use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const DEFAULT_BASE_URL: &str = "http://127.0.0.1:8002/v1";
const DEFAULT_MODEL: &str = "default";
const DEFAULT_TIMEOUT_SECS: u64 = 45;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub llm_base_url: String,
    pub llm_model: String,
    pub llm_api_key: String,
    pub llm_timeout_secs: u64,
}

impl Default for AppSettings {
    /// Seed from OMLX_* env when present, else built-in defaults — so the
    /// current env-var launch keeps working until the user saves settings.
    fn default() -> Self {
        Self {
            llm_base_url: std::env::var("OMLX_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.into()),
            llm_model: std::env::var("OMLX_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into()),
            llm_api_key: std::env::var("OMLX_API_KEY").unwrap_or_default(),
            llm_timeout_secs: std::env::var("OMLX_TIMEOUT_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .filter(|&n| (5..=300).contains(&n))
                .unwrap_or(DEFAULT_TIMEOUT_SECS),
        }
    }
}

impl AppSettings {
    /// Built-in reset values (NOT env) — the panel's "Defaults" button.
    pub fn builtin() -> Self {
        Self {
            llm_base_url: DEFAULT_BASE_URL.into(),
            llm_model: DEFAULT_MODEL.into(),
            llm_api_key: String::new(),
            llm_timeout_secs: DEFAULT_TIMEOUT_SECS,
        }
    }

    pub fn config_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".azreadanalyzer/settings.json")
    }

    pub fn load() -> Self {
        Self::load_from(&Self::config_path())
    }

    pub fn load_from(path: &std::path::Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<AppSettings>(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        self.save_to(&Self::config_path())
    }

    pub fn save_to(&self, path: &std::path::Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    /// Validate + normalize in place (review #3): parse with the `url` crate,
    /// require an http/https scheme + host, strip a trailing `/chat/completions`
    /// (llm.rs appends that itself) and any trailing slash, and enforce the
    /// timeout range. Returns Err (caller persists nothing) on invalid input.
    pub fn validate_and_normalize(&mut self) -> Result<(), String> {
        let raw = self.llm_base_url.trim();
        let parsed = url::Url::parse(raw).map_err(|_| "Base URL is not a valid URL".to_string())?;
        match parsed.scheme() {
            "http" | "https" => {}
            _ => return Err("Base URL must use http or https".into()),
        }
        if parsed.host_str().is_none() {
            return Err("Base URL must include a host".into());
        }
        let mut base = raw.trim_end_matches('/').to_string();
        if let Some(stripped) = base.strip_suffix("/chat/completions") {
            base = stripped.trim_end_matches('/').to_string();
        }
        self.llm_base_url = base;

        self.llm_model = self.llm_model.trim().to_string();
        if self.llm_model.is_empty() {
            return Err("Model must not be empty".into());
        }
        if !(5..=300).contains(&self.llm_timeout_secs) {
            return Err("Timeout must be 5–300 seconds".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_has_loopback_default() {
        let s = AppSettings::builtin();
        assert_eq!(s.llm_base_url, "http://127.0.0.1:8002/v1");
        assert_eq!(s.llm_timeout_secs, 45);
        assert!(s.llm_api_key.is_empty());
    }

    #[test]
    fn normalize_strips_trailing_slash() {
        let mut s = AppSettings::builtin();
        s.llm_base_url = "  http://127.0.0.1:8002/v1/  ".into();
        s.validate_and_normalize().unwrap();
        assert_eq!(s.llm_base_url, "http://127.0.0.1:8002/v1");
    }

    #[test]
    fn normalize_rejects_no_scheme() {
        let mut s = AppSettings::builtin();
        s.llm_base_url = "127.0.0.1:8002/v1".into();
        assert!(s.validate_and_normalize().is_err());
    }

    #[test]
    fn normalize_rejects_bad_timeout() {
        let mut s = AppSettings::builtin();
        s.llm_timeout_secs = 1;
        assert!(s.validate_and_normalize().is_err());
    }

    #[test]
    fn normalize_strips_chat_completions_suffix() {
        let mut s = AppSettings::builtin();
        s.llm_base_url = "http://127.0.0.1:8002/v1/chat/completions".into();
        s.validate_and_normalize().unwrap();
        assert_eq!(s.llm_base_url, "http://127.0.0.1:8002/v1");
    }

    #[test]
    fn save_to_then_load_from_roundtrips() {
        // (review #6) exercises the real save_to/load_from, not manual JSON.
        let mut s = AppSettings::builtin();
        s.llm_model = "gemma-4-e4b-it-4bit".into();
        let path = std::env::temp_dir().join("azra_settings_test").join("settings.json");
        s.save_to(&path).unwrap();
        let back = AppSettings::load_from(&path);
        assert_eq!(s, back);
    }
}
