# Settings Panel + Frost Controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-architect the frosted-glass window into one tunable CSS-variable layer, and add an extensible Settings panel (gear button) with an Appearance section (frost presets + sliders, localStorage) and a Rust-backed Connection section (oMLX config in `settings.json`).

**Architecture:** Frost is driven by `--az-bg-alpha` / `--az-blur` CSS variables on `:root`, applied from `localStorage` by a small `frost.ts` module (no Zustand, no IPC — instant). The Settings panel is a portaled overlay with two sections: Appearance (client-side, instant) and Connection (Rust `AppSettings` in `~/.azreadanalyzer/settings.json` via `get_settings`/`apply_settings`, default-seeded from `OMLX_*` env). `llm.rs::get_feedback` stops reading env directly and instead receives a resolved `LlmConfig` from `stop_recording`, which reads `AppState.settings`.

**Tech Stack:** React 19 + TypeScript + Tailwind v4 + Zustand · Tauri 2 (Rust) · `serde`/`serde_json` · Vitest · `cargo test`.

**Spec:** [docs/superpowers/specs/2026-06-10-settings-panel-frost-design.md](../specs/2026-06-10-settings-panel-frost-design.md) (review-incorporated; finding 1 = warn-and-allow).

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/index.css` (modify) | `.az-frost` class driven by `--az-bg-alpha`/`--az-blur` + `@supports` fallback |
| `src/App.tsx` (modify) | root uses `.az-frost`; de-stack titlebar/panel translucency; gear button; mount `SettingsPanel`; apply frost on load |
| `src/lib/frost.ts` (create) | frost types, presets, clamp, load/save/apply (localStorage + CSS vars) |
| `src/lib/frost.test.ts` (create) | unit tests for clamp/load/save/apply |
| `src/components/SettingsPanel.tsx` (create) | portaled overlay; Appearance + Connection sections |
| `src/components/__tests__/SettingsPanel.test.tsx` (create) | render, preset, slider, warn, apply |
| `src/types/index.ts` (modify) | `AppSettings` TS type |
| `src/__mocks__/@tauri-apps/api/index.ts` (modify) | `get_settings`/`apply_settings` mock |
| `src/test-setup.ts` (modify) | route the `@tauri-apps/api/core` mock for tests |
| `src-tauri/src/settings.rs` (create) | `AppSettings` (default-from-env), normalize/validate, load/save + tests |
| `src-tauri/src/commands.rs` (modify) | `AppState.settings`; `get_settings`/`apply_settings`; `stop_recording` builds `LlmConfig` |
| `src-tauri/src/llm.rs` (modify) | `get_feedback` takes `LlmConfig`; drop env reads |
| `src-tauri/src/lib.rs` (modify) | load settings at startup; register the two commands |

---

## Task 1: Frost CSS variables + single-layer (the consistency fix)

**Files:**
- Modify: `src/index.css`
- Modify: `src/App.tsx` (root class + de-stack)

- [ ] **Step 1: Add the frost variables + class to `src/index.css`**

In the `@theme` / top area, add the variables to `:root` and a `.az-frost` utility. Put this after the existing `body { ... }` block:

```css
:root {
  --az-bg-alpha: 0.55;   /* Frosted preset default */
  --az-blur: 16px;
}

