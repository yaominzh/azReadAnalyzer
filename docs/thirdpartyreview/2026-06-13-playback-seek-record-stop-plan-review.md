# Third-Party Review: Playback Seek Handle + Stop-on-Record Implementation Plan

**Date:** 2026-06-13  
**Reviewer:** Codex  
**Plan reviewed:** `docs/superpowers/plans/2026-06-13-playback-seek-record-stop.md`  
**Reviewed against:** `docs/superpowers/specs/2026-06-13-playback-seek-record-stop-design.md`, `docs/thirdpartyreview/2026-06-13-playback-seek-record-stop-design-review.md`, and current source  

---

## Summary

The plan resolves the major design-review concerns at the architectural level:
recording now stops TTS before opening the microphone, fallback playback uses a
seek-capable player, and speed changes are routed through the player API instead
of directly poking a fallback source.

The remaining issues are implementation details that can still produce broken
runtime behavior: a stopped paused clip can incorrectly resume as silent playback,
and a mid-stream error can leave scheduled audio playing while the UI reports idle.

---

## Findings

### 1. Play can resume a stopped/empty context after stop-on-record

**Severity:** High  
**Location:** plan lines 527-534, 543-552

`stopPlayback()` calls `teardown()`, which clears `playerRef`, but it does not clear
`playbackTextRef` or change a suspended `AudioContext` back to a non-resumable
state. The resume branch later checks only:

```ts
ctxRef.current &&
ctxRef.current.state === "suspended" &&
playbackTextRef.current === inputText
```

If playback was paused, then Record invokes `ttsStop()`, the player is torn down,
and a later Play with the same text can resume an empty context, set
`ttsState = "playing"`, and produce no audio.

**Recommendation:** Require `playerRef.current` in the resume condition, and/or
clear `playbackTextRef` in `stopPlayback()`. The safest resume gate is: suspended
context, non-null player, matching playback text, and not explicitly stopped.

### 2. Mid-stream failure leaves scheduled audio playing while the UI goes idle

**Severity:** High  
**Location:** plan lines 583-591

When `play_tts_stream` fails after at least one chunk has arrived, the code stops
the progress loop, sets `ttsState` to idle, and shows a toast. It does not stop the
already scheduled `AudioBufferSourceNode`s.

That can leave audio continuing to play after the UI says playback has stopped,
and the seek/progress state can become inconsistent.

**Recommendation:** In the `received === true` error path, stop the current player,
clear `playerRef`, reset `seekable` and stream completion flags, and invalidate the
session as needed. If the intended behavior is to leave already played audio alone,
do not leave future scheduled audio running.

### 3. Automated tests do not exercise the core seek player behavior

**Severity:** Medium  
**Location:** plan lines 36-68, 389-440

The plan adds pure `computeSeekAnchor` tests and stop-on-record tests, but it does
not test the actual new seek-capable player behavior: `createBufferPlayer.seek`,
`setSpeed`, `isSeekable`, or the `PlaybackControls` pointer-driven seek path.

Those are the feature's main behavioral contracts and the places most likely to
regress.

**Recommendation:** Add a small mocked Web Audio test for `createBufferPlayer`
that verifies `seek()` starts the source with the expected offset and `setSpeed()`
updates playback rate plus anchor. Add a lightweight component test for the seek
track when `isSeekable()` is true, or explicitly document that seek UI is manual
only and keep core player behavior covered.

### 4. Slider role lacks keyboard behavior or disabled semantics

**Severity:** Medium  
**Location:** plan lines 721-733, 896-901

The progress track is always rendered with `role="slider"` and `aria-valuenow`, but
the plan explicitly leaves keyboard seek out of scope. A slider without keyboard
operation is an accessibility mismatch. When `seekable` is false, the element is
also still exposed as an operable slider unless disabled semantics are provided.

**Recommendation:** Either implement basic slider keyboard behavior
(`ArrowLeft/Right`, `Home`, `End`) when seekable, or do not expose the track as a
slider until it is actually operable. If it remains rendered while disabled, add
`aria-disabled="true"` and ensure pointer/key handlers no-op consistently.

---

## Notes

- The store-registered `ttsStop` callback is a reasonable decoupling point between
  `RecordingPanel` and `PlaybackControls`.
- Using `createBufferPlayer` for fallback playback resolves the earlier fallback
  seek ambiguity.
- The virtual-anchor helper is a good pure unit-test target, but it should not be
  the only automated coverage for seek.

---

## Verdict

Revise before implementation. The plan is close, but it should tighten stopped
resume behavior, mid-stream failure cleanup, and seek accessibility/test coverage
before execution.
