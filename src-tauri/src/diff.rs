use similar::{ChangeTag, TextDiff};

use crate::events::DiffToken;

/// Deterministic word-level diff between the original text and the transcription.
/// Owned by Rust (not the LLM) so it is testable and reproducible.
/// missed = in original, not said; added = said, not in original; correct = match.
pub fn word_diff(original: &str, transcription: &str) -> Vec<DiffToken> {
    let diff = TextDiff::from_words(original, transcription);
    let mut tokens = Vec::new();

    for change in diff.iter_all_changes() {
        let text = change.value().to_string();
        if text.is_empty() {
            continue;
        }
        let token_type = match change.tag() {
            ChangeTag::Equal => "correct",
            ChangeTag::Delete => "missed",
            ChangeTag::Insert => "added",
        }
        .to_string();
        tokens.push(DiffToken { text, token_type });
    }

    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_all_correct() {
        let result = word_diff("hello world", "hello world");
        assert!(result.iter().all(|t| t.token_type == "correct"));
    }

    #[test]
    fn missing_word_marked_missed() {
        let result = word_diff("hello world foo", "hello world");
        assert!(result.iter().any(|t| t.token_type == "missed" && t.text.contains("foo")));
    }

    #[test]
    fn extra_word_marked_added() {
        let result = word_diff("hello world", "hello beautiful world");
        assert!(result.iter().any(|t| t.token_type == "added" && t.text.contains("beautiful")));
    }
}
