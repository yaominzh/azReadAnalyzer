// Recording state
export type RecordingState = "idle" | "recording" | "analyzing";

// TTS state
export type TtsState = "idle" | "playing";

// Diff token from Rust word-level diff
export interface DiffToken {
  text: string;
  type: "correct" | "missed" | "added";
}

// LLM coaching comment
export interface LlmComment {
  icon: string;
  text: string;
}

// Pacing metrics computed in Rust (fluency.rs) from word timestamps.
// Field names are camelCase to match Rust's #[serde(rename_all = "camelCase")].
export interface PacingMetrics {
  wordsPerMinute: number;
  articulationRate: number;
  pauseCount: number;
  totalPauseMs: number;
  pauseRatio: number;
  longHesitations: number;
}

// Full feedback result
export interface FeedbackResult {
  score: number | null;   // null when the LLM was unreachable (diff + pacing still shown)
  transcription: string;
  diff: DiffToken[];
  pacing: PacingMetrics;
  comments: LlmComment[];
}

// Tauri IPC event payloads
export interface TextCapturedPayload {
  text: string;
}

export interface AudioLevelPayload {
  level: number;
}

export interface RecordingStatePayload {
  state: RecordingState;
}

export interface FeedbackReadyPayload {
  score: number | null;   // null = LLM unreachable (Rust sends None)
  transcription: string;
  diff: DiffToken[];
  pacing: PacingMetrics;
  comments: LlmComment[];
}

// Toast notification
export interface Toast {
  id: string;
  message: string;
  type: "error" | "info";
}
