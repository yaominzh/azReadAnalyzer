# azReadAnalyzer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a macOS Tauri 2 desktop app for English speaking practice — capture text via screenshot OCR or clipboard, TTS playback, self-recording, Whisper STT, and feedback on **content accuracy** (Rust-computed diff) + **fluency/pacing** (Rust-computed metrics from word timestamps) + **LLM coaching** (score + comments).

**Architecture:** Tauri 2 (Rust backend + React/TypeScript frontend). Two Python sidecars: `ocr_service` (Vision OCR on screenshots) and `tts_service` (Qwen3-TTS, reused from azVoiceAssist — synthesizes WAV only; playback is client-side via HTML5 Audio). Rust handles clipboard, audio recording, Whisper STT (with word timestamps), the deterministic content diff, and pacing-metric computation. The local LLM receives the diff + pacing metrics and returns a score + coaching comments only — it does NOT compute the diff. See the design spec's "Feedback Methodology & Research Basis" section for why v1 scopes to content accuracy + fluency/pacing (not phoneme-level pronunciation).

**Tech Stack:** Tauri 2.10.3 · React 19 · TypeScript 6 · Tailwind CSS v4 · Zustand 5 · Vite 8 · transcribe-rs 0.3.11 · cpal 0.16 · hound 3 · arboard 3 · similar 2 · reqwest 0.12 · Python FastAPI (sidecars)

---

## File Map

```
azReadAnalyzer/
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css
│   ├── test-setup.ts
│   ├── types/index.ts            ← all domain types + IPC payloads
│   ├── store/useAppStore.ts      ← single Zustand store
│   ├── hooks/
│   │   ├── useTauriEvents.ts     ← wires Tauri events → store
│   │   └── useMockEvents.ts      ← VITE_USE_MOCK=true mode
│   ├── components/
│   │   ├── TextInputPanel.tsx
│   │   ├── CaptureControls.tsx
│   │   ├── PlaybackControls.tsx
│   │   ├── RecordingPanel.tsx
│   │   └── FeedbackPanel.tsx
│   └── __mocks__/@tauri-apps/api/index.ts
├── src-tauri/src/
│   ├── main.rs
│   ├── lib.rs                    ← pub mod + run()
│   ├── commands.rs               ← all #[tauri::command] fns + AppState
│   ├── events.rs                 ← emit_* helpers + payload structs
│   ├── capture.rs                ← screenshot + OCR sidecar call
│   ├── clipboard.rs              ← arboard clipboard read
│   ├── audio.rs                  ← cpal mic recording + audio-level events
│   ├── stt.rs                    ← Whisper STT via transcribe-rs (text + word timestamps)
│   ├── diff.rs                   ← deterministic word-level diff via similar crate
│   ├── fluency.rs                ← pacing metrics from word timestamps
│   └── llm.rs                    ← LLM HTTP client (score + comments from diff + pacing)
├── src-tauri/
│   ├── Cargo.toml
│   ├── build.rs
│   └── tauri.conf.json
├── ocr_service/
│   ├── server.py
│   └── requirements.txt
├── tts_service/
│   ├── server.py
│   └── requirements.txt
├── index.html
├── vite.config.ts
├── package.json
├── tsconfig.json
├── tsconfig.app.json
├── tsconfig.node.json
└── CLAUDE.md
```

---

## Sub-project 1: App Shell

### Task 1: Frontend Scaffold

**Files:**
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `tsconfig.app.json`
- Create: `tsconfig.node.json`
- Create: `index.html`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "azreadanalyzer",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "tauri": "tauri",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint ."
  },
  "dependencies": {
    "@tauri-apps/api": "^2.10.1",
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "react-resizable-panels": "^4.10.0",
    "zustand": "^5.0.12"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.4",
    "@tailwindcss/vite": "^4.2.2",
    "@tauri-apps/cli": "^2.10.1",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.1",
    "@types/node": "^24.12.2",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.1",
    "eslint": "^9.39.4",
    "eslint-plugin-react-hooks": "^7.0.1",
    "eslint-plugin-react-refresh": "^0.5.2",
    "globals": "^17.4.0",
    "jsdom": "^29.0.2",
    "tailwindcss": "^4.2.2",
    "typescript": "~6.0.2",
    "typescript-eslint": "^8.58.0",
    "vite": "^8.0.4",
    "vitest": "^4.1.4"
  }
}
```

- [ ] **Step 2: Create `vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test-setup.ts",
  },
}));
```

- [ ] **Step 3: Create tsconfig files**

`tsconfig.json`:
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

`tsconfig.app.json`:
```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "es2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "types": ["vite/client"],
    "skipLibCheck": true,
    "strict": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

`tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "esnext",
    "skipLibCheck": true,
    "strict": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Create `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>azReadAnalyzer</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
src-tauri/target/
.DS_Store
*.log
/tmp/az_*.wav
/tmp/az_*.png
```

- [ ] **Step 6: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` populated, no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json index.html .gitignore
git commit -m "feat: frontend scaffold (Tauri 2 + React 19 + Tailwind v4)"
```

---

### Task 2: Tauri 2 Backend Scaffold

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/commands.rs`
- Create: `src-tauri/src/events.rs`

- [ ] **Step 1: Create `src-tauri/Cargo.toml`**

```toml
[package]
name = "app"
version = "0.1.0"
edition = "2021"
rust-version = "1.80.0"

[lib]
name = "app_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2.5.6", features = [] }

[dependencies]
tauri = { version = "2.10.3", features = [] }
tauri-plugin-log = "2"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
log = "0.4"
anyhow = "1.0"
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
reqwest = { version = "0.12", features = ["json"] }
dirs = "5"

# Audio
cpal = "0.16.0"
hound = "3"

# Clipboard
arboard = "3"

# Diff
similar = "2"

# STT
transcribe-rs = { version = "0.3.11", features = ["whisper-cpp"] }

# Unique temp files (screenshot PNG + recording WAV); auto-deleted on drop.
# In [dependencies] (not dev-only) because runtime code uses it.
tempfile = "3"

[target.'cfg(target_os = "macos")'.dependencies]
transcribe-rs = { version = "0.3.11", features = ["whisper-cpp", "whisper-metal"] }
```

- [ ] **Step 2: Create `src-tauri/build.rs`**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 3: Create `src-tauri/tauri.conf.json`**

```json
{
  "$schema": "../node_modules/@tauri-apps/cli/config.schema.json",
  "productName": "azReadAnalyzer",
  "version": "0.1.0",
  "identifier": "com.azreadanalyzer.app",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "azReadAnalyzer",
        "width": 1100,
        "height": 700,
        "minWidth": 700,
        "minHeight": 500,
        "resizable": true,
        "fullscreen": false,
        "decorations": false,
        "alwaysOnTop": true
      }
    ],
    "withGlobalTauri": true,
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

- [ ] **Step 4: Create `src-tauri/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_lib::run();
}
```

- [ ] **Step 5: Create `src-tauri/src/lib.rs`** (stub — expands as modules are added)

```rust
pub mod capture;
pub mod clipboard;
pub mod audio;
pub mod stt;
pub mod diff;
pub mod fluency;
pub mod llm;
mod commands;
mod events;

