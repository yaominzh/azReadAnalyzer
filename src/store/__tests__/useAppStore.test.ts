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

  it("setCaptureImageUrl sets the url and clearCaptureImage nulls it", () => {
    useAppStore.getState().setCaptureImageUrl("blob:one");
    expect(useAppStore.getState().captureImageUrl).toBe("blob:one");
    // replacing revokes the previous and sets the new
    useAppStore.getState().setCaptureImageUrl("blob:two");
    expect(useAppStore.getState().captureImageUrl).toBe("blob:two");
    useAppStore.getState().clearCaptureImage();
    expect(useAppStore.getState().captureImageUrl).toBeNull();
  });

  it("stores and clears the ttsStop callback", () => {
    const fn = () => {};
    useAppStore.getState().setTtsStop(fn);
    expect(useAppStore.getState().ttsStop).toBe(fn);
    useAppStore.getState().setTtsStop(null);
    expect(useAppStore.getState().ttsStop).toBeNull();
  });
});
