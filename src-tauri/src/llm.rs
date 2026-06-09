use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;

use crate::events::{DiffToken, LlmComment, PacingMetrics};

const DEFAULT_TIMEOUT_SECS: u64 = 45;

#[derive(Deserialize, Debug)]
struct LlmResponse {
    score: u32,
    comments: Vec<LlmCommentRaw>,
}

#[derive(Deserialize, Debug)]
struct LlmCommentRaw {
    icon: String,
    text: String,
}

/// The diff and pacing are computed deterministically in Rust (diff.rs / fluency.rs).
/// The LLM only summarizes them into a score + coaching comments — it does NOT
/// recompute the diff. We pass the already-computed diff + pacing so its comments
/// are grounded in the same numbers the UI shows.
pub async fn get_feedback(
    original: &str,
    transcription: &str,
    diff: &[DiffToken],
    pacing: &PacingMetrics,
) -> Result<(u32, Vec<LlmComment>), String> {
    let base_url =
        std::env::var("OMLX_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8002/v1".into());
    let api_key = std::env::var("OMLX_API_KEY").unwrap_or_default();
    let model = std::env::var("OMLX_MODEL").unwrap_or_else(|_| "default".into());

    // Tier-B B2: bound the request so a cold/slow local model can't hang the
    // Analyze step forever. Configurable via OMLX_TIMEOUT_SECS (default 45).
    let timeout_secs = std::env::var("OMLX_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_TIMEOUT_SECS);

    // Summarize the Rust-computed diff for the prompt.
    let missed: Vec<&str> = diff
        .iter()
        .filter(|t| t.token_type == "missed")
        .map(|t| t.text.trim())
        .filter(|s| !s.is_empty())
        .collect();
    let added: Vec<&str> = diff
        .iter()
        .filter(|t| t.token_type == "added")
        .map(|t| t.text.trim())
        .filter(|s| !s.is_empty())
        .collect();

    // If pause data is unreliable (single-segment ASR), tell the model not to
    // coach on pauses/hesitations — only WPM + content (honesty guardrail).
    let pacing_note = if pacing.pauses_reliable {
        format!(
            "- Pause count: {pc}\n- Total pause time: {tp} ms\n- Pause ratio: {pr:.2}\n- Long hesitations: {lh}\n",
            pc = pacing.pause_count,
            tp = pacing.total_pause_ms,
            pr = pacing.pause_ratio,
            lh = pacing.long_hesitations,
        )
    } else {
        "- Pause/hesitation data: UNAVAILABLE for this short clip — do NOT comment on pauses or hesitations; focus on speaking rate and content only.\n".to_string()
    };

    let prompt = format!(
        "You are coaching a Chinese-native English learner on a read-aloud exercise. \
All metrics below are already computed — do NOT recompute them, just interpret them.\n\n\
Original text: {original}\n\n\
What they said (ASR): {transcription}\n\n\
CONTENT DIFF (computed):\n- Missed/substituted words: {missed:?}\n- Extra/substituted words said: {added:?}\n\n\
PACING METRICS (computed):\n\
- Words per minute: {wpm:.0}\n\
- Articulation rate (excl. pauses): {art:.0}\n\
{pacing_note}\n\
Note: ASR normalizes pronunciation, so do NOT claim specific phoneme/word-ending mispronunciations — \
focus on CONTENT ACCURACY (missed/extra words) and FLUENCY/PACING (rate, pauses, hesitations). \
A natural read-aloud pace is ~150-170 wpm.\n\n\
Return ONLY a JSON object (no markdown fences):\n\
- \"score\": integer 0-100 combining content accuracy and fluency\n\
- \"comments\": array of 3-5 objects, each with \"icon\" (a single emoji) and \"text\" (one specific, constructive tip)",
        original = original,
        transcription = transcription,
        missed = missed,
        added = added,
        wpm = pacing.words_per_minute,
        art = pacing.articulation_rate,
        pacing_note = pacing_note,
    );

    let body = serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You are an English fluency and read-aloud coach for non-native speakers. You interpret pre-computed content-diff and pacing metrics. Return only valid JSON. No markdown fences."
            },
            { "role": "user", "content": prompt }
        ],
        "temperature": 0.3
    });

    let client = Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("{}");

    // Tier-B B2: local models often wrap JSON in ```fences``` or prose. Extract
    // the first {...} block before parsing rather than trusting strict format.
    let cleaned = extract_json_object(content);
    let parsed: LlmResponse = serde_json::from_str(&cleaned)
        .map_err(|e| format!("LLM returned non-JSON: {e}\nRaw: {content}"))?;

    let comments = parsed
        .comments
        .into_iter()
        .map(|c| LlmComment { icon: c.icon, text: c.text })
        .collect();

    Ok((parsed.score, comments))
}

/// Strip markdown fences and isolate the first balanced-looking JSON object
/// (first `{` to last `}`). Returns the original trimmed string if no braces.
fn extract_json_object(raw: &str) -> String {
    let trimmed = raw.trim().trim_start_matches("```json").trim_start_matches("```").trim();
    match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(start), Some(end)) if end > start => trimmed[start..=end].to_string(),
        _ => trimmed.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::PacingMetrics;

    #[tokio::test]
    async fn returns_err_when_llm_unreachable() {
        std::env::set_var("OMLX_BASE_URL", "http://127.0.0.1:19999/v1");
        let result = get_feedback("hello", "hello", &[], &PacingMetrics::default()).await;
        assert!(result.is_err());
    }

    #[test]
    fn extracts_json_from_markdown_fences() {
        let raw = "Sure! Here is the result:\n```json\n{\"score\": 88, \"comments\": []}\n```\nHope that helps.";
        let cleaned = extract_json_object(raw);
        let parsed: LlmResponse = serde_json::from_str(&cleaned).unwrap();
        assert_eq!(parsed.score, 88);
    }

    #[test]
    fn extracts_bare_json() {
        let raw = "{\"score\": 70, \"comments\": [{\"icon\": \"👍\", \"text\": \"ok\"}]}";
        let cleaned = extract_json_object(raw);
        let parsed: LlmResponse = serde_json::from_str(&cleaned).unwrap();
        assert_eq!(parsed.score, 70);
        assert_eq!(parsed.comments.len(), 1);
    }
}
