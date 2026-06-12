# Third-Party Review: azReadAnalyzer — Streaming TTS

**Date:** 2026-06-11  
**Reviewer:** Codex  
**Spec reviewed:** `docs/superpowers/specs/2026-06-11-streaming-tts-design.md`  
**Reviewed against:** current source, `2026-06-07-azreadanalyzer-design.md`, and `2026-06-08-azreadanalyzer-tierb-hardening.md`  

---

## Summary

The design is directionally sound. Rust-mediated `Channel` transport preserves the
existing Tauri boundary, raw PCM avoids container/header churn during progressive
delivery, keeping `/tts` as a fallback is pragmatic, and the Web Audio scheduling
direction matches the current `PlaybackControls` implementation.

The main gaps are lifecycle and stream-contract details. Before implementation,
the spec should tighten non-2xx handling, stale playback-session behavior, and the
exact semantics of speed/progress while chunks are still being scheduled.

---

## Findings

### 1. Non-2xx stream responses can be forwarded as PCM

**Severity:** High  
**Location:** spec lines 58-60, 72, 80

`play_tts_stream` is specified as `POST /tts_stream` followed by
`resp.bytes_stream()`, forwarding every byte chunk through the Tauri channel.
`reqwest` does not turn HTTP error statuses into errors unless the implementation
calls `error_for_status()` or checks `resp.status()` explicitly.

If the sidecar returns a 4xx/5xx JSON or text error body, Rust could forward that
body as raw PCM. The frontend would then schedule invalid audio instead of taking
the fallback path. The current full-WAV helper in `src-tauri/src/capture.rs` has a
similar unchecked-status shape around `call_tts_sidecar`, so the streaming path
should not copy that omission.

**Recommendation:** Require an explicit status check before entering
`bytes_stream()`. On non-success, read a short error body if available and return
`Err`, allowing the frontend to fall back to `play_tts` or show the existing TTS
toast.

### 2. Stale channel messages can schedule audio after the active playback changes

**Severity:** High  
**Location:** spec lines 67-72, 81, 83

The frontend flow creates a `Channel`, invokes `play_tts_stream`, and feeds
`onmessage` chunks into the stream player. The spec does not define what happens
when the user stops, pauses/replays, changes text, clicks Play again, or unmounts
while the Rust command is still reading the HTTP stream.

Without a current-playback guard, old channel messages can keep arriving and
schedule audio into a stopped or replaced player. The same issue applies to the
eventual invoke resolution or rejection: a stale success/error can reset state or
show a toast for a playback session the user has already abandoned.

**Recommendation:** Require a per-playback session id or cancellation flag in
`PlaybackControls`. Every chunk handler, completion handler, and error handler
must verify it still belongs to the current session before mutating state or
scheduling audio. `stop()` and unmount should invalidate the session and tear down
sources.

### 3. Live speed semantics are underspecified for scheduled sources

**Severity:** Medium  
**Location:** spec lines 26, 68, 71, 96

The decisions promise "live speed", but the scheduler description applies
`getSpeed()` when each chunk is converted into an `AudioBufferSourceNode`.
Already scheduled sources keep their own `playbackRate` and start times unless the
implementation explicitly tracks and updates them. Because `nextStartTime` is
computed using the speed at scheduling time, changing speed later can also make
previous timing assumptions wrong.

This may produce a user-visible mismatch: the speed selector changes, but queued
audio continues at the old rate, or the transition between old-rate and new-rate
chunks develops gaps or overlap.

**Recommendation:** Define one of two contracts. Either downgrade the feature to
"speed applies to subsequently scheduled chunks" and make the UI behavior clear,
or require the stream player to maintain active/pending sources and update their
`playbackRate` plus scheduling math when speed changes.

### 4. Scheduler should protect against underrun and past start times

**Severity:** Medium  
**Location:** spec lines 20, 28, 68, 91

The feasibility notes say synthesis is ~2x realtime, but the scheduler still
needs to handle ordinary runtime stalls: cold/warm boundary requests, GC pauses,
main-thread work, WebView scheduling delay, or a temporary sidecar hiccup. As
written, `src.start(nextStartTime)` can use a time that is already in the past.

Web Audio will then start immediately, which can make underruns audible and can
desynchronize progress from scheduled duration.

**Recommendation:** Require the stream player to clamp each scheduled chunk with
a small lookahead, for example `nextStartTime = Math.max(nextStartTime,
ctx.currentTime + lookaheadSeconds)`, and document the chosen lookahead. Keep a
short underrun counter/log for manual live checks if useful.

### 5. Sidecar streaming test is too informal for the binary contract

**Severity:** Low  
**Location:** spec lines 87-91

The sidecar test is described as a script that asserts chunks arrive
incrementally. That catches the core latency goal, but it does not fully protect
the new wire contract.

**Recommendation:** Make the script assert success status, expected content type
or documented raw PCM media type, first-chunk latency, multiple chunks for a
longer passage, even byte counts for int16 framing, and a non-empty total byte
count. This gives implementers a quick check that `/tts_stream` is not returning
an error body or malformed PCM.

---

## Notes

- The Rust-mediated `tauri::ipc::Channel` approach is a good fit for the existing
  app boundary and avoids WebView CORS/mixed-content issues.
- Raw int16 LE mono PCM at a fixed 24 kHz is a reasonable v1 streaming format.
- Keeping `/tts` and `play_tts` as fallback preserves the current working path and
  azVoiceAssist parity.
- Moving streaming scheduling into `src/lib/streamPlayer.ts` is the right shape;
  it gives the chunk assembly and scheduling rules a focused test surface.

---

## Verdict

Revise before implementation. The architecture is solid, but the spec should make
stream error handling, stale-session protection, and speed/scheduling semantics
decision-complete before coding starts.
