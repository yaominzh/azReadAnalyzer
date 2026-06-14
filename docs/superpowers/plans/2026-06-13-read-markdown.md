# Read from Markdown Files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Read MD" capture source — read one or more local Markdown files (optional per-file line range), extract faithful plain text deterministically, and drop it into the practice input box.

**Architecture:** A self-contained Rust module (`markdown.rs`) parses the textarea, resolves/reads/slices local files under robustness caps, concatenates, and extracts plain text via `pulldown-cmark`. A `prepare_markdown` Tauri command wraps it in `spawn_blocking`. A `ReadMarkdownPanel` modal collects the input, calls the command behind a request guard, and applies the result (sets input text, clears thumbnail + stale feedback, one summary toast). No LLM, no network — fully on-device and faithful by construction.

**Tech Stack:** Rust + Tauri 2, `pulldown-cmark` (new), `dirs`, `tempfile` (tests); React 19 + TS, Zustand, Vitest + RTL.

**Spec:** `docs/superpowers/specs/2026-06-13-read-markdown-design.md` (review-incorporated, both rounds).

---

## File structure

| File | Change | Responsibility |
|------|--------|----------------|
| `src-tauri/Cargo.toml` | edit | add `pulldown-cmark` |
| `src-tauri/src/markdown.rs` | create | `markdown_to_text`, `parse_specs`, `slice_lines`, `prepare_from_input`, caps, `PrepareMarkdownResult` |
| `src-tauri/src/commands.rs` | edit | `prepare_markdown` async command (wraps `prepare_from_input` in `spawn_blocking`) |
| `src-tauri/src/lib.rs` | edit | `pub mod markdown;` + register command |
| `src/types/index.ts` | edit | `PrepareMarkdownResult` interface |
| `src/components/ReadMarkdownPanel.tsx` | create | modal: textarea, Read/Cancel, loading, request guard, applies result |
| `src/components/CaptureControls.tsx` | edit | "Read MD" button + open/close state + render panel |
| `src/components/__tests__/ReadMarkdownPanel.test.tsx` | create | panel behavior + request-guard test |

---

## Task 1: `markdown_to_text` extraction (pulldown-cmark)

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/markdown.rs`
- Test: in `src-tauri/src/markdown.rs` (`#[cfg(test)]`)

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml`, under `[dependencies]` (after the `similar = "2"` line), add:
```toml
# Markdown → faithful plain text for the Read-MD capture source (deterministic).
pulldown-cmark = "0.12"
```

- [ ] **Step 2: Create `src-tauri/src/markdown.rs` with the failing test first**

Create the file with just the test module + a stub so it compiles and fails:
```rust
// Read-from-Markdown: parse a textarea of local file paths (+ optional line
// ranges), read/slice/concatenate under robustness caps, and extract faithful
// plain text. Deterministic + on-device (no LLM, no network).

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// Convert Markdown to faithful read-aloud plain text. Drops code blocks and
/// raw HTML; keeps inline code, link text, image alt, and table cell text.
pub fn markdown_to_text(md: &str) -> String {
    let _ = md;
    String::new() // replaced in Step 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_faithful_text() {
        let md = "\
# Title

Some **bold** and `inline code` and a [link](https://x.com).

```rust
fn hidden() {}
```

- item one
- item two

<div>raw html</div>

Para two.";
        let out = markdown_to_text(md);
        assert!(out.contains("Title"));
        assert!(out.contains("bold"));
        assert!(out.contains("inline code"));
        assert!(out.contains("link"));          // link text kept
        assert!(!out.contains("https://x.com")); // URL dropped
        assert!(!out.contains("hidden"));        // code block dropped
        assert!(!out.contains("<div>"));         // raw HTML dropped
        assert!(out.contains("item one") && out.contains("item two"));
        assert!(out.contains("Para two."));
    }

    #[test]
    fn handles_tables_setext_and_strikethrough() {
        let md = "\
Heading
=======

| A | B |
|---|---|
| x | y |

~~struck~~ kept";
        let out = markdown_to_text(md);
        assert!(out.contains("Heading")); // setext heading
        assert!(out.contains("A") && out.contains("B") && out.contains("x") && out.contains("y")); // table cells
        assert!(out.contains("struck") && out.contains("kept")); // strikethrough inner text
    }

    #[test]
    fn collapses_blank_lines_and_trims() {
        let out = markdown_to_text("a\n\n\n\n\nb\n");
        assert_eq!(out, "a\n\nb");
    }
}
```

- [ ] **Step 3: Register the module so Rust compiles + discovers its tests**

In `src-tauri/src/lib.rs`, add `pub mod markdown;` right after the `pub mod fluency;` line. **This must happen now** — without a `mod` declaration Rust never compiles `markdown.rs`, so `cargo test markdown::tests` would silently match **0 tests** instead of failing. (Command registration stays in Task 3.)

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd src-tauri && cargo test markdown::tests -- --nocapture`
Expected: FAIL — **3 tests run and assertions fail** (the stub returns an empty string). If it reports "0 tests", the `pub mod markdown;` line is missing — go back to Step 3.