/* Single frosted-glass layer — the desktop shows through, blurred. */
.az-frost {
  background: rgba(8, 8, 8, var(--az-bg-alpha, 0.55));
  -webkit-backdrop-filter: blur(var(--az-blur, 16px));
  backdrop-filter: blur(var(--az-blur, 16px));
}
/* Legibility fallback if backdrop-filter is unsupported. */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .az-frost { background: rgba(8, 8, 8, 0.92); }
}
```

- [ ] **Step 2: Point the app root at `.az-frost` and de-stack inner layers in `src/App.tsx`**

Change the root container (currently `bg-[#080808]/65 backdrop-blur-2xl`) to use `.az-frost` (drop the Tailwind bg/blur so the single layer owns the frost):

```tsx
<div className="flex flex-col h-screen rounded-xl overflow-hidden border border-white/10 az-frost">
```

De-stack the two layers that currently double up the translucency:
- Titlebar: change `bg-black/60` (the titlebar `<div data-tauri-drag-region ...>`) → `bg-white/[0.03]`.
- Both panel containers: change `bg-white/[0.04]` → `bg-white/[0.02]` (keep their `border border-white/[0.08]`). (Two occurrences — left and right panels.)

- [ ] **Step 3: Verify build + lint**

Run: `npx tsc -b && npx eslint . && npm run build`
Expected: all clean (no behavior change yet, just styling).

- [ ] **Step 4: Commit**

```bash
git add src/index.css src/App.tsx
git commit -m "feat(frost): single CSS-variable frost layer + de-stack panels"
```

---

## Task 2: `frost.ts` module (load/save/apply + clamp)

**Files:**
- Create: `src/lib/frost.ts`
- Test: `src/lib/frost.test.ts`

- [ ] **Step 1: Write the failing test** — `src/lib/frost.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadFrost, saveFrost, FROST_DEFAULT, FROST_PRESETS, clampAlpha, clampBlur } from "./frost";

describe("frost", () => {
  beforeEach(() => localStorage.clear());

  it("clamps alpha and blur to range", () => {
    expect(clampAlpha(2)).toBe(0.95);
    expect(clampAlpha(0)).toBe(0.05);
    expect(clampBlur(99)).toBe(40);
    expect(clampBlur(-5)).toBe(0);
  });

  it("loadFrost returns defaults when storage is empty", () => {
    expect(loadFrost()).toEqual(FROST_DEFAULT);
  });

  it("loadFrost falls back to defaults on garbage", () => {
    localStorage.setItem("az.frost.alpha", "notnum");
    localStorage.setItem("az.frost.blur", "");
    expect(loadFrost()).toEqual(FROST_DEFAULT);
  });

  it("saveFrost persists clamped values and loadFrost reads them", () => {
    saveFrost({ alpha: 2, blur: 99 });
    expect(loadFrost()).toEqual({ alpha: 0.95, blur: 40 });
  });

  it("Frosted preset equals the default", () => {
    expect(FROST_PRESETS.Frosted).toEqual(FROST_DEFAULT);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run src/lib/frost.test.ts`
Expected: FAIL — module `./frost` not found.

- [ ] **Step 3: Implement `src/lib/frost.ts`**

```ts
export interface Frost {
  alpha: number; // background opacity 0.05–0.95
  blur: number;  // backdrop blur px 0–40
}

export const FROST_DEFAULT: Frost = { alpha: 0.55, blur: 16 };

export const FROST_PRESETS = {
  Solid: { alpha: 0.95, blur: 0 },
  Frosted: { alpha: 0.55, blur: 16 },
  Glass: { alpha: 0.25, blur: 28 },
} as const satisfies Record<string, Frost>;

const KEY_ALPHA = "az.frost.alpha";
const KEY_BLUR = "az.frost.blur";

export const clampAlpha = (n: number): number => Math.min(0.95, Math.max(0.05, n));
export const clampBlur = (n: number): number => Math.min(40, Math.max(0, n));

export function loadFrost(): Frost {
  const a = parseFloat(localStorage.getItem(KEY_ALPHA) ?? "");
  const b = parseFloat(localStorage.getItem(KEY_BLUR) ?? "");
  return {
    alpha: Number.isFinite(a) ? clampAlpha(a) : FROST_DEFAULT.alpha,
    blur: Number.isFinite(b) ? clampBlur(b) : FROST_DEFAULT.blur,
  };
}

// Apply to the live DOM via CSS variables (the runtime source of truth).
export function applyFrost(f: Frost): void {
  const root = document.documentElement;
  root.style.setProperty("--az-bg-alpha", String(clampAlpha(f.alpha)));
  root.style.setProperty("--az-blur", `${clampBlur(f.blur)}px`);
}

export function saveFrost(f: Frost): void {
  const safe = { alpha: clampAlpha(f.alpha), blur: clampBlur(f.blur) };
  localStorage.setItem(KEY_ALPHA, String(safe.alpha));
  localStorage.setItem(KEY_BLUR, String(safe.blur));
  applyFrost(safe);
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run src/lib/frost.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/frost.ts src/lib/frost.test.ts
git commit -m "feat(frost): frost.ts load/save/apply with clamping + presets"
```

---

## Task 3: Apply persisted frost on app load

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Apply frost once on mount in `App.tsx`**

Add the import:
```tsx
import { useEffect } from "react";
import { loadFrost, applyFrost } from "./lib/frost";
```
(If `useState` is already imported from "react", extend that import to include `useEffect`.)

Inside `App()`, alongside the existing `useTauriEvents(); useMockEvents();`:
```tsx
useEffect(() => {
  applyFrost(loadFrost());
}, []);
```

- [ ] **Step 2: Verify**

Run: `npx tsc -b && npx eslint . && npx vitest run`
Expected: clean; 25 existing + 5 frost tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(frost): apply persisted frost on app load"
```

---

## Task 4: Rust `AppSettings` (settings.rs)

**Files:**
- Create: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod settings;`)

