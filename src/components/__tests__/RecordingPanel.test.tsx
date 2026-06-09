import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
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