- [ ] **Step 5: Implement `markdown_to_text`**

Replace the stub body with:
```rust
pub fn markdown_to_text(md: &str) -> String {
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut out = String::new();
    let mut in_code_block = false;

    for event in Parser::new_ext(md, opts) {
        match event {
            Event::Start(Tag::CodeBlock(_)) => in_code_block = true,
            Event::End(TagEnd::CodeBlock) => in_code_block = false,
            Event::Text(t) => {
                if !in_code_block {
                    out.push_str(&t);
                }
            }
            Event::Code(t) => out.push_str(&t), // inline code: read as a word
            Event::SoftBreak => out.push(' '),
            Event::HardBreak => out.push('\n'),
            Event::End(TagEnd::Paragraph)
            | Event::End(TagEnd::Heading(_))
            | Event::End(TagEnd::Item)
            | Event::End(TagEnd::TableRow)
            | Event::End(TagEnd::TableHead) => out.push('\n'),
            Event::End(TagEnd::TableCell) => out.push(' '),
            // Html / InlineHtml / TaskListMarker / FootnoteReference → dropped
            // (not matched → no output). Emphasis/Strong/Strikethrough/Link/Image
            // start+end are no-ops; their inner Text carries the words.
            _ => {}
        }
    }

    // Collapse 3+ consecutive newlines to exactly two; trim ends.
    let mut collapsed = String::with_capacity(out.len());
    let mut newline_run = 0;
    for ch in out.chars() {
        if ch == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                collapsed.push('\n');
            }
        } else {
            newline_run = 0;
            collapsed.push(ch);
        }
    }
    collapsed.trim().to_string()
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test markdown::tests -- --nocapture`
Expected: PASS (3 tests). If `cargo` reports an unused-import warning for `Tag`/`TagEnd` not yet used by later tasks, that's fine — they're used here.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/markdown.rs
git commit -m "feat(md): markdown_to_text faithful extraction via pulldown-cmark"
```

---

## Task 2: parsing, path resolution, slicing, caps, `prepare_from_input`

**Files:**
- Modify: `src-tauri/src/markdown.rs`
- Test: same file (`#[cfg(test)]`)

- [ ] **Step 1: Add the failing tests**

