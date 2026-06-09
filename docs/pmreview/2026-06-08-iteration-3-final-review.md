# Final PM Review — azReadAnalyzer MVP (Iteration 3 of 3)

**Date:** 2026-06-08
**Reviewer:** Product Manager (subagent)
**Verdict:** **SHIP-WITH-FOLLOWUPS**

---

## Final verdict

**SHIP-WITH-FOLLOWUPS.** The MVP application code is complete, internally consistent, and the Iteration-2 priority was delivered in full. Every headline claim was spot-checked against the actual source and independently re-run — nothing was taken on faith. The remaining work is *operator setup* (model download, two sidecar dirs) and a *live hardware pass*, not missing or broken app code. Acceptable to call the MVP done, with a clear handoff backlog.

## Iteration-2 priority — delivered?

Yes, both halves.
- **Full real pipeline wired** (`commands.rs`): `stop_recording` → `transcribe` → `word_diff` → `compute_pacing(words, segment_count)` → `get_feedback` → `emit_feedback_ready`. LLM is best-effort; on error `score=None`, `comments=[]`, diff+pacing still ship.
- **First genuine end-to-end verification** — machine-verifiable layers pass on this machine; the live round-trip is correctly scoped as requiring the user's Mac, not hand-waved.

## Honesty guardrail (P1) — correctly implemented?

**Yes — threaded cleanly through all five layers.** Standout of the iteration.
- `stt.rs` `segment_count` (synthetic whole-clip segment counted as 1, not promoted).
- `fluency.rs` `pauses_reliable: segment_count >= 2`; WPM always valid.
- `events.rs` `pauses_reliable` on `PacingMetrics`, camelCase, documented.
- `llm.rs` prompt branch: when unreliable, "do NOT comment on pauses or hesitations." The model is constrained, not just the UI.
- `FeedbackPanel.tsx`: "—" + "Limited timing data" note; WPM prominent.
- Tested both sides. No gaps.

## B2 hardening — verified

45s timeout with `OMLX_TIMEOUT_SECS` override; `extract_json_object` strips fences + isolates first `{`…last `}`; covered by two tests. Plain-text comments (untrusted model output).

## Is the MVP done? (caveats head-on)

**The app is done; the deployment environment is not — a real distinction, not a dodge.**
- **"Needs the user's Mac for live E2E" — ACCEPTABLE.** Live mic→STT→LLM needs permissions + local LLM + model, none of which exist in the sandbox. Pipeline wired + unit-tested per stage; full UI driven by a real browser in mock mode.
- **Un-created `ocr_service/` + `tts_service/` — ACCEPTABLE for "code complete," but gate "user can actually use it."** Confirmed both dirs + model genuinely absent. App degrades gracefully, but without OCR no screenshot capture, without model no transcription.

**Independent re-verification (real exit codes):** Rust 15 passed / 1 ignored; frontend 20 passed (5 files); sidecar dirs + model absent as disclosed. Report did not overstate.

## What shipped (3 iterations)

- Capture & UI shell; recording state machine; full Practice panel (score ring, color-coded diff, pacing readout, emoji coach cards).
- Recording → STT (`WhisperEngine`, temp-WAV auto-deleted, segment timestamps).
- Deterministic Rust-owned analysis: `diff.rs` (similar) + `fluency.rs` (wpm/articulation/pauses).
- LLM coaching grounded on pre-computed diff+pacing, timeout-bounded, tolerant JSON, best-effort.
- P1 honesty guardrail end-to-end.
- Graceful degradation everywhere.

## Backlog for the user / v1.1

**Must-do to actually run it (operator setup):**
1. Download `ggml-base.en.bin` to `~/.azreadanalyzer/models/`.
2. Create + start `tts_service/` (read-aloud audio).
3. Create + start `ocr_service/` on :8124 (screenshot capture; un-gates the ignored Rust test).
4. Grant macOS Mic + Screen-Recording permissions.
5. Start the local LLM on `OMLX_BASE_URL` (or accept diff+pacing-only).
6. **Run the live mic→STT→LLM pass once on the Mac** — the one verification that couldn't run here.

**v1.1:** one-shot `setup.sh`/preflight check; replace favicon (kill 404); revisit `>=2 segment` heuristic if true word-timestamps land; multi-segment integration test on real audio.

## Final word

Three iterations, three honest reviews, and the team closed the exact gap I flagged: the pipeline is real and wired, and the P1 honesty guardrail is implemented the right way — it constrains the model, not just the pixels, and it's tested at the boundary. The claims survived independent re-verification. **The MVP is code-complete and ships.** Approved: **SHIP-WITH-FOLLOWUPS.**

---

## Engineering response

Items 2 & 3 of the must-do backlog (`tts_service/`, `ocr_service/`) are sidecar *code*, not just operator config — created in the same final commit so the user's manual list drops to: model download, macOS permissions, start the 2 sidecars + LLM, run the live pass. Items requiring the user's hardware (model, permissions, live round-trip) remain theirs by physics. v1.1 preflight `setup.sh` noted for follow-up.
