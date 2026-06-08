# Third-Party Review: azReadAnalyzer — Design Spec

**Spec reviewed:** `docs/superpowers/specs/2026-06-07-azreadanalyzer-design.md`
**Review date:** 2026-06-07
**Reviewer:** Cascade (independent code-grounded review)
**Verdict:** Architecturally sound and well-scoped, but **two items need resolution before planning** — the Whisper-as-pronunciation-truth risk (#1) and the TTS speed/playback/progress work that's mislabeled as "reused" (#2, #3). The diff-ownership contradiction (#4) should also be settled since it's the core feature.

---

## Grounding (verified against source)

- **azReadAnalyzer is greenfield** — only `docs/` + `mockup.html` exist; this is a pure design review.
- **TTS sidecar reality:** `azVoiceAssist/tts_service/server.py:22-27` accepts **only** `{text: str}` — no speed param. Playback happens in **Rust via rodio** (`azVoiceAssist/rust/src/tts.rs:59-77`), stop-only (no pause) and **no position/duration reporting**.
- **STT claim verified:** MeetBuddy uses `transcribe-rs 0.3.11` with `whisper-cpp` (`meetbuddy/src-tauri/Cargo.toml:36`), so the `ggml-base.en.bin` download (spec line 331) is the right format. That reuse claim holds.
- **Note:** azVoiceAssist itself uses `whisper-rs 0.16` (`azVoiceAssist/rust/Cargo.toml:12`), not transcribe-rs — so STT is borrowed from MeetBuddy, TTS from azVoiceAssist.

---

## Summary Table

| Severity | Issue |
|----------|-------|
| 🔴 Critical | Whisper transcription is a weak ground truth for pronunciation / word-ending feedback — the headline feature |
| 🟠 Major | TTS speed control (0.75x–2x) not supported by the "verbatim reused" sidecar (`{text}` only) |
| 🟠 Major | TTS playback + progress (pause, position_ms/duration_ms) is net-new, not "reused" |
| 🟠 Major | Diff ownership contradictory — LLM-returned diff (Data Flow) vs Rust "diff algorithm" unit test (Testing) |
| 🟡 Minor | OCR transport undecided; fixed temp paths; split reuse provenance; Mermaid `\n`; `LLMComment.icon` source |

---

## Critical / Product Risk

### 1. Whisper transcription is a weak ground truth for pronunciation feedback
The target user wants feedback on **"pronunciation, word endings, adverb forms"** (spec line 12), and the analysis compares original text against a **Whisper transcription** of the recording (lines 70, 208). But Whisper has a strong internal language model that **auto-corrects and restores** dropped word-endings (`-ed`, `-s`), filler, and minor mispronunciations — it often "hears" the intended word. A text-level diff of Whisper output will therefore **systematically miss** exactly the errors this app promises to catch, while phoneme-level scoring is explicitly **out of scope** (line 353).

Result: the headline feature (pronunciation / word-ending feedback) may not be deliverable from Whisper-text diff alone.

**Recommend** the spec explicitly acknowledge this and either:
- (a) reposition v1 feedback as **content accuracy / fluency / pacing** rather than pronunciation, or
- (b) add a `word_timestamps`-based pacing signal (transcribe-rs/whisper-cpp can emit timestamps) to give a defensible fluency metric.

---

## Major

### 2. TTS speed control (0.75x–2x) is not supported by the reused sidecar
The spec promises a speed selector (lines 79, 109, 136, 162, 247) and calls the TTS sidecar "reused from azVoiceAssist **verbatim**" (line 161). The actual service takes only `{text}` (`server.py:22`) with a fixed voice — no speed parameter. So either the sidecar must be modified (contradicting "verbatim") or speed is applied in the Rust rodio layer. Note rodio playback-rate changes **pitch** unless time-stretched, which is undesirable for pronunciation modeling. The spec must specify the mechanism; this is unresolved net-new work.

### 3. TTS playback + progress tracking is net-new, not "reused"
The spec labels the sidecar's purpose as "text-to-speech **playback**" (lines 66, 163) and the diagram shows it doing playback (lines 43-44). In reality the sidecar only **synthesizes a full WAV buffer**; playback is Rust-side rodio (`tts.rs:59-77`), which in azVoiceAssist supports **stop only — no pause, no position reporting**. The spec requires:
- **Play/pause/stop** (line 136) — pause is new (verify rodio `Sink::pause`/`play`).
- **Progress bar with `position_ms`/`duration_ms`** via `tts-state` (line 259, UI `0:14/0:42`) — needs a Rust playback-position timer; `duration_ms` derivable from WAV length, `position_ms` is new.

None of this is "reused." Recommend a `PlaybackControls`/rodio section in Components scoping this work, and correcting the diagram/table to say the sidecar **synthesizes** (Rust plays).

### 4. Diff ownership is contradictory (LLM vs. Rust)
The Data Flow says the **LLM** returns `{score, diff, comments}` (lines 208, 233), but Testing says the **Rust** "diff algorithm" is unit-tested (line 309). These conflict: an LLM-generated diff is non-deterministic and not unit-testable. **Recommend** computing the `diff` deterministically in Rust (token alignment over original vs transcription) and letting the LLM produce only `score` + `comments`. That makes `DiffToken[]` reliable, the unit test meaningful, and reduces LLM latency/variability.

---

## Minor

- **OCR transport undecided.** Line 159 says "via stdout/HTTP"; Data Flow and setup use HTTP (lines 175, 193, 324). Pick HTTP and drop "stdout" for consistency.
- **Fixed temp paths.** `/tmp/az_capture.png` and `/tmp/az_recording.wav` (lines 173, 206) collide across concurrent instances and leave stale files. Use unique temp files (the TTS sidecar itself uses `tempfile.TemporaryDirectory`).
- **Reuse provenance is split** (fine, but state once): STT from MeetBuddy (`transcribe-rs`), TTS from azVoiceAssist (which uses `whisper-rs`, not transcribe-rs). Confirm the new app standardizes on `transcribe-rs` for STT to avoid pulling two whisper stacks.
- **Mermaid `\n` line breaks** (lines 50-54, 87-91) render literally in many renderers; use `<br/>`. Cosmetic.
- **`LLMComment.icon` source.** Type is `{icon, text}` (line 286) but the LLM is a text model — specify how `icon` is chosen (LLM-returned enum vs frontend-mapped category) to avoid the LLM emitting arbitrary icon strings.

---

## What's Good

- Clean two-panel UX with a clear capture→listen→record→analyze→feedback loop.
- Sensible privacy posture (100% on-device) and a realistic sidecar split.
- STT reuse from MeetBuddy (`transcribe-rs` + ggml model) is accurate and low-risk.
- Error-handling table is thorough (permissions, unreachable sidecars, cancelled screenshot).
- `Out of Scope (v1)` is explicit and disciplined.

---

## Verdict

Architecturally sound and pleasantly scoped, but **two things need resolution before planning**: the Whisper-as-pronunciation-truth risk (#1) and the TTS speed/playback/progress work that's mislabeled as "reused" (#2, #3). The diff-ownership contradiction (#4) should also be settled since it's the core feature. The reuse from MeetBuddy (STT) checks out; the reuse from azVoiceAssist (TTS) is real but covers far less than the spec implies — it synthesizes WAV only, with playback, pause, speed, and progress all being new work.