Add these to the `mod tests` block in `src-tauri/src/markdown.rs` (keep the Task 1 tests). They use `tempfile` (already a dependency) and `std::io::Write`:
```rust
    use std::io::Write;

    fn tmp_md(contents: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::Builder::new().suffix(".md").tempfile().unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        f
    }

    #[test]
    fn parses_path_and_optional_range() {
        let specs = parse_specs("/a/b.md\n/c/d.md:10-50\n\n  \n/e.md");
        assert_eq!(specs.len(), 3);
        assert_eq!(specs[0].path, "/a/b.md");
        assert_eq!(specs[0].range, None);
        assert_eq!(specs[1].path, "/c/d.md");
        assert_eq!(specs[1].range, Some((10, 50)));
        assert_eq!(specs[2].path, "/e.md");
    }

    #[test]
    fn trailing_non_range_is_part_of_path() {
        // a colon that isn't followed by digits-digits stays in the path
        let specs = parse_specs("/weird:name.md\n/x.md:notarange");
        assert_eq!(specs[0].path, "/weird:name.md");
        assert_eq!(specs[0].range, None);
        assert_eq!(specs[1].path, "/x.md:notarange");
        assert_eq!(specs[1].range, None);
    }

    #[test]
    fn slices_1_based_inclusive_with_clamp() {
        let content = "l1\nl2\nl3\nl4\nl5";
        assert_eq!(slice_lines(content, 2, 4).unwrap(), ("l2\nl3\nl4".to_string(), false));
        // end past EOF clamps + flags clamped=true
        assert_eq!(slice_lines(content, 4, 99).unwrap(), ("l4\nl5".to_string(), true));
        // start past EOF / start>end / start==0 are errors
        assert!(slice_lines(content, 9, 10).is_err());
        assert!(slice_lines(content, 3, 1).is_err());
        assert!(slice_lines(content, 0, 2).is_err());
    }

    #[test]
    fn prepare_reads_concats_and_extracts() {
        let f1 = tmp_md("# A\n\nalpha");
        let f2 = tmp_md("# B\n\nbeta\ngamma\ndelta");
        let input = format!("{}\n{}:3-4", f1.path().display(), f2.path().display());
        let res = prepare_from_input(&input).unwrap();
        assert!(res.text.contains("alpha"));
        assert!(res.text.contains("beta") || res.text.contains("gamma")); // f2 lines 3-4 = "beta","gamma"? (see note)
        assert!(res.warnings.is_empty());
    }

    #[test]
    fn relative_path_is_skipped_with_warning() {
        let res = prepare_from_input("relative/notes.md");
        // only entry is relative → skipped → empty → Err
        assert!(res.is_err());
    }

    #[test]
    fn empty_input_errors() {
        assert!(prepare_from_input("   \n  ").is_err());
    }

    #[test]
    fn resolve_path_expands_home_and_rejects_relative() {
        assert!(resolve_path("/abs/x.md").is_ok());
        assert!(resolve_path("relative/x.md").is_err());
        let home = dirs::home_dir().unwrap();
        let r = resolve_path("~/x.md").unwrap();
        assert!(r.starts_with(&home) && r.ends_with("x.md"));
    }

    #[test]
    fn directory_path_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        // only entry is a directory → skipped → empty → Err
        assert!(prepare_from_input(&dir.path().display().to_string()).is_err());
    }

    #[test]
    fn too_many_entries_warns_and_truncates() {
        let files: Vec<_> = (0..=MAX_ENTRIES).map(|i| tmp_md(&format!("file{i}"))).collect(); // MAX_ENTRIES+1
        let input = files.iter().map(|f| f.path().display().to_string()).collect::<Vec<_>>().join("\n");
        let res = prepare_from_input(&input).unwrap();
        assert!(res.warnings.iter().any(|w| w.contains("Too many")));
        assert!(res.text.contains("file0"));
        assert!(!res.text.contains(&format!("file{MAX_ENTRIES}"))); // the (MAX_ENTRIES+1)-th not read
    }

    #[test]
    fn oversized_file_is_skipped() {
        let big = tmp_md(&"x".repeat(MAX_FILE_BYTES as usize + 16));
        // skipped (too large) before reading → empty → Err
        assert!(prepare_from_input(&big.path().display().to_string()).is_err());
    }

    #[test]
    fn output_truncated_at_max_total_chars() {
        let f = tmp_md(&"a ".repeat(MAX_TOTAL_CHARS)); // ~2× the char cap
        let res = prepare_from_input(&f.path().display().to_string()).unwrap();
        assert!(res.text.chars().count() <= MAX_TOTAL_CHARS);
        assert!(res.warnings.iter().any(|w| w.contains("truncated")));
    }

    // NOTE: the aggregate MAX_TOTAL_MD_BYTES stop is exercised in manual
    // verification, not here — it needs >10 MiB across multiple ≤5 MiB files,
    // which is too much I/O for the unit suite.
```

> Note on `f2:3-4`: file is `# B`/blank/`beta`/`gamma`/`delta` → lines 3-4 are `beta` and `gamma`. The assertion accepts either word.

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test markdown::tests -- --nocapture`
Expected: FAIL — `parse_specs`, `slice_lines`, `prepare_from_input`, `PrepareMarkdownResult` not defined.

- [ ] **Step 3: Implement parsing, slicing, caps, and orchestration**

Add to `src-tauri/src/markdown.rs` (above the test module). Add `use serde::Serialize;` and `use std::path::PathBuf;` to the file's imports:
```rust
pub const MAX_ENTRIES: usize = 25;
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;       // per file
pub const MAX_TOTAL_MD_BYTES: usize = 10 * 1024 * 1024; // aggregate raw input
pub const MAX_TOTAL_CHARS: usize = 100_000;             // extracted output

#[derive(Serialize)]
pub struct PrepareMarkdownResult {
    pub text: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, PartialEq)]
