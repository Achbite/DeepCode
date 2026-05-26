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
#[serde(rename_all = "camelCase")]
pub struct RunId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageRunId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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
        workspace_binding: Option<WorkspaceBinding>,
        profile_ref: Option<ProfileRef>,
        workflow_ref: Option<WorkflowRef>,
        run_overrides: Option<Value>,
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
pub struct WorkspaceBinding {
    pub workspace_id: Option<String>,
    pub workspace_hash: Option<String>,
    pub open_path: Option<String>,
    pub active_folder_id: Option<String>,
    pub folder_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRef {
    pub id: String,
    pub kind: Option<String>,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRef {
    pub id: String,
    pub version: Option<String>,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionDecisionKind {
    Accept,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum KernelEvent {
    #[serde(rename = "host.status")]
    HostStatus {
        request_id: Option<RequestId>,
        status: HostStatus,
        detail: Option<String>,
        message_key: Option<String>,
        args: Option<Value>,
    },
    #[serde(rename = "snapshot.ready")]
    SnapshotReady {
        request_id: RequestId,
        snapshot: KernelSnapshot,
    },
    #[serde(rename = "run.started")]
    RunStarted {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        workspace_binding: WorkspaceBinding,
        sequence: Option<u64>,
    },
    #[serde(rename = "run.completed")]
    RunCompleted {
        run_id: RunId,
        session_id: Option<SessionId>,
        status: RunStatus,
        summary: Option<String>,
        sequence: Option<u64>,
    },
    #[serde(rename = "stage.changed")]
    StageChanged {
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        turn_id: Option<TurnId>,
        stage_run_id: Option<StageRunId>,
        phase: String,
        status: StageStatus,
        reason: Option<String>,
        sequence: Option<u64>,
    },
    #[serde(rename = "message.appended")]
    MessageAppended {
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        turn_id: Option<TurnId>,
        role: MessageRole,
        channel: Option<String>,
        content: Option<String>,
        message_key: Option<String>,
        args: Option<Value>,
        sequence: Option<u64>,
    },
    #[serde(rename = "tool.requested")]
    ToolRequested {
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        turn_id: Option<TurnId>,
        tool_call_id: String,
        tool_name: String,
        args_preview: Value,
        sequence: Option<u64>,
    },
    #[serde(rename = "tool.completed")]
    ToolCompleted {
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        turn_id: Option<TurnId>,
        tool_call_id: String,
        tool_name: String,
        ok: bool,
        output: Option<Value>,
        error: Option<KernelErrorEnvelope>,
        sequence: Option<u64>,
    },
    #[serde(rename = "permission.requested")]
    PermissionRequested {
        run_id: Option<RunId>,
        session_id: SessionId,
        request: PermissionRequestEnvelope,
        sequence: Option<u64>,
    },
    #[serde(rename = "permission.resolved")]
    PermissionResolved {
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        permission_id: String,
        decision: PermissionDecisionKind,
        reason: Option<String>,
        sequence: Option<u64>,
    },
    #[serde(rename = "config.snapshot.attached")]
    ConfigSnapshotAttached {
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        snapshot_ref: ConfigSnapshotRef,
        sequence: Option<u64>,
    },
    #[serde(rename = "error")]
    Error {
        request_id: Option<RequestId>,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        error: KernelErrorEnvelope,
        message_key: Option<String>,
        args: Option<Value>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StageStatus {
    Pending,
    Running,
    Completed,
    Blocked,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageRole {
    User,
    Agent,
    System,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelSnapshot {
    pub session_id: Option<SessionId>,
    pub run_id: Option<RunId>,
    pub workspace_binding: Option<WorkspaceBinding>,
    pub config_ref: Option<ConfigSnapshotRef>,
    pub workflow_phase: Option<String>,
    pub pending_stage: Option<String>,
    pub events: Vec<KernelEventSummary>,
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
pub struct ConfigSnapshotRef {
    pub snapshot_id: String,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelEventSummary {
    pub id: Option<String>,
    pub kind: String,
    pub sequence: Option<u64>,
    pub summary: Option<String>,
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

    #[test]
    fn run_start_carries_workspace_binding_and_refs() {
        let command = KernelCommand::RunStart {
            request_id: RequestId("req-run".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "inspect workspace".to_string(),
                attachments: vec![serde_json::json!({ "kind": "context" })],
            },
            workspace_binding: Some(WorkspaceBinding {
                workspace_id: Some("ws-1".to_string()),
                workspace_hash: Some("hash-1".to_string()),
                open_path: Some("/workspace/project.code-workspace".to_string()),
                active_folder_id: Some("wf-0".to_string()),
                folder_hash: Some("folder-hash".to_string()),
            }),
            profile_ref: Some(ProfileRef {
                id: "developer".to_string(),
                kind: Some("policy".to_string()),
                hash: None,
            }),
            workflow_ref: Some(WorkflowRef {
                id: "plan-first".to_string(),
                version: Some("1".to_string()),
                hash: None,
            }),
            run_overrides: Some(serde_json::json!({ "mode": "plan" })),
        };

        let encoded = serde_json::to_value(&command).expect("serialize run start");
        assert_eq!(encoded["kind"], "runStart");
        assert_eq!(encoded["workspaceBinding"]["activeFolderId"], "wf-0");
        assert_eq!(encoded["profileRef"]["id"], "developer");
        assert_eq!(encoded["workflowRef"]["id"], "plan-first");

        let decoded: KernelCommand =
            serde_json::from_value(encoded).expect("deserialize run start");
        assert_eq!(decoded, command);
    }

    #[test]
    fn kernel_event_uses_locale_neutral_dotted_kind() {
        let event = KernelEvent::MessageAppended {
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            turn_id: Some(TurnId("turn-1".to_string())),
            role: MessageRole::Agent,
            channel: Some("final".to_string()),
            content: None,
            message_key: Some("agent.done".to_string()),
            args: Some(serde_json::json!({ "count": 1 })),
            sequence: Some(7),
        };

        let encoded = serde_json::to_value(&event).expect("serialize event");
        assert_eq!(encoded["kind"], "message.appended");
        assert_eq!(encoded["messageKey"], "agent.done");
        assert_eq!(encoded["sequence"], 7);

        let decoded: KernelEvent = serde_json::from_value(encoded).expect("deserialize event");
        assert_eq!(decoded, event);
    }

    #[test]
    fn kernel_snapshot_is_recoverable_without_gui_state() {
        let snapshot = KernelSnapshot {
            session_id: Some(SessionId("session-1".to_string())),
            run_id: Some(RunId("run-1".to_string())),
            workspace_binding: Some(WorkspaceBinding {
                workspace_id: Some("ws-1".to_string()),
                workspace_hash: Some("hash-1".to_string()),
                open_path: None,
                active_folder_id: Some("wf-0".to_string()),
                folder_hash: None,
            }),
            config_ref: Some(ConfigSnapshotRef {
                snapshot_id: "cfg-1".to_string(),
                hash: Some("cfg-hash".to_string()),
            }),
            workflow_phase: Some("plan".to_string()),
            pending_stage: None,
            events: vec![KernelEventSummary {
                id: Some("evt-1".to_string()),
                kind: "run.started".to_string(),
                sequence: Some(1),
                summary: Some("Run started".to_string()),
            }],
            pending_permission: None,
            updated_at: Some("2026-05-26T00:00:00Z".to_string()),
        };

        let encoded = serde_json::to_value(&snapshot).expect("serialize snapshot");
        assert!(encoded.get("panelState").is_none());
        assert!(encoded.get("editorState").is_none());
        assert_eq!(encoded["workspaceBinding"]["activeFolderId"], "wf-0");

        let decoded: KernelSnapshot =
            serde_json::from_value(encoded).expect("deserialize snapshot");
        assert_eq!(decoded, snapshot);
    }
}
