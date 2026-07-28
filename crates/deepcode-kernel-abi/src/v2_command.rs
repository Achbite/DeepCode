use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::tool_catalog_v4::{
    AuthorityToolIdV4, ExecutionAvailabilityV4, ToolCatalogDigestV4, ToolCatalogV4,
    ToolContractDigestV4, ToolInvocationInputV4, ToolRiskV4,
};
use crate::v2::{
    decode_strict_json, empty_field, field_too_large, invalid_value, too_many_values,
    validate_identity, validate_wire_abi_header, zero_value, AdmissionRejectionV2, AttemptId,
    AuthorizationRequestDigestV2, CancelRequestId, CommandRequestDigestV2, CommandRequestId,
    ControlEpoch, CorrelationRefV2, CorrelationSetV2, FactId, GrantDecisionDigestV2,
    GrantDenialReasonV2, GrantId, GrantReservationId, GrantScopeDigestV2, GrantSupersessionCauseV2,
    IdempotencyKeyHashV2, InputId, InvocationId, InvocationSubmissionDigestV2,
    KernelFactEnvelopeV2, NetworkOriginV2, OperationId, OperationIdempotencyConflictV2,
    QueryDigestV2, ResolvedResourceV2, ResourceId, ResourceProjectionObservationV2,
    ResourceScopeV2, RunId, UserDecisionRefV2, V2ValidationError, V2WireDecodeError,
    WorkspaceBindingDigestV2, FACT_STORE_SCHEMA_CONTRACT_V2, MAX_CORRELATION_REFS_V2,
    MAX_FACT_PAGE_BYTES_V2, MAX_PAGE_ITEMS_V2, MAX_TEXT_BYTES_V2,
};
use crate::{KERNEL_ABI_V2_VERSION, KERNEL_TOOL_CATALOG_V4_VERSION};

pub const MAX_COMMAND_BYTES_V2: usize = 2 * 1024 * 1024;
pub const MAX_SNAPSHOT_PAGE_BYTES_V2: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelCommandEnvelopeV2 {
    pub abi_version: String,
    pub request_id: CommandRequestId,
    pub command: KernelCommandV2,
}

