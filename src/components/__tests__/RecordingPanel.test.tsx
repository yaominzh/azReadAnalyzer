import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store/useAppStore";
import RecordingPanel from "../RecordingPanel";

describe("RecordingPanel", () => {
  beforeEach(() =>
    useAppStore.setState({ recordingState: "idle", inputText: "hello" })
  );

  it("shows Record button when idle", () => {
    render(<RecordingPanel />);
    expect(screen.getByRole("button", { name: /record/i })).toBeInTheDocument();
  });

  it("disables Record when no input text", () => {
    useAppStore.setState({ inputText: "" });
    render(<RecordingPanel />);
    expect(screen.getByRole("button", { name: /record/i })).toBeDisabled();
  });

  it("shows Stop button when recording", () => {
    useAppStore.setState({ recordingState: "recording" });
    render(<RecordingPanel />);
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
  });

  it("shows analyzing message when analyzing", () => {
    useAppStore.setState({ recordingState: "analyzing" });
    render(<RecordingPanel />);
    expect(screen.getByText(/analyzing/i)).toBeInTheDocument();
  });
});

describe("RecordingPanel — stops TTS before recording", () => {
  beforeEach(() => {
    useAppStore.setState({ recordingState: "idle", inputText: "hello", ttsStop: null });
    vi.mocked(invoke).mockClear();
  });
  afterEach(() => { vi.mocked(invoke).mockReset(); });

  it("calls ttsStop before invoking start_recording", async () => {
    const calls: string[] = [];
    const ttsStop = vi.fn(() => { calls.push("ttsStop"); });
    useAppStore.setState({ ttsStop });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(`invoke:${cmd}`);
      return undefined;
    });

    render(<RecordingPanel />);
    fireEvent.click(screen.getByRole("button", { name: /record/i }));

    await waitFor(() => expect(calls).toContain("invoke:start_recording"));
    expect(ttsStop).toHaveBeenCalled();
    expect(calls[0]).toBe("ttsStop"); // stop runs first, before the mic opens
    expect(calls.indexOf("ttsStop")).toBeLessThan(calls.indexOf("invoke:start_recording"));
  });
});
