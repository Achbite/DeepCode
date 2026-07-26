use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::v2::{
    decode_strict_json, validate_wire_abi_header, AttemptId, CancelRequestId, CleanupId,
    ControlEpoch, CorrelationRefV2, FactId, GrantId, GrantReservationId, InputId, InvocationId,
    KernelErrorCodeV2, KernelFactEnvelopeV2, OperationId, ResourceId, RunId, V2ValidationError,
    V2WireDecodeError,
};
use crate::{KERNEL_ABI_V2_VERSION, KERNEL_TOOL_CATALOG_V4_VERSION};

const MAX_COMMAND_BYTES: usize = 2 * 1024 * 1024;
const MAX_ID_BYTES: usize = 512;
const MAX_TEXT_BYTES: usize = 16 * 1024;
const MAX_SCOPE_ITEMS: usize = 256;
const MAX_PAGE_SIZE: u32 = 1_000;
const MAX_TOOL_ARGS_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelCommandEnvelopeV2 {
    pub abi_version: String,
    pub request_id: String,
    pub command: KernelCommandV2,
}

impl KernelCommandEnvelopeV2 {
    pub fn new(request_id: impl Into<String>, command: KernelCommandV2) -> Self {
        Self {
            abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
            request_id: request_id.into(),
            command,
        }
    }

    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_version(&self.abi_version)?;
        validate_text("requestId", &self.request_id)?;
        self.command.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelCommandV2 {
    CompatibilityGet,
    ToolCatalogGet,
    ControlEpochAdvance {
        run_id: RunId,
        input_id: InputId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_current_epoch: Option<ControlEpoch>,
        opaque_input_ref: String,
    },
    GrantPreview {
        run_id: RunId,
        operation_id: OperationId,
        control_epoch: ControlEpoch,
        tool_id: String,
        args: Value,
        target_refs: Vec<ResourceTargetV2>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        requested_deadline_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        correlation_refs: Vec<CorrelationRefV2>,
    },
    GrantDecisionSubmit {
        run_id: RunId,
        operation_id: OperationId,
        control_epoch: ControlEpoch,
        request_digest: String,
        decision: GrantDecisionV2,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    GrantRevoke {
        run_id: RunId,
        operation_id: OperationId,
        control_epoch: ControlEpoch,
        grant_id: GrantId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    InvocationSubmit {
        run_id: RunId,
        operation_id: OperationId,
        control_epoch: ControlEpoch,
        grant_id: GrantId,
        tool_id: String,
        args: Value,
        target_refs: Vec<ResourceTargetV2>,
        idempotency_key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        requested_deadline_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        correlation_refs: Vec<CorrelationRefV2>,
    },
    InvocationCancel {
        run_id: RunId,
        expected_control_epoch: ControlEpoch,
        cancel_request_id: CancelRequestId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        invocation_id: Option<InvocationId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    InvocationStatusGet {
        run_id: RunId,
        invocation_id: InvocationId,
    },
    EffectFactsQuery {
        filter: EffectFactsFilterV2,
        cursor: EventStreamCursorV2,
    },
    ResourceResolve {
        run_id: RunId,
        operation_id: OperationId,
        control_epoch: ControlEpoch,
        tool_id: String,
        target: ResourceTargetV2,
    },
    CleanupRetry {
        run_id: RunId,
        operation_id: OperationId,
        control_epoch: ControlEpoch,
        cleanup_id: CleanupId,
        resource_id: ResourceId,
    },
    RunTerminate {
        run_id: RunId,
        expected_control_epoch: ControlEpoch,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

impl KernelCommandV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        match self {
            Self::CompatibilityGet | Self::ToolCatalogGet => Ok(()),
            Self::ControlEpochAdvance {
                run_id,
                input_id,
                expected_current_epoch,
                opaque_input_ref,
            } => {
                run_id.validate_as("command.runId")?;
                input_id.validate_as("command.inputId")?;
                if let Some(epoch) = expected_current_epoch {
                    epoch.validate()?;
                }
                validate_text("command.opaqueInputRef", opaque_input_ref)
            }
            Self::GrantPreview {
                run_id,
                operation_id,
                control_epoch,
                tool_id,
                args,
                target_refs,
                requested_deadline_ms,
                correlation_refs,
            } => {
                validate_run_operation_epoch(run_id, operation_id, *control_epoch)?;
                validate_text("command.toolId", tool_id)?;
                validate_json_size("command.args", args, MAX_TOOL_ARGS_BYTES)?;
                validate_targets(target_refs)?;
                validate_requested_deadline(*requested_deadline_ms)?;
                validate_correlations(correlation_refs)
            }
            Self::GrantDecisionSubmit {
                run_id,
                operation_id,
                control_epoch,
                request_digest,
                reason,
                ..
            } => {
                validate_run_operation_epoch(run_id, operation_id, *control_epoch)?;
                validate_text("command.requestDigest", request_digest)?;
                validate_optional_text("command.reason", reason.as_deref())
            }
            Self::GrantRevoke {
                run_id,
                operation_id,
                control_epoch,
                grant_id,
                reason,
            } => {
                validate_run_operation_epoch(run_id, operation_id, *control_epoch)?;
                grant_id.validate_as("command.grantId")?;
                validate_optional_text("command.reason", reason.as_deref())
            }
            Self::InvocationSubmit {
                run_id,
                operation_id,
                control_epoch,
                grant_id,
                tool_id,
                args,
                target_refs,
                idempotency_key,
                requested_deadline_ms,
                correlation_refs,
            } => {
                validate_run_operation_epoch(run_id, operation_id, *control_epoch)?;
                grant_id.validate_as("command.grantId")?;
                validate_text("command.toolId", tool_id)?;
                validate_json_size("command.args", args, MAX_TOOL_ARGS_BYTES)?;
                validate_targets(target_refs)?;
                validate_text("command.idempotencyKey", idempotency_key)?;
                validate_requested_deadline(*requested_deadline_ms)?;
                validate_correlations(correlation_refs)
            }
            Self::InvocationCancel {
                run_id,
                expected_control_epoch,
                cancel_request_id,
                invocation_id,
                reason,
            } => {
                run_id.validate_as("command.runId")?;
                expected_control_epoch.validate()?;
                cancel_request_id.validate_as("command.cancelRequestId")?;
                if let Some(invocation_id) = invocation_id {
                    invocation_id.validate_as("command.invocationId")?;
                }
                validate_optional_text("command.reason", reason.as_deref())
            }
            Self::InvocationStatusGet {
                run_id,
                invocation_id,
            } => {
                run_id.validate_as("command.runId")?;
                invocation_id.validate_as("command.invocationId")
            }
            Self::EffectFactsQuery { filter, cursor } => {
                filter.validate()?;
                cursor.validate()
            }
            Self::ResourceResolve {
                run_id,
                operation_id,
                control_epoch,
                tool_id,
                target,
            } => {
                validate_run_operation_epoch(run_id, operation_id, *control_epoch)?;
                validate_text("command.toolId", tool_id)?;
                target.validate()
            }
            Self::CleanupRetry {
                run_id,
                operation_id,
                control_epoch,
                cleanup_id,
                resource_id,
            } => {
                validate_run_operation_epoch(run_id, operation_id, *control_epoch)?;
                cleanup_id.validate_as("command.cleanupId")?;
                resource_id.validate_as("command.resourceId")
            }
            Self::RunTerminate {
                run_id,
                expected_control_epoch,
                reason,
            } => {
                run_id.validate_as("command.runId")?;
                expected_control_epoch.validate()?;
                validate_optional_text("command.reason", reason.as_deref())
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolRiskV2 {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GrantDecisionV2 {
    Allow,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceTargetV2 {
    pub resource_kind: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_digest: Option<String>,
}

impl ResourceTargetV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_text("command.target.resourceKind", &self.resource_kind)?;
        validate_text("command.target.target", &self.target)?;
        validate_optional_text(
            "command.target.expectedDigest",
            self.expected_digest.as_deref(),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectFactsFilterV2 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<OperationId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invocation_id: Option<InvocationId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<AttemptId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_id: Option<GrantId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_reservation_id: Option<GrantReservationId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_epoch: Option<ControlEpoch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<ResourceId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fact_id: Option<FactId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<FactId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub correlation_refs: Vec<CorrelationRefV2>,
}

impl EffectFactsFilterV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if let Some(run_id) = &self.run_id {
            run_id.validate_as("filter.runId")?;
        }
        if let Some(operation_id) = &self.operation_id {
            operation_id.validate_as("filter.operationId")?;
        }
        if let Some(invocation_id) = &self.invocation_id {
            invocation_id.validate_as("filter.invocationId")?;
        }
        if let Some(attempt_id) = &self.attempt_id {
            attempt_id.validate_as("filter.attemptId")?;
        }
        if let Some(grant_id) = &self.grant_id {
            grant_id.validate_as("filter.grantId")?;
        }
        if let Some(reservation_id) = &self.grant_reservation_id {
            reservation_id.validate_as("filter.grantReservationId")?;
        }
        if let Some(control_epoch) = self.control_epoch {
            control_epoch.validate()?;
        }
        if let Some(resource_id) = &self.resource_id {
            resource_id.validate_as("filter.resourceId")?;
        }
        if let Some(fact_id) = &self.fact_id {
            fact_id.validate_as("filter.factId")?;
        }
        if let Some(causation_id) = &self.causation_id {
            causation_id.validate_as("filter.causationId")?;
        }
        validate_optional_text(
            "filter.idempotencyKeyHash",
            self.idempotency_key_hash.as_deref(),
        )?;
        validate_correlations(&self.correlation_refs)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventStreamCursorV2 {
    pub after_ledger_sequence: u64,
    pub limit: u32,
}

impl EventStreamCursorV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if self.limit == 0 {
            return Err(V2ValidationError::ZeroValue {
                field: "cursor.limit",
            });
        }
        if self.limit > MAX_PAGE_SIZE {
            return Err(V2ValidationError::InvalidRelation {
                field: "cursor.limit",
                detail: "exceeds the maximum page size",
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelReplyEnvelopeV2 {
    pub abi_version: String,
    pub request_id: String,
    pub reply: KernelReplyV2,
}

impl KernelReplyEnvelopeV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_version(&self.abi_version)?;
        validate_text("requestId", &self.request_id)?;
        self.reply.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "body",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum KernelReplyV2 {
    Compatibility(CompatibilityV2),
    ToolCatalog(ToolCatalogV2),
    GrantPreview(GrantPreviewResultV2),
    CommandAck(CommandAckV2),
    InvocationStatus(InvocationStatusV2),
    EffectFacts(EffectFactsPageV2),
    ResourceResolved(ResourceResolutionV2),
    Error(KernelErrorEnvelopeV2),
}

impl KernelReplyV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        match self {
            Self::Compatibility(value) => value.validate(),
            Self::ToolCatalog(value) => value.validate(),
            Self::GrantPreview(value) => value.validate(),
            Self::CommandAck(value) => value.validate(),
            Self::InvocationStatus(value) => value.validate(),
            Self::EffectFacts(value) => value.validate(),
            Self::ResourceResolved(value) => value.validate(),
            Self::Error(value) => value.validate(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompatibilityV2 {
    pub kernel_abi_version: String,
    pub tool_catalog_version: String,
}

impl CompatibilityV2 {
    pub fn canonical() -> Self {
        Self {
            kernel_abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
            tool_catalog_version: KERNEL_TOOL_CATALOG_V4_VERSION.to_owned(),
        }
    }

    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_version(&self.kernel_abi_version)?;
        if self.tool_catalog_version != KERNEL_TOOL_CATALOG_V4_VERSION {
            return Err(V2ValidationError::InvalidRelation {
                field: "toolCatalogVersion",
                detail: "does not match the v4 tool catalog contract",
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolCatalogV2 {
    pub catalog_version: String,
    pub tools: Vec<ToolContractSummaryV2>,
}

impl ToolCatalogV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if self.catalog_version != KERNEL_TOOL_CATALOG_V4_VERSION {
            return Err(V2ValidationError::InvalidRelation {
                field: "catalogVersion",
                detail: "does not match the v4 tool catalog contract",
            });
        }
        for tool in &self.tools {
            tool.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolContractSummaryV2 {
    pub tool_id: String,
    pub effect_scope: Vec<String>,
    pub risk: ToolRiskV2,
    pub default_deadline_ms: u64,
    pub maximum_deadline_ms: u64,
    pub cancellable: bool,
}

impl ToolContractSummaryV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_text("tools[].toolId", &self.tool_id)?;
        validate_scope("tools[].effectScope", &self.effect_scope)?;
        if self.default_deadline_ms == 0 {
            return Err(V2ValidationError::ZeroValue {
                field: "tools[].defaultDeadlineMs",
            });
        }
        if self.maximum_deadline_ms < self.default_deadline_ms {
            return Err(V2ValidationError::InvalidRelation {
                field: "tools[].maximumDeadlineMs",
                detail: "must be greater than or equal to defaultDeadlineMs",
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GrantPreviewDispositionV2 {
    AutoIssuable,
    RequiresDecision,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantPreviewResultV2 {
    pub run_id: RunId,
    pub operation_id: OperationId,
    pub control_epoch: ControlEpoch,
    pub tool_id: String,
    pub request_digest: String,
    pub derived_resource_scope: Vec<String>,
    pub derived_effect_scope: Vec<String>,
    pub derived_risk: ToolRiskV2,
    pub disposition: GrantPreviewDispositionV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl GrantPreviewResultV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_run_operation_epoch(&self.run_id, &self.operation_id, self.control_epoch)?;
        validate_text("grantPreview.toolId", &self.tool_id)?;
        validate_text("grantPreview.requestDigest", &self.request_digest)?;
        validate_scope(
            "grantPreview.derivedResourceScope",
            &self.derived_resource_scope,
        )?;
        validate_scope(
            "grantPreview.derivedEffectScope",
            &self.derived_effect_scope,
        )?;
        validate_optional_text("grantPreview.reason", self.reason.as_deref())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandAckStatusV2 {
    Accepted,
    Admitted,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandAckV2 {
    pub status: CommandAckStatusV2,
    pub run_id: RunId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<OperationId>,
    pub accepted_control_epoch: ControlEpoch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<InputId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancel_request_id: Option<CancelRequestId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_id: Option<GrantId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invocation_id: Option<InvocationId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<KernelErrorEnvelopeV2>,
}

impl CommandAckV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        self.run_id.validate_as("ack.runId")?;
        self.accepted_control_epoch.validate()?;
        validate_optional_id("ack.operationId", self.operation_id.as_ref())?;
        validate_optional_id("ack.inputId", self.input_id.as_ref())?;
        validate_optional_id("ack.cancelRequestId", self.cancel_request_id.as_ref())?;
        validate_optional_id("ack.grantId", self.grant_id.as_ref())?;
        validate_optional_id("ack.invocationId", self.invocation_id.as_ref())?;
        if matches!(self.status, CommandAckStatusV2::Rejected) != self.error.is_some() {
            return Err(V2ValidationError::InvalidRelation {
                field: "ack.error",
                detail: "must be present exactly when status is rejected",
            });
        }
        if let Some(error) = &self.error {
            error.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InvocationStateV2 {
    Admitted,
    AttemptPrepared,
    Running,
    CancellationRequested,
    Completed,
    Failed,
    Indeterminate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvocationStatusV2 {
    pub run_id: RunId,
    pub invocation_id: InvocationId,
    pub operation_id: OperationId,
    pub control_epoch: ControlEpoch,
    pub state: InvocationStateV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fact_id: Option<FactId>,
}

impl InvocationStatusV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_run_operation_epoch(&self.run_id, &self.operation_id, self.control_epoch)?;
        self.invocation_id
            .validate_as("invocationStatus.invocationId")?;
        validate_optional_id("invocationStatus.lastFactId", self.last_fact_id.as_ref())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectFactsPageV2 {
    pub facts: Vec<KernelFactEnvelopeV2>,
    pub ledger_sequence_high_water: u64,
    pub next_after_ledger_sequence: u64,
    pub caught_up: bool,
}

impl EffectFactsPageV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        for fact in &self.facts {
            fact.validate()?;
        }
        if self.next_after_ledger_sequence > self.ledger_sequence_high_water {
            return Err(V2ValidationError::InvalidRelation {
                field: "nextAfterLedgerSequence",
                detail: "must not exceed ledgerSequenceHighWater",
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceResolutionV2 {
    pub run_id: RunId,
    pub resource_id: ResourceId,
    pub canonical_target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_digest: Option<String>,
}

impl ResourceResolutionV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        self.run_id.validate_as("resource.runId")?;
        self.resource_id.validate_as("resource.resourceId")?;
        validate_text("resource.canonicalTarget", &self.canonical_target)?;
        validate_optional_text("resource.contentDigest", self.content_digest.as_deref())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelErrorEnvelopeV2 {
    pub code: KernelErrorCodeV2,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl KernelErrorEnvelopeV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_text("error.message", &self.message)
    }

    pub fn from_wire_error(error: &V2WireDecodeError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
            retryable: false,
            details: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunSequenceHighWaterV2 {
    pub run_id: RunId,
    pub run_sequence_high_water: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelSnapshotV2 {
    pub abi_version: String,
    pub ledger_sequence_high_water: u64,
    pub run_sequences: Vec<RunSequenceHighWaterV2>,
    pub active_invocations: Vec<InvocationStatusV2>,
}

impl KernelSnapshotV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_version(&self.abi_version)?;
        for run in &self.run_sequences {
            run.run_id.validate_as("snapshot.runSequences[].runId")?;
        }
        for invocation in &self.active_invocations {
            invocation.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventStreamPageV2 {
    pub facts: Vec<KernelFactEnvelopeV2>,
    pub ledger_sequence_high_water: u64,
    pub next_after_ledger_sequence: u64,
    pub caught_up: bool,
}

impl EventStreamPageV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        EffectFactsPageV2 {
            facts: self.facts.clone(),
            ledger_sequence_high_water: self.ledger_sequence_high_water,
            next_after_ledger_sequence: self.next_after_ledger_sequence,
            caught_up: self.caught_up,
        }
        .validate()
    }
}

/// Parses only the ABI discriminator before attempting typed command
/// deserialization. A legacy payload therefore receives the frozen
/// `UnsupportedAbiVersion` code even when its remaining shape is not v2.
pub fn decode_kernel_command_v2(
    input: &[u8],
) -> Result<KernelCommandEnvelopeV2, V2WireDecodeError> {
    if input.len() > MAX_COMMAND_BYTES {
        return Err(V2ValidationError::FieldTooLarge {
            field: "commandEnvelope",
            maximum_bytes: MAX_COMMAND_BYTES,
        }
        .into());
    }
    let value = decode_strict_json(input)?;
    validate_wire_abi_header(&value)?;
    let command: KernelCommandEnvelopeV2 =
        serde_json::from_value(value).map_err(|error| V2WireDecodeError::InvalidPayload {
            message: error.to_string(),
        })?;
    command.validate()?;
    Ok(command)
}

fn validate_run_operation(
    run_id: &RunId,
    operation_id: &OperationId,
) -> Result<(), V2ValidationError> {
    run_id.validate_as("command.runId")?;
    operation_id.validate_as("command.operationId")
}

fn validate_run_operation_epoch(
    run_id: &RunId,
    operation_id: &OperationId,
    control_epoch: ControlEpoch,
) -> Result<(), V2ValidationError> {
    validate_run_operation(run_id, operation_id)?;
    control_epoch.validate()
}

fn validate_version(version: &str) -> Result<(), V2ValidationError> {
    if version != KERNEL_ABI_V2_VERSION {
        return Err(V2ValidationError::UnsupportedAbiVersion {
            actual: version.to_owned(),
            expected: KERNEL_ABI_V2_VERSION,
        });
    }
    Ok(())
}

fn validate_text(field: &'static str, value: &str) -> Result<(), V2ValidationError> {
    if value.trim().is_empty() {
        return Err(V2ValidationError::EmptyField { field });
    }
    if value.len() > MAX_TEXT_BYTES {
        return Err(V2ValidationError::FieldTooLarge {
            field,
            maximum_bytes: MAX_TEXT_BYTES,
        });
    }
    Ok(())
}

fn validate_optional_text(
    field: &'static str,
    value: Option<&str>,
) -> Result<(), V2ValidationError> {
    if let Some(value) = value {
        validate_text(field, value)?;
    }
    Ok(())
}

fn validate_scope(field: &'static str, values: &[String]) -> Result<(), V2ValidationError> {
    if values.is_empty() {
        return Err(V2ValidationError::EmptyField { field });
    }
    if values.len() > MAX_SCOPE_ITEMS {
        return Err(V2ValidationError::TooManyValues {
            field,
            maximum: MAX_SCOPE_ITEMS,
        });
    }
    for value in values {
        validate_text(field, value)?;
    }
    Ok(())
}

fn validate_json_size(
    field: &'static str,
    value: &Value,
    maximum_bytes: usize,
) -> Result<(), V2ValidationError> {
    let size = serde_json::to_vec(value)
        .map_err(|_| V2ValidationError::InvalidRelation {
            field,
            detail: "must be serializable JSON",
        })?
        .len();
    if size > maximum_bytes {
        return Err(V2ValidationError::FieldTooLarge {
            field,
            maximum_bytes,
        });
    }
    Ok(())
}

fn validate_targets(targets: &[ResourceTargetV2]) -> Result<(), V2ValidationError> {
    if targets.len() > MAX_SCOPE_ITEMS {
        return Err(V2ValidationError::TooManyValues {
            field: "command.targetRefs",
            maximum: MAX_SCOPE_ITEMS,
        });
    }
    for target in targets {
        target.validate()?;
    }
    Ok(())
}

fn validate_requested_deadline(value: Option<u64>) -> Result<(), V2ValidationError> {
    if value == Some(0) {
        return Err(V2ValidationError::ZeroValue {
            field: "command.requestedDeadlineMs",
        });
    }
    Ok(())
}

fn validate_correlations(values: &[CorrelationRefV2]) -> Result<(), V2ValidationError> {
    if values.len() > 64 {
        return Err(V2ValidationError::TooManyValues {
            field: "correlationRefs",
            maximum: 64,
        });
    }
    for correlation in values {
        validate_text("correlationRefs[].kind", &correlation.kind)?;
        validate_text("correlationRefs[].value", &correlation.value)?;
    }
    Ok(())
}

fn validate_optional_id<T>(field: &'static str, value: Option<&T>) -> Result<(), V2ValidationError>
where
    T: AsRef<str>,
{
    if let Some(value) = value {
        let value = value.as_ref();
        if value.trim().is_empty() {
            return Err(V2ValidationError::EmptyField { field });
        }
        if value.len() > MAX_ID_BYTES {
            return Err(V2ValidationError::FieldTooLarge {
                field,
                maximum_bytes: MAX_ID_BYTES,
            });
        }
    }
    Ok(())
}
