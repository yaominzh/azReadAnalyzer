// stt.rs — transcribe-rs SEGMENT-level timestamps (start/end in seconds).
//
// Spike result (Task 14 Step 2b, verified against transcribe-rs 0.3.11 source):
//   TranscriptionResult { text: String, segments: Option<Vec<TranscriptionSegment>> }
//   TranscriptionSegment { start: f32 (s), end: f32 (s), text: String }
//   transcribe_with() ALWAYS populates `segments` from full_n_segments().
// There are NO word-level timestamps, so each segment's words are distributed
// evenly across its [start, end] span, and the silence BETWEEN segments is
// preserved as a gap that fluency.rs reads as a pause. Finer (word/phoneme)
// pause detection is deferred (Tier A / v2).
use std::path::{Path, PathBuf};
// Alias the crate's engine to avoid colliding with our own `WhisperEngine` struct.
use transcribe_rs::whisper_cpp::{WhisperEngine as TranscribeWhisper, WhisperInferenceParams};

const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// One transcribed word with its timing, used for pacing analysis (fluency.rs).
pub struct WordTimestamp {
    pub word: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Full STT result: joined text plus per-word timestamps.
pub struct Transcription {
    pub text: String,
    pub words: Vec<WordTimestamp>,
}

pub struct WhisperEngine {
    engine: TranscribeWhisper,
}

impl WhisperEngine {
    pub fn default_model_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".azreadanalyzer/models/ggml-base.en.bin")
    }

    pub fn new(model_path: &Path) -> Result<Self, String> {
        let engine = TranscribeWhisper::load(model_path).map_err(|e| {
            format!("Failed to load Whisper model at {}: {:?}", model_path.display(), e)
        })?;
        Ok(Self { engine })
    }

    pub fn transcribe(&mut self, wav_path: &Path) -> Result<Transcription, String> {
        // Read WAV → f32 samples (mono; audio.rs already mixed to mono).
        let mut reader = hound::WavReader::open(wav_path).map_err(|e| e.to_string())?;
        let spec = reader.spec();

        let raw_samples: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Int => reader
                .samples::<i16>()
                .map(|s| s.map(|v| v as f32 / i16::MAX as f32))
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?,
            hound::SampleFormat::Float => reader
                .samples::<f32>()
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?,
        };

        // Anti-aliased resample to 16kHz via rubato (Tier-B B3) — replaces the
        // naive linear interpolation that could alias and hurt Whisper accuracy.
        let samples = resample_to_16k(&raw_samples, spec.sample_rate)?;

        let params = WhisperInferenceParams {
            language: Some("en".to_string()),
            ..Default::default()
        };
        let result = self
            .engine
            .transcribe_with(&samples, &params)
            .map_err(|e| format!("Whisper inference failed: {e:?}"))?;

        // Build per-word timestamps from segment-level [start, end] (seconds → ms).
        // If the engine returned no segments, synthesize one spanning the whole clip
        // so WPM is still meaningful (pauseCount stays 0).
        let total_ms = (samples.len() as u64) * 1000 / WHISPER_SAMPLE_RATE as u64;
        let segments: Vec<(String, u64, u64)> = match &result.segments {
            Some(segs) if !segs.is_empty() => segs
                .iter()
                .map(|s| {
                    (
                        s.text.clone(),
                        (s.start.max(0.0) * 1000.0) as u64,
                        (s.end.max(0.0) * 1000.0) as u64,
                    )
                })
                .collect(),
            _ => vec![(result.text.clone(), 0, total_ms)],
        };

        let mut words: Vec<WordTimestamp> = Vec::new();
        for (seg_text, t0_ms, t1_ms) in &segments {
            let seg_words: Vec<&str> = seg_text.split_whitespace().collect();
            if seg_words.is_empty() {
                continue;
            }
            let span = t1_ms.saturating_sub(*t0_ms).max(1);
            let per = span / seg_words.len() as u64;
            for (j, word) in seg_words.iter().enumerate() {
                let ws = t0_ms + per * j as u64;
                let we = if j + 1 == seg_words.len() { *t1_ms } else { ws + per };
                words.push(WordTimestamp { word: word.to_string(), start_ms: ws, end_ms: we });
            }
        }

        Ok(Transcription { text: result.text.trim().to_string(), words })
    }
}

/// Resample mono f32 PCM to 16kHz using rubato's FFT resampler (anti-aliased).
/// No-op when already at 16kHz. Processes in fixed input chunks, zero-padding
/// the final partial chunk. Same dependency/approach as MeetBuddy.
fn resample_to_16k(input: &[f32], in_rate: u32) -> Result<Vec<f32>, String> {
    use rubato::{FftFixedIn, Resampler};

    if in_rate == WHISPER_SAMPLE_RATE || input.is_empty() {
        return Ok(input.to_vec());
    }

    let mut resampler =
        FftFixedIn::<f32>::new(in_rate as usize, WHISPER_SAMPLE_RATE as usize, 1024, 2, 1)
            .map_err(|e| format!("resampler init: {e}"))?;

    let mut out: Vec<f32> = Vec::with_capacity(
        input.len() * WHISPER_SAMPLE_RATE as usize / in_rate as usize + 1024,
    );
    let mut pos = 0usize;
    loop {
        let need = resampler.input_frames_next();
        let chunk: Vec<f32> = if pos + need <= input.len() {
            let c = input[pos..pos + need].to_vec();
            pos += need;
            c
        } else {
            // Final partial chunk: zero-pad to `need`.
            let mut c = vec![0.0f32; need];
            let remain = input.len().saturating_sub(pos);
            if remain > 0 {
                c[..remain].copy_from_slice(&input[pos..]);
            }
            pos = input.len();
            c
        };
        let processed = resampler.process(&[chunk], None).map_err(|e| e.to_string())?;
        out.extend_from_slice(&processed[0]);
        if pos >= input.len() {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_path_is_correct() {
        let path = WhisperEngine::default_model_path();
        println!("Whisper model path: {}", path.display());
        assert!(path.ends_with("ggml-base.en.bin"));
    }

    #[test]
    fn resample_48k_to_16k_is_roughly_one_third() {
        // 1 second of 48kHz → ~16000 samples at 16kHz (within a chunk's tolerance).
        let input = vec![0.1f32; 48_000];
        let out = resample_to_16k(&input, 48_000).unwrap();
        let diff = (out.len() as i64 - 16_000).abs();
        assert!(diff < 2048, "resampled len {} not ~16000", out.len());
    }

    #[test]
    fn resample_noop_at_16k() {
        let input = vec![0.2f32; 1000];
        let out = resample_to_16k(&input, 16_000).unwrap();
        assert_eq!(out.len(), 1000);
    }
}
