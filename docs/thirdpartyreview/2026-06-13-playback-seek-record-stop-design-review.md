# Third-Party Review: Playback Seek Handle + Stop-on-Record Design

**Date:** 2026-06-13  
**Reviewer:** Codex  
**Spec reviewed:** `docs/superpowers/specs/2026-06-13-playback-seek-record-stop-design.md`  
**Reviewed against:** current source, `docs/superpowers/specs/2026-06-11-streaming-tts-design.md`, and `docs/superpowers/plans/2026-06-11-streaming-tts.md`  

---

## Summary

The feature direction is good: retaining decoded TTS samples after streaming
completes is the right way to add seek without regressing time-to-first-sound, and
stopping TTS before recording is necessary for clean microphone input.

The main gap is ordering. The current stop-on-record design reacts to the backend
`recording-state` event, but that event is emitted only after the microphone stream
has already started. The seek design also needs a clearer stream-player contract
for speed changes and fallback playback.

---

## Findings

### 1. Stop-on-record is too late to guarantee no TTS bleed

**Severity:** High  
**Location:** spec lines 55-61; current `src-tauri/src/commands.rs` lines 223-230; current `src-tauri/src/audio.rs` lines 47-49

The spec says `PlaybackControls` should stop playback when `recordingState`
becomes `"recording"`. In the current backend, `start_recording` calls
`Recorder::start()` first, and `Recorder::start()` starts the cpal input stream
before Rust emits the `"recording"` event.

That means TTS can still be audible during the first moments of microphone capture,
which contradicts the stated goal that the recording contains only the user's
voice.

**Recommendation:** Stop TTS before invoking `start_recording`. The cleanest
implementation is a frontend pre-record action in `RecordingPanel`: stop local
playback, cancel any stream, wait for that cleanup to settle, then call
`invoke("start_recording")`. Keep the reactive `recordingState` effect only as a
defensive fallback, not as the primary guarantee.

### 2. Mid-play speed after seek is underspecified

**Severity:** High  
**Location:** spec lines 35-41, 51; current `src/components/PlaybackControls.tsx` lines 185-190

After `seek()`, the active source is internal to `streamPlayer`, but current speed
handling updates only the fallback source ref. If seeking creates a single
`AudioBufferSourceNode` inside `streamPlayer`, `PlaybackControls` has no way to
update that source's `playbackRate`.

There is also a timeline issue: if playback rate changes mid-source, the virtual
anchor and `playbackEndTime()` need to be recomputed from the current absolute
position. Otherwise progress can jump or drift after a seek followed by a speed
change.

**Recommendation:** Add an explicit `setSpeed(speed)` or
`commitSpeedChange(speed)` API to `streamPlayer`. It should compute the current
absolute position, update the active source rate where possible, and recompute the
virtual start/end anchors.

### 3. Fallback seek behavior is ambiguous

**Severity:** Medium  
**Location:** spec lines 43-50, 75

The UI section requires `player.seek(...)`, but the current fallback path exposes a
minimal player-like object for progress only. The spec says seek "can apply" to the
fallback if a fallback clip is buffered, which leaves the implementation contract
open.

That ambiguity can produce a UI that enables the thumb but calls a missing
`seek()` method when playback came from the non-streaming `play_tts` fallback.

**Recommendation:** Decide explicitly. Either make fallback use the same
seek-capable `StreamPlayer` interface, or define a capability check that disables
seeking for fallback playback.

### 4. The proposed test does not prove the bleed fix

**Severity:** Medium  
**Location:** spec lines 63-69

The proposed `PlaybackControls` test flips `recordingState` to `"recording"` and
asserts that `stop_tts_stream` is called. That verifies the reactive effect, but it
does not verify the critical ordering: TTS must stop before `start_recording`
begins microphone capture.

**Recommendation:** Add a test around clicking the Record button that verifies the
pre-record stop path runs before `invoke("start_recording")`. If a defensive
reactive effect remains, keep the existing test too.

---

## Notes

- Retaining samples after streaming is complete is a reasonable memory/performance
  tradeoff for v1 reading passages.
- Disabling seek during initial stream-in keeps the first-sound latency benefit and
  avoids partial-buffer seek semantics.
- The virtual-anchor approach is a good way to preserve the current progress math,
  provided speed changes update the anchor consistently.

---

## Verdict

Revise before planning implementation. The seek direction is solid, but the
recording-order guarantee and stream-player speed/fallback contract need to be
made decision-complete first.
