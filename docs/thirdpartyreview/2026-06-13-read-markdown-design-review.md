# Read from Markdown Files — Design Review

**Date:** 2026-06-14  
**Reviewed spec:** `docs/superpowers/specs/2026-06-13-read-markdown-design.md`

## Findings

### 1. High: local Markdown can be sent off-device despite the privacy claim

The spec says "Local files only" and frames the LLM as local egress only, but the current app allows a non-loopback LLM endpoint after explicit confirmation in `SettingsPanel`. `prepare_markdown` would send concatenated local file contents to that endpoint.

For this feature, either refuse LLM cleanup when the configured endpoint is non-local and use deterministic cleanup, or add an explicit per-use warning in the Read MD modal before sending local file contents.

### 2. High: arbitrary local file read is under-specified

The textarea controls Rust-side file reads directly. The spec does not define canonicalization, symlink behavior, file type checks, extension checks, relative path handling, maximum size, or directory rejection. Because the design uses Rust file I/O, this is not protected by Tauri filesystem capability allowlists.

Add explicit guardrails: regular files only, `.md` / `.markdown` unless deliberately broader, canonicalized paths, max entries, max per-file bytes, max total bytes/chars, and clear behavior for symlinks.

### 3. High: LLM "faithful cleanup" is not enforceable as written

The cleaned output becomes the user's practice input, but the only protection against summarization or rephrasing is prompt text. That is too weak for a read-aloud scoring pipeline.

Run deterministic Markdown extraction first, then either skip the LLM or validate LLM output against the deterministic text with token-overlap/order checks. If the model drops, adds, or reorders too much material, fall back to deterministic cleanup.

### 4. Medium: the LLM integration does not match the current `llm.rs` shape

The spec says to reuse the LLM client/helper, but current `llm.rs` exposes a feedback-specific `get_feedback` path that returns score/comments JSON. Markdown cleanup needs a separate generic text-completion helper using `LlmConfig`, status checks, timeout, empty-response handling, and no feedback JSON parser.

### 5. Medium: no context or file-size limits

Whole files and multi-file concatenation are allowed, then sent in one LLM request. Large Markdown files can block the command, exceed model context, or produce huge TTS input.

Specify hard caps and user-facing warnings or errors for max entries, per-file size, total input size, and final cleaned text length.

### 6. Medium: session state side effects are incomplete

Read MD replaces `inputText`, but the spec does not say to clear old feedback or clear the screenshot/paste thumbnail. Existing capture and paste flows maintain thumbnail state explicitly; Read MD should do the same and probably clear stale feedback.

### 7. Medium: fallback Markdown stripping is too ad hoc for "faithful cleanup"

The fallback rules miss common Markdown constructs: `~~~` fences, Setext headings, reference links, autolinks, HTML blocks, escaped emphasis, nested links, and real tables.

If fidelity matters, use a Markdown parser such as `pulldown-cmark`; if the simple stripper is intentional, document the known degradation.

### 8. Low: range syntax has an unavoidable ambiguity

A path ending in `:10-50` cannot be read as a whole file because the trailing range regex claims it. That may be acceptable on macOS, but the spec should state it or add quoting/escaping.

### 9. Low: async stale-result behavior is unspecified

If the modal is closed or reopened while `prepare_markdown` is still running, a late success can still overwrite the input. The frontend spec should include a request/session guard.

## Overall

The feature direction is sound and fits the app's Rust-owned pipeline, but this spec should not be implemented as-is. Before planning, tighten privacy handling for non-local LLM endpoints, file-read boundaries, LLM-output validation, input-size limits, and integration with existing session state and mock IPC.
