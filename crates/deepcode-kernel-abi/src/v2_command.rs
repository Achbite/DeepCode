use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

use crate::tool_protocol_v2::{
    CapabilityAuthorizationBindingV2, CapabilityLeaseRefV2, CapabilityScopeDigestV2,
    CapabilityScopePreviewIdV2, FactQueryContinuationV2, PlanActionIdV2, PlanRevisionV2,
    RawToolArgumentsV2, ScopeIntentV2, ToolContextBundleV2, ToolContextRefV2, ToolContractDigestV2,
    ToolEffectClassV2, ToolEffectScopeV2, ToolIdV2, ToolIntentAuthorityV2, ToolRiskV2,
    WorkspaceBindingRefV2,
};
use crate::v2::{
    decode_strict_json, empty_field, field_too_large, invalid_value, too_many_values,
    validate_cross_language_safe_json_value_v2, validate_cross_language_safe_u64_v2,
    validate_wire_abi_header, zero_value, AttemptId, CancelRequestId, CommandRequestDigestV2,
    CommandRequestId, ControlEpoch, CorrelationRefV2, EffectId, FactId, InputId, InvocationId,
    KernelFactEnvelopeV2, OperationId, ResourceId, ResourceScopeV2, RunId, V2ValidationError,
    V2WireDecodeError, WorkspaceBindingDigestV2, MAX_CORRELATION_REFS_V2, MAX_PAGE_ITEMS_V2,
    MAX_TEXT_BYTES_V2,
};
use crate::KERNEL_ABI_V2_VERSION;

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
    RunOpen(RunOpenV2),
    ToolContextGet(ToolContextGetV2),
    CapabilityScopePreviewBatch(CapabilityScopePreviewBatchV2),
    ToolIntentSubmit(ToolIntentSubmitV2),
    KernelFactsQueryScoped(KernelFactsQueryScopedV2),
    ControlEpochAdvance(ControlEpochAdvanceV2),
    InvocationCancel(InvocationCancelV2),
}

