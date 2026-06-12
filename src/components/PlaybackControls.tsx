import { useEffect, useRef, useState } from "react";
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

  // Playback via the Web Audio API (decodeAudioData + AudioBufferSourceNode).
  // The WebView <audio> element renders this 24kHz TTS WAV with a robotic /
  // "machinery" timbre, even though the identical bytes play cleanly natively;
  // Web Audio decodes + resamples with the high-quality path and fixes it.
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const startedAtRef = useRef(0);    // ctx time when the current segment started
  const offsetRef = useRef(0);       // buffer offset (s) the current segment started at
  const rafRef = useRef<number | null>(null);
  const stoppingRef = useRef(false); // true => the next onended is a manual stop/replace
  const speedRef = useRef(ttsSpeed); // mirror of ttsSpeed for the rAF/commit math
  speedRef.current = ttsSpeed;

  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const disabled = !inputText.trim();

  function getCtx(): AudioContext {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }

  function stopProgress() {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }

  function teardownSource() {
    if (sourceRef.current) {
      stoppingRef.current = true;
      try { sourceRef.current.stop(); } catch { /* already stopped */ }
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
  }

  function tick() {
    const ctx = ctxRef.current;
    const buf = bufferRef.current;
    if (!ctx || !buf) return;
    const cur = offsetRef.current + (ctx.currentTime - startedAtRef.current) * speedRef.current;
    const clamped = Math.min(cur, buf.duration);
    setCurrentTime(clamped);
    setProgress(buf.duration ? clamped / buf.duration : 0);
    if (cur < buf.duration) rafRef.current = requestAnimationFrame(tick);
  }

  function playFrom(offset: number) {
    const ctx = getCtx();
    const buf = bufferRef.current;
    if (!buf) return;
    teardownSource();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = speedRef.current;
    src.connect(ctx.destination);
    src.onended = () => {
      if (stoppingRef.current) { stoppingRef.current = false; return; } // manual stop/replace
      stopProgress();
      offsetRef.current = 0;
      setProgress(0);
      setCurrentTime(0);
      setTtsState("idle");
    };
    stoppingRef.current = false;
    src.start(0, offset);
    sourceRef.current = src;
    startedAtRef.current = ctx.currentTime;
    offsetRef.current = offset;
    stopProgress();
    rafRef.current = requestAnimationFrame(tick);
  }

  async function handlePlay() {
    if (ttsState === "playing") {
      // Pause: remember the position, stop the source.
      const ctx = ctxRef.current;
      if (ctx) {
        offsetRef.current += (ctx.currentTime - startedAtRef.current) * speedRef.current;
      }
      teardownSource();
      stopProgress();
      setTtsState("idle");
      return;
    }

    try {
      setTtsState("playing");
      // Resume a paused clip without re-synthesizing.
      if (
        bufferRef.current &&
        offsetRef.current > 0 &&
        offsetRef.current < bufferRef.current.duration
      ) {
        await getCtx().resume();
        playFrom(offsetRef.current);
        return;
      }
      // Fresh: synthesize, decode, play from the start.
      const bytes = await invoke<ArrayBuffer>("play_tts", { text: inputText });
      const ctx = getCtx();
      await ctx.resume();
      // decodeAudioData detaches its input — pass a copy.
      const buf = await ctx.decodeAudioData(bytes.slice(0));
      bufferRef.current = buf;
      setDuration(buf.duration);
      offsetRef.current = 0;
      playFrom(0);
    } catch (e) {
      setTtsState("idle");
      addToast(String(e), "error");
    }
  }

  function handleSpeedChange(speed: number) {
    // If playing, commit elapsed at the OLD rate, then apply the new rate live.
    if (ttsState === "playing" && ctxRef.current && sourceRef.current) {
      const ctx = ctxRef.current;
      offsetRef.current += (ctx.currentTime - startedAtRef.current) * speedRef.current;
      startedAtRef.current = ctx.currentTime;
      sourceRef.current.playbackRate.value = speed;
    }
    speedRef.current = speed;
    setTtsSpeed(speed);
  }

  // Clean up audio + timers on unmount.
  useEffect(() => {
    return () => {
      stopProgress();
      teardownSource();
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    };
  }, []);

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
