# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status: MVP built (Tier-B hardened)

The v1 MVP is implemented across the full stack: `src/` (React frontend) and `src-tauri/src/` (Rust backend) exist and compile. Built in 3 iterations with a PM review after each (see [docs/pmreview/](docs/pmreview/)).

**Machine-verified:** `cargo build` links the app binary; `cargo test --lib` (15 pass, 1 ignored — the OCR test needs a live sidecar); frontend `vitest` (20 pass), `tsc`, `eslint`, `vite build` all clean; the full Practice/Feedback UI renders correctly in mock mode (`VITE_USE_MOCK=true npx vite`).

**NOT machine-verifiable here (needs the user's hardware/services):** a real mic→TTS→LLM round-trip. That requires Microphone + Screen-Recording permissions, the `ggml-base.en.bin` model, both Python sidecars running, and a local OpenAI-compatible LLM. The Rust pipeline (`stop_recording` → STT → diff → fluency → LLM → `feedback-ready`) is wired and unit-tested per stage, but the live end-to-end pass must be run on the target Mac.

**Source-of-truth docs:**
- [docs/superpowers/specs/2026-06-07-azreadanalyzer-design.md](docs/superpowers/specs/2026-06-07-azreadanalyzer-design.md) — authoritative design spec (architecture, IPC contract, state shapes, feedback methodology).
- [docs/superpowers/specs/2026-06-08-azreadanalyzer-tierb-hardening.md](docs/superpowers/specs/2026-06-08-azreadanalyzer-tierb-hardening.md) — the Tier-B runtime-robustness hardening applied in this build (B1/B2/B3).
- [docs/superpowers/plans/2026-06-07-azreadanalyzer-implementation.md](docs/superpowers/plans/2026-06-07-azreadanalyzer-implementation.md) — the 19-task plan the build followed.
- [docs/pmreview/](docs/pmreview/) — per-iteration PM reviews and the engineering responses carried forward.
- [docs/thirdpartyreview/](docs/thirdpartyreview/) — independent reviews of the spec and plan; document *why* the design landed where it did.

**Deviations from the original plan, applied during the build (all in commit history + PM reviews):**
- `react-resizable-panels` v4 API is `Group`/`Panel`/`Separator` (the plan used the v2 `PanelGroup`/`PanelResizeHandle` names).
- Bundle icons were generated with `npx tauri icon` (the plan referenced an `icons/` dir it never created → `generate_context!` failed without them).
- Added `eslint.config.js` (flat config; the plan listed the deps but never created the file).
- B-hardening folded in: B1 (`play_tts` → `tauri::ipc::Response`), B2 (LLM timeout via `OMLX_TIMEOUT_SECS` + tolerant JSON extraction), B3 (cpal sample-format branching + `rubato` resampling).
- Honesty guardrail (PM Iteration-2 P1): `PacingMetrics.pausesReliable` (`false` when ASR yields <2 segments) → the UI shows "—" + "limited timing data" for pause/hesitation instead of an authoritative "0 pauses".
- `FeedbackPanel` renders LLM comment text as plain text, not `dangerouslySetInnerHTML`.

When extending, the plan is the source of truth for *intent*; the spec is the source of truth for *why*. If they conflict, prefer the spec and flag it.

## What the app is

A **macOS-only** Tauri 2 desktop app for English speaking practice (target user: Chinese native speakers). Flow: capture text (screenshot OCR or clipboard) → listen to TTS → record yourself reading → get feedback. 100% on-device; no audio or text leaves the machine.

## Architecture (big picture)

```
React/TS + Tailwind v4 + Zustand  ──Tauri IPC──►  Rust backend
                                                    ├─ clipboard (arboard)
                                                    ├─ audio recording (cpal/hound)
                                                    ├─ Whisper STT (transcribe-rs, w/ word timestamps)
                                                    ├─ diff.rs    (deterministic content diff)
                                                    └─ fluency.rs (pacing metrics)
                                                         │
            Python sidecars (HTTP)                 Local LLM (OpenAI-compatible)
            ├─ ocr_service  :8124 (macOS Vision)   └─ returns SCORE + COMMENTS only
            └─ tts_service  :8123 (Qwen3-TTS)
```

### Load-bearing design decisions (do not silently change these)

1. **v1 feedback = content accuracy + fluency/pacing, NOT phoneme-level pronunciation.** This is deliberate and research-grounded (see the spec's "Feedback Methodology & Research Basis"). Whisper's language model auto-corrects dropped word-endings, so a transcript diff *cannot* reliably detect mispronunciation. Phoneme-level / GOP detection is explicitly deferred to v2.

2. **The LLM does NOT compute the diff or the metrics.** `diff.rs` (word-level content diff) and `fluency.rs` (wpm, articulation rate, pauses, hesitations from Whisper word timestamps) are **deterministic, Rust-owned, and unit-tested**. The LLM receives the already-computed diff + pacing and returns only `{score, comments}`. This split is what makes the feedback testable — preserve it.

3. **TTS reuse is synthesis-only.** `tts_service` is reused *verbatim* from azVoiceAssist: it takes `{text}` and returns a complete WAV — no streaming, no speed param, no playback. Playback, pause, speed (0.75x–2x via `playbackRate`), and progress are **net-new frontend work** using the HTML5 `Audio` element. There is no `stop_tts` command and no `tts-state` event — TTS playback state lives entirely in the React component, not in Rust/Zustand.

4. **LLM is best-effort.** If the LLM endpoint is unreachable, `score` is `None`/`null` and `comments` is empty; the UI still shows the locally-computed diff + pacing. Rust serializes `score: Option<u32>`; the frontend type is `number | null`.

### Cross-cutting conventions

- **IPC payloads:** Rust structs use `#[serde(rename_all = "camelCase")]` (notably `PacingMetrics`) to match the TS interfaces. `DiffToken` uses `#[serde(rename = "type")]` for its `token_type` field. Keep both sides in lockstep.
- **Temp files:** screenshot PNGs and recording WAVs use **unique** temp paths via the `tempfile` crate (`NamedTempFile`), auto-deleted on drop — never fixed paths like `/tmp/az_capture.png`.
- **Mock mode:** `VITE_USE_MOCK=true` simulates all Tauri events for UI-only dev without the Rust backend (same pattern as MeetBuddy/azVoiceAssist).

## Reuse provenance (sibling repos)

Two existing apps in `/Users/allen/repo/` are the reference implementations — consult them when wiring the borrowed pieces:

- **STT** is borrowed from **[MeetBuddy](/Users/allen/repo/MeetBuddy)** (`transcribe-rs 0.3.11` + `whisper-cpp`, `ggml-base.en.bin`). Note: azVoiceAssist uses `whisper-rs` instead — use MeetBuddy's approach.
- **TTS sidecar** and the **visual theme** (`#080808` bg, frosted glass, indigo `#6366f1`, Inter) are borrowed from **[azVoiceAssist](/Users/allen/repo/azVoiceAssist)**. Same LLM env vars (`OMLX_BASE_URL`, `OMLX_API_KEY`, `OMLX_MODEL`).

## Commands

These become available as the plan creates the corresponding files. Run frontend/Node commands from the repo root and Rust commands from `src-tauri/`.

```bash
# Dev (full app — needs sidecars + Whisper model for end-to-end)
npx tauri dev

# Frontend
npm run dev            # vite only
npm run build          # tsc -b && vite build
npm run lint           # eslint
npm test               # vitest run (all)
npx vitest run path/to/file.test.tsx   # single test file
npx vitest             # watch mode

# Rust (from src-tauri/)
cargo check
cargo test                              # all
cargo test --lib                        # unit tests (diff.rs, fluency.rs, etc.)
cargo test diff::tests::name -- --nocapture   # single test

# Sidecars (each in its own terminal, from its own dir)
cd ocr_service && .venv/bin/uvicorn server:app --port 8124
cd tts_service && .venv/bin/uvicorn server:app --port 8123

# Whisper model (one-time)
mkdir -p ~/.azreadanalyzer/models
curl -L -o ~/.azreadanalyzer/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

**macOS permissions** (grant via Terminal.app on the machine directly): Microphone (prompted on first record) and Screen Recording (required for `screencapture -i`, granted in System Settings → Privacy → Screen Recording).

## Testing approach

- **Rust unit tests** are the backbone — they cover the deterministic diff (`diff.rs`) and pacing computation (`fluency.rs`, tested with synthetic word timestamps). These are meaningful precisely because the LLM only layers score+comments on top.
- **Frontend** uses Vitest + React Testing Library for store actions and components; the plan follows a TDD rhythm (write failing test → implement → pass).
- **Integration** is manual: the full capture→record→feedback round-trip on real hardware.

## Open risk to resolve early

Before building `fluency.rs`, **verify that `transcribe-rs`/whisper-cpp actually surfaces word/segment timestamps with usable precision** for Chinese-accented read-aloud English (whisper.cpp has `--dtw` token timestamps). The entire pacing signal depends on this. If native precision is insufficient, the documented fallback is a WhisperX-style wav2vec2 alignment pass — but that pulls a Python/PyTorch dependency and should be avoided for v1. See the spec's "Implementation risk to resolve during planning."
