# Third-Party Review: Streaming TTS Implementation Plan

**Date:** 2026-06-11  
**Reviewer:** Codex  
**Plan reviewed:** `docs/superpowers/plans/2026-06-11-streaming-tts.md`  
**Reviewed against:** `docs/superpowers/specs/2026-06-11-streaming-tts-design.md`, `docs/thirdpartyreview/2026-06-11-streaming-tts-design-review.md`, and current source  

---

## Summary

The plan carries the revised streaming architecture through the right files:
`/tts_stream` in the sidecar, Rust forwarding over `tauri::ipc::Channel`, a
frontend `streamPlayer`, stale-session guards, and the existing `play_tts` fallback.

The remaining issues are implementation-contract gaps. Two are likely to break
tests or behavior directly: progress/pause/resume tracking is not tied to actual
played audio, and the Vitest Tauri mock does not export the newly imported
`Channel`.

---

## Findings

### 1. Pause/resume and completion tracking are not based on actual playback position

**Severity:** High  
**Location:** plan lines 470-489, 504-518

`startProgress()` captures a fresh `startedAt = ctx.currentTime` every time it is
called. On pause/resume, the `AudioContext` resumes the already scheduled timeline
from its paused position, but the UI elapsed time restarts from zero. Completion
then fires late because it compares the restarted elapsed value to the total
scheduled duration.

The same progress calculation also ignores playback speed. At `2x`, audio can
finish before the UI reaches the scheduled synthesized duration; at `0.75x`, the UI
can mark playback idle while audio is still playing.

**Recommendation:** Move played-position tracking into `streamPlayer`, or keep an
accumulated played offset in `PlaybackControls` that is updated on pause/resume and
accounts for the rate used by each scheduled chunk. Completion should be driven by
actual playback end state, not `ctx.currentTime - startedAt` alone.

### 2. Vitest mock will fail when `Channel` is imported

**Severity:** High  
**Location:** plan lines 426-430, 653-658; current `src/test-setup.ts` lines 28-30

The replacement `PlaybackControls.tsx` imports:

```ts
import { invoke, Channel } from "@tauri-apps/api/core";
```

The current Vitest mock for `@tauri-apps/api/core` returns only `{ invoke }`.
Import resolution happens before any render, so the existing render tests can fail
even though no streaming command is invoked during render.

**Recommendation:** Add `src/__mocks__/@tauri-apps/api/index.ts` to the file touch
list and update the mock to export a minimal `Channel` class with `onmessage` and
`toJSON` behavior sufficient for tests. Also make the mock `invoke` handle
`play_tts_stream` and `stop_tts_stream` with resolved promises.

### 3. Streaming speed changes can lag by the queued-audio lead, not just lookahead

**Severity:** Medium  
**Location:** plan lines 373-381, 587-593

`pushChunk()` schedules every chunk as soon as it arrives. The feasibility notes
say synthesis runs about 2x realtime, so `nextStartTime` can build up a scheduled
lead of multiple seconds on longer passages. Since speed changes only affect future
chunks, the user-visible speed-change delay is the full queued lead, not just the
`LOOKAHEAD = 0.1` seconds described in the design.

**Recommendation:** Either add a maximum scheduling horizon and keep later chunks
queued in JS until the horizon drains, or explicitly document that streaming speed
changes may lag by the accumulated scheduled-audio lead. If the goal is near-live
speed, implement the max-horizon queue.

### 4. Rust test plan no longer exercises the specified error behavior

**Severity:** Medium  
**Location:** plan lines 227-240; spec lines 61-62, 96

The spec requires `play_tts_stream` to return `Err` for unreachable and non-2xx
sidecar responses so error bodies are never forwarded as PCM. The plan replaces
that with a compile-only `commands_exist` test, which does not cover the core
failure mode.

**Recommendation:** Extract the stream-forwarding logic into a helper with an
injectable endpoint/client, or provide a local fake-server test path. At minimum,
include an automated test that verifies a non-2xx response returns `Err` before
any channel send occurs.

### 5. Sidecar contract test adds an undeclared dependency

**Severity:** Low  
**Location:** plan lines 74-83; current `tts_service/requirements.txt`

`tts_service/test_stream.py` imports `requests`, but `tts_service/requirements.txt`
currently lists only `mlx_audio`, `fastapi`, and `uvicorn`. A fresh sidecar venv
following the plan may fail to run the contract test.

**Recommendation:** Add `requests` to `tts_service/requirements.txt`, or rewrite
the test with a dependency already installed by the sidecar environment.

---

## Notes

- The plan correctly keeps `/tts` and `play_tts` as a fallback instead of replacing
  the current working path.
- The Rust status check before `bytes_stream()` addresses the most important
  binary-contract risk from the design review.
- The frontend stale-session guard plus `stop_tts_stream` is the right overall
  shape for superseded streams and unmount cleanup.

---

## Verdict

Revise before implementation. The plan is close, but progress/completion tracking
and the test mock surface need to be corrected before the task list is safe to
execute as written.
