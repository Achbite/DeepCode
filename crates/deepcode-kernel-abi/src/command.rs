use crate::{
    ArtifactDraftLedgerFrame, AuditQueryFilter, HostInspectionQuery, HostMcpRiskDecisionSubmit,
    HostSkillTrustDecisionSubmit, KernelActionBatch, PermissionDecisionKind,
    PlanAuthorizationDecisionSubmit, ProfileRef, ProposalEnvelope, RequestId,
    ResourceResolveRequest, ReviewGateDecision, RunId, SessionId, TaskIntentEnvelope, UserInput,
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
    ResourceResolve {
        request_id: RequestId,
        run_id: RunId,
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
        batch: KernelActionBatch,
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
        decision: ReviewGateDecision,
    },
    RunCancel {
        request_id: RequestId,
        run_id: RunId,
    },
    RunResume {
        request_id: RequestId,
        session_id: SessionId,
    },
    HostWorkspaceBindingResolve {
        request_id: RequestId,
        path: String,
    },
    HostWorkspaceOpen {
        request_id: RequestId,
        path: String,
    },
    HostWorkspaceCurrent {
        request_id: RequestId,
    },
    HostWorkspaceSave {
        request_id: RequestId,
        file_name: Option<String>,
    },
    HostResourceQuery {
        request_id: RequestId,
        query: HostInspectionQuery,
    },
    HostSkillDiscover {
        request_id: RequestId,
    },
    PermissionResolve {
        request_id: RequestId,
        permission_id: String,
        decision: PermissionDecisionKind,
    },
    HostSkillTrustDecisionSubmit {
        request_id: RequestId,
        skill_id: String,
        decision: HostSkillTrustDecisionSubmit,
    },
    HostMcpRiskDecisionSubmit {
        request_id: RequestId,
        connector_id: String,
        binding_id: Option<String>,
        decision: HostMcpRiskDecisionSubmit,
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

impl KernelCommand {
    pub fn session_id(&self) -> Option<&SessionId> {
        match self {
            Self::SnapshotGet { session_id, .. }
            | Self::RunCreate { session_id, .. }
            | Self::StateContractGet { session_id, .. }
            | Self::ProposalSubmit { session_id, .. }
            | Self::PlanAuthorizationSubmit { session_id, .. }
            | Self::PlanAuthorizationDecisionSubmit { session_id, .. }
            | Self::ResourceResolve { session_id, .. }
            | Self::DraftLedgerSubmit { session_id, .. }
            | Self::ActionBatchSubmit { session_id, .. }
            | Self::ReviewFactsGet { session_id, .. }
            | Self::ReviewGateEvaluate { session_id, .. } => session_id.as_ref(),
            Self::RunResume { session_id, .. } => Some(session_id),
            Self::HealthCheck { .. }
            | Self::RunCancel { .. }
            | Self::HostWorkspaceBindingResolve { .. }
            | Self::HostWorkspaceOpen { .. }
            | Self::HostWorkspaceCurrent { .. }
            | Self::HostWorkspaceSave { .. }
            | Self::HostResourceQuery { .. }
            | Self::HostSkillDiscover { .. }
            | Self::PermissionResolve { .. }
            | Self::HostSkillTrustDecisionSubmit { .. }
            | Self::HostMcpRiskDecisionSubmit { .. }
            | Self::AuditVerify { .. }
            | Self::AuditQuery { .. } => None,
        }
    }

    pub fn run_id(&self) -> Option<&RunId> {
        match self {
            Self::StateContractGet { run_id, .. } => run_id.as_ref(),
            Self::ProposalSubmit { run_id, .. }
            | Self::PlanAuthorizationSubmit { run_id, .. }
            | Self::PlanAuthorizationDecisionSubmit { run_id, .. }
            | Self::DraftLedgerSubmit { run_id, .. }
            | Self::ActionBatchSubmit { run_id, .. }
            | Self::ReviewFactsGet { run_id, .. }
            | Self::ReviewGateEvaluate { run_id, .. }
            | Self::RunCancel { run_id, .. }
            | Self::ResourceResolve { run_id, .. } => Some(run_id),
            Self::HealthCheck { .. }
            | Self::SnapshotGet { .. }
            | Self::RunCreate { .. }
            | Self::RunResume { .. }
            | Self::HostWorkspaceBindingResolve { .. }
            | Self::HostWorkspaceOpen { .. }
            | Self::HostWorkspaceCurrent { .. }
            | Self::HostWorkspaceSave { .. }
            | Self::HostResourceQuery { .. }
            | Self::HostSkillDiscover { .. }
            | Self::PermissionResolve { .. }
            | Self::HostSkillTrustDecisionSubmit { .. }
            | Self::HostMcpRiskDecisionSubmit { .. }
            | Self::AuditVerify { .. }
            | Self::AuditQuery { .. } => None,
        }
    }
}