impl KernelCommandEnvelopeV2 {
    pub fn new(request_id: CommandRequestId, command: KernelCommandV2) -> Self {
        Self {
            abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
            request_id,
            command,
        }
    }

    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_abi_version(&self.abi_version)?;
        self.command.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelCommandV2 {
    CompatibilityGet {},
    ToolCatalogGet {},
    ControlEpochAdvance(ControlEpochAdvanceV2),
    GrantPreview(GrantRequestV2),
    GrantDecisionSubmit(GrantDecisionSubmitV2),
    GrantRevoke(GrantRevokeV2),
    InvocationSubmit(InvocationSubmitV2),
    InvocationCancel(InvocationCancelV2),
    InvocationStatusGet(InvocationStatusGetV2),
    KernelFactsQuery(KernelFactsQueryV2),
    ResourceResolve(ResourceResolveV2),
    RunTerminate(RunTerminateV2),
}

impl KernelCommandV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        match self {
            Self::CompatibilityGet {} | Self::ToolCatalogGet {} => Ok(()),
            Self::ControlEpochAdvance(value) => value.validate(),
            Self::GrantPreview(value) => value.validate(),
            Self::GrantDecisionSubmit(value) => value.validate(),
            Self::GrantRevoke(value) => value.validate(),
            Self::InvocationSubmit(value) => value.validate(),
            Self::InvocationCancel(value) => value.validate(),
            Self::InvocationStatusGet(_) | Self::ResourceResolve(_) => Ok(()),
            Self::KernelFactsQuery(value) => value.validate(),
            Self::RunTerminate(value) => value.validate(),
        }
    }

    pub const fn kind(&self) -> &'static str {
        match self {
            Self::CompatibilityGet {} => "compatibilityGet",
            Self::ToolCatalogGet {} => "toolCatalogGet",
            Self::ControlEpochAdvance(_) => "controlEpochAdvance",
            Self::GrantPreview(_) => "grantPreview",
            Self::GrantDecisionSubmit(_) => "grantDecisionSubmit",
            Self::GrantRevoke(_) => "grantRevoke",
            Self::InvocationSubmit(_) => "invocationSubmit",
            Self::InvocationCancel(_) => "invocationCancel",
            Self::InvocationStatusGet(_) => "invocationStatusGet",
            Self::KernelFactsQuery(_) => "kernelFactsQuery",
            Self::ResourceResolve(_) => "resourceResolve",
            Self::RunTerminate(_) => "runTerminate",
        }
    }

    pub const fn mutation_kind(&self) -> Option<MutationCommandKindV2> {
        match self {
            Self::ControlEpochAdvance(_) => Some(MutationCommandKindV2::ControlEpochAdvance),
            Self::GrantDecisionSubmit(_) => Some(MutationCommandKindV2::GrantDecisionSubmit),
            Self::GrantRevoke(_) => Some(MutationCommandKindV2::GrantRevoke),
            Self::InvocationSubmit(_) => Some(MutationCommandKindV2::InvocationSubmit),
            Self::InvocationCancel(_) => Some(MutationCommandKindV2::InvocationCancel),
            Self::RunTerminate(_) => Some(MutationCommandKindV2::RunTerminate),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MutationCommandKindV2 {
    ControlEpochAdvance,
    GrantDecisionSubmit,
    GrantRevoke,
    InvocationSubmit,
    InvocationCancel,
    RunTerminate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlEpochAdvanceV2 {
    pub run_id: RunId,
    pub precondition: EpochPreconditionV2,
    pub input_id: InputId,
    pub opaque_input_ref: String,
}

impl ControlEpochAdvanceV2 {
    fn validate(&self) -> Result<(), V2ValidationError> {
        validate_text("opaqueInputRef", &self.opaque_input_ref)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EpochPreconditionV2 {
    NoCurrentEpoch {},
    Exact { control_epoch: ControlEpoch },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantRequestV2 {
    pub run_id: RunId,
    pub operation_id: OperationId,
    pub control_epoch: ControlEpoch,
    pub idempotency_key: String,
    pub canonical_invocation: ToolInvocationInputV4,
    pub deadline: DeadlineRequestV2,
    pub correlation_refs: Vec<CorrelationRefV2>,
}

impl GrantRequestV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_text("idempotencyKey", &self.idempotency_key)?;
        self.canonical_invocation.validate()?;
        self.deadline.validate()?;
        validate_correlations(&self.correlation_refs)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DeadlineRequestV2 {
    ContractDefault {},
    ExactMilliseconds { value: u32 },
}

impl DeadlineRequestV2 {
    fn validate(&self) -> Result<(), V2ValidationError> {
        if matches!(self, Self::ExactMilliseconds { value: 0 }) {
            return Err(zero_value("deadline.value"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantDecisionSubmitV2 {
    pub request: GrantRequestV2,
    pub expected_authorization_digest: AuthorizationRequestDigestV2,
    pub decision: GrantDecisionSubmissionV2,
}

impl GrantDecisionSubmitV2 {
    fn validate(&self) -> Result<(), V2ValidationError> {
        self.request.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GrantDecisionSubmissionV2 {
    ApplyKernelPolicy {},
    UserAllow {
        input_id: InputId,
        decision_ref: UserDecisionRefV2,
    },
    UserDeny {
        input_id: InputId,
        decision_ref: UserDecisionRefV2,
        reason_code: GrantDenialReasonV2,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantRevokeV2 {
    pub run_id: RunId,
    pub expected_control_epoch: ControlEpoch,
    pub grant_id: GrantId,
    pub reason_code: crate::v2::GrantRevokeReasonCodeV2,
    pub reason: Option<String>,
}

impl GrantRevokeV2 {
    fn validate(&self) -> Result<(), V2ValidationError> {
        validate_optional_text("reason", self.reason.as_deref())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvocationSubmitV2 {
    pub grant_id: GrantId,
    pub request: GrantRequestV2,
}

impl InvocationSubmitV2 {
    fn validate(&self) -> Result<(), V2ValidationError> {
        self.request.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvocationCancelV2 {
    pub run_id: RunId,
    pub expected_control_epoch: ControlEpoch,
    pub target: InvocationCancelTargetV2,
    pub reason_code: crate::v2::CancellationReasonCodeV2,
    pub reason: Option<String>,
}

impl InvocationCancelV2 {
    fn validate(&self) -> Result<(), V2ValidationError> {
        validate_optional_text("reason", self.reason.as_deref())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InvocationCancelTargetV2 {
    CurrentForRun {},
    Exact { invocation_id: InvocationId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvocationStatusGetV2 {
    pub run_id: RunId,
    pub invocation_id: InvocationId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelFactsQueryV2 {
    pub filter: KernelFactFilterV2,
    pub page: FactPageRequestV2,
}

impl KernelFactsQueryV2 {
    fn validate(&self) -> Result<(), V2ValidationError> {
        self.filter.validate()?;
        self.page.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelFactFilterV2 {
    All {},
    MatchAll {
        predicates: Vec<KernelFactPredicateV2>,
    },
}

impl KernelFactFilterV2 {
    fn validate(&self) -> Result<(), V2ValidationError> {
        if let Self::MatchAll { predicates } = self {
            if predicates.is_empty() {
                return Err(empty_field("filter.predicates"));
            }
            if predicates.len() > MAX_CORRELATION_REFS_V2 {
                return Err(too_many_values(
                    "filter.predicates",
                    MAX_CORRELATION_REFS_V2,
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelFactPredicateV2 {
    Run {
        run_id: RunId,
    },
    Operation {
        run_id: RunId,
        operation_id: OperationId,
    },
    Invocation {
        run_id: RunId,
        invocation_id: InvocationId,
    },
    Attempt {
        run_id: RunId,
        attempt_id: AttemptId,
    },
    Grant {
        run_id: RunId,
        grant_id: GrantId,
    },
    Reservation {
        run_id: RunId,
        reservation_id: GrantReservationId,
    },
    Resource {
        run_id: RunId,
        resource_id: ResourceId,
    },
    Command {
        command_request_id: CommandRequestId,
    },
    Fact {
        fact_id: FactId,
    },
    Causation {
        causation_fact_id: FactId,
    },
    Idempotency {
        run_id: RunId,
        idempotency_key_hash: IdempotencyKeyHashV2,
    },
    Correlation(CorrelationRefV2),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactPageRequestV2 {
    pub after_ledger_sequence: u64,
    pub limit: u32,
}

impl FactPageRequestV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_page_limit(self.limit, "page.limit")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceResolveV2 {
    pub run_id: RunId,
    pub resource_id: ResourceId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunTerminateV2 {
    pub run_id: RunId,
    pub expected_control_epoch: ControlEpoch,
    pub reason_code: crate::v2::RunTerminationReasonCodeV2,
    pub reason: Option<String>,
}

impl RunTerminateV2 {
    fn validate(&self) -> Result<(), V2ValidationError> {
        validate_optional_text("reason", self.reason.as_deref())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelReplyV2 {
    Compatibility(CompatibilityReplyV2),
    ToolCatalog(ToolCatalogV4),
    ControlEpochAdvanced(ControlEpochAdvancedReplyV2),
    GrantPreviewed(GrantPreviewReplyV2),
    GrantDecisionRecorded(GrantDecisionReplyV2),
    GrantRevoked(GrantRevokedReplyV2),
    InvocationSubmission(InvocationSubmissionReplyV2),
    InvocationCancelResult(InvocationCancelReplyV2),
    InvocationStatus(InvocationStatusReplyV2),
    KernelFacts(KernelFactPageV2),
    ResourceResolved(ResourceResolveReplyV2),
    RunTerminated(RunTerminatedReplyV2),
    Error(KernelErrorV2),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelCommandResponseEnvelopeV2 {
    Correlated {
        server_abi_version: String,
        request_id: CommandRequestId,
        handling: CommandHandlingV2,
        reply: KernelReplyV2,
    },
    UncorrelatedWireFailure {
        server_abi_version: String,
        error: KernelWireErrorV2,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandHandlingV2 {
    Evaluated,
    Replayed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompatibilityReplyV2 {
    pub kernel_abi_version: String,
    pub fact_store_schema_contract: String,
    pub tool_catalog_version: String,
    pub local_tool_catalog_digest: ToolCatalogDigestV4,
    pub legacy_command_ingress_supported: bool,
}

impl CompatibilityReplyV2 {
    pub fn new(local_tool_catalog_digest: ToolCatalogDigestV4) -> Self {
        Self {
            kernel_abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
            fact_store_schema_contract: FACT_STORE_SCHEMA_CONTRACT_V2.to_owned(),
            tool_catalog_version: KERNEL_TOOL_CATALOG_V4_VERSION.to_owned(),
            local_tool_catalog_digest,
            legacy_command_ingress_supported: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlEpochAdvancedReplyV2 {
    pub run_id: RunId,
    pub accepted_control_epoch: ControlEpoch,
    pub epoch_fact_id: FactId,
    pub superseded_grant_count: u64,
    pub cancellation: ControlCancellationReplyV2,
    pub command_batch_high_water: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ControlCancellationReplyV2 {
    None {},
    Requested {
        cancel_request_id: CancelRequestId,
        invocation_id: InvocationId,
        cancellation_fact_id: FactId,
    },
    AlreadyRequested {
        cancel_request_id: CancelRequestId,
        invocation_id: InvocationId,
        cancellation_fact_id: FactId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GrantPreviewReplyV2 {
    AutoIssuable {
        request: CanonicalGrantRequestV2,
    },
    RequiresUserDecision {
        request: CanonicalGrantRequestV2,
    },
    Blocked {
        tool_id: AuthorityToolIdV4,
        availability: ExecutionAvailabilityV4,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalGrantRequestV2 {
    pub run_id: RunId,
    pub operation_id: OperationId,
    pub control_epoch: ControlEpoch,
    pub idempotency_key_hash: IdempotencyKeyHashV2,
    pub canonical_invocation: ToolInvocationInputV4,
    pub local_tool_contract_digest: ToolContractDigestV4,
    pub resource_scope: ResourceScopeV2,
    pub effect_scope: crate::tool_catalog_v4::EffectScopeV4,
    pub risk: ToolRiskV4,
    pub effective_deadline_ms: u32,
    pub workspace_binding_digest: WorkspaceBindingDigestV2,
    pub authorization_request_digest: AuthorizationRequestDigestV2,
    pub correlation_refs: Vec<CorrelationRefV2>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GrantDecisionReplyV2 {
    Issued {
        grant_id: GrantId,
        fact_id: FactId,
        ledger_sequence: u64,
    },
    Denied {
        fact_id: FactId,
        ledger_sequence: u64,
    },
    RequiresUserDecision {
        authorization_request_digest: AuthorizationRequestDigestV2,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantRevokedReplyV2 {
    pub grant_id: GrantId,
    pub outcome: GrantRevokeOutcomeV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GrantRevokeOutcomeV2 {
    Revoked {
        revocation_fact_id: FactId,
        ledger_sequence: u64,
    },
    AlreadyRevoked {
        revocation_fact_id: FactId,
        ledger_sequence: u64,
    },
    AlreadySuperseded {
        supersession_fact_id: FactId,
        ledger_sequence: u64,
        cause: GrantSupersessionCauseV2,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InvocationSubmissionReplyV2 {
    Admitted {
        run_id: RunId,
        operation_id: OperationId,
        accepted_control_epoch: ControlEpoch,
        grant_id: GrantId,
        reservation_id: GrantReservationId,
        invocation_id: InvocationId,
        attempt_id: AttemptId,
        effective_deadline_ms: u32,
        admission_fact_id: FactId,
        admission_batch_high_water: u64,
    },
    Rejected {
        run_id: RunId,
        operation_id: OperationId,
        current_control_epoch: ControlEpoch,
        rejection: AdmissionRejectionV2,
        rejection_fact_id: FactId,
        rejection_batch_high_water: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InvocationCancelReplyV2 {
    Requested {
        cancel_request_id: CancelRequestId,
        invocation_id: InvocationId,
        fact_id: FactId,
        ledger_sequence: u64,
    },
    AlreadyRequested {
        cancel_request_id: CancelRequestId,
        invocation_id: InvocationId,
        fact_id: FactId,
        ledger_sequence: u64,
    },
    NoActiveInvocation {
        run_id: RunId,
        control_epoch: ControlEpoch,
    },
    AlreadyTerminal {
        invocation_id: InvocationId,
        terminal_fact_id: FactId,
        terminal_phase: InvocationPhaseV2,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvocationStatusReplyV2 {
    pub identity: InvocationStatusIdentityV2,
    pub phase: InvocationPhaseV2,
    pub stop_overlay: StopOverlayV2,
    pub latest_fact_id: FactId,
    pub ledger_sequence_high_water: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvocationStatusIdentityV2 {
    pub run_id: RunId,
    pub operation_id: OperationId,
    pub control_epoch: ControlEpoch,
    pub invocation_id: InvocationId,
    pub attempt_id: AttemptId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InvocationPhaseV2 {
    AttemptPrepared,
    Executing,
    FailedBeforeEffect,
    CancelledBeforeEffect,
    TimedOutBeforeEffect,
    Completed,
    FailedAfterObservedEffect,
    Indeterminate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StopOverlayV2 {
    None {},
    CancellationRequested { cancel_request_id: CancelRequestId },
    DeadlineObserved {},
    CancellationAndDeadline { cancel_request_id: CancelRequestId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ResourceResolveReplyV2 {
    Workspace {
        resource_id: ResourceId,
        invocation_id: InvocationId,
        relative_path: String,
        object_kind: crate::v2::WorkspaceObjectKindV2,
        observation: ResourceProjectionObservationV2,
        lifecycle: ResourceLifecycleV2,
        last_fact_id: FactId,
        as_of_ledger_sequence: u64,
    },
    NetworkQuery {
        resource_id: ResourceId,
        invocation_id: InvocationId,
        query_digest: QueryDigestV2,
        service_origin: NetworkOriginV2,
        observation: ResourceProjectionObservationV2,
        lifecycle: ResourceLifecycleV2,
        last_fact_id: FactId,
        as_of_ledger_sequence: u64,
    },
    NetworkEndpoint {
        resource_id: ResourceId,
        invocation_id: InvocationId,
        origin: NetworkOriginV2,
        observation: ResourceProjectionObservationV2,
        lifecycle: ResourceLifecycleV2,
        last_fact_id: FactId,
        as_of_ledger_sequence: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum ResourceLifecycleV2 {
    Resolved {},
    Acquired {},
    Released {},
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunTerminatedReplyV2 {
    pub run_id: RunId,
    pub outcome: RunTerminationOutcomeV2,
    pub cancellation: ControlCancellationReplyV2,
    pub superseded_grant_count: u64,
    pub command_batch_high_water: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RunTerminationOutcomeV2 {
    Terminated {
        termination_fact_id: FactId,
        ledger_sequence: u64,
    },
    AlreadyTerminated {
        termination_fact_id: FactId,
        ledger_sequence: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelErrorV2 {
    InvalidRequest {
        reason: InvalidRequestReasonV2,
    },
    RunNotFound {
        run_id: RunId,
    },
    ControlEpochAlreadyExists {
        run_id: RunId,
        current: ControlEpoch,
    },
    ControlEpochExhausted {
        run_id: RunId,
        current: ControlEpoch,
    },
    StaleControlEpoch {
        run_id: RunId,
        submitted: ControlEpoch,
        current: ControlEpoch,
    },
    RunTerminated {
        run_id: RunId,
        control_epoch: ControlEpoch,
    },
    ToolExecutionUnavailable {
        tool_id: AuthorityToolIdV4,
        availability: ExecutionAvailabilityV4,
    },
    GrantNotFound {
        run_id: RunId,
    },
    TrustedDecisionSourceRequired {},
    AuthorizationDigestMismatch {
        expected: AuthorizationRequestDigestV2,
        actual: AuthorizationRequestDigestV2,
    },
    DuplicateCommandDigestMismatch {
        command_request_id: CommandRequestId,
        existing: CommandRequestDigestV2,
        submitted: CommandRequestDigestV2,
    },
    DuplicateGrantDecisionDigestMismatch {
        authorization_request_digest: AuthorizationRequestDigestV2,
        existing: GrantDecisionDigestV2,
        submitted: GrantDecisionDigestV2,
    },
    DuplicateOperationDigestMismatch {
        run_id: RunId,
        operation_id: OperationId,
        idempotency_key_hash: IdempotencyKeyHashV2,
        conflict: OperationIdempotencyConflictV2,
        submitted: InvocationSubmissionDigestV2,
    },
    InvocationNotFound {
        run_id: RunId,
        invocation_id: InvocationId,
    },
    InvocationNotOwnedByRun {
        run_id: RunId,
        invocation_id: InvocationId,
    },
    ResourceNotFound {
        run_id: RunId,
        resource_id: ResourceId,
    },
    InvalidCursor {
        reason_code: InvalidCursorReasonV2,
    },
    FactStoreUnavailable {
        fault_code: StorageFaultCodeV2,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InvalidRequestReasonV2 {
    UnknownCommandKind {},
    UnknownField {
        field_path: String,
    },
    MissingField {
        field_path: String,
    },
    InvalidField {
        field_path: String,
        violation: InvalidFieldViolationV2,
    },
    InvalidRelation {
        relation: InvalidRelationV2,
    },
    DeadlineOutOfContract {
        requested_ms: u32,
        maximum_ms: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InvalidFieldViolationV2 {
    Empty,
    TooLong,
    OutOfRange,
    MalformedIdentity,
    InvalidEnum,
    Unsorted,
    Duplicate,
    PathEscapesWorkspace,
    UrlUserInfoForbidden,
    PayloadLimit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InvalidRelationV2 {
    RunMismatch,
    EpochMismatch,
    ToolInputMismatch,
    DecisionInputNotInEpoch,
    CursorScopeMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InvalidCursorReasonV2 {
    Malformed,
    SchemaMismatch,
    CatalogMismatch,
    ScopeMismatch,
    HighWaterInvalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageFaultCodeV2 {
    Unavailable,
    Busy,
    ReadOnly,
    Full,
    Io,
    Corrupt,
    SchemaMismatch,
    WriterFaulted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RecordedCommandErrorV2 {
    ControlEpochAlreadyExists {
        run_id: RunId,
        current: ControlEpoch,
    },
    ControlEpochExhausted {
        run_id: RunId,
        current: ControlEpoch,
    },
    StaleControlEpoch {
        run_id: RunId,
        submitted: ControlEpoch,
        current: ControlEpoch,
    },
    RunTerminated {
        run_id: RunId,
        control_epoch: ControlEpoch,
    },
    ToolExecutionUnavailable {
        tool_id: AuthorityToolIdV4,
        availability: ExecutionAvailabilityV4,
    },
    GrantNotFound {
        run_id: RunId,
    },
    AuthorizationDigestMismatch {
        expected: AuthorizationRequestDigestV2,
        actual: AuthorizationRequestDigestV2,
    },
    DuplicateGrantDecisionDigestMismatch {
        authorization_request_digest: AuthorizationRequestDigestV2,
        existing: GrantDecisionDigestV2,
        submitted: GrantDecisionDigestV2,
    },
    InvocationNotFound {
        run_id: RunId,
        invocation_id: InvocationId,
    },
    InvocationNotOwnedByRun {
        run_id: RunId,
        invocation_id: InvocationId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelWireErrorV2 {
    PayloadTooLarge { maximum_bytes: usize },
    InvalidJson {},
    DuplicateKey {},
    MissingAbiVersion {},
    InvalidAbiVersion {},
    UnsupportedAbiVersion { received: String },
    MissingRequestId {},
    InvalidRequestId {},
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelFactPageV2 {
    pub requested_after_ledger_sequence: u64,
    pub ledger_sequence_high_water: u64,
    pub facts: Vec<KernelFactEnvelopeV2>,
    pub continuation: FactPageContinuationV2,
}

impl KernelFactPageV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if self.facts.len() > MAX_PAGE_ITEMS_V2 {
            return Err(too_many_values("facts", MAX_PAGE_ITEMS_V2));
        }
        let mut previous = self.requested_after_ledger_sequence;
        for fact in &self.facts {
            fact.validate()?;
            if fact.ledger_sequence <= previous
                || fact.ledger_sequence > self.ledger_sequence_high_water
            {
                return Err(invalid_value(
                    "facts",
                    "must be strictly increasing and no greater than high-water",
                ));
            }
            previous = fact.ledger_sequence;
        }
        match &self.continuation {
            FactPageContinuationV2::More {
                after_ledger_sequence,
            } if self.facts.is_empty() || *after_ledger_sequence != previous => {
                return Err(invalid_value(
                    "continuation",
                    "more requires the final returned sequence",
                ));
            }
            FactPageContinuationV2::CaughtUp { at_ledger_sequence }
                if *at_ledger_sequence != self.ledger_sequence_high_water =>
            {
                return Err(invalid_value(
                    "continuation",
                    "caughtUp must equal high-water",
                ));
            }
            _ => {}
        }
        let encoded =
            serde_json::to_vec(self).map_err(|_| invalid_value("factPage", "must serialize"))?;
        if encoded.len() > MAX_FACT_PAGE_BYTES_V2 {
            return Err(field_too_large("factPage", MAX_FACT_PAGE_BYTES_V2));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FactPageContinuationV2 {
    More { after_ledger_sequence: u64 },
    CaughtUp { at_ledger_sequence: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelSnapshotRequestV2 {
    pub scope: SnapshotScopeV2,
    pub page: SnapshotPageRequestV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SnapshotScopeV2 {
    Global {},
    Run { run_id: RunId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SnapshotPageRequestV2 {
    Start { limit: u32 },
    Continue { opaque_cursor: String, limit: u32 },
}

impl SnapshotPageRequestV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        match self {
            Self::Start { limit } => validate_page_limit(*limit, "page.limit"),
            Self::Continue {
                opaque_cursor,
                limit,
            } => {
                validate_page_limit(*limit, "page.limit")?;
                validate_identity("page.opaqueCursor", opaque_cursor)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelSnapshotPageV2 {
    pub server_abi_version: String,
    pub scope: SnapshotScopeV2,
    pub as_of_ledger_sequence: u64,
    pub ledger_sequence_high_water: u64,
    pub local_tool_catalog_version: String,
    pub local_tool_catalog_digest: ToolCatalogDigestV4,
    pub entries: Vec<SnapshotEntryV2>,
    pub continuation: SnapshotContinuationV2,
}

impl KernelSnapshotPageV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_abi_version(&self.server_abi_version)?;
        if self.as_of_ledger_sequence != self.ledger_sequence_high_water {
            return Err(invalid_value(
                "ledgerSequenceHighWater",
                "must equal asOfLedgerSequence in R1",
            ));
        }
        if self.local_tool_catalog_version != KERNEL_TOOL_CATALOG_V4_VERSION {
            return Err(invalid_value(
                "localToolCatalogVersion",
                "must be deepcode.kernel.tools.v4",
            ));
        }
        if self.entries.len() > MAX_PAGE_ITEMS_V2 {
            return Err(too_many_values("entries", MAX_PAGE_ITEMS_V2));
        }
        let mut previous: Option<SnapshotSortKeyV2> = None;
        for entry in &self.entries {
            let key = entry.sort_key();
            if previous.as_ref().is_some_and(|value| value >= &key) {
                return Err(invalid_value(
                    "entries",
                    "must use the exact unique snapshot sort order",
                ));
            }
            previous = Some(key);
        }
        if matches!(self.continuation, SnapshotContinuationV2::More { .. })
            && self.entries.is_empty()
        {
            return Err(invalid_value(
                "continuation",
                "more requires a non-empty page",
            ));
        }
        let encoded = serde_json::to_vec(self)
            .map_err(|_| invalid_value("snapshotPage", "must serialize"))?;
        if encoded.len() > MAX_SNAPSHOT_PAGE_BYTES_V2 {
            return Err(field_too_large("snapshotPage", MAX_SNAPSHOT_PAGE_BYTES_V2));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SnapshotContinuationV2 {
    More { opaque_cursor: String },
    CaughtUp {},
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SnapshotEntryV2 {
    RunState {
        run_id: RunId,
        control_epoch: ControlEpoch,
        lifecycle: RunLifecycleV2,
        active_invocation: ActiveInvocationV2,
        run_sequence_high_water: u64,
        last_fact_id: FactId,
    },
    GrantState {
        run_id: RunId,
        grant_id: GrantId,
        grant_epoch: ControlEpoch,
        tool_id: AuthorityToolIdV4,
        grant_scope_digest: GrantScopeDigestV2,
        lifecycle: GrantLifecycleV2,
        use_count: u64,
        last_fact_id: FactId,
    },
    InvocationState {
        run_id: RunId,
        operation_id: OperationId,
        invocation_id: InvocationId,
        admitted_epoch: ControlEpoch,
        invocation_digest: crate::v2::InvocationRequestDigestV2,
        phase: InvocationPhaseV2,
        stop_overlay: StopOverlayV2,
        last_fact_id: FactId,
    },
    ResourceState {
        run_id: RunId,
        invocation_id: InvocationId,
        resource_id: ResourceId,
        resource: ResolvedResourceV2,
        observation: ResourceProjectionObservationV2,
        lifecycle: ResourceLifecycleV2,
        last_fact_id: FactId,
    },
}

impl SnapshotEntryV2 {
    pub fn sort_key(&self) -> SnapshotSortKeyV2 {
        match self {
            Self::RunState { run_id, .. } => SnapshotSortKeyV2 {
                entry_kind: SnapshotEntryKindV2::RunState,
                run_id: run_id.clone(),
                entity_id: run_id.as_str().to_owned(),
            },
            Self::GrantState {
                run_id, grant_id, ..
            } => SnapshotSortKeyV2 {
                entry_kind: SnapshotEntryKindV2::GrantState,
                run_id: run_id.clone(),
                entity_id: grant_id.as_str().to_owned(),
            },
            Self::InvocationState {
                run_id,
                invocation_id,
                ..
            } => SnapshotSortKeyV2 {
                entry_kind: SnapshotEntryKindV2::InvocationState,
                run_id: run_id.clone(),
                entity_id: invocation_id.as_str().to_owned(),
            },
            Self::ResourceState {
                run_id,
                resource_id,
                ..
            } => SnapshotSortKeyV2 {
                entry_kind: SnapshotEntryKindV2::ResourceState,
                run_id: run_id.clone(),
                entity_id: resource_id.as_str().to_owned(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotSortKeyV2 {
    pub entry_kind: SnapshotEntryKindV2,
    pub run_id: RunId,
    pub entity_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotEntryKindV2 {
    RunState,
    GrantState,
    InvocationState,
    ResourceState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RunLifecycleV2 {
    Active {},
    Terminated { termination_fact_id: FactId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ActiveInvocationV2 {
    None {},
    Exact { invocation_id: InvocationId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GrantLifecycleV2 {
    Issued {},
    Revoked { fact_id: FactId },
    Superseded { fact_id: FactId },
}

pub fn decode_kernel_command_v2(
    input: &[u8],
) -> Result<KernelCommandEnvelopeV2, V2WireDecodeError> {
    if input.len() > MAX_COMMAND_BYTES_V2 {
        return Err(V2WireDecodeError::PayloadTooLarge {
            maximum: MAX_COMMAND_BYTES_V2,
        });
    }
    let value = decode_strict_json(input)?;
    validate_wire_abi_header(&value)?;
    validate_request_id_header(&value)?;
    let command = serde_json::from_value::<KernelCommandEnvelopeV2>(value)
        .map_err(|error| V2WireDecodeError::InvalidPayload(error.to_string()))?;
    command.validate()?;
    Ok(command)
}

pub use crate::v2::{command_request_digest_v2, idempotency_key_hash_v2};

fn validate_abi_version(value: &str) -> Result<(), V2ValidationError> {
    if value == KERNEL_ABI_V2_VERSION {
        Ok(())
    } else {
        Err(V2ValidationError::UnsupportedAbiVersion {
            actual: value.to_owned(),
        })
    }
}

fn validate_request_id_header(value: &Value) -> Result<(), V2WireDecodeError> {
    match value.as_object().and_then(|object| object.get("requestId")) {
        None => Err(V2WireDecodeError::InvalidPayload(
            "missing requestId".to_owned(),
        )),
        Some(Value::String(value)) => CommandRequestId::new(value.clone())
            .map(|_| ())
            .map_err(|_| V2WireDecodeError::InvalidPayload("invalid requestId".to_owned())),
        Some(_) => Err(V2WireDecodeError::InvalidPayload(
            "invalid requestId".to_owned(),
        )),
    }
}

fn validate_page_limit(value: u32, field: &'static str) -> Result<(), V2ValidationError> {
    if value == 0 {
        return Err(zero_value(field));
    }
    if value as usize > MAX_PAGE_ITEMS_V2 {
        return Err(invalid_value(field, "must not exceed 1000"));
    }
    Ok(())
}

fn validate_correlations(values: &[CorrelationRefV2]) -> Result<(), V2ValidationError> {
    CorrelationSetV2 {
        refs: values.to_vec(),
    }
    .validate()
}

fn validate_text(field: &'static str, value: &str) -> Result<(), V2ValidationError> {
    if value.is_empty() {
        return Err(empty_field(field));
    }
    if value.len() > MAX_TEXT_BYTES_V2 {
        return Err(field_too_large(field, MAX_TEXT_BYTES_V2));
    }
    if value.trim() != value || value.chars().any(char::is_control) {
        return Err(invalid_value(
            field,
            "contains surrounding whitespace or control characters",
        ));
    }
    Ok(())
}

fn validate_optional_text(
    field: &'static str,
    value: Option<&str>,
) -> Result<(), V2ValidationError> {
    value.map_or(Ok(()), |value| validate_text(field, value))
}
