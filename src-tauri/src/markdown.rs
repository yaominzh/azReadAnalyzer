// Read-from-Markdown: parse a textarea of local file paths (+ optional line
// ranges), read/slice/concatenate under robustness caps, and extract faithful
// plain text. Deterministic + on-device (no LLM, no network).

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

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
