# Third-Party Review: azReadAnalyzer — Settings Panel + Frost/Transparency Controls

**Date:** 2026-06-10  
**Reviewer:** Codex  
**Spec reviewed:** `docs/superpowers/specs/2026-06-10-settings-panel-frost-design.md`  
**Reviewed against:** current source, `2026-06-07-azreadanalyzer-design.md`, `2026-06-09-ui-feedback-round1-design.md`, and the azVoiceAssist transparency/settings reference  

---

## Summary

The proposal is directionally sound. It fits the current round-1 UI state, keeps frost
runtime tuning on the frontend, and correctly avoids adding a backend settings event where
azReadAnalyzer has no long-lived worker thread to notify.

The main gaps are contract details: local-only LLM endpoint handling, ambiguous
Apply/Cancel/Defaults behavior, URL normalization, save ordering, and mock/test support.
These should be tightened before implementation so the settings panel does not drift from
the app's privacy and runtime guarantees.

---

## Findings

### 1. Local-only oMLX endpoint invariant is not explicit

**Severity:** High  
**Location:** spec lines 66-72

The Connection section lets the user edit the LLM Base URL, and the current `llm.rs`
payload includes the original text, transcription, Rust-computed diff, and pacing metrics.
The broader app contract is still 100% on-device, and the intended deployment is local
oMLX.

The spec currently describes this as a generic LLM/oMLX config field. A future implementer
could treat it as any OpenAI-compatible remote endpoint, which would violate the app's
privacy model.

**Recommendation:** Rename the UI field to **Local oMLX Base URL** and define a local-only
validation rule. Accept loopback hosts such as `127.0.0.1`, `localhost`, and `::1`; reject
or at least strongly warn on non-loopback hosts. Keep the default
`http://127.0.0.1:8002/v1`.

### 2. Appearance Cancel semantics conflict with instant persistence

**Severity:** Medium  
**Location:** spec lines 57, 63, 72

The panel can be dismissed with Cancel, but Appearance changes are also specified to apply
and persist instantly on every preset click or slider tick. That makes Cancel ambiguous:
does it revert frost preview changes, or does it only discard unapplied Connection edits?

**Recommendation:** Define Cancel precisely. The simplest contract is: Appearance changes
are live and already persisted; Cancel only closes the panel and discards unsaved
Connection form edits. If reversible preview is desired, specify a snapshot/rollback flow.

### 3. Base URL validation is too loose for the current `llm.rs` call shape

**Severity:** Medium  
**Location:** spec lines 68, 92-95

Validation currently requires only a non-empty Base URL. The implementation appends
`/chat/completions` to the configured base, so malformed strings, trailing slash variants,
or a user pasting a full `/chat/completions` URL can persist successfully and fail later
during analysis.

**Recommendation:** Specify URL parsing and normalization: trim whitespace, trim trailing
slashes, require `http` or `https`, enforce local-only hosts, and treat the stored value as
the API base path ending at `/v1` rather than the full chat completions endpoint.

### 4. `apply_settings` save/update ordering is underspecified

**Severity:** Medium  
**Location:** spec lines 93-101, 111

The spec says `apply_settings` validates, updates `AppState.settings`, and saves
`settings.json`, but it does not define failure ordering. If in-memory settings are updated
before the file write succeeds, the next analysis can use settings the UI reports as failed
or not persisted.

**Recommendation:** Require this order: validate -> write `settings.json` successfully ->
update `AppState.settings`. If the write fails, return `Err` and leave in-memory settings
unchanged.

### 5. `SettingsChanged` language contradicts the later no-event decision

**Severity:** Low  
**Location:** spec lines 27, 103

The goal says the panel mirrors azVoiceAssist's `get_settings` / `apply_settings` /
`SettingsChanged` pattern, but the IPC section correctly says no `SettingsChanged` event is
needed because azReadAnalyzer has no long-lived worker thread consuming settings.

**Recommendation:** Remove `SettingsChanged` from the goal text and state that only
`get_settings` and `apply_settings` are mirrored.

### 6. Defaults behavior is ambiguous with env-seeded settings

**Severity:** Low  
**Location:** spec lines 72, 92

`AppSettings::default()` is env-seeded, but the Connection section also has a Defaults
button. It is unclear whether Defaults restores built-in values or the current environment
defaults, especially for `llm_api_key`.

**Recommendation:** Define Defaults as one of:

- Built-in reset: `http://127.0.0.1:8002/v1`, model `default`, empty key, timeout `45`.
- Environment reset: re-read `OMLX_*` and use built-in fallbacks only when env vars are
  absent.

For privacy and predictability, built-in reset is cleaner unless there is a strong need to
preserve launch-time env configuration.

### 7. Mock/test surface is missing from the file touch list

**Severity:** Low  
**Location:** spec lines 115-136

The spec calls for frontend tests and supports `VITE_USE_MOCK=true`, but the anticipated
file list omits the Tauri invoke mock and mock-mode behavior. Without this, `get_settings`
and `apply_settings` can break component tests or UI-only development.

**Recommendation:** Add mock support to the implementation contract: update
`src/__mocks__/@tauri-apps/api/index.ts` or the relevant test setup so `get_settings`
returns representative defaults and `apply_settings` resolves. If mock-mode UI needs the
panel, provide equivalent behavior there too.

---

## Notes

- The single-root frost layer is a good correction to the round-1 stacked translucency.
- Keeping Appearance persistence in `localStorage` is consistent with the azVoiceAssist
  transparency system and avoids slider-driven IPC/file writes.
- The decision not to put frost settings in Zustand is reasonable because CSS variables are
  the runtime source of truth and there is no cross-component business state to synchronize.
