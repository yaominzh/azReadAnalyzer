import { StrictMode } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store/useAppStore";
import ReadMarkdownPanel from "../ReadMarkdownPanel";

describe("ReadMarkdownPanel", () => {
  beforeEach(() => {
    useAppStore.setState({ inputText: "", feedback: null, captureImageUrl: null, toasts: [] });
    vi.mocked(invoke).mockReset();
  });

  it("reads, sets input text, clears stale thumbnail + feedback, and closes", async () => {
    // seed stale session state to prove Read MD clears it
    useAppStore.setState({
      captureImageUrl: "blob:stale",
      feedback: { score: 7, transcription: "x", diff: [], pacing: {} as never, comments: [] },
    });
    vi.mocked(invoke).mockResolvedValue({ text: "hello world", warnings: [] });
    const onClose = vi.fn();
    render(<ReadMarkdownPanel onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/Users/a/x.md" } });
    fireEvent.click(screen.getByRole("button", { name: /read/i }));
    await waitFor(() => expect(useAppStore.getState().inputText).toBe("hello world"));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("prepare_markdown", { input: "/Users/a/x.md" });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("clear_session_media"); // backend media cleared (review #2)
    expect(useAppStore.getState().captureImageUrl).toBeNull(); // thumbnail cleared
    expect(useAppStore.getState().feedback).toBeNull();        // stale feedback cleared
    expect(onClose).toHaveBeenCalled();
  });

  it("shows one summary toast when there are warnings", async () => {
    vi.mocked(invoke).mockResolvedValue({ text: "ok", warnings: ["Skipped (not found): /a", "Range end clamped: /b"] });
    render(<ReadMarkdownPanel onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/a\n/b" } });
    fireEvent.click(screen.getByRole("button", { name: /read/i }));
    await waitFor(() => expect(useAppStore.getState().toasts.length).toBe(1)); // ONE summary toast, not two
  });

  it("does not overwrite input if closed before the read resolves (request guard)", async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(invoke).mockReturnValue(new Promise((r) => { resolve = r; }));
    const onClose = vi.fn();
    const { unmount } = render(<ReadMarkdownPanel onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/a.md" } });
    fireEvent.click(screen.getByRole("button", { name: /read/i }));
    unmount(); // panel closed/unmounted while in flight
    resolve({ text: "late", warnings: [] });
    await Promise.resolve();
    expect(useAppStore.getState().inputText).toBe(""); // stale result ignored
  });

  it("Cancel closes without calling the command", () => {
    const onClose = vi.fn();
    render(<ReadMarkdownPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  // Regression: under StrictMode (dev), effects run setup→cleanup→setup. If the
  // unmount-cleanup's `closedRef=true` isn't reset on the re-mount, the post-await
  // guard bails and the read silently no-ops (button stuck on "Reading…").
  it("still applies the result under StrictMode (closedRef reset on mount)", async () => {
    vi.mocked(invoke).mockResolvedValue({ text: "strict ok", warnings: [] });
    render(
      <StrictMode>
        <ReadMarkdownPanel onClose={() => {}} />
      </StrictMode>
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/a.md" } });
    fireEvent.click(screen.getByRole("button", { name: /read/i }));
    await waitFor(() => expect(useAppStore.getState().inputText).toBe("strict ok"));
  });
});
