use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KernelCommand {
    HealthCheck {
        request_id: RequestId,
    },
    SnapshotGet {
        request_id: RequestId,
        session_id: Option<SessionId>,
    },
    ConfigGet {
        request_id: RequestId,
    },
    ConfigPatch {
        request_id: RequestId,
        patch: Value,
    },
    RunStart {
        request_id: RequestId,
        session_id: Option<SessionId>,
        input: UserInput,
    },
    PermissionResolve {
        request_id: RequestId,
        permission_id: String,
        decision: PermissionDecisionKind,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInput {
    pub text: String,
    pub attachments: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionDecisionKind {
    Accept,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KernelEvent {
    HostStatus {
        request_id: Option<RequestId>,
        status: HostStatus,
        detail: Option<String>,
    },
    SnapshotReady {
        request_id: RequestId,
        snapshot: KernelSnapshot,
    },
    ConfigChanged {
        snapshot: ConfigSnapshot,
    },
    PermissionRequested {
        session_id: SessionId,
        request: PermissionRequestEnvelope,
    },
    Error {
        request_id: Option<RequestId>,
        error: KernelErrorEnvelope,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostStatus {
    Starting,
    Ready,
    Degraded,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelSnapshot {
    pub session_id: Option<SessionId>,
    pub config: Option<ConfigSnapshot>,
    pub workflow: Option<Value>,
    pub trace: Vec<Value>,
    pub pending_permission: Option<PermissionRequestEnvelope>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub snapshot_id: String,
    pub schema_version: String,
    pub source_refs: Vec<ConfigSourceRef>,
    pub effective: Value,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSourceRef {
    pub id: String,
    pub kind: String,
    pub path: Option<String>,
    pub trust_level: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestEnvelope {
    pub id: String,
    pub capability: String,
    pub risk_level: String,
    pub summary: String,
    pub args_preview: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEnvelopeRef {
    pub id: String,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyProfileRef {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDescriptorRef {
    pub id: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelErrorEnvelope {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Error)]
pub enum KernelError {
    #[error("not implemented: {0}")]
    NotImplemented(&'static str),
    #[error("invalid command: {0}")]
    InvalidCommand(String),
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
            KernelError::PermissionDenied(_) => "permission_denied",
            KernelError::Other(_) => "kernel_error",
        };
        Self {
            code: code.to_string(),
            message: value.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_command_round_trips_as_tagged_json() {
        let command = KernelCommand::HealthCheck {
            request_id: RequestId("req-1".to_string()),
        };

        let encoded = serde_json::to_string(&command).expect("serialize command");
        assert!(encoded.contains("healthCheck"));

        let decoded: KernelCommand = serde_json::from_str(&encoded).expect("deserialize command");
        assert_eq!(decoded, command);
    }
}
