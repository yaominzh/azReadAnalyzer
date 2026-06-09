use reqwest::Client;
use std::path::Path;
use tempfile::NamedTempFile;

pub async fn capture_screen_region() -> Result<NamedTempFile, String> {
    // Unique temp file with a .png suffix; auto-deleted when the returned
    // handle is dropped by the caller (after OCR consumes it).
    let temp = tempfile::Builder::new()
        .prefix("az_capture_")
        .suffix(".png")
        .tempfile()
        .map_err(|e| format!("temp file: {e}"))?;
    let path = temp.path().to_path_buf();

    // screencapture -i: interactive region selection; exits non-zero if cancelled.
    // It overwrites the (empty) temp file at `path`.
    let status = std::process::Command::new("screencapture")
        .args(["-i", path.to_str().unwrap()])
        .status()
        .map_err(|e| format!("screencapture failed: {e}"))?;

    // Cancelled → file left empty (0 bytes). Treat empty as cancelled.
    let empty = std::fs::metadata(&path).map(|m| m.len() == 0).unwrap_or(true);
    if !status.success() || empty {
        return Err("Screenshot cancelled".into());
    }

    Ok(temp)
}

pub async fn call_ocr_sidecar(image_path: &Path) -> Result<String, String> {
    let client = Client::new();
    let resp = client
        .post("http://127.0.0.1:8124/ocr")
        .json(&serde_json::json!({"image_path": image_path.to_str().unwrap()}))
        .send()
        .await
        .map_err(|_| "OCR service not running — start ocr_service/".to_string())?;

    if !resp.status().is_success() {
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("OCR error: {detail}"));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json["text"].as_str().unwrap_or("").to_string())
}

pub async fn call_tts_sidecar(text: &str) -> Result<Vec<u8>, String> {
    let client = Client::new();
    let resp = client
        .post("http://127.0.0.1:8123/tts")
        .json(&serde_json::json!({"text": text}))
        .send()
        .await
        .map_err(|_| "TTS service not running — start tts_service/".to_string())?;

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // Integration test — requires ocr_service running on :8124.
    // Run with: cargo test capture::tests::ocr_sidecar_reachable -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "requires ocr_service on :8124"]
    async fn ocr_sidecar_reachable() {
        let result = call_ocr_sidecar(&PathBuf::from("/nonexistent.png")).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(!err.contains("not running"), "OCR sidecar not running on :8124");
    }
}