use commands::AppState;
use std::sync::{Arc, Mutex};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(AppState {
            recorder: Mutex::new(None),
            stt_engine: Mutex::new(None),
        }))
        .invoke_handler(tauri::generate_handler![
            commands::paste_clipboard,
            commands::capture_screenshot,
            commands::play_tts,
            commands::set_always_on_top,
            commands::start_recording,
            commands::stop_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 6: Create `src-tauri/src/events.rs`**

```rust
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct TextCapturedPayload {
    pub text: String,
}

#[derive(Serialize, Clone)]
pub struct AudioLevelPayload {
    pub level: f32,
}

#[derive(Serialize, Clone)]
pub struct RecordingStatePayload {
    pub state: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiffToken {
    pub text: String,
    #[serde(rename = "type")]
    pub token_type: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct LlmComment {
    pub icon: String,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PacingMetrics {
    pub words_per_minute: f32,
    pub articulation_rate: f32,
    pub pause_count: u32,
    pub total_pause_ms: u32,
    pub pause_ratio: f32,
    pub long_hesitations: u32,
}

#[derive(Serialize, Clone)]
pub struct FeedbackReadyPayload {
    // score is None when the LLM was unreachable — the UI then shows diff +
    // pacing (both computed locally in Rust) but suppresses the score ring and
    // comments, per spec ("transcription only, no score/comments").
    pub score: Option<u32>,
    pub transcription: String,
    pub diff: Vec<DiffToken>,
    pub pacing: PacingMetrics,
    pub comments: Vec<LlmComment>,
}

pub fn emit_text_captured(app: &AppHandle, text: String) {
    app.emit("text-captured", TextCapturedPayload { text }).ok();
}

pub fn emit_audio_level(app: &AppHandle, level: f32) {
    app.emit("audio-level", AudioLevelPayload { level }).ok();
}

pub fn emit_recording_state(app: &AppHandle, state: &str) {
    app.emit("recording-state", RecordingStatePayload { state: state.to_string() }).ok();
}

pub fn emit_feedback_ready(app: &AppHandle, payload: FeedbackReadyPayload) {
    app.emit("feedback-ready", payload).ok();
}
```

- [ ] **Step 7: Create `src-tauri/src/commands.rs`** (stub — grows through later tasks)

```rust
use std::sync::{Arc, Mutex};
use tauri::{command, AppHandle, State};

use crate::audio::Recorder;
use crate::stt::WhisperEngine;

pub struct AppState {
    pub recorder: Mutex<Option<Recorder>>,
    pub stt_engine: Mutex<Option<WhisperEngine>>,
}

// SAFETY: Recorder holds cpal::Stream which is not Send, but access is
// serialised through Mutex and only ever on one thread at a time.
unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

#[command]
pub fn paste_clipboard() -> Result<String, String> {
    crate::clipboard::read_text()
}

#[command]
pub async fn capture_screenshot(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let window = app.get_webview_window("main");

    // Hide our window so it isn't captured / doesn't block the target.
    if let Some(w) = &window {
        w.hide().ok();
    }

    // Run capture + OCR, always restoring the window afterward.
    let outcome = async {
        // `temp` is a NamedTempFile (unique path); dropped at end of this block → auto-deleted.
        let temp = crate::capture::capture_screen_region().await?;
        crate::capture::call_ocr_sidecar(temp.path()).await
    }
    .await;

    if let Some(w) = &window {
        w.show().ok();
        w.set_focus().ok();
    }

    let text = outcome?;
    crate::events::emit_text_captured(&app, text);
    Ok(())
}

#[command]
pub async fn play_tts(text: String) -> Result<Vec<u8>, String> {
    crate::capture::call_tts_sidecar(&text).await
}

#[command]
pub fn set_always_on_top(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        w.set_always_on_top(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub fn start_recording(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let mut rec = state.recorder.lock().map_err(|e| e.to_string())?;
    if rec.is_some() {
        return Err("Already recording".into());
    }
    *rec = Some(Recorder::start(app.clone())?);
    crate::events::emit_recording_state(&app, "recording");
    Ok(())
}

#[command]
pub async fn stop_recording(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    original_text: String,
) -> Result<(), String> {
    // `wav` is a NamedTempFile (unique path, auto-deleted when dropped at fn end).
    let wav = {
        let mut rec = state.recorder.lock().map_err(|e| e.to_string())?;
        let recorder = rec.take().ok_or("Not recording")?;
        recorder.stop()?
    };

    crate::events::emit_recording_state(&app, "analyzing");

    // Whisper returns text + word timestamps (see stt.rs / Task 14)
    let result = {
        let mut eng = state.stt_engine.lock().map_err(|e| e.to_string())?;
        let engine = eng.as_mut().ok_or("Whisper not loaded")?;
        engine.transcribe(wav.path())?
    };

    let diff = crate::diff::word_diff(&original_text, &result.text);
    let pacing = crate::fluency::compute_pacing(&result.words);

    // LLM is best-effort. If it's unreachable, score = None and comments = [];
    // the UI still shows the locally-computed diff + pacing.
    let (score, comments) =
        match crate::llm::get_feedback(&original_text, &result.text, &diff, &pacing).await {
            Ok((s, c)) => (Some(s), c),
            Err(e) => {
                log::warn!("LLM feedback unavailable: {e}");
                (None, vec![])
            }
        };

    crate::events::emit_feedback_ready(
        &app,
        crate::events::FeedbackReadyPayload {
            score,
            transcription: result.text,
            diff,
            pacing,
            comments,
        },
    );
    crate::events::emit_recording_state(&app, "idle");
    Ok(())
    // `wav` (a NamedTempFile) drops here → recording file auto-deleted.
}
```

- [ ] **Step 8: Create stub modules so the project compiles**

Create `src-tauri/src/capture.rs`:
```rust
use std::path::Path;
use tempfile::NamedTempFile;
// Returns a NamedTempFile (unique path, auto-deleted on drop) holding the screenshot PNG.
pub async fn capture_screen_region() -> Result<NamedTempFile, String> { todo!() }
pub async fn call_ocr_sidecar(_path: &Path) -> Result<String, String> { todo!() }
pub async fn call_tts_sidecar(_text: &str) -> Result<Vec<u8>, String> { todo!() }
```

Create `src-tauri/src/clipboard.rs`:
```rust
pub fn read_text() -> Result<String, String> { todo!() }
```

Create `src-tauri/src/audio.rs`:
```rust
use tauri::AppHandle;
use tempfile::NamedTempFile;
pub struct Recorder;
impl Recorder {
    pub fn start(_app: AppHandle) -> Result<Self, String> { todo!() }
    // Returns a NamedTempFile (unique path, auto-deleted on drop) holding the recording WAV.
    pub fn stop(self) -> Result<NamedTempFile, String> { todo!() }
}
```

Create `src-tauri/src/stt.rs`:
```rust
use std::path::Path;

/// One transcribed word with its timing, used for pacing analysis.
pub struct WordTimestamp {
    pub word: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Full STT result: text plus per-word timestamps.
pub struct Transcription {
    pub text: String,
    pub words: Vec<WordTimestamp>,
}

pub struct WhisperEngine;
impl WhisperEngine {
    pub fn transcribe(&mut self, _path: &Path) -> Result<Transcription, String> { todo!() }
}
```

Create `src-tauri/src/diff.rs`:
```rust
use crate::events::DiffToken;
pub fn word_diff(_original: &str, _transcription: &str) -> Vec<DiffToken> { vec![] }
```

Create `src-tauri/src/fluency.rs`:
```rust
use crate::events::PacingMetrics;
use crate::stt::WordTimestamp;
pub fn compute_pacing(_words: &[WordTimestamp]) -> PacingMetrics { PacingMetrics::default() }
```

Create `src-tauri/src/llm.rs`:
```rust
use crate::events::{DiffToken, LlmComment, PacingMetrics};
pub async fn get_feedback(
    _original: &str,
    _transcription: &str,
    _diff: &[DiffToken],
    _pacing: &PacingMetrics,
) -> Result<(u32, Vec<LlmComment>), String> {
    Ok((0, vec![]))
}
```

- [ ] **Step 9: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```

Expected: compiles with warnings (unused stubs), no errors. If there are linker errors related to transcribe-rs, ensure Xcode CLI Tools are installed: `xcode-select --install`.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/
git commit -m "feat: Tauri 2 backend scaffold with stub modules"
```

---

### Task 3: App Shell UI

**Files:**
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `src/index.css`
- Create: `src/test-setup.ts`

- [ ] **Step 1: Create `src/test-setup.ts`**

```typescript
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 2: Create `src/index.css`** (azVoiceAssist dark theme + Tailwind v4)

```css
@import "tailwindcss";

@theme {
  --color-az-bg: #080808;
  --color-az-panel: rgba(255, 255, 255, 0.04);
  --color-az-border: rgba(255, 255, 255, 0.08);
  --color-az-accent: #6366f1;
  --color-az-accent-light: #818cf8;
  --font-family-sans: 'Inter', system-ui, sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  background: #080808;
  color: #e8e8e8;
  font-family: var(--font-family-sans);
  margin: 0;
  overflow: hidden;
  height: 100vh;
  user-select: none;
}

textarea, input {
  user-select: text;
}

::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

.titlebar {
  -webkit-app-region: drag;
}
button, select, input, textarea, a {
  -webkit-app-region: no-drag;
}
```

- [ ] **Step 3: Create `src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 4: Create `src/App.tsx`** (shell with two-panel layout + custom titlebar)

```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";

export default function App() {
  // Window starts always-on-top (tauri.conf.json alwaysOnTop: true); toggle flips it.
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);

  function toggleAlwaysOnTop() {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    invoke("set_always_on_top", { enabled: next }).catch(() => {});
  }

  return (
    <div className="flex flex-col h-screen bg-[#080808]">
      {/* Custom titlebar */}
      <div className="titlebar flex items-center justify-between px-4 h-10 bg-black/60 border-b border-white/[0.07] flex-shrink-0">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <div className="w-3 h-3 rounded-full bg-[#28c840]" />
        </div>
        <span className="text-[13px] font-medium text-white/40 tracking-wider">
          azReadAnalyzer
        </span>
        <button
          onClick={toggleAlwaysOnTop}
          className="flex items-center gap-2 text-[11px] text-white/30 hover:text-white/60 transition-colors"
        >
          <span>Always on top</span>
          <div className={`w-7 h-4 rounded-full relative transition-colors ${alwaysOnTop ? "bg-[#6366f1]/50" : "bg-white/10"}`}>
            <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${alwaysOnTop ? "left-3.5" : "left-0.5"}`} />
          </div>
        </button>
      </div>

      {/* Two-panel body */}
      <div className="flex-1 p-3 overflow-hidden">
        <PanelGroup direction="horizontal" className="gap-2.5 h-full">
          <Panel defaultSize={50} minSize={30}>
            <div className="h-full rounded-xl bg-white/[0.04] border border-white/[0.08] flex flex-col">
              <p className="px-3.5 py-2.5 text-[10px] font-semibold tracking-widest uppercase text-white/30 border-b border-white/[0.06]">
                Text Input
              </p>
              <div className="flex-1 p-4 text-white/70 text-sm">
                {/* TextInputPanel + CaptureControls go here */}
              </div>
            </div>
          </Panel>
          <PanelResizeHandle className="w-1.5 rounded-full bg-white/[0.04] hover:bg-white/10 transition-colors" />
          <Panel defaultSize={50} minSize={30}>
            <div className="h-full rounded-xl bg-white/[0.04] border border-white/[0.08] flex flex-col overflow-y-auto">
              <p className="px-3.5 py-2.5 text-[10px] font-semibold tracking-widest uppercase text-white/30 border-b border-white/[0.06]">
                Practice
              </p>
              <div className="p-4 text-white/70 text-sm">
                {/* PlaybackControls + RecordingPanel + FeedbackPanel go here */}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Verify dev server runs**

```bash
npx tauri dev
```

Expected: window opens with dark two-panel layout, traffic lights, "azReadAnalyzer" title. No errors in console.

If `npx tauri dev` fails due to missing Whisper model (Rust won't fail yet — stubs just todo!()), the frontend should still render.

- [ ] **Step 6: Commit**

```bash
git add src/
git commit -m "feat: app shell with dark two-panel layout and azVoiceAssist theme"
```

---

### Task 4: Types + Zustand Store + Mock Mode

**Files:**
- Create: `src/types/index.ts`
- Create: `src/store/useAppStore.ts`
- Create: `src/hooks/useTauriEvents.ts`
- Create: `src/hooks/useMockEvents.ts`
- Create: `src/__mocks__/@tauri-apps/api/index.ts`

- [ ] **Step 1: Write types test**

Create `src/store/__tests__/useAppStore.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../useAppStore";

const ZERO_PACING = {
  wordsPerMinute: 0, articulationRate: 0, pauseCount: 0,
  totalPauseMs: 0, pauseRatio: 0, longHesitations: 0,
};

describe("useAppStore", () => {
  beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

  it("starts with idle recording state", () => {
    expect(useAppStore.getState().recordingState).toBe("idle");
  });

  it("setInputText updates text", () => {
    useAppStore.getState().setInputText("hello world");
    expect(useAppStore.getState().inputText).toBe("hello world");
  });

  it("setFeedback stores feedback result", () => {
    const fb = { score: 85, transcription: "hello", diff: [], pacing: ZERO_PACING, comments: [] };
    useAppStore.getState().setFeedback(fb);
    expect(useAppStore.getState().feedback?.score).toBe(85);
  });

  it("clearFeedback resets feedback to null", () => {
    useAppStore.getState().setFeedback({ score: 85, transcription: "x", diff: [], pacing: ZERO_PACING, comments: [] });
    useAppStore.getState().clearFeedback();
    expect(useAppStore.getState().feedback).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run src/store/__tests__/useAppStore.test.ts
```

Expected: FAIL — `useAppStore` not found.

- [ ] **Step 3: Create `src/types/index.ts`**

```typescript
// Recording state
export type RecordingState = "idle" | "recording" | "analyzing";

// TTS state
export type TtsState = "idle" | "playing";

// Diff token from Rust word-level diff
export interface DiffToken {
  text: string;
  type: "correct" | "missed" | "added";
}

// LLM coaching comment
export interface LlmComment {
  icon: string;
  text: string;
}

// Pacing metrics computed in Rust (fluency.rs) from word timestamps.
// Field names are camelCase to match Rust's #[serde(rename_all = "camelCase")].
export interface PacingMetrics {
  wordsPerMinute: number;
  articulationRate: number;
  pauseCount: number;
  totalPauseMs: number;
  pauseRatio: number;
  longHesitations: number;
}

// Full feedback result
export interface FeedbackResult {
  score: number | null;   // null when the LLM was unreachable (diff + pacing still shown)
  transcription: string;
  diff: DiffToken[];
  pacing: PacingMetrics;
  comments: LlmComment[];
}

// Tauri IPC event payloads
export interface TextCapturedPayload {
  text: string;
}

export interface AudioLevelPayload {
  level: number;
}

export interface RecordingStatePayload {
  state: RecordingState;
}

export interface FeedbackReadyPayload {
  score: number | null;   // null = LLM unreachable (Rust sends None)
  transcription: string;
  diff: DiffToken[];
  pacing: PacingMetrics;
  comments: LlmComment[];
}

// Toast notification
export interface Toast {
  id: string;
  message: string;
  type: "error" | "info";
}
```

- [ ] **Step 4: Create `src/store/useAppStore.ts`**

```typescript
import { create } from "zustand";
import type { RecordingState, TtsState, FeedbackResult, Toast } from "../types";

interface AppStore {
  // Text
  inputText: string;
  // TTS
  ttsState: TtsState;
  ttsSpeed: number;
  // Recording
  recordingState: RecordingState;
  audioLevel: number;
  recordingTimer: number;
  // Feedback
  feedback: FeedbackResult | null;
  // Toasts
  toasts: Toast[];

  // Actions
  setInputText(text: string): void;
  setTtsState(state: TtsState): void;
  setTtsSpeed(speed: number): void;
  setRecordingState(state: RecordingState): void;
  setAudioLevel(level: number): void;
  setRecordingTimer(seconds: number): void;
  setFeedback(result: FeedbackResult): void;
  clearFeedback(): void;
  addToast(message: string, type: "error" | "info"): void;
  removeToast(id: string): void;
}

const INITIAL_STATE = {
  inputText: "",
  ttsState: "idle" as TtsState,
  ttsSpeed: 1.0,
  recordingState: "idle" as RecordingState,
  audioLevel: 0,
  recordingTimer: 0,
  feedback: null,
  toasts: [],
};

export const useAppStore = create<AppStore>()((set) => ({
  ...INITIAL_STATE,

  setInputText: (text) => set({ inputText: text }),
  setTtsState: (ttsState) => set({ ttsState }),
  setTtsSpeed: (ttsSpeed) => set({ ttsSpeed }),
  setRecordingState: (recordingState) => set({ recordingState }),
  setAudioLevel: (audioLevel) => set({ audioLevel }),
  setRecordingTimer: (recordingTimer) => set({ recordingTimer }),
  setFeedback: (feedback) => set({ feedback }),
  clearFeedback: () => set({ feedback: null }),
  addToast: (message, type) =>
    set((s) => ({
      toasts: [...s.toasts, { id: crypto.randomUUID(), message, type }],
    })),
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// Expose initial state for test resets
(useAppStore as any).getInitialState = () => INITIAL_STATE;
```

- [ ] **Step 5: Run test — verify it passes**

```bash
npx vitest run src/store/__tests__/useAppStore.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 6: Create `src/__mocks__/@tauri-apps/api/index.ts`**

```typescript
import { vi } from "vitest";

export const invoke = vi.fn().mockResolvedValue(undefined);
export const listen = vi.fn().mockResolvedValue(() => {});
export const emit = vi.fn().mockResolvedValue(undefined);
```

- [ ] **Step 7: Create `src/hooks/useTauriEvents.ts`**

```typescript
import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store/useAppStore";
import type {
  TextCapturedPayload,
  AudioLevelPayload,
  RecordingStatePayload,
  FeedbackReadyPayload,
} from "../types";

export function useTauriEvents() {
  const unlistenersRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    if (import.meta.env.VITE_USE_MOCK) return;

    let cancelled = false;

    async function setup(): Promise<boolean> {
      if (!(window as any).__TAURI__) return false;

      const store = useAppStore.getState();

      const u1 = await listen<TextCapturedPayload>("text-captured", (e) => {
        store.setInputText(e.payload.text);
      });

      const u2 = await listen<AudioLevelPayload>("audio-level", (e) => {
        store.setAudioLevel(e.payload.level);
      });

      const u3 = await listen<RecordingStatePayload>("recording-state", (e) => {
        store.setRecordingState(e.payload.state);
      });

      const u4 = await listen<FeedbackReadyPayload>("feedback-ready", (e) => {
        store.setFeedback(e.payload);
      });

      if (!cancelled) {
        unlistenersRef.current = [u1, u2, u3, u4];
        return true;
      }
      [u1, u2, u3, u4].forEach((u) => u());
      return false;
    }

    let attempts = 0;
    function trySetup() {
      setup().then((ok) => {
        if (!ok && !cancelled && ++attempts < 10) setTimeout(trySetup, 200);
      });
    }
    trySetup();

    return () => {
      cancelled = true;
      unlistenersRef.current.forEach((u) => u());
    };
  }, []);
}
```

- [ ] **Step 8: Create `src/hooks/useMockEvents.ts`**

```typescript
import { useEffect } from "react";
import { useAppStore } from "../store/useAppStore";

