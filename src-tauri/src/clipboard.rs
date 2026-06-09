pub fn read_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .get_text()
        .map_err(|e| format!("Clipboard empty or non-text: {e}"))
}

#[cfg(test)]
mod tests {
    // arboard requires a display server; test is compile-only on CI
    #[test]
    fn read_text_compiles() {
        let _ = super::read_text;
    }
}
