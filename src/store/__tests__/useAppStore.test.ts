import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../useAppStore";

const ZERO_PACING = {
  wordsPerMinute: 0, articulationRate: 0, pauseCount: 0,
  totalPauseMs: 0, pauseRatio: 0, longHesitations: 0, pausesReliable: false,
};

describe("useAppStore", () => {
  beforeEach(() =>
    useAppStore.setState(
      (useAppStore as unknown as { getInitialState: () => object }).getInitialState()
    )
  );

  it("starts with idle recording state", () => {
    expect(useAppStore.getState().recordingState).toBe("idle");
  });

  it("setInputText updates text", () => {
    useAppStore.getState().setInputText("hello world");
    expect(useAppStore.getState().inputText).toBe("hello world");
  });

  it("setFeedback stores feedback result", () => {
    const fb = { score: 85, transcription: "hello", diff: [], pacing: ZERO_PACING, comments: [] };
    useAppStore.getState().setFeedback(fb);
    expect(useAppStore.getState().feedback?.score).toBe(85);
  });

  it("clearFeedback resets feedback to null", () => {
    useAppStore.getState().setFeedback({ score: 85, transcription: "x", diff: [], pacing: ZERO_PACING, comments: [] });
    useAppStore.getState().clearFeedback();
    expect(useAppStore.getState().feedback).toBeNull();
  });
});
