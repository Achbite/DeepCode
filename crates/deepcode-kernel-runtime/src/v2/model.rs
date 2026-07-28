use deepcode_kernel_abi::v2::{
    AttemptId, CancelRequestId, CanonicalPrivateTargetV2, ControlEpoch, CorrelationSetV2,
    EffectEvidenceV2, EffectId, FactId, IdempotencyKeyHashV2, IndeterminateReasonV2, InputId,
    InvocationAuthorityV2, InvocationId, KernelFactEnvelopeV2, OperationId, PlatformV2,
    PostObservedEffectFailureCodeV2, ResolvedResourceV2, ResourceId, ResourceScopeV2,
    ResourceStateDigestV2, ResourceStateV2, RunId, TargetRevalidationDigestV2,
    TargetRevalidationObservationV2, WorkspaceBindingDigestV2, WorkspaceObjectKindV2,
};
use deepcode_kernel_abi::v2_command::{InvocationPhaseV2, KernelErrorV2};
use deepcode_kernel_tools::{AuthorityToolIdV4, ToolInvocationInputV4};
use std::collections::HashMap;
use std::path::PathBuf;

pub(super) type AuthorityResult<T> = Result<T, KernelErrorV2>;

#[derive(Debug, Clone)]
pub(super) struct RunRecord {
    pub(super) epoch: ControlEpoch,
    pub(super) active_invocation_id: Option<InvocationId>,
    pub(super) admitted_inputs: HashMap<InputId, ControlEpoch>,
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
}

#[derive(Debug, Clone)]
pub(super) struct DirectInvocationRecord {
    pub(super) run_id: RunId,
    pub(super) operation_id: OperationId,
    pub(super) control_epoch: ControlEpoch,
    pub(super) authority: InvocationAuthorityV2,
    pub(super) invocation_id: InvocationId,
    pub(super) attempt_id: AttemptId,
    pub(super) idempotency_key_hash: IdempotencyKeyHashV2,
    pub(super) legacy_tool_id: AuthorityToolIdV4,
    pub(super) resource_scope: ResourceScopeV2,
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
    pub(super) direct_invocations: HashMap<InvocationId, DirectInvocationRecord>,
    pub(super) resources: HashMap<ResourceId, ResourceRecord>,
    pub(super) invocation_effects: HashMap<InvocationId, (EffectId, FactId)>,
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
pub(super) struct PreparedDirectToolIntent {
    pub(super) canonical_invocation: ToolInvocationInputV4,
    pub(super) resource_scope: ResourceScopeV2,
    pub(super) resolved_targets: Vec<ResolvedTarget>,
    pub(super) idempotency_key_hash: IdempotencyKeyHashV2,
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
    pub(super) output: serde_json::Value,
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
