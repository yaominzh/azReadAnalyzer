# azReadAnalyzer — UI/UX Feedback Round 1

**Date:** 2026-06-09
**Status:** Approved
**Branch:** `260609-bugfix`
**Type:** Bug fix (#1) + UX enhancements (#2–#4) from live testing of the MVP.
**Builds on:** [2026-06-07-azreadanalyzer-design.md](2026-06-07-azreadanalyzer-design.md), [2026-06-08-azreadanalyzer-tierb-hardening.md](2026-06-08-azreadanalyzer-tierb-hardening.md)

---

## Overview

Four items from the first hands-on test of the running app:

1. **Window controls are broken (bug).** The window can't be closed, dragged, or resized.
2. **Frosted/transparent glass UI** matching azVoiceAssist.
3. **Replay your own recording** — hear back what you read.
4. **Image thumbnail + click-to-enlarge** (ChatGPT-style) for captured images — covering **both** screenshot captures and pasted clipboard images.

All four ship together on `260609-bugfix`. Item #1 is the only true bug and the most urgent (the window is currently hard to quit). #2–#4 are enhancements.

---

## Shared architecture decisions

- **Binary → frontend transfer** reuses the existing Tier-B B1 pattern: Rust commands return `tauri::ipc::Response` (raw bytes); the frontend wraps the resulting `ArrayBuffer` in a `Blob` + object URL. Used for replay audio (#3) and thumbnail image (#4) — no base64 bloat.
- **Session-scoped Rust state**: `AppState` gains
  - `last_recording_wav: Mutex<Option<Vec<u8>>>`
  - `last_capture_png: Mutex<Option<Vec<u8>>>`

  Both are in-memory only, replaced on each new recording/capture, and dropped when the app quits. No new files persist beyond the existing auto-deleted temp files. Stays 100% on-device.
- **New Rust dependency**: `image` crate (PNG encoding) — needed to turn clipboard RGBA into a PNG for OCR + thumbnail. The screenshot path is already PNG and needs no encoding.

---

## #1 — Window controls (bug fix)

Keep `decorations: false` and the custom macOS-style frosted titlebar (the look #2 will enhance). Root cause: the traffic-light dots are decorative `<div>`s, and dragging relied on `-webkit-app-region: drag` CSS that doesn't work reliably in Tauri.

**Changes**
- Add `data-tauri-drag-region` to the titlebar container; remove the `-webkit-app-region` reliance. Interactive children (toggle, buttons) must not inherit drag and must stop propagation so their clicks register.
- Wire the three dots via `@tauri-apps/api/window` `getCurrentWindow()`:
  - red → `close()`
  - amber → `minimize()`
  - green → `toggleMaximize()`
  - Add macOS-style hover glyphs (×, −, +) for affordance.
- Capabilities (`src-tauri/capabilities/default.json`): add `core:window:allow-close`, `core:window:allow-minimize`, `core:window:allow-maximize`, `core:window:allow-unmaximize`, `core:window:allow-start-dragging`.
- Edge-resize: `resizable: true` + decorationless should already allow dragging window edges; **verify live**. If macOS does not expose resize edges on a transparent decorationless window, add a thin CSS resize affordance — decide only if the live check fails.

**Verification:** live — click each dot (close/min/zoom), drag the titlebar, drag an edge to resize.

---

## #2 — Frosted/transparent glass (azVoiceAssist parity)

azVoiceAssist achieves its frost with `transparent: true` + `macOSPrivateApi: true` and CSS `backdrop-blur` over a non-opaque body — **no** vibrancy crate. Replicate exactly.

**Changes**
- `src-tauri/tauri.conf.json`: window `transparent: true`; add `app.macOSPrivateApi: true`.
- `src-tauri/Cargo.toml`: add `macos-private-api` to the `tauri` features.
- `src/index.css`: body background becomes transparent. The root app container becomes a **rounded translucent card** — `border-radius`, `overflow: hidden`, a hairline border, and `backdrop-blur` — so the desktop shows through the frost. Panels keep their existing `backdrop-blur` layering. Full azVoiceAssist-style translucency (user-selected over the safer near-opaque option).

**Risk:** text contrast can drop over busy/light wallpapers — accepted by the user for fidelity. **Requires an app restart to verify** (config-level change), so it's validated live, not by unit test.

---

## #3 — Replay your reading

Today the recording WAV (`NamedTempFile`) is deleted immediately after transcription, so there's nothing to replay.

**Changes**
- `stop_recording`: after writing the WAV temp file and before it drops, read its bytes into `last_recording_wav`. Transcription is unchanged; we just keep a copy for the session.
- New command `get_last_recording() -> Result<tauri::ipc::Response, String>` returning the stored WAV bytes (error/empty when none).
- Frontend: a **"▶ Your reading"** control in the Feedback panel (which renders after analysis), so the user can compare against the reference TTS "Listen" control at the top of the Practice panel. Plays via HTML5 `Audio` (same mechanism as `PlaybackControls`). Hidden until a recording exists; replaced on each new recording.

**Verification:** Rust unit — `AppState` stores and replaces the last recording. Frontend — replay control enabled only when a recording exists. Live — record, then replay and hear it.

---

## #4 — Image thumbnail + lightbox (screenshot **and** clipboard image)

**Unified capture model:** any image source — a screenshot capture **or** a pasted clipboard image — produces (a) reading text via OCR and (b) a PNG stored in `last_capture_png`, surfaced as a clickable thumbnail. Plain clipboard **text** paste stays text-only (no thumbnail).

**Changes**
- `paste_clipboard` is upgraded: check clipboard **text** first → if present, return it (no image). If no text, try `get_image()` (arboard RGBA) → encode to PNG via the `image` crate → write to a unique temp PNG → OCR it → store the PNG in `last_capture_png`. Return shape changes from `String` to `{ text: String, hasImage: bool }`.
- `capture_screenshot`: in addition to OCR, read the screenshot PNG bytes into `last_capture_png` before the temp file drops.
- `text-captured` event payload gains `hasImage: bool`.
- New command `get_capture_image() -> Result<tauri::ipc::Response, String>` returning the stored PNG bytes.
- Frontend: when `hasImage` is true, fetch the PNG via `get_capture_image()`, build an object URL, and render a **thumbnail chip on the Text Input panel**. Click → **full-size lightbox overlay** (dismiss on click or Esc) — the ChatGPT pattern.
- **Clear / New Text** clears the thumbnail and drops `last_capture_png` in Rust.

**Verification:** Rust unit — clipboard RGBA → PNG encode roundtrip; `AppState` stores/replaces the capture PNG. Frontend — thumbnail renders only when `hasImage`; lightbox opens/closes. Live — screenshot and paste-image both show a thumbnail; click enlarges.

---

## Error handling

| Scenario | Handling |
|----------|----------|
| Clipboard has neither text nor image | Existing toast: "No text in clipboard" |
| Clipboard image decode/encode/OCR fails | Toast; no thumbnail; input text unchanged |
| `get_last_recording` / `get_capture_image` with nothing stored | Control hidden/disabled; no error surfaced |
| Window-control permission missing | Caught at build (capabilities); verified live |

---

## Out of scope

- Multiple simultaneous thumbnails / image history (one current capture at a time).
- Editing or re-OCR of a thumbnail after capture.
- Persisting recordings or images across app restarts (session-only, on-device).
- Windows/Linux window-chrome behavior (macOS only, unchanged from v1).

---

## File touch list (anticipated)

- `src-tauri/tauri.conf.json` — transparent + macOSPrivateApi (#2).
- `src-tauri/Cargo.toml` — `macos-private-api` feature, `image` crate (#2, #4).
- `src-tauri/capabilities/default.json` — window control permissions (#1).
- `src-tauri/src/commands.rs` — `AppState` fields; `paste_clipboard` reshape; `get_last_recording`, `get_capture_image`; `stop_recording` keeps WAV; `capture_screenshot` keeps PNG (#1 none) (#3, #4).
- `src-tauri/src/clipboard.rs` — image read + PNG encode (#4).
- `src-tauri/src/events.rs` — `text-captured` gains `hasImage` (#4).
- `src/App.tsx` — functional titlebar + drag region (#1); rounded translucent root (#2).
- `src/index.css` — transparent body + frosted card (#2).
- `src/components/TextInputPanel.tsx` / new thumbnail + lightbox component (#4).
- `src/components/FeedbackPanel.tsx` (or RecordingPanel) — replay control (#3).
- `src/types/index.ts`, `src/hooks/*`, mock — new payload fields + mock sample image/recording.
