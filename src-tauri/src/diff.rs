use similar::{capture_diff_slices, Algorithm, DiffTag};

use crate::events::DiffToken;

/// Comparison key for a word: lowercase, alphanumeric only. So "Atomic" vs
/// "atomic", "moment:" vs "moment,", and "(journey)" vs "journey" compare on
/// their core word — case and surrounding punctuation are NOT flagged as
/// content errors (they're ASR artifacts, not reading mistakes).
fn norm(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Append a word token, inserting a neutral space between words so the rendered
/// diff reads naturally (the space is never struck through / highlighted).
fn push_word(tokens: &mut Vec<DiffToken>, text: &str, kind: &str) {
    if !tokens.is_empty() {
        tokens.push(DiffToken { text: " ".into(), token_type: "correct".into() });
    }
    tokens.push(DiffToken { text: text.to_string(), token_type: kind.to_string() });
}

/// Deterministic, case- and punctuation-insensitive word-level diff between the
/// original text and the transcription. Owned by Rust (not the LLM). Matched and
/// missed words are shown with the ORIGINAL text's casing; added words (said but
/// not in the original) keep the transcription's form.
/// missed = in original, not said; added = said, not in original; correct = match.
pub fn word_diff(original: &str, transcription: &str) -> Vec<DiffToken> {
    let orig: Vec<&str> = original.split_whitespace().collect();
    let trans: Vec<&str> = transcription.split_whitespace().collect();
    let orig_keys: Vec<String> = orig.iter().map(|w| norm(w)).collect();
    let trans_keys: Vec<String> = trans.iter().map(|w| norm(w)).collect();

    let mut tokens: Vec<DiffToken> = Vec::new();
    for op in capture_diff_slices(Algorithm::Myers, &orig_keys, &trans_keys) {
        match op.tag() {
            DiffTag::Equal => {
                for i in op.old_range() {
                    push_word(&mut tokens, orig[i], "correct");
                }
            }
            DiffTag::Delete => {
                for i in op.old_range() {
                    // Punctuation-only token (empty key) isn't a spoken word —
                    // show it neutral, never highlight it as missed.
                    let kind = if orig_keys[i].is_empty() { "correct" } else { "missed" };
                    push_word(&mut tokens, orig[i], kind);
                }
            }
            DiffTag::Insert => {
                for i in op.new_range() {
                    // Drop transcription-only punctuation entirely (not a real
                    // "said instead" error).
                    if trans_keys[i].is_empty() {
                        continue;
                    }
                    push_word(&mut tokens, trans[i], "added");
                }
            }
            DiffTag::Replace => {
                for i in op.old_range() {
                    let kind = if orig_keys[i].is_empty() { "correct" } else { "missed" };
                    push_word(&mut tokens, orig[i], kind);
                }
                for i in op.new_range() {
                    if trans_keys[i].is_empty() {
                        continue;
                    }
                    push_word(&mut tokens, trans[i], "added");
                }
            }
        }
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_all_correct() {
        let result = word_diff("hello world", "hello world");
        assert!(result.iter().all(|t| t.token_type == "correct"));
    }

    #[test]
    fn missing_word_marked_missed() {
        let result = word_diff("hello world foo", "hello world");
        assert!(result.iter().any(|t| t.token_type == "missed" && t.text.contains("foo")));
    }

    #[test]
    fn extra_word_marked_added() {
        let result = word_diff("hello world", "hello beautiful world");
        assert!(result.iter().any(|t| t.token_type == "added" && t.text.contains("beautiful")));
    }

    #[test]
    fn case_and_punctuation_differences_are_not_errors() {
        // "Atomic"/"atomic", "Pattern,"/"pattern", "Section"/"section" match.
        let result = word_diff("Atomic Pattern, in Section", "atomic pattern in section");
        assert!(
            result.iter().all(|t| t.token_type == "correct"),
            "case/punct-only diffs should all be correct, got {result:?}"
        );
        // Display preserves the ORIGINAL casing + punctuation.
        assert!(result.iter().any(|t| t.text == "Atomic"));
        assert!(result.iter().any(|t| t.text == "Pattern,"));
    }

    #[test]
    fn standalone_punctuation_not_highlighted() {
        // A lone "—" in the original isn't a spoken word → must not be flagged.
        let result = word_diff("live — the compact", "live the compact");
        assert!(
            result.iter().all(|t| t.token_type == "correct"),
            "punctuation-only token must not be highlighted, got {result:?}"
        );
        // Transcription-only punctuation is dropped, not shown as "said instead".
        let r2 = word_diff("live the compact", "live — the compact");
        assert!(r2.iter().all(|t| t.token_type == "correct"));
    }

    #[test]
    fn genuine_word_differences_still_flagged() {
        // Allen vs Alan and one vs 1 are real mismatches, not case/punct noise.
        let result = word_diff("Allen said one", "Alan said 1");
        assert!(result.iter().any(|t| t.token_type == "missed" && t.text == "Allen"));
        assert!(result.iter().any(|t| t.token_type == "added" && t.text == "Alan"));
        assert!(result.iter().any(|t| t.token_type == "missed" && t.text == "one"));
    }
}
