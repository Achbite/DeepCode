use crate::{
    ArtifactDraftEvent, AuditQueryResult, ConfigSnapshotRef, DriverRequest, HostInspectionResult,
    HostMcpRiskDecisionRecord, HostSkillCatalogResult, HostSkillTrustDecisionRecord, HostStatus,
    HostWorkspaceResult, KernelActionBatchSummary, KernelErrorEnvelope, KernelProposalReviewReport,
    KernelResourceCleanupStateFact, KernelSnapshot, KernelStateContract, LlmProviderDiagnostic,
    MessageRole, PermissionDecisionKind, PermissionRequestEnvelope, PlanAuthorizationDecisionKind,
    PlanAuthorizationReview, ProposalEnvelope, RequestId, ResourcePacket, ReviewFacts,
    ReviewGateEvaluation, RunId, RunStatus, RuntimeLifecycleState, SessionId, ToolCompletionFact,
    ToolEffectReceipt, ToolExecutionAttemptFact, ToolOutcomeIndeterminateFact, ToolRequestFact,
    TurnId, WorkUnitDescriptor,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    #[serde(rename = "host.inspection_completed")]
    HostInspectionCompleted {
        request_id: RequestId,
        result: HostInspectionResult,
    },
    #[serde(rename = "host.workspace_completed")]
    HostWorkspaceCompleted {
        request_id: RequestId,
        result: HostWorkspaceResult,
    },
    #[serde(rename = "state.entered")]
    StateEntered {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        state_contract: KernelStateContract,
        sequence: Option<u64>,
    },
    #[serde(rename = "driver.request_produced")]
    DriverRequestProduced {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        driver_request: DriverRequest,
        sequence: Option<u64>,
    },
    #[serde(rename = "proposal.accepted")]
    ProposalAccepted {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        proposal: ProposalEnvelope,
        sequence: Option<u64>,
    },
    #[serde(rename = "proposal.reviewed")]
    ProposalReviewed {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        proposal_id: String,
        report: KernelProposalReviewReport,
        sequence: Option<u64>,
    },
    #[serde(rename = "plan_authorization.reviewed")]
    PlanAuthorizationReviewed {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        plan_id: String,
        review: PlanAuthorizationReview,
        sequence: Option<u64>,
    },
    #[serde(rename = "plan_authorization.decision_recorded")]
    PlanAuthorizationDecisionRecorded {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        authorization_contract_id: String,
        decision: PlanAuthorizationDecisionKind,
        lease_id: Option<String>,
        sequence: Option<u64>,
    },
    #[serde(rename = "proposal.rejected")]
    ProposalRejected {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        proposal_id: Option<String>,
        reason: String,
        diagnostics: Option<Value>,
        sequence: Option<u64>,
    },
    #[serde(rename = "resource.packet_produced")]
    ResourcePacketProduced {
        request_id: Option<RequestId>,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        packet: ResourcePacket,
        sequence: Option<u64>,
    },
    #[serde(rename = "draft.open")]
    DraftOpen {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        draft: ArtifactDraftEvent,
        sequence: Option<u64>,
    },
    #[serde(rename = "draft.chunk")]
    DraftChunk {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        draft: ArtifactDraftEvent,
        sequence: Option<u64>,
    },
    #[serde(rename = "draft.file_completed")]
    DraftFileCompleted {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        draft: ArtifactDraftEvent,
        sequence: Option<u64>,
    },
    #[serde(rename = "draft.batch_completed")]
    DraftBatchCompleted {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        draft: ArtifactDraftEvent,
        sequence: Option<u64>,
    },
    #[serde(rename = "draft.discarded")]
    DraftDiscarded {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        draft: ArtifactDraftEvent,
        sequence: Option<u64>,
    },
    #[serde(rename = "draft.committed")]
    DraftCommitted {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        draft: ArtifactDraftEvent,
        sequence: Option<u64>,
    },
    #[serde(rename = "action_batch.accepted")]
    ActionBatchAccepted {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        batch: KernelActionBatchSummary,
        sequence: Option<u64>,
    },
    #[serde(rename = "work_unit.queued")]
    WorkUnitQueued {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        work_unit: WorkUnitDescriptor,
        sequence: Option<u64>,
    },
    #[serde(rename = "work_unit.started")]
    WorkUnitStarted {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        work_unit_id: String,
        sequence: Option<u64>,
    },
    #[serde(rename = "work_unit.completed")]
    WorkUnitCompleted {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        work_unit_id: String,
        output: Option<Value>,
        sequence: Option<u64>,
    },
    #[serde(rename = "work_unit.failed")]
    WorkUnitFailed {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        work_unit_id: String,
        error: KernelErrorEnvelope,
        sequence: Option<u64>,
    },
    #[serde(rename = "work_unit.blocked")]
    WorkUnitBlocked {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        work_unit_id: String,
        reason: String,
        sequence: Option<u64>,
    },
    #[serde(rename = "batch.review_ready")]
    BatchReviewReady {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        contract_id: String,
        sequence: Option<u64>,
    },
    #[serde(rename = "review.facts_produced")]
    ReviewFactsProduced {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        facts: ReviewFacts,
        sequence: Option<u64>,
    },
    #[serde(rename = "review_gate.evaluated")]
    ReviewGateEvaluated {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        result: ReviewGateEvaluation,
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
    #[serde(rename = "runtime.lifecycle_changed")]
    RuntimeLifecycleChanged {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        previous_state: Option<RuntimeLifecycleState>,
        current_state: RuntimeLifecycleState,
        reason: Option<String>,
        sequence: Option<u64>,
    },
    #[serde(rename = "resource.cleanup_state_changed")]
    ResourceCleanupStateChanged {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        fact: KernelResourceCleanupStateFact,
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
    #[serde(rename = "llm.provider_error")]
    LlmProviderError {
        run_id: RunId,
        session_id: Option<SessionId>,
        phase: String,
        llm_call_id: String,
        diagnostic: LlmProviderDiagnostic,
        sequence: Option<u64>,
    },
    #[serde(rename = "tool.requested")]
    ToolRequested {
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        turn_id: Option<TurnId>,
        fact: ToolRequestFact,
        sequence: Option<u64>,
    },
    #[serde(rename = "tool.execution_attempted")]
    ToolExecutionAttempted {
        run_id: RunId,
        session_id: Option<SessionId>,
        fact: ToolExecutionAttemptFact,
        sequence: Option<u64>,
    },
    #[serde(rename = "tool.effect_observed")]
    ToolEffectObserved {
        run_id: RunId,
        session_id: Option<SessionId>,
        fact: ToolEffectReceipt,
        sequence: Option<u64>,
    },
    #[serde(rename = "tool.outcome_indeterminate")]
    ToolOutcomeIndeterminate {
        run_id: RunId,
        session_id: Option<SessionId>,
        fact: ToolOutcomeIndeterminateFact,
        sequence: Option<u64>,
    },
    #[serde(rename = "tool.completed")]
    ToolCompleted {
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        turn_id: Option<TurnId>,
        fact: ToolCompletionFact,
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
    #[serde(rename = "runtime.resumed")]
    RuntimeResumed {
        run_id: RunId,
        session_id: Option<SessionId>,
        checkpoint_id: String,
        lifecycle_state: RuntimeLifecycleState,
        sequence: Option<u64>,
    },
    #[serde(rename = "host.skills_discovered")]
    HostSkillsDiscovered {
        request_id: RequestId,
        result: HostSkillCatalogResult,
    },
    #[serde(rename = "host.skill_trust_decision_recorded")]
    HostSkillTrustDecisionRecorded {
        request_id: RequestId,
        record: HostSkillTrustDecisionRecord,
        sequence: Option<u64>,
    },
    #[serde(rename = "host.mcp_risk_decision_recorded")]
    HostMcpRiskDecisionRecorded {
        request_id: RequestId,
        record: HostMcpRiskDecisionRecord,
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
    #[serde(rename = "audit.query_completed")]
    AuditQueryCompleted {
        request_id: Option<RequestId>,
        result: AuditQueryResult,
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

impl KernelEvent {
    pub fn session_id(&self) -> Option<&SessionId> {
        match self {
            Self::StateEntered { session_id, .. }
            | Self::DriverRequestProduced { session_id, .. }
            | Self::ProposalAccepted { session_id, .. }
            | Self::ProposalReviewed { session_id, .. }
            | Self::PlanAuthorizationReviewed { session_id, .. }
            | Self::PlanAuthorizationDecisionRecorded { session_id, .. }
            | Self::ProposalRejected { session_id, .. }
            | Self::ResourcePacketProduced { session_id, .. }
            | Self::DraftOpen { session_id, .. }
            | Self::DraftChunk { session_id, .. }
            | Self::DraftFileCompleted { session_id, .. }
            | Self::DraftBatchCompleted { session_id, .. }
            | Self::DraftDiscarded { session_id, .. }
            | Self::DraftCommitted { session_id, .. }
            | Self::ActionBatchAccepted { session_id, .. }
            | Self::WorkUnitQueued { session_id, .. }
            | Self::WorkUnitStarted { session_id, .. }
            | Self::WorkUnitCompleted { session_id, .. }
            | Self::WorkUnitFailed { session_id, .. }
            | Self::WorkUnitBlocked { session_id, .. }
            | Self::BatchReviewReady { session_id, .. }
            | Self::ReviewFactsProduced { session_id, .. }
            | Self::ReviewGateEvaluated { session_id, .. }
            | Self::RunCompleted { session_id, .. }
            | Self::RuntimeLifecycleChanged { session_id, .. }
            | Self::ResourceCleanupStateChanged { session_id, .. }
            | Self::MessageAppended { session_id, .. }
            | Self::LlmProviderError { session_id, .. }
            | Self::ToolRequested { session_id, .. }
            | Self::ToolExecutionAttempted { session_id, .. }
            | Self::ToolEffectObserved { session_id, .. }
            | Self::ToolOutcomeIndeterminate { session_id, .. }
            | Self::ToolCompleted { session_id, .. }
            | Self::PermissionResolved { session_id, .. }
            | Self::AutonomyTransitioned { session_id, .. }
            | Self::ConfigSnapshotAttached { session_id, .. }
            | Self::RuntimeResumed { session_id, .. }
            | Self::Error { session_id, .. } => session_id.as_ref(),
            Self::PermissionRequested { session_id, .. } => Some(session_id),
            Self::HostStatus { .. }
            | Self::SnapshotReady { .. }
            | Self::HostInspectionCompleted { .. }
            | Self::HostWorkspaceCompleted { .. }
            | Self::HostSkillsDiscovered { .. }
            | Self::HostSkillTrustDecisionRecorded { .. }
            | Self::HostMcpRiskDecisionRecorded { .. }
            | Self::AuditVerifyStarted { .. }
            | Self::AuditVerifyCompleted { .. }
            | Self::AuditQueryCompleted { .. }
            | Self::AuditDegradedEntered { .. }
            | Self::AuditDegradedExited { .. }
            | Self::AuditSegmentRotated { .. } => None,
        }
    }

    pub fn run_id(&self) -> Option<&RunId> {
        match self {
            Self::ResourcePacketProduced { run_id, .. }
            | Self::MessageAppended { run_id, .. }
            | Self::ToolRequested { run_id, .. }
            | Self::ToolCompleted { run_id, .. }
            | Self::PermissionRequested { run_id, .. }
            | Self::PermissionResolved { run_id, .. }
            | Self::AutonomyTransitioned { run_id, .. }
            | Self::ConfigSnapshotAttached { run_id, .. }
            | Self::Error { run_id, .. } => run_id.as_ref(),
            Self::StateEntered { run_id, .. }
            | Self::DriverRequestProduced { run_id, .. }
            | Self::ProposalAccepted { run_id, .. }
            | Self::ProposalReviewed { run_id, .. }
            | Self::PlanAuthorizationReviewed { run_id, .. }
            | Self::PlanAuthorizationDecisionRecorded { run_id, .. }
            | Self::ProposalRejected { run_id, .. }
            | Self::DraftOpen { run_id, .. }
            | Self::DraftChunk { run_id, .. }
            | Self::DraftFileCompleted { run_id, .. }
            | Self::DraftBatchCompleted { run_id, .. }
            | Self::DraftDiscarded { run_id, .. }
            | Self::DraftCommitted { run_id, .. }
            | Self::ActionBatchAccepted { run_id, .. }
            | Self::WorkUnitQueued { run_id, .. }
            | Self::WorkUnitStarted { run_id, .. }
            | Self::WorkUnitCompleted { run_id, .. }
            | Self::WorkUnitFailed { run_id, .. }
            | Self::WorkUnitBlocked { run_id, .. }
            | Self::BatchReviewReady { run_id, .. }
            | Self::ReviewFactsProduced { run_id, .. }
            | Self::ReviewGateEvaluated { run_id, .. }
            | Self::RunCompleted { run_id, .. }
            | Self::RuntimeLifecycleChanged { run_id, .. }
            | Self::ResourceCleanupStateChanged { run_id, .. }
            | Self::LlmProviderError { run_id, .. }
            | Self::RuntimeResumed { run_id, .. } => Some(run_id),
            Self::ToolExecutionAttempted { run_id, .. }
            | Self::ToolEffectObserved { run_id, .. }
            | Self::ToolOutcomeIndeterminate { run_id, .. } => Some(run_id),
            Self::HostStatus { .. }
            | Self::SnapshotReady { .. }
            | Self::HostInspectionCompleted { .. }
            | Self::HostWorkspaceCompleted { .. }
            | Self::HostSkillsDiscovered { .. }
            | Self::HostSkillTrustDecisionRecorded { .. }
            | Self::HostMcpRiskDecisionRecorded { .. }
            | Self::AuditVerifyStarted { .. }
            | Self::AuditVerifyCompleted { .. }
            | Self::AuditQueryCompleted { .. }
            | Self::AuditDegradedEntered { .. }
            | Self::AuditDegradedExited { .. }
            | Self::AuditSegmentRotated { .. } => None,
        }
    }
}
