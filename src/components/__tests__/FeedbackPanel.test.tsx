import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../../store/useAppStore";
import FeedbackPanel from "../FeedbackPanel";
import type { FeedbackResult } from "../../types";

const MOCK_FEEDBACK: FeedbackResult = {
  score: 87,
  transcription: "hello world",
  diff: [
    { text: "hello ", type: "correct" },
    { text: "world", type: "missed" },
    { text: "earth", type: "added" },
  ],
  pacing: {
    wordsPerMinute: 142,
    articulationRate: 168,
    pauseCount: 6,
    totalPauseMs: 4200,
    pauseRatio: 0.21,
    longHesitations: 2,
  },
  comments: [{ icon: "🐢", text: "Aim for 150–170 wpm." }],
};

describe("FeedbackPanel", () => {
  beforeEach(() => useAppStore.setState({ feedback: null }));

  it("renders nothing when no feedback", () => {
    const { container } = render(<FeedbackPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("shows score when feedback is ready", () => {
    useAppStore.setState({ feedback: MOCK_FEEDBACK });
    render(<FeedbackPanel />);
    expect(screen.getByText("87")).toBeInTheDocument();
  });

  it("renders diff tokens with correct text", () => {
    useAppStore.setState({ feedback: MOCK_FEEDBACK });
    render(<FeedbackPanel />);
    expect(screen.getByText(/hello/)).toBeInTheDocument();
  });

  it("renders pacing metrics", () => {
    useAppStore.setState({ feedback: MOCK_FEEDBACK });
    render(<FeedbackPanel />);
    expect(screen.getByText(/142/)).toBeInTheDocument();   // wpm
    expect(screen.getByText(/6/)).toBeInTheDocument();     // pause count
  });

  it("renders LLM comment", () => {
    useAppStore.setState({ feedback: MOCK_FEEDBACK });
    render(<FeedbackPanel />);
    expect(screen.getByText(/150–170 wpm/)).toBeInTheDocument();
  });

  it("suppresses score + comments when score is null (LLM unreachable)", () => {
    useAppStore.setState({ feedback: { ...MOCK_FEEDBACK, score: null, comments: [] } });
    render(<FeedbackPanel />);
    expect(screen.queryByText("87")).not.toBeInTheDocument();        // no score ring
    expect(screen.getByText(/AI coach unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/142/)).toBeInTheDocument();             // pacing still shown
  });
});
