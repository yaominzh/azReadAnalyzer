# Read from Markdown Files — Design Spec

**Date:** 2026-06-13
**Status:** Approved (brainstorming), revised per third-party review — pending implementation plan
**Branch:** `260613-read-md`
**Review incorporated:** `docs/thirdpartyreview/2026-06-13-read-markdown-design-review.md` (see "Review resolutions").

## Context

A third text-capture source alongside **Screenshot** (OCR) and **Paste** (clipboard): read text from one or more **local Markdown files**, optionally limited to a line range per file, and turn it into clean read-aloud text for the practice pipeline. The user enters file paths in a text window; Rust assembles the content and extracts faithful plain text, which lands in the practice input box exactly like the other two sources.

This is a reading-practice app: the captured text becomes what the user reads aloud and is scored against (the content diff). The text must therefore stay **faithful to the source**.

## Decisions (brainstorming + review)

- **Local files only** — no remote URLs.
- **Deterministic extraction, no LLM.** A real Markdown parser (`pulldown-cmark`) converts Markdown → plain prose. Faithful **by construction** (no summarizing/reordering risk), and **fully on-device** — this feature sends nothing over the network. (This supersedes the earlier "LLM cleanup" idea: the review showed prompt-only faithfulness is unenforceable for a scoring pipeline, and a parser removes the need.)
- **Input UX:** a textarea, one entry per line.
- **Robustness caps** on entries / file size / total text (not a security boundary — single-user app reading the user's own paths — but guards against OOM/UI-block and runaway TTS input).

## User flow

1. A **Read MD** button in the capture bar (next to Paste) opens a modal panel (same portal pattern as `SettingsPanel`).
2. The panel has a **textarea** + **Read** / **Cancel**. One **entry per line**:
   - `/Users/you/notes.md` — whole file.
   - `/Users/you/ch1.md:10-50` — only lines 10–50 (**1-based, inclusive**).
   - Blank lines ignored.
3. On **Read**, the frontend calls `invoke("prepare_markdown", { input })`, shows a brief loading state, and on success calls `setInputText(result.text)`, **clears the capture thumbnail and any stale feedback**, closes the panel, and toasts any `warnings`. The user then proceeds to Listen / Record.

## Architecture — Rust-owned, deterministic

All parsing, file I/O, slicing, concatenation, and Markdown→text extraction live in Rust (testable; consistent with the "deterministic logic in Rust" pattern). No `AppState`/LLM dependency — the command is self-contained.

### IPC contract

```rust
#[derive(Serialize)]
pub struct PrepareMarkdownResult {
    pub text: String,          // faithful plain text, ready for TTS / scoring
    pub warnings: Vec<String>, // per-entry problems (skipped file, clamped range, truncation, …)
}

#[tauri::command]
pub async fn prepare_markdown(input: String) -> Result<PrepareMarkdownResult, String>;
```

```ts
interface PrepareMarkdownResult { text: string; warnings: string[]; }
```

### Pipeline (inside `prepare_markdown`, new `markdown.rs`)

1. **Parse** `input` into entries. Each non-blank, trimmed line → `FileSpec { path, range: Option<(usize, usize)> }`. A trailing `:<start>-<end>` (both integers, matched by a regex anchored at end-of-line) is the range; otherwise the whole line is the path. Cap: at most **`MAX_ENTRIES = 25`** entries (extra → warning, ignored).
2. **Read & slice** each entry, with robustness guards:
   - `fs::metadata` → must be a **regular file** (reject directories / devices → warning, skip).
   - Size guard: files larger than **`MAX_FILE_BYTES = 5 MiB`** → warning, skip.
   - Read as UTF-8 (`read_to_string`); non-UTF-8/unreadable → warning, skip.
   - With a range: split into physical lines, take `start..=end` **1-based inclusive**; clamp `end` to line count (warn if clamped); `start > line_count` or `start > end` → warning, skip the entry.
   - No range → whole file.
3. **Concatenate** kept slices in listed order, separated by `\n\n`.
4. **Extract** plain text with `pulldown-cmark` (`markdown_to_text`, below).
5. **Total cap:** if the extracted text exceeds **`MAX_TOTAL_CHARS = 100_000`**, truncate at a char boundary and add a warning.
6. If the final text is empty (nothing readable) → `Err("No readable Markdown content")` (frontend toasts, input unchanged).

The command is `async`; reads are bounded by the caps so they don't meaningfully block (the plan may use `spawn_blocking` if preferred).

### `markdown_to_text(md: &str) -> String` (pulldown-cmark)

Drive `pulldown_cmark::Parser` over events and emit faithful prose:
- **`Text`** and **inline `Code`** → keep verbatim (inline code is usually a term/word — read it).
- **Fenced/indented code blocks** (`CodeBlock` start→end) → **drop** the contained text (don't read code aloud).
- **`SoftBreak`** → space; **`HardBreak`** → newline.
- **End of `Paragraph` / `Heading` / `Item`** → newline (blank line after block elements).
- **Links** → keep the link text (the `Text` events inside), drop the URL. **Images** → keep alt text if present, else drop.
- **Tables** → keep cell text (cells separated by spaces/newlines) — readable, not structural.
- Collapse 3+ consecutive blank lines to one; trim ends.

Using the parser (vs hand-rolled regex) correctly handles `~~~` fences, Setext headings, reference/autolinks, HTML blocks, escapes, and tables (review #7).

## Components / files

- **Frontend:**
  - `src/components/ReadMarkdownPanel.tsx` — modal (portal): textarea, Read/Cancel, loading state, **a request guard** (a ref counter; a resolved `prepare_markdown` only applies if it's the latest request and the panel is still open — review #9).
  - `src/components/CaptureControls.tsx` — **Read MD** button + local `useState` for panel open/close. On success: `setInputText`, `clearCaptureImage()`, `clearFeedback()` (review #6).
  - `src/types.ts` — `PrepareMarkdownResult`.
- **Rust:**
  - `src-tauri/src/markdown.rs` — `parse_specs`, `read_and_slice`, `markdown_to_text`, the caps as `const`s.
  - `src-tauri/src/commands.rs` — `prepare_markdown` command.
  - `src-tauri/src/lib.rs` — `pub mod markdown;` + register `prepare_markdown`.
  - `src-tauri/Cargo.toml` — add `pulldown-cmark` (review #7; new dependency).

## Error handling

| Case | Behavior |
|------|----------|
| Not a regular file (dir/device) | Warning, skip entry |
| File > `MAX_FILE_BYTES` | Warning, skip entry |
| Non-UTF-8 / unreadable | Warning, skip entry |
| Range `start > end` or `start > line_count` | Warning, skip entry |
| Range `end > line_count` | Clamp to line count, warning |
| > `MAX_ENTRIES` lines | Warning; extra entries ignored |
| Extracted text > `MAX_TOTAL_CHARS` | Truncate at char boundary, warning |
| All entries fail / empty result | `Err` → toast, input unchanged |
| Malformed line (empty path after trim) | Skipped (blank) |

The frontend shows `warnings` as info toasts; an `Err` is an error toast and leaves the input unchanged.

## Review resolutions (summary)

- **#1 non-local LLM egress / #3 faithfulness / #4 llm.rs shape:** resolved by dropping the LLM — deterministic extraction is on-device and faithful by construction; no `llm.rs` change needed.
- **#2 file-read boundaries:** reframed as robustness (regular-file check + size caps), not a security boundary (single-user app, user's own paths); no symlink/canonicalization ceremony.
- **#5 size/context limits:** `MAX_ENTRIES`, `MAX_FILE_BYTES`, `MAX_TOTAL_CHARS` with warnings.
- **#6 session side-effects:** Read MD clears the thumbnail (matches Paste) and stale feedback.
- **#7 ad-hoc stripping:** use `pulldown-cmark`.
- **#8 range ambiguity:** documented (below).
- **#9 stale async result:** request guard in the panel.

## Known limitation (review #8)

A line whose path literally ends in `:<digits>-<digits>` is always parsed as `path:range`; such a path can't be addressed as a whole file. Acceptable on macOS (paths ending that way are vanishingly rare); no escaping syntax in v1.

## Testing

- **Rust unit tests (`markdown.rs`)** — the backbone:
  - `parse_specs`: path only; `path:10-50`; path containing `:` but no trailing range; malformed range; blank lines; `> MAX_ENTRIES` truncation.
  - `read_and_slice` (temp files): whole file; 1-based inclusive slice; `end` clamp; `start` past EOF → skip; `start>end` → skip; directory path → skip; oversized file → skip.
  - concatenation order + `\n\n` separator; `MAX_TOTAL_CHARS` truncation.
  - `markdown_to_text`: headings (ATX + Setext), emphasis, inline code kept, fenced **and** `~~~` code blocks dropped, links→text, reference links, autolinks, images→alt, tables→cell text, blank-line collapse.
- **Frontend (`ReadMarkdownPanel`)** — Vitest + RTL with `prepare_markdown` mocked: renders textarea + buttons; Read calls `prepare_markdown` with the textarea text, sets `inputText`, clears thumbnail + feedback, toasts warnings; Cancel closes without calling; **request-guard test** — a resolve after close/reopen does not overwrite the input.
- **Manual (live):** real `.md` files with/without ranges; multi-file concat order; code blocks dropped; links read as text; oversized file + too-many-entries warnings; bad path → warning while others still read.

## Out of scope

- Remote / `http(s)` Markdown URLs (local only).
- Any LLM involvement / summarization / rewriting.
- A rich multi-row file-picker UI (textarea is the input; a future "Browse" helper could append paths).
- Watching files for changes / live re-read.
- Escaping syntax for paths ending in `:N-M`.