pub struct FileSpec {
    pub path: String,
    pub range: Option<(usize, usize)>,
}

/// Parse the textarea: one non-blank line per entry; a trailing `:<start>-<end>`
/// (both integers) is a line range, otherwise the whole line is the path.
pub fn parse_specs(input: &str) -> Vec<FileSpec> {
    input
        .lines()
        .filter_map(|line| {
            let t = line.trim();
            if t.is_empty() {
                return None;
            }
            match split_trailing_range(t) {
                Some((path, range)) => Some(FileSpec { path, range: Some(range) }),
                None => Some(FileSpec { path: t.to_string(), range: None }),
            }
        })
        .collect()
}

/// If `s` ends in `:<digits>-<digits>` with a non-empty path before it, split it.
fn split_trailing_range(s: &str) -> Option<(String, (usize, usize))> {
    let idx = s.rfind(':')?;
    let (path, rest) = (&s[..idx], &s[idx + 1..]);
    if path.is_empty() {
        return None;
    }
    let (a, b) = rest.split_once('-')?;
    let start: usize = a.parse().ok()?;
    let end: usize = b.parse().ok()?;
    Some((path.to_string(), (start, end)))
}

/// Take `start..=end` (1-based, inclusive). Returns (text, clamped). Errs when
/// start==0, start>line_count, or start>end.
pub fn slice_lines(content: &str, start: usize, end: usize) -> Result<(String, bool), String> {
    let lines: Vec<&str> = content.lines().collect();
    let n = lines.len();
    if start == 0 || start > n {
        return Err("range start past end of file".into());
    }
    if start > end {
        return Err("range start after end".into());
    }
    let clamped = end > n;
    let real_end = end.min(n);
    Ok((lines[start - 1..real_end].join("\n"), clamped))
}

/// Expand a leading `~/`, then require an absolute path.
fn resolve_path(path: &str) -> Result<PathBuf, String> {
    let pb = if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir().ok_or("no home directory")?.join(rest)
    } else {
        PathBuf::from(path)
    };
    if !pb.is_absolute() {
        return Err("relative path not supported".into());
    }
    Ok(pb)
}

/// The whole pipeline (sync; the command wraps this in spawn_blocking).
pub fn prepare_from_input(input: &str) -> Result<PrepareMarkdownResult, String> {
    let mut warnings: Vec<String> = Vec::new();
    let mut specs = parse_specs(input);
    if specs.len() > MAX_ENTRIES {
        warnings.push(format!("Too many files; only the first {MAX_ENTRIES} are read"));
        specs.truncate(MAX_ENTRIES);
    }

    let mut pieces: Vec<String> = Vec::new();
    let mut total_bytes: usize = 0;

    for spec in &specs {
        let path = match resolve_path(&spec.path) {
            Ok(p) => p,
            Err(_) => {
                warnings.push(format!("Skipped (use an absolute path): {}", spec.path));
                continue;
            }
        };
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => {
                warnings.push(format!("Skipped (not found): {}", spec.path));
                continue;
            }
        };
        if !meta.is_file() {
            warnings.push(format!("Skipped (not a file): {}", spec.path));
            continue;
        }
        if meta.len() > MAX_FILE_BYTES {
            warnings.push(format!("Skipped (too large): {}", spec.path));
            continue;
        }
        if total_bytes.saturating_add(meta.len() as usize) > MAX_TOTAL_MD_BYTES {
            warnings.push("Stopped reading: total size limit reached".into());
            break;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => {
                warnings.push(format!("Skipped (not UTF-8 text): {}", spec.path));
                continue;
            }
        };
        total_bytes += content.len();

        let piece = match spec.range {
            Some((start, end)) => match slice_lines(&content, start, end) {
                Ok((text, clamped)) => {
                    if clamped {
                        warnings.push(format!("Range end clamped to file length: {}", spec.path));
                    }
                    text
                }
                Err(msg) => {
                    warnings.push(format!("Skipped ({msg}): {}", spec.path));
                    continue;
                }
            },
            None => content,
        };
        pieces.push(piece);
    }

    let combined = pieces.join("\n\n");
    let mut text = markdown_to_text(&combined);
    if text.chars().count() > MAX_TOTAL_CHARS {
        text = text.chars().take(MAX_TOTAL_CHARS).collect();
        warnings.push("Text truncated to the maximum length".into());
    }
    if text.trim().is_empty() {
        return Err("No readable Markdown content".into());
    }
    Ok(PrepareMarkdownResult { text, warnings })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test markdown::tests -- --nocapture`
Expected: PASS — Task 1 (3) + Task 2 (11) = 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/markdown.rs
git commit -m "feat(md): parse specs, slice ranges, caps, prepare_from_input"
```

