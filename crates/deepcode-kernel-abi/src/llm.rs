use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LlmProviderErrorLayer {
    Transport,
    HttpStatus,
    JsonDecode,
    SchemaDecode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProviderDiagnostic {
    pub reason: String,
    pub error_layer: LlmProviderErrorLayer,
    pub message: String,
    pub provider: String,
    pub profile_id: String,
    pub profile_name: String,
    pub model: String,
    pub status: Option<u16>,
    pub content_type: String,
    pub is_stream: bool,
    pub body_preview: String,
    pub body_hash: Option<String>,
    pub expected_schema: String,
}

impl fmt::Display for LlmProviderDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.reason, self.message)
    }
}

impl LlmProviderDiagnostic {
    pub fn archive_text(&self) -> String {
        format!(
            "{}:\n  provider = {}\n  status = {}\n  content_type = {}\n  is_stream = {}\n  body_preview = {}\n  expected_schema = {}",
            self.reason,
            self.provider,
            self.status
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            self.content_type,
            self.is_stream,
            if self.body_preview.is_empty() {
                "<empty>"
            } else {
                self.body_preview.as_str()
            },
            self.expected_schema
        )
    }
}
