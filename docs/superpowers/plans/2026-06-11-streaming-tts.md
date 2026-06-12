# Streaming TTS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream TTS audio chunk-by-chunk (sidecar `/tts_stream` → Rust `ipc::Channel` → frontend Web Audio scheduler) so time-to-first-sound drops from ~1–3.5 s to ~0.2–0.3 s, with the existing non-streaming `play_tts` kept as fallback.

**Architecture:** A new sidecar endpoint streams raw int16 PCM as `mlx_audio` generates it. A Rust command forwards each byte chunk over a Tauri `Channel` (status-checked, generation-gated for cancellation). A frontend `streamPlayer` assembles int16 frames into `AudioBuffer`s and schedules them gaplessly; `PlaybackControls` wires the channel with a stale-session guard and falls back to `play_tts` on failure.

**Tech Stack:** FastAPI + mlx_audio (Python) · Tauri 2 / reqwest `bytes_stream` + `futures-util` · `tauri::ipc::Channel` · Web Audio API · Vitest / cargo test.

**Spec:** [docs/superpowers/specs/2026-06-11-streaming-tts-design.md](../specs/2026-06-11-streaming-tts-design.md) (review-incorporated).

---

## File structure

| File | Responsibility |
|------|----------------|
| `tts_service/server.py` (modify) | add `POST /tts_stream` — async generator over `model.generate(stream=True)`, int16 LE PCM |
| `tts_service/test_stream.py` (create) | contract test (status, media type, first-chunk latency, multi-chunk, even bytes) |
| `tts_service/requirements.txt` (modify) | add `requests` (used by the contract test) |
| `src-tauri/Cargo.toml` (modify) | reqwest `"stream"` feature + `futures-util` |
| `src-tauri/src/commands.rs` (modify) | `AppState.tts_gen`; `play_tts_stream`, `stop_tts_stream` |
| `src-tauri/src/lib.rs` (modify) | init `tts_gen`; register the two commands |
| `src/lib/streamPlayer.ts` (create) | `int16ChunkToFloat32` + `createStreamPlayer` (Web Audio scheduler) |
| `src/lib/streamPlayer.test.ts` (create) | unit tests for the PCM frame assembler |
| `src/__mocks__/@tauri-apps/api/index.ts` + `src/test-setup.ts` (modify) | export a `Channel` stub + resolve `play_tts_stream`/`stop_tts_stream` so tests import cleanly |
| `src/components/PlaybackControls.tsx` (modify) | Channel wiring, session guard, streaming play + `play_tts` fallback |

---

## Task 1: Sidecar `/tts_stream` endpoint

**Files:**
- Modify: `tts_service/server.py`
- Create: `tts_service/test_stream.py`

- [ ] **Step 1: Add the streaming endpoint** to `tts_service/server.py`

Add the imports near the top (after the existing imports):
```python
import numpy as np
from fastapi.responses import StreamingResponse
```
Add a constant near `INSTRUCT`:
```python
STREAMING_INTERVAL = 0.5  # seconds of audio per streamed chunk
```
Add the endpoint (after the existing `@app.post("/tts")` function):
```python
@app.post("/tts_stream")
async def tts_stream(req: Req):
    # Stream int16 LE mono PCM at 24kHz as mlx_audio generates it. The model
    # generator is synchronous and MUST run on this (event-loop / Metal) thread,
    # so we iterate it inline; each yield flushes a chunk to the client.
    def pcm_chunks():
        for r in model.generate(
            text=req.text,
            instruct=INSTRUCT,
            stream=True,
            streaming_interval=STREAMING_INTERVAL,
            verbose=False,
        ):
            audio = np.array(r.audio, dtype=np.float32)
            pcm = np.clip(audio, -1.0, 1.0)
            pcm = (pcm * 32767.0).astype("<i2").tobytes()
            yield pcm

    async def agen():
        for chunk in pcm_chunks():
            yield chunk

    return StreamingResponse(agen(), media_type="audio/L16; rate=24000; channels=1")
```

- [ ] **Step 2: Create the contract test** `tts_service/test_stream.py`

