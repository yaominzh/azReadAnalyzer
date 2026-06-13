# Screenshot Capture — Architecture

How the **Screenshot** button turns a region of your screen into editable text in the input panel. It's an end-to-end pipeline: button click → native macOS region capture → Vision OCR (sidecar) → text + thumbnail back in the UI.

## Flow

```mermaid
flowchart TD
    BTN["Screenshot button<br/>CaptureControls.tsx"] -->|invoke| CMD["capture_screenshot<br/>commands.rs"]

    CMD -->|1. hide window| HIDE["window.hide()"]
    HIDE --> CAP["capture_screen_region()<br/>capture.rs"]

    CAP -->|screencapture -i| SC{"PNG produced?<br/>(non-empty file)"}
    SC -->|no| PERM{"CGPreflightScreenCaptureAccess()<br/>permission granted?"}
    PERM -->|no| ERRPERM["Err: Screen recording<br/>permission denied<br/>+ CGRequestScreenCaptureAccess()"]
    PERM -->|yes| ERRCANCEL["Err: Screenshot cancelled"]

    SC -->|yes| OCR["call_ocr_sidecar()<br/>POST :8124/ocr"]
    OCR --> VISION["ocr_service/server.py<br/>macOS Vision (Accurate)"]
    VISION -->|{ text }| READPNG["read PNG bytes →<br/>AppState.last_capture_png"]

    READPNG --> SHOW["window.show() + focus<br/>(always, even on error)"]
    ERRPERM --> SHOW
    ERRCANCEL --> SHOW

    SHOW --> EMIT["emit 'text-captured'<br/>{ text, hasImage }"]
    EMIT --> LISTEN["useTauriEvents.ts listener"]
    LISTEN --> SETTEXT["setInputText(text)<br/>→ input panel"]
    LISTEN -->|hasImage| THUMB["loadCaptureImage()<br/>get_capture_image → object URL<br/>→ CaptureThumbnail / Lightbox"]

    ERRPERM -.->|rejected invoke| TOAST["error toast in UI<br/>(permission / generic)"]
    ERRCANCEL -.->|rejected invoke| SILENT["silent (expected cancel)"]
```

## Step by step

### 1. The trigger (frontend)

The **Screenshot** button in [`CaptureControls.tsx:12-30`](../../src/components/CaptureControls.tsx#L12-L30) just fires the command:

```ts
await invoke("capture_screenshot");
```

It does **no** state updates itself — the result arrives via an event (see step 5). Its real job is **error classification**: a silent user-cancel (`"Screenshot cancelled"` → do nothing), a permission denial (→ actionable toast pointing to System Settings), or anything else (→ generic error toast).

### 2. The orchestrator (Rust command)

[`capture_screenshot`](../../src-tauri/src/commands.rs#L79-L113) in `commands.rs` coordinates everything:

1. **Hides the app window** ([commands.rs:87-89](../../src-tauri/src/commands.rs#L87-L89)) so it isn't captured and doesn't block the region you're selecting.
2. Runs capture + OCR inside an `async` block, then **always restores the window** afterward ([commands.rs:102-105](../../src-tauri/src/commands.rs#L102-L105)) — even on error, so you never get stuck with a hidden window.
3. Reads the PNG bytes *before* the temp file drops ([commands.rs:97](../../src-tauri/src/commands.rs#L97)) and stashes them in `AppState.last_capture_png` for the thumbnail.
4. **Emits the `text-captured` event** ([commands.rs:111](../../src-tauri/src/commands.rs#L111)) with the recognized text and `hasImage: true`.

### 3. Native capture + the permission disambiguation

[`capture_screen_region`](../../src-tauri/src/capture.rs#L17-L54) in `capture.rs`:

- Creates a **unique temp PNG** via `tempfile` ([capture.rs:20-24](../../src-tauri/src/capture.rs#L20-L24)) — auto-deleted when the handle drops (no fixed `/tmp/az_capture.png`).
- Shells out to macOS's built-in **`screencapture -i`** ([capture.rs:29-32](../../src-tauri/src/capture.rs#L29-L32)) — `-i` is the interactive crosshair/region selector.

**The subtle problem it solves:** `screencapture -i` produces an **empty file** both when you *cancel* AND when the app *lacks Screen Recording permission* — indistinguishable by exit code or file size alone. So on the failure path ([capture.rs:38-51](../../src-tauri/src/capture.rs#L38-L51)) it calls two CoreGraphics APIs declared at [capture.rs:10-15](../../src-tauri/src/capture.rs#L10-L15):

- `CGPreflightScreenCaptureAccess()` — is permission actually granted?
- `CGRequestScreenCaptureAccess()` — triggers the OS prompt / adds the app to the Screen Recording list for next launch.

That lets the UI show an actionable "enable Screen Recording" toast instead of silently swallowing the failure (bugfix `e0ef118`).

### 4. The OCR sidecar

[`call_ocr_sidecar`](../../src-tauri/src/capture.rs#L56-L72) POSTs the image path to `http://127.0.0.1:8124/ocr`. The sidecar [`ocr_service/server.py`](../../ocr_service/server.py) runs **macOS Vision** (`VNRecognizeTextRequest`):

- **Accurate** recognition level ([server.py:24](../../ocr_service/server.py#L24)) — `Fast` produced "character soup" on small UI text (bugfix `6e6b2fa`).
- Language correction on, `en-US`; joins recognized lines with newlines; returns `{"text": "..."}`.

### 5. Back to the UI

The event listener in [`useTauriEvents.ts:25-29`](../../src/hooks/useTauriEvents.ts#L25-L29) receives `text-captured` and:

- `setInputText(text)` → the OCR'd text fills the input panel.
- if `hasImage`, calls [`loadCaptureImage`](../../src/lib/loadCaptureImage.ts) → invokes `get_capture_image` ([commands.rs:194](../../src-tauri/src/commands.rs#L194)) to pull the PNG bytes back as an `ArrayBuffer`, wraps them in an object URL, hands it to the store → [`CaptureThumbnail`](../../src/components/CaptureThumbnail.tsx) + [`Lightbox`](../../src/components/Lightbox.tsx) show the preview.

## Why event-driven instead of a return value?

`capture_screenshot` returns `Result<(), String>` — the *text* comes back through an emitted event, not the return value. This is intentional: the same `text-captured` event is **also** emitted by the clipboard-paste path, so both capture methods funnel through one UI listener. Clipboard paste, by contrast, returns its result directly ([CaptureControls.tsx:32-43](../../src/components/CaptureControls.tsx#L32-L43)) — a small asymmetry, but it works because paste needs no window-hiding dance.

## Key files

| File | Role |
|------|------|
| [`src/components/CaptureControls.tsx`](../../src/components/CaptureControls.tsx) | Screenshot button + error classification |
| [`src-tauri/src/commands.rs`](../../src-tauri/src/commands.rs) (`capture_screenshot`) | Orchestrator: hide → capture → OCR → show → emit |
| [`src-tauri/src/capture.rs`](../../src-tauri/src/capture.rs) | `screencapture -i`, permission preflight, OCR call |
| [`ocr_service/server.py`](../../ocr_service/server.py) | macOS Vision OCR sidecar (`:8124`) |
| [`src/hooks/useTauriEvents.ts`](../../src/hooks/useTauriEvents.ts) | Listens for `text-captured` → store |
| [`src/lib/loadCaptureImage.ts`](../../src/lib/loadCaptureImage.ts) | Pulls PNG bytes for the thumbnail |
