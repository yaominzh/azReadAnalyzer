use std::sync::{Arc, Mutex};
use tauri::{command, AppHandle, State};

use crate::audio::Recorder;
use crate::stt::WhisperEngine;

pub struct AppState {
    pub recorder: Mutex<Option<Recorder>>,
    pub stt_engine: Mutex<Option<WhisperEngine>>,
}

// SAFETY: Recorder holds cpal::Stream which is not Send, but access is
// serialised through Mutex and only ever on one thread at a time.
unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

#[command]
pub fn paste_clipboard() -> Result<String, String> {
    crate::clipboard::read_text()
}

#[command]
pub async fn capture_screenshot(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let window = app.get_webview_window("main");

    // Hide our window so it isn't captured / doesn't block the target.
    if let Some(w) = &window {
        w.hide().ok();
    }

    // Run capture + OCR, always restoring the window afterward.
    let outcome = async {
        // `temp` is a NamedTempFile (unique path); dropped at end of this block → auto-deleted.
        let temp = crate::capture::capture_screen_region().await?;
        crate::capture::call_ocr_sidecar(temp.path()).await
    }
    .await;

    if let Some(w) = &window {
        w.show().ok();
        w.set_focus().ok();
    }

    let text = outcome?;
    crate::events::emit_text_captured(&app, text);
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
