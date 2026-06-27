use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use serde::Serialize;
use tauri::{command, AppHandle, State};
use futures_util::StreamExt;

use crate::audio::Recorder;
use crate::stt::WhisperEngine;

pub struct AppState {
    pub recorder: Mutex<Option<Recorder>>,
    pub stt_engine: Mutex<Option<WhisperEngine>>,
    // Session-only copy of the last recording's WAV bytes, for replay (#3).
    // In-memory only; overwritten each recording; dropped on quit.
    pub last_recording_wav: Mutex<Option<Vec<u8>>>,
    // Session-only copy of the last captured image PNG (screenshot or pasted
    // image), for the thumbnail/lightbox (#4). Authoritative for "is there a
    // thumbnail"; cleared on text-only paste / clear / capture failure.
    pub last_capture_png: Mutex<Option<Vec<u8>>>,
    // User settings (LLM/oMLX connection), loaded at startup, edited via the
    // Settings panel. Persisted to ~/.azreadanalyzer/settings.json.
    pub settings: Mutex<crate::settings::AppSettings>,
    // Generation counter for streaming TTS. Bumped on each new stream and on
    // stop; an in-flight play_tts_stream loop exits when it's superseded.
    pub tts_gen: AtomicU64,
}

// SAFETY: Recorder holds cpal::Stream which is not Send, but access is
// serialised through Mutex and only ever on one thread at a time.
unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

/// Result of a paste: reading text, plus whether an image thumbnail was captured (#4).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteResult {
    pub text: String,
    pub has_image: bool,
}

#[command]
pub async fn paste_clipboard(state: State<'_, Arc<AppState>>) -> Result<PasteResult, String> {
    // Text-first precedence (review #4): a clipboard carrying both text and
    // image flavors is treated as text-only.
    if let Ok(text) = crate::clipboard::read_text() {
        if !text.trim().is_empty() {
            if let Ok(mut g) = state.last_capture_png.lock() {
                *g = None;
            }
            return Ok(PasteResult { text, has_image: false });
        }
    }

    // No text → try an image: encode to PNG, OCR it, keep the PNG for the thumbnail.
    // Clear up-front so ANY early error below (temp/write/OCR) cannot leave a
    // stale capture image — spec error table requires "last_capture_png cleared"
    // on capture/OCR failure (QA D1). Only set it on full success.
    if let Ok(mut g) = state.last_capture_png.lock() {
        *g = None;
    }
    match crate::clipboard::read_image_png() {
        Ok(png) => {
            let temp = tempfile::Builder::new()
                .prefix("az_paste_")
                .suffix(".png")
                .tempfile()
                .map_err(|e| format!("temp file: {e}"))?;
            std::fs::write(temp.path(), &png).map_err(|e| e.to_string())?;
            let text = crate::capture::call_ocr_sidecar(temp.path()).await?;
            if let Ok(mut g) = state.last_capture_png.lock() {
                *g = Some(png);
            }
            Ok(PasteResult { text, has_image: true })
        }
        Err(e) => Err(e),
    }
}

#[command]
pub async fn capture_screenshot(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    use tauri::Manager;
    let window = app.get_webview_window("main");

    // Hide our window so it isn't captured / doesn't block the target.
    if let Some(w) = &window {
        w.hide().ok();
    }

    // Run capture + OCR, always restoring the window afterward. Also read the
    // PNG bytes before the temp file drops, to keep them for the thumbnail (#4).
    let outcome = async {
        // `temp` is a NamedTempFile (unique path); dropped at end of this block → auto-deleted.
        let temp = crate::capture::capture_screen_region().await?;
        let text = crate::capture::call_ocr_sidecar(temp.path()).await?;
        let png = std::fs::read(temp.path()).ok();
        Ok::<(String, Option<Vec<u8>>), String>((text, png))
    }
    .await;

    if let Some(w) = &window {
        w.show().ok();
        w.set_focus().ok();
    }

    let (text, png) = outcome?;
    if let Ok(mut g) = state.last_capture_png.lock() {
        *g = png;
    }
    crate::events::emit_text_captured(&app, text, true);
    Ok(())
}

/// Returns the synthesized WAV as raw bytes via `tauri::ipc::Response` (Tier-B B1).
/// This avoids serializing the WAV as a JSON `number[]` (which bloats a ~1-2MB
/// paragraph to a 5-7MB JSON string). The frontend receives an ArrayBuffer.
#[command]
pub async fn play_tts(text: String) -> Result<tauri::ipc::Response, String> {
    let bytes = crate::capture::call_tts_sidecar(&text).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Map a sidecar HTTP status + body to a result (review #1/#4 — never forward an
/// error body as PCM). Extracted so the non-2xx branch is unit-testable.
fn ensure_success(status: reqwest::StatusCode, body: &str) -> Result<(), String> {
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("TTS stream error: {body}"))
    }
}

