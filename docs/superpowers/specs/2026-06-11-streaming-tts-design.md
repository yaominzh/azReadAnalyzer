# azReadAnalyzer — Streaming TTS

**Date:** 2026-06-11
**Status:** Approved
**Branch:** `260609-bugfix` (follows the settings/frost + manual-test fixes)
**Builds on:** the current TTS path — `tts_service/server.py` (`/tts`, full-WAV), `commands.rs::play_tts` (raw bytes via `ipc::Response`), and `PlaybackControls.tsx` (Web Audio single-buffer playback).
**Review incorporated:** [2026-06-11-streaming-tts-design-review.md](../thirdpartyreview/2026-06-11-streaming-tts-design-review.md) (Codex) — findings 1–5 evaluated/verified and applied (non-2xx handling, stale-session guard + cancellation, speed contract, underrun clamp, stronger sidecar test).

---

## Overview

Today TTS is non-streaming: the sidecar synthesizes the **entire** passage into one WAV before returning a byte, so time-to-first-sound equals full synthesis time — measured ~1 s for a sentence and ~3.5 s for a paragraph. This makes "Read Aloud" feel laggy on longer text.

This adds **streaming TTS**: the sidecar emits audio chunks as they're generated, Rust forwards them to the frontend over a Tauri `Channel`, and the frontend schedules them back-to-back via the Web Audio API. **Time-to-first-sound drops to ~0.2–0.3 s, independent of passage length.**

### Feasibility (verified empirically)

- `mlx_audio` Qwen3 `model.generate(text, instruct, stream=True, streaming_interval=s)` is a generator yielding incremental 24 kHz float chunks (~`s` seconds of audio each), per segment.
- **Warm** (the server is always warm after its first request), the **first chunk arrives in ~0.1 s regardless of total length** (measured 0.12 s for a sentence and for a 10 s passage; 0.07 s at `streaming_interval=0.3`). The one-off ~2.8 s cold first-chunk seen initially was MLX Metal-kernel compilation on a fresh process, not a per-request cost.
- Synthesis runs ~2× realtime, so chunks keep arriving faster than they play (no underruns).
- Transport APIs confirmed present: `tauri::ipc::Channel<T>` (Rust `.send()`) ↔ JS `Channel` (`onmessage`), and reqwest `bytes_stream()` (requires the `stream` feature).

### Decisions (from brainstorming)

- **Transport:** through Rust via `tauri::ipc::Channel` (robust — no CORS / WebView mixed-content issues; keeps the existing "TTS via Rust" boundary).
- **Player fidelity:** play / pause-resume / live speed / progress-as-it-arrives. **No seek** (audio arrives progressively).
- **Fallback:** keep the non-streaming `/tts` + `play_tts`; fall back to it if streaming fails. (Also retains azVoiceAssist parity for `/tts`.)
- **Format/interval:** raw **int16 LE, mono, 24000 Hz**; `streaming_interval = 0.5` s.

---

## Data flow

```
WebView (PlaybackControls)        Rust                         tts_service :8123
  ch = new Channel<bytes>
  invoke("play_tts_stream",   →   #[command] play_tts_stream   POST /tts_stream {text}
     { text, onChunk: ch })        (text, on_chunk: Channel)  → model.generate(stream=True,
                                    reqwest .bytes_stream()       streaming_interval=0.5)
  ch.onmessage(pcm)  ←──────────   on_chunk.send(bytes) ←─────  yields int16 PCM chunks
  streamPlayer.schedule(pcm)       (loop until stream ends)
                                    return Ok  ─► "synthesis complete"
```

---

## Components

### 1. Sidecar — new `POST /tts_stream` (additive; `/tts` unchanged)

- Returns a `StreamingResponse` of **raw PCM** (int16 LE, mono, 24000 Hz). No per-chunk header; the format is fixed and known to the client.
- Body is an **async generator** that iterates the **synchronous** `model.generate(text=…, instruct=INSTRUCT, stream=True, streaming_interval=0.5)` and, per yielded `result`, converts `result.audio` (float samples in ~[-1, 1]) to int16 bytes (`clamp(-1,1) * 32767`) and `yield`s them.
- **Threading:** the generator runs on the uvicorn event-loop thread — the same thread the current `/tts` runs MLX on, satisfying the "MLX/Metal must stay on the thread that created the context" constraint. We therefore **cannot** offload generation to a worker thread; the ~0.1 s per-chunk compute briefly blocks the loop, which is acceptable for this single-user local tool.
- `INSTRUCT` is shared with `/tts` (same voice).

### 2. Rust — `play_tts_stream` command