---

## Task 3: `prepare_markdown` Tauri command + registration + TS type

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/types/index.ts`

- [ ] **Step 1: Add the command to `src-tauri/src/commands.rs`**

At the top of the file ensure `use tauri::command;` exists (it does — other commands use `#[command]`). Add this command (anywhere among the other `#[command]` fns):
```rust
/// Read local Markdown files (with optional line ranges) and return faithful
/// plain text for the practice box. Deterministic + on-device; file reads run
/// on a blocking thread so a large batch can't stall the command worker.
#[command]
pub async fn prepare_markdown(
    input: String,
) -> Result<crate::markdown::PrepareMarkdownResult, String> {
    tokio::task::spawn_blocking(move || crate::markdown::prepare_from_input(&input))
        .await
        .map_err(|e| format!("read task failed: {e}"))?
}
```

- [ ] **Step 2: Register the command in `src-tauri/src/lib.rs`**

(`pub mod markdown;` was already added in Task 1.) Add `commands::prepare_markdown,` to the `tauri::generate_handler![ ... ]` list (after `commands::stop_tts_stream,`).

- [ ] **Step 3: Verify it builds**

Run: `cd src-tauri && cargo build 2>&1 | tail -5; echo EXIT=${PIPESTATUS[0]}`
Expected: `EXIT=0` (links cleanly). Run `cargo test --lib 2>&1 | tail -5; echo EXIT=${PIPESTATUS[0]}` → `EXIT=0`, markdown tests included.

- [ ] **Step 4: Add the TS type to `src/types/index.ts`**

Append:
```ts
// Result of the prepare_markdown command (Read-from-Markdown capture source)
export interface PrepareMarkdownResult {
  text: string;
  warnings: string[];
}
```

- [ ] **Step 5: Typecheck the frontend**

Run (repo root): `npx tsc -b`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/types/index.ts
git commit -m "feat(md): prepare_markdown command + register + TS type"
```

---

## Task 4: `ReadMarkdownPanel` + capture-bar button

**Files:**
- Create: `src/components/ReadMarkdownPanel.tsx`
- Modify: `src/components/CaptureControls.tsx`
- Test: `src/components/__tests__/ReadMarkdownPanel.test.tsx`

- [ ] **Step 1: Write the failing test `src/components/__tests__/ReadMarkdownPanel.test.tsx`**

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store/useAppStore";
import ReadMarkdownPanel from "../ReadMarkdownPanel";

describe("ReadMarkdownPanel", () => {
  beforeEach(() => {
    useAppStore.setState({ inputText: "", feedback: null, captureImageUrl: null, toasts: [] });
    vi.mocked(invoke).mockReset();
  });

  it("reads, sets input text, and closes", async () => {
    vi.mocked(invoke).mockResolvedValue({ text: "hello world", warnings: [] });
    const onClose = vi.fn();
    render(<ReadMarkdownPanel onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/Users/a/x.md" } });
    fireEvent.click(screen.getByRole("button", { name: /read/i }));
    await waitFor(() => expect(useAppStore.getState().inputText).toBe("hello world"));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("prepare_markdown", { input: "/Users/a/x.md" });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("clear_session_media"); // backend media cleared (review #2)
    expect(onClose).toHaveBeenCalled();
  });

  it("shows one summary toast when there are warnings", async () => {
    vi.mocked(invoke).mockResolvedValue({ text: "ok", warnings: ["Skipped (not found): /a", "Range end clamped: /b"] });
    render(<ReadMarkdownPanel onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/a\n/b" } });
    fireEvent.click(screen.getByRole("button", { name: /read/i }));
    await waitFor(() => expect(useAppStore.getState().toasts.length).toBe(1)); // ONE summary toast, not two
  });

  it("does not overwrite input if closed before the read resolves (request guard)", async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(invoke).mockReturnValue(new Promise((r) => { resolve = r; }));
    const onClose = vi.fn();
    const { unmount } = render(<ReadMarkdownPanel onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/a.md" } });
    fireEvent.click(screen.getByRole("button", { name: /read/i }));
    unmount(); // panel closed/unmounted while in flight
    resolve({ text: "late", warnings: [] });
    await Promise.resolve();
    expect(useAppStore.getState().inputText).toBe(""); // stale result ignored
  });

  it("Cancel closes without calling the command", () => {
    const onClose = vi.fn();
    render(<ReadMarkdownPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/__tests__/ReadMarkdownPanel.test.tsx`
