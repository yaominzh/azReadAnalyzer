# Third-Party Review: azReadAnalyzer — UI/UX Feedback Round 1

**Date:** 2026-06-09  
**Reviewer:** Codex  
**Spec reviewed:** `docs/superpowers/specs/2026-06-09-ui-feedback-round1-design.md`  
**Reviewed against:** current MVP source, `2026-06-07-azreadanalyzer-design.md`, and `2026-06-08-azreadanalyzer-tierb-hardening.md`  

---

## Summary

The proposal is aligned with the app's established architecture: binary media transfer via
`tauri::ipc::Response`, session-only media state, frontend-owned playback, and macOS-only
window chrome are all consistent with prior specs.

The main issues are not architectural. They are contract and lifecycle gaps that could lead
to stale media being shown, new IPC commands not being registered, or the titlebar controls
failing due to missing permissions.

---

## Findings

### 1. Stale capture image state is underspecified

**Severity:** High  
**Location:** spec lines 85-90

The spec says **Clear / New Text** clears the thumbnail and drops `last_capture_png` in Rust,
but it does not define a command to do this. Current clear paths are frontend-only:

- `src/components/CaptureControls.tsx` clears `inputText` and feedback only.
- `src/components/FeedbackPanel.tsx` clears feedback and text only.

This creates two stale-state paths:

1. The frontend clears the visible thumbnail, but `get_capture_image` can still return the
   previous Rust-side PNG.
2. `paste_clipboard` takes the text branch after a previous image capture, returning
   `{ text, hasImage: false }` while `last_capture_png` still contains the old image.

**Recommendation:** Add an explicit Rust command such as `clear_capture_image` or
`clear_session_media`, register it in `lib.rs`, and call it from Clear/New Text. Also clear
`last_capture_png` when `paste_clipboard` returns text-only and when capture/OCR fails.

### 2. New commands/state require `lib.rs`, but the touch list omits it

**Severity:** High  
**Location:** spec lines 27-31, 73, 88, 116-128

The spec adds:

- `last_recording_wav: Mutex<Option<Vec<u8>>>`
- `last_capture_png: Mutex<Option<Vec<u8>>>`
- `get_last_recording`
- `get_capture_image`

Current `AppState` construction and command registration live in `src-tauri/src/lib.rs`.
Without updating that file, the new fields will not be initialized and the new commands will
not be exposed to the frontend.

**Recommendation:** Add `src-tauri/src/lib.rs` to the file touch list and explicitly call out
both required edits: initialize the new `AppState` fields and add the new commands to
`tauri::generate_handler!`.

### 3. `toggleMaximize()` permission list is incomplete

**Severity:** Medium  
**Location:** spec lines 42-48

The green traffic-light control is specified as `toggleMaximize()`, but the capability list
names:

- `core:window:allow-maximize`
- `core:window:allow-unmaximize`

It does not name the exact permission for the chosen API:

- `core:window:allow-toggle-maximize`

This may be masked by broader defaults today, but the spec should list the permission that
matches the API it requires.

**Recommendation:** Add `core:window:allow-toggle-maximize`. Keep `allow-maximize` and
`allow-unmaximize` only if the implementation will call those APIs directly.

### 4. Clipboard precedence can defeat image paste

**Severity:** Medium  
**Location:** spec lines 82-85

The spec says `paste_clipboard` should check clipboard text first and return it if present.
That can prevent image thumbnails from appearing when the clipboard contains both an image
flavor and a text flavor, which is common in some copy paths.

This conflicts with the stated outcome that pasted clipboard images should produce OCR text
and a thumbnail.

**Recommendation:** Define precedence for multi-format clipboard contents. If the feature is
"Paste image from clipboard," prefer image bytes when available; otherwise explicitly accept
the tradeoff that mixed image+text clipboards will be treated as text-only.

### 5. Object URL cleanup should be part of the contract

**Severity:** Low  
**Location:** spec lines 26, 74, 89

Replay audio and thumbnail images both use `Blob` object URLs. The spec does not require
`URL.revokeObjectURL` on replacement, clear, unmount, playback end, or failed playback.
Repeated captures and replays can leak memory if implementers miss this.

**Recommendation:** Add a short lifecycle note: every generated object URL must be revoked
when replaced, cleared, or when its owning component unmounts.

---

## Notes

- The glass/frost approach matches the azVoiceAssist precedent: `transparent: true`,
  `macOSPrivateApi: true`, `macos-private-api` Tauri feature, and CSS blur over a
  transparent body.
- The replay feature fits the existing Tier-B B1 binary transfer pattern and does not
  require persistent files.
- The `image` crate is a reasonable dependency for clipboard RGBA to PNG encoding. The
  implementation should preserve arboard's RGBA channel order when constructing the PNG.

---

## Verdict

Proceed after tightening the IPC and lifecycle details above. The spec's direction is sound,
but the implementation plan should not start until stale media clearing, command
registration, and exact window permissions are made explicit.