```python
"""Contract test for /tts_stream. Requires the sidecar running on :8123:
    /opt/homebrew/bin/uvicorn server:app --port 8123
Run:  /opt/homebrew/bin/python3.12 test_stream.py
"""
import time
import requests

TEXT = ("The ability to communicate clearly in English is one of the most "
        "valuable skills you can develop. Keep practicing every day.")


def main():
    t0 = time.time()
    r = requests.post("http://127.0.0.1:8123/tts_stream", json={"text": TEXT}, stream=True)
    assert r.status_code == 200, f"status {r.status_code}"
    ctype = r.headers.get("content-type", "")
    assert "L16" in ctype or "octet" in ctype, f"unexpected content-type {ctype!r}"

    first = None
    chunks = 0
    total = 0
    for chunk in r.iter_content(chunk_size=8192):
        if not chunk:
            continue
        if first is None:
            first = time.time() - t0
        chunks += 1
        total += len(chunk)

    assert first is not None and first < 1.0, f"first chunk too slow: {first}"
    assert chunks >= 2, f"expected multiple chunks, got {chunks}"
    assert total > 0, "no audio"
    assert total % 2 == 0, f"odd byte count {total} (not int16-framed)"
    print(f"OK: first chunk {first:.2f}s, {chunks} chunks, {total} bytes ({total/2/24000:.1f}s audio)")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2b: Add the test dependency (review #5)** — append `requests` to `tts_service/requirements.txt` so a fresh sidecar venv can run the contract test:

```
mlx_audio
fastapi
uvicorn
requests
```

- [ ] **Step 3: Run the contract test** (start the sidecar first if needed)

```bash
cd tts_service
/opt/homebrew/bin/python3.12 -c "import server"   # syntax/import check
# In one terminal: /opt/homebrew/bin/uvicorn server:app --port 8123
/opt/homebrew/bin/python3.12 test_stream.py
```
Expected: `OK: first chunk 0.1xs, N chunks, M bytes ...` (first chunk well under 1 s).

- [ ] **Step 4: Commit**

```bash
git add tts_service/server.py tts_service/test_stream.py tts_service/requirements.txt
git commit -m "feat(tts): /tts_stream endpoint streaming int16 PCM"
```

---

## Task 2: Rust `play_tts_stream` + `stop_tts_stream`

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add deps** in `src-tauri/Cargo.toml`

Change the reqwest line and add futures-util in `[dependencies]`:
```toml
reqwest = { version = "0.12", features = ["json", "stream"] }
futures-util = "0.3"
```

- [ ] **Step 2: Add `tts_gen` to `AppState`** in `src-tauri/src/commands.rs`

At the top, extend the imports:
```rust
use std::sync::atomic::{AtomicU64, Ordering};
```
Add the field to the `AppState` struct (after `settings`):
```rust
    // Generation counter for streaming TTS. Bumped on each new stream and on
    // stop; an in-flight play_tts_stream loop exits when it's superseded.
    pub tts_gen: AtomicU64,
```

- [ ] **Step 3: Add the two commands** in `src-tauri/src/commands.rs`

Add `use futures_util::StreamExt;` to the top imports. Then add the commands (e.g. after `play_tts`):
```rust
/// Map a sidecar HTTP status + body to a result (review #1/#4 — never forward an
/// error body as PCM). Extracted so the non-2xx branch is unit-testable.
fn ensure_success(status: reqwest::StatusCode, body: &str) -> Result<(), String> {
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("TTS stream error: {body}"))
    }
}

