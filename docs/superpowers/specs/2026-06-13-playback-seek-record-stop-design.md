# Playback Experience: Seek Handle + Stop-on-Record — Design Spec

**Date:** 2026-06-13
**Status:** Approved (brainstorming) — pending implementation plan
**Branch:** `260612-iteration`

## Context

This iteration improves the Listen/Record playback experience with two changes the user asked for:

1. **Draggable seek handle** — a thumb on the Listen progress bar that lets the user drag to any position and replay from there.
2. **Stop playback when recording starts** — clicking *Record Your Reading* must stop TTS playback so the microphone records only the user's voice (no speaker→mic bleed).

Both are scoped tightly. This supersedes the earlier streaming-TTS spec's explicit "no seek" decision (`docs/superpowers/specs/2026-06-11-streaming-tts-design.md`) for the **fully-buffered** case.

## Background (current state)

- `src/lib/streamPlayer.ts` (`createStreamPlayer`) decodes each int16 PCM chunk, schedules it as a throwaway `AudioBufferSourceNode`, and **discards the samples**. It exposes `pushChunk / pause / resume / stop / synthDuration / playbackStartTime / playbackEndTime`. Progress is driven by ctx-time bounds: `playbackStartTime()` (first chunk's ctx start) and `playbackEndTime()` (`nextStartTime`).
- `src/components/PlaybackControls.tsx` owns the `AudioContext` + player in refs (not the store). Its progress tick computes `p = (ctx.currentTime − start)/(end − start)`. The progress bar is a static fill div with **no thumb**. On completion it sets `ttsState = "idle"` but does **not** tear down the player.
- `src/components/RecordingPanel.tsx` calls `invoke("start_recording")`; the Rust backend emits a `recording-state` event → the store's `recordingState`. The recorder (`src-tauri/src/audio.rs`) uses cpal `default_input_device()` — the system microphone; it cannot capture system audio digitally.
- `recordingState` and `ttsState` both already live in the Zustand store (`src/store/useAppStore.ts`).

## Feature 1 — Draggable seek handle

### Player changes (`src/lib/streamPlayer.ts`)

1. **Retain decoded samples.** Accumulate each chunk's `Float32` samples into a growing list (we already decode them in `pushChunk`); track total sample count. No change to the fast first-sound path — chunks still schedule as they arrive.

2. **`seek(positionSec: number): void`.** Preconditions: the full clip is buffered and `positionSec` is clamped to `[0, totalDuration]`. Steps:
   - Stop and disconnect all currently-scheduled sources.
   - Build one `AudioBuffer` from the accumulated samples (lazily; cache it).
   - Create a single `AudioBufferSourceNode`, `start(startAt, positionSec)` where `startAt = ctx.currentTime + LOOKAHEAD`.
   - Recompute the ctx-time anchor (below).

3. **Virtual anchor so progress math is unchanged.** After a seek to `positionSec` at speed `s`:
   - `firstStartAt (start) = startAt − positionSec / s`
   - `nextStartTime (end) = startAt + (total − positionSec) / s`

   Then for any `ctx.currentTime = T` during playback:
   `(T − start)/(end − start) = ((T − startAt)·s + positionSec) / total = absolutePosition / total`. ✓
   So the existing PlaybackControls progress tick, time label, and completion check (`ctx.currentTime ≥ end − 0.02`) keep working at any speed and through pause/resume.

4. **New surface for the UI:** `seek(positionSec)`, plus a way to know seek is allowed and the clip length. `synthDuration()` already returns total seconds once buffered. Add `isSeekable(): boolean` (true once the full clip is retained), or expose this via PlaybackControls' existing `streamDoneRef` — see UI section.

### UI changes (`src/components/PlaybackControls.tsx`)

- **Thumb.** Render a draggable thumb on the progress track at `progress * 100%`.
- **Enabled state.** Draggable only when `streamDoneRef.current` is true (full clip buffered) and a player exists. During the initial ~2-3s stream-in, the thumb shows progress but does not respond to drag.
- **Interaction.** Pointer-based drag (`pointerdown` on track/thumb → capture; `pointermove` updates a local `scrubFraction` and renders the thumb at that position, pausing the rAF progress updates to avoid fighting the drag; `pointerup` → `player.seek(scrubFraction * synthDuration)` and resume the progress tick). A plain click on the track seeks to that point.
- **Play/pause preserved.** If playback was playing, it continues from the new position; if paused (`ctx.state === "suspended"`), the source is repositioned but stays paused until Play/resume. After the clip finishes (idle, progress = 1), dragging back replays — the player is intact (completion does not tear it down).
- **Speed.** Seeking uses the current speed for the anchor; a later speed change keeps the documented "applies to subsequently scheduled audio" contract (after a seek there is a single source, so a mid-play speed change behaves like the fallback single-source path).

## Feature 2 — Stop playback when recording starts

- **Reactive, one-directional wiring.** `PlaybackControls` subscribes to `recordingState`. A `useEffect` on `recordingState` stops playback when it becomes `"recording"`:
  - `teardown()` (stop player, stop fallback source, bump session, stop progress),
  - `invoke("stop_tts_stream")` to cancel any in-flight backend stream,
  - `setTtsState("idle")`, reset `progress / currentTime / duration` to 0.
- **`RecordingPanel` is unchanged.** It calls `start_recording` as today; the existing `recording-state` event updates the store, and PlaybackControls reacts. No direct coupling between the two components.
- **Safety of `stop_tts_stream` here.** The earlier teardown deliberately omitted `stop_tts_stream` to avoid a stop-then-immediate-replay race. Record is not followed by a Play, so cancelling the backend stream here is safe and desirable (prevents any residual streamed audio).
- **Result:** with TTS silenced before recording proceeds, the system-mic recording contains only the user's voice.

## Testing

- **`streamPlayer` unit tests** (`src/lib/streamPlayer.test.ts`): extend with the seek anchor math as a pure function check (compute `start`/`end` for a given `positionSec`, `speed`, `total`, assert the progress formula yields `positionSec/total` at `T = startAt`). The actual audio scheduling requires a real `AudioContext` → manual/integration only.
- **`PlaybackControls` test**: keep the existing render test (Play + speed render; disabled when empty). Add a test that flipping `recordingState` to `"recording"` stops playback — assert `invoke("stop_tts_stream")` is called and `ttsState` becomes `"idle"` (the shared Tauri mock already resolves `stop_tts_stream`).
- **Manual (live):**
  1. Listen to a paragraph; after it finishes buffering, drag the thumb back to replay a phrase; drag mid-playback and confirm it continues from the new spot; drag while paused and confirm it stays paused at the new spot.
  2. Start Listen, then click Record mid-playback → playback stops instantly, the button returns to Play, and the resulting recording contains only your voice (no TTS bleed).

## Out of scope

- Seeking during the initial stream-in (before fully buffered).
- Microphone input-device picker; echo/noise cancellation DSP.
- Any change to the non-streaming `play_tts` fallback's behavior beyond what already exists (it already exposes the same ctx-time bounds, so seek can apply to it too if a fallback clip is buffered — implementation may reuse the same path).
