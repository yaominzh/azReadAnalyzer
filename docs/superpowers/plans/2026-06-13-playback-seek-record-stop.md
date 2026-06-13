# Playback Seek Handle + Stop-on-Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a draggable seek handle to the Listen progress bar, and stop TTS playback the instant recording starts so the mic records only the user's voice.

**Architecture:** The TTS player (`src/lib/streamPlayer.ts`) gains the ability to **retain decoded PCM** and replay from an arbitrary offset. A new `createBufferPlayer` factory encapsulates single-complete-buffer playback with native seek; the streaming player delegates to it once seeking begins, and the `play_tts` fallback uses it directly. Stop-on-record is wired through a store-registered `ttsStop` callback that `RecordingPanel` invokes **before** `start_recording` (synchronous audible stop, so no bleed), with a defensive reactive effect as backup.

**Tech Stack:** React 19 + TypeScript, Zustand, Web Audio API (`AudioBufferSourceNode`, `decodeAudioData`), Tauri IPC, Vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-06-13-playback-seek-record-stop-design.md` (review-incorporated).

---

## File structure

| File | Change | Responsibility |
|------|--------|----------------|
| `src/lib/streamPlayer.ts` | rewrite | Player core: chunk streaming + retained-sample seek; new `createBufferPlayer`, `computeSeekAnchor`; `StreamPlayer` interface gains `seek/setSpeed/isSeekable/markComplete` |
| `src/lib/streamPlayer.test.ts` | extend | Keep int16 tests; add pure `computeSeekAnchor` tests |
| `src/store/useAppStore.ts` | edit | Add `ttsStop` slice (`ttsStop`, `setTtsStop`) |
| `src/store/__tests__/useAppStore.test.ts` | extend | Test `setTtsStop` set/clear |
| `src/components/PlaybackControls.tsx` | rewrite | Seek UI (thumb + scrub), `setSpeed` wiring, fallback via `createBufferPlayer`, register `ttsStop`, defensive stop effect |
| `src/components/__tests__/PlaybackControls.test.tsx` | extend | Keep render tests; add ttsStop-registration + defensive-stop tests |
| `src/components/RecordingPanel.tsx` | edit | Call `ttsStop()` before `start_recording` |
| `src/components/__tests__/RecordingPanel.test.tsx` | extend | Keep tests; add ordering test (stop before start_recording) |

---

## Task 1: `streamPlayer.ts` — retain samples, `computeSeekAnchor`, `createBufferPlayer`, seek/setSpeed

**Files:**
- Modify/rewrite: `src/lib/streamPlayer.ts`
- Test: `src/lib/streamPlayer.test.ts`

- [ ] **Step 1: Write the failing test for `computeSeekAnchor`**

Add to `src/lib/streamPlayer.test.ts` (keep the existing `int16ChunkToFloat32` describe block; add the import and this new block):

```ts
import { int16ChunkToFloat32, computeSeekAnchor } from "./streamPlayer";