Expected: FAIL — module `../ReadMarkdownPanel` does not exist.

- [ ] **Step 3: Create `src/components/ReadMarkdownPanel.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import type { PrepareMarkdownResult } from "../types";

const PLACEHOLDER = `One file per line. Optional line range with :start-end
/Users/you/notes.md
/Users/you/chapter.md:10-50`;

function summarize(warnings: string[]): string {
  if (warnings.length === 1) return warnings[0];
  return `${warnings.length} notes — ${warnings[0]} …`;
}

export default function ReadMarkdownPanel({ onClose }: { onClose: () => void }) {
  const setInputText = useAppStore((s) => s.setInputText);
  const clearFeedback = useAppStore((s) => s.clearFeedback);
  const clearCaptureImage = useAppStore((s) => s.clearCaptureImage);
  const addToast = useAppStore((s) => s.addToast);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);
  const closedRef = useRef(false);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") handleClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      closedRef.current = true; // unmount invalidates any in-flight request (review #9)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
  }, []);

  function handleClose() {
    closedRef.current = true;
    onClose();
  }

  async function handleRead() {
    if (!input.trim() || loading) return;
    const req = ++reqRef.current;
    setLoading(true);
    try {
      const res = import.meta.env.VITE_USE_MOCK
        ? ({ text: "Sample Markdown content for mock-mode UI development.", warnings: [] } as PrepareMarkdownResult)
        : await invoke<PrepareMarkdownResult>("prepare_markdown", { input });
      if (req !== reqRef.current || closedRef.current) return; // stale / closed
      setInputText(res.text);
      clearCaptureImage();
      invoke("clear_session_media").catch(() => {}); // also clear Rust's last_capture_png (review #2)
      clearFeedback();
      if (res.warnings.length > 0) addToast(summarize(res.warnings), "info");
      handleClose();
    } catch (e) {
      if (req !== reqRef.current || closedRef.current) return;
      addToast(String(e), "error");
      setLoading(false);
    }
  }

  return createPortal(
    <div onClick={handleClose} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" style={{ backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-[460px] max-h-[85vh] overflow-y-auto rounded-xl border border-white/10 bg-[#0c0c0c]/95 p-5 text-white/80">
        <p className="text-[13px] font-semibold tracking-wider uppercase text-white/40 mb-1">Read from Markdown</p>
        <p className="text-[11px] text-white/40 mb-3">One local file path per line. Add <span className="text-fuchsia-300">:10-50</span> for a line range (1-based, inclusive).</p>
        <textarea
          aria-label="Markdown file paths"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          className="w-full min-h-[140px] bg-[#0b0b0d] border border-white/12 rounded-lg p-3 text-[13px] leading-relaxed text-white/85 font-mono outline-none"
        />
        <div className="flex gap-2 mt-4 justify-end">
          <button onClick={handleClose} className="px-3 py-2 rounded-lg text-[12px] bg-white/[0.06] border border-white/10 text-white/60">Cancel</button>
          <button onClick={handleRead} disabled={!input.trim() || loading}
            className="px-4 py-2 rounded-lg text-[12px] font-medium bg-gradient-to-br from-indigo-500 to-indigo-400 text-white disabled:opacity-40 disabled:cursor-not-allowed">
            {loading ? "Reading…" : "Read →"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
```

- [ ] **Step 4: Wire the button into `src/components/CaptureControls.tsx`**

Add the import and a `useState`, the button, and the conditional panel. Concretely:

