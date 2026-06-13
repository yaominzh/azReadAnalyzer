# Playback Experience: Seek Handle + Stop-on-Record — Design Spec

**Date:** 2026-06-13
**Status:** Approved (brainstorming), revised per third-party review — pending implementation plan
**Branch:** `260612-iteration`
**Review incorporated:** `docs/thirdpartyreview/2026-06-13-playback-seek-record-stop-design-review.md` (findings 1–4: pre-record stop ordering, `setSpeed` contract, fallback seek capability, ordering test).

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

4. **`setSpeed(speed: number): void`** (review finding 2). Speed must be a player method, because after a seek the active source is a single node owned by `streamPlayer` and unreachable from `PlaybackControls`. Behavior:
   - **Single-source mode (post-seek, or fallback):** compute the current absolute position `pos` from the anchor and elapsed time, set the live source's `playbackRate.value = speed`, then recompute the virtual anchor as if re-seeking to `pos` at the new speed (`start = now − pos/speed`, `end = now + (total − pos)/speed`). This keeps progress continuous and correct after a mid-play speed change.
   - **Chunk-streaming mode (before any seek):** update the stored speed used by `getSpeed()` for subsequently scheduled chunks; already-scheduled chunks keep their rate (the documented v1 "mid-play speed applies to upcoming audio" contract from the streaming-TTS spec — unchanged).

5. **`isSeekable(): boolean`** (review finding 3). True once a complete clip is retained: for streaming, after the stream fully arrives; for the fallback player, immediately (it holds the full decoded WAV). `PlaybackControls` gates the drag handle on `player.isSeekable()` rather than on `streamDoneRef`, so the thumb is never enabled without a working `seek()`.

6. **Unified `StreamPlayer` interface.** Both the streaming player and the fallback player object implement `seek`, `setSpeed`, and `isSeekable` (in addition to the existing methods). `synthDuration()` already returns total clip seconds once buffered.

### UI changes (`src/components/PlaybackControls.tsx`)

- **Thumb.** Render a draggable thumb on the progress track at `progress * 100%`.
- **Enabled state.** Draggable only when `player.isSeekable()` is true (full clip retained — streaming-done, or any fallback clip). During the initial ~2-3s stream-in the thumb shows progress but does not respond to drag.
- **Interaction.** Pointer-based drag (`pointerdown` on track/thumb → capture; `pointermove` updates a local `scrubFraction` and renders the thumb at that position, pausing the rAF progress updates to avoid fighting the drag; `pointerup` → `player.seek(scrubFraction * synthDuration)` and resume the progress tick). A plain click on the track seeks to that point.
- **Play/pause preserved.** If playback was playing, it continues from the new position; if paused (`ctx.state === "suspended"`), the source is repositioned but stays paused until Play/resume. After the clip finishes (idle, progress = 1), dragging back replays — the player is intact (completion does not tear it down).
- **Speed.** `handleSpeedChange` calls `player.setSpeed(speed)` (in addition to updating the store). For a single seeked/fallback source this updates the live rate and recomputes the anchor (continuous progress); in chunk-streaming mode it applies to upcoming chunks per the existing contract. `handleSpeedChange` no longer pokes `fbSourceRef.playbackRate` directly — `setSpeed` owns it.

## Feature 2 — Stop playback when recording starts

**Ordering matters (review finding 1).** `start_recording` opens the cpal input stream *before* the backend emits the `recording-state` event, so a purely reactive `recordingState` effect would stop TTS only after the mic is already live — TTS could bleed into the first moments. The stop must happen **before** `invoke("start_recording")`.

- **Primary path — pre-record stop via a store-registered callback.**
  - `PlaybackControls` registers its stop function in the store on mount: a store slice `ttsStop: (() => void) | null` with `setTtsStop(fn)`. The registered function runs the local teardown synchronously — stop the player/fallback source (audible output ceases immediately, since Web Audio `source.stop()` is synchronous), bump the session, stop the progress tick, fire `invoke("stop_tts_stream")` (fire-and-forget) to cancel any in-flight backend stream, `setTtsState("idle")`, and reset `progress / currentTime / duration` to 0.
  - `RecordingPanel.handleRecord` calls `useAppStore.getState().ttsStop?.()` **before** `await invoke("start_recording")`. Because the audible stop is synchronous, no TTS is playing once the mic opens. (The async `stop_tts_stream` only cancels the backend producer, which does not affect already-stopped local output.)
- **Defensive fallback — keep the reactive effect.** `PlaybackControls` also keeps a `useEffect` on `recordingState` that stops playback when it becomes `"recording"`, so playback still stops if recording is ever initiated by another path. This is belt-and-suspenders, not the primary guarantee.
- **`stop_tts_stream` is safe here.** The earlier teardown omitted it to avoid a stop-then-immediate-replay race; Record is not followed by a Play, so cancelling the backend stream is safe and desirable.
- **Coupling.** `RecordingPanel` depends only on the store action, not on `PlaybackControls` — the components stay decoupled through the store.
- **Result:** TTS is silenced before the mic captures, so the system-mic recording contains only the user's voice.

## Testing

- **`streamPlayer` unit tests** (`src/lib/streamPlayer.test.ts`): extend with the seek anchor math as a pure function check (compute `start`/`end` for a given `positionSec`, `speed`, `total`, assert the progress formula yields `positionSec/total` at `T = startAt`). The actual audio scheduling requires a real `AudioContext` → manual/integration only.
- **Ordering test (review finding 4):** add a `RecordingPanel` test that clicks Record and asserts the pre-record stop runs **before** `invoke("start_recording")` — e.g. register a spy as `ttsStop` in the store and assert the recorded call order is `ttsStop` → `invoke("start_recording")`. This is the test that actually proves the bleed fix.
- **`PlaybackControls` tests**: keep the existing render test (Play + speed render; disabled when empty). Add a test that it registers `ttsStop` on mount, and that the defensive effect — flipping `recordingState` to `"recording"` — stops playback (`invoke("stop_tts_stream")` called, `ttsState` becomes `"idle"`; the shared Tauri mock already resolves `stop_tts_stream`).
- **Manual (live):**
  1. Listen to a paragraph; after it finishes buffering, drag the thumb back to replay a phrase; drag mid-playback and confirm it continues from the new spot; drag while paused and confirm it stays paused at the new spot.
  2. Start Listen, then click Record mid-playback → playback stops instantly, the button returns to Play, and the resulting recording contains only your voice (no TTS bleed).

## Out of scope

- Seeking during the initial stream-in (before fully buffered).
- Microphone input-device picker; echo/noise cancellation DSP.

(Note: the `play_tts` fallback is **in scope** for seek — it implements the same seek-capable `StreamPlayer` interface since it already holds the full decoded buffer, per Feature 1 items 5–6. This is a resolved decision, not deferred work.)
