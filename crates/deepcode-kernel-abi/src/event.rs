use crate::{
    ConfigSnapshotRef, DriverRequest, HostStatus, KernelErrorEnvelope, KernelSnapshot,
    KernelStateContract, LlmProviderDiagnostic, MessageRole, PermissionDecisionKind,
    PermissionRequestEnvelope, ProposalEnvelope, RequestId, RunId, RunStatus, SessionId,
    StageRunId, StageStatus, TurnId, WorkflowDecision,
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
        report: Value,
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
        packet: Value,
        sequence: Option<u64>,
    },
    #[serde(rename = "artifact.registered")]
    ArtifactRegistered {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        artifact: Value,
        evidence_ref: String,
        sequence: Option<u64>,
    },
    #[serde(rename = "action_batch.accepted")]
    ActionBatchAccepted {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        batch: Value,
        sequence: Option<u64>,
    },
    #[serde(rename = "work_unit.queued")]
    WorkUnitQueued {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        work_unit: Value,
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
    #[serde(rename = "review.facts_produced")]
    ReviewFactsProduced {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        facts: Value,
        sequence: Option<u64>,
    },
    #[serde(rename = "review_gate.evaluated")]
    ReviewGateEvaluated {
        request_id: Option<RequestId>,
        run_id: RunId,
        session_id: Option<SessionId>,
        result: Value,
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