1. Update the imports at the top:
```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import { loadCaptureImage } from "../lib/loadCaptureImage";
import ReadMarkdownPanel from "./ReadMarkdownPanel";
import type { PasteResult } from "../types";
```
2. At the top of the component body (after the existing `useAppStore` selector lines), add:
```tsx
  const [readMdOpen, setReadMdOpen] = useState(false);
```
3. In the returned JSX, add a **Read MD** button after the Paste button (before the `ml-auto` Clear button):
```tsx
      <button className={btn} onClick={() => setReadMdOpen(true)}>
        Read MD
      </button>
```
4. Render the panel at the end of the returned fragment. Change the outer wrapper to include the panel — wrap the existing `<div>…</div>` return so the panel renders as a sibling:
```tsx
  return (
    <>
      <div className="flex items-center gap-2 pt-3 border-t border-white/[0.06] flex-shrink-0">
        <button className={btn} onClick={handleScreenshot}>Screenshot</button>
        <button className={btn} onClick={handlePaste}>Paste</button>
        <button className={btn} onClick={() => setReadMdOpen(true)}>Read MD</button>
        <button className={`${btn} ml-auto`} onClick={handleClear}>Clear</button>
      </div>
      {readMdOpen && <ReadMarkdownPanel onClose={() => setReadMdOpen(false)} />}
    </>
  );
```
(Leave `handleScreenshot`, `handlePaste`, `handleClear`, and `btn` exactly as they are.)

- [ ] **Step 5: Run the panel tests + full suite**

Run: `npx vitest run src/components/__tests__/ReadMarkdownPanel.test.tsx`
Expected: PASS (4 tests).
Then: `npx vitest run && npx tsc -b && npx eslint .`
Expected: all clean/green (report the total vitest count).

- [ ] **Step 6: Commit**

```bash
git add src/components/ReadMarkdownPanel.tsx src/components/CaptureControls.tsx src/components/__tests__/ReadMarkdownPanel.test.tsx
git commit -m "feat(md): Read MD panel + capture-bar button"
```

---

## Manual verification (live)

- [ ] Click **Read MD** → textarea modal opens; Esc / Cancel / backdrop close it.
- [ ] Enter one real `.md` path → Read → its prose (no `#`, no code blocks, links read as text) fills the practice box; any prior thumbnail + feedback clear.
- [ ] Enter several files + a `:start-end` range → confirm concat order and that only the range is read.
- [ ] `~/somefile.md` resolves to home; a **relative** path → skipped with a summary toast; others still read.
- [ ] A directory path / a >5 MiB file → skipped with a warning; a non-existent path → warning, others still read.
- [ ] Many bad entries → exactly **one** summary toast (not one per problem).
- [ ] After Read, run Listen + Record/Feedback as normal on the imported text.

---

## Self-review notes

- **Spec coverage:** capture-bar button + modal textarea (Task 4); `path` / `path:start-end` parsing, 1-based inclusive slicing, `~/`+absolute resolution, robustness caps `MAX_ENTRIES`/`MAX_FILE_BYTES`/`MAX_TOTAL_MD_BYTES`/`MAX_TOTAL_CHARS` (Task 2 — unit-tested for resolve/dir-skip/too-many/oversized/char-truncation; the 10 MiB aggregate stop is manual-verified, noted in Task 2); `pulldown-cmark` extraction with the exact event rules incl. dropped code/HTML/task-marker and tables/strikethrough enabled (Task 1); `spawn_blocking` command + registration + TS type (Task 3); request guard + clear thumbnail/feedback + `clear_session_media` (backend media) + single summary toast (Task 4). Error-handling table rows all map to warnings/`Err` in `prepare_from_input` (Task 2). Tests: Rust units are the backbone; frontend panel test incl. the request-guard case.
- **Plan-review incorporated:** `docs/thirdpartyreview/2026-06-13-read-markdown-plan-review.md` — #1 `pub mod markdown;` moved into Task 1 (else early `cargo test` matches 0 tests); #2 `clear_session_media` on success; #3 mock-mode returns representative canned text (keeps the SettingsPanel-style `VITE_USE_MOCK` branch — unit tests already exercise `invoke`); #5 added cap/skip/resolve unit tests. (#4 left as the generic summary — the spec's count example was illustrative.)
- **Type consistency:** `PrepareMarkdownResult { text, warnings }` is identical in `markdown.rs` (Rust, `#[derive(Serialize)]` → `text`/`warnings`, no rename needed), the command return type (Task 3), and `src/types/index.ts` (Task 4). `prepare_from_input(&str) -> Result<PrepareMarkdownResult, String>` is called by the command via `spawn_blocking`. `parse_specs`/`slice_lines` signatures match their tests.
- **No LLM / no network** anywhere — `llm.rs` untouched; consistent with the deterministic decision.
- **Out of scope (per spec):** remote URLs, any LLM, file-picker UI, file watching, escaping for paths ending in `:N-M`.
