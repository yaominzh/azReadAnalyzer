import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import { loadCaptureImage } from "../lib/loadCaptureImage";
import ReadMarkdownPanel from "./ReadMarkdownPanel";
import type { PasteResult } from "../types";

export default function CaptureControls() {
  const addToast = useAppStore((s) => s.addToast);
  const setInputText = useAppStore((s) => s.setInputText);
  const clearFeedback = useAppStore((s) => s.clearFeedback);
  const clearCaptureImage = useAppStore((s) => s.clearCaptureImage);
  const [readMdOpen, setReadMdOpen] = useState(false);

  async function handleScreenshot() {
    // capture_screenshot emits text-captured (with hasImage) → useTauriEvents
    // loads the thumbnail; no extra handling needed here.
    try {
      await invoke("capture_screenshot");
    } catch (e) {
      const msg = String(e);
      if (msg === "Screenshot cancelled") {
        // user pressed Esc / drew nothing — silent, expected.
      } else if (msg.includes("permission denied")) {
        addToast(
          "Screen Recording permission needed — enable it in System Settings → Privacy & Security → Screen Recording, then relaunch.",
          "error"
        );
      } else {
        addToast(msg, "error");
      }
    }
  }

  async function handlePaste() {
    try {
      const r = await invoke<PasteResult>("paste_clipboard");
      setInputText(r.text);
      if (r.hasImage) loadCaptureImage();
      else clearCaptureImage();
    } catch (e) {
      // Failed paste → no thumbnail (matches spec; QA D2).
      clearCaptureImage();
      addToast(String(e), "error");
    }
  }

  function handleClear() {
    setInputText("");
    clearFeedback();
    clearCaptureImage();
    invoke("clear_session_media").catch(() => {});
  }

  const btn =
    "px-3 py-1.5 rounded-lg text-[12px] font-medium text-white/70 bg-white/[0.06] border border-white/10 hover:bg-white/[0.1] hover:text-white/90 transition-colors";

  return (
    <>
      <div className="flex items-center gap-2 pt-3 border-t border-white/[0.06] flex-shrink-0">
        <button className={btn} onClick={handleScreenshot}>Screenshot</button>
        <button className={btn} onClick={handlePaste}>Paste</button>
        <button className={btn} onClick={() => setReadMdOpen(true)}>Read MD</button>
        <button className={`${btn} ml-auto`} onClick={handleClear}>Clear</button>
      </div>
      {readMdOpen && <ReadMarkdownPanel onClose={() => setReadMdOpen(false)} />}
    </>
  );
}
