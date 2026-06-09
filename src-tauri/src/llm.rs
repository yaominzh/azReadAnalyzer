use crate::events::{DiffToken, LlmComment, PacingMetrics};

// Stub — real OpenAI-compatible client lands in Iteration 3 (Task 16).
pub async fn get_feedback(
    _original: &str,
    _transcription: &str,
    _diff: &[DiffToken],
    _pacing: &PacingMetrics,
) -> Result<(u32, Vec<LlmComment>), String> {
    Err("LLM not yet implemented".into())
}
