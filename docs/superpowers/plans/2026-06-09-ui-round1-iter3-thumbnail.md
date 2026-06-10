# Iteration 3 Plan — Image Thumbnail + Lightbox (#4)

**Spec:** [2026-06-09-ui-feedback-round1-design.md](../specs/2026-06-09-ui-feedback-round1-design.md) goal #4, §#4 (+ review findings #1 stale-clear, #4 clipboard precedence, #5 object-URL, RGBA note)
**Branch:** `260609-bugfix`

**Goal:** any image source — a Screenshot capture **or** a pasted clipboard image — produces OCR reading text **and** a clickable thumbnail (click → full-size lightbox). Plain clipboard text stays text-only. Reuses Iteration 2's session-media + `ipc::Response` + object-URL patterns.

---

## Data-flow design (decouple display from fetch — important)

The thumbnail's image source differs between real and mock:
- **Real:** the PNG lives in Rust (`last_capture_png`). Frontend fetches it via `get_capture_image()` (raw bytes) → object URL.
- **Mock/browser:** `invoke` throws, so the mock sets a sample image URL directly.

So the **store owns `captureImageUrl: string | null`**; components only read it. A helper loads/sets it. The store action that sets a new URL revokes the previous one; clearing revokes + nulls (review #5).

---

## Task 1 — `image` crate + clipboard image read (Rust)

**Files:** `src-tauri/Cargo.toml`, `src-tauri/src/clipboard.rs`

- [ ] `Cargo.toml`: add `image = "0.25"` (default features ok; PNG encoder included).
- [ ] `clipboard.rs`: add `read_image_png() -> Result<Vec<u8>, String>`. **(TPM M2/M3 — exact, compiling code):**
  ```rust
  pub fn read_image_png() -> Result<Vec<u8>, String> {
      // arboard::ImageData<'static> { width: usize, height: usize, bytes: Cow<'static,[u8]> }, RGBA8 row-major.
      let img = arboard::Clipboard::new().map_err(|e| e.to_string())?
          .get_image().map_err(|e| format!("No image in clipboard: {e}"))?;
      // RGBA8 → image::RgbaImage is RGBA8: direct, no channel swap. from_raw returns Option (len = w*h*4).
      let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned())
          .ok_or("clipboard image size mismatch")?;
      let mut buf = std::io::Cursor::new(Vec::new());
      rgba.write_to(&mut buf, image::ImageFormat::Png).map_err(|e| e.to_string())?; // &mut writer
      Ok(buf.into_inner())
  }
  ```
- [ ] Keep existing `read_text()` unchanged.

## Task 2 — AppState + commands (Rust)

**Files:** `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/events.rs`

- [ ] `AppState`: add `pub last_capture_png: Mutex<Option<Vec<u8>>>`.
- [ ] `lib.rs`: init `last_capture_png: Mutex::new(None)` in `.manage(...)`; add `get_capture_image`, `clear_session_media` to `generate_handler!`. **(lib.rs MUST be edited — finding #2.)**
- [ ] `events.rs`: `TextCapturedPayload` gains `pub has_image: bool` with `#[serde(rename_all = "camelCase")]` → frontend sees `hasImage`. (Add the derive attr if not present.)
- [ ] `paste_clipboard` **reshape** → returns `{ text, has_image }` (a small `#[derive(Serialize)] #[serde(rename_all="camelCase")] struct PasteResult`):
  - **Text-first precedence (finding #4):** if `read_text()` yields non-empty text → store `*last_capture_png = None`, return `{ text, has_image: false }`.
  - Else try `read_image_png()` → on Ok: write to a unique temp PNG (tempfile) → `call_ocr_sidecar(path)` → store PNG in `last_capture_png` → return `{ text: ocr_text, has_image: true }`. On any failure: `*last_capture_png = None`, return the error (toast).
- [ ] `capture_screenshot`: after OCR succeeds, read the screenshot PNG bytes (`std::fs::read(temp.path())`) into `last_capture_png` **before** the temp file drops; emit `text-captured { text, has_image: true }`. On failure path, leave/clear as appropriate (cancel → no change).
- [ ] `get_capture_image() -> Result<tauri::ipc::Response, String>`: return stored PNG bytes (Err when None). Same pattern as `get_last_recording`.
- [ ] `clear_session_media() -> Result<(), String>`: set `*last_capture_png = None` **only**. **(TPM S6 — do NOT also clear `last_recording_wav`:** "New Text" calls this, and dropping the WAV would make the replay control vanish mid-session. Scope strictly to the capture image.)

## Task 3 — Frontend store + types

**Files:** `src/types/index.ts`, `src/store/useAppStore.ts`

- [ ] `types`: `TextCapturedPayload` gains `hasImage: boolean`. Add `PasteResult { text: string; hasImage: boolean }`.
- [ ] `store`: add `captureImageUrl: string | null` (init null). Actions:
  - `setCaptureImageUrl(url)`: revoke any existing `captureImageUrl` first, then set (review #5).
  - `clearCaptureImage()`: revoke existing, set null.
  - Both live in the store so the URL has one owner.

## Task 4 — Frontend: load + thumbnail + lightbox

**Files:** `src/hooks/useTauriEvents.ts`, `src/hooks/useMockEvents.ts`, `src/components/CaptureControls.tsx`, `src/components/TextInputPanel.tsx` (or a new `CaptureThumbnail.tsx`), new `src/components/Lightbox.tsx`, `src/App.tsx`

- [ ] **Load helper** (e.g. in a small module or inside the hook): `async function loadCaptureImage()` → `invoke<ArrayBuffer>("get_capture_image")` → object URL → `store.setCaptureImageUrl(url)`; catch → toast.
- [ ] `useTauriEvents`: in the `text-captured` handler, if `e.payload.hasImage` → call `loadCaptureImage()`, else `store.clearCaptureImage()`.
- [ ] `CaptureControls.handlePaste`: `const r = await invoke<PasteResult>("paste_clipboard")` → `setInputText(r.text)`; if `r.hasImage` → `loadCaptureImage()` else `clearCaptureImage()`.
- [ ] `CaptureControls.handleClear` and FeedbackPanel "New Text": also `invoke("clear_session_media").catch(()=>{})` and `store.clearCaptureImage()`.
- [ ] **Thumbnail** (in/below TextInputPanel): when `captureImageUrl` is set, render a small ~`h-16` rounded image chip with a subtle border; `onClick` opens the lightbox.
- [ ] **Lightbox** (`Lightbox.tsx`): **(TPM Q1)** render via `ReactDOM.createPortal(..., document.body)` — the App root has `backdrop-blur` (a `backdrop-filter`), which establishes a containing block AND `overflow-hidden` + `rounded-xl`, so a fixed overlay rendered *inside* the root would be clipped. Portal to `document.body` to cover the window edge-to-edge. `fixed inset-0 z-50` dark backdrop, centered image (`max-w-[90vw] max-h-[90vh]`). Dismiss on backdrop click or **Esc**. **(TPM Q2)** backdrop `onClick=close`; image `onClick={e => e.stopPropagation()}` so clicking the image doesn't close; `useEffect` adds the keydown listener and **removes it on unmount**.
- [ ] **Manual textarea edits (TPM S3 — decided):** editing the OCR text in the textarea does NOT clear the thumbnail. The thumbnail represents the captured *image source*; users routinely correct OCR text, and the image attachment should persist (matches ChatGPT). Scoped-out, documented — no `onChange` clearing.
- [ ] **Re-record / handleRecord (TPM S2):** deliberately RETAIN `captureImageUrl` + `last_capture_png` (same passage re-read). Only Clear / New Text clear them.
- [ ] **Mock:** `useMockEvents` sets `captureImageUrl` to a tiny inline sample (a data URL) so the thumbnail + lightbox are exercisable in mock mode without Rust. (Note: mock has no paste/clear simulation, so the text-only-paste stale-clear path is live-verify only — TPM S1.)

## Task 5 — Tests

**Files:** `src/test-setup.ts`, `src/components/__tests__/` (+ store test)

- [ ] **(TPM M1 — required first):** jsdom 29 does NOT implement `URL.createObjectURL`/`URL.revokeObjectURL` (both `undefined`) — the store actions call `revokeObjectURL` and would throw `TypeError`. Add stubs to `src/test-setup.ts`:
  ```ts
  import { vi } from "vitest";
  if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => "blob:mock");
  if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();
  ```
- [ ] Store test: `setCaptureImageUrl` replaces+is set; `clearCaptureImage` nulls (revoke is the stubbed `vi.fn`).
- [ ] Thumbnail test: renders an `<img>` when `captureImageUrl` set; nothing when null. Clicking opens the lightbox (lightbox visible). Esc / backdrop click closes it.
- [ ] Existing suite stays green.

## Verification

- [ ] `cd src-tauri && cargo check` clean (image crate, new fields/commands, paste reshape, events payload).
- [ ] `npx tsc -b`, `npx eslint .` clean. `npx vitest run` all pass incl. new tests.
- [ ] **Live** (`npx tauri dev`): (a) Screenshot a region of text → text populates AND a thumbnail appears → click → lightbox shows the screenshot → Esc closes. (b) Copy an image (e.g. ⌘⌃⇧4 to clipboard) → Paste → OCR text + thumbnail. (c) Copy plain text → Paste → text only, no thumbnail. (d) Clear / New Text → thumbnail gone, and a subsequent text-only paste shows no stale thumbnail.

## Risks / notes

- **arboard `get_image` availability:** confirm arboard 3 exposes `get_image()` on macOS (it does). If clipboard has no image flavor it returns Err → handled as text-first already.
- **RGBA channel order (review note):** arboard gives RGBA8; `image::RgbaImage` is RGBA8 — direct, no swap.
- **`paste_clipboard` return type change** is a breaking IPC contract change; update the single caller (`CaptureControls`) and its test in lockstep.
- **Stale media (finding #1):** every text-only paste, clear, and capture failure must null `last_capture_png` (Rust) and the frontend `captureImageUrl` — enumerated above; QA should grep for any path that sets text without resolving the image state.
- **Object URLs (#5):** store is the single owner; revoke on replace/clear. Lightbox uses the same `captureImageUrl` (no second URL).

## Out of scope

Image history / multiple thumbnails; editing; cross-restart persistence (all per spec Out of Scope).
