use std::sync::{Arc, Mutex};
use tauri::{command, AppHandle, State};

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

    // LLM is best-effort. If it's unreachable, score = None and comments = [];
    // the UI still shows the locally-computed diff + pacing.
    let (score, comments) =
        match crate::llm::get_feedback(&original_text, &result.text, &diff, &pacing).await {
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
