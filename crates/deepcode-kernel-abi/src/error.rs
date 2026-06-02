use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelErrorEnvelope {
    pub code: String,
    pub message: String,
    pub message_key: Option<String>,
    pub args: Option<Value>,
}

#[derive(Debug, Error)]
pub enum KernelError {
    #[error("not implemented: {0}")]
    NotImplemented(&'static str),
    #[error("invalid command: {0}")]
    InvalidCommand(String),
    #[error("workspace binding is required")]
    MissingWorkspaceBinding,
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("kernel error: {0}")]
    Other(String),
}

pub type KernelResult<T> = Result<T, KernelError>;

impl From<&KernelError> for KernelErrorEnvelope {
    fn from(value: &KernelError) -> Self {
        let code = match value {
            KernelError::NotImplemented(_) => "not_implemented",
            KernelError::InvalidCommand(_) => "invalid_command",
            KernelError::MissingWorkspaceBinding => "workspace_binding_required",
            KernelError::PermissionDenied(_) => "permission_denied",
            KernelError::Other(_) => "kernel_error",
        };
        Self {
            code: code.to_string(),
            message: value.to_string(),
            message_key: None,
            args: None,
        }
    }
}
