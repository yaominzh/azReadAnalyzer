import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import type { PrepareMarkdownResult } from "../types";

const PLACEHOLDER = `One file per line. Optional line range with :start-end
/Users/you/notes.md
/Users/you/chapter.md:10-50`;

function summarize(warnings: string[]): string {
  if (warnings.length === 1) return warnings[0];
  return `${warnings.length} notes — ${warnings[0]} …`;
}

export default function ReadMarkdownPanel({ onClose }: { onClose: () => void }) {
  const setInputText = useAppStore((s) => s.setInputText);
  const clearFeedback = useAppStore((s) => s.clearFeedback);
  const clearCaptureImage = useAppStore((s) => s.clearCaptureImage);
  const addToast = useAppStore((s) => s.addToast);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);
  const closedRef = useRef(false);

  // Esc to close.
  useEffect(() => {
    closedRef.current = false; // (re)mount resets — survives React StrictMode's dev setup→cleanup→setup
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") handleClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      closedRef.current = true; // real unmount invalidates any in-flight request (review #9)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
  }, []);

  function handleClose() {
    closedRef.current = true;
    onClose();
  }

  async function handleRead() {
    if (!input.trim() || loading) return;
    const req = ++reqRef.current;
    setLoading(true);
    try {
      const res = import.meta.env.VITE_USE_MOCK
        ? ({ text: "Sample Markdown content for mock-mode UI development.", warnings: [] } as PrepareMarkdownResult)
        : await invoke<PrepareMarkdownResult>("prepare_markdown", { input });
      if (req !== reqRef.current || closedRef.current) return; // stale / closed
      setInputText(res.text);
      clearCaptureImage();
      if (!import.meta.env.VITE_USE_MOCK) {
        invoke("clear_session_media").catch(() => {}); // also clear Rust's last_capture_png (review #2)
      }
      clearFeedback();
      if (res.warnings.length > 0) addToast(summarize(res.warnings), "info");
      handleClose();
    } catch (e) {
      if (req !== reqRef.current || closedRef.current) return;
      addToast(String(e), "error");
      setLoading(false);
    }
  }

  return createPortal(
    <div onClick={handleClose} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" style={{ backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-[460px] max-h-[85vh] overflow-y-auto rounded-xl border border-white/10 bg-[#0c0c0c]/95 p-5 text-white/80">
        <p className="text-[13px] font-semibold tracking-wider uppercase text-white/40 mb-1">Read from Markdown</p>
        <p className="text-[11px] text-white/40 mb-3">One local file path per line. Add <span className="text-fuchsia-300">:10-50</span> for a line range (1-based, inclusive).</p>
        <textarea
          aria-label="Markdown file paths"
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          className="w-full min-h-[140px] bg-[#0b0b0d] border border-white/12 rounded-lg p-3 text-[13px] leading-relaxed text-white/85 font-mono outline-none"
        />
        <div className="flex gap-2 mt-4 justify-end">
          <button onClick={handleClose} className="px-3 py-2 rounded-lg text-[12px] bg-white/[0.06] border border-white/10 text-white/60">Cancel</button>
          <button onClick={handleRead} disabled={!input.trim() || loading}
            className="px-4 py-2 rounded-lg text-[12px] font-medium bg-gradient-to-br from-indigo-500 to-indigo-400 text-white disabled:opacity-40 disabled:cursor-not-allowed">
            {loading ? "Reading…" : "Read →"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