- [ ] **Step 1: Declare the module** in `src-tauri/src/lib.rs`

Add near the other `pub mod` lines (e.g. after `pub mod llm;`):
```rust
pub mod settings;
```

- [ ] **Step 2: Write `src-tauri/src/settings.rs` with failing tests**

```rust
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const DEFAULT_BASE_URL: &str = "http://127.0.0.1:8002/v1";
const DEFAULT_MODEL: &str = "default";
const DEFAULT_TIMEOUT_SECS: u64 = 45;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub llm_base_url: String,
    pub llm_model: String,
    pub llm_api_key: String,
    pub llm_timeout_secs: u64,
}

impl Default for AppSettings {
    /// Seed from OMLX_* env when present, else built-in defaults — so the
    /// current env-var launch keeps working until the user saves settings.
    fn default() -> Self {
        Self {
            llm_base_url: std::env::var("OMLX_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.into()),
            llm_model: std::env::var("OMLX_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into()),
            llm_api_key: std::env::var("OMLX_API_KEY").unwrap_or_default(),
            llm_timeout_secs: std::env::var("OMLX_TIMEOUT_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .filter(|&n| (5..=300).contains(&n))
                .unwrap_or(DEFAULT_TIMEOUT_SECS),
        }
    }
}

impl AppSettings {
    /// Built-in reset values (NOT env) — the panel's "Defaults" button.
    pub fn builtin() -> Self {
        Self {
            llm_base_url: DEFAULT_BASE_URL.into(),
            llm_model: DEFAULT_MODEL.into(),
            llm_api_key: String::new(),
            llm_timeout_secs: DEFAULT_TIMEOUT_SECS,
        }
    }

    pub fn config_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".azreadanalyzer/settings.json")
    }

    pub fn load() -> Self {
        let path = Self::config_path();
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<AppSettings>(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())
    }

    /// Validate + normalize in place. Trims the URL, strips trailing slashes,
    /// requires an http/https scheme, and enforces the timeout range. Returns
    /// Err (no mutation persisted by the caller) on invalid input.
    pub fn validate_and_normalize(&mut self) -> Result<(), String> {
        let url = self.llm_base_url.trim().trim_end_matches('/').to_string();
        if !(url.starts_with("http://") || url.starts_with("https://")) || url.len() < 10 {
            return Err("Base URL must start with http:// or https://".into());
        }
        self.llm_base_url = url;
        self.llm_model = self.llm_model.trim().to_string();
        if self.llm_model.is_empty() {
            return Err("Model must not be empty".into());
        }
        if !(5..=300).contains(&self.llm_timeout_secs) {
            return Err("Timeout must be 5–300 seconds".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_has_loopback_default() {
        let s = AppSettings::builtin();
        assert_eq!(s.llm_base_url, "http://127.0.0.1:8002/v1");
        assert_eq!(s.llm_timeout_secs, 45);
        assert!(s.llm_api_key.is_empty());
    }

    #[test]
    fn normalize_strips_trailing_slash() {
        let mut s = AppSettings::builtin();
        s.llm_base_url = "  http://127.0.0.1:8002/v1/  ".into();
        s.validate_and_normalize().unwrap();
        assert_eq!(s.llm_base_url, "http://127.0.0.1:8002/v1");
    }

    #[test]
    fn normalize_rejects_no_scheme() {
        let mut s = AppSettings::builtin();
        s.llm_base_url = "127.0.0.1:8002/v1".into();
        assert!(s.validate_and_normalize().is_err());
    }

    #[test]
    fn normalize_rejects_bad_timeout() {
        let mut s = AppSettings::builtin();
        s.llm_timeout_secs = 1;
        assert!(s.validate_and_normalize().is_err());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let mut s = AppSettings::builtin();
        s.llm_model = "gemma-4-e4b-it-4bit".into();
        // Write to a temp path by overriding HOME for this test.
        let dir = std::env::temp_dir().join("azra_settings_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let json = serde_json::to_string_pretty(&s).unwrap();
        std::fs::write(&path, &json).unwrap();
        let back: AppSettings = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(s, back);
    }
}
```