impl KernelCommandV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        match self {
            Self::RunOpen(value) => value.validate(),
            Self::ToolContextGet(value) => value.validate(),
            Self::CapabilityScopePreviewBatch(value) => value.validate(),
            Self::ToolIntentSubmit(value) => value.validate(),
            Self::KernelFactsQueryScoped(value) => value.validate(),
            Self::ControlEpochAdvance(value) => value.validate(),
            Self::InvocationCancel(value) => value.validate(),
        }
    }

    pub const fn kind(&self) -> &'static str {
        match self {
            Self::RunOpen(_) => "runOpen",
            Self::ToolContextGet(_) => "toolContextGet",
            Self::CapabilityScopePreviewBatch(_) => "capabilityScopePreviewBatch",
            Self::ToolIntentSubmit(_) => "toolIntentSubmit",
            Self::KernelFactsQueryScoped(_) => "kernelFactsQueryScoped",
            Self::ControlEpochAdvance(_) => "controlEpochAdvance",
            Self::InvocationCancel(_) => "invocationCancel",
        }
    }

    pub const fn mutation_kind(&self) -> Option<MutationCommandKindV2> {
        match self {
            Self::RunOpen(_) => Some(MutationCommandKindV2::RunOpen),
            Self::ToolIntentSubmit(_) => Some(MutationCommandKindV2::ToolIntentSubmit),
            Self::ControlEpochAdvance(_) => Some(MutationCommandKindV2::ControlEpochAdvance),
            Self::InvocationCancel(_) => Some(MutationCommandKindV2::InvocationCancel),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MutationCommandKindV2 {
    RunOpen,
    ToolIntentSubmit,
    ControlEpochAdvance,
    InvocationCancel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunOpenV2 {
    pub workspace_binding_ref: WorkspaceBindingRefV2,
    pub input_id: InputId,
    pub opaque_input_ref: String,
}

impl RunOpenV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_text("opaqueInputRef", &self.opaque_input_ref)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolContextGetV2 {
    pub run_id: RunId,
    pub known_context: Option<ToolContextRefV2>,
}

impl ToolContextGetV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityScopePreviewItemV2 {
    pub plan_action_id: PlanActionIdV2,
    pub operation_id: OperationId,
    pub idempotency_key: String,
    pub tool_id: ToolIdV2,
    pub scope_intent: ScopeIntentV2,
    pub deadline: DeadlineRequestV2,
}

impl CapabilityScopePreviewItemV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_text("idempotencyKey", &self.idempotency_key)?;
        self.scope_intent.validate()?;
        self.deadline.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityScopePreviewBatchV2 {
    pub run_id: RunId,
    pub expected_control_epoch: ControlEpoch,
    pub plan_revision: PlanRevisionV2,
    pub items: Vec<CapabilityScopePreviewItemV2>,
    pub tool_context_ref: ToolContextRefV2,
}

impl CapabilityScopePreviewBatchV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if self.items.is_empty() {
            return Err(empty_field("items"));
        }
        if self.items.len() > MAX_CORRELATION_REFS_V2 {
            return Err(too_many_values("items", MAX_CORRELATION_REFS_V2));
        }
        let mut plan_action_ids = BTreeSet::new();
        let mut operation_ids = BTreeSet::new();
        let mut idempotency_keys = BTreeSet::new();
        for item in &self.items {
            item.validate()?;
            if !plan_action_ids.insert(item.plan_action_id.as_str()) {
                return Err(invalid_value(
                    "items.planActionId",
                    "must be unique within the preview batch",
                ));
            }
            if !operation_ids.insert(item.operation_id.as_str()) {
                return Err(invalid_value(
                    "items.operationId",
                    "must be unique within the preview batch",
                ));
            }
            if !idempotency_keys.insert(item.idempotency_key.as_str()) {
                return Err(invalid_value(
                    "items.idempotencyKey",
                    "must be unique within the preview batch",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolIntentSubmitV2 {
    pub run_id: RunId,
    pub expected_control_epoch: ControlEpoch,
    pub operation_id: OperationId,
    pub idempotency_key: String,
    pub tool_id: ToolIdV2,
    pub raw_arguments: RawToolArgumentsV2,
    pub authority: ToolIntentAuthorityV2,
    pub deadline: DeadlineRequestV2,
    pub tool_context_ref: ToolContextRefV2,
}

impl ToolIntentSubmitV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_text("idempotencyKey", &self.idempotency_key)?;
        self.authority.validate()?;
        self.deadline.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelFactsQueryScopedV2 {
    pub run_id: RunId,
    pub after_ledger_sequence: u64,
    pub limit: u32,
    pub continuation: Option<FactQueryContinuationV2>,
}

impl KernelFactsQueryScopedV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_cross_language_safe_u64_v2("afterLedgerSequence", self.after_ledger_sequence)?;
        validate_page_limit(self.limit, "limit")
    }
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
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelReplyV2 {
    RunOpened(RunOpenReplyV2),
    ToolContext(ToolContextGetReplyV2),
    CapabilityScopePreviewBatchResult(CapabilityScopePreviewBatchReplyV2),
    ToolIntentSubmission(ToolIntentSubmitReplyV2),
    KernelFactsProjected(KernelFactProjectionPageV2),
    ControlEpochAdvanced(ControlEpochAdvancedReplyV2),
    InvocationCancelResult(InvocationCancelReplyV2),
    Error(KernelErrorV2),
}

impl KernelReplyV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        match self {
            Self::RunOpened(reply) => reply.validate()?,
            Self::ToolContext(reply) => reply.validate()?,
            Self::CapabilityScopePreviewBatchResult(reply) => reply.validate()?,
            Self::ToolIntentSubmission(reply) => reply.validate()?,
            Self::KernelFactsProjected(reply) => reply.validate()?,
            Self::ControlEpochAdvanced(reply) => reply.validate()?,
            Self::InvocationCancelResult(reply) => reply.validate()?,
            Self::Error(_) => {}
        }
        let encoded =
            serde_json::to_value(self).map_err(|_| invalid_value("reply", "must serialize"))?;
        validate_cross_language_safe_json_value_v2("reply", &encoded)
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
pub struct RunOpenReplyV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub workspace_binding_digest: WorkspaceBindingDigestV2,
    pub tool_context: ToolContextBundleV2,
}

impl RunOpenReplyV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        self.tool_context.validate()
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
pub enum ToolContextGetReplyV2 {
    Current { context_ref: ToolContextRefV2 },
    Updated { tool_context: ToolContextBundleV2 },
}

impl ToolContextGetReplyV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        match self {
            Self::Current { .. } => Ok(()),
            Self::Updated { tool_context } => tool_context.validate(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityScopeDispositionV2 {
    AutoIssuable,
    RequiresUserDecision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityResourcePresentationKindV2 {
    WorkspacePath,
    ResourceLabel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityResourcePresentationV2 {
    pub kind: CapabilityResourcePresentationKindV2,
    pub label: String,
    pub workspace_relative_path: Option<String>,
    pub canonical_resource_ref: Option<String>,
}

impl CapabilityResourcePresentationV2 {
    fn validate(&self) -> Result<(), V2ValidationError> {
        validate_text("approvalView.resourcePresentation.label", &self.label)?;
        validate_optional_text(
            "approvalView.resourcePresentation.workspaceRelativePath",
            self.workspace_relative_path.as_deref(),
        )?;
        validate_optional_text(
            "approvalView.resourcePresentation.canonicalResourceRef",
            self.canonical_resource_ref.as_deref(),
        )?;
        match self.kind {
            CapabilityResourcePresentationKindV2::WorkspacePath
                if self.workspace_relative_path.is_none() =>
            {
                Err(invalid_value(
                    "approvalView.resourcePresentation.workspaceRelativePath",
                    "is required for workspacePath presentation",
                ))
            }
            CapabilityResourcePresentationKindV2::ResourceLabel
                if self.workspace_relative_path.is_some() =>
            {
                Err(invalid_value(
                    "approvalView.resourcePresentation.workspaceRelativePath",
                    "is only valid for workspacePath presentation",
                ))
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityApprovalViewV2 {
    pub summary: String,
    pub canonical_targets: Vec<String>,
    pub scope_delta: Vec<String>,
    #[serde(default)]
    pub resource_presentation: Vec<CapabilityResourcePresentationV2>,
    pub risk: ToolRiskV2,
    pub effect_class: ToolEffectClassV2,
    pub effect_scope: ToolEffectScopeV2,
    pub effective_deadline_ms: u32,
    pub scope_digest: CapabilityScopeDigestV2,
}

impl CapabilityApprovalViewV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_text("approvalView.summary", &self.summary)?;
        if self.effective_deadline_ms == 0 {
            return Err(zero_value("approvalView.effectiveDeadlineMs"));
        }
        if self.canonical_targets.len() > MAX_CORRELATION_REFS_V2
            || self.scope_delta.len() > MAX_CORRELATION_REFS_V2
            || self.resource_presentation.len() > MAX_CORRELATION_REFS_V2
        {
            return Err(too_many_values(
                "approvalView.targets",
                MAX_CORRELATION_REFS_V2,
            ));
        }
        for target in self.canonical_targets.iter().chain(self.scope_delta.iter()) {
            validate_text("approvalView.target", target)?;
        }
        for presentation in &self.resource_presentation {
            presentation.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityScopePreviewRecordV2 {
    pub preview_id: CapabilityScopePreviewIdV2,
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub plan_revision: PlanRevisionV2,
    pub plan_action_id: PlanActionIdV2,
    pub operation_id: OperationId,
    pub tool_id: ToolIdV2,
    pub authorization_binding: CapabilityAuthorizationBindingV2,
    pub canonical_scope: ResourceScopeV2,
    pub scope_digest: CapabilityScopeDigestV2,
    pub authorization_digest: crate::tool_protocol_v2::CapabilityAuthorizationDigestV2,
    pub tool_contract_digest: ToolContractDigestV2,
    pub context_ref: ToolContextRefV2,
    pub effect_class: ToolEffectClassV2,
    pub effect_scope: ToolEffectScopeV2,
    pub risk: ToolRiskV2,
    pub effective_deadline_ms: u32,
    pub disposition: CapabilityScopeDispositionV2,
    pub approval_view: CapabilityApprovalViewV2,
}

impl CapabilityScopePreviewRecordV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if self.effective_deadline_ms == 0 {
            return Err(zero_value("effectiveDeadlineMs"));
        }
        if self.approval_view.risk != self.risk
            || self.approval_view.effect_class != self.effect_class
            || self.approval_view.effect_scope != self.effect_scope
            || self.approval_view.effective_deadline_ms != self.effective_deadline_ms
            || self.approval_view.scope_digest != self.scope_digest
        {
            return Err(invalid_value(
                "approvalView",
                "must describe the exact canonical preview",
            ));
        }
        self.approval_view.validate()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityScopeRejectionReasonV2 {
    ToolNotRegistered,
    ToolUnavailable,
    InvalidArguments,
    RequestedScopeInvalid,
    SettingsDenied,
    StaleToolContext,
    StaleControlEpoch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CapabilityScopePreviewReplyV2 {
    Previewed {
        preview: CapabilityScopePreviewRecordV2,
    },
    Rejected {
        plan_action_id: PlanActionIdV2,
        operation_id: OperationId,
        tool_id: ToolIdV2,
        reason: CapabilityScopeRejectionReasonV2,
        guidance: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityScopePreviewBatchReplyV2 {
    pub run_id: RunId,
    pub accepted_control_epoch: ControlEpoch,
    pub plan_revision: PlanRevisionV2,
    pub results: Vec<CapabilityScopePreviewReplyV2>,
}

impl CapabilityScopePreviewBatchReplyV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if self.results.is_empty() {
            return Err(empty_field("results"));
        }
        if self.results.len() > MAX_CORRELATION_REFS_V2 {
            return Err(too_many_values("results", MAX_CORRELATION_REFS_V2));
        }
        for result in &self.results {
            result.validate()?;
        }
        Ok(())
    }
}

impl CapabilityScopePreviewReplyV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        match self {
            Self::Previewed { preview } => preview.validate(),
            Self::Rejected { guidance, .. } => {
                validate_optional_text("guidance", Some(guidance.as_str()))
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolIntentRejectionReasonV2 {
    ToolNotRegistered,
    ToolUnavailable,
    InvalidArguments,
    StaleToolContext,
    StaleControlEpoch,
    PlanActionRequired,
    CapabilityLeaseStale,
    CapabilityScopeMismatch,
    SettingsDenied,
    RunBusy,
    CapacityExceeded,
    IndeterminateRecoveryRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ToolIntentSubmitReplyV2 {
    Admitted {
        run_id: RunId,
        operation_id: OperationId,
        accepted_control_epoch: ControlEpoch,
        lease: Option<CapabilityLeaseRefV2>,
        invocation_id: InvocationId,
        attempt_id: AttemptId,
        effective_deadline_ms: u32,
        admission_fact_id: FactId,
        admission_batch_high_water: u64,
    },
    AwaitingCapability {
        run_id: RunId,
        operation_id: OperationId,
        accepted_control_epoch: ControlEpoch,
        invocation_id: InvocationId,
        preview: CapabilityScopePreviewRecordV2,
        awaiting_fact_id: FactId,
        awaiting_batch_high_water: u64,
    },
    Rejected {
        run_id: RunId,
        operation_id: OperationId,
        current_control_epoch: ControlEpoch,
        reason: ToolIntentRejectionReasonV2,
        guidance: String,
        rejection_fact_id: FactId,
        rejection_batch_high_water: u64,
    },
}

impl ToolIntentSubmitReplyV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        match self {
            Self::Admitted {
                effective_deadline_ms,
                admission_batch_high_water,
                ..
            } => {
                if *effective_deadline_ms == 0 {
                    return Err(zero_value("effectiveDeadlineMs"));
                }
                if *admission_batch_high_water == 0 {
                    return Err(zero_value("admissionBatchHighWater"));
                }
                validate_cross_language_safe_u64_v2(
                    "admissionBatchHighWater",
                    *admission_batch_high_water,
                )
            }
            Self::AwaitingCapability {
                run_id,
                operation_id,
                accepted_control_epoch,
                preview,
                awaiting_batch_high_water,
                ..
            } => {
                preview.validate()?;
                if run_id != &preview.run_id
                    || operation_id != &preview.operation_id
                    || accepted_control_epoch != &preview.control_epoch
                {
                    return Err(invalid_value(
                        "awaitingCapability.preview",
                        "must match the reply runId, operationId, and acceptedControlEpoch",
                    ));
                }
                if *awaiting_batch_high_water == 0 {
                    return Err(zero_value("awaitingBatchHighWater"));
                }
                validate_cross_language_safe_u64_v2(
                    "awaitingBatchHighWater",
                    *awaiting_batch_high_water,
                )
            }
            Self::Rejected {
                guidance,
                rejection_batch_high_water,
                ..
            } => {
                validate_optional_text("guidance", Some(guidance.as_str()))?;
                if *rejection_batch_high_water == 0 {
                    return Err(zero_value("rejectionBatchHighWater"));
                }
                validate_cross_language_safe_u64_v2(
                    "rejectionBatchHighWater",
                    *rejection_batch_high_water,
                )
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelFactDomainProjectionV2 {
    Control,
    Authorization,
    Invocation,
    Effect,
    Resource,
    Cleanup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelFactLineageV2 {
    pub run_id: RunId,
    pub control_epoch: Option<ControlEpoch>,
    pub plan_action_ids: Vec<PlanActionIdV2>,
    pub operation_id: Option<OperationId>,
    pub capability_lease: Option<CapabilityLeaseRefV2>,
    pub invocation_id: Option<InvocationId>,
    pub attempt_id: Option<AttemptId>,
    pub effect_id: Option<EffectId>,
    pub resource_ids: Vec<ResourceId>,
}

impl KernelFactLineageV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if self.plan_action_ids.len() > MAX_CORRELATION_REFS_V2
            || self.resource_ids.len() > MAX_CORRELATION_REFS_V2
        {
            return Err(too_many_values("fact.lineage", MAX_CORRELATION_REFS_V2));
        }
        if !self
            .plan_action_ids
            .windows(2)
            .all(|pair| pair[0] < pair[1])
            || !self
                .resource_ids
                .windows(2)
                .all(|pair| pair[0].as_str() < pair[1].as_str())
        {
            return Err(invalid_value(
                "fact.lineage",
                "identifier lists must be strictly sorted and unique",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelFactProjectionV2 {
    pub abi_version: String,
    pub fact_id: FactId,
    pub ledger_sequence: u64,
    pub run_sequence: u64,
    pub recorded_at: crate::v2::RecordedAtV2,
    pub domain: KernelFactDomainProjectionV2,
    pub fact_kind: String,
    pub lineage: KernelFactLineageV2,
    pub details: Value,
}

impl KernelFactProjectionV2 {
    pub fn from_envelope(envelope: &KernelFactEnvelopeV2) -> Result<Self, V2ValidationError> {
        envelope.validate()?;
        let encoded_payload = serde_json::to_value(&envelope.payload)
            .map_err(|_| invalid_value("fact.details", "must serialize"))?;
        let encoded_fact = encoded_payload
            .as_object()
            .and_then(|object| object.get("fact"))
            .and_then(Value::as_object)
            .ok_or_else(|| invalid_value("fact.details", "must contain a typed fact"))?;
        let fact_kind = encoded_fact
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_value("fact.details", "must contain a typed fact kind"))?
            .to_owned();
        let details = encoded_fact
            .get("data")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or_else(|| invalid_value("fact.details", "must contain object fact data"))?;
        let domain = match &envelope.payload {
            crate::v2::KernelFactPayloadV2::Control(_) => KernelFactDomainProjectionV2::Control,
            crate::v2::KernelFactPayloadV2::Authorization(_) => {
                KernelFactDomainProjectionV2::Authorization
            }
            crate::v2::KernelFactPayloadV2::Invocation(_) => {
                KernelFactDomainProjectionV2::Invocation
            }
            crate::v2::KernelFactPayloadV2::Effect(_) => KernelFactDomainProjectionV2::Effect,
            crate::v2::KernelFactPayloadV2::Resource(_) => KernelFactDomainProjectionV2::Resource,
            crate::v2::KernelFactPayloadV2::Cleanup(_) => KernelFactDomainProjectionV2::Cleanup,
        };
        let mut plan_action_ids = envelope
            .payload
            .correlation_set()
            .into_iter()
            .flat_map(|set| set.refs.iter())
            .map(|reference| match reference {
                CorrelationRefV2::PlanAction { value } => PlanActionIdV2::new(value.clone()),
            })
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(plan_action_id) = envelope.payload.authorization_plan_action_id() {
            plan_action_ids.push(plan_action_id.clone());
        }
        plan_action_ids.sort();
        plan_action_ids.dedup();
        let mut resource_ids = envelope
            .payload
            .resource_ids()
            .into_iter()
            .cloned()
            .collect::<Vec<_>>();
        resource_ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
        resource_ids.dedup();
        let lineage = KernelFactLineageV2 {
            run_id: envelope.payload.run_id().clone(),
            control_epoch: envelope.payload.control_epoch(),
            plan_action_ids,
            operation_id: envelope.payload.operation_id().cloned(),
            capability_lease: envelope.payload.capability_lease(),
            invocation_id: envelope.payload.invocation_id().cloned(),
            attempt_id: envelope.payload.attempt_id().cloned(),
            effect_id: envelope.payload.effect_id().cloned(),
            resource_ids,
        };
        let projection = Self {
            abi_version: envelope.abi_version.clone(),
            fact_id: envelope.fact_id.clone(),
            ledger_sequence: envelope.ledger_sequence,
            run_sequence: envelope.run_sequence,
            recorded_at: envelope.recorded_at.clone(),
            domain,
            fact_kind,
            lineage,
            details,
        };
        projection.validate()?;
        Ok(projection)
    }

    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_abi_version(&self.abi_version)?;
        if self.ledger_sequence == 0 {
            return Err(zero_value("ledgerSequence"));
        }
        if self.run_sequence == 0 {
            return Err(zero_value("runSequence"));
        }
        validate_cross_language_safe_u64_v2("ledgerSequence", self.ledger_sequence)?;
        validate_cross_language_safe_u64_v2("runSequence", self.run_sequence)?;
        validate_text("factKind", &self.fact_kind)?;
        if !self.details.is_object() {
            return Err(invalid_value("details", "must be a JSON object"));
        }
        validate_cross_language_safe_json_value_v2("details", &self.details)?;
        self.lineage.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelFactProjectionPageV2 {
    pub requested_after_ledger_sequence: u64,
    pub snapshot_high_water: u64,
    pub facts: Vec<KernelFactProjectionV2>,
    pub has_more: bool,
    pub next_after_ledger_sequence: u64,
    pub next_continuation: Option<FactQueryContinuationV2>,
}

impl KernelFactProjectionPageV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_cross_language_safe_u64_v2(
            "requestedAfterLedgerSequence",
            self.requested_after_ledger_sequence,
        )?;
        validate_cross_language_safe_u64_v2("snapshotHighWater", self.snapshot_high_water)?;
        validate_cross_language_safe_u64_v2(
            "nextAfterLedgerSequence",
            self.next_after_ledger_sequence,
        )?;
        if self.facts.len() > MAX_PAGE_ITEMS_V2 {
            return Err(too_many_values("facts", MAX_PAGE_ITEMS_V2));
        }
        if self.requested_after_ledger_sequence > self.snapshot_high_water {
            return Err(invalid_value(
                "requestedAfterLedgerSequence",
                "must be no greater than snapshotHighWater",
            ));
        }
        let mut previous = self.requested_after_ledger_sequence;
        for fact in &self.facts {
            fact.validate()?;
            if fact.ledger_sequence <= previous || fact.ledger_sequence > self.snapshot_high_water {
                return Err(invalid_value(
                    "facts",
                    "must be strictly increasing and no greater than high-water",
                ));
            }
            previous = fact.ledger_sequence;
        }
        if self.has_more != self.next_continuation.is_some() {
            return Err(invalid_value(
                "nextContinuation",
                "must be present exactly when hasMore is true",
            ));
        }
        if self.has_more {
            if self.facts.is_empty()
                || self.next_after_ledger_sequence != previous
                || self.next_after_ledger_sequence >= self.snapshot_high_water
            {
                return Err(invalid_value(
                    "nextAfterLedgerSequence",
                    "a continued page must advance to its final fact below snapshotHighWater",
                ));
            }
        } else if self.next_after_ledger_sequence != self.snapshot_high_water {
            return Err(invalid_value(
                "nextAfterLedgerSequence",
                "a caught-up page must advance across run gaps to snapshotHighWater",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlEpochAdvancedReplyV2 {
    pub run_id: RunId,
    pub accepted_control_epoch: ControlEpoch,
    pub epoch_fact_id: FactId,
    pub superseded_capability_count: u64,
    pub cancellation: ControlCancellationReplyV2,
    pub command_batch_high_water: u64,
}

impl ControlEpochAdvancedReplyV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_cross_language_safe_u64_v2(
            "supersededCapabilityCount",
            self.superseded_capability_count,
        )?;
        if self.command_batch_high_water == 0 {
            return Err(zero_value("commandBatchHighWater"));
        }
        validate_cross_language_safe_u64_v2("commandBatchHighWater", self.command_batch_high_water)
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

impl InvocationCancelReplyV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        let ledger_sequence = match self {
            Self::Requested {
                ledger_sequence, ..
            }
            | Self::AlreadyRequested {
                ledger_sequence, ..
            } => Some(*ledger_sequence),
            Self::NoActiveInvocation { .. } | Self::AlreadyTerminal { .. } => None,
        };
        let Some(ledger_sequence) = ledger_sequence else {
            return Ok(());
        };
        if ledger_sequence == 0 {
            return Err(zero_value("ledgerSequence"));
        }
        validate_cross_language_safe_u64_v2("ledgerSequence", ledger_sequence)
    }
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
pub enum KernelErrorV2 {
    InvalidRequest {
        reason: InvalidRequestReasonV2,
    },
    RunNotFound {
        run_id: RunId,
    },
    WorkspaceBindingNotFound {
        workspace_binding_ref: WorkspaceBindingRefV2,
    },
    RunCapabilityRequired {
        run_id: RunId,
    },
    RunCapabilityInvalid {
        run_id: RunId,
    },
    RunRetirementPending {
        run_id: RunId,
        control_epoch: ControlEpoch,
        fence_fact_id: FactId,
        fence_ledger_sequence: u64,
    },
    ToolNotRegistered {
        tool_id: ToolIdV2,
    },
    ToolUnavailable {
        tool_id: ToolIdV2,
        availability: crate::tool_protocol_v2::ToolAvailabilityV2,
    },
    ToolContextStale {
        submitted: ToolContextRefV2,
        current: ToolContextRefV2,
    },
    CapabilityLeaseNotFound {
        run_id: RunId,
        lease_id: crate::tool_protocol_v2::CapabilityLeaseIdV2,
    },
    CapabilityLeaseStale {
        lease: CapabilityLeaseRefV2,
    },
    CapabilityScopeMismatch {
        submitted: CapabilityScopeDigestV2,
        authorized: CapabilityScopeDigestV2,
    },
    UnsupportedHistorySchema {
        received: String,
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
    DuplicateCommandDigestMismatch {
        command_request_id: CommandRequestId,
        existing: CommandRequestDigestV2,
        submitted: CommandRequestDigestV2,
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
    InvalidRelation,
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
    InvalidPayload {},
    DuplicateKey {},
    MissingAbiVersion {},
    InvalidAbiVersion {},
    UnsupportedAbiVersion { received: String },
    MissingRequestId {},
    InvalidRequestId {},
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