const SAMPLE_TEXT =
  "The ability to communicate clearly in English is one of the most valuable skills you can develop.";

export function useMockEvents() {
  useEffect(() => {
    if (!import.meta.env.VITE_USE_MOCK) return;

    const store = useAppStore.getState();

    // Simulate text capture after 800ms
    const t1 = setTimeout(() => {
      store.setInputText(SAMPLE_TEXT);
    }, 800);

    // Simulate feedback after 3s
    const t2 = setTimeout(() => {
      store.setRecordingState("analyzing");
      setTimeout(() => {
        store.setFeedback({
          score: 87,
          transcription: "The ability to communicate clear in English is one of the most valuable skills.",
          diff: [
            { text: "The ability to communicate ", type: "correct" },
            { text: "clearly", type: "missed" },
            { text: "clear", type: "added" },
            { text: " in English is one of the most valuable skills", type: "correct" },
            { text: " you can develop", type: "missed" },
            { text: ".", type: "correct" },
          ],
          pacing: {
            wordsPerMinute: 142,
            articulationRate: 168,
            pauseCount: 6,
            totalPauseMs: 4200,
            pauseRatio: 0.21,
            longHesitations: 2,
          },
          comments: [
            { icon: "🐢", text: 'Your pace (142 wpm) is on the slow side for read-aloud — aim for 150–170.' },
            { icon: "⏸️", text: '2 long hesitations and a 21% pause ratio. Try reading a full clause without stopping.' },
            { icon: "✅", text: 'Good rhythm on the opening clause — natural stress and pacing.' },
          ],
        });
        store.setRecordingState("idle");
      }, 1200);
    }, 3000);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);
}
```

- [ ] **Step 9: Commit**

```bash
git add src/types/ src/store/ src/hooks/ src/__mocks__/
git commit -m "feat: types, Zustand store, Tauri event hooks, mock mode"
```

---

## Sub-project 2: Text Capture

### Task 5: Clipboard Paste

**Files:**
- Modify: `src-tauri/src/clipboard.rs`
- Modify: `src-tauri/Cargo.toml` (arboard already added in Task 2)

- [ ] **Step 1: Write Rust clipboard test**

Add to `src-tauri/src/clipboard.rs`:
```rust
#[cfg(test)]
mod tests {
    // arboard requires a display server; test is compile-only on CI
    #[test]
    fn read_text_compiles() {
        // Integration test: run manually with a clipboard that has text
        let _ = super::read_text;
    }
}
```

- [ ] **Step 2: Implement `src-tauri/src/clipboard.rs`**

```rust
pub fn read_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.get_text().map_err(|e| format!("Clipboard empty or non-text: {e}"))
}
```

- [ ] **Step 3: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```

Expected: no errors.

- [ ] **Step 4: Wire clipboard paste to frontend**

Update `src/App.tsx` — add paste handler (temporary inline, components come in Task 8):

```tsx
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./store/useAppStore";

// Inside App component:
async function handlePaste() {
  try {
    const text = await invoke<string>("paste_clipboard");
    useAppStore.getState().setInputText(text);
  } catch (e) {
    useAppStore.getState().addToast(String(e), "error");
  }
}
```

- [ ] **Step 5: Verify paste works**

```bash
npx tauri dev
```

Copy any text to clipboard → click Paste (wire a temp button) → text appears in left panel.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/clipboard.rs src/
git commit -m "feat: clipboard paste via arboard"
```

---

### Task 6: OCR Sidecar

**Files:**
- Create: `ocr_service/server.py`
- Create: `ocr_service/requirements.txt`

- [ ] **Step 1: Create `ocr_service/requirements.txt`**

```
fastapi==0.115.0
uvicorn==0.32.0
pyobjc-framework-Vision==11.0
pyobjc-framework-Quartz==11.0
```

- [ ] **Step 2: Create `ocr_service/server.py`**

```python
"""macOS Vision OCR sidecar. POST /ocr {"image_path": "/tmp/az_capture.png"} -> {"text": "..."}"""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()


class OcrRequest(BaseModel):
    image_path: str


def _run_vision_ocr(image_path: str) -> str:
    from Foundation import NSURL
    import Vision

    url = NSURL.fileURLWithPath_(image_path)
    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(url, {})
    request = Vision.VNRecognizeTextRequest.alloc().init()
    # VNRequestTextRecognitionLevelAccurate = 1
    request.setRecognitionLevel_(1)
    request.setUsesLanguageCorrection_(True)

    success, error = handler.performRequests_error_([request], None)
    if not success:
        raise RuntimeError(f"Vision OCR failed: {error}")

    lines = []
    for obs in (request.results() or []):
        candidates = obs.topCandidates_(1)
        if candidates and len(candidates) > 0:
            lines.append(candidates[0].string())

    return "\n".join(lines)


@app.post("/ocr")
def ocr(req: OcrRequest) -> dict:
    try:
        text = _run_vision_ocr(req.image_path)
        return {"text": text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
def health():
    return {"status": "ok"}
```

- [ ] **Step 3: Install and start OCR sidecar**

```bash
cd ocr_service
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn server:app --port 8124
```

- [ ] **Step 4: Test OCR sidecar with a sample image**

```bash
# Take a test screenshot first
screencapture -i /tmp/test_ocr.png

# Test OCR endpoint
curl -s -X POST http://localhost:8124/ocr \
  -H "Content-Type: application/json" \
  -d '{"image_path": "/tmp/test_ocr.png"}' | python3 -m json.tool
```

Expected: `{"text": "... extracted text ..."}`. Verify the extracted text matches what was in the screenshot.

- [ ] **Step 5: Commit**

```bash
git add ocr_service/
git commit -m "feat: OCR sidecar using macOS Vision framework"
```

---

### Task 7: Screenshot Capture (Rust)

**Files:**
- Modify: `src-tauri/src/capture.rs`

- [ ] **Step 1: Write Rust capture test**

Add to `src-tauri/src/capture.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ocr_sidecar_reachable() {
        // Requires ocr_service running on :8124
        // Run: cd ocr_service && .venv/bin/uvicorn server:app --port 8124
        let result = call_ocr_sidecar(&std::path::PathBuf::from("/nonexistent.png")).await;
        // Should fail with a 500 from sidecar, not a connection error
        assert!(result.is_err());
        assert!(!result.unwrap_err().contains("unreachable"), "OCR sidecar not running");
    }
}
```

- [ ] **Step 2: Implement `src-tauri/src/capture.rs`**

```rust
use reqwest::Client;
use std::path::Path;
use tempfile::NamedTempFile;

pub async fn capture_screen_region() -> Result<NamedTempFile, String> {
    // Unique temp file with a .png suffix; auto-deleted when the returned
    // handle is dropped by the caller (after OCR consumes it).
    let temp = tempfile::Builder::new()
        .prefix("az_capture_")
        .suffix(".png")
        .tempfile()
        .map_err(|e| format!("temp file: {e}"))?;
    let path = temp.path().to_path_buf();

    // screencapture -i: interactive region selection; exits non-zero if cancelled.
    // It overwrites the (empty) temp file at `path`.
    let status = std::process::Command::new("screencapture")
        .args(["-i", path.to_str().unwrap()])
        .status()
        .map_err(|e| format!("screencapture failed: {e}"))?;

    // Cancelled → file left empty (0 bytes). Treat empty as cancelled.
    let empty = std::fs::metadata(&path).map(|m| m.len() == 0).unwrap_or(true);
    if !status.success() || empty {
        return Err("Screenshot cancelled".into());
    }

    Ok(temp)
}

pub async fn call_ocr_sidecar(image_path: &Path) -> Result<String, String> {
    let client = Client::new();
    let resp = client
        .post("http://127.0.0.1:8124/ocr")
        .json(&serde_json::json!({"image_path": image_path.to_str().unwrap()}))
        .send()
        .await
        .map_err(|_| "OCR service not running — start ocr_service/".to_string())?;

    if !resp.status().is_success() {
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("OCR error: {detail}"));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json["text"].as_str().unwrap_or("").to_string())
}

