use tauri::AppHandle;
use tempfile::NamedTempFile;

// Stub — real cpal recording implementation lands in Iteration 2 (Task 12).
pub struct Recorder;

impl Recorder {
    pub fn start(_app: AppHandle) -> Result<Self, String> {
        Err("Recording not yet implemented".into())
    }
    // Returns a NamedTempFile (unique path, auto-deleted on drop) holding the recording WAV.
    pub fn stop(self) -> Result<NamedTempFile, String> {
        Err("Recording not yet implemented".into())
    }
}
