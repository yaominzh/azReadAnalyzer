# Iteration 1 Plan — Window Controls (#1) + Frosted Glass (#2)

**Spec:** [2026-06-09-ui-feedback-round1-design.md](../specs/2026-06-09-ui-feedback-round1-design.md) goals #1, #2
**Branch:** `260609-bugfix`
**Why paired:** both touch the window chrome (`tauri.conf.json`, `App.tsx` titlebar, `index.css`, capabilities) and must be verified together in one live launch.

**Goal of this iteration:** the app window can be closed/dragged/resized via the custom titlebar, and the UI is a frosted translucent glass card (azVoiceAssist parity).

---

## Task 1 — Window config: transparent + private API (#2)

**Files:** `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`

- [ ] **tauri.conf.json** — in the `main` window object add `"transparent": true` and `"shadow": false` (TPM open-Q2: with a transparent decorationless window + CSS `border-radius`, macOS would otherwise draw a square shadow behind the rounded card; `shadow:false` gives a clean rounded silhouette like azVoiceAssist). In `app` add `"macOSPrivateApi": true` (top-level `app` object, NOT inside the window). Keep `decorations: false`, `resizable: true`, `alwaysOnTop: true`. (Verified: `withGlobalTauri`/CSP unchanged — not required for drag/frost.)
- [ ] **Cargo.toml** — change `tauri = { version = "2.10.3", features = [] }` → `features = ["macos-private-api"]`.
- [ ] Verify: `cd src-tauri && cargo check` compiles.

## Task 2 — Window control permissions (#1)

**Files:** `src-tauri/capabilities/default.json`

- [ ] Add to `permissions`: `core:window:allow-close`, `core:window:allow-minimize`, `core:window:allow-toggle-maximize`, `core:window:allow-start-dragging`. (`allow-set-always-on-top`, `allow-hide`, `allow-show`, `allow-set-focus` already present from v1 — keep.)
- [ ] These identifiers verified present in `src-tauri/gen/schemas/acl-manifests.json`.

## Task 3 — Functional titlebar: drag + traffic lights (#1)

**Files:** `src/App.tsx`

> **TPM M1 (blocking):** `getCurrentWindow()` dereferences `window.__TAURI_INTERNALS__` **at call time** and throws `TypeError` outside the Tauri webview (browser dev / jsdom). So do **NOT** call it at module/component top level — call it lazily *inside each handler*, wrapped in try/catch. Importing the symbol is safe; only the call throws.

- [ ] Import `getCurrentWindow` from `@tauri-apps/api/window` (top-level import only — no top-level call).
- [ ] Add `data-tauri-drag-region` to the titlebar container `<div>`. Remove reliance on the `.titlebar { -webkit-app-region }` CSS (the class can stay for styling but drag now comes from the attribute).
- [ ] Replace the 3 decorative traffic-light `<div>`s with `<button>`s (keep the colored dot look). Each onClick calls a lazy, guarded helper: red → `try { getCurrentWindow().close() } catch {}`, amber → `minimize()`, green → `toggleMaximize()`.
- [ ] **TPM M3:** interactive children of the drag region — the 3 traffic-light buttons **and the existing always-on-top toggle button** (currently `App.tsx:38`) — each get `onMouseDown={(e) => e.stopPropagation()}` so the parent drag region doesn't swallow their clicks. (Do NOT use `data-tauri-drag-region={false}` — it doesn't reliably exempt children.) Add macOS-style hover glyphs (× − +) on the traffic lights via group-hover.
- [ ] **TPM M2:** crash-safety in browser/jsdom comes solely from M1 (handler-gated calls + try/catch), NOT from a mock. The `@tauri-apps/api/window` subpath is not mocked and does not need to be (no test renders `App`; verified). No new mock added this iteration.

## Task 4 — Frosted glass CSS (#2)

**Files:** `src/index.css`, `src/App.tsx`

- [ ] `index.css`: change `body { background: #080808 }` → `body { background: transparent }` (keep `overflow:hidden`, height). Drop the `-webkit-app-region` rules (now using `data-tauri-drag-region`).
- [ ] `App.tsx`: the root `<div>` (currently `bg-[#080808]`) becomes a rounded translucent frosted card: e.g. `rounded-xl overflow-hidden border border-white/10 bg-[#080808]/70 backdrop-blur-2xl` (tune opacity so the desktop shows through but text stays readable — full azVoiceAssist translucency per spec). The titlebar + panels keep their existing translucent layering.
- [ ] Because the window is transparent + decorationless, the rounded corners now show the desktop behind; ensure no opaque child fills the corners.

## Verification

- [ ] **(TPM S2) cheap config assertions** before the slow launch: assert `tauri.conf.json` has `windows[0].transparent === true`, `windows[0].shadow === false`, `app.macOSPrivateApi === true`; assert `capabilities/default.json` `permissions` contains the 4 new strings. One `node -e` check.
- [ ] `cd src-tauri && cargo check` — compiles with `macos-private-api`.
- [ ] `npm run build` (tsc + vite) — frontend compiles; `npx vitest run` still green (20 tests; App not unit-tested, verified no test renders it).
- [ ] `npx eslint .` clean. (TPM S1: eslint config ignores `src-tauri`, so this validates TS/TSX only — not `tauri.conf.json`; the S2 assertion covers config.)
- [ ] **Live launch** (`npx tauri dev`): window appears as a frosted translucent rounded card; clicking red closes, amber minimizes, green zooms; dragging the titlebar moves the window; dragging an edge resizes. (Window-chrome + frost require human eyes / screenshot — machine checks cover build + launch-without-error + frontend render.)
- [ ] **Resize fallback (TPM Q4, pre-agreed):** if macOS doesn't expose edge-resize on the transparent decorationless window, add a CSS `resize` affordance / thin invisible edge handles calling `getCurrentWindow().startResizeDragging(...)`. Decide at live check.

## Risks / notes

- `transparent: true` + `decorations: false`: macOS edge-resize should still work with `resizable: true`; if the live check shows no resize, fall back to a CSS resize affordance (decide at verification, don't pre-build).
- Interactive children inside a `data-tauri-drag-region` element: clicks on `<button>`/toggle should still fire; if drag swallows clicks, add `onMouseDown={e => e.stopPropagation()}` to the buttons.
- Frost legibility over busy wallpapers is an accepted tradeoff (spec #2).

## Out of scope (this iteration)

Replay (#3) and thumbnail (#4) — later iterations. No analysis-pipeline changes.
