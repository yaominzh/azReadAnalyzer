pub mod capture;
pub mod clipboard;
pub mod audio;
pub mod stt;
pub mod diff;
pub mod fluency;
pub mod llm;
pub mod settings;
mod commands;
mod events;

use commands::AppState;
use std::sync::{Arc, Mutex};
use stt::WhisperEngine;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load the Whisper model at startup. If absent, the engine is None and the
    // first recording surfaces a "Whisper not loaded" error (model-missing UX
    // is Tier C, out of scope for this build).
    let stt_engine = WhisperEngine::new(&WhisperEngine::default_model_path())
        .map(Some)
        .unwrap_or_else(|err| {
            eprintln!("Warning: Whisper model not loaded: {err}");
            None
        });

    tauri::Builder::default()
        .manage(Arc::new(AppState {
            recorder: Mutex::new(None),
            stt_engine: Mutex::new(stt_engine),
            last_recording_wav: Mutex::new(None),
            last_capture_png: Mutex::new(None),
            settings: Mutex::new(settings::AppSettings::load()),
            tts_gen: std::sync::atomic::AtomicU64::new(0),
        }))
        .invoke_handler(tauri::generate_handler![
            commands::paste_clipboard,
            commands::capture_screenshot,
            commands::play_tts,
            commands::get_last_recording,
            commands::get_capture_image,
            commands::clear_session_media,
            commands::set_always_on_top,
            commands::start_recording,
            commands::stop_recording,
            commands::get_settings,
            commands::apply_settings,
            commands::play_tts_stream,
            commands::stop_tts_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