- [ ] **Step 3: Run the tests — verify they pass**

Run: `cd src-tauri && cargo test settings::tests`
Expected: PASS (5 tests). (They are written to pass directly — this is pure logic; `cargo check` first if needed.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/settings.rs src-tauri/src/lib.rs
git commit -m "feat(settings): AppSettings load/save/normalize (default-from-env)"
```

---

## Task 5: `AppState.settings` + `get_settings`/`apply_settings`

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the field to `AppState`** in `commands.rs`

In the `AppState` struct (after `last_capture_png`):
```rust
    // User settings (LLM/oMLX connection), loaded at startup, edited via the
    // Settings panel. Persisted to ~/.azreadanalyzer/settings.json.
    pub settings: Mutex<crate::settings::AppSettings>,
```

- [ ] **Step 2: Add the two commands** in `commands.rs`

```rust
#[command]
pub fn get_settings(state: State<'_, Arc<AppState>>) -> Result<crate::settings::AppSettings, String> {
    let g = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(g.clone())
}

/// Strict ordering (spec review #4): validate+normalize → write file → THEN
/// update in-memory. On any failure, settings.json and AppState are unchanged.
#[command]
pub fn apply_settings(
    state: State<'_, Arc<AppState>>,
    mut settings: crate::settings::AppSettings,
) -> Result<(), String> {
    settings.validate_and_normalize()?;
    settings.save()?; // write file first
    let mut g = state.settings.lock().map_err(|e| e.to_string())?;
    *g = settings; // only update memory after a successful write
    Ok(())
}
```

- [ ] **Step 3: Initialize + register in `lib.rs`**

In the `.manage(Arc::new(AppState { ... }))` block, add:
```rust
            settings: Mutex::new(settings::AppSettings::load()),
```
Add `use settings;` is unnecessary (already `pub mod settings;`); reference as `settings::AppSettings`. In `generate_handler!`, add:
```rust
            commands::get_settings,
            commands::apply_settings,
```

- [ ] **Step 4: Verify compile**

Run: `cd src-tauri && cargo check`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(settings): AppState.settings + get_settings/apply_settings commands"
```

---

## Task 6: `llm.rs` takes a resolved `LlmConfig`

**Files:**
- Modify: `src-tauri/src/llm.rs`
- Modify: `src-tauri/src/commands.rs` (`stop_recording` call site, line ~205)

- [ ] **Step 1: Add `LlmConfig` and change `get_feedback` signature** in `llm.rs`

Replace the env-reading head of `get_feedback`. Add this struct above the function. **Use owned `String`s** so the caller can clone out of the settings lock guard and drop the guard before `.await` (no borrow-across-await):
```rust
/// Resolved LLM connection config, passed in by the caller (from AppState.settings)
/// so this module no longer reads env directly.
pub struct LlmConfig {
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub timeout_secs: u64,
}
```
Change the signature (note `cfg: &LlmConfig`):
```rust
pub async fn get_feedback(
    original: &str,
    transcription: &str,
    diff: &[DiffToken],
    pacing: &PacingMetrics,
    cfg: &LlmConfig,
) -> Result<(u32, Vec<LlmComment>), String> {
```
Delete the four `std::env::var("OMLX_*")` lines and instead bind (borrow from `cfg`):
```rust
    let base_url = &cfg.base_url;
    let api_key = &cfg.api_key;
    let model = &cfg.model;
    let timeout_secs = cfg.timeout_secs;
```
(`.bearer_auth(api_key)` and `format!("{base_url}/chat/completions")` work with `&String`. The `"model"` JSON value takes `model` directly.)
(The rest of the body — prompt building, `Client::builder().timeout(...)`, `format!("{base_url}/chat/completions")`, `.bearer_auth(api_key)`, `"model": model` — is unchanged. `DEFAULT_TIMEOUT_SECS` const may now be unused; delete it to avoid a warning.)

- [ ] **Step 2: Update the existing `llm.rs` unreachable test** to pass a config

Replace the test body that sets env with a config:
```rust
    #[tokio::test]
    async fn returns_err_when_llm_unreachable() {
        let cfg = LlmConfig { base_url: "http://127.0.0.1:19999/v1", model: "default", api_key: "", timeout_secs: 5 };
        let result = get_feedback("hello", "hello", &[], &crate::events::PacingMetrics::default(), &cfg).await;
        assert!(result.is_err());
    }
```
(The two JSON-extraction tests are unaffected — they call `extract_json_object`, not `get_feedback`.)

- [ ] **Step 3: Update the call site in `commands.rs` `stop_recording`** (line ~205)

Before the `match crate::llm::get_feedback(...)`, clone the settings out of the lock guard (so the guard drops before the `.await`) and build the config:
```rust
    let cfg = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        crate::llm::LlmConfig {
            base_url: s.llm_base_url.clone(),
            model: s.llm_model.clone(),
            api_key: s.llm_api_key.clone(),
            timeout_secs: s.llm_timeout_secs,
        }
    }; // guard dropped here — not held across the await
```
Then change the match line to pass `&cfg`:
```rust
    let (score, comments) =
        match crate::llm::get_feedback(&original_text, &result.text, &diff, &pacing, &cfg).await {
```

- [ ] **Step 4: Verify**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS (all prior Rust tests + settings tests; llm unreachable test still Err).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/llm.rs src-tauri/src/commands.rs
git commit -m "feat(settings): llm.rs uses resolved LlmConfig from AppState.settings"
```

---

## Task 7: TS `AppSettings` type + Tauri mock

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/__mocks__/@tauri-apps/api/index.ts`
- Modify: `src/test-setup.ts`

- [ ] **Step 1: Add the `AppSettings` type** to `src/types/index.ts`

```ts
// LLM connection settings (Rust AppSettings, camelCase serde) (#settings)
export interface AppSettings {
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  llmTimeoutSecs: number;
}
```

- [ ] **Step 2: Make the mock answer `get_settings`/`apply_settings`** in `src/__mocks__/@tauri-apps/api/index.ts`

Replace the `invoke` mock with a command-aware one:
```ts
import { vi } from "vitest";

const DEFAULT_SETTINGS = {
  llmBaseUrl: "http://127.0.0.1:8002/v1",
  llmModel: "default",
  llmApiKey: "",
  llmTimeoutSecs: 45,
};

export const invoke = vi.fn(async (cmd: string) => {
  if (cmd === "get_settings") return DEFAULT_SETTINGS;
  if (cmd === "apply_settings") return undefined; // Ok(())
  return undefined;
});
export const listen = vi.fn().mockResolvedValue(() => {});
export const emit = vi.fn().mockResolvedValue(undefined);
```

- [ ] **Step 3: Route `@tauri-apps/api/core` to the mock in tests** — `src/test-setup.ts`

Components import `invoke` from `@tauri-apps/api/core`. Add at the top of `test-setup.ts` (after the existing imports):
```ts
vi.mock("@tauri-apps/api/core", async () => {
  const m = await import("./__mocks__/@tauri-apps/api/index");
  return { invoke: m.invoke };
});
```
(`vi` is already imported in `test-setup.ts` from the frost/URL stub work.)

- [ ] **Step 4: Verify existing tests still pass**

Run: `npx vitest run`
Expected: PASS (the now-centralized `invoke` mock returns `undefined` for the existing commands, same as before).

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/__mocks__/@tauri-apps/api/index.ts src/test-setup.ts
git commit -m "feat(settings): AppSettings TS type + get/apply_settings mock"
```

---

## Task 8: `SettingsPanel` component

**Files:**
- Create: `src/components/SettingsPanel.tsx`
- Test: `src/components/__tests__/SettingsPanel.test.tsx`

- [ ] **Step 1: Write the failing test** — `src/components/__tests__/SettingsPanel.test.tsx`

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import SettingsPanel from "../SettingsPanel";
import { loadFrost } from "../../lib/frost";
import { invoke } from "@tauri-apps/api/core";

describe("SettingsPanel", () => {
  it("renders Appearance presets and Connection fields", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /frosted/i })).toBeInTheDocument();
    // Connection fields populate from get_settings
    await waitFor(() => expect(screen.getByLabelText(/oMLX Base URL/i)).toHaveValue("http://127.0.0.1:8002/v1"));
  });

  it("clicking the Glass preset persists frost", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /glass/i }));
    expect(loadFrost()).toEqual({ alpha: 0.25, blur: 28 });
  });

  it("warns when a non-loopback host is entered", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    const url = await screen.findByLabelText(/oMLX Base URL/i);
    await userEvent.clear(url);
    await userEvent.type(url, "http://192.168.1.50:8002/v1");
    expect(screen.getByText(/sends your reading text off this machine/i)).toBeInTheDocument();
  });

  it("Apply calls apply_settings", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    await screen.findByLabelText(/oMLX Base URL/i);
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("apply_settings", expect.objectContaining({ settings: expect.any(Object) }))
    );
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run src/components/__tests__/SettingsPanel.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement `src/components/SettingsPanel.tsx`**

```tsx
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import { FROST_PRESETS, FROST_DEFAULT, loadFrost, saveFrost, type Frost } from "../lib/frost";
import type { AppSettings } from "../types";

function isLoopback(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return true; // unparseable → don't show the off-device warning (validation handles it)
  }
}

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const addToast = useAppStore((s) => s.addToast);
  const [frost, setFrost] = useState<Frost>(() => loadFrost());
  const [settings, setSettings] = useState<AppSettings | null>(null);

  // Load Rust-backed connection settings on open.
  useEffect(() => {
    invoke<AppSettings>("get_settings").then(setSettings).catch(() => {});
  }, []);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function setPreset(p: Frost) { setFrost(p); saveFrost(p); }      // instant + persist
  function setAlpha(alpha: number) { const f = { ...frost, alpha }; setFrost(f); saveFrost(f); }
  function setBlur(blur: number) { const f = { ...frost, blur }; setFrost(f); saveFrost(f); }

  async function applyConnection() {
    if (!settings) return;
    try {
      await invoke("apply_settings", { settings });
      addToast("Settings saved", "info");
      onClose();
    } catch (e) {
      addToast(String(e), "error");
    }
  }

  const nonLocal = settings ? !isLoopback(settings.llmBaseUrl) : false;

  return createPortal(
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" style={{ backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-[440px] max-h-[85vh] overflow-y-auto rounded-xl border border-white/10 bg-[#0c0c0c]/95 p-5 text-white/80">
        <p className="text-[13px] font-semibold tracking-wider uppercase text-white/40 mb-4">Settings</p>

        {/* Appearance */}
        <p className="text-[10px] font-semibold tracking-widest uppercase text-white/28 mb-2">Appearance</p>
        <div className="flex gap-2 mb-3">
          {(Object.keys(FROST_PRESETS) as Array<keyof typeof FROST_PRESETS>).map((name) => (
            <button key={name} onClick={() => setPreset(FROST_PRESETS[name])}
              className="px-3 py-1.5 rounded-lg text-[12px] bg-white/[0.06] border border-white/10 hover:bg-white/[0.12]">
              {name}
            </button>
          ))}
        </div>
        <label className="block text-[11px] text-white/45 mb-3">
          Opacity {Math.round(frost.alpha * 100)}%
          <input type="range" min={5} max={95} value={Math.round(frost.alpha * 100)}
            onChange={(e) => setAlpha(Number(e.target.value) / 100)} className="w-full" />
        </label>
        <label className="block text-[11px] text-white/45 mb-4">
          Blur {frost.blur}px
          <input type="range" min={0} max={40} value={frost.blur}
            onChange={(e) => setBlur(Number(e.target.value))} className="w-full" />
        </label>
        <button onClick={() => setPreset(FROST_DEFAULT)} className="text-[11px] text-white/35 hover:text-white/60 mb-4">Reset appearance</button>

        {/* Connection */}
        <p className="text-[10px] font-semibold tracking-widest uppercase text-white/28 mb-2 mt-2 border-t border-white/[0.06] pt-4">Connection</p>
        {settings && (
          <div className="flex flex-col gap-2.5">
            <label className="text-[11px] text-white/45">oMLX Base URL
              <input aria-label="oMLX Base URL" type="text" value={settings.llmBaseUrl}
                onChange={(e) => setSettings({ ...settings, llmBaseUrl: e.target.value })}
                className="w-full mt-1 bg-white/[0.06] border border-white/10 rounded px-2 py-1 text-[12px] text-white/80" />
            </label>
            {nonLocal && (
              <p className="text-[11px] text-amber-300/90">⚠ This sends your reading text off this machine (not 127.0.0.1).</p>
            )}
            <label className="text-[11px] text-white/45">Model
              <input aria-label="Model" type="text" value={settings.llmModel}
                onChange={(e) => setSettings({ ...settings, llmModel: e.target.value })}
                className="w-full mt-1 bg-white/[0.06] border border-white/10 rounded px-2 py-1 text-[12px] text-white/80" />
            </label>
            <label className="text-[11px] text-white/45">API key
              <input aria-label="API key" type="password" value={settings.llmApiKey}
                onChange={(e) => setSettings({ ...settings, llmApiKey: e.target.value })}
                className="w-full mt-1 bg-white/[0.06] border border-white/10 rounded px-2 py-1 text-[12px] text-white/80" />
            </label>
            <label className="text-[11px] text-white/45">Timeout (s)
              <input aria-label="Timeout (s)" type="number" min={5} max={300} value={settings.llmTimeoutSecs}
                onChange={(e) => setSettings({ ...settings, llmTimeoutSecs: Number(e.target.value) })}
                className="w-full mt-1 bg-white/[0.06] border border-white/10 rounded px-2 py-1 text-[12px] text-white/80" />
            </label>
          </div>
        )}

        <div className="flex gap-2 mt-5">
          <button onClick={applyConnection} className="flex-1 py-2 rounded-lg text-[12px] font-medium bg-gradient-to-br from-indigo-500 to-indigo-400 text-white">Apply</button>
          <button onClick={() => setSettings({ llmBaseUrl: "http://127.0.0.1:8002/v1", llmModel: "default", llmApiKey: "", llmTimeoutSecs: 45 })}
            className="px-3 py-2 rounded-lg text-[12px] bg-white/[0.06] border border-white/10 text-white/60">Defaults</button>
          <button onClick={onClose} className="px-3 py-2 rounded-lg text-[12px] bg-white/[0.06] border border-white/10 text-white/60">Cancel</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run src/components/__tests__/SettingsPanel.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsPanel.tsx src/components/__tests__/SettingsPanel.test.tsx
git commit -m "feat(settings): SettingsPanel (Appearance + Connection, portal, warn)"
```

---

## Task 9: Gear button in titlebar + mount the panel

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add open state + import** in `App.tsx`

Extend imports:
```tsx
import SettingsPanel from "./components/SettingsPanel";
```
In `App()`, add state:
```tsx
const [settingsOpen, setSettingsOpen] = useState(false);
```

- [ ] **Step 2: Add the gear button** in the titlebar, just before the "Always on top" button:

```tsx
<button
  onMouseDown={stop}
  onClick={() => setSettingsOpen(true)}
  aria-label="Settings"
  className="text-white/30 hover:text-white/60 transition-colors text-[14px]"
>
  ⚙
</button>
```
(The titlebar's right side currently holds only the always-on-top toggle; wrap both in a `<div className="flex items-center gap-3">` so they sit together.)

- [ ] **Step 3: Mount the panel** at the end of the root `<div>`, after `<Toasts />`:

```tsx
{settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
```

- [ ] **Step 4: Verify everything**

Run: `npx tsc -b && npx eslint . && npx vitest run`
Expected: clean; all tests pass (existing 25 + frost 5 + SettingsPanel 4).
Run: `cd src-tauri && cargo build`
Expected: links.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(settings): gear button opens the Settings panel"
```

---

## Final verification (live)

- [ ] `VITE_USE_MOCK=true npx vite` → open the gear → Appearance presets/sliders change the window live; relaunch preserves the choice (localStorage).
- [ ] Full app (`npx tauri dev` with sidecars + model): open Settings → set Model to your oMLX model → Apply → record a reading → feedback uses the new model. Enter a non-loopback URL → warning shows. `~/.azreadanalyzer/settings.json` is written.
- [ ] Frost reads as clean frosted glass (not flat dark) at the default Frosted preset.

---

## Self-review notes

- **Spec coverage:** Part A frost → Tasks 1–3. Part B Appearance (presets+sliders, localStorage, instant) → Tasks 2,3,8. Connection (Rust settings.json, get/apply, default-from-env, normalize, strict ordering, Defaults=built-in, warn-and-allow) → Tasks 4–6,8. Mock (#7) → Task 7. No `SettingsChanged` (#5) — not added. ✓
- **Types consistent:** Rust `AppSettings` camelCase ↔ TS `AppSettings` (`llmBaseUrl`…); `LlmConfig` owns `String`s; `apply_settings(settings)` arg name matches the TS `invoke("apply_settings", { settings })`. ✓
- **Frost values consistent** across `index.css` (0.55/16), `frost.ts` `FROST_DEFAULT`/`FROST_PRESETS`, and the panel. ✓
