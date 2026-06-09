# PM Review — Iteration 1 (App Shell + Text Capture)

**Date:** 2026-06-08
**Reviewer:** Product Manager (subagent)
**Iteration:** 1 of 3
**Scope reviewed:** Sub-project 1 (App Shell, Tasks 1–4) + Sub-project 2 (Text Capture, Tasks 5–8), plus early hardening B1 + B3 dependency.
**Build status at review:** 7/7 vitest, tsc clean, eslint clean, vite build OK, `cargo check` OK.

---

## Verdict

**APPROVE-WITH-NOTES.** This is the right foundation. The architecture matches the spec, the contracts are clean, the hardening is genuinely folded in (not just claimed), and the iteration boundaries are honest. The notes below are about one user-facing gap and a couple of claims in the demo write-up that overstate what's actually shippable today. Nothing here blocks proceeding to Iteration 2.

## What works

- **App shell is real and on-spec.** `App.tsx` has the custom titlebar (traffic lights, always-on-top toggle wired to `set_always_on_top`), the 50/50 resizable two-panel layout, and the `#080808` azVoiceAssist dark theme. Matches the UI Layout section of the design spec.
- **State and event plumbing are complete and correct.** `useAppStore.ts` holds the full app state (text/tts/recording/feedback/toasts) exactly per the spec's Zustand interface. `useTauriEvents.ts` wires all four events (`text-captured`, `audio-level`, `recording-state`, `feedback-ready`) with proper unlisten cleanup and a `__TAURI__`-ready retry guard.
- **Text capture works end-to-end (Rust side fully implemented).** `capture.rs` does `screencapture -i` into a unique `NamedTempFile`, treats 0-byte output as "cancelled," calls the OCR sidecar on :8124, and auto-deletes the temp file on drop. `clipboard.rs` + `CaptureControls.tsx` Paste path is complete. Error toasts match the spec's Error Handling table.
- **B1 hardening is genuinely implemented, not stubbed.** `play_tts` returns `tauri::ipc::Response::new(bytes)` (raw bytes), not a JSON `number[]`.
- **Type consistency holds across the boundary.** `score: number | null` (TS) ↔ `Option<u32>` (Rust), camelCase `PacingMetrics` — the LLM-unreachable degradation path is already modeled on both sides.
- **Verification claims check out.** Frontend suite: 7/7 vitest pass. Stub boundaries match the implementation plan's task→iteration mapping exactly.

## Concerns / risks

- **[P1] The Practice panel is completely empty — mock mode can't actually exercise the feedback UI yet.** `useMockEvents.ts` faithfully pushes a full mock `FeedbackResult` into the store, but there is no `FeedbackPanel`/`PlaybackControls`/`RecordingPanel` to render it. The headline claim that mock mode lets you "exercise the whole UI without the backend" is only half-true: the capture half is exercisable; the practice/feedback half renders nothing. **We have not yet visually validated the most important screen in the product.** Don't let it slide past Iteration 2.
- **[P2] Demo write-up overstates diff.rs/fluency.rs.** They're stubs returning `vec![]` / `default()`. Correct per the plan (Tasks 15/15B are Iteration 3), but **zero Rust unit tests exist yet** for the diff/pacing core. No action now — just don't carry a false sense of coverage.
- **[P2] Unresolved spec risk still unaddressed (expected).** The spec's own call-out — "verify `transcribe-rs` timestamp precision before building fluency.rs" — lands in Iteration 2 (Task 14, Step 2b). This is the single biggest technical unknown (pacing is the dominant fluency signal). Must be resolved early in Iteration 2.
- **[P2] `unsafe impl Send/Sync for AppState`** (wrapping the non-Send cpal `Stream`) is reasonable but bites under concurrency. Worth a careful look when real cpal streams land in Task 12.

## Priorities for Iteration 2

**The single most important thing: ship `PlaybackControls` + `RecordingPanel` AND a `FeedbackPanel` good enough to render the mock feedback result — so the right-hand Practice panel is fully exercisable in mock mode by end of Iteration 2.** The feedback view is the product; the mock already produces a complete `FeedbackResult`, so wiring a `FeedbackPanel` costs little and unblocks design review of the highest-risk screen one iteration earlier. Pair this with the Task 14 timestamp-precision spike up front.

## Open questions for the team

1. **Timestamp spike outcome:** When Task 14 lands, what's the actual pause-detection resolution? If segment-level only, do we accept the documented duration-only fallback for v1, and does the "6 pauses · 2 long hesitations" UI degrade gracefully when pause data is coarse/absent?
2. **Mic + Screen Recording permissions:** only grantable on real hardware. Who validates the permission-denied toast flows before we call the MVP done, and on which machine?
3. **TTS payload size in practice:** B1 fixed the `number[]` bloat, but how large is a real Qwen3-TTS WAV for a paragraph, and is HTML5 `Audio` from an in-memory ArrayBuffer blob smooth at 0.75x–2x `playbackRate`? Worth a real-WAV check during Task 11.

---

## Engineering response (carried into Iteration 2 plan)

- **P1 accepted** → FeedbackPanel (Task 18) is **pulled forward** into Iteration 2 so mock mode renders the full Practice panel.
- **P2 timestamp risk accepted** → Task 14 Step 2b (transcribe-rs API/timestamp confirmation) is done **first** in Iteration 2, before fluency wiring.
- Iteration 2 also lands B1's frontend consumption (ArrayBuffer in PlaybackControls) and B3 (audio sample-format branching + rubato resampling).
