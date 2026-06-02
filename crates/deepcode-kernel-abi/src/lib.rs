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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    LlmResponseSubmit {
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        llm_call_id: String,
        response_envelope: Value,
    },
    RunCancel {
        request_id: RequestId,
        run_id: RunId,
    },
    RunResume {
        request_id: RequestId,
        session_id: SessionId,
    },
    WorkspaceOpen {
        request_id: RequestId,
        path: String,
    },
    WorkspaceCurrent {
        request_id: RequestId,
    },
    WorkspaceList {
        request_id: RequestId,
        folder_id: Option<String>,
        path: Option<String>,
        depth: Option<u32>,
    },
    WorkspaceRead {
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
    },
    WorkspaceWrite {
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
        content: String,
        create: bool,
    },
    WorkspaceCreate {
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
        content: Option<String>,
    },
    WorkspaceCreateFolder {
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
    },
    WorkspaceRename {
        request_id: RequestId,
        folder_id: Option<String>,
        old_path: String,
        new_path: String,
    },
    WorkspaceDelete {
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
    },
    WorkspaceSearch {
        request_id: RequestId,
        folder_id: Option<String>,
        query: String,
        include: Option<Vec<String>>,
        is_regex: bool,
    },
    ToolInvoke {
        request_id: RequestId,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        tool_call_id: String,
        tool_name: String,
        arguments: Value,
        workspace_binding: Option<WorkspaceBinding>,
    },
    SkillDiscover {
        request_id: RequestId,
    },
    SkillInvoke {
        request_id: RequestId,
        skill_id: String,
        input: Value,
    },
    ContextAttachReference {
        request_id: RequestId,
        source_path: String,
        import_copy: bool,
    },
    ContextListReferences {
        request_id: RequestId,
    },
    WorkflowObserve {
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        event: Box<KernelEvent>,
    },
    PermissionResolve {
        request_id: RequestId,
        permission_id: String,
        decision: PermissionDecisionKind,
    },
    PlanAccept {
        request_id: RequestId,
        run_id: RunId,
        plan_id: String,
    },
    PlanReject {
        request_id: RequestId,
        run_id: RunId,
        plan_id: String,
        reason: Option<String>,
    },
    PlanRevise {
        request_id: RequestId,
        run_id: RunId,
        plan_id: String,
        guidance: String,
    },
    PlanContractSubmit {
        request_id: RequestId,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        contract: Value,
    },
    SkillTrustApprove {
        request_id: RequestId,
        skill_id: String,
        decision: Value,
    },
    McpRiskAcknowledgmentSubmit {
        request_id: RequestId,
        connector_id: String,
        binding_id: Option<String>,
        acknowledgment: Value,
    },
    AuditVerify {
        request_id: RequestId,
        scope: Value,
    },
    AuditQuery {
        request_id: RequestId,
        filter: Value,
        projection: Option<String>,
    },
    PermissionGrantTemporary {
        request_id: RequestId,
        run_id: RunId,
        grant: TemporaryGrantEnvelope,
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
pub struct TemporaryGrantEnvelope {
    pub id: String,
    pub capability: String,
    pub resource_kind: String,
    pub resource_path: Option<String>,
    pub expires_after_sequence: Option<u64>,
    pub reason: Option<String>,
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
    #[serde(rename = "llm.call_requested")]
    LlmCallRequested {
        run_id: RunId,
        session_id: Option<SessionId>,
        phase: String,
        llm_call_id: String,
        profile_ref: Option<ProfileRef>,
        request_envelope: Value,
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
    #[serde(rename = "autonomy.transitioned")]
    AutonomyTransitioned {
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        from_level: Option<String>,
        to_level: String,
        capability_set: Vec<String>,
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
    #[serde(rename = "plan.proposed")]
    PlanProposed {
        run_id: RunId,
        session_id: Option<SessionId>,
        plan_id: String,
        summary: Option<String>,
        sequence: Option<u64>,
    },
    #[serde(rename = "plan.accepted")]
    PlanAccepted {
        run_id: RunId,
        session_id: Option<SessionId>,
        plan_id: String,
        auto_accepted: bool,
        sequence: Option<u64>,
    },
    #[serde(rename = "plan.rejected")]
    PlanRejected {
        run_id: RunId,
        session_id: Option<SessionId>,
        plan_id: String,
        reason: Option<String>,
        sequence: Option<u64>,
    },
    #[serde(rename = "plan.review_report_produced")]
    PlanReviewReportProduced {
        request_id: Option<RequestId>,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        report: Value,
        sequence: Option<u64>,
    },
    #[serde(rename = "workflow.checkpointed")]
    WorkflowCheckpointed {
        run_id: RunId,
        session_id: Option<SessionId>,
        checkpoint_id: String,
        phase: String,
        sequence: Option<u64>,
    },
    #[serde(rename = "workflow.resumed")]
    WorkflowResumed {
        run_id: RunId,
        session_id: Option<SessionId>,
        checkpoint_id: String,
        phase: String,
        sequence: Option<u64>,
    },
    #[serde(rename = "workflow.decision_made")]
    WorkflowDecisionMade {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        decision: WorkflowDecision,
        sequence: Option<u64>,
    },
    #[serde(rename = "workspace.result")]
    WorkspaceResult {
        request_id: RequestId,
        operation: String,
        ok: bool,
        output: Option<Value>,
        error: Option<KernelErrorEnvelope>,
        sequence: Option<u64>,
    },
    #[serde(rename = "skill.result")]
    SkillResult {
        request_id: RequestId,
        skill_id: Option<String>,
        ok: bool,
        output: Option<Value>,
        error: Option<KernelErrorEnvelope>,
        sequence: Option<u64>,
    },
    #[serde(rename = "skill.trust_requested")]
    SkillTrustRequested {
        request_id: Option<RequestId>,
        skill_id: String,
        hash: Option<String>,
        request: Value,
        sequence: Option<u64>,
    },
    #[serde(rename = "skill.trust_granted")]
    SkillTrustGranted {
        request_id: Option<RequestId>,
        skill_id: String,
        trust_record: Value,
        sequence: Option<u64>,
    },
    #[serde(rename = "mcp.risk_acknowledgment_required")]
    McpRiskAcknowledgmentRequired {
        request_id: Option<RequestId>,
        connector_id: String,
        binding_id: Option<String>,
        risk_report: Value,
        sequence: Option<u64>,
    },
    #[serde(rename = "context.result")]
    ContextResult {
        request_id: RequestId,
        operation: String,
        ok: bool,
        output: Option<Value>,
        error: Option<KernelErrorEnvelope>,
        sequence: Option<u64>,
    },
    #[serde(rename = "tempArtifact.created")]
    TempArtifactCreated {
        run_id: RunId,
        session_id: Option<SessionId>,
        path: String,
        sequence: Option<u64>,
    },
    #[serde(rename = "tempArtifact.cleaned")]
    TempArtifactCleaned {
        run_id: RunId,
        session_id: Option<SessionId>,
        path: String,
        sequence: Option<u64>,
    },
    #[serde(rename = "tempArtifact.lease_granted")]
    TempArtifactLeaseGranted {
        run_id: RunId,
        session_id: Option<SessionId>,
        lease_id: String,
        artifact_id: String,
        scope: String,
        required: bool,
        sequence: Option<u64>,
    },
    #[serde(rename = "tempArtifact.lease_released")]
    TempArtifactLeaseReleased {
        run_id: RunId,
        session_id: Option<SessionId>,
        lease_id: String,
        artifact_id: String,
        cleanup_ok: bool,
        sequence: Option<u64>,
    },
    #[serde(rename = "tempArtifact.lease_promoted")]
    TempArtifactLeasePromoted {
        run_id: RunId,
        session_id: Option<SessionId>,
        lease_id: String,
        artifact_id: String,
        from_scope: String,
        to_scope: String,
        sequence: Option<u64>,
    },
    #[serde(rename = "tempCleanup.failed")]
    TempCleanupFailed {
        run_id: RunId,
        session_id: Option<SessionId>,
        path: String,
        error: KernelErrorEnvelope,
        sequence: Option<u64>,
    },
    #[serde(rename = "audit.verify_started")]
    AuditVerifyStarted {
        request_id: Option<RequestId>,
        scope: Value,
        sequence: Option<u64>,
    },
    #[serde(rename = "audit.verify_completed")]
    AuditVerifyCompleted {
        request_id: Option<RequestId>,
        ok: bool,
        report: Value,
        sequence: Option<u64>,
    },
    #[serde(rename = "audit.degraded_entered")]
    AuditDegradedEntered {
        request_id: Option<RequestId>,
        reason: String,
        sequence: Option<u64>,
    },
    #[serde(rename = "audit.degraded_exited")]
    AuditDegradedExited {
        request_id: Option<RequestId>,
        reason: Option<String>,
        sequence: Option<u64>,
    },
    #[serde(rename = "audit.segment_rotated")]
    AuditSegmentRotated {
        request_id: Option<RequestId>,
        segment_id: String,
        seal: Value,
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
    pub created_at: Option<String>,
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
pub enum WorkflowDecisionAction {
    Continue,
    AwaitPermission,
    Replan,
    Review,
    Done,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowDecisionReason {
    EventAccepted,
    AwaitingPermission,
    PermissionRejected,
    PendingCriticalSteps,
    CompletionCriteriaSatisfied,
    AnswerObligationsSatisfied,
    ToolFailed,
    KernelUnableToDecide,
    FailClosed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnswerObligationId {
    Identity,
    ToolComponentSummary,
    TempFileLifecycleResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnswerObligationStatus {
    Pending,
    Satisfied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerObligation {
    pub id: AnswerObligationId,
    pub description: String,
    pub status: AnswerObligationStatus,
    pub satisfied_by_event: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDecision {
    pub action: WorkflowDecisionAction,
    pub reason: WorkflowDecisionReason,
    pub phase: Option<String>,
    pub pending_steps: Vec<String>,
    pub answer_obligations: Vec<AnswerObligation>,
    pub summary: Option<String>,
    pub fail_closed: bool,
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
    fn workspace_and_skill_syscalls_round_trip() {
        let command = KernelCommand::WorkspaceWrite {
            request_id: RequestId("req-write".to_string()),
            folder_id: Some("wf-0".to_string()),
            path: "_agent_tmp_syscall.txt".to_string(),
            content: "hello".to_string(),
            create: true,
        };

        let encoded = serde_json::to_value(&command).expect("serialize workspace write");
        assert_eq!(encoded["kind"], "workspaceWrite");
        assert_eq!(encoded["path"], "_agent_tmp_syscall.txt");

        let decoded: KernelCommand =
            serde_json::from_value(encoded).expect("deserialize workspace write");
        assert_eq!(decoded, command);

        let command = KernelCommand::SkillInvoke {
            request_id: RequestId("req-skill".to_string()),
            skill_id: "external.python.echo".to_string(),
            input: serde_json::json!({ "text": "ok" }),
        };
        let encoded = serde_json::to_value(&command).expect("serialize skill invoke");
        assert_eq!(encoded["kind"], "skillInvoke");
        assert_eq!(encoded["skillId"], "external.python.echo");
    }

    #[test]
    fn syscall_result_events_are_locale_neutral() {
        let event = KernelEvent::WorkspaceResult {
            request_id: RequestId("req-list".to_string()),
            operation: "workspace.list".to_string(),
            ok: true,
            output: Some(serde_json::json!({ "nodes": [] })),
            error: None,
            sequence: Some(1),
        };

        let encoded = serde_json::to_value(&event).expect("serialize workspace result");
        assert_eq!(encoded["kind"], "workspace.result");
        assert_eq!(encoded["operation"], "workspace.list");
        assert_eq!(encoded["ok"], true);
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
    fn plan_command_and_checkpoint_event_round_trip() {
        let command = KernelCommand::PermissionGrantTemporary {
            request_id: RequestId("req-grant".to_string()),
            run_id: RunId("run-1".to_string()),
            grant: TemporaryGrantEnvelope {
                id: "grant-1".to_string(),
                capability: "workspace.write".to_string(),
                resource_kind: "workspaceFile".to_string(),
                resource_path: Some("src/main.rs".to_string()),
                expires_after_sequence: Some(10),
                reason: Some("approved test grant".to_string()),
            },
        };
        let encoded = serde_json::to_value(&command).expect("serialize command");
        assert_eq!(encoded["kind"], "permissionGrantTemporary");
        assert_eq!(encoded["grant"]["resourceKind"], "workspaceFile");
        let decoded: KernelCommand = serde_json::from_value(encoded).expect("deserialize command");
        assert_eq!(decoded, command);

        let event = KernelEvent::WorkflowCheckpointed {
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            checkpoint_id: "checkpoint-1".to_string(),
            phase: "plan".to_string(),
            sequence: Some(4),
        };
        let encoded = serde_json::to_value(&event).expect("serialize event");
        assert_eq!(encoded["kind"], "workflow.checkpointed");
        assert_eq!(encoded["checkpointId"], "checkpoint-1");
        let decoded: KernelEvent = serde_json::from_value(encoded).expect("deserialize event");
        assert_eq!(decoded, event);
    }

    #[test]
    fn plan_review_and_skill_trust_placeholders_round_trip() {
        let command = KernelCommand::PlanContractSubmit {
            request_id: RequestId("req-plan-contract".to_string()),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            contract: serde_json::json!({ "id": "plan-1", "status": "draft" }),
        };
        let encoded = serde_json::to_value(&command).expect("serialize plan contract command");
        assert_eq!(encoded["kind"], "planContractSubmit");
        assert_eq!(encoded["contract"]["id"], "plan-1");
        let decoded: KernelCommand =
            serde_json::from_value(encoded).expect("deserialize plan contract command");
        assert_eq!(decoded, command);

        let event = KernelEvent::PlanReviewReportProduced {
            request_id: Some(RequestId("req-plan-review".to_string())),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            report: serde_json::json!({ "status": "interfaceOnly" }),
            sequence: Some(9),
        };
        let encoded = serde_json::to_value(&event).expect("serialize plan review event");
        assert_eq!(encoded["kind"], "plan.review_report_produced");
        assert_eq!(encoded["report"]["status"], "interfaceOnly");
        let decoded: KernelEvent =
            serde_json::from_value(encoded).expect("deserialize plan review event");
        assert_eq!(decoded, event);

        let event = KernelEvent::SkillTrustRequested {
            request_id: Some(RequestId("req-skill-trust".to_string())),
            skill_id: "skill.py".to_string(),
            hash: Some("sha256:abc".to_string()),
            request: serde_json::json!({ "trustMode": "brokeredScript" }),
            sequence: Some(10),
        };
        let encoded = serde_json::to_value(&event).expect("serialize skill trust event");
        assert_eq!(encoded["kind"], "skill.trust_requested");
        assert_eq!(encoded["hash"], "sha256:abc");
        let decoded: KernelEvent =
            serde_json::from_value(encoded).expect("deserialize skill trust event");
        assert_eq!(decoded, event);

        let command = KernelCommand::McpRiskAcknowledgmentSubmit {
            request_id: RequestId("req-mcp-risk".to_string()),
            connector_id: "mcp-text-tools".to_string(),
            binding_id: Some("text.uppercase".to_string()),
            acknowledgment: serde_json::json!({ "decision": "acknowledge" }),
        };
        let encoded = serde_json::to_value(&command).expect("serialize mcp risk command");
        assert_eq!(encoded["kind"], "mcpRiskAcknowledgmentSubmit");
        assert_eq!(encoded["connectorId"], "mcp-text-tools");
        let decoded: KernelCommand =
            serde_json::from_value(encoded).expect("deserialize mcp risk command");
        assert_eq!(decoded, command);

        let event = KernelEvent::McpRiskAcknowledgmentRequired {
            request_id: Some(RequestId("req-mcp-risk".to_string())),
            connector_id: "mcp-text-tools".to_string(),
            binding_id: Some("text.uppercase".to_string()),
            risk_report: serde_json::json!({ "riskLevel": "medium" }),
            sequence: Some(11),
        };
        let encoded = serde_json::to_value(&event).expect("serialize mcp risk event");
        assert_eq!(encoded["kind"], "mcp.risk_acknowledgment_required");
        assert_eq!(encoded["riskReport"]["riskLevel"], "medium");
        let decoded: KernelEvent =
            serde_json::from_value(encoded).expect("deserialize mcp risk event");
        assert_eq!(decoded, event);
    }

    #[test]
    fn audit_placeholders_round_trip() {
        let command = KernelCommand::AuditVerify {
            request_id: RequestId("req-audit-verify".to_string()),
            scope: serde_json::json!({ "kind": "all" }),
        };
        let encoded = serde_json::to_value(&command).expect("serialize audit verify command");
        assert_eq!(encoded["kind"], "auditVerify");
        let decoded: KernelCommand =
            serde_json::from_value(encoded).expect("deserialize audit verify command");
        assert_eq!(decoded, command);

        let command = KernelCommand::AuditQuery {
            request_id: RequestId("req-audit-query".to_string()),
            filter: serde_json::json!({ "runId": "run-1" }),
            projection: Some("redacted".to_string()),
        };
        let encoded = serde_json::to_value(&command).expect("serialize audit query command");
        assert_eq!(encoded["kind"], "auditQuery");
        assert_eq!(encoded["projection"], "redacted");
        let decoded: KernelCommand =
            serde_json::from_value(encoded).expect("deserialize audit query command");
        assert_eq!(decoded, command);

        let event = KernelEvent::AuditVerifyCompleted {
            request_id: Some(RequestId("req-audit-verify".to_string())),
            ok: true,
            report: serde_json::json!({ "entriesVerified": 2 }),
            sequence: Some(11),
        };
        let encoded = serde_json::to_value(&event).expect("serialize audit event");
        assert_eq!(encoded["kind"], "audit.verify_completed");
        assert_eq!(encoded["report"]["entriesVerified"], 2);
        let decoded: KernelEvent =
            serde_json::from_value(encoded).expect("deserialize audit event");
        assert_eq!(decoded, event);
    }

    #[test]
    fn workflow_observe_and_decision_event_round_trip() {
        let observed = KernelEvent::ToolCompleted {
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            turn_id: None,
            tool_call_id: "tool-1".to_string(),
            tool_name: "fs.list".to_string(),
            ok: true,
            output: Some(serde_json::json!({ "path": "." })),
            error: None,
            sequence: Some(5),
        };
        let command = KernelCommand::WorkflowObserve {
            request_id: RequestId("req-observe".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            event: Box::new(observed.clone()),
        };
        let encoded = serde_json::to_value(&command).expect("serialize observe command");
        assert_eq!(encoded["kind"], "workflowObserve");
        assert_eq!(encoded["event"]["kind"], "tool.completed");
        let decoded: KernelCommand =
            serde_json::from_value(encoded).expect("deserialize observe command");
        assert_eq!(decoded, command);

        let event = KernelEvent::WorkflowDecisionMade {
            request_id: Some(RequestId("req-observe".to_string())),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            decision: WorkflowDecision {
                action: WorkflowDecisionAction::Continue,
                reason: WorkflowDecisionReason::PendingCriticalSteps,
                phase: Some("complete".to_string()),
                pending_steps: vec!["create temp file".to_string()],
                answer_obligations: vec![AnswerObligation {
                    id: AnswerObligationId::Identity,
                    description: "answer identity once".to_string(),
                    status: AnswerObligationStatus::Pending,
                    satisfied_by_event: None,
                }],
                summary: Some("Continue until completion criteria are satisfied.".to_string()),
                fail_closed: false,
            },
            sequence: Some(6),
        };
        let encoded = serde_json::to_value(&event).expect("serialize decision event");
        assert_eq!(encoded["kind"], "workflow.decision_made");
        assert_eq!(encoded["decision"]["action"], "continue");
        assert_eq!(encoded["decision"]["reason"], "pendingCriticalSteps");
        let decoded: KernelEvent =
            serde_json::from_value(encoded).expect("deserialize decision event");
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