- `#[command] async fn play_tts_stream(text: String, on_chunk: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>, state: State<'_, Arc<AppState>>) -> Result<(), String>`.
- reqwest `POST http://127.0.0.1:8123/tts_stream`.
- **(review #1) Check status before streaming:** after `.send().await`, verify `resp.status().is_success()`. On a non-2xx, read a short error body and return `Err(...)` — do **not** enter `bytes_stream()`. Otherwise a 4xx/5xx JSON/text error body would be forwarded as "PCM" and the frontend would schedule garbage instead of taking the fallback. (The existing `call_tts_sidecar` omits this check — the streaming path must not copy that.)
- Then `.bytes_stream()`; for each `Ok(bytes)` → `on_chunk.send(...)`. Return `Ok(())` when the stream ends (synthesis complete), `Err(...)` on unreachable / non-2xx / stream error.
- **(review #2) Cancellation:** `AppState` gains `tts_gen: AtomicU64`. On entry, `let my_gen = state.tts_gen.fetch_add(1, SeqCst) + 1;` (supersedes any prior stream). The forward loop breaks as soon as `state.tts_gen.load(SeqCst) != my_gen`. Breaking drops the reqwest response → the sidecar sees the client disconnect and stops generating on its next chunk boundary (freeing it for the next request). A companion `#[command] stop_tts_stream(state)` bumps `tts_gen` so a plain Stop (no replay) also cancels.
- `Cargo.toml`: add `"stream"` to reqwest features (`["json", "stream"]`).
- **Byte alignment:** a network chunk may split a 2-byte sample. Rust forwards bytes verbatim; the **frontend** carries a leftover odd byte across chunks (single place to handle it).
- Register `play_tts_stream` + `stop_tts_stream` in `lib.rs` `generate_handler!`; add `tts_gen: AtomicU64::new(0)` to the `AppState` init.

### 3. Frontend — streaming scheduler

- **`src/lib/streamPlayer.ts` (new):** a small, unit-testable module owning the Web Audio scheduling, so `PlaybackControls` stays readable.
  - `createStreamPlayer(ctx, getSpeed)` → `{ pushChunk(bytes), pause(), resume(), stop(), synthDuration(), playbackStartTime(), playbackEndTime() }` (the last two are ctx-time bounds used for progress/completion — review #1).
  - `pushChunk(bytes)`: append to a pending byte buffer; carry an odd trailing byte; for the whole int16 frames, build `AudioBuffer(1, n, 24000)` (int16 → float32 = `v / 32768`); `src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = getSpeed(); src.connect(ctx.destination)`. **(review #4 — underrun clamp)** before starting, clamp the cursor to the present: `nextStartTime = Math.max(nextStartTime, ctx.currentTime + LOOKAHEAD)` (`LOOKAHEAD = 0.1 s`) so a runtime stall (GC, main-thread work, sidecar hiccup) never schedules a chunk in the past (which Web Audio would start immediately, causing an audible underrun + progress desync). Then `src.start(nextStartTime); nextStartTime += buf.duration / getSpeed()`. Track sources + accumulate `synthDuration`. (A small underrun counter may be logged for live checks.)
  - **(review #3 — speed contract, honest):** a speed change applies to chunks scheduled **after** it; already-scheduled chunks keep their rate. The timeline stays **gapless** because `nextStartTime` advances by each chunk's *actual played duration* (`buf.duration / rate-at-schedule`). **Caveat:** synthesis outruns playback (~2×), so on a longer passage most/all chunks may already be scheduled by the time the user changes speed — meaning a mid-playback change can lag by the **buffered lead** (up to the remaining clip), not just `LOOKAHEAD`. **v1 contract:** set speed **before Play** for an immediate effect; mid-play changes affect only not-yet-scheduled audio. A bounded-horizon scheduler for near-live mid-play speed is a **deferred enhancement** (per design-review option). The UI is unchanged; this is documented behavior.
  - **Pause/resume** = `ctx.suspend()` / `ctx.resume()` — freezes the entire scheduled timeline (no offset math).
  - **Stop** = stop all sources, reset cursor.
- **`PlaybackControls.tsx`:** on Play, create a `Channel`, `invoke("play_tts_stream", { text, onChunk })`, feed `onmessage` chunks into the stream player. Keep one `AudioContext` for the component (created lazily). **Progress/completion via the audio timeline (review #1):** the stream player exposes its scheduled span in **ctx-time** — `playbackStartTime()` (ctx time the first chunk starts) and `playbackEndTime()` (ctx time the scheduled audio ends, i.e. `nextStartTime`). Progress = `(ctx.currentTime − start) / (end − start)`; the duration label uses `synthDuration()` (audio seconds, grows as chunks arrive). This is **correct under pause/resume** (`ctx.currentTime` freezes during `suspend()`, no `startedAt` reset) and **under any speed** (`end` already accounts for per-chunk rate). **Completion** fires when the stream has fully arrived *and* `ctx.currentTime ≥ playbackEndTime()` — driven by the actual played-out position, not wall-clock-elapsed.
- **(review #2 — Vitest mock):** the shared `@tauri-apps/api/core` mock must export a minimal `Channel` (with `onmessage`) and resolve `play_tts_stream`/`stop_tts_stream`, since `PlaybackControls` now imports `Channel`. Without it the existing render tests can break at import.
- **(review #2 — stale-session guard):** `PlaybackControls` holds an incrementing `playbackSessionId` ref. Each Play starts a **new** session (bump id) + a fresh `Channel`. Every `onmessage` chunk handler, the invoke completion handler, and the error handler first checks `session === currentSessionId` and **no-ops** if stale — so chunks/results from a superseded stream never schedule audio, reset state, or toast. **Stop / replay / new-text / unmount** invalidate the session (bump id), tear down the stream player's sources, and `invoke("stop_tts_stream")` to cancel the backend (which frees the sidecar).
- **Fallback:** if `play_tts_stream` rejects before any chunk arrives (sidecar down / stream error), call the existing `play_tts` full-WAV path (single-buffer Web Audio playback already implemented). `play_tts` and `/tts` remain.

---

## Error handling

| Scenario | Handling |
|----------|----------|
| Sidecar unreachable (stream) | `play_tts_stream` → `Err` before any chunk → fallback to `play_tts`; if that also fails → existing "TTS service not running" toast |
| Sidecar returns non-2xx (review #1) | status checked before `bytes_stream()` → `Err` (short error body) → fallback. The error body is never forwarded as PCM. |
| Mid-stream failure (after chunks played) | stop scheduling, toast; audio already played is left intact; reset to idle; **no** fallback (would double-play) |
| Stop / replay / new-text / unmount mid-stream (review #2) | bump `playbackSessionId` + `stop_tts_stream`; stale chunks/results no-op; sidecar cancels |
| Empty/whitespace text | Play disabled (unchanged) |
| User pauses then plays | `ctx.suspend()`/`resume()`; replay after natural end re-streams from the start |

## Testing

- **Sidecar (review #5 — assert the wire contract):** a script that hits `/tts_stream` and asserts: **200** status; a documented raw-PCM media type (e.g. `application/octet-stream` or `audio/L16;rate=24000`); **first-chunk latency** « full-synth time; **multiple chunks** for a longer passage; **even** total byte count (int16 framing); and a **non-empty** total. This guards against the endpoint silently returning an error body or malformed PCM.
- **Rust:** `play_tts_stream` returns `Err` when the sidecar is unreachable, and (review #1) when it returns a non-2xx status (mirrors the existing `llm::returns_err_when_llm_unreachable` test). Chunk forwarding + cancellation are covered by the live check.
- **Frontend:** unit tests for `streamPlayer`'s PCM-frame assembler — odd-byte carry across chunks, int16→float32 conversion, and that `pushChunk` schedules a buffer per complete frame set. (AudioContext is mocked/guarded in jsdom; the chunk-math is the testable core.)
- **Existing:** the non-streaming `play_tts` tests and `PlaybackControls` render tests stay green.
- **Live (by ear):** first-sound latency ~0.2–0.3 s on a paragraph; gapless playback; pause/resume; speed; fallback when the sidecar is stopped.

## Out of scope

- Seeking/scrubbing (progressive arrival makes arbitrary seek impractical for v1).
- Per-request voice/speed params to the model (speed is applied client-side at playback as today).
- Replacing `/tts` — it stays as the fallback and for azVoiceAssist parity.
- A spinner/"synthesizing…" UI — unnecessary once first sound is ~0.2 s (can revisit if needed).

## File touch list

- `tts_service/server.py` — add `POST /tts_stream` (async generator over `model.generate(stream=True)`, int16 PCM).
- `src-tauri/Cargo.toml` — reqwest `"stream"` feature.
- `src-tauri/src/commands.rs` — `play_tts_stream` (status check → reqwest `bytes_stream` → `Channel.send`, generation-gated) + `stop_tts_stream`; `AppState.tts_gen: AtomicU64`.
- `src-tauri/src/lib.rs` — register `play_tts_stream` + `stop_tts_stream`; init `tts_gen`.
- `src/lib/streamPlayer.ts` (new) + `src/lib/streamPlayer.test.ts` (new) — Web Audio chunk scheduler + frame-assembly tests.
- `src/components/PlaybackControls.tsx` — Channel wiring, streaming play with `play_tts` fallback; keep pause/speed/progress.
