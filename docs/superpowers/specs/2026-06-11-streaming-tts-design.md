# azReadAnalyzer — Streaming TTS

**Date:** 2026-06-11
**Status:** Approved
**Branch:** `260609-bugfix` (follows the settings/frost + manual-test fixes)
**Builds on:** the current TTS path — `tts_service/server.py` (`/tts`, full-WAV), `commands.rs::play_tts` (raw bytes via `ipc::Response`), and `PlaybackControls.tsx` (Web Audio single-buffer playback).

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

- `#[command] async fn play_tts_stream(text: String, on_chunk: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>) -> Result<(), String>`.
- reqwest `POST http://127.0.0.1:8123/tts_stream`, then `.bytes_stream()`; for each `Ok(bytes)` → `on_chunk.send(bytes_into_response_body)`. Return `Ok(())` when the stream ends (signals synthesis complete), `Err(...)` if the sidecar is unreachable or the stream errors.
- `Cargo.toml`: add `"stream"` to the reqwest features (`["json", "stream"]`).
- **Byte alignment:** a network chunk may split a 2-byte sample. Rust forwards bytes verbatim; the **frontend** carries a leftover odd byte across chunks (simplest single place to handle it).
- Registered in `lib.rs` `generate_handler!`. (No `AppState` needed.)

### 3. Frontend — streaming scheduler

- **`src/lib/streamPlayer.ts` (new):** a small, unit-testable module owning the Web Audio scheduling, so `PlaybackControls` stays readable.
  - `createStreamPlayer(ctx, getSpeed)` → `{ pushChunk(bytes), pause(), resume(), stop(), onProgress, synthDuration }`.
  - `pushChunk(bytes)`: append to a pending byte buffer; carry an odd trailing byte; for the whole int16 frames, build `AudioBuffer(1, n, 24000)` (int16 → float32 = `v / 32768`); `src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = getSpeed(); src.connect(ctx.destination); src.start(nextStartTime); nextStartTime += buf.duration / getSpeed()`. Track sources + accumulate `synthDuration`.
  - **Pause/resume** = `ctx.suspend()` / `ctx.resume()` — freezes the entire scheduled timeline (no offset math).
  - **Stop** = stop all sources, reset cursor.
- **`PlaybackControls.tsx`:** on Play, create a `Channel`, `invoke("play_tts_stream", { text, onChunk })`, feed `onmessage` chunks into the stream player. Keep one `AudioContext` for the component (created lazily). Progress bar = `ctx.currentTime`-elapsed over `synthDuration`-so-far (grows as audio arrives; exact once the stream completes). Speed select sets the rate applied to subsequently-scheduled chunks.
- **Fallback:** if `play_tts_stream` rejects before any chunk arrives (sidecar down / stream error), call the existing `play_tts` full-WAV path (single-buffer Web Audio playback already implemented). `play_tts` and `/tts` remain.

---

## Error handling

| Scenario | Handling |
|----------|----------|
| Sidecar unreachable (stream) | `play_tts_stream` → `Err` → fallback to `play_tts`; if that also fails → existing "TTS service not running" toast |
| Mid-stream failure | stop scheduling, toast; audio already played is left intact; reset to idle |
| Empty/whitespace text | Play disabled (unchanged) |
| User pauses then plays | `ctx.suspend()`/`resume()`; replay after natural end re-streams from the start |

## Testing

- **Sidecar:** a script (formalizing the feasibility probe) asserting `/tts_stream` yields chunks incrementally — first chunk arrives well before full-synth time.
- **Rust:** `play_tts_stream` returns `Err` when the sidecar is unreachable (mirrors the existing `llm::returns_err_when_llm_unreachable` test). Forwarding is covered by the live check.
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
- `src-tauri/src/commands.rs` — `play_tts_stream` command (reqwest `bytes_stream` → `Channel.send`).
- `src-tauri/src/lib.rs` — register `play_tts_stream`.
- `src/lib/streamPlayer.ts` (new) + `src/lib/streamPlayer.test.ts` (new) — Web Audio chunk scheduler + frame-assembly tests.
- `src/components/PlaybackControls.tsx` — Channel wiring, streaming play with `play_tts` fallback; keep pause/speed/progress.
