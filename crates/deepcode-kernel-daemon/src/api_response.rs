#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

pub(crate) const LARGE_JSON_BODY_LIMIT_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiResponse {
    pub(crate) ok: bool,
    pub(crate) data: Option<Value>,
    pub(crate) error: Option<String>,
    pub(crate) message: Option<String>,
}

impl ApiResponse {
    pub(crate) fn ok(data: Value) -> Json<Self> {
        Json(Self {
            ok: true,
            data: Some(data),
            error: None,
            message: None,
        })
    }

    pub(crate) fn error(code: impl Into<String>, message: impl Into<String>) -> Json<Self> {
        Json(Self {
            ok: false,
            data: None,
            error: Some(code.into()),
            message: Some(message.into()),
        })
    }

    pub(crate) fn error_with_data(
        code: impl Into<String>,
        message: impl Into<String>,
        data: Value,
    ) -> Json<Self> {
        Json(Self {
            ok: false,
            data: Some(data),
            error: Some(code.into()),
            message: Some(message.into()),
        })
    }
}

pub(crate) fn json_body_rejection_response(
    route: &str,
    rejection: JsonRejection,
) -> Json<ApiResponse> {
    let (code, message) = json_body_rejection_error(route, &rejection);
    ApiResponse::error_with_data(
        code,
        message,
        json!({
            "route": route,
            "status": rejection.status().as_u16(),
            "bodyLimitBytes": LARGE_JSON_BODY_LIMIT_BYTES,
            "suggestion": "Compact provider traces and avoid archiving raw streaming chunks or full provider payload arrays."
        }),
    )
}

pub(crate) fn json_body_rejection_error(
    route: &str,
    rejection: &JsonRejection,
) -> (&'static str, String) {
    if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return (
            "http_body_too_large",
            format!(
                "{route} request body exceeded the local DeepCode HTTP body limit of {} bytes; compact provider traces before retrying",
                LARGE_JSON_BODY_LIMIT_BYTES
            ),
        );
    }
    (
        "invalid_json_body",
        format!(
            "{route} request body is invalid JSON: {}",
            rejection.body_text()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_json_body_limit_covers_deepcode_context_envelope() {
        assert!(LARGE_JSON_BODY_LIMIT_BYTES >= 128 * 1024 * 1024);
    }
}
