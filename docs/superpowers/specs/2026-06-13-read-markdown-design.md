# Read from Markdown Files — Design Spec

**Date:** 2026-06-13
**Status:** Approved (brainstorming) — pending implementation plan
**Branch:** `260613-read-md`

## Context

A third text-capture source alongside **Screenshot** (OCR) and **Paste** (clipboard): read text from one or more **local Markdown files**, optionally limited to a line range per file, and turn it into clean read-aloud text for the practice pipeline. The user enters file paths in a text window; the content is assembled in Rust and cleaned by the local LLM into TTS-ready prose, which lands in the practice input box exactly like the other two sources.

This is a reading-practice app: the captured text becomes what the user reads aloud and is scored against (the content diff). So the LLM cleanup is **faithful** — it strips Markdown formatting but preserves wording and meaning; it does not summarize or rephrase.

## Decisions (from brainstorming)

- **Local files only** — no remote URLs. Keeps the app's 100%-on-device stance (the only egress remains the already-configured local LLM).
- **LLM = faithful cleanup**, not summary. Preserve wording/meaning; strip Markdown.
- **Fallback = deterministic Markdown-strip** when the LLM is unreachable/times out, with a toast — the feature still works offline.
- **Input UX:** a textarea, one entry per line.

## User flow

1. A **Read MD** button in the capture bar (next to Paste) opens a modal panel (same portal pattern as `SettingsPanel`).
2. The panel has a **textarea** + **Read** / **Cancel**. The user types **one entry per line**:
   - `/Users/you/notes.md` — the whole file.
   - `/Users/you/ch1.md:10-50` — only lines 10–50 (**1-based, inclusive**).
   - Blank lines are ignored.
3. On **Read**, the frontend calls `invoke("prepare_markdown", { input })` with the raw textarea string, shows a loading state (the LLM call can take seconds), and on success calls `setInputText(result.text)`, closes the panel, and toasts any warnings. The user then proceeds to Listen / Record as usual.

## Architecture — Rust-owned read → clean → text

All file I/O, parsing, concatenation, the LLM call, and the fallback live in Rust (testable; consistent with the app's "deterministic logic in Rust, LLM best-effort" pattern). The frontend only sends the textarea text and consumes the result.

### IPC contract

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareMarkdownResult {
    pub text: String,        // cleaned, read-aloud text (LLM output, or strip fallback)
    pub used_llm: bool,      // false when the deterministic fallback was used
    pub warnings: Vec<String>, // per-file problems (skipped file, clamped range, …)
}

#[tauri::command]
pub async fn prepare_markdown(
    input: String,
    state: State<'_, Arc<AppState>>,
) -> Result<PrepareMarkdownResult, String>;
```

TS side:
```ts
interface PrepareMarkdownResult { text: string; usedLlm: boolean; warnings: string[]; }
```

### Pipeline (inside `prepare_markdown`)

1. **Parse** the input into entries (new `markdown.rs`). Each non-blank line → `FileSpec { path: String, range: Option<(usize, usize)> }`. A trailing `:<start>-<end>` (matched by a regex anchored at end-of-line, both integers) is the range; otherwise the whole line is the path. This tolerates `:` elsewhere in a path because only a trailing `:\d+-\d+` is treated as a range.
2. **Read & slice** each file:
   - Read as UTF-8. Unreadable/missing → push a warning, **skip** this entry.
   - With a range: split into physical lines, take `start..=end` **1-based inclusive**; clamp `end` to the line count (warn if clamped); if `start > line_count` or `start > end` → warning, skip the entry.
   - No range → whole file.
3. **Concatenate** the kept slices in listed order, separated by a blank line (`\n\n`).
4. If the concatenation is empty (no readable content) → return `Err("No readable Markdown content")` (frontend toasts, input unchanged).
5. **LLM cleanup:** send the concatenated Markdown to the local LLM (reuse the OMLX client + `AppSettings` `LlmConfig` from `llm.rs`; honor the existing timeout) with the faithful-cleanup instruction (below). On success → `{ text: llm_out, used_llm: true, warnings }`.
6. **Fallback:** if the LLM call fails for any reason (unreachable, non-2xx, timeout, empty response), run the deterministic strip on the concatenated Markdown → `{ text: stripped, used_llm: false, warnings: warnings + ["LLM unavailable — used basic Markdown cleanup"] }`.

### LLM cleanup instruction (faithful)

> You convert Markdown into clean text for read-aloud speaking practice. Preserve the original wording and meaning. Remove Markdown formatting: heading markers, emphasis (`*`/`_`), list bullets/numbers, inline-code backticks, and tables. Drop fenced code blocks entirely. For links, keep the link text and drop the URL. Do NOT summarize, shorten, translate, rephrase, or add any commentary. Output only the cleaned reading text.

Non-streaming, one-shot. Reuses the same endpoint/model/key/timeout the feedback step uses.

### Deterministic strip (fallback, also unit-tested)

A pure `strip_markdown(md: &str) -> String` in `markdown.rs`:
- Drop fenced code blocks (```` ``` ````-delimited) entirely.
- Remove ATX heading markers (`#`+), blockquote `>`, list markers (`-`, `*`, `+`, `1.`) at line start.
- Strip emphasis (`*`/`_`/`~`) and inline-code backticks.
- Links `[text](url)` → `text`; images `![alt](url)` → `alt` (or drop if no alt).
- Collapse 3+ blank lines to one; trim.

