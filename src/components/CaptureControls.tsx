import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";

export default function CaptureControls() {
  const addToast = useAppStore((s) => s.addToast);
  const setInputText = useAppStore((s) => s.setInputText);
  const clearFeedback = useAppStore((s) => s.clearFeedback);

  async function handleScreenshot() {
    try {
      await invoke("capture_screenshot");
    } catch (e) {
      if (String(e) !== "Screenshot cancelled") {
        addToast(String(e), "error");
      }
    }
  }

  async function handlePaste() {
    try {
      const text = await invoke<string>("paste_clipboard");
      setInputText(text);
    } catch (e) {
      addToast(String(e), "error");
    }
  }

  function handleClear() {
    setInputText("");
    clearFeedback();
  }

  const btn =
    "px-3 py-1.5 rounded-lg text-[12px] font-medium text-white/70 bg-white/[0.06] border border-white/10 hover:bg-white/[0.1] hover:text-white/90 transition-colors";

  return (
    <div className="flex items-center gap-2 pt-3 border-t border-white/[0.06] flex-shrink-0">
      <button className={btn} onClick={handleScreenshot}>
        Screenshot
      </button>
      <button className={btn} onClick={handlePaste}>
        Paste
      </button>
      <button className={`${btn} ml-auto`} onClick={handleClear}>
        Clear
      </button>
    </div>
  );
}
