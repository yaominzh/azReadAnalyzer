# azReadAnalyzer — Setup & Run Guide

A macOS-only Tauri 2 desktop app for English speaking practice: capture text (screenshot OCR or clipboard) → listen to TTS → record yourself reading → get content-accuracy + fluency/pacing feedback. 100% on-device by default (no audio or text leaves the machine unless you point the LLM at a non-local endpoint).

The app talks to **four external pieces**. Each is **optional** — the app degrades gracefully when one is missing (it shows a toast and continues; e.g. no TTS → "Read Aloud" is unavailable, but recording/feedback still work).

| Piece | Port | Needed for |
|-------|------|-----------|
| TTS sidecar (Qwen3-TTS) | `:8123` | "Read Aloud" (listen to the text) |
| OCR sidecar (macOS Vision) | `:8124` | "Screenshot" text capture |
| Whisper model file | — | Recording → transcription (STT) |
| Local LLM (OpenAI-compatible) | `:8002`* | AI score + coaching comments |

\* default; configurable.

---

## Prerequisites (macOS, Apple Silicon)

- **Node** 18+ (tested on v25), **Rust** stable (tested 1.94), **Python** 3.11/3.12, **cmake**, **Xcode Command Line Tools** (`xcode-select --install`).
- Tauri CLI is invoked via `npx tauri` (no global install needed).

```bash
git clone <this repo> && cd azReadAnalyzer
npm install        # frontend deps
```

---

## 1. TTS service (`:8123`) — Qwen3-TTS via MLX-Audio

Reused verbatim from **azVoiceAssist**. `mlx_audio` provides the synthesis; it loads the model at startup (first run downloads the Qwen3-TTS weights, ~GBs).

**If `mlx_audio` is already installed in your Python** (e.g. Homebrew Python — check with `python3 -c "import mlx_audio"`), just run it directly:

```bash
cd tts_service
/opt/homebrew/bin/uvicorn server:app --port 8123     # or any python3 that has mlx_audio
```

**Otherwise, create a venv:**

```bash
cd tts_service
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt            # mlx_audio, fastapi, uvicorn
.venv/bin/uvicorn server:app --port 8123
```

Verify (returns a WAV):
```bash
curl -s -X POST http://127.0.0.1:8123/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello, testing."}' --output /tmp/test.wav && afplay /tmp/test.wav
```

> Note: `server.py` exposes only `POST /tts` (no `/health`). A 404 on `/health` just means the server is up.

---

## 2. OCR service (`:8124`) — macOS Vision

FastAPI wrapper around the macOS Vision framework (via PyObjC). Used by the "Screenshot" button.

```bash
cd ocr_service
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt            # fastapi, uvicorn, pyobjc Vision/Quartz
.venv/bin/uvicorn server:app --port 8124
```

Verify:
```bash
curl -s http://127.0.0.1:8124/health                 # {"status":"ok"}
```

---

## 3. Whisper model (one-time, ~141 MB)

Speech-to-text runs in-process via `transcribe-rs` (whisper.cpp). It expects the English base model here:

```bash
mkdir -p ~/.azreadanalyzer/models
curl -L -o ~/.azreadanalyzer/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Without it, recording works but transcription fails with "Whisper not loaded".

---

## 4. Local LLM (OpenAI-compatible)

The LLM receives the Rust-computed diff + pacing and returns only a score + coaching comments. Any OpenAI-compatible server works (oMLX, llama.cpp, Ollama at `…/v1`, etc.).

**Two ways to configure it (settings file wins over env):**

- **In-app (recommended):** launch the app → **⚙ Settings → Connection** → set Base URL / Model / API key / Timeout → **Apply**. This persists to `~/.azreadanalyzer/settings.json` and is used by the next analysis. Non-loopback hosts prompt an off-device confirmation (your text would leave the machine).
- **Env vars (seed the first-run defaults):** if there's no `settings.json` yet, these populate the panel's defaults:

```bash
export OMLX_BASE_URL="http://127.0.0.1:8002/v1"
export OMLX_API_KEY="your-key"        # empty if your server needs none
export OMLX_MODEL="your-model-id"
export OMLX_TIMEOUT_SECS="45"         # optional, 5–300
```

If the LLM is unreachable, the app still shows the local diff + pacing (score/comments are suppressed).

---

## 5. Run the app

```bash
# Dev (hot reload). Pass the LLM env if you haven't saved settings.json yet:
OMLX_BASE_URL="http://127.0.0.1:8002/v1" OMLX_API_KEY="…" OMLX_MODEL="…" npx tauri dev

# Production build
npm run build && npx tauri build
```

The window opens always-on-top with a custom frosted titlebar.

---

## macOS permissions (grant once)

- **Microphone** — prompted on first **Record**. Grant it.
- **Screen Recording** — required for the **Screenshot** capture (`screencapture -i`). System Settings → Privacy & Security → Screen Recording → enable your terminal/the app, then relaunch.

---

## Appearance / frost

The frosted-glass look is tunable at runtime: **⚙ Settings → Appearance** → presets (Solid / Frosted / Glass) or the **Advanced** opacity/blur sliders. These apply instantly and persist in the browser `localStorage` (not in `settings.json`) — no restart needed.

---

## Files that hold your state

| Path | What | Set by |
|------|------|--------|
| `~/.azreadanalyzer/models/ggml-base.en.bin` | Whisper model | one-time download |
| `~/.azreadanalyzer/settings.json` | LLM connection settings | ⚙ Settings → Apply |
| browser `localStorage` (`az.frost.*`) | frost opacity/blur | ⚙ Settings → Appearance |

Temp recording WAVs and screenshot PNGs use unique temp paths and are auto-deleted after use.

---

## Ports

| Service | Port |
|---------|------|
| Vite dev server | 1420 |
| TTS sidecar | 8123 |
| OCR sidecar | 8124 |
| Local LLM | 8002 (default) |

---

## Tests

```bash
npm test                 # vitest (frontend)
npm run lint             # eslint
npx tsc -b               # typecheck
cd src-tauri && cargo test --lib    # Rust unit tests (diff, fluency, settings, llm, …)
```

The OCR integration test is `#[ignore]`d (needs the sidecar running): `cargo test capture::tests::ocr_sidecar_reachable -- --ignored`.

---

## Troubleshooting

- **"TTS service not running"** → start the `:8123` sidecar (§1). Remember `mlx_audio` may already be in your Homebrew Python, so a missing `tts_service/.venv` doesn't mean TTS is unavailable.
- **"OCR service not running"** → start the `:8124` sidecar (§2).
- **"Whisper not loaded"** → download the model (§3); restart the app (the model loads at startup).
- **No score / "AI coach unavailable"** → the LLM endpoint is unreachable or returned non-JSON; check ⚙ Settings → Connection. Diff + pacing still render.
- **Screenshot does nothing** → grant Screen Recording permission, then relaunch.
- **Frost looks flat** → open ⚙ Settings → Appearance and lower the opacity / raise the blur (or pick the Glass preset).
