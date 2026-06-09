use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct TextCapturedPayload {
    pub text: String,
}

#[derive(Serialize, Clone)]
pub struct AudioLevelPayload {
    pub level: f32,
}

#[derive(Serialize, Clone)]
pub struct RecordingStatePayload {
    pub state: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiffToken {
    pub text: String,
    #[serde(rename = "type")]
    pub token_type: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct LlmComment {
    pub icon: String,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PacingMetrics {
    pub words_per_minute: f32,
    pub articulation_rate: f32,
    pub pause_count: u32,
    pub total_pause_ms: u32,
    pub pause_ratio: f32,
    pub long_hesitations: u32,
}

#[derive(Serialize, Clone)]
pub struct FeedbackReadyPayload {
    // score is None when the LLM was unreachable — the UI then shows diff +
    // pacing (both computed locally in Rust) but suppresses the score ring and
    // comments, per spec ("transcription only, no score/comments").
    pub score: Option<u32>,
    pub transcription: String,
    pub diff: Vec<DiffToken>,
    pub pacing: PacingMetrics,
    pub comments: Vec<LlmComment>,
}

pub fn emit_text_captured(app: &AppHandle, text: String) {
    app.emit("text-captured", TextCapturedPayload { text }).ok();
}

pub fn emit_audio_level(app: &AppHandle, level: f32) {
    app.emit("audio-level", AudioLevelPayload { level }).ok();
}

pub fn emit_recording_state(app: &AppHandle, state: &str) {
    app.emit("recording-state", RecordingStatePayload { state: state.to_string() }).ok();
}

pub fn emit_feedback_ready(app: &AppHandle, payload: FeedbackReadyPayload) {
    app.emit("feedback-ready", payload).ok();
}