/// Streams TTS audio chunks (int16 PCM) from the sidecar to the frontend via a
/// Tauri Channel. Status-checked (never forwards an error body as audio) and
/// generation-gated (a newer stream or stop_tts_stream supersedes this one,
/// which drops the response and disconnects the sidecar).
#[command]
pub async fn play_tts_stream(
    text: String,
    on_chunk: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let my_gen = state.tts_gen.fetch_add(1, Ordering::SeqCst) + 1;

    let client = reqwest::Client::new();
    let resp = client
        .post("http://127.0.0.1:8123/tts_stream")
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await
        .map_err(|_| "TTS service not running — start tts_service/".to_string())?;

    if let Err(e) = ensure_success(resp.status(), "") {
        // read a short body for context, then fail — do NOT enter bytes_stream().
        let detail = resp.text().await.unwrap_or_default();
        return Err(if detail.is_empty() { e } else { format!("TTS stream error: {detail}") });
    }

    let mut stream = resp.bytes_stream();
    while let Some(item) = stream.next().await {
        // Superseded → stop. Dropping `stream`/`resp` disconnects the sidecar.
        if state.tts_gen.load(Ordering::SeqCst) != my_gen {
            return Ok(());
        }
        let bytes = item.map_err(|e| e.to_string())?;
        on_chunk
            .send(tauri::ipc::InvokeResponseBody::Raw(bytes.to_vec()))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Cancels any in-flight streaming TTS (used by Stop / replace / unmount).
#[command]
pub fn stop_tts_stream(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.tts_gen.fetch_add(1, Ordering::SeqCst);
    Ok(())
}
```

- [ ] **Step 4: Init + register in `src-tauri/src/lib.rs`**

In the `.manage(Arc::new(AppState { ... }))` block, add:
```rust
            tts_gen: std::sync::atomic::AtomicU64::new(0),
```
In `generate_handler!`, add:
```rust
            commands::play_tts_stream,
            commands::stop_tts_stream,
```

- [ ] **Step 5: Add a Rust test (review #4)** — append this `#[cfg(test)]` module at the end of `src-tauri/src/commands.rs`. It **deterministically** covers the core contract — non-2xx → `Err` (the "never forward an error body as PCM" guarantee). (The unreachable→`Err` path is the same `reqwest::send()` behavior already proven by `llm::returns_err_when_llm_unreachable` and the live fallback check; we avoid a duplicate dead-port network test, which would be non-deterministic if that port were ever bound — the reviewer's `TcpListener`-to-0 alternative has its own bind/connect race, so a pure unit test is the better call.)
```rust
#[cfg(test)]
mod stream_tests {
    use super::ensure_success;

    #[test]
    fn non_2xx_is_err() {
        assert!(ensure_success(reqwest::StatusCode::INTERNAL_SERVER_ERROR, "boom").is_err());
        assert!(ensure_success(reqwest::StatusCode::NOT_FOUND, "").is_err());
        assert!(ensure_success(reqwest::StatusCode::OK, "").is_ok());
    }
}
```

- [ ] **Step 6: Verify**

```bash
cd src-tauri && cargo test --lib
```
Expected: compiles; all existing tests pass + `commands_exist`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(tts): play_tts_stream/stop_tts_stream Rust commands (Channel, status-checked, gen-gated)"
```

---

## Task 3: `streamPlayer.ts` (PCM frame assembler + Web Audio scheduler)

**Files:**
- Create: `src/lib/streamPlayer.ts`
- Test: `src/lib/streamPlayer.test.ts`

- [ ] **Step 1: Write the failing test** `src/lib/streamPlayer.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { int16ChunkToFloat32 } from "./streamPlayer";

// helper: build a Uint8Array of int16 LE samples
function pcm(...vals: number[]): Uint8Array {
  const u = new Uint8Array(vals.length * 2);
  const dv = new DataView(u.buffer);
  vals.forEach((v, i) => dv.setInt16(i * 2, v, true));
  return u;
}

describe("int16ChunkToFloat32", () => {
  it("converts whole frames, no remainder", () => {
    const { samples, remainder } = int16ChunkToFloat32(new Uint8Array(0), pcm(0, 32767, -32768));
    expect(remainder.length).toBe(0);
    expect(samples.length).toBe(3);
    expect(samples[0]).toBeCloseTo(0, 5);
    expect(samples[1]).toBeCloseTo(0.99997, 4);
    expect(samples[2]).toBeCloseTo(-1, 5);
  });

  it("carries an odd trailing byte to the remainder", () => {
    const bytes = pcm(100, 200);          // 4 bytes
    const odd = new Uint8Array([...bytes, 0x7f]); // +1 stray byte
    const { samples, remainder } = int16ChunkToFloat32(new Uint8Array(0), odd);
    expect(samples.length).toBe(2);
    expect(remainder.length).toBe(1);
    expect(remainder[0]).toBe(0x7f);
  });

  it("combines a carried remainder with the next chunk", () => {
    // first chunk ends mid-sample (1 leftover byte: low byte of int16 = 0x10)
    const first = int16ChunkToFloat32(new Uint8Array(0), new Uint8Array([0x10]));
    expect(first.samples.length).toBe(0);
    expect(first.remainder.length).toBe(1);
    // next chunk supplies the high byte 0x27 -> int16 LE 0x2710 = 10000
    const second = int16ChunkToFloat32(first.remainder, new Uint8Array([0x27]));
    expect(second.samples.length).toBe(1);
    expect(second.samples[0]).toBeCloseTo(10000 / 32768, 5);
    expect(second.remainder.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run src/lib/streamPlayer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/lib/streamPlayer.ts`

```ts
// Streaming TTS playback: assemble int16 LE PCM byte chunks into AudioBuffers
// and schedule them gaplessly on a Web Audio context.

const SAMPLE_RATE = 24000;
const LOOKAHEAD = 0.1; // seconds — never schedule a chunk in the past

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

export interface StreamPlayer {
  pushChunk(bytes: ArrayBuffer): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** total audio seconds scheduled so far (duration label) */
  synthDuration(): number;
  /** ctx time the first chunk starts (null until the first chunk), and the ctx
   *  time the scheduled audio ends — the basis for progress/completion. */
  playbackStartTime(): number | null;
  playbackEndTime(): number;
}

export function createStreamPlayer(ctx: AudioContext, getSpeed: () => number): StreamPlayer {
  let remainder = new Uint8Array(0);
  let nextStartTime = 0;          // ctx time the next chunk will start
  let firstStartAt: number | null = null; // ctx time the first chunk starts
  let scheduled = 0;              // total audio seconds scheduled
  const sources: AudioBufferSourceNode[] = [];

  function pushChunk(bytes: ArrayBuffer): void {
    const out = int16ChunkToFloat32(remainder, new Uint8Array(bytes));
    remainder = out.remainder;
    if (out.samples.length === 0) return;

    const buffer = ctx.createBuffer(1, out.samples.length, SAMPLE_RATE);
    buffer.copyToChannel(out.samples, 0);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const speed = getSpeed();
    src.playbackRate.value = speed;
    src.connect(ctx.destination);

    if (firstStartAt === null) nextStartTime = ctx.currentTime + LOOKAHEAD;
    // Underrun clamp: a stall must not schedule into the past.
    const startAt = Math.max(nextStartTime, ctx.currentTime + LOOKAHEAD);
    if (firstStartAt === null) firstStartAt = startAt;
    src.start(startAt);
    nextStartTime = startAt + buffer.duration / speed; // advance by actual played duration
    scheduled += buffer.duration;
    sources.push(src);
  }

  function pause(): void { ctx.suspend(); }
  function resume(): void { ctx.resume(); }

  function stop(): void {
    for (const s of sources) {
      try { s.stop(); } catch { /* already stopped */ }
      s.disconnect();
    }
    sources.length = 0;
    remainder = new Uint8Array(0);
    firstStartAt = null;
    nextStartTime = 0;
    scheduled = 0;
  }

  return {
    pushChunk,
    pause,
    resume,
    stop,
    synthDuration: () => scheduled,
    playbackStartTime: () => firstStartAt,
    playbackEndTime: () => nextStartTime,
  };
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run src/lib/streamPlayer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/streamPlayer.ts src/lib/streamPlayer.test.ts
git commit -m "feat(tts): streamPlayer — int16 frame assembler + Web Audio scheduler"
```

---

## Task 4: `PlaybackControls` streaming integration + fallback

**Files:**
- Modify: `src/__mocks__/@tauri-apps/api/index.ts`, `src/test-setup.ts`
- Modify: `src/components/PlaybackControls.tsx`

This replaces the playback logic. Streaming is primary; the existing single-buffer Web Audio path becomes the fallback. A `playbackSessionId` ref guards against stale channel messages.

- [ ] **Step 1: Update the Vitest mock (review #2)** — `PlaybackControls` now imports `Channel` from `@tauri-apps/api/core`, which the shared mock doesn't export. In `src/__mocks__/@tauri-apps/api/index.ts`, add a minimal `Channel` and handle the new commands in `invoke`:

```ts
export class Channel<T = unknown> {
  onmessage: (msg: T) => void = () => {};
  // Tauri serializes a Channel to an IPC id string; a stub is enough for tests.
  toJSON() { return "__CHANNEL__"; }
}
```
and inside the existing `invoke` mock body, before the final `return undefined;`, add:
```ts
  if (cmd === "play_tts_stream") return undefined; // resolves; no chunks in tests
  if (cmd === "stop_tts_stream") return undefined;
```
Then in `src/test-setup.ts`, export `Channel` from the core mock:
```ts
vi.mock("@tauri-apps/api/core", async () => {
  const m = await import("./__mocks__/@tauri-apps/api/index");
  return { invoke: m.invoke, Channel: m.Channel };
});
```

- [ ] **Step 2: Replace `src/components/PlaybackControls.tsx`** with:

```tsx
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
```

- [ ] **Step 3: Verify build + existing tests**

```bash
npx tsc -b && npx eslint . && npx vitest run
```
Expected: clean; the existing `PlaybackControls.test.tsx` (renders Play + speed; disabled when empty) still passes (the mock now exports `Channel`; no command is invoked on render). `streamPlayer` tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/__mocks__/@tauri-apps/api/index.ts src/test-setup.ts src/components/PlaybackControls.tsx
git commit -m "feat(tts): streaming playback with session guard + play_tts fallback"
```

---

## Final verification (live, full stack)

- [ ] Start TTS (`/opt/homebrew/bin/uvicorn server:app --port 8123` from `tts_service/`), the app (`npx tauri dev`).
- [ ] Paste a paragraph → Listen → **first sound in ~0.2–0.3 s** (vs ~3.5 s before); playback is gapless to the end.
- [ ] Pause/resume works (progress freezes/continues correctly); progress bar reflects played position under pause and at non-1× speed; on completion the button returns to Play.
- [ ] Speed: set **before Play** → immediate. A mid-play change applies only to not-yet-scheduled audio and may lag by the buffered lead (documented v1 behavior; bounded-horizon scheduler deferred).
- [ ] Stop mid-stream then immediately replay → replay starts promptly (backend cancelled; sidecar freed).
- [ ] Stop the TTS sidecar → Listen → falls back to `play_tts` (if also down, the "TTS service not running" toast).

---

## Self-review notes

- **Spec coverage:** sidecar `/tts_stream` (Task 1); reqwest `stream`+`futures-util`, `play_tts_stream` status-check + gen-cancel, `stop_tts_stream`, `AppState.tts_gen` (Task 2); `streamPlayer` frame assembler + clamp + pause/resume/stop (Task 3); Channel wiring + session guard + speed contract + fallback + progress (Task 4). Review findings #1 (status check), #2 (session guard + tts_gen + stop_tts_stream), #3 (speed contract — `speedRef`, applies to new chunks), #4 (LOOKAHEAD clamp in pushChunk), #5 (contract test) all present.
- **Types consistent:** `Channel<ArrayBuffer>` (JS) ↔ `Channel<InvokeResponseBody>` send `Raw(Vec<u8>)` → ArrayBuffer; `createStreamPlayer(ctx, getSpeed) -> StreamPlayer { pushChunk, pause, resume, stop, synthDuration }` used exactly in PlaybackControls; `play_tts_stream({ text, onChunk })` arg names match the Rust params (`text`, `on_chunk` → JS `onChunk`).
- **Note:** Tauri maps the Rust param `on_chunk` to JS key `onChunk` (camelCase). The invoke uses `{ text, onChunk }`.
- **Plan-review 1 (Codex 2026-06-11) findings applied:** #1 progress/completion via ctx-time bounds (`playbackStartTime`/`playbackEndTime`) — correct under pause/resume + speed; #2 Vitest mock exports `Channel` + resolves the new commands; #3 speed contract documented honestly (set-before-Play; mid-play lag; horizon deferred); #4 `ensure_success` helper + deterministic non-2xx test; #5 `requests` added to sidecar requirements.
- **Plan-review 2 (Codex 2026-06-11) findings applied:** #1 backend cancel removed from `teardown()` (a fresh `play_tts_stream` supersedes via `tts_gen`; `stop_tts_stream` only on unmount) — fixes the stop/start race; #2 `playbackTextRef` guard so resume only continues matching text, else fresh; #3 fallback exposed as a unified player object so resume uses the ctx-time progress path; #4 dropped the flaky dead-port network test in favor of the deterministic `ensure_success` test (the suggested `TcpListener`-0 fix has its own race).
