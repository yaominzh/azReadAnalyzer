pub mod capture;
pub mod clipboard;
pub mod audio;
pub mod stt;
pub mod diff;
pub mod fluency;
pub mod llm;
mod commands;
mod events;

use commands::AppState;
use std::sync::{Arc, Mutex};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(AppState {
            recorder: Mutex::new(None),
            stt_engine: Mutex::new(None),
        }))
        .invoke_handler(tauri::generate_handler![
            commands::paste_clipboard,
            commands::capture_screenshot,
            commands::play_tts,
            commands::set_always_on_top,
            commands::start_recording,
            commands::stop_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
