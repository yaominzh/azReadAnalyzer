# Iteration 2 Plan — Replay Your Reading (#3)

**Spec:** [2026-06-09-ui-feedback-round1-design.md](../specs/2026-06-09-ui-feedback-round1-design.md) goal #3, §#3
**Branch:** `260609-bugfix`

**Goal:** after recording + analysis, the user can replay their own reading audio. Establishes the session-media-in-`AppState` + `ipc::Response` binary + object-URL-lifecycle patterns that Iteration 3 reuses.

---

## Task 1 — Keep the recording in session state (Rust)

**Files:** `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

- [ ] `AppState` (commands.rs): add `pub last_recording_wav: Mutex<Option<Vec<u8>>>`.
- [ ] `lib.rs`: in the `.manage(Arc::new(AppState { … }))` block, initialize `last_recording_wav: Mutex::new(None)`. **(This file MUST be edited — AppState construction lives here, per the round spec / review finding #2.)**
- [ ] `stop_recording` (commands.rs): the recording WAV is a `NamedTempFile` that currently drops (deletes) at fn end. Read its bytes and store a copy:
  ```rust
  if let Ok(bytes) = std::fs::read(wav.path()) {
      if let Ok(mut g) = state.last_recording_wav.lock() { *g = Some(bytes); }
  }
  ```
  **(TPM M1)** Place this **immediately after STT completes (right after the `let result = { … engine.transcribe(...) }` block), BEFORE the `llm::get_feedback(...).await`** — so the copy is captured even if the LLM is slow/cancelled, and the `last_recording_wav` lock is never held across an `.await` (the guard drops at the end of the `if let`). The temp file is still auto-deleted; only an in-memory copy is kept (session-only, on-device).

## Task 2 — `get_last_recording` command (Rust)

**Files:** `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

- [ ] Add command returning the stored WAV as raw bytes (same B1 pattern as `play_tts`):
  ```rust
  #[command]
  pub fn get_last_recording(state: State<'_, Arc<AppState>>) -> Result<tauri::ipc::Response, String> {
      let g = state.last_recording_wav.lock().map_err(|e| e.to_string())?;
      match &*g {
          Some(bytes) => Ok(tauri::ipc::Response::new(bytes.clone())),
          None => Err("No recording yet".into()),
      }
  }
  ```
- [ ] `lib.rs`: add `commands::get_last_recording` to `tauri::generate_handler!`.

## Task 3 — Replay control (frontend)

**Files:** `src/components/FeedbackPanel.tsx` (and a small reusable bit if cleaner)

- [ ] In `FeedbackPanel` (renders only when `feedback` exists), add a **"▶ Your reading"** button near the top (so the user can compare against the TTS "Listen" control above). Play/pause toggle. **(TPM M3)** Use a real **text** label ("Your reading") — glyph as a text node, NOT an icon-only `aria-label` button — so its accessible name contains "Your reading" and the Task-4 test query matches.
- [ ] **(TPM S3)** Keep both `audioRef` and `urlRef`. On a fresh play, if a prior audio/URL exists, `pause()` + `URL.revokeObjectURL` the old one **before** creating the new one (don't just rely on `onended`), so repeated clicks don't leak.
- [ ] On play: `const buf = await invoke<ArrayBuffer>("get_last_recording")` → `new Blob([new Uint8Array(buf)], {type:"audio/wav"})` → object URL → `new Audio(url)` → `play()`. Catch errors → `addToast(String(e), "error")` (covers mock/browser where invoke throws, and "No recording yet").
- [ ] **Object-URL lifecycle (spec/review #5):** keep the `Audio` + URL in refs; on `ended`, on a new play, and on component unmount → `pause()` + `URL.revokeObjectURL(url)`. A `useEffect(() => () => cleanup(), [])` handles unmount.
- [ ] Disabled/idle visual consistent with the app (indigo accent). Button always present when feedback is shown; if no recording is actually stored (e.g. mock), the click simply toasts — acceptable.

## Task 4 — Tests

**Files:** `src/components/__tests__/FeedbackPanel.test.tsx`

- [ ] Add a test: when `feedback` is set, the "Your reading" replay button renders (e.g. `getByRole("button", { name: /your reading/i })`). Existing 6 FeedbackPanel tests must still pass.
- [ ] No new Rust unit test for the trivial command, but `get_last_recording`'s empty→`Err` branch is exercised at runtime; note in verification. (If cheap, add a pure helper test; not required.)

## Verification

- [ ] `cd src-tauri && cargo check` clean (AppState field + new command compile; `generate_handler!` updated).
- [ ] `npx tsc -b`, `npx eslint .` clean.
- [ ] `npx vitest run` — all pass incl. the new replay-button test.
- [ ] **Live** (`npx tauri dev`, mic + model + LLM): record a reading → after feedback, click "▶ Your reading" → hear your own audio back; play a second time works (no leaked/duplicated audio); switching away/clearing stops it.

## Risks / notes

- `std::fs::read(wav.path())` after STT: ensure it happens before the `wav` `NamedTempFile` drops (it's still in scope at that point in `stop_recording`). Don't move the read past the function's media cleanup.
- Memory: one WAV (a single read-aloud, seconds long) held in memory — negligible; replaced each recording.
- Mock/browser: `invoke("get_last_recording")` throws outside Tauri → caught → toast. The button still renders for layout/QA.

## Notes (TPM M2 / Q1)

- **Early-return staleness is acceptable, by design.** If a later recording errors before the copy (e.g. "Whisper not loaded", transcribe error), `last_recording_wav` keeps the previous WAV — but the replay control is gated on `feedback != null` (FeedbackPanel renders only then), and feedback is emitted only on the success path, so the stale WAV is never reachable via the UI. This matches the spec ("overwritten each recording; no explicit clear needed"). No clearing added this iteration.
- **Forward note:** when Iteration 3 introduces `clear_session_media()` (for `last_capture_png`), consider having it also drop `last_recording_wav` for hygiene (optional; not required by the gating argument).

## Out of scope

Thumbnail/lightbox (#4 — Iteration 3). No changes to the analysis pipeline or window chrome.
