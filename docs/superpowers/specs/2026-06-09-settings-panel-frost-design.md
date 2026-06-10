# azReadAnalyzer — Settings Panel + Frost/Transparency Controls

**Date:** 2026-06-09
**Status:** Approved
**Branch:** `260609-bugfix` (follows the UI-feedback round-1 work)
**Builds on:** [2026-06-09-ui-feedback-round1-design.md](2026-06-09-ui-feedback-round1-design.md) (frost was introduced there, #2)
**Reference:** azVoiceAssist transparency system — `/Users/allen/repo/azVoiceAssist/docs/archi/03-tauri-gui-target.md` (§Transparency system, §Settings panel)
**Review incorporated:** [2026-06-10-settings-panel-frost-design-review.md](../thirdpartyreview/2026-06-10-settings-panel-frost-design-review.md) (Codex) — findings 1–7 evaluated/verified and applied (finding 1 as **warn-and-allow** per user decision, not hard-reject).

> **Privacy note:** the app's "100% on-device" guarantee holds for the default loopback oMLX. Allowing a user-set **non-loopback** endpoint (with an explicit off-device warning + confirm) is a deliberate, user-chosen exception — the reading text is sent to whatever host they configure. The guarantee is the default and the safe path, not an absolute lock.

---

## Overview

Two coupled problems from live testing:
1. The frosted-glass window looks **inconsistent / flat-dark** — the effect is spread across nested translucent layers at high opacity (65%) + heavy blur (40px), so it reads unevenly and depends heavily on what's behind the window.
2. There's **no way to adjust** the look at runtime.

The fix has two parts: (A) re-architect the frost to azVoiceAssist's single-layer, CSS-variable model so it renders cleanly; (B) add an **extensible Settings panel** (gear button → overlay) whose first section, **Appearance**, lets the user tune frost via presets + advanced sliders. Per the user's scope choice, the panel is backed by a real **Rust `settings.json`** (azVoiceAssist pattern), seeded with a **Connection** section (LLM/oMLX config) so the extensible backbone is immediately useful — you set the endpoint in the UI instead of via env vars.

---

## Goals

By the end of this round:

1. **The frost renders cleanly and consistently.** One variable-driven frost layer (not stacked translucency), with sensible defaults. *Success:* the window reads as deliberate frosted glass, not flat dark; verified live.
2. **Appearance is tunable at runtime.** A gear button opens a Settings panel; the Appearance section offers frost **presets** (Solid / Frosted / Glass) plus **advanced** opacity + blur sliders with live preview, persisted across restarts. *Success:* changing a preset/slider updates the window instantly and survives a relaunch.
3. **The Settings panel is extensible and backed by Rust.** A general panel (sections), with a **Connection** section editing LLM settings persisted to a Rust `settings.json`, mirroring azVoiceAssist's `get_settings` / `apply_settings` commands (review #5: **no `SettingsChanged` event** — azReadAnalyzer has no long-lived worker thread to notify; the next `stop_recording` reads the updated `AppState.settings`). *Success:* setting base URL / model / key / timeout in the UI persists and is used by the next analysis — no env var needed.

**Non-goals:** native macOS vibrancy material (we use the CSS approach per azVoiceAssist); per-panel independent frost; theming/accent colors; settings beyond Appearance + Connection (e.g. Whisper model path, TTS speed default) — the panel is *structured* to grow but those are out of scope now.

---

## Part A — Frost re-architecture (the consistency fix)

Mirror azVoiceAssist's three-layer model.

- **Layer 1 — window** (already in place from round 1): `transparent: true`, `macOSPrivateApi: true`, `decorations: false`. `macOSPrivateApi` is what lets `backdrop-filter` blur the desktop. No change.
- **Layer 2 — CSS baseline (single frost layer).** Drive the root app card from two CSS custom properties on `:root`:
  ```css
  :root { --az-bg-alpha: 0.55; --az-blur: 16px; }
  /* app root */ {
    background: rgba(8, 8, 8, var(--az-bg-alpha));
    backdrop-filter: blur(var(--az-blur));
    -webkit-backdrop-filter: blur(var(--az-blur));
  }
  @supports not (backdrop-filter: blur(1px)) {
    /* root */ { background: rgba(8,8,8,0.92); }   /* legible fallback */
  }
  ```
  **Stop stacking translucency:** the titlebar (`bg-black/40`) and the two panels (`bg-white/0.04`) currently each paint their own semi-opaque layer over the blurred root — the main cause of the uneven, flat look. Make the frost live on the **one** root layer; reduce inner panels to hairline borders / near-transparent fills so the single backdrop-blur reads cleanly.
- **Layer 3 — runtime override (see Part B):** the Appearance controls set `--az-bg-alpha` and `--az-blur` (and the inline `backdrop-filter`) live.
- **Defaults (consistent across all layers):** `--az-bg-alpha: 0.55`, `--az-blur: 16px` (the "Frosted" preset). Higher opacity than azVoiceAssist's 22% because this app is content-heavy (two text panels) and must stay legible over any wallpaper.

## Part B — Settings panel

- **Gear ⚙ button** in the titlebar, beside "Always on top" (its own `onMouseDown` stopPropagation, like the other titlebar buttons, since the titlebar is a drag region).
- **Panel:** an overlay (centered modal or slide-up) with its own heavier `backdrop-filter: blur(24px)` for legibility (not user-adjustable), rendered via `createPortal` to `document.body` (the app root's `backdrop-filter` + `overflow-hidden` would otherwise clip/contain a fixed overlay — same lesson as the lightbox). Dismiss on Esc / backdrop click / Cancel. Built as a **sectioned, extensible** component.

### Section 1 — Appearance (client-side, localStorage)
- **Presets** (one click): `Solid` (alpha 0.95, blur 0) · `Frosted` (0.55, 16px — **default**) · `Glass` (0.25, 28px).
- **Advanced** (expandable): Opacity slider 5–95%, Blur slider 0–40px, with **live preview on slide**.
- **Reset to defaults** (back to Frosted).
- **Persistence:** localStorage keys `az.frost.alpha`, `az.frost.blur`. Applied on app load and instantly on every change by setting the CSS variables (and inline `backdrop-filter`). **No Rust round-trip** — instant live preview; an IPC + file write per slider tick would be janky. (This is azVoiceAssist's Layer-3 decision verbatim.)
- Malformed/absent values → fall back to the Frosted defaults.

### Section 2 — Connection (Rust-backed, settings.json)
Edits the LLM/oMLX config currently supplied via env vars:
- **oMLX Base URL** (text, default `http://127.0.0.1:8002/v1`). **(review #1 — privacy)** The app's guarantee is on-device *by default*; this field defaults to loopback. If the user enters a **non-loopback** host (not `127.0.0.1` / `localhost` / `::1`), the panel shows a clear inline warning — "this sends your reading text off this machine" — and requires explicit confirmation, but **allows** it (the user's documented setup includes a remote/LAN oMLX). So: warn-and-allow, not hard-reject.
- **(review #3 — normalization)** On Apply, the URL is normalized: trim whitespace, strip trailing slash(es), require an `http`/`https` scheme, and treat the stored value as the API **base** (ending at `/v1`) — `llm.rs` appends `/chat/completions`. Reject (toast) a value with no scheme or that isn't parseable.
- **Model** (text, default `default`)
- **API key** (password field, default empty)
- **Timeout (s)** (number 5–300, default 45)
- **Apply** validates + persists (see ordering below) and the new config is used by the next analysis.
- **(review #6) Defaults** = **built-in reset** (not env): `http://127.0.0.1:8002/v1`, model `default`, empty key, timeout `45`. (Predictable + privacy-safe; doesn't silently re-pull whatever env the app was launched with.)
- **(review #2) Cancel** = close the panel and **discard unsaved Connection form edits**. It does NOT revert Appearance — those are live and already persisted (see below). Connection edits only take effect on Apply.

## Persistence architecture (the azVoiceAssist split)

| Setting | Where | Apply timing |
|---------|-------|--------------|
| Frost opacity, blur (Appearance) | **localStorage** (`az.frost.*`) | instant, on change, no Rust |
| LLM base URL / model / key / timeout (Connection) | **Rust `settings.json`** (`~/.azreadanalyzer/settings.json`) | on **Apply** (IPC round-trip) |

### Rust `AppSettings` (new `settings.rs`, mirroring azVoiceAssist)
```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub llm_base_url: String,
    pub llm_model: String,
    pub llm_api_key: String,
    pub llm_timeout_secs: u64,
}
```
- `Default` pulls each field from the matching env var (`OMLX_BASE_URL` / `OMLX_MODEL` / `OMLX_API_KEY` / `OMLX_TIMEOUT_SECS`) when present, else the built-in default — so the current env-var launch keeps working, and the UI can override.
- `load()` reads `~/.azreadanalyzer/settings.json`, falling back to `Default` on absent/parse-error. `save()` writes it (pretty JSON). Validation (review #3): base URL trimmed, trailing slashes stripped, parseable with an `http`/`https` scheme; timeout in 5–300. Non-loopback host is allowed but the *frontend* surfaces the off-device warning (review #1) — the backend does not block it.
- **Managed state:** `AppState` gains `settings: Mutex<AppSettings>` (loaded at startup).
- **`llm::get_feedback` change:** instead of reading env vars itself, it receives the resolved connection config (base_url, model, api_key, timeout) from the caller. `stop_recording` reads `AppState.settings` and passes them in. (This removes the env reads from `llm.rs`; env is now only consulted to seed `AppSettings::default()`.)

### Tauri IPC (new commands)
| Command | Action |
|---------|--------|
| `get_settings() -> AppSettings` | returns current in-memory settings (for panel load) |
| `apply_settings(settings: AppSettings) -> Result<(), String>` | **(review #4 — strict ordering)** validate (incl. URL normalize) → **write `settings.json` successfully → only then update `AppState.settings`**. If validation or the file write fails, return `Err` and leave in-memory settings unchanged (so the next analysis never uses settings the UI reported as failed). |

(No `SettingsChanged` event needed — unlike azVoiceAssist there's no long-lived worker thread to notify; the next `stop_recording` simply reads the updated `AppState.settings`.)

## Error handling

| Scenario | Handling |
|----------|----------|
| localStorage frost values missing/NaN | use Frosted defaults |
| `settings.json` missing / unparseable | `AppSettings::default()` (env → built-in) |
| `apply_settings` invalid (unparseable/no-scheme URL, timeout out of range) | `Err` → toast in panel; neither `settings.json` nor in-memory settings change (review #4 ordering) |
| Non-loopback oMLX host entered | inline warning + explicit confirm in the panel; allowed on confirm (review #1) |
| `backdrop-filter` unsupported | `@supports` fallback to near-opaque bg |
| LLM still unreachable after Apply | existing degradation: diff + pacing shown, score/comments suppressed |

## Testing

- **Frontend:** frost util (clamp opacity/blur to range; apply sets CSS vars); localStorage load/save round-trip with default fallback; Settings panel renders; preset click sets values; slider updates the variable live; Connection fields populate from `get_settings` and Apply calls `apply_settings`; non-loopback host shows the warning + requires confirm. Lightbox-style portal + Esc/backdrop dismiss for the panel.
- **(review #7) Mock support:** the current `src/__mocks__/@tauri-apps/api/index.ts` `invoke` resolves `undefined`, which breaks a panel that reads `get_settings` fields. The SettingsPanel test must mock `invoke` so `get_settings` returns representative defaults and `apply_settings` resolves `Ok`. For `VITE_USE_MOCK` UI-dev, `useMockEvents` (or a mock invoke shim) likewise returns default settings so the panel opens without a backend.
- **Rust:** `AppSettings` default-from-env, `load`/`save` round-trip, validation (reject empty URL / out-of-range timeout) — unit-tested like azVoiceAssist's `settings.rs`.
- **Live:** open Settings; Frosted/Glass/Solid visibly change the window; slider live-previews; relaunch preserves frost; set a bogus then correct Base URL and confirm the next analysis uses it.

## Out of scope

Native vibrancy material; accent/theme colors; per-panel frost; additional settings sections (Whisper model, TTS default speed, recording device) — the panel is structured to add them later, but not now.

## File touch list (anticipated)

- `src/index.css` — `--az-bg-alpha` / `--az-blur` variables, single-layer frost, `@supports` fallback.
- `src/App.tsx` — gear button in titlebar; de-stack panel/titlebar translucency; mount Settings panel; apply persisted frost on load.
- `src/components/SettingsPanel.tsx` (new) — sectioned panel (Appearance + Connection), portal, Esc/backdrop dismiss.
- `src/lib/frost.ts` (new) — read/write/clamp/apply frost (localStorage + CSS vars). Frost lives here + the DOM, **not** in Zustand (no reactive store need — it's applied directly to CSS variables); the panel reads/writes via this module and keeps its slider values in local component state.
- `src/types/index.ts` — `AppSettings` TS type.
- `src-tauri/src/settings.rs` (new) — `AppSettings` (default-from-env, load/save/validate) + unit tests.
- `src-tauri/src/config.rs` (new or inline) — `~/.azreadanalyzer/settings.json` path helper.
- `src-tauri/src/commands.rs` — `AppState.settings`; `get_settings`, `apply_settings`; `stop_recording` reads settings and passes connection config to `get_feedback`.
- `src-tauri/src/llm.rs` — `get_feedback` takes resolved connection config instead of reading env directly.
- `src-tauri/src/lib.rs` — init `AppState.settings` (load at startup); register `get_settings`, `apply_settings`.
- `src/__mocks__/@tauri-apps/api/index.ts` and/or test setup — **(review #7)** make `invoke("get_settings")` resolve representative defaults and `invoke("apply_settings")` resolve `Ok`, so SettingsPanel tests and `VITE_USE_MOCK` UI-dev work without a backend.
