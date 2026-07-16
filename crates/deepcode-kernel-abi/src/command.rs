use crate::{
    ArtifactDraftLedgerFrame, AuditQueryFilter, HostInspectionQuery, PermissionDecisionKind,
    PlanAuthorizationDecisionSubmit, ProfileRef, ProposalEnvelope, RequestId,
    ResourceResolveRequest, RunId, SessionId, TaskIntentEnvelope, UserDecisionSubmit, UserInput,
    WorkspaceBinding,
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
    RunCreate {
        request_id: RequestId,
        session_id: Option<SessionId>,
        input: UserInput,
        workspace_binding: Option<WorkspaceBinding>,
        profile_ref: Option<ProfileRef>,
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
    PlanAuthorizationSubmit {
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        intent: TaskIntentEnvelope,
    },
    PlanAuthorizationDecisionSubmit {
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        decision: PlanAuthorizationDecisionSubmit,
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
    DraftLedgerSubmit {
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        frame: ArtifactDraftLedgerFrame,
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
    WorkspaceBindingResolve {
        request_id: RequestId,
        path: String,
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
        query: HostInspectionQuery,
    },
    SkillDiscover {
        request_id: RequestId,
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
        filter: AuditQueryFilter,
    },
}
