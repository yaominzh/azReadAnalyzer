// Read-from-Markdown: parse a textarea of local file paths (+ optional line
// ranges), read/slice/concatenate under robustness caps, and extract faithful
// plain text. Deterministic + on-device (no LLM, no network).

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use std::path::PathBuf;

/// Convert Markdown to faithful read-aloud plain text. Drops code blocks and
/// raw HTML; keeps inline code, link text, image alt, and table cell text.
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
            // Block separators that warrant a blank line between them. The
            // collapse pass below caps runs at two newlines, so emitting "\n\n"
            // here yields a single blank line regardless of adjacent breaks.
            Event::End(TagEnd::Paragraph) | Event::End(TagEnd::Heading(_)) => {
                out.push_str("\n\n")
            }
            Event::End(TagEnd::Item)
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

pub const MAX_ENTRIES: usize = 25;
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024; // per file
pub const MAX_TOTAL_MD_BYTES: usize = 10 * 1024 * 1024; // aggregate raw input
pub const MAX_TOTAL_CHARS: usize = 100_000; // extracted output

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

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(slice_lines(content, 4, 99).unwrap(), ("l4\nl5".to_string(), true));
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
        assert!(res.text.contains("beta") || res.text.contains("gamma"));
        assert!(res.warnings.is_empty());
    }

    #[test]
    fn relative_path_is_skipped_with_warning() {
        let res = prepare_from_input("relative/notes.md");
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
        assert!(prepare_from_input(&dir.path().display().to_string()).is_err());
    }

    #[test]
    fn too_many_entries_warns_and_truncates() {
        let files: Vec<_> = (0..=MAX_ENTRIES).map(|i| tmp_md(&format!("file{i}"))).collect();
        let input = files.iter().map(|f| f.path().display().to_string()).collect::<Vec<_>>().join("\n");
        let res = prepare_from_input(&input).unwrap();
        assert!(res.warnings.iter().any(|w| w.contains("Too many")));
        assert!(res.text.contains("file0"));
        assert!(!res.text.contains(&format!("file{MAX_ENTRIES}")));
    }

    #[test]
    fn oversized_file_is_skipped() {
        let big = tmp_md(&"x".repeat(MAX_FILE_BYTES as usize + 16));
        assert!(prepare_from_input(&big.path().display().to_string()).is_err());
    }

    #[test]
    fn output_truncated_at_max_total_chars() {
        let f = tmp_md(&"a ".repeat(MAX_TOTAL_CHARS));
        let res = prepare_from_input(&f.path().display().to_string()).unwrap();
        assert!(res.text.chars().count() <= MAX_TOTAL_CHARS);
        assert!(res.warnings.iter().any(|w| w.contains("truncated")));
    }

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
