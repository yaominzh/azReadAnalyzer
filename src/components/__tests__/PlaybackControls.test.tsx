import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store/useAppStore";
import PlaybackControls from "../PlaybackControls";

describe("PlaybackControls", () => {
  beforeEach(() => {
    useAppStore.setState({
      inputText: "", ttsState: "idle", ttsSpeed: 1.0,
      recordingState: "idle", ttsStop: null,
    });
    vi.mocked(invoke).mockClear();
  });

  it("renders play button and speed selector", () => {
    useAppStore.setState({ inputText: "hi" });
    render(<PlaybackControls />);
    expect(screen.getByRole("button", { name: /play/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("disables play button when inputText is empty", () => {
    render(<PlaybackControls />);
    expect(screen.getByRole("button", { name: /play/i })).toBeDisabled();
  });

  it("registers a ttsStop callback on mount", () => {
    useAppStore.setState({ inputText: "hi" });
    render(<PlaybackControls />);
    expect(typeof useAppStore.getState().ttsStop).toBe("function");
  });

  it("stops playback when recording starts (defensive effect)", async () => {
    useAppStore.setState({ inputText: "hi", ttsState: "playing" });
    render(<PlaybackControls />);
    act(() => { useAppStore.setState({ recordingState: "recording" }); });
    await waitFor(() => expect(useAppStore.getState().ttsState).toBe("idle"));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("stop_tts_stream");
  });
});