pub async fn call_tts_sidecar(text: &str) -> Result<Vec<u8>, String> {
    let client = Client::new();
    let resp = client
        .post("http://127.0.0.1:8123/tts")
        .json(&serde_json::json!({"text": text}))
        .send()
        .await
        .map_err(|_| "TTS service not running — start tts_service/".to_string())?;

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ocr_sidecar_reachable() {
        let result = call_ocr_sidecar(&PathBuf::from("/nonexistent.png")).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(!err.contains("not running"), "OCR sidecar not running on :8124");
    }
}
```

- [ ] **Step 3: Run Rust test (with sidecar running)**

```bash
cd src-tauri && cargo test capture::tests::ocr_sidecar_reachable -- --nocapture
```

Expected: PASS — error is about nonexistent file, not connection failure.

- [ ] **Step 4: Verify screenshot → text flow end-to-end**

```bash
npx tauri dev
```

Start OCR sidecar in another terminal. Click "Screenshot" → draw a region over some text on screen → text should appear in left panel.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/capture.rs
git commit -m "feat: screenshot capture + OCR sidecar integration"
```

---

### Task 8: TextInputPanel + CaptureControls Components

**Files:**
- Create: `src/components/TextInputPanel.tsx`
- Create: `src/components/CaptureControls.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write component test**

Create `src/components/__tests__/TextInputPanel.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../../store/useAppStore";
import TextInputPanel from "../TextInputPanel";