describe("computeSeekAnchor", () => {
  it("maps the progress formula to position/total at T = startAt", () => {
    const startAt = 5, pos = 3, speed = 1.5, total = 10;
    const { start, end } = computeSeekAnchor(startAt, pos, speed, total);
    const fractionAtStart = (startAt - start) / (end - start);
    expect(fractionAtStart).toBeCloseTo(pos / total, 6); // shows the seeked position immediately
    expect(end - start).toBeCloseTo(total / speed, 6);    // remaining span scales by 1/speed
  });

  it("anchors position 0 so start === startAt", () => {
    const { start, end } = computeSeekAnchor(2, 0, 1, 8);
    expect(start).toBeCloseTo(2, 6);
    expect(end).toBeCloseTo(10, 6);
  });

  it("at 2x speed the clip span halves", () => {
    const { start, end } = computeSeekAnchor(0, 0, 2, 10);
    expect(end - start).toBeCloseTo(5, 6);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/streamPlayer.test.ts`
Expected: FAIL — `computeSeekAnchor` is not exported.

- [ ] **Step 3: Rewrite `src/lib/streamPlayer.ts`**

Replace the entire file with:

```ts
// Streaming TTS playback: assemble int16 LE PCM byte chunks into AudioBuffers
// and schedule them gaplessly. Once the stream is complete the decoded samples
// are retained so playback can seek to any offset (createBufferPlayer handles
// the single-complete-buffer case; the streaming player delegates to it once a
// seek happens). The play_tts fallback uses createBufferPlayer directly.

const SAMPLE_RATE = 24000;
const LOOKAHEAD = 0.1; // seconds — never schedule a chunk/seek in the past

/** Convert a byte chunk (prefixed by a carried remainder) into Float32 samples
 *  plus any leftover odd byte to carry into the next chunk. */
export function int16ChunkToFloat32(
  prev: Uint8Array,
  chunk: Uint8Array
): { samples: Float32Array; remainder: Uint8Array } {
  const buf = new Uint8Array(prev.length + chunk.length);
  buf.set(prev, 0);
  buf.set(chunk, prev.length);
  const frameCount = Math.floor(buf.length / 2);
  const samples = new Float32Array(frameCount);
  const dv = new DataView(buf.buffer, buf.byteOffset, frameCount * 2);
  for (let i = 0; i < frameCount; i++) {
    samples[i] = dv.getInt16(i * 2, true) / 32768;
  }
  return { samples, remainder: buf.slice(frameCount * 2) };
}

/** Virtual ctx-time anchor for a clip playing from `positionSec` at `speed`,
 *  started at ctx time `startAt`. With these bounds, the existing progress
 *  formula (T - start)/(end - start) equals absolutePosition/total. Pure. */
export function computeSeekAnchor(
  startAt: number,
  positionSec: number,
  speed: number,
  total: number
): { start: number; end: number } {
  return {
    start: startAt - positionSec / speed,
    end: startAt + (total - positionSec) / speed,
  };
}

export interface StreamPlayer {
  pushChunk(bytes: ArrayBuffer): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** Seek to an absolute position in seconds (no-op unless isSeekable()). */
  seek(positionSec: number): void;
  /** Apply a new playback rate, updating the live source + anchor where applicable. */
  setSpeed(speed: number): void;
  /** True once a complete clip is retained and seeking is possible. */
  isSeekable(): boolean;
  /** Tell the streaming player the stream has fully arrived (enables seek). */
  markComplete(): void;
  /** Total clip seconds (grows during streaming; full once complete). */
  synthDuration(): number;
  /** ctx time the clip's position 0 maps to (null until playback has started). */
  playbackStartTime(): number | null;
  /** ctx time the clip ends — basis for progress/completion. */
  playbackEndTime(): number;
}

/** Plays one complete AudioBuffer with native offset seek. Used by the
 *  play_tts fallback and as the streaming player's delegate after a seek. */
export function createBufferPlayer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  getSpeed: () => number
): StreamPlayer {
  let src: AudioBufferSourceNode | null = null;
  let anchorStart = 0;
  let anchorEnd = 0;
  const total = buffer.duration;

  function currentPos(): number {
    const span = anchorEnd - anchorStart;
    if (span <= 0) return 0;
    const f = Math.min(1, Math.max(0, (ctx.currentTime - anchorStart) / span));
    return f * total;
  }

  function startFrom(positionSec: number): void {
    const pos = Math.min(total, Math.max(0, positionSec));
    if (src) { try { src.stop(); } catch { /* noop */ } src.disconnect(); }
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    const speed = getSpeed();
    s.playbackRate.value = speed;
    s.connect(ctx.destination);
    const startAt = ctx.currentTime + LOOKAHEAD;
    s.start(startAt, pos);
    src = s;
    const a = computeSeekAnchor(startAt, pos, speed, total);
    anchorStart = a.start; anchorEnd = a.end;
  }

  return {
    pushChunk() { /* complete buffer: nothing to stream */ },
    pause() { ctx.suspend(); },
    resume() { ctx.resume(); },
    stop() { if (src) { try { src.stop(); } catch { /* noop */ } src.disconnect(); src = null; } },
    seek(positionSec) { startFrom(positionSec); },
    setSpeed(speed) {
      if (!src) return;
      const pos = currentPos();
      src.playbackRate.value = speed;
      const a = computeSeekAnchor(ctx.currentTime, pos, speed, total);
      anchorStart = a.start; anchorEnd = a.end;
    },
    isSeekable: () => true,
    markComplete() { /* already complete */ },
    synthDuration: () => total,
    playbackStartTime: () => (src ? anchorStart : null),
    playbackEndTime: () => anchorEnd,
  };
}

export function createStreamPlayer(ctx: AudioContext, getSpeed: () => number): StreamPlayer {
  let remainder: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let nextStartTime = 0;          // ctx time the next chunk will start
  let firstStartAt: number | null = null; // ctx time the first chunk starts
  const sources: AudioBufferSourceNode[] = [];

  // Retained audio for seek.
  const allSamples: Float32Array[] = [];
  let totalSamples = 0;
  let complete = false;

  // Single-source delegate, created lazily on first seek.
  let delegate: StreamPlayer | null = null;

  function totalDuration(): number { return totalSamples / SAMPLE_RATE; }

  function buildFullBuffer(): AudioBuffer {
    const buf = ctx.createBuffer(1, totalSamples, SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    let off = 0;
    for (const s of allSamples) { ch.set(s, off); off += s.length; }
    return buf;
  }

  function stopStreamingSources(): void {
    for (const s of sources) { try { s.stop(); } catch { /* noop */ } s.disconnect(); }
    sources.length = 0;
  }

  function pushChunk(bytes: ArrayBuffer): void {
    if (delegate) return; // already in single-source mode
    const out = int16ChunkToFloat32(remainder, new Uint8Array(bytes));
    remainder = out.remainder as Uint8Array<ArrayBuffer>;
    if (out.samples.length === 0) return;

    allSamples.push(out.samples);
    totalSamples += out.samples.length;

    const buffer = ctx.createBuffer(1, out.samples.length, SAMPLE_RATE);
    buffer.copyToChannel(out.samples as Float32Array<ArrayBuffer>, 0);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const speed = getSpeed();
    src.playbackRate.value = speed;
    src.connect(ctx.destination);

    if (firstStartAt === null) nextStartTime = ctx.currentTime + LOOKAHEAD;
    const startAt = Math.max(nextStartTime, ctx.currentTime + LOOKAHEAD);
    if (firstStartAt === null) firstStartAt = startAt;
    src.start(startAt);
    nextStartTime = startAt + buffer.duration / speed;
    sources.push(src);
  }

  function seek(positionSec: number): void {
    if (!complete || totalSamples === 0) return;
    if (!delegate) {
      stopStreamingSources();
      delegate = createBufferPlayer(ctx, buildFullBuffer(), getSpeed);
    }
    delegate.seek(positionSec);
  }

  function setSpeed(speed: number): void {
    // Delegate (post-seek) updates its live source + anchor. In chunk-streaming
    // mode getSpeed() already feeds the new rate to upcoming chunks; already
    // scheduled chunks keep their rate (documented contract).
    delegate?.setSpeed(speed);
  }

  function stop(): void {
    stopStreamingSources();
    delegate?.stop();
    delegate = null;
    remainder = new Uint8Array(0);
    firstStartAt = null;
    nextStartTime = 0;
    allSamples.length = 0;
    totalSamples = 0;
    complete = false;
  }

  return {
    pushChunk,
    pause() { ctx.suspend(); },
    resume() { ctx.resume(); },
    stop,
    seek,
    setSpeed,
    isSeekable: () => complete && totalSamples > 0,
    markComplete() { complete = true; },
    synthDuration: () => totalDuration(),
    playbackStartTime: () => (delegate ? delegate.playbackStartTime() : firstStartAt),
    playbackEndTime: () => (delegate ? delegate.playbackEndTime() : nextStartTime),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/streamPlayer.test.ts`
Expected: PASS — all `int16ChunkToFloat32` tests (3) and all `computeSeekAnchor` tests (3).

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc -b && npx eslint src/lib/streamPlayer.ts`
Expected: clean. (If TS5.7 typed-array generics complain on `buildFullBuffer`'s `ch.set(s, off)`, that is fine — `s` is `Float32Array`; no cast needed. The two existing `as` casts in `pushChunk` are retained.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/streamPlayer.ts src/lib/streamPlayer.test.ts
git commit -m "feat(tts): retain PCM + seekable buffer player (computeSeekAnchor, createBufferPlayer)"
```

---

## Task 2: store — `ttsStop` slice

**Files:**
- Modify: `src/store/useAppStore.ts`
- Test: `src/store/__tests__/useAppStore.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the existing top-level `describe(...)` in `src/store/__tests__/useAppStore.test.ts`:

```ts
  it("stores and clears the ttsStop callback", () => {
    const fn = () => {};
    useAppStore.getState().setTtsStop(fn);
    expect(useAppStore.getState().ttsStop).toBe(fn);
    useAppStore.getState().setTtsStop(null);
    expect(useAppStore.getState().ttsStop).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/store/__tests__/useAppStore.test.ts`
Expected: FAIL — `setTtsStop is not a function`.

- [ ] **Step 3: Add the slice to `src/store/useAppStore.ts`**

In the `AppStore` interface, add the field under the `// TTS` group (after `ttsSpeed: number;`):

```ts
  // Stop-TTS-playback callback registered by PlaybackControls; called by
  // RecordingPanel before start_recording so the mic records only the user.
  ttsStop: (() => void) | null;
```

In the `AppStore` interface actions, add (after `setTtsSpeed(speed: number): void;`):

```ts
  setTtsStop(fn: (() => void) | null): void;
```

In `INITIAL_STATE`, add (after `ttsSpeed: 1.0,`):

```ts
  ttsStop: null as (() => void) | null,
```

In the `create<AppStore>()` body, add (after the `setTtsSpeed` line):

```ts
  setTtsStop: (ttsStop) => set({ ttsStop }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/store/__tests__/useAppStore.test.ts`
Expected: PASS, including the new test.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/store/useAppStore.ts src/store/__tests__/useAppStore.test.ts
git commit -m "feat(store): ttsStop callback slice for stop-on-record"
```

---

## Task 3: `PlaybackControls.tsx` — seek UI + setSpeed + stop-on-record wiring

**Files:**
- Rewrite: `src/components/PlaybackControls.tsx`
- Test: `src/components/__tests__/PlaybackControls.test.tsx`

- [ ] **Step 1: Add the failing tests**

Replace `src/components/__tests__/PlaybackControls.test.tsx` with (keeps both existing tests, adds two):

```tsx
import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store/useAppStore";
import PlaybackControls from "../PlaybackControls";

describe("PlaybackControls", () => {
  beforeEach(() => {
    useAppStore.setState({
      inputText: "", ttsState: "idle", ttsSpeed: 1.0,
      recordingState: "idle", ttsStop: null,
    });
    vi.mocked(invoke).mockClear();
  });

  it("renders play button and speed selector", () => {
    useAppStore.setState({ inputText: "hi" });
    render(<PlaybackControls />);
    expect(screen.getByRole("button", { name: /play/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("disables play button when inputText is empty", () => {
    render(<PlaybackControls />);
    expect(screen.getByRole("button", { name: /play/i })).toBeDisabled();
  });

  it("registers a ttsStop callback on mount", () => {
    useAppStore.setState({ inputText: "hi" });
    render(<PlaybackControls />);
    expect(typeof useAppStore.getState().ttsStop).toBe("function");
  });

  it("stops playback when recording starts (defensive effect)", async () => {
    useAppStore.setState({ inputText: "hi", ttsState: "playing" });
    render(<PlaybackControls />);
    act(() => { useAppStore.setState({ recordingState: "recording" }); });
    await waitFor(() => expect(useAppStore.getState().ttsState).toBe("idle"));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("stop_tts_stream");
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run src/components/__tests__/PlaybackControls.test.tsx`
Expected: the two new tests FAIL (no `ttsStop` registration / no defensive stop yet); the two render tests still pass.

- [ ] **Step 3: Rewrite `src/components/PlaybackControls.tsx`**

Replace the entire file with:

```tsx
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
        stopProgress();
        setTtsState("idle");
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

  // Register the stop-before-record callback (Feature 2, primary path).
  useEffect(() => {
    setTtsStop(stopPlayback);
    return () => setTtsStop(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- register once; closes over stable refs/setters
  }, []);

  // Defensive: also stop if recording is started via any other path.
  useEffect(() => {
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
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          className="relative flex-1 h-4 flex items-center"
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/__tests__/PlaybackControls.test.tsx`
Expected: PASS — all four tests (2 render + registration + defensive-stop).

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc -b && npx eslint src/components/PlaybackControls.tsx`
Expected: clean (the three `eslint-disable` comments cover the ref-mirror and the two intentional empty-dep effects).

- [ ] **Step 6: Commit**

```bash
git add src/components/PlaybackControls.tsx src/components/__tests__/PlaybackControls.test.tsx
git commit -m "feat(tts): draggable seek handle + setSpeed + stop-on-record wiring"
```

---

## Task 4: `RecordingPanel.tsx` — stop TTS before recording

**Files:**
- Modify: `src/components/RecordingPanel.tsx`
- Test: `src/components/__tests__/RecordingPanel.test.tsx`

- [ ] **Step 1: Add the failing ordering test**

Append a new `describe` block to `src/components/__tests__/RecordingPanel.test.tsx` (keep the existing block; add the imports it needs at the top — `fireEvent`, `waitFor`, `vi`, and `invoke`):

At the top, ensure the imports include:

```ts
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store/useAppStore";
import RecordingPanel from "../RecordingPanel";
```

Then append:

```ts
describe("RecordingPanel — stops TTS before recording", () => {
  beforeEach(() => {
    useAppStore.setState({ recordingState: "idle", inputText: "hello", ttsStop: null });
    vi.mocked(invoke).mockClear();
  });
  afterEach(() => { vi.mocked(invoke).mockReset(); });

  it("calls ttsStop before invoking start_recording", async () => {
    const calls: string[] = [];
    const ttsStop = vi.fn(() => { calls.push("ttsStop"); });
    useAppStore.setState({ ttsStop });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(`invoke:${cmd}`);
      return undefined;
    });

    render(<RecordingPanel />);
    fireEvent.click(screen.getByRole("button", { name: /record/i }));

    await waitFor(() => expect(calls).toContain("invoke:start_recording"));
    expect(ttsStop).toHaveBeenCalled();
    expect(calls[0]).toBe("ttsStop"); // stop runs first, before the mic opens
    expect(calls.indexOf("ttsStop")).toBeLessThan(calls.indexOf("invoke:start_recording"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/__tests__/RecordingPanel.test.tsx`
Expected: FAIL — `ttsStop` is never called (or `calls[0]` is the invoke, not the stop).

- [ ] **Step 3: Edit `handleRecord` in `src/components/RecordingPanel.tsx`**

Change the `handleRecord` function (currently lines ~24-32) to call the registered stop first:

```tsx
  async function handleRecord() {
    // Stop TTS BEFORE the mic opens so the recording captures only the user's
    // voice (start_recording opens the cpal stream before emitting its event,
    // so a reactive stop would be too late). The audible stop is synchronous.
    useAppStore.getState().ttsStop?.();
    clearFeedback();
    setTimer(0);
    try {
      await invoke("start_recording");
    } catch (e) {
      addToast(String(e), "error");
    }
  }
```

(No other changes to the file. `useAppStore` is already imported.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/__tests__/RecordingPanel.test.tsx`
Expected: PASS — the existing four tests and the new ordering test.

- [ ] **Step 5: Full suite + typecheck + lint**

Run: `npx vitest run && npx tsc -b && npx eslint .`
Expected: all clean. (Total frontend tests = previous count + `computeSeekAnchor` ×3 + store ×1 + PlaybackControls ×2 + RecordingPanel ×1.)

- [ ] **Step 6: Commit**

```bash
git add src/components/RecordingPanel.tsx src/components/__tests__/RecordingPanel.test.tsx
git commit -m "feat(recording): stop TTS before start_recording (no mic bleed)"
```

---

## Manual verification (live, on the Mac)

Run the sidecars + `npx tauri dev` (LLM env vars as before), then:

- [ ] **Seek — after buffered.** Paste a paragraph → Listen. During the first ~2-3s the thumb is hidden/inert; once fully buffered the white thumb appears. Drag it back to replay a phrase; playback continues from the new spot. Drag forward; it jumps. Click directly on the track; it seeks there.
- [ ] **Seek — while paused.** Pause mid-clip, drag the thumb; it repositions and stays paused; press Play; it resumes from the dragged position.
- [ ] **Seek — after finish.** Let the clip finish (button returns to Play), then drag back; it replays from there.
- [ ] **Speed after seek.** Seek, then change speed mid-playback; audio rate changes and the progress bar stays continuous (no jump/drift). Repeat on the fallback path.
- [ ] **Stop-on-record.** Start Listen, then click Record while audio is playing → playback stops instantly (button returns to Play, progress resets) and the resulting recording contains only your voice (no TTS bleed at the start).
- [ ] **Fallback seek.** Stop the TTS sidecar so Listen falls back to `play_tts`; confirm the thumb still works (seek/drag) on the fallback clip.

---

## Self-review notes

- **Spec coverage:** retain samples + `seek` + virtual anchor (Task 1: `createStreamPlayer` retains `allSamples`, `seek` delegates to `createBufferPlayer`, `computeSeekAnchor`); `setSpeed` with live-source update + anchor recompute (Task 1 `createBufferPlayer.setSpeed`, wired in Task 3 `handleSpeedChange`); `isSeekable` gating (Task 1 + Task 3 `seekable` state/thumb); fallback uses the same seek-capable interface (Task 3 `playFallback` → `createBufferPlayer`); pre-record stop via store callback + defensive effect (Task 2 slice, Task 3 register/effect, Task 4 `handleRecord`); ordering test (Task 4); thumb UI + drag + click-seek + play/pause preserved (Task 3). All spec sections map to a task.
- **Type consistency:** `StreamPlayer` interface (Task 1) is implemented identically by `createStreamPlayer` and `createBufferPlayer`, and consumed in `PlaybackControls` (Task 3) — methods `seek/setSpeed/isSeekable/markComplete/pushChunk/pause/resume/stop/synthDuration/playbackStartTime/playbackEndTime` match across all three. Store `ttsStop: (() => void) | null` + `setTtsStop` (Task 2) match the `getState().ttsStop?.()` call (Task 4) and `setTtsStop(stopPlayback)` registration (Task 3).
- **Removed:** `fbSourceRef` and the bespoke fallback player object (replaced by `createBufferPlayer`); `handleSpeedChange` no longer pokes a source ref directly. This also fixes the latent fallback speed-drift bug (review finding 2), since `playbackEndTime` is now the anchor, not a live division.
- **Out of scope (per spec):** seeking during initial stream-in; mic device picker / DSP; keyboard seek (the `role="slider"` exposes `aria-valuenow` for screen readers but arrow-key seeking is not implemented).
