use deepcode_kernel_abi::tool_catalog_v4::{
    AuthorityToolIdV4, EffectScopeV4, ToolContractDigestV4, ToolInvocationInputV4,
    ToolOutputDigestV4, ToolOutputV4, ToolRiskV4,
};
use deepcode_kernel_abi::v2::{
    AttemptId, AuthorizationRequestDigestV2, CancelRequestId, CanonicalPrivateTargetV2,
    CommandRequestDigestV2, CommandRequestId, ControlEpoch, CorrelationSetV2, EffectEvidenceV2,
    EffectId, FactId, GrantDecisionBasisV2, GrantDecisionDigestV2, GrantId, GrantReservationId,
    GrantScopeDigestV2, GrantSupersessionCauseV2, IdempotencyKeyHashV2, IndeterminateReasonV2,
    InputId, InvocationId, InvocationRequestDigestV2, InvocationSubmissionDigestV2,
    KernelFactEnvelopeV2, OperationId, PlatformV2, PostObservedEffectFailureCodeV2,
    ResolvedResourceV2, ResourceId, ResourceScopeV2, ResourceStateDigestV2, ResourceStateV2, RunId,
    TargetRevalidationDigestV2, TargetRevalidationObservationV2, WorkspaceBindingDigestV2,
    WorkspaceObjectKindV2,
};
use deepcode_kernel_abi::v2_command::{
    GrantDecisionReplyV2, InvocationPhaseV2, InvocationSubmissionReplyV2, KernelErrorV2,
    KernelReplyV2, StopOverlayV2,
};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

pub(super) type AuthorityResult<T> = Result<T, KernelErrorV2>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum RunLifecycle {
    Active,
    Terminated {
        fact_id: FactId,
        ledger_sequence: u64,
    },
}

