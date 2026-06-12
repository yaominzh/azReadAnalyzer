import { useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import { createStreamPlayer, type StreamPlayer } from "../lib/streamPlayer";

const SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0];

export default function PlaybackControls() {
  const inputText = useAppStore((s) => s.inputText);
  const ttsSpeed = useAppStore((s) => s.ttsSpeed);
  const setTtsSpeed = useAppStore((s) => s.setTtsSpeed);
  const ttsState = useAppStore((s) => s.ttsState);
  const setTtsState = useAppStore((s) => s.setTtsState);
  const addToast = useAppStore((s) => s.addToast);

  const ctxRef = useRef<AudioContext | null>(null);
  const playerRef = useRef<StreamPlayer | null>(null);
  const sessionRef = useRef(0);
  const speedRef = useRef(ttsSpeed);
  // eslint-disable-next-line react-hooks/refs -- intentional latest-value mirror for callbacks
  speedRef.current = ttsSpeed;
  const rafRef = useRef<number | null>(null);
  const streamDoneRef = useRef(false); // true once the stream has fully arrived
  const playbackTextRef = useRef(""); // text the current playback was made from

  // Fallback (single-buffer) state.
  const fbSourceRef = useRef<AudioBufferSourceNode | null>(null);

  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const disabled = !inputText.trim();

  function getCtx(): AudioContext {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }

  function stopProgress() {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }

  // Progress/completion are driven by the audio timeline (ctx-time bounds from
  // the player), so they're correct under pause/resume (ctx.currentTime freezes
  // on suspend) and any playback speed (end already accounts for per-chunk rate).
  function startProgress() {
    const ctx = ctxRef.current;
    const player = playerRef.current;
    function tick() {
      if (!ctx || !player) return;
      const synth = player.synthDuration();
      const start = player.playbackStartTime();
      const end = player.playbackEndTime();
      setDuration(synth);
      if (start != null && end > start) {
        const p = Math.min(1, Math.max(0, (ctx.currentTime - start) / (end - start)));
        setProgress(p);
        setCurrentTime(p * synth);
        // Stream fully arrived AND its scheduled audio has played out → done.
        if (streamDoneRef.current && ctx.currentTime >= end - 0.02) {
          stopProgress(); setProgress(1); setCurrentTime(synth); setTtsState("idle"); return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    stopProgress();
    rafRef.current = requestAnimationFrame(tick);
  }

  // Local teardown only. Does NOT cancel the backend: a fresh play_tts_stream
  // supersedes the prior stream via tts_gen, and calling stop_tts_stream then
  // immediately starting a new stream would race (the stop could cancel the new
  // one). Backend cancellation happens only on unmount (see the effect). (review #1)
  function teardown() {
    sessionRef.current++;           // invalidate any in-flight session
    stopProgress();
    playerRef.current?.stop();
    playerRef.current = null;
    if (fbSourceRef.current) {
      try { fbSourceRef.current.stop(); } catch { /* noop */ }
      fbSourceRef.current.disconnect();
      fbSourceRef.current = null;
    }
  }

  async function handlePlay() {
    if (ttsState === "playing") {
      // pause: freeze the whole scheduled timeline.
      ctxRef.current?.suspend().catch(() => {});
      stopProgress();
      setTtsState("idle");
      return;
    }
    // Resume a paused clip (streaming or fallback) without re-synthesizing —
    // but only if the text hasn't changed since it was made (review #2).
    if (
      ctxRef.current &&
      ctxRef.current.state === "suspended" &&
      playbackTextRef.current === inputText
    ) {
      await ctxRef.current.resume();
      startProgress();
      setTtsState("playing");
      return;
    }

    // Fresh playback (new text, or first play, or finished).
    teardown();
    const session = ++sessionRef.current;
    playbackTextRef.current = inputText;
    setTtsState("playing");
    setProgress(0); setCurrentTime(0); setDuration(0);
    streamDoneRef.current = false;

    const ctx = getCtx();
    await ctx.resume();
    const player = createStreamPlayer(ctx, () => speedRef.current);
    playerRef.current = player;
    let received = false;

    const onChunk = new Channel<ArrayBuffer>();
    onChunk.onmessage = (chunk) => {
      if (session !== sessionRef.current) return; // stale
      received = true;
      player.pushChunk(chunk);
    };

    startProgress();
    try {
      await invoke("play_tts_stream", { text: inputText, onChunk });
      // Stream fully arrived; the progress tick flips to idle once it plays out.
      if (session === sessionRef.current) streamDoneRef.current = true;
    } catch (e) {
      if (session !== sessionRef.current) return; // stale
      if (!received) {
        await playFallback(session); // sidecar down / non-2xx before any audio
      } else {
        stopProgress();
        setTtsState("idle");
        addToast(String(e), "error");
      }
    }
  }

  // Fallback: the existing full-WAV path via play_tts (single buffer).
  async function playFallback(session: number) {
    try {
      const bytes = await invoke<ArrayBuffer>("play_tts", { text: inputText });
      if (session !== sessionRef.current) return;
      const ctx = getCtx();
      await ctx.resume();
      const buf = await ctx.decodeAudioData(bytes.slice(0));
      if (session !== sessionRef.current) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = speedRef.current;
      src.connect(ctx.destination);
      fbSourceRef.current = src;

      const startAt = ctx.currentTime + 0.05;
      src.start(startAt);
      src.onended = () => { if (session === sessionRef.current) { stopProgress(); setProgress(1); setTtsState("idle"); } };

      // Expose the fallback as a player so progress + resume use the SAME ctx-time
      // path as streaming (review #3 — resume no longer reads a stale empty player).
      playerRef.current = {
        pushChunk() {},
        pause() { ctx.suspend(); },
        resume() { ctx.resume(); },
        stop() { try { src.stop(); } catch { /* noop */ } src.disconnect(); },
        synthDuration: () => buf.duration,
        playbackStartTime: () => startAt,
        playbackEndTime: () => startAt + buf.duration / speedRef.current,
      };
      streamDoneRef.current = true; // fallback audio is fully available
      startProgress();
    } catch (e) {
      if (session === sessionRef.current) { setTtsState("idle"); addToast(String(e), "error"); }
    }
  }

  function handleSpeedChange(speed: number) {
    speedRef.current = speed;
    setTtsSpeed(speed);
    // Streaming: applies to chunks scheduled hereafter (see spec speed contract).
    // Fallback single source: update live.
    if (fbSourceRef.current) fbSourceRef.current.playbackRate.value = speed;
  }

  useEffect(() => () => {
    teardown();
    invoke("stop_tts_stream").catch(() => {}); // cancel any in-flight backend stream on unmount
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup; teardown is stable
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

        <div className="flex-1 h-[3px] bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-indigo-400 rounded-full transition-all"
            style={{ width: `${progress * 100}%` }}
          />
        </div>

        <span className="text-[12px] text-white/35 tabular-nums">
          {fmt(currentTime)} / {fmt(duration)}
        </span>

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
