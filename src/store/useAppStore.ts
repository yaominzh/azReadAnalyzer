import { create } from "zustand";
import type { RecordingState, TtsState, FeedbackResult, Toast } from "../types";

interface AppStore {
  // Text
  inputText: string;
  // TTS
  ttsState: TtsState;
  ttsSpeed: number;
  // Stop-TTS-playback callback registered by PlaybackControls; called by
  // RecordingPanel before start_recording so the mic records only the user.
  ttsStop: (() => void) | null;
  // Recording
  recordingState: RecordingState;
  audioLevel: number;
  recordingTimer: number;
  // Feedback
  feedback: FeedbackResult | null;
  // Captured image thumbnail (#4) — object URL (real) or data URL (mock).
  // The store is the single owner; setter revokes the previous URL.
  captureImageUrl: string | null;
  // Toasts
  toasts: Toast[];

  // Actions
  setInputText(text: string): void;
  setTtsState(state: TtsState): void;
  setTtsSpeed(speed: number): void;
  setTtsStop(fn: (() => void) | null): void;
  setRecordingState(state: RecordingState): void;
  setAudioLevel(level: number): void;
  setRecordingTimer(seconds: number): void;
  setFeedback(result: FeedbackResult): void;
  clearFeedback(): void;
  setCaptureImageUrl(url: string): void;
  clearCaptureImage(): void;
  addToast(message: string, type: "error" | "info"): void;
  removeToast(id: string): void;
}

const INITIAL_STATE = {
  inputText: "",
  ttsState: "idle" as TtsState,
  ttsSpeed: 1.0,
  ttsStop: null as (() => void) | null,
  recordingState: "idle" as RecordingState,
  audioLevel: 0,
  recordingTimer: 0,
  feedback: null,
  captureImageUrl: null,
  toasts: [],
};

export const useAppStore = create<AppStore>()((set) => ({
  ...INITIAL_STATE,

  setInputText: (text) => set({ inputText: text }),
  setTtsState: (ttsState) => set({ ttsState }),
  setTtsSpeed: (ttsSpeed) => set({ ttsSpeed }),
  setTtsStop: (ttsStop) => set({ ttsStop }),
  setRecordingState: (recordingState) => set({ recordingState }),
  setAudioLevel: (audioLevel) => set({ audioLevel }),
  setRecordingTimer: (recordingTimer) => set({ recordingTimer }),
  setFeedback: (feedback) => set({ feedback }),
  clearFeedback: () => set({ feedback: null }),
  // Single-owner object-URL lifecycle: revoke the previous URL before replacing
  // / clearing so blob URLs don't leak (review #5). Revoking a data: URL (mock)
  // is a harmless no-op.
  setCaptureImageUrl: (url) =>
    set((s) => {
      if (s.captureImageUrl) URL.revokeObjectURL(s.captureImageUrl);
      return { captureImageUrl: url };
    }),
  clearCaptureImage: () =>
    set((s) => {
      if (s.captureImageUrl) URL.revokeObjectURL(s.captureImageUrl);
      return { captureImageUrl: null };
    }),
  addToast: (message, type) =>
    set((s) => ({
      toasts: [...s.toasts, { id: crypto.randomUUID(), message, type }],
    })),
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// Expose initial state for test resets
(useAppStore as unknown as { getInitialState: () => typeof INITIAL_STATE }).getInitialState =
  () => INITIAL_STATE;
