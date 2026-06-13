import { useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import { createStreamPlayer, createBufferPlayer, type StreamPlayer } from "../lib/streamPlayer";

const SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0];

export default function PlaybackControls() {
  const inputText = useAppStore((s) => s.inputText);
  const ttsSpeed = useAppStore((s) => s.ttsSpeed);
  const setTtsSpeed = useAppStore((s) => s.setTtsSpeed);
  const ttsState = useAppStore((s) => s.ttsState);
  const setTtsState = useAppStore((s) => s.setTtsState);
  const recordingState = useAppStore((s) => s.recordingState);
  const setTtsStop = useAppStore((s) => s.setTtsStop);
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
  const scrubbingRef = useRef(false);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekable, setSeekable] = useState(false);

  const disabled = !inputText.trim();

  function getCtx(): AudioContext {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }

  function stopProgress() {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }

  // Progress/completion are driven by the audio timeline (ctx-time bounds from
  // the player), so they're correct under pause/resume and any playback speed.
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
        if (streamDoneRef.current && ctx.currentTime >= end - 0.02) {
          stopProgress(); setProgress(1); setCurrentTime(synth); setTtsState("idle"); return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    stopProgress();
    rafRef.current = requestAnimationFrame(tick);
  }

  // Local teardown only (does NOT cancel the backend stream).
  function teardown() {
    sessionRef.current++;
    stopProgress();
    playerRef.current?.stop();
    playerRef.current = null;
  }

  // Full stop used before recording (Feature 2). Synchronous audible stop +
  // backend cancel, so the mic that opens next records only the user's voice.
  function stopPlayback() {
    teardown();
    invoke("stop_tts_stream").catch(() => {});
    setTtsState("idle");
    setProgress(0); setCurrentTime(0); setDuration(0);
    setSeekable(false);
    streamDoneRef.current = false;
    playbackTextRef.current = ""; // review #1: prevent a later Play resuming a torn-down clip
  }

  async function handlePlay() {
    if (ttsState === "playing") {
      await ctxRef.current?.suspend().catch(() => {});
      stopProgress();
      setTtsState("idle");
      return;
    }
    if (
      ctxRef.current &&
      ctxRef.current.state === "suspended" &&
      playerRef.current &&                       // review #1: a torn-down player can't resume
      playbackTextRef.current === inputText
    ) {
      await ctxRef.current.resume();
      startProgress();
      setTtsState("playing");
      return;
    }

    teardown();
    const session = ++sessionRef.current;
    playbackTextRef.current = inputText;
    setTtsState("playing");
    setProgress(0); setCurrentTime(0); setDuration(0);
    setSeekable(false);
    streamDoneRef.current = false;

    const ctx = getCtx();
    await ctx.resume();
    const player = createStreamPlayer(ctx, () => speedRef.current);
    playerRef.current = player;
    let received = false;

    const onChunk = new Channel<ArrayBuffer>();
    onChunk.onmessage = (chunk) => {
      if (session !== sessionRef.current) return;
      received = true;
      player.pushChunk(chunk);
    };

    startProgress();
    try {
      await invoke("play_tts_stream", { text: inputText, onChunk });
      if (session === sessionRef.current) {
        streamDoneRef.current = true;
        player.markComplete();
        setSeekable(true); // full clip buffered → seek handle now active
      }
    } catch (e) {
      if (session !== sessionRef.current) return;
      if (!received) {
        await playFallback(session);
      } else {
        // Mid-stream failure after audio began: tear down the scheduled sources
        // so audio doesn't keep playing while the UI shows idle (review #2).
        teardown();
        setTtsState("idle");
        setProgress(0); setCurrentTime(0); setDuration(0);
        setSeekable(false);
        streamDoneRef.current = false;
        addToast(String(e), "error");
      }
    }
  }

  // Fallback: the full-WAV play_tts path, played via the seek-capable buffer player.
  async function playFallback(session: number) {
    try {
      const bytes = await invoke<ArrayBuffer>("play_tts", { text: inputText });
      if (session !== sessionRef.current) return;
      const ctx = getCtx();
      await ctx.resume();
      const buf = await ctx.decodeAudioData(bytes.slice(0));
      if (session !== sessionRef.current) return;
      const player = createBufferPlayer(ctx, buf, () => speedRef.current);
      playerRef.current = player;
      streamDoneRef.current = true;
      player.seek(0); // begin playback from the start
      setSeekable(true);
      startProgress();
    } catch (e) {
      if (session === sessionRef.current) { setTtsState("idle"); addToast(String(e), "error"); }
    }
  }

  function handleSpeedChange(speed: number) {
    speedRef.current = speed;
    setTtsSpeed(speed);
    playerRef.current?.setSpeed(speed); // updates live source + anchor (post-seek/fallback)
  }

  // --- Seek (Feature 1) ---
  function fractionFromClientX(clientX: number): number {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }

  function seekTo(fraction: number) {
    const player = playerRef.current;
    const ctx = ctxRef.current;
    if (!player || !ctx || !player.isSeekable()) return;
    const dur = player.synthDuration();
    const pos = Math.min(dur, Math.max(0, fraction * dur));
    const wasPlaying = ttsState === "playing";
    player.seek(pos);
    setProgress(dur > 0 ? pos / dur : 0);
    setCurrentTime(pos);
    if (wasPlaying) {
      startProgress(); // keep playing from the new spot
    } else if (ctx.state === "suspended") {
      // paused mid-clip: reposition, stay paused (next Play resumes from here)
    } else {
      setTtsState("playing"); // was idle/finished: replay from the new spot
      startProgress();
    }
  }

  function onScrubStart(e: React.PointerEvent<HTMLDivElement>) {
    if (!playerRef.current?.isSeekable()) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    scrubbingRef.current = true;
    stopProgress();
    const f = fractionFromClientX(e.clientX);
    const dur = playerRef.current?.synthDuration() ?? 0;
    setProgress(f); setCurrentTime(f * dur);
  }
  function onScrubMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbingRef.current) return;
    const f = fractionFromClientX(e.clientX);
    const dur = playerRef.current?.synthDuration() ?? 0;
    setProgress(f); setCurrentTime(f * dur);
  }
  function onScrubEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    seekTo(fractionFromClientX(e.clientX));
  }

  // Keyboard seek (review #4): makes role="slider" genuinely operable.
  function onSeekKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!playerRef.current?.isSeekable()) return;
    let f: number;
    if (e.key === "ArrowLeft") f = Math.max(0, progress - 0.05);
    else if (e.key === "ArrowRight") f = Math.min(1, progress + 0.05);
    else if (e.key === "Home") f = 0;
    else if (e.key === "End") f = 1;
    else return;
    e.preventDefault();
    seekTo(f);
  }

  // Register the stop-before-record callback (Feature 2, primary path).
  useEffect(() => {
    setTtsStop(stopPlayback);
    return () => setTtsStop(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- register once; closes over stable refs/setters
  }, []);

  // Defensive: also stop if recording is started via any other path.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing playback teardown to an external state transition (recording start)
    if (recordingState === "recording") stopPlayback();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react only to recordingState
  }, [recordingState]);

  useEffect(() => () => {
    teardown();
    invoke("stop_tts_stream").catch(() => {});
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

        <div
          ref={trackRef}
          onPointerDown={onScrubStart}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubEnd}
          onKeyDown={onSeekKeyDown}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-disabled={!seekable}
          tabIndex={seekable ? 0 : -1}
          className="relative flex-1 h-4 flex items-center outline-none"
          style={{ cursor: seekable ? "pointer" : "default", touchAction: "none" }}
        >
          <div className="absolute inset-x-0 h-[3px] bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-indigo-400 rounded-full"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          {seekable && (
            <div
              className="absolute w-3 h-3 -ml-1.5 rounded-full bg-white shadow-[0_0_6px_rgba(99,102,241,0.6)] pointer-events-none"
              style={{ left: `${progress * 100}%` }}
            />
          )}
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
