# Plan Review: azReadAnalyzer Implementation

**Date:** 2026-06-08
**Reviewer:** Cascade
**Plan reviewed:** `docs/superpowers/plans/2026-06-07-azreadanalyzer-implementation.md` (3397 lines)
**Spec reviewed against:** `docs/superpowers/specs/2026-06-07-azreadanalyzer-design.md`

---

## Summary

The big-picture alignment is strong. The LLM-only-scores / Rust-owns-diff-and-pacing
split, the `PacingMetrics` camelCase serde bridge, the TTS-synthesis-only reuse boundary,
and the v1 scope (no phoneme-level GOP) are all consistent and well-threaded across tasks.

However, there are a few concrete inconsistencies — one will break at compile/runtime, and
three contradict explicit spec requirements (including one the Self-Review Checklist falsely
claims is done).

---

## Will break (compile + runtime)

### 1. `audio.rs` audio-level event — wrong payload + missing import

**Location:** Task 12, plan line 1971

```rust
app.emit("audio-level", rms).ok();
```

Two problems:

- **Missing trait import:** `emit` comes from `tauri::Emitter`, but `audio.rs` only imports
  `use tauri::AppHandle;`. This won't compile.
- **Payload shape mismatch:** it emits a bare `f32`, but the frontend listens for
  `AudioLevelPayload` and reads `e.payload.level` (plan line 1060). A bare number has no
  `.level` → the waveform receives `undefined`.

`events.rs` already has the correct helper `emit_audio_level` (plan line 474). The closure
should call `crate::events::emit_audio_level(&app, rms)` instead (the closure already
captures a `move`d `app` clone).

---

## Contradicts the spec

### 2. Temp paths are fixed, not unique

The spec **mandates** unique temp paths.

> Spec line 192: "Both the screenshot PNG and the recording WAV use **unique** temp paths
> (e.g. via the `tempfile` crate or a UUID suffix)..."

But the plan hardcodes:

- `/tmp/az_capture.png` in `capture.rs` (plan line 1372)
- `/tmp/az_recording.wav` in `audio.rs` (plan line 2006)

`tempfile` is only in `[dev-dependencies]` (plan line 315), so it isn't even available to
non-test code. **The Self-Review Checklist (plan line 3387) explicitly claims this is done**
— that line is inaccurate.

### 3. Temp files are never deleted

The spec data flow says "Rust deletes the temp image" (spec lines 189/192). Neither
`capture.rs` nor `audio.rs` cleans up after use.

### 4. Screenshot does not hide/restore the window

The spec UX (spec line 131) and the sequence diagram (`RS->>RS: Hide window` /
`Restore window`) both require hiding the app window during region select.
`capture_screen_region` just runs `screencapture -i` (plan line 1375) with no hide/restore,
so the app window sits over the capture target.

---

## Minor deviations worth a conscious decision

- **transcribe-rs API surface is unverified beyond timestamps.** Task 14 Step 2b
  (plan line 2290) smartly gates the *timestamp* question, but the entire low-level surface
  used in Step 3 (`WhisperContext`, `WhisperContextParams`, `full_n_segments`,
  `full_get_segment_t0/t1`) is assumed. transcribe-rs may only expose a higher-level engine
  API, and the plan's own struct is also named `WhisperEngine` (collides with the crate's
  export). Suggest broadening Step 2b to "verify the import surface compiles," not just
  timestamps.
- **Whisper-model-missing UX:** spec says *modal with download instructions* (spec line 369);
  plan degrades to a generic toast via `stop_recording` returning `Err`.
- **LLM-unreachable UX:** spec says *"transcription only, no score/comments"* (spec line 370);
  plan emits `score: 0` via `.unwrap_or((0, vec![]))` (plan line 561), which renders a
  misleading 0 in the score ring rather than suppressing it.
- **Always-on-top toggle is decorative.** The titlebar renders a toggle (plan line 761) but
  `tauri.conf.json` sets no `alwaysOnTop` and nothing wires it. Spec calls always-on-top out
  in Overview/UI.

---

## Recommendation

Items **1–4** should be fixed before implementation starts — #1 is a guaranteed break, and
#2–4 are explicit spec requirements (with #2 mis-marked as complete in the checklist). The
items in the minor list are judgment calls that can be consciously accepted for v1.

### Suggested fixes for items 1–4

1. In `audio.rs`: replace the direct `app.emit("audio-level", rms)` with
   `crate::events::emit_audio_level(&app, rms)` (no extra import needed since the helper lives
   in `events.rs`).
2. Switch both temp paths to unique paths (move `tempfile` to `[dependencies]`, or use a
   UUID/PID suffix) and update the Self-Review Checklist line to reflect reality.
3. Add temp-file cleanup after OCR and after STT consume the files.
4. Add window hide/restore around `screencapture -i` in `capture_screen_region`.