/// Streams TTS audio chunks (int16 PCM) from the sidecar to the frontend via a
/// Tauri Channel. Status-checked (never forwards an error body as audio) and
/// generation-gated (a newer stream or stop_tts_stream supersedes this one,
/// which drops the response and disconnects the sidecar).
#[command]
pub async fn play_tts_stream(
    text: String,
    on_chunk: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let my_gen = state.tts_gen.fetch_add(1, Ordering::SeqCst) + 1;

    let client = reqwest::Client::new();
    let resp = client
        .post("http://127.0.0.1:8123/tts_stream")
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await
        .map_err(|_| "TTS service not running — start tts_service/".to_string())?;

    if let Err(e) = ensure_success(resp.status(), "") {
        // read a short body for context, then fail — do NOT enter bytes_stream().
        let detail = resp.text().await.unwrap_or_default();
        return Err(if detail.is_empty() { e } else { format!("TTS stream error: {detail}") });
    }

    let mut stream = resp.bytes_stream();
    while let Some(item) = stream.next().await {
        // Superseded → stop. Dropping `stream`/`resp` disconnects the sidecar.
        if state.tts_gen.load(Ordering::SeqCst) != my_gen {
            return Ok(());
        }
        let bytes = item.map_err(|e| e.to_string())?;
        on_chunk
            .send(tauri::ipc::InvokeResponseBody::Raw(bytes.to_vec()))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Cancels any in-flight streaming TTS (used by Stop / replace / unmount).
#[command]
pub fn stop_tts_stream(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.tts_gen.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

/// Read local Markdown files (with optional line ranges) and return faithful
/// plain text for the practice box. Deterministic + on-device; file reads run
/// on a blocking thread so a large batch can't stall the command worker.
#[command]
pub async fn prepare_markdown(
    input: String,
) -> Result<crate::markdown::PrepareMarkdownResult, String> {
    tokio::task::spawn_blocking(move || crate::markdown::prepare_from_input(&input))
        .await
        .map_err(|e| format!("read task failed: {e}"))?
}

/// Returns the last recording's WAV bytes for replay (#3), via the same
/// raw-bytes `ipc::Response` pattern as `play_tts`. Err when nothing is stored.
#[command]
pub fn get_last_recording(state: State<'_, Arc<AppState>>) -> Result<tauri::ipc::Response, String> {
    let g = state.last_recording_wav.lock().map_err(|e| e.to_string())?;
    match &*g {
        Some(bytes) => Ok(tauri::ipc::Response::new(bytes.clone())),
        None => Err("No recording yet".into()),
    }
}

/// Returns the last captured image PNG bytes for the thumbnail/lightbox (#4).
#[command]
pub fn get_capture_image(state: State<'_, Arc<AppState>>) -> Result<tauri::ipc::Response, String> {
    let g = state.last_capture_png.lock().map_err(|e| e.to_string())?;
    match &*g {
        Some(bytes) => Ok(tauri::ipc::Response::new(bytes.clone())),
        None => Err("No capture image".into()),
    }
}

/// Clears the session capture image (#4). Scoped to `last_capture_png` ONLY —
/// NOT `last_recording_wav` (New Text calls this; dropping the recording would
/// hide the replay control mid-session). (TPM S6)
#[command]
pub fn clear_session_media(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    if let Ok(mut g) = state.last_capture_png.lock() {
        *g = None;
    }
    Ok(())
}

#[command]
pub fn set_always_on_top(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        w.set_always_on_top(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub fn start_recording(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let mut rec = state.recorder.lock().map_err(|e| e.to_string())?;
    if rec.is_some() {
        return Err("Already recording".into());
    }
    *rec = Some(Recorder::start(app.clone())?);
    crate::events::emit_recording_state(&app, "recording");
    Ok(())
}

#[command]
pub async fn stop_recording(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    original_text: String,
) -> Result<(), String> {
    // `wav` is a NamedTempFile (unique path, auto-deleted when dropped at fn end).
    let wav = {
        let mut rec = state.recorder.lock().map_err(|e| e.to_string())?;
        let recorder = rec.take().ok_or("Not recording")?;
        recorder.stop()?
    };

    crate::events::emit_recording_state(&app, "analyzing");

    // Whisper returns text + word timestamps (see stt.rs / Task 14)
    let result = {
        let mut eng = state.stt_engine.lock().map_err(|e| e.to_string())?;
        let engine = eng.as_mut().ok_or("Whisper not loaded")?;
        engine.transcribe(wav.path())?
    };

    // Keep an in-memory copy of the recording for replay (#3), captured right
    // after STT and before the LLM await — so it's saved even if the LLM is
    // slow/cancelled, and the lock is never held across `.await`. (TPM M1)
    if let Ok(bytes) = std::fs::read(wav.path()) {
        if let Ok(mut g) = state.last_recording_wav.lock() {
            *g = Some(bytes);
        }
    }

    let diff = crate::diff::word_diff(&original_text, &result.text);
    let pacing = crate::fluency::compute_pacing(&result.words, result.segment_count);

    let cfg = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        crate::llm::LlmConfig {
            base_url: s.llm_base_url.clone(),
            model: s.llm_model.clone(),
            api_key: s.llm_api_key.clone(),
            timeout_secs: s.llm_timeout_secs,
        }
    }; // guard dropped here — not held across the await

    // LLM is best-effort. If it's unreachable, score = None and comments = [];
    // the UI still shows the locally-computed diff + pacing.
    let (score, comments) =
        match crate::llm::get_feedback(&original_text, &result.text, &diff, &pacing, &cfg).await {
            Ok((s, c)) => (Some(s), c),
            Err(e) => {
                log::warn!("LLM feedback unavailable: {e}");
                (None, vec![])
            }
        };

    crate::events::emit_feedback_ready(
        &app,
        crate::events::FeedbackReadyPayload {
            score,
            transcription: result.text,
            diff,
            pacing,
            comments,
        },
    );
    crate::events::emit_recording_state(&app, "idle");
    Ok(())
    // `wav` (a NamedTempFile) drops here → recording file auto-deleted.
}

#[command]
pub fn get_settings(state: State<'_, Arc<AppState>>) -> Result<crate::settings::AppSettings, String> {
    let g = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(g.clone())
}

/// Strict ordering (spec review #4): validate+normalize → write file → THEN
/// update in-memory. On any failure, settings.json and AppState are unchanged.
#[command]
pub fn apply_settings(
    state: State<'_, Arc<AppState>>,
    mut settings: crate::settings::AppSettings,
) -> Result<(), String> {
    settings.validate_and_normalize()?;
    settings.save()?; // write file first
    let mut g = state.settings.lock().map_err(|e| e.to_string())?;
    *g = settings; // only update memory after a successful write
    Ok(())
}

/// Readiness of the app's external dependencies, surfaced in the Settings panel.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub tts: bool,
    pub ocr: bool,
    pub llm: bool,
    pub whisper: bool,
}

/// GET `url` (optionally bearer-authed) and report whether it answered 2xx.
async fn ping_ok(client: &reqwest::Client, url: String, bearer: Option<String>) -> bool {
    let mut req = client.get(&url);
    if let Some(key) = bearer {
        req = req.bearer_auth(key);
    }
    matches!(req.send().await, Ok(resp) if resp.status().is_success())
}

/// Probe the four dependencies for the Settings "Services" panel. The three
/// HTTP checks run concurrently with a short timeout; Whisper is a local check
/// (the engine is loaded at startup, so `Some` == ready).
#[command]
pub async fn check_services(state: State<'_, Arc<AppState>>) -> Result<ServiceStatus, String> {
    let whisper = state.stt_engine.lock().map(|g| g.is_some()).unwrap_or(false);

    // Snapshot the LLM endpoint (drop the lock before awaiting).
    let (llm_url, llm_key) = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        (
            format!("{}/models", s.llm_base_url.trim_end_matches('/')),
            s.llm_api_key.clone(),
        )
    };
    let bearer = if llm_key.is_empty() { None } else { Some(llm_key) };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;

    let (tts, ocr, llm) = tokio::join!(
        ping_ok(&client, "http://127.0.0.1:8123/health".into(), None),
        ping_ok(&client, "http://127.0.0.1:8124/health".into(), None),
        ping_ok(&client, llm_url, bearer),
    );

    Ok(ServiceStatus { tts, ocr, llm, whisper })
}

#[cfg(test)]
mod stream_tests {
    use super::ensure_success;

    #[test]
    fn non_2xx_is_err() {
        assert!(ensure_success(reqwest::StatusCode::INTERNAL_SERVER_ERROR, "boom").is_err());
        assert!(ensure_success(reqwest::StatusCode::NOT_FOUND, "").is_err());
        assert!(ensure_success(reqwest::StatusCode::OK, "").is_ok());
    }
}
