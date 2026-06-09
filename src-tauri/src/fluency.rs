use crate::events::PacingMetrics;
use crate::stt::WordTimestamp;

/// Minimum silent gap (ms) counted as a pause / long hesitation.
/// 250ms is the standard minimum pause threshold in the fluency literature.
const LONG_PAUSE_MS: u64 = 250;

/// Compute pacing metrics from per-word timestamps.
///
/// `segment_count` is the number of real ASR segments (from stt.rs). Pauses are
/// only observable across segment boundaries, so with <2 segments we cannot
/// measure them — `pauses_reliable` is set false and the UI de-emphasizes the
/// pause/hesitation readout (PM Iteration-2 honesty guardrail). WPM is always
/// valid since it only needs first/last word timing.
pub fn compute_pacing(words: &[WordTimestamp], segment_count: usize) -> PacingMetrics {
    if words.is_empty() {
        return PacingMetrics::default(); // pauses_reliable = false
    }

    let first_start = words.first().unwrap().start_ms;
    let last_end = words.last().unwrap().end_ms;
    let total_ms = last_end.saturating_sub(first_start).max(1);

    // Sum inter-word gaps that exceed the pause threshold.
    let mut total_pause_ms: u64 = 0;
    let mut pause_count: u32 = 0;
    let mut long_hesitations: u32 = 0;
    for pair in words.windows(2) {
        let gap = pair[1].start_ms.saturating_sub(pair[0].end_ms);
        if gap >= LONG_PAUSE_MS {
            total_pause_ms += gap;
            pause_count += 1;
            long_hesitations += 1;
        }
    }

    let word_count = words.len() as f32;
    let total_min = total_ms as f32 / 60_000.0;
    let speaking_ms = total_ms.saturating_sub(total_pause_ms).max(1);
    let speaking_min = speaking_ms as f32 / 60_000.0;

    PacingMetrics {
        words_per_minute: word_count / total_min,
        articulation_rate: word_count / speaking_min, // excludes pause time
        pause_count,
        total_pause_ms: total_pause_ms as u32,
        pause_ratio: total_pause_ms as f32 / total_ms as f32,
        long_hesitations,
        // Need at least 2 segments to have observed an inter-segment boundary.
        pauses_reliable: segment_count >= 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::WordTimestamp;

    fn w(word: &str, start_ms: u64, end_ms: u64) -> WordTimestamp {
        WordTimestamp { word: word.to_string(), start_ms, end_ms }
    }

    #[test]
    fn empty_words_yields_zero() {
        let m = compute_pacing(&[], 0);
        assert_eq!(m.words_per_minute, 0.0);
        assert_eq!(m.pause_count, 0);
        assert!(!m.pauses_reliable);
    }

    #[test]
    fn three_words_over_one_second_is_180_wpm() {
        // words span 0..1000ms, no gaps → 3 words / 1s = 180 wpm
        let words = vec![w("a", 0, 300), w("b", 300, 600), w("c", 600, 1000)];
        let m = compute_pacing(&words, 1);
        assert!((m.words_per_minute - 180.0).abs() < 1.0);
        assert_eq!(m.pause_count, 0);
        assert_eq!(m.total_pause_ms, 0);
    }

    #[test]
    fn gap_over_threshold_counts_as_pause() {
        // 500ms gap between b and c → 1 pause, 1 long hesitation
        let words = vec![w("a", 0, 300), w("b", 300, 600), w("c", 1100, 1400)];
        let m = compute_pacing(&words, 2);
        assert_eq!(m.pause_count, 1);
        assert_eq!(m.total_pause_ms, 500);
        assert_eq!(m.long_hesitations, 1);
        // articulation rate (excludes pause time) > wpm (includes it)
        assert!(m.articulation_rate > m.words_per_minute);
        assert!(m.pause_ratio > 0.0 && m.pause_ratio < 1.0);
    }

    #[test]
    fn single_segment_marks_pauses_unreliable() {
        let words = vec![w("a", 0, 300), w("b", 300, 600)];
        assert!(!compute_pacing(&words, 1).pauses_reliable);
        assert!(compute_pacing(&words, 3).pauses_reliable);
    }
}
