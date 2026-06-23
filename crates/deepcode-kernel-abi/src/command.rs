use crate::{
    KernelEvent, PermissionDecisionKind, ProfileRef, ProposalEnvelope, RequestId,
    ResourceResolveRequest, RunId, SessionId, TemporaryGrantEnvelope, UserDecisionSubmit,
    UserInput, WorkflowRef, WorkspaceBinding,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    RunCreate {
        request_id: RequestId,
        session_id: Option<SessionId>,
        input: UserInput,
        workspace_binding: Option<WorkspaceBinding>,
        profile_ref: Option<ProfileRef>,
        workflow_ref: Option<WorkflowRef>,
        run_overrides: Option<Value>,
    },
    StateContractGet {
        request_id: RequestId,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
    },
    ProposalSubmit {
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        proposal: ProposalEnvelope,
    },
    UserDecisionSubmit {
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        decision: UserDecisionSubmit,
    },
    ResourceResolve {
        request_id: RequestId,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        request: ResourceResolveRequest,
    },
    ArtifactRegister {
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        artifact: Value,
    },
    DraftLedgerSubmit {
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        frame: Value,
    },
    ActionBatchSubmit {
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        batch: Value,
    },
    ReviewFactsGet {
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
    },
    ReviewGateEvaluate {
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        decision: Value,
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
    HostResourceQuery {
        request_id: RequestId,
        query: Value,
    },
    SkillDiscover {
        request_id: RequestId,
    },
    SkillInvoke {
        request_id: RequestId,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        skill_id: String,
        input: Value,
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
