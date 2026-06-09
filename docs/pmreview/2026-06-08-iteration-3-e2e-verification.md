# Iteration 3 — End-to-End Verification Report

**Date:** 2026-06-08
**Iteration:** 3 of 3 (final)
**Purpose:** Honest accounting of what is verified vs. what requires the user's hardware — directly answering PM Iteration-2 Open Question #3 ("avoid a third 'E2E verified' that means 'mock verified'").

---

## Machine-verified (run in this environment, real exit codes)

| Check | Result |
|-------|--------|
| `cargo build` (full app binary links, all real impls wired) | ✅ exit 0 |
| `cargo test --lib` | ✅ 15 passed, 1 ignored (OCR needs live sidecar) |
| `npx vitest run` | ✅ 20 passed |
| `npx tsc -b` | ✅ clean |
| `npx eslint .` | ✅ exit 0 |
| `npm run build` (tsc + vite prod build) | ✅ built |
| Full UI render in mock mode (real browser via Playwright) | ✅ screenshot captured |

**Rust unit coverage of the deterministic core (the spec's "trustworthy" layer):**
- `diff.rs` — identical/missed/added word diff (3 tests).
- `fluency.rs` — wpm, articulation rate, pause counting, and the `pausesReliable` honesty guardrail (4 tests).
- `stt.rs` — rubato resample length + 16kHz no-op (2 tests) + model path.
- `llm.rs` — B2 tolerant JSON extraction from markdown fences + bare JSON, and unreachable→Err degradation (3 tests).

**Visual verification (not "mock-claimed" — actually rendered):** the dev server was launched with `VITE_USE_MOCK=true`, driven by a real Chromium via Playwright, and screenshotted after the mock pushed a full `FeedbackResult`. Confirmed on-screen: titlebar + always-on-top toggle; left text panel with captured text + Screenshot/Paste/Clear; right Practice panel with Listen (play/progress/1x speed), Record (button/waveform/timer), and Feedback — score ring **87**, pacing readout **142 wpm · 6 pauses · 2 long hesitations · 21% pause ratio**, color-coded diff (`clearly`→`clear`, `you can develop` struck through), missed/said-instead legend, and three emoji coach cards. Only console message was a harmless `favicon.ico` 404.

## Requires the user's Mac (cannot be verified in this environment)

A true mic→TTS→LLM round-trip needs all of:
1. **Microphone** + **Screen Recording** permissions (granted via Terminal.app on the machine; prompts on first use).
2. **`ggml-base.en.bin`** Whisper model at `~/.azreadanalyzer/models/` (~141 MB download).
3. **OCR sidecar** on :8124 (`ocr_service/` — not yet created; see Remaining work) and **TTS sidecar** on :8123 (`tts_service/`, copy from azVoiceAssist — not yet created).
4. A **local OpenAI-compatible LLM** on `OMLX_BASE_URL`.

The Rust pipeline `stop_recording` → `stt::transcribe` → `diff::word_diff` → `fluency::compute_pacing` → `llm::get_feedback` → `emit_feedback_ready` is fully wired in `commands.rs` and each stage is unit-tested, but the live integration pass must be run on the target hardware.

## Remaining work to reach a runnable product on the user's machine

These were in the plan's Sub-projects but are sidecar/asset setup, not app code:
- **`ocr_service/`** (Task 6) — FastAPI + macOS Vision OCR. Not yet created.
- **`tts_service/`** (Task 9) — copy from `azVoiceAssist/tts_service/`. Not yet created.
- **Whisper model download** (Task 14 Step 2) — one-time curl.

The app **degrades gracefully** without these: missing model → "Whisper not loaded" on record; sidecar down → toast ("OCR/TTS service not running"); LLM down → diff + pacing shown, score/comments suppressed.

## Known v1 limitations (by design / scope)

- **Pace/pause precision:** segment-level ASR timestamps only → pauses observable at segment boundaries; surfaced honestly via `pausesReliable` (Tier A deferred).
- **Content accuracy:** `base.en` may over-report errors on Chinese-accented speech (Tier A2 deferred).
- **Model-missing UX:** generic error, not the spec's download modal (Tier C deferred).
- These are out of the approved Tier-B scope and are documented, not hidden.
