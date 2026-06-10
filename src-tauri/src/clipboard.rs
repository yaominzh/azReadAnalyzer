pub fn read_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .get_text()
        .map_err(|e| format!("Clipboard empty or non-text: {e}"))
}

/// Read an image from the clipboard and encode it to PNG bytes (#4).
/// arboard returns `ImageData<'static> { width, height, bytes: Cow<[u8]> }` as
/// RGBA8 row-major, which maps directly to `image::RgbaImage` (no channel swap).
pub fn read_image_png() -> Result<Vec<u8>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let img = clipboard
        .get_image()
        .map_err(|e| format!("No image in clipboard: {e}"))?;
    let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned())
        .ok_or("clipboard image size mismatch")?;
    let mut buf = std::io::Cursor::new(Vec::new());
    rgba.write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}

#[cfg(test)]
mod tests {
    // arboard requires a display server; test is compile-only on CI
    #[test]
    fn read_text_compiles() {
        let _ = super::read_text;
    }
}
