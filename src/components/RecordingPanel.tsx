import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";

export default function RecordingPanel() {
  const recordingState = useAppStore((s) => s.recordingState);
  const audioLevel = useAppStore((s) => s.audioLevel);
  const inputText = useAppStore((s) => s.inputText);
  const addToast = useAppStore((s) => s.addToast);
  const clearFeedback = useAppStore((s) => s.clearFeedback);

  const [timer, setTimer] = useState(0);
  const disabled = !inputText.trim();

  // Effect only manages the ticking interval; the reset lives in handleRecord
  // (event handler) to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    if (recordingState !== "recording") return;
    const id = setInterval(() => setTimer((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [recordingState]);

  async function handleRecord() {
    clearFeedback();
    setTimer(0);
    try {
      await invoke("start_recording");
    } catch (e) {
      addToast(String(e), "error");
    }
  }

  async function handleStop() {
    try {
      await invoke("stop_recording", { originalText: inputText });
    } catch (e) {
      addToast(String(e), "error");
    }
  }

  function fmt(s: number) {
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  return (
    <div className="mb-3 pb-3 border-b border-white/[0.06]">
      <p className="text-[10px] font-semibold tracking-widest uppercase text-white/28 mb-2.5">
        Record Your Reading
      </p>

      {recordingState === "analyzing" ? (
        <p className="text-[13px] text-white/40 italic">Analyzing your recording…</p>
      ) : (
        <div className="flex items-center gap-3">
          {/* Record / Stop button */}
          {recordingState === "recording" ? (
            <button
              aria-label="Stop"
              onClick={handleStop}
              className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 bg-red-500/20 border-2 border-red-500/70 hover:bg-red-500/30 transition-all"
            >
              <div className="w-4 h-4 rounded-sm bg-red-400" />
            </button>
          ) : (
            <button
              aria-label="Record"
              onClick={handleRecord}
              disabled={disabled}
              className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 bg-red-500/15 border-2 border-red-500/50 hover:bg-red-500/25 hover:border-red-500/80 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <div className="w-4 h-4 rounded-full bg-red-400" />
            </button>
          )}

          {/* Waveform */}
          <div className="flex-1 h-9 flex items-center gap-[2px] px-1">
            {Array.from({ length: 20 }, (_, i) => {
              const active = recordingState === "recording";
              const height = active
                ? Math.max(0.15, audioLevel * (0.5 + Math.sin(i * 0.8) * 0.5))
                : 0.15;
              return (
                <div
                  key={i}
                  className="flex-1 rounded-sm transition-all duration-75"
                  style={{
                    height: `${height * 100}%`,
                    background: active
                      ? "rgba(99,102,241,0.6)"
                      : "rgba(255,255,255,0.1)",
                  }}
                />
              );
            })}
          </div>

          <span className="text-[13px] text-white/50 tabular-nums">
            {recordingState === "recording" ? fmt(timer) : "00:00"}
          </span>
        </div>
      )}
    </div>
  );
}