#[derive(Debug, Clone)]
pub(super) struct RunRecord {
    pub(super) epoch: ControlEpoch,
    pub(super) lifecycle: RunLifecycle,
    pub(super) active_invocation_id: Option<InvocationId>,
    pub(super) admitted_inputs: HashMap<InputId, ControlEpoch>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum GrantLifecycle {
    Issued,
    Revoked {
        fact_id: FactId,
        ledger_sequence: u64,
    },
    Superseded {
        fact_id: FactId,
        ledger_sequence: u64,
        cause: GrantSupersessionCauseV2,
    },
}

#[derive(Debug, Clone)]
pub(super) struct GrantRecord {
    pub(super) run_id: RunId,
    pub(super) grant_epoch: ControlEpoch,
    pub(super) issuance_operation_id: OperationId,
    pub(super) grant_id: GrantId,
    pub(super) tool_id: AuthorityToolIdV4,
    pub(super) issuance_authorization_digest: AuthorizationRequestDigestV2,
    pub(super) grant_scope_digest: GrantScopeDigestV2,
    pub(super) resource_scope: ResourceScopeV2,
    pub(super) effect_scope: EffectScopeV4,
    pub(super) risk: ToolRiskV4,
    pub(super) lifecycle: GrantLifecycle,
    pub(super) use_count: u64,
}

#[derive(Debug, Clone)]
pub(super) struct ReservationRecord {
    pub(super) consumed: bool,
    pub(super) released: bool,
}

pub(super) type InvocationPhase = InvocationPhaseV2;

pub(super) const fn invocation_phase_is_terminal(phase: InvocationPhase) -> bool {
    matches!(
        phase,
        InvocationPhase::FailedBeforeEffect
            | InvocationPhase::CancelledBeforeEffect
            | InvocationPhase::TimedOutBeforeEffect
            | InvocationPhase::Completed
            | InvocationPhase::FailedAfterObservedEffect
            | InvocationPhase::Indeterminate
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum StopOverlay {
    None,
    CancellationRequested {
        cancel_request_id: CancelRequestId,
        fact_id: FactId,
        ledger_sequence: u64,
    },
    DeadlineObserved {
        fact_id: FactId,
    },
    CancellationAndDeadline {
        cancel_request_id: CancelRequestId,
        cancellation_fact_id: FactId,
        cancellation_ledger_sequence: u64,
        deadline_fact_id: FactId,
    },
}

impl StopOverlay {
    pub(super) fn cancellation(&self) -> Option<(&CancelRequestId, &FactId, u64)> {
        match self {
            Self::CancellationRequested {
                cancel_request_id,
                fact_id,
                ledger_sequence,
            }
            | Self::CancellationAndDeadline {
                cancel_request_id,
                cancellation_fact_id: fact_id,
                cancellation_ledger_sequence: ledger_sequence,
                ..
            } => Some((cancel_request_id, fact_id, *ledger_sequence)),
            Self::None | Self::DeadlineObserved { .. } => None,
        }
    }

    pub(super) const fn deadline_observed(&self) -> bool {
        matches!(
            self,
            Self::DeadlineObserved { .. } | Self::CancellationAndDeadline { .. }
        )
    }

    pub(super) fn wire(&self) -> StopOverlayV2 {
        match self {
            Self::None => StopOverlayV2::None {},
            Self::CancellationRequested {
                cancel_request_id, ..
            } => StopOverlayV2::CancellationRequested {
                cancel_request_id: cancel_request_id.clone(),
            },
            Self::DeadlineObserved { .. } => StopOverlayV2::DeadlineObserved {},
            Self::CancellationAndDeadline {
                cancel_request_id, ..
            } => StopOverlayV2::CancellationAndDeadline {
                cancel_request_id: cancel_request_id.clone(),
            },
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct InvocationRecord {
    pub(super) run_id: RunId,
    pub(super) operation_id: OperationId,
    pub(super) control_epoch: ControlEpoch,
    pub(super) grant_id: GrantId,
    pub(super) reservation_id: GrantReservationId,
    pub(super) invocation_id: InvocationId,
    pub(super) attempt_id: AttemptId,
    pub(super) idempotency_key_hash: IdempotencyKeyHashV2,
    pub(super) tool_id: AuthorityToolIdV4,
    pub(super) workspace_binding_digest: WorkspaceBindingDigestV2,
    pub(super) correlations: CorrelationSetV2,
    pub(super) phase: InvocationPhase,
    pub(super) stop_overlay: StopOverlay,
    pub(super) admission_fact_id: FactId,
    pub(super) attempt_prepared_fact_id: Option<FactId>,
    pub(super) execution_started_fact_id: Option<FactId>,
    pub(super) cancellation_observed_fact_id: Option<FactId>,
    pub(super) deadline_observed_fact_id: Option<FactId>,
    pub(super) last_fact_id: FactId,
}

#[derive(Debug, Clone)]
pub(super) struct CommandReplay {
    pub(super) digest: CommandRequestDigestV2,
    pub(super) reply: KernelReplyV2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct GrantDecisionReplay {
    pub(super) digest: GrantDecisionDigestV2,
    pub(super) reply: GrantDecisionReplyV2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SubmissionBinding {
    pub(super) digest: InvocationSubmissionDigestV2,
    pub(super) reply: InvocationSubmissionReplyV2,
    pub(super) retryable_rejection: bool,
}

#[derive(Debug, Clone)]
pub(super) struct ResourceRecord {
    pub(super) run_id: RunId,
    pub(super) invocation_id: InvocationId,
    pub(super) resource_id: ResourceId,
    pub(super) resolved: ResolvedResourceV2,
    pub(super) resolution_fact_id: FactId,
    pub(super) revalidation: Option<(
        FactId,
        TargetRevalidationDigestV2,
        TargetRevalidationObservationV2,
    )>,
    pub(super) last_fact_id: FactId,
}

#[derive(Debug, Clone, Default)]
pub(super) struct AuthorityState {
    pub(super) runs: HashMap<RunId, RunRecord>,
    pub(super) grants: HashMap<GrantId, GrantRecord>,
    pub(super) reservations: HashMap<GrantReservationId, ReservationRecord>,
    pub(super) invocations: HashMap<InvocationId, InvocationRecord>,
    pub(super) resources: HashMap<ResourceId, ResourceRecord>,
    pub(super) invocation_effects: HashMap<InvocationId, (EffectId, FactId)>,
    pub(super) commands: HashMap<CommandRequestId, CommandReplay>,
    pub(super) grant_decisions: HashMap<String, GrantDecisionReplay>,
    pub(super) operation_bindings: HashMap<(RunId, OperationId), SubmissionBinding>,
    pub(super) idempotency_bindings: HashMap<(RunId, IdempotencyKeyHashV2), SubmissionBinding>,
    pub(super) storage_faulted: bool,
    pub(super) facts_by_id: HashMap<FactId, KernelFactEnvelopeV2>,
}

#[derive(Debug, Clone)]
pub(super) struct WorkspaceBinding {
    pub(super) platform: PlatformV2,
    pub(super) canonical_root: PathBuf,
    pub(super) canonical_root_utf8: String,
    pub(super) digest: WorkspaceBindingDigestV2,
}

#[derive(Debug, Clone)]
pub(super) struct ResolvedTarget {
    pub(super) relative_path: Option<String>,
    pub(super) object_kind: Option<WorkspaceObjectKindV2>,
    pub(super) state: Option<ResourceStateV2>,
    pub(super) state_digest: Option<ResourceStateDigestV2>,
    pub(super) public_resource: ResolvedResourceV2,
    pub(super) private_target: CanonicalPrivateTargetV2,
}

#[derive(Debug, Clone)]
pub(super) struct PreparedGrantRequest {
    pub(super) canonical_invocation: ToolInvocationInputV4,
    pub(super) resource_scope: ResourceScopeV2,
    pub(super) resolved_targets: Vec<ResolvedTarget>,
    pub(super) idempotency_key_hash: IdempotencyKeyHashV2,
    pub(super) grant_scope_digest: GrantScopeDigestV2,
    pub(super) authorization_digest: AuthorizationRequestDigestV2,
    pub(super) workspace_binding_digest: WorkspaceBindingDigestV2,
    pub(super) effective_deadline_ms: u32,
    pub(super) correlations: CorrelationSetV2,
}

pub(super) struct RawExecution {
    pub(super) output: serde_json::Value,
    pub(super) complete_document_text: Option<String>,
    pub(super) http_status_code: Option<u16>,
    pub(super) http_content_type: Option<String>,
}

pub(super) struct VerifiedExecution {
    pub(super) output: ToolOutputV4,
    pub(super) evidence: EffectEvidenceV2,
}

pub(super) enum ExecutionResolution {
    Completed(VerifiedExecution),
    FailedAfterObservedEffect {
        evidence: EffectEvidenceV2,
        error_code: PostObservedEffectFailureCodeV2,
    },
    Indeterminate {
        evidence: EffectEvidenceV2,
        reason_code: IndeterminateReasonV2,
    },
}
