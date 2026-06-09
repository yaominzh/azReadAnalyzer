# PM Review — Iteration 2 (TTS Playback + Recording/STT + FeedbackPanel)

**Date:** 2026-06-08
**Reviewer:** Product Manager (subagent)
**Iteration:** 2 of 3
**Scope reviewed:** Tasks 11–14 + Task 18 (FeedbackPanel pulled forward per Iteration 1 P1), with B1 (frontend ArrayBuffer) and B3 (audio sample-format + rubato) hardening.
**Build status at review:** 19/19 vitest, tsc clean, eslint clean, vite build OK, full `cargo build` links, `cargo test --lib` = 5 passed / 1 ignored.

---

## Verdict
**APPROVE-WITH-NOTES.** Engineering accepted my P1, pulled the FeedbackPanel forward, and delivered it end-to-end in mock mode. Verification is real this time. The honesty correction about the masked exit code in Iteration 1 is exactly the behavior I want — flagged proactively, root-caused (missing icons + missing `cpal::Sample` import), fixed. No P0s. Proceed to Iteration 3.

## P1 from Iteration 1 — resolved?
**Yes, genuinely.** The right Practice panel now mounts PlaybackControls + RecordingPanel + FeedbackPanel. FeedbackPanel renders the score ring, color-coded diff (missed = red strikethrough, said-instead = green), pacing readout, and LLM comment cards. The empty-feedback-screen complaint is fully addressed; the full feedback UX is visible via `VITE_USE_MOCK=true npm run dev`.

Two unprompted wins: (a) the LLM-unreachable degradation is correctly wired (`score === null` suppresses ring + comments, shows "AI coach unavailable", keeps diff+pacing), with a test; (b) comment text renders as plain `{c.text}`, not `dangerouslySetInnerHTML` — they avoided injecting LLM output as HTML.

## Segment-level timestamps — accept or escalate?
**Accept for v1 — with a documented honesty guardrail (P1 below).** The spike was done up front and verified against the actual 0.3.11 crate source. Reality: segment-level start/end only, no word timestamps; words distributed evenly across each segment, only inter-segment silence reads as a pause → **a fluent single-segment read-aloud yields pauseCount=0.**

Accepting because: (1) the user explicitly chose Tier B and deferred Tier A — a made decision, not an oversight; (2) the spike gives a *known* limitation, not a surprise; (3) WPM and the content diff — the load-bearing parts — are unaffected, with a sensible single-segment fallback so WPM stays meaningful.

What keeps it from a clean APPROVE: pauseCount=0 on a *halting* short read is wrong and invisible — and the UI presents "6 pauses / 2 long hesitations" with the same authority as WPM. We must not imply hesitation precision we don't have. P1 UX/honesty item, not a reason to pull Tier A into scope.

## What works
- FeedbackPanel end-to-end in mock mode; matches all claims on inspection.
- B-series hardening is real: B3 sample-format branching (F32/I16/U16), B3 rubato anti-aliased resampling with zero-padded final chunk + tests, B1 ArrayBuffer playback consuming raw bytes.
- Mono mixdown + 16-bit WAV with clamping; RMS audio-level events drive the waveform.
- Honest stubs: diff.rs / fluency.rs / llm.rs clearly labeled "lands in Iteration 3" — no fake data masquerading as real.
- Verification is now trustworthy (real exit codes; masked-pipe issue disclosed and fixed).

## Concerns / risks
- **P0:** None.
- **P1 (honesty guardrail):** Pacing metrics from segment-level timestamps can silently under-report hesitations on short/single-segment reads. Iteration 3 must (a) gate or visually de-emphasize pause/hesitation readouts when segment count is low (show "—" or a "limited timing data" qualifier instead of an authoritative "0 pauses"), and (b) document this limitation in one user-visible spot. WPM stays prominent; hesitation precision must not be over-claimed.
- **P1 (carryover, now blocking E2E):** Still not runnable end-to-end — real recording produces a transcription but no diff/score/pacing. Iteration 3 carries all three compute stubs + full pipeline wiring + first real E2E verification. Heaviest iteration; cannot slip.
- **P2:** `useMockEvents.ts` nested setTimeout — fine as a demo harness; confirm it's gated out of production (it is, on `VITE_USE_MOCK`).
- **P2:** Waveform is a level meter dressed as a waveform (single audioLevel scalar × static sine shape). Acceptable; don't let it imply per-bar frequency data.

## Priority for Iteration 3
**Wire the full real pipeline (diff → pacing → LLM) and produce the first genuine end-to-end verification — record → transcribe → diff → score → rendered feedback on a real run, not mock.** Bundled in, non-negotiable: the **P1 honesty guardrail** — when wiring real pacing (Task 15B), gate the hesitation/pause readout on segment availability so we never show authoritative "0 pauses" on data we can't measure. A working-but-honest pipeline beats a complete-looking one.

## Open questions
1. **LLM B2 hardening scope:** enumerate exactly what B2 covers (timeout, retry, key-missing, malformed-response parsing) before code, like Task 14 was spiked.
2. **Score when LLM is up but pacing is degraded:** should the score lean on diff+WPM (reliable) and treat pause data as advisory?
3. **E2E verification environment:** OCR test needs a live sidecar; STT needs `ggml-base.en.bin`. What's the plan to run a real record→feedback pass — is the model present, or does E2E stay partially mocked? Avoid a third "E2E verified" that means "mock verified."

---

## Engineering response (carried into Iteration 3 plan)
- **P1 honesty guardrail accepted** → thread segment count from `stt.rs` → add `pausesReliable` to `PacingMetrics` (false when <2 segments) → FeedbackPanel renders pauses/hesitations as "—" + "limited timing data" note when unreliable; WPM stays prominent.
- **B2 scope (answer to Q1):** timeout (45s, `OMLX_TIMEOUT_SECS` override) + tolerant JSON extraction (strip fences, first `{`…last `}`). NOT adding retry or `response_format` (some local servers 400 on it). Key-missing → request proceeds with empty bearer; unreachable/parse-fail → existing `score=None` degradation.
- **Score reliability (answer to Q2):** prompt already instructs the LLM not to over-claim; with the guardrail, degraded pause data is surfaced as advisory and the score remains LLM-discretion over diff+WPM+pacing. Not changing the scoring contract in v1.
- **E2E honesty (answer to Q3):** real `cargo build` + `cargo test --lib` are genuine; a true mic→LLM round-trip needs the user's hardware + model + running sidecars/LLM, which this environment can't fully supply. Iteration 3 verification will be explicit about what is machine-verified (compile + unit + mock-rendered full UI) vs. what requires the user's box (live mic/TTS/LLM), rather than claiming false E2E.
