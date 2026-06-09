use crate::events::PacingMetrics;
use crate::stt::WordTimestamp;

// Stub — real pacing computation lands in Iteration 3 (Task 15B).
pub fn compute_pacing(_words: &[WordTimestamp]) -> PacingMetrics {
    PacingMetrics::default()
}
