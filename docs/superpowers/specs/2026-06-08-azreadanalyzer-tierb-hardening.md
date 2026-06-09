# azReadAnalyzer — Tier-B Runtime-Robustness Hardening

**Date:** 2026-06-08
**Status:** Approved
**Type:** Hardening spec — amends the existing implementation plan
**Amends:** [docs/superpowers/plans/2026-06-07-azreadanalyzer-implementation.md](../plans/2026-06-07-azreadanalyzer-implementation.md)
**Spec of record:** [docs/superpowers/specs/2026-06-07-azreadanalyzer-design.md](2026-06-07-azreadanalyzer-design.md)

---

## Overview

A critical read of the implementation plan surfaced issues across four tiers. This spec covers **Tier B only — runtime robustness**: defects that compile cleanly and pass the planned unit tests but break or degrade at runtime. The chosen scope deliberately **excludes**:

- **Tier A** — the two pillars' credibility (segment-level-timestamp pauses; `base.en` WER on accented speech)
- **Tier C** — first-run Whisper-model-missing UX
- **Tier D** — minor/defensive polish (recording duration cap, blocking `screencapture`, WPM source)

Those remain as the v1 plan specifies. Nothing here changes the feedback methodology, the IPC event contract, the Zustand state shapes, or any domain type. All three fixes are **localized amendments to existing tasks** — no new sub-projects, no new tasks.

**Guiding principle:** where a fix has a known-good precedent in **MeetBuddy** (the sibling repo this project already borrows `transcribe-rs` STT from), adopt that pattern rather than invent a new one.

---

## B1 — TTS WAV delivery over IPC

### Problem

`play_tts` (Task 2 `commands.rs`) returns `Vec<u8>` and the frontend (Task 11 `PlaybackControls.tsx`) calls `invoke<number[]>`. Tauri serializes a byte vector as a **JSON array of numbers**, so a paragraph-length WAV (~1–2 MB) becomes a 5–7 MB JSON string transferred and parsed on every "Read Aloud" — slow and memory-heavy, scaling with text length.

### Decision

Return raw bytes via **`tauri::ipc::Response`**.

- **Rust** — `play_tts` returns `tauri::ipc::Response` constructed from the WAV `Vec<u8>` (`tauri::ipc::Response::new(bytes)`). Tauri transfers this as a binary body, not JSON.
- **Frontend** — `invoke("play_tts", …)` now resolves to an `ArrayBuffer`. The only change in `PlaybackControls` is the bytes-to-Blob line: `new Uint8Array(arrayBuffer)` instead of `new Uint8Array(numberArray)`. The `Blob` → `URL.createObjectURL` → HTML5 `Audio` path, and **all** pause / `playbackRate` / progress logic, are unchanged.

No `tauri.conf.json` changes. The `play_tts` IPC command name, call site, and surrounding flow stay identical.

### Rejected alternative

Temp WAV file + `convertFileSrc` asset URL. Streams from disk (marginally better for very long audio) but requires asset-protocol scope configuration and temp-file lifecycle management — unjustified complexity for read-aloud-length clips.

### Affected plan tasks
- Task 2 — `commands.rs` `play_tts` signature/return.
- Task 11 — `PlaybackControls.tsx` fetch line + `invoke` generic type.

---

## B2 — LLM client robustness

### Problem

Task 16 `llm.rs` has two latent runtime failures:

1. **No request timeout.** `reqwest::Client::new()` has no default timeout. A cold or slow local model leaves the Analyze step hanging indefinitely with no recovery.
2. **Strict JSON parse.** `serde_json::from_str(content)` requires the model to return a bare JSON object. Local OpenAI-compatible models routinely wrap output in ` ```json ` fences or add leading/trailing prose, so the parse fails and the **entire coaching panel** falls back to "unavailable" even when the model answered correctly.

### Decision

Two independent, additive fixes inside `get_feedback`:

1. **Timeout.** Build the client with `Client::builder().timeout(Duration::from_secs(timeout_secs)).build()`. Default `timeout_secs = 45`; overridable via an optional `OMLX_TIMEOUT_SECS` env var (parsed; falls back to 45 on absent/invalid), consistent with the existing `OMLX_BASE_URL` / `OMLX_API_KEY` / `OMLX_MODEL` convention. On timeout, the call returns `Err`, which the existing `stop_recording` match already maps to `score = None`, `comments = []` — diff + pacing still render.

2. **Tolerant JSON extraction.** Before parsing, normalize the model's `content`: strip markdown code fences, then extract the substring from the first `{` to the last `}`. Parse that. If still unparseable, return `Err` (same graceful fallback). This recovers the common "JSON wrapped in fences/prose" case without trusting the model to obey formatting instructions.

**Explicitly NOT done:** adding `response_format: { "type": "json_object" }` to the request body. Some OpenAI-compatible local servers reject unknown request fields with a 400; tolerant extraction is universally safe and achieves the same end.

### Affected plan tasks
- Task 16 — `llm.rs` (`get_feedback` client construction + response parsing). The existing unreachable-endpoint test still passes (connection refused is still `Err`).

---

## B3 — Audio capture quality

### Problem

1. **Sample-format assumption.** Task 12 `audio.rs` builds the cpal input stream with a hardcoded `move |data: &[f32], _|` callback, assuming the device delivers `f32`. This is the common macOS case but not guaranteed; a device offering `i16` fails to build the stream.
2. **Naive resampling.** Task 14 `stt.rs` downsamples the recording to 16 kHz with hand-rolled linear interpolation and **no anti-alias filter**, which can introduce aliasing artifacts that degrade Whisper accuracy.

### Decision

Adopt MeetBuddy's proven pattern (`src-tauri/src/audio/capture.rs`, `src-tauri/src/audio/resampler.rs`):

1. **Sample-format branching** in `audio.rs` — `match config.sample_format()` handling `SampleFormat::F32` and `SampleFormat::I16`, converting samples to `f32` in each callback; return a clear error for any other format. RMS computation, the audio-level event, and WAV writing are unchanged downstream of the conversion.

2. **`rubato` resampling** — add `rubato = "0.16.2"` (already a MeetBuddy dependency) and replace the linear-interpolation block in `stt.rs` with a `FftFixedIn<f32>` resampler from the device rate to 16 kHz. The surrounding decode (`hound`) and the `transcribe_with` call are unchanged. When the device already runs at 16 kHz, skip resampling.

### Affected plan tasks
- Task 2 — `Cargo.toml` add `rubato = "0.16.2"`.
- Task 12 — `audio.rs` sample-format match.
- Task 14 — `stt.rs` resampling via rubato.

---

## What does NOT change

- Feedback methodology and v1 scope (content accuracy + fluency/pacing; no phoneme-level GOP).
- The Tauri IPC **event** contract, all event payload shapes, and the `play_tts` **command name**.
- Zustand state shape and every domain type (`DiffToken`, `PacingMetrics`, `LlmComment`, `FeedbackResult`).
- The deterministic Rust-owned diff (`diff.rs`) and pacing (`fluency.rs`) logic, and the LLM's score-and-comments-only role.
- Segment-level timestamp handling (Tier A1), Whisper model choice (Tier A2), model-missing UX (Tier C), and all Tier-D items.

## Testing

These are robustness changes; the planned test suite stays valid. Additions:

- **B2:** a unit test feeding fence-wrapped JSON (e.g. ` ```json\n{…}\n``` `) to the extraction step and asserting it parses to the expected score/comments. The existing unreachable-endpoint test (asserts `Err`) is unaffected.
- **B3:** the existing `recorder_compiles` test still holds. A small resampler test asserting output length ≈ `input_len × 16000 / in_rate` for a non-16 kHz input.
- **B1:** covered by the Task 17 / Task 19 manual end-to-end playback check (TTS plays a full paragraph); no new automated test (IPC binary transfer isn't unit-testable without the Tauri runtime).

## Out of scope (restating, to prevent scope creep during execution)

Tier A (pause-detection accuracy, model choice), Tier C (model-missing modal), and Tier D (recording cap, non-blocking screencapture, true-audio-duration WPM). If any of these become blocking during implementation, raise them — do not silently fold them in.
