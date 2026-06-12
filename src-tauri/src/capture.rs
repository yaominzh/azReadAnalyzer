use reqwest::Client;
use std::path::Path;
use tempfile::NamedTempFile;

// macOS Screen Recording (TCC) preflight. `screencapture -i` silently produces
// an empty file when the responsible app lacks Screen Recording permission —
// indistinguishable from a user cancel by exit code/size alone. We use these
// CoreGraphics APIs only on the failure path to tell the two apart and give a
// helpful error (and trigger the OS prompt) instead of swallowing it silently.
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

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

    // No image produced (non-zero exit or 0-byte file). This happens on a user
    // cancel AND on a Screen Recording permission denial — disambiguate so the
    // latter isn't silently swallowed.
    let empty = std::fs::metadata(&path).map(|m| m.len() == 0).unwrap_or(true);
    if !status.success() || empty {
        #[cfg(target_os = "macos")]
        {
            // SAFETY: argument-less CoreGraphics C functions, no shared state.
            let granted = unsafe { CGPreflightScreenCaptureAccess() };
            if !granted {
                // Trigger the OS prompt / add us to the Screen Recording list
                // for next launch, then report a distinct, actionable error.
                unsafe { CGRequestScreenCaptureAccess() };
                return Err("Screen recording permission denied".into());
            }
        }
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
