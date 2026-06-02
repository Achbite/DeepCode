#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

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
}
