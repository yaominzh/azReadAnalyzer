import { create } from "zustand";
import type { RecordingState, TtsState, FeedbackResult, Toast } from "../types";

interface AppStore {
  // Text
  inputText: string;
  // TTS
  ttsState: TtsState;
  ttsSpeed: number;
  // Recording
  recordingState: RecordingState;
  audioLevel: number;
  recordingTimer: number;
  // Feedback
  feedback: FeedbackResult | null;
  // Toasts
  toasts: Toast[];

  // Actions
  setInputText(text: string): void;
  setTtsState(state: TtsState): void;
  setTtsSpeed(speed: number): void;
  setRecordingState(state: RecordingState): void;
  setAudioLevel(level: number): void;
  setRecordingTimer(seconds: number): void;
  setFeedback(result: FeedbackResult): void;
  clearFeedback(): void;
  addToast(message: string, type: "error" | "info"): void;
  removeToast(id: string): void;
}

const INITIAL_STATE = {
  inputText: "",
  ttsState: "idle" as TtsState,
  ttsSpeed: 1.0,
  recordingState: "idle" as RecordingState,
  audioLevel: 0,
  recordingTimer: 0,
  feedback: null,
  toasts: [],
};

export const useAppStore = create<AppStore>()((set) => ({
  ...INITIAL_STATE,

  setInputText: (text) => set({ inputText: text }),
  setTtsState: (ttsState) => set({ ttsState }),
  setTtsSpeed: (ttsSpeed) => set({ ttsSpeed }),
  setRecordingState: (recordingState) => set({ recordingState }),
  setAudioLevel: (audioLevel) => set({ audioLevel }),
  setRecordingTimer: (recordingTimer) => set({ recordingTimer }),
  setFeedback: (feedback) => set({ feedback }),
  clearFeedback: () => set({ feedback: null }),
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
