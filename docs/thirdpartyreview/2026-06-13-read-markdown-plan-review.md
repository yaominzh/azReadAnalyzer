# Read from Markdown Files — Plan Review

**Date:** 2026-06-14  
**Reviewed plan:** `docs/superpowers/plans/2026-06-13-read-markdown.md`

## Findings

### 1. High: Rust tests in Task 1/2 will not run because `markdown.rs` is not registered until Task 3

The plan creates `src-tauri/src/markdown.rs` in Task 1 and runs `cargo test markdown::tests`, but `src-tauri/src/lib.rs` does not get `pub mod markdown;` until Task 3.

Until the module is registered, Rust will not compile or discover tests in that file, so the "failing test first" step is invalid and can silently report 0 tests. Move `pub mod markdown;` into Task 1 before the first test run, and keep command registration for Task 3.

### 2. Medium: Read MD clears only frontend thumbnail state, leaving Rust's authoritative capture image stale

The plan's success path calls `clearCaptureImage()` and `clearFeedback()`, but does not invoke `clear_session_media`. Existing Clear does both frontend clear and backend clear. Since Rust `last_capture_png` remains available through `get_capture_image`, Read MD should call:

```ts
invoke("clear_session_media").catch(() => {});
```

on success. Add a test expectation for that call.

### 3. Medium: mock-mode behavior bypasses the command instead of mocking it

The proposed component returns `{ text: input, warnings: [] }` when `VITE_USE_MOCK` is true. That means browser mock mode puts file paths into the practice box, not simulated Markdown content, and `prepare_markdown` is never exercised through the shared invoke mock.

Prefer adding `prepare_markdown` to `src/__mocks__/@tauri-apps/api/index.ts` and always calling `invoke`, consistent with the rest of the app.

### 4. Low: warning summary cannot produce the spec's richer counts

The plan's `summarize()` only emits `N notes — first warning`. That is acceptable, but it no longer matches the spec's richer example such as "Read 3 files · 2 skipped, 1 truncated".

Either adjust the spec expectation or keep the generic summary language in the plan.

### 5. Low: Task 2 test coverage is weaker than the design

The plan includes basic parsing, slicing, and relative-path tests, but it does not test `MAX_ENTRIES`, `MAX_TOTAL_MD_BYTES`, `MAX_TOTAL_CHARS`, directory skip, oversized file skip, `~/` expansion, or "aggregate cap stops further reads," despite those being called out in the spec and self-review.

Add targeted unit tests before implementation.

## Overall

The plan is close, but the module-registration issue should be fixed before execution. Without it, the early Rust TDD steps are misleading. The backend thumbnail clear is the main behavioral gap.