describe("TextInputPanel", () => {
  beforeEach(() => useAppStore.setState({ inputText: "" } as any));

  it("renders placeholder when empty", () => {
    render(<TextInputPanel />);
    expect(screen.getByPlaceholderText(/paste text or capture/i)).toBeInTheDocument();
  });

  it("displays store inputText", () => {
    useAppStore.setState({ inputText: "hello world" } as any);
    render(<TextInputPanel />);
    expect(screen.getByDisplayValue("hello world")).toBeInTheDocument();
  });

  it("updates store on user edit", async () => {
    render(<TextInputPanel />);
    const ta = screen.getByPlaceholderText(/paste text or capture/i);
    await userEvent.type(ta, "test");
    expect(useAppStore.getState().inputText).toContain("test");
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run src/components/__tests__/TextInputPanel.test.tsx
```

Expected: FAIL — component not found.

- [ ] **Step 3: Create `src/components/TextInputPanel.tsx`**

```tsx
import { useAppStore } from "../store/useAppStore";

export default function TextInputPanel() {
  const inputText = useAppStore((s) => s.inputText);
  const setInputText = useAppStore((s) => s.setInputText);

  return (
    <textarea
      className="flex-1 w-full bg-transparent border-none outline-none resize-none text-[15px] leading-relaxed text-white/85 placeholder-white/20 p-0"
      placeholder="Paste text or capture a screenshot to begin…"
      value={inputText}
      onChange={(e) => setInputText(e.target.value)}
    />
  );
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run src/components/__tests__/TextInputPanel.test.tsx
```

Expected: PASS (3 tests).

- [ ] **Step 5: Create `src/components/CaptureControls.tsx`**

```tsx
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";

export default function CaptureControls() {
  const addToast = useAppStore((s) => s.addToast);
  const setInputText = useAppStore((s) => s.setInputText);
  const inputText = useAppStore((s) => s.inputText);

  async function handleScreenshot() {
    try {
      await invoke("capture_screenshot");
    } catch (e) {
      if (String(e) !== "Screenshot cancelled") {
        addToast(String(e), "error");
      }
    }
  }

  async function handlePaste() {
    try {
      const text = await invoke<string>("paste_clipboard");
      setInputText(text);
    } catch (e) {
      addToast(String(e), "error");
    }
  }

  function handleClear() {
    setInputText("");
  }

  return (
    <div className="flex gap-2 pt-2.5 border-t border-white/[0.06]">
      <button
        onClick={handleScreenshot}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-white/[0.06] border border-white/[0.08] text-white/60 hover:bg-white/10 hover:text-white/85 transition-all"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        Screenshot
      </button>

      <button
        onClick={handlePaste}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-white/[0.06] border border-white/[0.08] text-white/60 hover:bg-white/10 hover:text-white/85 transition-all"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        Paste
      </button>

      {inputText && (
        <button
          onClick={handleClear}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-white/[0.04] border border-white/[0.06] text-white/35 hover:text-white/60 transition-all"
        >
          Clear
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Wire components into `src/App.tsx`**

Replace the left panel contents in `App.tsx`:

```tsx
import TextInputPanel from "./components/TextInputPanel";
import CaptureControls from "./components/CaptureControls";
import { useTauriEvents } from "./hooks/useTauriEvents";
import { useMockEvents } from "./hooks/useMockEvents";

// Inside App():
useTauriEvents();
useMockEvents();

// In left panel body:
<div className="flex flex-col flex-1 p-3.5 gap-0 min-h-0">
  <TextInputPanel />
  <CaptureControls />
</div>
```

- [ ] **Step 7: Verify UI with mock mode**

```bash
VITE_USE_MOCK=true npx vite
```

Expected: browser opens, text auto-populates after 800ms, Screenshot/Paste/Clear buttons render.

- [ ] **Step 8: Commit**

```bash
git add src/components/
git commit -m "feat: TextInputPanel + CaptureControls with clipboard and screenshot"
```

---

## Sub-project 3: TTS Playback

### Task 9: TTS Sidecar

**Files:**
- Create: `tts_service/server.py`
- Create: `tts_service/requirements.txt`

- [ ] **Step 1: Copy TTS sidecar from azVoiceAssist**

```bash
cp /Users/allen/repo/azVoiceAssist/tts_service/server.py tts_service/server.py
cp /Users/allen/repo/azVoiceAssist/tts_service/requirements.txt tts_service/requirements.txt
```

- [ ] **Step 2: Install and start TTS sidecar**

```bash
cd tts_service
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn server:app --port 8123
```

First run downloads Qwen3-TTS weights (~1.8GB). Subsequent starts are fast.

- [ ] **Step 3: Test TTS endpoint**

```bash
curl -s -X POST http://localhost:8123/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test."}' \
  --output /tmp/test_tts.wav && \
  afplay /tmp/test_tts.wav
```

Expected: WAV file plays with natural English speech.

- [ ] **Step 4: Commit**

```bash
git add tts_service/
git commit -m "feat: TTS sidecar (Qwen3-TTS) copied from azVoiceAssist"
```

---

### Task 10: Rust TTS Command

**Files:**
- Modify: `src-tauri/src/capture.rs` (call_tts_sidecar already implemented in Task 7)
- `play_tts` command already in `commands.rs` from Task 2 — no changes needed

The `play_tts` command calls `call_tts_sidecar` and returns `Vec<u8>` (WAV bytes). This is fully implemented. Verify it compiles:

- [ ] **Step 1: Verify compile**

```bash
cd src-tauri && cargo check
```

Expected: no errors.

---

### Task 11: PlaybackControls Component

**Files:**
- Create: `src/components/PlaybackControls.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write PlaybackControls test**

Create `src/components/__tests__/PlaybackControls.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import PlaybackControls from "../PlaybackControls";

describe("PlaybackControls", () => {
  it("renders play button and speed selector", () => {
    render(<PlaybackControls />);
    expect(screen.getByRole("button", { name: /play/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("disables play button when inputText is empty", () => {
    render(<PlaybackControls />);
    expect(screen.getByRole("button", { name: /play/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run src/components/__tests__/PlaybackControls.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Create `src/components/PlaybackControls.tsx`**

```tsx
import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";

const SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0];

export default function PlaybackControls() {
  const inputText = useAppStore((s) => s.inputText);
  const ttsSpeed = useAppStore((s) => s.ttsSpeed);
  const setTtsSpeed = useAppStore((s) => s.setTtsSpeed);
  const ttsState = useAppStore((s) => s.ttsState);
  const setTtsState = useAppStore((s) => s.setTtsState);
  const addToast = useAppStore((s) => s.addToast);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const disabled = !inputText.trim();

  async function handlePlay() {
    if (ttsState === "playing") {
      audioRef.current?.pause();
      setTtsState("idle");
      return;
    }

    try {
      setTtsState("playing");
      const bytes = await invoke<number[]>("play_tts", { text: inputText });
      const arr = new Uint8Array(bytes);
      const blob = new Blob([arr], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);

      const audio = new Audio(url);
      audio.playbackRate = ttsSpeed;
      audioRef.current = audio;

      audio.onloadedmetadata = () => setDuration(audio.duration);
      audio.ontimeupdate = () => {
        setCurrentTime(audio.currentTime);
        setProgress(audio.currentTime / audio.duration);
      };
      audio.onended = () => {
        setTtsState("idle");
        setProgress(0);
        setCurrentTime(0);
        URL.revokeObjectURL(url);
      };

      await audio.play();
    } catch (e) {
      setTtsState("idle");
      addToast(String(e), "error");
    }
  }

  function handleSpeedChange(speed: number) {
    setTtsSpeed(speed);
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }

  function fmt(s: number) {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  }

  return (
    <div className="mb-3">
      <p className="text-[10px] font-semibold tracking-widest uppercase text-white/28 mb-2.5">
        Listen
      </p>
      <div className="flex items-center gap-3">
        {/* Play/Pause */}
        <button
          aria-label={ttsState === "playing" ? "Pause" : "Play"}
          onClick={handlePlay}
          disabled={disabled}
          className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 bg-gradient-to-br from-indigo-500 to-indigo-400 shadow-[0_0_20px_rgba(99,102,241,0.35)] hover:shadow-[0_0_30px_rgba(99,102,241,0.5)] hover:scale-105 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {ttsState === "playing" ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
              <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
              <polygon points="5,3 19,12 5,21" />
            </svg>
          )}
        </button>

        {/* Progress */}
        <div className="flex-1 h-[3px] bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-indigo-400 rounded-full transition-all"
            style={{ width: `${progress * 100}%` }}
          />
        </div>

        <span className="text-[12px] text-white/35 tabular-nums">
          {fmt(currentTime)} / {fmt(duration)}
        </span>

        {/* Speed */}
        <select
          value={ttsSpeed}
          onChange={(e) => handleSpeedChange(Number(e.target.value))}
          className="bg-white/[0.06] border border-white/10 rounded-md text-[12px] text-white/70 px-2 py-1 outline-none cursor-pointer"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>{s}x</option>
          ))}
        </select>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run src/components/__tests__/PlaybackControls.test.tsx
```

Expected: PASS (2 tests).

- [ ] **Step 5: Add PlaybackControls to `src/App.tsx`** right panel

```tsx
import PlaybackControls from "./components/PlaybackControls";

// In right panel body:
<div className="p-3.5 flex flex-col gap-0 overflow-y-auto flex-1">
  <PlaybackControls />
  {/* RecordingPanel + FeedbackPanel go here */}
</div>
```

- [ ] **Step 6: Test TTS playback end-to-end**

Start TTS sidecar on :8123. Run `npx tauri dev`. Paste text → click Play → audio plays. Speed selector changes playback rate.

- [ ] **Step 7: Commit**

```bash
git add src/components/PlaybackControls.tsx src/App.tsx
git commit -m "feat: TTS playback with progress bar and speed control"
```

---

## Sub-project 4: Recording + STT

### Task 12: Rust Audio Recording

**Files:**
- Modify: `src-tauri/src/audio.rs`

- [ ] **Step 1: Write Rust audio test**

Add to `src-tauri/src/audio.rs`:
```rust
#[cfg(test)]
mod tests {
    #[test]
    fn recorder_compiles() {
        // Verify Recorder API exists and compiles
        let _ = std::mem::size_of::<super::Recorder>();
    }
}
```

- [ ] **Step 2: Implement `src-tauri/src/audio.rs`**

```rust
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tauri::AppHandle;
use tempfile::NamedTempFile;

pub struct Recorder {
    _stream: cpal::Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    stop_flag: Arc<AtomicBool>,
    channels: u16,
    sample_rate: u32,
}

impl Recorder {
    pub fn start(app: AppHandle) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or("No microphone found")?;

        let config = device
            .default_input_config()
            .map_err(|e| e.to_string())?;

        let channels = config.channels();
        let sample_rate = config.sample_rate().0;
        let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
        let stop_flag = Arc::new(AtomicBool::new(false));

        let samples_cb = samples.clone();
        let stop_flag_cb = stop_flag.clone();

        let stream = device
            .build_input_stream(
                &config.into(),
                move |data: &[f32], _| {
                    if stop_flag_cb.load(Ordering::Relaxed) {
                        return;
                    }
                    // Compute RMS for waveform display
                    let rms = (data.iter().map(|s| s * s).sum::<f32>() / data.len() as f32)
                        .sqrt()
                        .min(1.0);
                    // Use the typed helper so the payload is {level: f32} (frontend
                    // reads e.payload.level) and the Emitter trait is in scope.
                    crate::events::emit_audio_level(&app, rms);

                    samples_cb.lock().unwrap().extend_from_slice(data);
                },
                |err| eprintln!("Audio stream error: {err}"),
                None,
            )
            .map_err(|e| e.to_string())?;

        stream.play().map_err(|e| e.to_string())?;

        Ok(Self {
            _stream: stream,
            samples,
            stop_flag,
            channels,
            sample_rate,
        })
    }

    pub fn stop(self) -> Result<NamedTempFile, String> {
        self.stop_flag.store(true, Ordering::Relaxed);
        // _stream is dropped here, stopping the stream

        let raw = self.samples.lock().unwrap();

        // Mix down to mono if stereo
        let mono: Vec<f32> = if self.channels > 1 {
            raw.chunks(self.channels as usize)
                .map(|ch| ch.iter().sum::<f32>() / self.channels as f32)
                .collect()
        } else {
            raw.clone()
        };

        // Unique temp WAV; auto-deleted when the caller drops the handle (after STT).
        let temp = tempfile::Builder::new()
            .prefix("az_recording_")
            .suffix(".wav")
            .tempfile()
            .map_err(|e| format!("temp file: {e}"))?;

        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: self.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::create(temp.path(), spec).map_err(|e| e.to_string())?;
        for sample in mono {
            let s = (sample * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
            writer.write_sample(s).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;

        Ok(temp)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn recorder_compiles() {
        let _ = std::mem::size_of::<super::Recorder>();
    }
}
```

- [ ] **Step 3: Run Rust test**

```bash
cd src-tauri && cargo test audio::tests::recorder_compiles
```

Expected: PASS.

- [ ] **Step 4: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/audio.rs
git commit -m "feat: mic recording with cpal, WAV output, audio-level events"
```

---

### Task 13: RecordingPanel Component

**Files:**
- Create: `src/components/RecordingPanel.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write RecordingPanel test**

Create `src/components/__tests__/RecordingPanel.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../../store/useAppStore";
import RecordingPanel from "../RecordingPanel";

describe("RecordingPanel", () => {
  beforeEach(() =>
    useAppStore.setState({ recordingState: "idle", inputText: "hello" } as any)
  );

  it("shows Record button when idle", () => {
    render(<RecordingPanel />);
    expect(screen.getByRole("button", { name: /record/i })).toBeInTheDocument();
  });

  it("disables Record when no input text", () => {
    useAppStore.setState({ inputText: "" } as any);
    render(<RecordingPanel />);
    expect(screen.getByRole("button", { name: /record/i })).toBeDisabled();
  });

  it("shows Stop button when recording", () => {
    useAppStore.setState({ recordingState: "recording" } as any);
    render(<RecordingPanel />);
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
  });

  it("shows analyzing message when analyzing", () => {
    useAppStore.setState({ recordingState: "analyzing" } as any);
    render(<RecordingPanel />);
    expect(screen.getByText(/analyzing/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run src/components/__tests__/RecordingPanel.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Create `src/components/RecordingPanel.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";

export default function RecordingPanel() {
  const recordingState = useAppStore((s) => s.recordingState);
  const audioLevel = useAppStore((s) => s.audioLevel);
  const inputText = useAppStore((s) => s.inputText);
  const addToast = useAppStore((s) => s.addToast);
  const clearFeedback = useAppStore((s) => s.clearFeedback);

  const [timer, setTimer] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const disabled = !inputText.trim();

  useEffect(() => {
    if (recordingState === "recording") {
      timerRef.current = setInterval(() => setTimer((t) => t + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (recordingState === "idle") setTimer(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [recordingState]);

  async function handleRecord() {
    clearFeedback();
    try {
      await invoke("start_recording");
    } catch (e) {
      addToast(String(e), "error");
    }
  }

  async function handleStop() {
    try {
      await invoke("stop_recording", { originalText: inputText });
    } catch (e) {
      addToast(String(e), "error");
    }
  }

  function fmt(s: number) {
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  return (
    <div className="mb-3 pb-3 border-b border-white/[0.06]">
      <p className="text-[10px] font-semibold tracking-widest uppercase text-white/28 mb-2.5">
        Record Your Reading
      </p>

      {recordingState === "analyzing" ? (
        <p className="text-[13px] text-white/40 italic">Analyzing your recording…</p>
      ) : (
        <div className="flex items-center gap-3">
          {/* Record / Stop button */}
          {recordingState === "recording" ? (
            <button
              aria-label="Stop"
              onClick={handleStop}
              className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 bg-red-500/20 border-2 border-red-500/70 hover:bg-red-500/30 transition-all"
            >
              <div className="w-4 h-4 rounded-sm bg-red-400" />
            </button>
          ) : (
            <button
              aria-label="Record"
              onClick={handleRecord}
              disabled={disabled}
              className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 bg-red-500/15 border-2 border-red-500/50 hover:bg-red-500/25 hover:border-red-500/80 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <div className="w-4 h-4 rounded-full bg-red-400" />
            </button>
          )}

          {/* Waveform */}
          <div className="flex-1 h-9 flex items-center gap-[2px] px-1">
            {Array.from({ length: 20 }, (_, i) => {
              const active = recordingState === "recording";
              const height = active
                ? Math.max(0.15, audioLevel * (0.5 + Math.sin(i * 0.8) * 0.5))
                : 0.15;
              return (
                <div
                  key={i}
                  className="flex-1 rounded-sm transition-all duration-75"
                  style={{
                    height: `${height * 100}%`,
                    background: active
                      ? "rgba(99,102,241,0.6)"
                      : "rgba(255,255,255,0.1)",
                  }}
                />
              );
            })}
          </div>

          <span className="text-[13px] text-white/50 tabular-nums">{fmt(timer)}</span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run src/components/__tests__/RecordingPanel.test.tsx
```

Expected: PASS (4 tests).

- [ ] **Step 5: Add RecordingPanel to `src/App.tsx`**

```tsx
import RecordingPanel from "./components/RecordingPanel";

// In right panel, after <PlaybackControls />:
<RecordingPanel />
```

- [ ] **Step 6: Verify waveform animates during recording (visual check)**

```bash
npx tauri dev
```

Paste text → click Record → speak → waveform bars animate with voice input → click Stop → "Analyzing…" appears.

- [ ] **Step 7: Commit**

```bash
git add src/components/RecordingPanel.tsx src/App.tsx
git commit -m "feat: RecordingPanel with animated waveform and timer"
```

---

### Task 14: Whisper STT

**Files:**
- Modify: `src-tauri/src/stt.rs`
- Modify: `src-tauri/src/lib.rs` (initialize WhisperEngine in AppState)

- [ ] **Step 1: Write STT test**

Add to `src-tauri/src/stt.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_path_is_correct() {
        let path = WhisperEngine::default_model_path();
        // Just verify the path computation doesn't panic
        println!("Whisper model path: {}", path.display());
    }
}
```

- [ ] **Step 2: Download Whisper model**

```bash
mkdir -p ~/.azreadanalyzer/models
curl -L -o ~/.azreadanalyzer/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Expected: ~141MB download. Verify: `ls -lh ~/.azreadanalyzer/models/ggml-base.en.bin`

- [ ] **Step 2b: Confirm the transcribe-rs API surface (BLOCKING — do before writing Step 3)**

The real transcribe-rs 0.3.11 API was verified against MeetBuddy's working code + docs.rs, and Step 3 below is written to it. Before implementing, confirm it still holds for the installed version (the crate wraps whisper-rs internally, so don't assume whisper-rs's `WhisperContext`/`state.full()` surface — that is NOT transcribe-rs's public API):

```bash
# Confirm the engine + result types compile by checking the crate source/docs.
cargo doc -p transcribe-rs --no-deps 2>/dev/null && \
  echo "open target/doc/transcribe_rs/index.html" || \
  echo "see https://docs.rs/transcribe-rs/0.3.11"
```

Verified facts Step 3 relies on (confirm these names exist):
- Engine: `transcribe_rs::whisper_cpp::WhisperEngine` with `WhisperEngine::load(path)` and `transcribe_with(&[f32], &WhisperInferenceParams) -> Result<TranscriptionResult>`.
- `transcribe_rs::TranscriptionResult { text: String, segments: Option<Vec<TranscriptionSegment>> }`.
- `transcribe_rs::TranscriptionSegment { start: f32 /* seconds */, end: f32 /* seconds */, text: String }`.

This gives **segment-level** timestamps (start/end in seconds) — sufficient for pacing. There are NO word-level timestamps, so Step 3 distributes a segment's words evenly across its `[start, end]` span and treats inter-segment gaps as pauses.

Fallbacks if a name differs:
- If `segments` comes back `None` (some param configs): Step 3 already falls back to one synthetic segment spanning the whole clip → WPM still computed, `pauseCount = 0`.
- If `transcribe_with`/`WhisperInferenceParams` names differ in the installed version, adjust to the actual signature (the MeetBuddy reference at `meetbuddy/src-tauri/src/stt/whisper_engine.rs` is known-good for 0.3.11).

- [ ] **Step 3: Implement `src-tauri/src/stt.rs`**

The `transcribe` method decodes the WAV to 16 kHz mono f32 samples, runs `transcribe_with`, then builds `Transcription { text, words }` from `result.segments`: each segment's words are distributed evenly across the segment's `[start, end]` span (converted seconds → ms), and the silence *between* segments is preserved as a gap between the last word of one segment and the first of the next — which is what `fluency.rs` reads as a pause. The crate's engine type `WhisperEngine` is imported under an alias to avoid colliding with our own `WhisperEngine` struct.

```rust
// stt.rs — transcribe-rs timestamp granularity used: SEGMENT-level (see Task 14 Step 2b).
// stt.rs — uses transcribe-rs SEGMENT-level timestamps (start/end in seconds).
use std::path::{Path, PathBuf};
// Alias the crate's engine to avoid colliding with our own `WhisperEngine` struct.
use transcribe_rs::whisper_cpp::{WhisperEngine as TranscribeWhisper, WhisperInferenceParams};

/// One transcribed word with its timing, used for pacing analysis (fluency.rs).
pub struct WordTimestamp {
    pub word: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Full STT result: joined text plus per-word timestamps.
pub struct Transcription {
    pub text: String,
    pub words: Vec<WordTimestamp>,
}

pub struct WhisperEngine {
    engine: TranscribeWhisper,
}

impl WhisperEngine {
    pub fn default_model_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".azreadanalyzer/models/ggml-base.en.bin")
    }

    pub fn new(model_path: &Path) -> Result<Self, String> {
        let engine = TranscribeWhisper::load(model_path)
            .map_err(|e| format!("Failed to load Whisper model at {}: {:?}", model_path.display(), e))?;
        Ok(Self { engine })
    }

    pub fn transcribe(&mut self, wav_path: &Path) -> Result<Transcription, String> {
        // Read WAV
        let mut reader = hound::WavReader::open(wav_path).map_err(|e| e.to_string())?;
        let spec = reader.spec();

        // Convert to f32 samples
        let raw_samples: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Int => reader
                .samples::<i16>()
                .map(|s| s.unwrap() as f32 / i16::MAX as f32)
                .collect(),
            hound::SampleFormat::Float => reader
                .samples::<f32>()
                .map(|s| s.unwrap())
                .collect(),
        };

        // Resample to 16kHz if needed (simple linear interpolation)
        let samples: Vec<f32> = if spec.sample_rate != 16000 {
            let ratio = spec.sample_rate as f64 / 16000.0;
            let out_len = (raw_samples.len() as f64 / ratio) as usize;
            (0..out_len)
                .map(|i| {
                    let pos = i as f64 * ratio;
                    let lo = pos.floor() as usize;
                    let hi = (lo + 1).min(raw_samples.len() - 1);
                    let frac = pos - pos.floor();
                    raw_samples[lo] * (1.0 - frac as f32) + raw_samples[hi] * frac as f32
                })
                .collect()
        } else {
            raw_samples
        };

        // transcribe-rs takes the decoded 16kHz mono samples directly.
        let params = WhisperInferenceParams::default();
        let result = self
            .engine
            .transcribe_with(&samples, &params)
            .map_err(|e| format!("Whisper inference failed: {e:?}"))?;

        // Build per-word timestamps from segment-level [start, end] (seconds → ms).
        // If the engine returned no segments, synthesize one spanning the whole clip
        // so WPM is still meaningful (pauseCount stays 0).
        let total_ms = (samples.len() as f64 / 16.0) as u64; // 16 samples per ms at 16kHz
        let segments: Vec<(String, u64, u64)> = match &result.segments {
            Some(segs) if !segs.is_empty() => segs
                .iter()
                .map(|s| (s.text.clone(), (s.start * 1000.0) as u64, (s.end * 1000.0) as u64))
                .collect(),
            _ => vec![(result.text.clone(), 0, total_ms)],
        };

        let mut words: Vec<WordTimestamp> = Vec::new();
        for (seg_text, t0_ms, t1_ms) in &segments {
            // Distribute the segment's words evenly across [t0, t1]. The gap to the
            // NEXT segment's t0 is preserved as a pause (fluency.rs reads it).
            let seg_words: Vec<&str> = seg_text.split_whitespace().collect();
            if seg_words.is_empty() {
                continue;
            }
            let span = t1_ms.saturating_sub(*t0_ms).max(1);
            let per = span / seg_words.len() as u64;
            for (j, w) in seg_words.iter().enumerate() {
                let ws = t0_ms + per * j as u64;
                let we = if j + 1 == seg_words.len() { *t1_ms } else { ws + per };
                words.push(WordTimestamp { word: w.to_string(), start_ms: ws, end_ms: we });
            }
        }

        Ok(Transcription { text: result.text.trim().to_string(), words })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_path_is_correct() {
        let path = WhisperEngine::default_model_path();
        println!("Whisper model path: {}", path.display());
    }
}
```

- [ ] **Step 4: Initialize WhisperEngine in `src-tauri/src/lib.rs`**

Update `run()` to load the Whisper model at startup:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let stt_engine = WhisperEngine::new(&WhisperEngine::default_model_path())
        .map(|e| Some(e))
        .unwrap_or_else(|err| {
            eprintln!("Warning: Whisper model not loaded: {err}");
            None
        });

    tauri::Builder::default()
        .manage(Arc::new(AppState {
            recorder: Mutex::new(None),
            stt_engine: Mutex::new(stt_engine),
        }))
        .invoke_handler(tauri::generate_handler![
            commands::paste_clipboard,
            commands::capture_screenshot,
            commands::play_tts,
            commands::set_always_on_top,
            commands::start_recording,
            commands::stop_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Add import at top of lib.rs:
```rust
use stt::WhisperEngine;
```

- [ ] **Step 5: Run Rust tests**

```bash
cd src-tauri && cargo test stt::tests::model_path_is_correct
```

Expected: PASS.

- [ ] **Step 6: Verify compile**

```bash
cd src-tauri && cargo check
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/stt.rs src-tauri/src/lib.rs
git commit -m "feat: Whisper STT via transcribe-rs with 16kHz resampling"
```

---

## Sub-project 5: LLM Feedback

### Task 15: Word-Level Diff

**Files:**
- Modify: `src-tauri/src/diff.rs`

- [ ] **Step 1: Write diff test**

Replace stub in `src-tauri/src/diff.rs` with tests:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_all_correct() {
        let result = word_diff("hello world", "hello world");
        assert!(result.iter().all(|t| t.token_type == "correct"));
    }

    #[test]
    fn missing_word_marked_missed() {
        let result = word_diff("hello world foo", "hello world");
        assert!(result.iter().any(|t| t.token_type == "missed" && t.text.contains("foo")));
    }

    #[test]
    fn extra_word_marked_added() {
        let result = word_diff("hello world", "hello beautiful world");
        assert!(result.iter().any(|t| t.token_type == "added" && t.text.contains("beautiful")));
    }
}
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd src-tauri && cargo test diff::tests
```

Expected: FAIL — `word_diff` returns empty vec.

- [ ] **Step 3: Implement `src-tauri/src/diff.rs`**

```rust
use similar::{ChangeTag, TextDiff};

use crate::events::DiffToken;

pub fn word_diff(original: &str, transcription: &str) -> Vec<DiffToken> {
    let diff = TextDiff::from_words(original, transcription);
    let mut tokens = Vec::new();

    for change in diff.iter_all_changes() {
        let text = change.value().to_string();
        if text.is_empty() {
            continue;
        }
        let token_type = match change.tag() {
            ChangeTag::Equal => "correct",
            ChangeTag::Delete => "missed",
            ChangeTag::Insert => "added",
        }
        .to_string();
        tokens.push(DiffToken { text, token_type });
    }

    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_all_correct() {
        let result = word_diff("hello world", "hello world");
        assert!(result.iter().all(|t| t.token_type == "correct"));
    }

    #[test]
    fn missing_word_marked_missed() {
        let result = word_diff("hello world foo", "hello world");
        assert!(result.iter().any(|t| t.token_type == "missed" && t.text.contains("foo")));
    }

    #[test]
    fn extra_word_marked_added() {
        let result = word_diff("hello world", "hello beautiful world");
        assert!(result.iter().any(|t| t.token_type == "added" && t.text.contains("beautiful")));
    }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd src-tauri && cargo test diff::tests
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/diff.rs
git commit -m "feat: word-level diff using similar crate"
```

---

### Task 15B: Pacing Metrics (fluency.rs)

**Files:**
- Modify: `src-tauri/src/fluency.rs`

> Depends on Task 14 Step 2b (timestamp verification). If that step found only text (no timestamps), implement the documented duration-only fallback instead of the code below and set pause fields to 0.

- [ ] **Step 1: Write pacing tests**

Replace the stub in `src-tauri/src/fluency.rs` with tests. `LONG_PAUSE_MS = 250` is the standard minimum-pause threshold from the fluency literature (see design spec).

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::WordTimestamp;

    fn w(word: &str, start_ms: u64, end_ms: u64) -> WordTimestamp {
        WordTimestamp { word: word.to_string(), start_ms, end_ms }
    }

    #[test]
    fn empty_words_yields_zero() {
        let m = compute_pacing(&[]);
        assert_eq!(m.words_per_minute, 0.0);
        assert_eq!(m.pause_count, 0);
    }

    #[test]
    fn three_words_over_one_second_is_180_wpm() {
        // words span 0..1000ms, no gaps → 3 words / 1s = 180 wpm
        let words = vec![w("a", 0, 300), w("b", 300, 600), w("c", 600, 1000)];
        let m = compute_pacing(&words);
        assert!((m.words_per_minute - 180.0).abs() < 1.0);
        assert_eq!(m.pause_count, 0);
        assert_eq!(m.total_pause_ms, 0);
    }

    #[test]
    fn gap_over_threshold_counts_as_pause() {
        // 500ms gap between b and c → 1 pause, 1 long hesitation
        let words = vec![w("a", 0, 300), w("b", 300, 600), w("c", 1100, 1400)];
        let m = compute_pacing(&words);
        assert_eq!(m.pause_count, 1);
        assert_eq!(m.total_pause_ms, 500);
        assert_eq!(m.long_hesitations, 1);
        // articulation rate (excludes pause time) > wpm (includes it)
        assert!(m.articulation_rate > m.words_per_minute);
        assert!(m.pause_ratio > 0.0 && m.pause_ratio < 1.0);
    }
}
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd src-tauri && cargo test fluency::tests
```

Expected: FAIL — `compute_pacing` returns `PacingMetrics::default()` (all zeros), so the non-zero assertions fail.

- [ ] **Step 3: Implement `src-tauri/src/fluency.rs`**

```rust
use crate::events::PacingMetrics;
use crate::stt::WordTimestamp;

/// Minimum silent gap (ms) counted as a pause / long hesitation.
/// 250ms is the standard minimum pause threshold in the fluency literature.
const LONG_PAUSE_MS: u64 = 250;

pub fn compute_pacing(words: &[WordTimestamp]) -> PacingMetrics {
    if words.is_empty() {
        return PacingMetrics::default();
    }

    let first_start = words.first().unwrap().start_ms;
    let last_end = words.last().unwrap().end_ms;
    let total_ms = last_end.saturating_sub(first_start).max(1);

    // Sum inter-word gaps that exceed the pause threshold.
    let mut total_pause_ms: u64 = 0;
    let mut pause_count: u32 = 0;
    let mut long_hesitations: u32 = 0;
    for pair in words.windows(2) {
        let gap = pair[1].start_ms.saturating_sub(pair[0].end_ms);
        if gap >= LONG_PAUSE_MS {
            total_pause_ms += gap;
            pause_count += 1;
            long_hesitations += 1;
        }
    }

    let word_count = words.len() as f32;
    let total_min = total_ms as f32 / 60_000.0;
    let speaking_ms = total_ms.saturating_sub(total_pause_ms).max(1);
    let speaking_min = speaking_ms as f32 / 60_000.0;

    PacingMetrics {
        words_per_minute: word_count / total_min,
        articulation_rate: word_count / speaking_min, // excludes pause time
        pause_count,
        total_pause_ms: total_pause_ms as u32,
        pause_ratio: total_pause_ms as f32 / total_ms as f32,
        long_hesitations,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::WordTimestamp;

    fn w(word: &str, start_ms: u64, end_ms: u64) -> WordTimestamp {
        WordTimestamp { word: word.to_string(), start_ms, end_ms }
    }

    #[test]
    fn empty_words_yields_zero() {
        let m = compute_pacing(&[]);
        assert_eq!(m.words_per_minute, 0.0);
        assert_eq!(m.pause_count, 0);
    }

    #[test]
    fn three_words_over_one_second_is_180_wpm() {
        let words = vec![w("a", 0, 300), w("b", 300, 600), w("c", 600, 1000)];
        let m = compute_pacing(&words);
        assert!((m.words_per_minute - 180.0).abs() < 1.0);
        assert_eq!(m.pause_count, 0);
        assert_eq!(m.total_pause_ms, 0);
    }

    #[test]
    fn gap_over_threshold_counts_as_pause() {
        let words = vec![w("a", 0, 300), w("b", 300, 600), w("c", 1100, 1400)];
        let m = compute_pacing(&words);
        assert_eq!(m.pause_count, 1);
        assert_eq!(m.total_pause_ms, 500);
        assert_eq!(m.long_hesitations, 1);
        assert!(m.articulation_rate > m.words_per_minute);
        assert!(m.pause_ratio > 0.0 && m.pause_ratio < 1.0);
    }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd src-tauri && cargo test fluency::tests
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/fluency.rs
git commit -m "feat: pacing metrics (wpm, articulation rate, pauses) from word timestamps"
```

---

### Task 16: LLM Feedback Client

**Files:**
- Modify: `src-tauri/src/llm.rs`

- [ ] **Step 1: Write LLM test**

Add to `src-tauri/src/llm.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::PacingMetrics;

    #[tokio::test]
    async fn returns_fallback_when_llm_unreachable() {
        // Point at a port with nothing listening
        std::env::set_var("OMLX_BASE_URL", "http://127.0.0.1:19999/v1");
        let result = get_feedback("hello", "hello", &[], &PacingMetrics::default()).await;
        // Should not panic — errors are swallowed by caller
        // (returns Err which caller maps to (0, []))
        assert!(result.is_err());
    }
}
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd src-tauri && cargo test llm::tests
```

Expected: FAIL — function is stub returning `Ok((0, vec![]))`, test expects `Err`.

- [ ] **Step 3: Implement `src-tauri/src/llm.rs`**

```rust
use reqwest::Client;
use serde::Deserialize;

use crate::events::{DiffToken, LlmComment, PacingMetrics};

#[derive(Deserialize, Debug)]
struct LlmResponse {
    score: u32,
    comments: Vec<LlmCommentRaw>,
}

#[derive(Deserialize, Debug)]
struct LlmCommentRaw {
    icon: String,
    text: String,
}

/// The diff and pacing are computed deterministically in Rust (diff.rs / fluency.rs).
/// The LLM only summarizes them into a score + coaching comments — it does NOT
/// recompute the diff. We pass the already-computed diff + pacing so its comments
/// are grounded in the same numbers the UI shows.
pub async fn get_feedback(
    original: &str,
    transcription: &str,
    diff: &[DiffToken],
    pacing: &PacingMetrics,
) -> Result<(u32, Vec<LlmComment>), String> {
    let base_url =
        std::env::var("OMLX_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8002/v1".into());
    let api_key = std::env::var("OMLX_API_KEY").unwrap_or_default();
    let model =
        std::env::var("OMLX_MODEL").unwrap_or_else(|_| "default".into());

    // Summarize the Rust-computed diff for the prompt.
    let missed: Vec<&str> = diff.iter()
        .filter(|t| t.token_type == "missed")
        .map(|t| t.text.trim())
        .filter(|s| !s.is_empty())
        .collect();
    let added: Vec<&str> = diff.iter()
        .filter(|t| t.token_type == "added")
        .map(|t| t.text.trim())
        .filter(|s| !s.is_empty())
        .collect();

    let prompt = format!(
        "You are coaching a Chinese-native English learner on a read-aloud exercise. \
All metrics below are already computed — do NOT recompute them, just interpret them.\n\n\
Original text: {original}\n\n\
What they said (ASR): {transcription}\n\n\
CONTENT DIFF (computed):\n- Missed/substituted words: {missed:?}\n- Extra/substituted words said: {added:?}\n\n\
PACING METRICS (computed):\n\
- Words per minute: {wpm:.0}\n\
- Articulation rate (excl. pauses): {art:.0}\n\
- Pause count: {pc}\n- Total pause time: {tp} ms\n- Pause ratio: {pr:.2}\n- Long hesitations: {lh}\n\n\
Note: ASR normalizes pronunciation, so do NOT claim specific phoneme/word-ending mispronunciations — \
focus on CONTENT ACCURACY (missed/extra words) and FLUENCY/PACING (rate, pauses, hesitations). \
A natural read-aloud pace is ~150-170 wpm.\n\n\
Return ONLY a JSON object (no markdown fences):\n\
- \"score\": integer 0-100 combining content accuracy and fluency\n\
- \"comments\": array of 3-5 objects, each with \"icon\" (a single emoji) and \"text\" (one specific, constructive tip)",
        original = original,
        transcription = transcription,
        missed = missed,
        added = added,
        wpm = pacing.words_per_minute,
        art = pacing.articulation_rate,
        pc = pacing.pause_count,
        tp = pacing.total_pause_ms,
        pr = pacing.pause_ratio,
        lh = pacing.long_hesitations,
    );

    let body = serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You are an English fluency and read-aloud coach for non-native speakers. You interpret pre-computed content-diff and pacing metrics. Return only valid JSON. No markdown fences."
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "temperature": 0.3
    });

    let client = Client::new();
    let resp = client
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("{}");

    let parsed: LlmResponse = serde_json::from_str(content).map_err(|e| {
        format!("LLM returned non-JSON: {e}\nRaw: {content}")
    })?;

    let comments = parsed
        .comments
        .into_iter()
        .map(|c| LlmComment { icon: c.icon, text: c.text })
        .collect();

    Ok((parsed.score, comments))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::PacingMetrics;

    #[tokio::test]
    async fn returns_err_when_llm_unreachable() {
        std::env::set_var("OMLX_BASE_URL", "http://127.0.0.1:19999/v1");
        let result = get_feedback("hello", "hello", &[], &PacingMetrics::default()).await;
        assert!(result.is_err());
    }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd src-tauri && cargo test llm::tests
```

Expected: PASS (connection refused = Err, which is what we assert).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/llm.rs
git commit -m "feat: LLM fluency feedback client via OpenAI-compatible API"
```

---

### Task 17: Wire stop_recording → full pipeline

`commands.rs` already has the full `stop_recording` implementation from Task 2. Verify end-to-end:

- [ ] **Step 1: Verify compile with all real implementations**

```bash
cd src-tauri && cargo build
```

Expected: compiles. If transcribe-rs Metal build fails: `xcode-select --install` and retry.

- [ ] **Step 2: Verify Rust unit tests pass**

```bash
cd src-tauri && cargo test --lib
```

Expected: all tests PASS.

- [ ] **Step 3: Run full app end-to-end**

Prerequisites:
```bash
# Terminal 1: OCR sidecar
cd ocr_service && .venv/bin/uvicorn server:app --port 8124

# Terminal 2: TTS sidecar
cd tts_service && .venv/bin/uvicorn server:app --port 8123

# Terminal 3: Local LLM (e.g. oMLX)
# export OMLX_BASE_URL, OMLX_API_KEY, OMLX_MODEL

# Terminal 4: App
npx tauri dev
```

Manual test checklist:
- [ ] Paste text from clipboard → text appears in left panel
- [ ] Click Read Aloud → TTS plays at selected speed
- [ ] Click Record → waveform animates while speaking
- [ ] Click Stop → "Analyzing…" appears
- [ ] Feedback panel renders: score ring, pacing metrics (wpm/pauses), diff view, LLM comments
- [ ] Pacing numbers look plausible (wpm in a sane range, pause count non-negative)
- [ ] Click Re-record → clears feedback, ready to record again

- [ ] **Step 4: Commit**

```bash
git add src-tauri/
git commit -m "feat: wire stop_recording to full STT + diff + pacing + LLM pipeline"
```

---

### Task 18: FeedbackPanel Component

**Files:**
- Create: `src/components/FeedbackPanel.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write FeedbackPanel test**

Create `src/components/__tests__/FeedbackPanel.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../../store/useAppStore";
import FeedbackPanel from "../FeedbackPanel";

const MOCK_FEEDBACK = {
  score: 87,
  transcription: "hello world",
  diff: [
    { text: "hello ", type: "correct" as const },
    { text: "world", type: "missed" as const },
    { text: "earth", type: "added" as const },
  ],
  pacing: {
    wordsPerMinute: 142,
    articulationRate: 168,
    pauseCount: 6,
    totalPauseMs: 4200,
    pauseRatio: 0.21,
    longHesitations: 2,
  },
  comments: [{ icon: "🐢", text: "Aim for 150–170 wpm." }],
};

describe("FeedbackPanel", () => {
  beforeEach(() => useAppStore.setState({ feedback: null } as any));

  it("renders nothing when no feedback", () => {
    const { container } = render(<FeedbackPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("shows score when feedback is ready", () => {
    useAppStore.setState({ feedback: MOCK_FEEDBACK } as any);
    render(<FeedbackPanel />);
    expect(screen.getByText("87")).toBeInTheDocument();
  });

  it("renders diff tokens with correct text", () => {
    useAppStore.setState({ feedback: MOCK_FEEDBACK } as any);
    render(<FeedbackPanel />);
    expect(screen.getByText(/hello/)).toBeInTheDocument();
  });

  it("renders pacing metrics", () => {
    useAppStore.setState({ feedback: MOCK_FEEDBACK } as any);
    render(<FeedbackPanel />);
    expect(screen.getByText(/142/)).toBeInTheDocument();   // wpm
    expect(screen.getByText(/6 pauses/i)).toBeInTheDocument();
  });

  it("renders LLM comment", () => {
    useAppStore.setState({ feedback: MOCK_FEEDBACK } as any);
    render(<FeedbackPanel />);
    expect(screen.getByText(/150–170 wpm/)).toBeInTheDocument();
  });

  it("suppresses score + comments when score is null (LLM unreachable)", () => {
    useAppStore.setState({ feedback: { ...MOCK_FEEDBACK, score: null, comments: [] } } as any);
    render(<FeedbackPanel />);
    expect(screen.queryByText("87")).not.toBeInTheDocument();        // no score ring
    expect(screen.getByText(/AI coach unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/142/)).toBeInTheDocument();             // pacing still shown
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run src/components/__tests__/FeedbackPanel.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Create `src/components/FeedbackPanel.tsx`**

```tsx
import { useAppStore } from "../store/useAppStore";
import type { DiffToken, PacingMetrics } from "../types";

function PacingReadout({ pacing }: { pacing: PacingMetrics }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3 text-[12px] text-white/55">
      <span><span className="text-indigo-300 font-medium">{Math.round(pacing.wordsPerMinute)}</span> wpm</span>
      <span><span className="text-indigo-300 font-medium">{pacing.pauseCount}</span> pauses</span>
      <span><span className="text-indigo-300 font-medium">{pacing.longHesitations}</span> long hesitations</span>
      <span><span className="text-indigo-300 font-medium">{Math.round(pacing.pauseRatio * 100)}%</span> pause ratio</span>
    </div>
  );
}

function ScoreRing({ score }: { score: number }) {
  const r = 26;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - score / 100);

  return (
    <div className="relative w-16 h-16 flex-shrink-0">
      <svg viewBox="0 0 64 64" className="w-16 h-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="5" />
        <circle
          cx="32" cy="32" r={r}
          fill="none"
          stroke="#6366f1"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          style={{ filter: "drop-shadow(0 0 4px rgba(99,102,241,0.6))", transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[14px] font-bold text-indigo-400">
        {score}
      </span>
    </div>
  );
}

function DiffView({ tokens }: { tokens: DiffToken[] }) {
  return (
    <div className="bg-black/25 border border-white/[0.06] rounded-lg p-3 text-[13px] leading-[1.8] mb-2.5">
      {tokens.map((t, i) => (
        <span
          key={i}
          className={
            t.type === "correct"
              ? "text-white/85"
              : t.type === "missed"
              ? "line-through text-red-300 bg-red-500/20 rounded px-0.5 mx-0.5"
              : "text-green-300 bg-green-500/15 rounded px-0.5 mx-0.5"
          }
        >
          {t.text}
        </span>
      ))}
    </div>
  );
}

export default function FeedbackPanel() {
  const feedback = useAppStore((s) => s.feedback);
  const clearFeedback = useAppStore((s) => s.clearFeedback);
  const setInputText = useAppStore((s) => s.setInputText);

  if (!feedback) return null;

  return (
    <div className="mt-3 pt-3 border-t border-white/[0.06]">
      {/* Header with score (suppressed when LLM was unreachable) */}
      <div className="flex items-center gap-3 mb-3">
        <p className="text-[10px] font-semibold tracking-widest uppercase text-white/28">
          Feedback
        </p>
        {feedback.score !== null && (
          <div className="ml-auto flex items-center gap-3">
            <ScoreRing score={feedback.score} />
            <span className="text-[11px] text-white/30 leading-tight">
              Fluency<br />Score
            </span>
          </div>
        )}
      </div>

      {/* Pacing metrics */}
      <PacingReadout pacing={feedback.pacing} />

      {/* Diff view */}
      <p className="text-[10px] text-white/25 uppercase tracking-widest mb-1.5">
        What you said vs original
      </p>
      <DiffView tokens={feedback.diff} />
      <div className="flex gap-4 mb-3">
        <span className="text-[10px] text-red-300">■ missed</span>
        <span className="text-[10px] text-green-300">■ said instead</span>
      </div>

      {/* LLM comments (empty when LLM unreachable → show a quiet notice instead) */}
      {feedback.score === null ? (
        <p className="text-[11px] text-white/35 italic mb-4">
          AI coach unavailable — showing content diff and pacing only.
        </p>
      ) : (
        <div className="flex flex-col gap-2 mb-4">
          {feedback.comments.map((c, i) => (
            <div
              key={i}
              className="flex gap-2 items-start p-2.5 rounded-lg bg-indigo-500/[0.06] border border-indigo-500/[0.12] text-[12px] text-white/65 leading-relaxed"
            >
              <span className="text-sm flex-shrink-0 mt-0.5">{c.icon}</span>
              <span dangerouslySetInnerHTML={{ __html: c.text }} />
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={clearFeedback}
          className="flex-1 py-2 rounded-lg text-[12px] font-medium bg-gradient-to-br from-indigo-500 to-indigo-400 text-white shadow-[0_0_16px_rgba(99,102,241,0.3)] hover:shadow-[0_0_24px_rgba(99,102,241,0.5)] transition-all"
        >
          ⏺ Re-record
        </button>
        <button
          onClick={() => { clearFeedback(); setInputText(""); }}
          className="px-4 py-2 rounded-lg text-[12px] font-medium bg-white/[0.06] border border-white/[0.08] text-white/60 hover:bg-white/10 hover:text-white/85 transition-all"
        >
          New Text
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run src/components/__tests__/FeedbackPanel.test.tsx
```

Expected: PASS (6 tests).

- [ ] **Step 5: Add FeedbackPanel to `src/App.tsx`**

```tsx
import FeedbackPanel from "./components/FeedbackPanel";

// In right panel, after <RecordingPanel />:
<FeedbackPanel />
```

- [ ] **Step 6: Run all frontend tests**

```bash
npx vitest run
```

Expected: all tests PASS. Note the count.

- [ ] **Step 7: Commit**

```bash
git add src/components/FeedbackPanel.tsx src/App.tsx
git commit -m "feat: FeedbackPanel with score ring, diff view, and LLM comments"
```

---

### Task 19: CLAUDE.md + End-to-End Verification

**Files:**
- Create: `CLAUDE.md`

- [ ] **Step 1: Create `CLAUDE.md`**

```markdown
# CLAUDE.md

## What This Is

**azReadAnalyzer** is a macOS desktop app for English speaking practice. Capture text via screenshot OCR or clipboard paste, listen to TTS playback, record yourself reading, and receive feedback on content accuracy (Rust-computed diff), fluency/pacing (Rust-computed metrics from Whisper word timestamps), and LLM coaching (score + comments). 100% on-device. Phoneme-level pronunciation feedback (GOP/forced alignment) is deferred to v2 — see the design spec's Feedback Methodology section.

## Commands

### Run full app (Tauri)
```bash
# Requires all three services running (see Services below)
export OMLX_BASE_URL="http://127.0.0.1:8002/v1"
export OMLX_API_KEY="your-key"
export OMLX_MODEL="your-model"
npx tauri dev
```

### Frontend only (mock mode — no mic, no Rust, no sidecars)
```bash
VITE_USE_MOCK=true npx vite
```

### Frontend tests
```bash
npx vitest run        # single run
npx vitest            # watch mode
```

### Rust tests
```bash
cd src-tauri && cargo test --lib
cd src-tauri && cargo check
```

### Services (three terminals)
```bash
# OCR sidecar (:8124)
cd ocr_service && .venv/bin/uvicorn server:app --port 8124

# TTS sidecar (:8123) — first run downloads Qwen3-TTS (~1.8GB)
cd tts_service && .venv/bin/uvicorn server:app --port 8123

# Local LLM — any OpenAI-compatible server on OMLX_BASE_URL
```

## Whisper Model (one-time download)
```bash
mkdir -p ~/.azreadanalyzer/models
curl -L -o ~/.azreadanalyzer/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

## macOS Permissions (one-time, grant via Terminal.app directly)
- **Microphone**: prompted on first Record click
- **Screen Recording**: grant in System Settings → Privacy → Screen Recording (required for Screenshot)

## Architecture
See `docs/superpowers/specs/2026-06-07-azreadanalyzer-design.md`.

## Key Files
- `src/types/index.ts` — all domain types + IPC payloads
- `src/store/useAppStore.ts` — single Zustand store
- `src/hooks/useTauriEvents.ts` — wires Tauri events → store
- `src-tauri/src/commands.rs` — all Tauri IPC commands + AppState
- `src-tauri/src/events.rs` — typed event payloads + emit helpers
```

- [ ] **Step 2: Run full frontend test suite**

```bash
npx vitest run
```

Expected: all tests PASS. Verify test count matches what was written across all tasks.

- [ ] **Step 3: Run Rust unit tests**

```bash
cd src-tauri && cargo test --lib
```

Expected: all tests PASS.

- [ ] **Step 4: End-to-end golden path test**

Start all three services and run `npx tauri dev`. Work through the full practice loop:

1. Copy a paragraph to clipboard → click Paste → text appears in left panel ✓
2. Click Read Aloud → TTS plays entire text naturally ✓
3. Change speed to 0.75x → play again at slower speed ✓
4. Click Record → speak the text aloud → waveform animates ✓
5. Click Stop → "Analyzing…" appears ✓
6. Feedback panel appears: score ring, pacing metrics (wpm/pauses/hesitations), colored diff, LLM comments ✓
7. Click Re-record → feedback clears, ready to record again ✓
8. Click New Text → clears everything ✓
9. Click Screenshot → draw region over text on screen → text extracted and populated ✓

- [ ] **Step 5: Final commit**

```bash
git add CLAUDE.md
git commit -m "feat: CLAUDE.md + end-to-end verified"
```

- [ ] **Step 6: Push to upstream**

```bash
git push -u origin master
```

---

## Self-Review Checklist

Mapped against the design spec (spec ↔ task):

- **Clipboard paste** → Task 5 (clipboard.rs + CaptureControls) ✓
- **Screenshot OCR (HTTP only)** → Task 6 (ocr_service) + Task 7 (capture.rs) + Task 8 (CaptureControls) ✓
- **TTS synthesis sidecar + client-side HTML5 Audio playback/speed/progress** → Task 9 (sidecar) + Task 11 (PlaybackControls) ✓
- **Mic recording with waveform** → Task 12 (audio.rs) + Task 13 (RecordingPanel) ✓
- **Whisper STT with word timestamps** → Task 14 (stt.rs; uses real transcribe-rs `whisper_cpp::WhisperEngine`/`transcribe_with` → `TranscriptionResult.segments`, aliased to avoid name collision; Step 2b confirms the API surface) ✓
- **Deterministic Rust-owned word-level diff** → Task 15 (diff.rs) ✓
- **Pacing/fluency metrics (wpm, articulation rate, pauses, hesitations)** → Task 15B (fluency.rs) ✓
- **LLM returns score + comments ONLY (receives diff + pacing)** → Task 16 (llm.rs) ✓
- **LLM unreachable → score = None, comments suppressed, diff + pacing still shown** → Task 2 (commands.rs match), Task 2/4 (`score: Option<u32>` / `number | null`), Task 18 (FeedbackPanel suppresses ring + shows "AI coach unavailable") ✓
- **FeedbackPanel (score ring + pacing readout + diff + comments)** → Task 18 ✓
- **PacingMetrics type + camelCase serde bridge** → Task 2 (events.rs) + Task 4 (types/index.ts) ✓
- **Mock mode (VITE_USE_MOCK) incl. pacing** → Task 4 (useMockEvents) ✓
- **audio-level event uses typed helper {level: f32}** → Task 12 calls `crate::events::emit_audio_level` (not a bare `app.emit` — fixes missing-Emitter + payload-shape bug) ✓
- **Unique temp paths via `tempfile::NamedTempFile` (in [dependencies])** → Task 7 (capture.rs) + Task 12 (audio.rs) — VERIFIED in code, not just claimed ✓
- **Temp files auto-deleted** → NamedTempFile dropped after OCR (Task 2 capture_screenshot) and after STT (Task 2 stop_recording) ✓
- **Screenshot hides/restores the app window** → Task 2 (capture_screenshot uses `get_webview_window("main").hide()/show()`) ✓
- **Always-on-top: window default on + functional toggle** → Task 2 (tauri.conf.json `alwaysOnTop: true` + `set_always_on_top` command) + Task 3 (titlebar toggle wired) ✓
- **Error toasts for sidecar failures** → CaptureControls + PlaybackControls ✓
- **Screen Recording permission** → handled via generic addToast in Task 8 ✓
- **Whisper-model-missing UX** → v1 uses a generic error toast (conscious deviation from the spec's modal; recorded here) ⚠️
- **azVoiceAssist color theme** → Task 3 (index.css with az-bg, az-accent) ✓
- **Two-panel resizable layout** → Task 3 (App.tsx with PanelGroup) ✓
- **Custom titlebar with traffic lights** → Task 3 ✓
- **CLAUDE.md** → Task 19 ✓
- **Out of scope confirmed:** phoneme-level pronunciation / dropped-ending (GOP) is NOT in any task — deferred to v2 per spec ✓

**Type-consistency check across tasks:** `PacingMetrics` fields (camelCase TS / snake_case Rust + `#[serde(rename_all="camelCase")]`) match between events.rs (Task 2), types/index.ts (Task 4), fluency.rs (Task 15B), mock (Task 4), and FeedbackPanel (Task 18). `Transcription { text, words }` and `WordTimestamp { word, start_ms, end_ms }` defined once in stt.rs (Tasks 2/14), consumed by fluency.rs and commands.rs. `get_feedback(original, transcription, diff, pacing)` signature consistent across stub (Task 2), tests, and impl (Task 16) and call site (Task 2 commands.rs). ✓
