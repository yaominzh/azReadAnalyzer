import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";

const SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0];

export default function PlaybackControls() {
  const inputText = useAppStore((s) => s.inputText);
  const ttsSpeed = useAppStore((s) => s.ttsSpeed);
  const setTtsSpeed = useAppStore((s) => s.setTtsSpeed);
  const ttsState = useAppStore((s) => s.ttsState);
  const setTtsState = useAppStore((s) => s.setTtsState);
  const addToast = useAppStore((s) => s.addToast);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const disabled = !inputText.trim();

  async function handlePlay() {
    if (ttsState === "playing") {
      audioRef.current?.pause();
      setTtsState("idle");
      return;
    }

    try {
      setTtsState("playing");
      // Tier-B B1: play_tts returns raw bytes via tauri::ipc::Response, so the
      // frontend receives an ArrayBuffer (not a JSON number[]).
      const buffer = await invoke<ArrayBuffer>("play_tts", { text: inputText });
      const blob = new Blob([new Uint8Array(buffer)], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);

      const audio = new Audio(url);
      audio.playbackRate = ttsSpeed;
      audioRef.current = audio;

      audio.onloadedmetadata = () => setDuration(audio.duration);
      audio.ontimeupdate = () => {
        setCurrentTime(audio.currentTime);
        setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
      };
      audio.onended = () => {
        setTtsState("idle");
        setProgress(0);
        setCurrentTime(0);
        URL.revokeObjectURL(url);
      };

      await audio.play();
    } catch (e) {
      setTtsState("idle");
      addToast(String(e), "error");
    }
  }

  function handleSpeedChange(speed: number) {
    setTtsSpeed(speed);
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }

  function fmt(s: number) {
    if (!Number.isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  }

  return (
    <div className="mb-3">
      <p className="text-[10px] font-semibold tracking-widest uppercase text-white/28 mb-2.5">
        Listen
      </p>
      <div className="flex items-center gap-3">
        {/* Play/Pause */}
        <button
          aria-label={ttsState === "playing" ? "Pause" : "Play"}
          onClick={handlePlay}
          disabled={disabled}
          className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 bg-gradient-to-br from-indigo-500 to-indigo-400 shadow-[0_0_20px_rgba(99,102,241,0.35)] hover:shadow-[0_0_30px_rgba(99,102,241,0.5)] hover:scale-105 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {ttsState === "playing" ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
              <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
              <polygon points="5,3 19,12 5,21" />
            </svg>
          )}
        </button>

        {/* Progress */}
        <div className="flex-1 h-[3px] bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-indigo-400 rounded-full transition-all"
            style={{ width: `${progress * 100}%` }}
          />
        </div>

        <span className="text-[12px] text-white/35 tabular-nums">
          {fmt(currentTime)} / {fmt(duration)}
        </span>

        {/* Speed */}
        <select
          aria-label="Playback speed"
          value={ttsSpeed}
          onChange={(e) => handleSpeedChange(Number(e.target.value))}
          className="bg-white/[0.06] border border-white/10 rounded-md text-[12px] text-white/70 px-2 py-1 outline-none cursor-pointer"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>{s}x</option>
          ))}
        </select>
      </div>
    </div>
  );
}
