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
3. On **Read**, the frontend calls `invoke("prepare_markdown", { input })`, shows a brief loading state, and on success calls `setInputText(result.text)`, **clears the capture thumbnail and any stale feedback**, closes the panel, and shows a **single summary toast** if there were `warnings`. The user then proceeds to Listen / Record.

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
2. **Resolve path** (review #3): expand a leading `~/` to the home directory; the result **must be absolute** — a relative path → warning, skip (a packaged app's CWD is unpredictable, so relative paths are not supported in v1).
3. **Read & slice** each entry, with robustness guards:
   - `fs::metadata` → must be a **regular file** (reject directories / devices → warning, skip).
   - Per-file size guard: files larger than **`MAX_FILE_BYTES = 5 MiB`** → warning, skip.
   - **Aggregate guard (review #2):** track total bytes read; once it would exceed **`MAX_TOTAL_MD_BYTES = 10 MiB`**, stop reading further entries → warning. This bounds raw input *before* concatenation/parsing (the per-file cap alone allows 25×5 MiB).
   - Read as UTF-8 (`read_to_string`); non-UTF-8/unreadable → warning, skip. (Any readable UTF-8 text file is accepted and treated as Markdown — no extension enforcement; review #4.)
   - With a range: split into physical lines, take `start..=end` **1-based inclusive**; clamp `end` to line count (warn if clamped); `start > line_count` or `start > end` → warning, skip the entry.
   - No range → whole file.
4. **Concatenate** kept slices in listed order, separated by `\n\n`.
5. **Extract** plain text with `pulldown-cmark` (`markdown_to_text`, below).
6. **Output cap:** if the extracted text exceeds **`MAX_TOTAL_CHARS = 100_000`**, truncate at a char boundary and add a warning.
7. If the final text is empty (nothing readable) → `Err("No readable Markdown content")` (frontend toasts, input unchanged).

**Runtime (review #2):** the file reads + parse run inside `tokio::task::spawn_blocking` (required, not optional) so a large batch can never stall the Tauri command worker. The aggregate byte cap bounds memory.

### `markdown_to_text(md: &str) -> String` (pulldown-cmark)

Construct the parser with **explicit options** (review #1) — tables and task lists are off by default:

```rust
use pulldown_cmark::{Parser, Options, Event, Tag, TagEnd};
let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
let parser = Parser::new_ext(md, opts);
```

Drive the events and emit faithful prose. **Exact event handling** (review #1):

| Event | Action |
|-------|--------|
| `Text(t)`, inline `Code(t)` | emit `t` verbatim (inline code is usually a term/word) |
| `Start(CodeBlock)` … `End(CodeBlock)` | **drop** all `Text` in between (don't read code aloud) — track a `in_code_block` depth flag |
| `Html(_)`, `InlineHtml(_)` | **drop** (never emit raw tags into read-aloud text) |
| `TaskListMarker(_)` | **drop** (don't read "checked/unchecked") |
| `FootnoteReference(_)` | **drop** (markers are noise; footnotes option left off) |
| `SoftBreak` | emit a space |
| `HardBreak` | emit a newline |
| `End(Paragraph \| Heading \| Item \| TableRow)` | emit a newline |
| `End(TableCell)` | emit a space (cells inline within a row) |
| `Start/End(Emphasis \| Strong \| Strikethrough \| Link \| Image)` | no-op — inner `Text` carries the words (link text kept, URL dropped; image alt kept) |
| everything else | no-op |

Then collapse 3+ consecutive blank lines to one and trim ends.

Because the option-enabled parser does the structural work, this correctly handles `~~~` fences, Setext headings, reference/autolinks, escapes, strikethrough, task lists, and tables (review #7) — and raw HTML is explicitly dropped rather than leaking (review #1).

## Components / files

- **Frontend:**
  - `src/components/ReadMarkdownPanel.tsx` — modal (portal): textarea, Read/Cancel, loading state, **a request guard** (a ref counter; a resolved `prepare_markdown` only applies if it's the latest request and the panel is still open — review #9).
  - `src/components/CaptureControls.tsx` — **Read MD** button + local `useState` for panel open/close. On success: `setInputText`, `clearCaptureImage()`, `clearFeedback()` (review #6).
  - `src/types/index.ts` — `PrepareMarkdownResult` (imported as `../types`).
- **Rust:**
  - `src-tauri/src/markdown.rs` — `parse_specs`, `read_and_slice`, `markdown_to_text`, the caps as `const`s.
  - `src-tauri/src/commands.rs` — `prepare_markdown` command.
  - `src-tauri/src/lib.rs` — `pub mod markdown;` + register `prepare_markdown`.
  - `src-tauri/Cargo.toml` — add `pulldown-cmark` (review #7; new dependency).

## Error handling

| Case | Behavior |
|------|----------|
| Relative path (not absolute after `~/` expansion) | Warning, skip entry |
| Not a regular file (dir/device) | Warning, skip entry |
| File > `MAX_FILE_BYTES` | Warning, skip entry |
| Aggregate read > `MAX_TOTAL_MD_BYTES` | Warning, stop reading remaining entries |
| Non-UTF-8 / unreadable | Warning, skip entry |
| Range `start > end` or `start > line_count` | Warning, skip entry |
| Range `end > line_count` | Clamp to line count, warning |
| > `MAX_ENTRIES` lines | Warning; extra entries ignored |
| Extracted text > `MAX_TOTAL_CHARS` | Truncate at char boundary, warning |
| All entries fail / empty result | `Err` → error toast, input unchanged |
| Malformed line (empty path after trim) | Skipped (blank) |

**Warning UX (review #5):** the frontend shows **one summary toast** that aggregates the run (e.g. "Read 3 files · 2 skipped, 1 truncated — <first detail>"), not one toast per warning, to avoid spam when many entries have problems. An `Err` is a single error toast and leaves the input unchanged.

## Review resolutions (summary)

- **#1 non-local LLM egress / #3 faithfulness / #4 llm.rs shape:** resolved by dropping the LLM — deterministic extraction is on-device and faithful by construction; no `llm.rs` change needed.
- **#2 file-read boundaries:** reframed as robustness (regular-file check + size caps), not a security boundary (single-user app, user's own paths); no symlink/canonicalization ceremony.
- **#5 size/context limits:** `MAX_ENTRIES`, `MAX_FILE_BYTES`, `MAX_TOTAL_CHARS` with warnings.
- **#6 session side-effects:** Read MD clears the thumbnail (matches Paste) and stale feedback.
- **#7 ad-hoc stripping:** use `pulldown-cmark`.
- **#8 range ambiguity:** documented (below).
- **#9 stale async result:** request guard in the panel.

**Second review round** (`...-design-review` follow-up):
- **Parser options/events:** explicit `Options::ENABLE_TABLES | ENABLE_STRIKETHROUGH | ENABLE_TASKLISTS` + an exact event table (HTML/inline-HTML/task-marker/footnote-ref dropped, table cell/row handling).
- **Runtime/memory:** `spawn_blocking` is required; `MAX_TOTAL_MD_BYTES = 10 MiB` bounds aggregate raw input before parsing (the per-file cap alone allowed 25×5 MiB).
- **Path semantics:** `~/` expansion, absolute required, relative paths skipped with a warning.
- **Extension:** any readable UTF-8 text file is accepted and treated as Markdown (no `.md` enforcement) — explicit decision.
- **Warning UX:** one aggregated summary toast, not per-warning.
- **TS path:** `src/types/index.ts` (not `src/types.ts`).

## Known limitation (review #8)

A line whose path literally ends in `:<digits>-<digits>` is always parsed as `path:range`; such a path can't be addressed as a whole file. Acceptable on macOS (paths ending that way are vanishingly rare); no escaping syntax in v1.

## Testing

- **Rust unit tests (`markdown.rs`)** — the backbone:
  - `parse_specs`: path only; `path:10-50`; path containing `:` but no trailing range; malformed range; blank lines; `> MAX_ENTRIES` truncation.
  - `read_and_slice` (temp files): whole file; 1-based inclusive slice; `end` clamp; `start` past EOF → skip; `start>end` → skip; directory path → skip; oversized file → skip.
  - concatenation order + `\n\n` separator; `MAX_TOTAL_CHARS` truncation.
  - `markdown_to_text`: headings (ATX + Setext), emphasis, **strikethrough** inner text kept, inline code kept, fenced **and** `~~~` code blocks dropped, **raw HTML / inline HTML dropped**, **task-list markers dropped**, links→text, reference links, autolinks, images→alt, **tables→cell text (with `ENABLE_TABLES`)**, blank-line collapse.
  - path resolution: `~/` expansion; relative path → skip with warning; aggregate `MAX_TOTAL_MD_BYTES` stops further reads.
- **Frontend (`ReadMarkdownPanel`)** — Vitest + RTL with `prepare_markdown` mocked: renders textarea + buttons; Read calls `prepare_markdown` with the textarea text, sets `inputText`, clears thumbnail + feedback, shows one summary toast for warnings; Cancel closes without calling; **request-guard test** — a resolve after close/reopen does not overwrite the input.
- **Manual (live):** real `.md` files with/without ranges; multi-file concat order; code blocks dropped; links read as text; oversized file + too-many-entries warnings; bad path → warning while others still read.

## Out of scope

- Remote / `http(s)` Markdown URLs (local only).
- Any LLM involvement / summarization / rewriting.
- A rich multi-row file-picker UI (textarea is the input; a future "Browse" helper could append paths).
- Watching files for changes / live re-read.
- Escaping syntax for paths ending in `:N-M`.
