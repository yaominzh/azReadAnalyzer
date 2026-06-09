use std::path::Path;

/// One transcribed word with its timing, used for pacing analysis (fluency.rs).
pub struct WordTimestamp {
    pub word: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Full STT result: text plus per-word timestamps.
pub struct Transcription {
    pub text: String,
    pub words: Vec<WordTimestamp>,
}

// Stub — real transcribe-rs implementation lands in Iteration 2 (Task 14).
pub struct WhisperEngine;

impl WhisperEngine {
    pub fn transcribe(&mut self, _path: &Path) -> Result<Transcription, String> {
        Err("STT not yet implemented".into())
    }
}
