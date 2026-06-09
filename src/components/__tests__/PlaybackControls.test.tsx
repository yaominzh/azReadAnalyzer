import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../../store/useAppStore";
import PlaybackControls from "../PlaybackControls";

describe("PlaybackControls", () => {
  beforeEach(() => useAppStore.setState({ inputText: "", ttsState: "idle", ttsSpeed: 1.0 }));

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
});