(The strip is intentionally simple — it's the offline safety net, not the primary path.)

## Components / files

- **Frontend:**
  - `src/components/ReadMarkdownPanel.tsx` — modal (portal) with textarea, Read/Cancel, loading state. Calls `prepare_markdown`, `setInputText`, toasts warnings.
  - `src/components/CaptureControls.tsx` — add the **Read MD** button that opens the panel.
  - Panel open/close state: a local `useState` in `CaptureControls` (the panel is only opened from there), or a small store flag — implementer's choice; local state preferred (YAGNI).
  - `src/types.ts` — `PrepareMarkdownResult`.
- **Rust:**
  - `src-tauri/src/markdown.rs` — `parse_specs`, `read_and_slice`, `strip_markdown` (+ a cleanup-call helper, or reuse one added to `llm.rs`).
  - `src-tauri/src/commands.rs` — `prepare_markdown` command.
  - `src-tauri/src/lib.rs` — register `prepare_markdown`; add `pub mod markdown;`.
  - `src-tauri/src/llm.rs` — a reusable "prompt → text" call if one isn't already exposed.

## Error handling

| Case | Behavior |
|------|----------|
| File missing / unreadable / not UTF-8 | Warning, skip entry, continue |
| Range `start > end` or `start > line_count` | Warning, skip entry |
| Range `end > line_count` | Clamp to line count, warning |
| All entries fail / empty result | `Err` → toast, input unchanged |
| LLM unreachable / timeout / non-2xx / empty | Deterministic strip + "LLM unavailable" warning; `usedLlm=false` |
| Malformed line (no path) | Warning, skip |

The frontend shows `warnings` as info/error toasts and, when `usedLlm === false`, makes clear basic cleanup was used.

## Testing

- **Rust unit tests (`markdown.rs`)** — the backbone:
  - `parse_specs`: path only; `path:10-50`; path containing `:` but no range; malformed range; blank lines skipped.
  - `read_and_slice` (via temp files): whole file; 1-based inclusive slice; `end` clamp; `start` past EOF → skip; `start>end` → skip.
  - concatenation order + `\n\n` separator.
  - `strip_markdown`: headings, emphasis, inline code, fenced code dropped, links→text, images→alt, blockquote, list markers, blank-line collapse.
- **LLM path** is integration/manual (the deterministic strip is the unit-tested fallback path).
- **Frontend (`ReadMarkdownPanel`)** — Vitest + RTL with `prepare_markdown` mocked: renders textarea + buttons; on Read, calls `prepare_markdown` with the textarea text and sets `inputText` to the result; shows a warning toast when `warnings` is non-empty / `usedLlm` is false; Cancel closes without calling.
- **Manual (live):** real `.md` files with and without ranges; multi-file concat order; LLM cleanup faithfulness; stop the LLM → confirm strip fallback + toast; bad path → warning + others still read.

## Out of scope

- Remote/`http(s)` Markdown URLs (local files only).
- Summarization / translation / any non-faithful rewriting by the LLM.
- A rich multi-row file-picker UI (the textarea is the input; a future "Browse" helper could append paths but is not in this iteration).
- Watching files for changes / live re-read.
