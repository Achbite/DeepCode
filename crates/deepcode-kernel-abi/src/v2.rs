use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fmt;
use thiserror::Error;

use crate::KERNEL_ABI_V2_VERSION;

const MAX_TIMESTAMP_BYTES: usize = 128;
const MAX_ID_BYTES: usize = 512;
const MAX_TEXT_BYTES: usize = 16 * 1024;
const MAX_SCOPE_ITEMS: usize = 256;
const MAX_CORRELATION_REFS: usize = 64;
const MAX_RECEIPT_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_FACT_WIRE_BYTES: usize = 2 * 1024 * 1024;

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn validate_as(&self, field: &'static str) -> Result<(), V2ValidationError> {
                validate_bounded_text(field, &self.0, MAX_ID_BYTES)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                if value.trim().is_empty() {
                    return Err(serde::de::Error::custom(concat!(
                        stringify!($name),
                        " must be non-empty"
                    )));
                }
                if value.len() > MAX_ID_BYTES {
                    return Err(serde::de::Error::custom(concat!(
                        stringify!($name),
                        " exceeds the v2 identity byte limit"
                    )));
                }
                Ok(Self(value))
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

string_id!(OperationId);
string_id!(RunId);
string_id!(InvocationId);
string_id!(AttemptId);
string_id!(GrantId);
string_id!(GrantReservationId);
string_id!(FactId);
string_id!(InputId);
string_id!(CancelRequestId);
string_id!(EffectId);
string_id!(ResourceId);
string_id!(CleanupId);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ControlEpoch(pub u64);

impl ControlEpoch {
    pub fn new(value: u64) -> Result<Self, V2ValidationError> {
        let epoch = Self(value);
        epoch.validate()?;
        Ok(epoch)
    }

    pub const fn get(self) -> u64 {
        self.0
    }

    pub fn validate(self) -> Result<(), V2ValidationError> {
        if self.0 == 0 {
            return Err(V2ValidationError::ZeroValue {
                field: "controlEpoch",
            });
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for ControlEpoch {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = u64::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CorrelationRefV2 {
    pub kind: String,
    pub value: String,
}

impl CorrelationRefV2 {
    fn validate(&self) -> Result<(), V2ValidationError> {
        validate_bounded_text(
            "identity.correlationRefs[].kind",
            &self.kind,
            MAX_TEXT_BYTES,
        )?;
        validate_bounded_text(
            "identity.correlationRefs[].value",
            &self.value,
            MAX_TEXT_BYTES,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CausalIdentityV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<OperationId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_grant_id: Option<GrantId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_reservation_id: Option<GrantReservationId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invocation_id: Option<InvocationId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<AttemptId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<FactId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub correlation_refs: Vec<CorrelationRefV2>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key_hash: Option<String>,
}

impl CausalIdentityV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        self.run_id.validate_as("identity.runId")?;
        self.control_epoch.validate()?;
        validate_optional_id("identity.operationId", self.operation_id.as_ref())?;
        validate_optional_id(
            "identity.capabilityGrantId",
            self.capability_grant_id.as_ref(),
        )?;
        validate_optional_id(
            "identity.grantReservationId",
            self.grant_reservation_id.as_ref(),
        )?;
        validate_optional_id("identity.invocationId", self.invocation_id.as_ref())?;
        validate_optional_id("identity.attemptId", self.attempt_id.as_ref())?;
        validate_optional_id("identity.causationId", self.causation_id.as_ref())?;
        if self.attempt_id.is_some() && self.invocation_id.is_none() {
            return Err(V2ValidationError::MissingCausalIdentity {
                field: "identity.invocationId",
                required_by: "identity.attemptId",
            });
        }
        if self.grant_reservation_id.is_some() && self.capability_grant_id.is_none() {
            return Err(V2ValidationError::MissingCausalIdentity {
                field: "identity.capabilityGrantId",
                required_by: "identity.grantReservationId",
            });
        }
        if self.correlation_refs.len() > MAX_CORRELATION_REFS {
            return Err(V2ValidationError::TooManyValues {
                field: "identity.correlationRefs",
                maximum: MAX_CORRELATION_REFS,
            });
        }
        for correlation in &self.correlation_refs {
            correlation.validate()?;
        }
        validate_optional_bounded_text(
            "identity.idempotencyKeyHash",
            self.idempotency_key_hash.as_deref(),
            MAX_TEXT_BYTES,
        )?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlFactKindV2 {
    EpochAdvanced,
    CancellationRequested,
    AuthoritySuperseded,
    RunTerminated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlFactV2 {
    pub kind: ControlFactKindV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<InputId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancel_request_id: Option<CancelRequestId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_epoch: Option<ControlEpoch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_invocation_id: Option<InvocationId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GrantFactKindV2 {
    Requested,
    Issued,
    Reserved,
    Consumed,
    ReservationReleased,
    Revoked,
    Expired,
    Superseded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GrantUsePolicyV2 {
    UnboundedWithinEpoch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantFactV2 {
    pub kind: GrantFactKindV2,
    pub grant_id: GrantId,
    pub tool_id: String,
    pub request_digest: String,
    pub resource_scope: Vec<String>,
    pub effect_scope: Vec<String>,
    pub use_policy: GrantUsePolicyV2,
    pub observed_use_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InvocationFactKindV2 {
    Submitted,
    Admitted,
    Rejected,
    FailedBeforeAttempt,
    AttemptPrepared,
    ExecutionStarted,
    CancellationObserved,
    Completed,
    Failed,
    Indeterminate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvocationFactV2 {
    pub kind: InvocationFactKindV2,
    pub invocation_id: InvocationId,
    pub tool_id: String,
    pub request_digest: String,
    pub idempotency_key_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<AttemptId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EffectOutcomeV2 {
    None,
    Observed,
    ObservedAfterCancel,
    Indeterminate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectFactV2 {
    pub effect_id: EffectId,
    pub invocation_id: InvocationId,
    pub attempt_id: AttemptId,
    pub outcome: EffectOutcomeV2,
    pub affected_resources: Vec<ResourceId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceFactKindV2 {
    Resolved,
    Acquired,
    Revalidated,
    Released,
    ReleaseFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceFactV2 {
    pub kind: ResourceFactKindV2,
    pub resource_id: ResourceId,
    pub resource_kind: String,
    pub canonical_target: String,
    pub owner_run_id: RunId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupFactKindV2 {
    Scheduled,
    Attempted,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupFactV2 {
    pub kind: CleanupFactKindV2,
    pub cleanup_id: CleanupId,
    pub resource_id: ResourceId,
    pub attempt: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "domain",
    content = "fact",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum KernelFactPayloadV2 {
    Control(ControlFactV2),
    Grant(GrantFactV2),
    Invocation(InvocationFactV2),
    Effect(EffectFactV2),
    Resource(ResourceFactV2),
    Cleanup(CleanupFactV2),
}

impl KernelFactPayloadV2 {
    pub fn validate(&self, identity: &CausalIdentityV2) -> Result<(), V2ValidationError> {
        match self {
            Self::Control(fact) => fact.validate(identity),
            Self::Grant(fact) => fact.validate(identity),
            Self::Invocation(fact) => fact.validate(identity),
            Self::Effect(fact) => fact.validate(identity),
            Self::Resource(fact) => fact.validate(identity),
            Self::Cleanup(fact) => fact.validate(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelFactDraftV2 {
    pub abi_version: String,
    pub fact_id: FactId,
    pub occurred_at: String,
    pub identity: CausalIdentityV2,
    pub payload: KernelFactPayloadV2,
}

impl KernelFactDraftV2 {
    pub fn new(
        fact_id: FactId,
        occurred_at: impl Into<String>,
        identity: CausalIdentityV2,
        payload: KernelFactPayloadV2,
    ) -> Self {
        Self {
            abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
            fact_id,
            occurred_at: occurred_at.into(),
            identity,
            payload,
        }
    }

    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_version(&self.abi_version)?;
        self.fact_id.validate_as("factId")?;
        validate_bounded_text("occurredAt", &self.occurred_at, MAX_TIMESTAMP_BYTES)?;
        self.identity.validate()?;
        self.payload.validate(&self.identity)
    }

    pub fn with_sequences(
        self,
        ledger_sequence: u64,
        run_sequence: u64,
    ) -> Result<KernelFactEnvelopeV2, V2ValidationError> {
        self.validate()?;
        validate_sequence("ledgerSequence", ledger_sequence)?;
        validate_sequence("runSequence", run_sequence)?;
        Ok(KernelFactEnvelopeV2 {
            abi_version: self.abi_version,
            fact_id: self.fact_id,
            ledger_sequence,
            run_sequence,
            occurred_at: self.occurred_at,
            identity: self.identity,
            payload: self.payload,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelFactEnvelopeV2 {
    pub abi_version: String,
    pub fact_id: FactId,
    pub ledger_sequence: u64,
    pub run_sequence: u64,
    pub occurred_at: String,
    pub identity: CausalIdentityV2,
    pub payload: KernelFactPayloadV2,
}

impl KernelFactEnvelopeV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_version(&self.abi_version)?;
        self.fact_id.validate_as("factId")?;
        validate_sequence("ledgerSequence", self.ledger_sequence)?;
        validate_sequence("runSequence", self.run_sequence)?;
        validate_bounded_text("occurredAt", &self.occurred_at, MAX_TIMESTAMP_BYTES)?;
        self.identity.validate()?;
        self.payload.validate(&self.identity)
    }

    pub fn into_draft(self) -> KernelFactDraftV2 {
        KernelFactDraftV2 {
            abi_version: self.abi_version,
            fact_id: self.fact_id,
            occurred_at: self.occurred_at,
            identity: self.identity,
            payload: self.payload,
        }
    }
}

impl ControlFactV2 {
    fn validate(&self, identity: &CausalIdentityV2) -> Result<(), V2ValidationError> {
        validate_optional_id("fact.inputId", self.input_id.as_ref())?;
        validate_optional_id("fact.cancelRequestId", self.cancel_request_id.as_ref())?;
        if let Some(previous_epoch) = self.previous_epoch {
            previous_epoch.validate()?;
            if previous_epoch >= identity.control_epoch {
                return Err(V2ValidationError::InvalidRelation {
                    field: "fact.previousEpoch",
                    detail: "must be lower than identity.controlEpoch",
                });
            }
        }
        validate_optional_id(
            "fact.targetInvocationId",
            self.target_invocation_id.as_ref(),
        )?;
        validate_optional_bounded_text("fact.reason", self.reason.as_deref(), MAX_TEXT_BYTES)?;

        match self.kind {
            ControlFactKindV2::EpochAdvanced => {
                require_present(
                    self.input_id.as_ref(),
                    "fact.inputId",
                    "fact.kind=epochAdvanced",
                )?;
            }
            ControlFactKindV2::CancellationRequested => {
                require_present(
                    self.cancel_request_id.as_ref(),
                    "fact.cancelRequestId",
                    "fact.kind=cancellationRequested",
                )?;
                let target = require_present(
                    self.target_invocation_id.as_ref(),
                    "fact.targetInvocationId",
                    "fact.kind=cancellationRequested",
                )?;
                if identity.invocation_id.as_ref() != Some(target) {
                    return Err(V2ValidationError::IdentityMismatch {
                        field: "identity.invocationId",
                        payload_field: "fact.targetInvocationId",
                    });
                }
            }
            ControlFactKindV2::AuthoritySuperseded | ControlFactKindV2::RunTerminated => {}
        }
        Ok(())
    }
}

impl GrantFactV2 {
    fn validate(&self, identity: &CausalIdentityV2) -> Result<(), V2ValidationError> {
        self.grant_id.validate_as("fact.grantId")?;
        validate_bounded_text("fact.toolId", &self.tool_id, MAX_TEXT_BYTES)?;
        validate_bounded_text("fact.requestDigest", &self.request_digest, MAX_TEXT_BYTES)?;
        validate_non_empty_values("fact.resourceScope", &self.resource_scope, MAX_SCOPE_ITEMS)?;
        validate_non_empty_values("fact.effectScope", &self.effect_scope, MAX_SCOPE_ITEMS)?;
        validate_optional_bounded_text("fact.reason", self.reason.as_deref(), MAX_TEXT_BYTES)?;
        if identity.capability_grant_id.as_ref() != Some(&self.grant_id) {
            return Err(V2ValidationError::IdentityMismatch {
                field: "identity.capabilityGrantId",
                payload_field: "fact.grantId",
            });
        }

        match self.kind {
            GrantFactKindV2::Reserved
            | GrantFactKindV2::Consumed
            | GrantFactKindV2::ReservationReleased => {
                require_present(
                    identity.grant_reservation_id.as_ref(),
                    "identity.grantReservationId",
                    "grant reservation fact",
                )?;
                require_present(
                    identity.operation_id.as_ref(),
                    "identity.operationId",
                    "grant reservation fact",
                )?;
                require_present(
                    identity.invocation_id.as_ref(),
                    "identity.invocationId",
                    "grant reservation fact",
                )?;
                require_present(
                    identity.causation_id.as_ref(),
                    "identity.causationId",
                    "grant reservation fact",
                )?;
            }
            GrantFactKindV2::Requested | GrantFactKindV2::Issued => {
                require_present(
                    identity.operation_id.as_ref(),
                    "identity.operationId",
                    "grant request or issuance",
                )?;
            }
            GrantFactKindV2::Revoked | GrantFactKindV2::Expired | GrantFactKindV2::Superseded => {}
        }
        if matches!(self.kind, GrantFactKindV2::Consumed) {
            require_present(
                identity.attempt_id.as_ref(),
                "identity.attemptId",
                "fact.kind=consumed",
            )?;
        }
        Ok(())
    }
}

impl InvocationFactV2 {
    fn validate(&self, identity: &CausalIdentityV2) -> Result<(), V2ValidationError> {
        self.invocation_id.validate_as("fact.invocationId")?;
        validate_bounded_text("fact.toolId", &self.tool_id, MAX_TEXT_BYTES)?;
        validate_bounded_text("fact.requestDigest", &self.request_digest, MAX_TEXT_BYTES)?;
        validate_bounded_text(
            "fact.idempotencyKeyHash",
            &self.idempotency_key_hash,
            MAX_TEXT_BYTES,
        )?;
        validate_optional_id("fact.attemptId", self.attempt_id.as_ref())?;
        validate_optional_bounded_text(
            "fact.errorCode",
            self.error_code.as_deref(),
            MAX_TEXT_BYTES,
        )?;
        require_present(
            identity.operation_id.as_ref(),
            "identity.operationId",
            "invocation fact",
        )?;
        if identity.invocation_id.as_ref() != Some(&self.invocation_id) {
            return Err(V2ValidationError::IdentityMismatch {
                field: "identity.invocationId",
                payload_field: "fact.invocationId",
            });
        }
        if let Some(attempt_id) = self.attempt_id.as_ref() {
            if identity.attempt_id.as_ref() != Some(attempt_id) {
                return Err(V2ValidationError::IdentityMismatch {
                    field: "identity.attemptId",
                    payload_field: "fact.attemptId",
                });
            }
        }
        if identity.idempotency_key_hash.as_deref() != Some(&self.idempotency_key_hash) {
            return Err(V2ValidationError::IdentityMismatch {
                field: "identity.idempotencyKeyHash",
                payload_field: "fact.idempotencyKeyHash",
            });
        }

        let requires_reservation = matches!(
            self.kind,
            InvocationFactKindV2::Admitted
                | InvocationFactKindV2::FailedBeforeAttempt
                | InvocationFactKindV2::AttemptPrepared
                | InvocationFactKindV2::ExecutionStarted
                | InvocationFactKindV2::CancellationObserved
                | InvocationFactKindV2::Completed
                | InvocationFactKindV2::Failed
                | InvocationFactKindV2::Indeterminate
        );
        if requires_reservation {
            require_present(
                identity.capability_grant_id.as_ref(),
                "identity.capabilityGrantId",
                "admitted or later invocation fact",
            )?;
            require_present(
                identity.grant_reservation_id.as_ref(),
                "identity.grantReservationId",
                "admitted or later invocation fact",
            )?;
        } else if matches!(self.kind, InvocationFactKindV2::Rejected)
            && identity.grant_reservation_id.is_some()
        {
            return Err(V2ValidationError::InvalidRelation {
                field: "identity.grantReservationId",
                detail: "must be absent for a rejected invocation",
            });
        }

        let requires_attempt = matches!(
            self.kind,
            InvocationFactKindV2::AttemptPrepared
                | InvocationFactKindV2::ExecutionStarted
                | InvocationFactKindV2::CancellationObserved
                | InvocationFactKindV2::Completed
                | InvocationFactKindV2::Failed
                | InvocationFactKindV2::Indeterminate
        );
        if requires_attempt {
            require_present(
                self.attempt_id.as_ref(),
                "fact.attemptId",
                "attempt or terminal invocation fact",
            )?;
            require_present(
                identity.attempt_id.as_ref(),
                "identity.attemptId",
                "attempt or terminal invocation fact",
            )?;
        } else if self.attempt_id.is_some() || identity.attempt_id.is_some() {
            return Err(V2ValidationError::InvalidRelation {
                field: "fact.attemptId",
                detail: "must be absent before an attempt is prepared",
            });
        }
        if !matches!(self.kind, InvocationFactKindV2::Submitted) {
            require_present(
                identity.causation_id.as_ref(),
                "identity.causationId",
                "admission or later invocation fact",
            )?;
        }
        if matches!(
            self.kind,
            InvocationFactKindV2::Rejected
                | InvocationFactKindV2::FailedBeforeAttempt
                | InvocationFactKindV2::Failed
                | InvocationFactKindV2::Indeterminate
        ) {
            require_present(
                self.error_code.as_ref(),
                "fact.errorCode",
                "failed, rejected, or indeterminate invocation fact",
            )?;
        }
        Ok(())
    }
}

impl EffectFactV2 {
    fn validate(&self, identity: &CausalIdentityV2) -> Result<(), V2ValidationError> {
        self.effect_id.validate_as("fact.effectId")?;
        self.invocation_id.validate_as("fact.invocationId")?;
        self.attempt_id.validate_as("fact.attemptId")?;
        require_present(
            identity.operation_id.as_ref(),
            "identity.operationId",
            "effect fact",
        )?;
        require_present(
            identity.capability_grant_id.as_ref(),
            "identity.capabilityGrantId",
            "effect fact",
        )?;
        require_present(
            identity.grant_reservation_id.as_ref(),
            "identity.grantReservationId",
            "effect fact",
        )?;
        if identity.invocation_id.as_ref() != Some(&self.invocation_id) {
            return Err(V2ValidationError::IdentityMismatch {
                field: "identity.invocationId",
                payload_field: "fact.invocationId",
            });
        }
        if identity.attempt_id.as_ref() != Some(&self.attempt_id) {
            return Err(V2ValidationError::IdentityMismatch {
                field: "identity.attemptId",
                payload_field: "fact.attemptId",
            });
        }
        require_present(
            identity.causation_id.as_ref(),
            "identity.causationId",
            "effect fact",
        )?;
        if self.affected_resources.len() > MAX_SCOPE_ITEMS {
            return Err(V2ValidationError::TooManyValues {
                field: "fact.affectedResources",
                maximum: MAX_SCOPE_ITEMS,
            });
        }
        for resource_id in &self.affected_resources {
            resource_id.validate_as("fact.affectedResources[]")?;
        }
        match self.outcome {
            EffectOutcomeV2::None => {
                if self.receipt.is_some() || !self.affected_resources.is_empty() {
                    return Err(V2ValidationError::InvalidRelation {
                        field: "fact.outcome",
                        detail: "none cannot carry a receipt or affected resources",
                    });
                }
            }
            EffectOutcomeV2::Observed
            | EffectOutcomeV2::ObservedAfterCancel
            | EffectOutcomeV2::Indeterminate => {
                let receipt = require_present(
                    self.receipt.as_ref(),
                    "fact.receipt",
                    "an observed or indeterminate effect",
                )?;
                let receipt_size = serde_json::to_vec(receipt)
                    .map_err(|_| V2ValidationError::InvalidRelation {
                        field: "fact.receipt",
                        detail: "must be serializable JSON",
                    })?
                    .len();
                if receipt_size > MAX_RECEIPT_BYTES {
                    return Err(V2ValidationError::FieldTooLarge {
                        field: "fact.receipt",
                        maximum_bytes: MAX_RECEIPT_BYTES,
                    });
                }
            }
        }
        Ok(())
    }
}

impl ResourceFactV2 {
    fn validate(&self, identity: &CausalIdentityV2) -> Result<(), V2ValidationError> {
        self.resource_id.validate_as("fact.resourceId")?;
        self.owner_run_id.validate_as("fact.ownerRunId")?;
        validate_bounded_text("fact.resourceKind", &self.resource_kind, MAX_TEXT_BYTES)?;
        validate_bounded_text(
            "fact.canonicalTarget",
            &self.canonical_target,
            MAX_TEXT_BYTES,
        )?;
        validate_optional_bounded_text(
            "fact.contentDigest",
            self.content_digest.as_deref(),
            MAX_TEXT_BYTES,
        )?;
        validate_optional_bounded_text("fact.reason", self.reason.as_deref(), MAX_TEXT_BYTES)?;
        if identity.run_id != self.owner_run_id {
            return Err(V2ValidationError::IdentityMismatch {
                field: "identity.runId",
                payload_field: "fact.ownerRunId",
            });
        }
        Ok(())
    }
}

impl CleanupFactV2 {
    fn validate(&self) -> Result<(), V2ValidationError> {
        self.cleanup_id.validate_as("fact.cleanupId")?;
        self.resource_id.validate_as("fact.resourceId")?;
        if self.attempt == 0 {
            return Err(V2ValidationError::ZeroValue {
                field: "fact.attempt",
            });
        }
        validate_optional_bounded_text("fact.error", self.error.as_deref(), MAX_TEXT_BYTES)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum KernelErrorCodeV2 {
    UnsupportedAbiVersion,
    InvalidRequest,
    RunBusy,
    CapacityExceeded,
    StaleControlEpoch,
    GrantRequired,
    GrantScopeMismatch,
    DuplicateOperationDigestMismatch,
    InvocationNotOwnedByRun,
    FactStoreUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum V2WireDecodeError {
    #[error("v2 wire payload exceeds the maximum of {maximum_bytes} bytes")]
    PayloadTooLarge { maximum_bytes: usize },
    #[error("invalid JSON: {message}")]
    InvalidJson { message: String },
    #[error("unsupported ABI version `{actual}`; expected `{expected}`")]
    UnsupportedAbiVersion {
        actual: String,
        expected: &'static str,
    },
    #[error("invalid v2 payload: {message}")]
    InvalidPayload { message: String },
    #[error(transparent)]
    Validation(#[from] V2ValidationError),
}

impl V2WireDecodeError {
    pub const fn code(&self) -> KernelErrorCodeV2 {
        match self {
            Self::UnsupportedAbiVersion { .. }
            | Self::Validation(V2ValidationError::UnsupportedAbiVersion { .. }) => {
                KernelErrorCodeV2::UnsupportedAbiVersion
            }
            Self::PayloadTooLarge { .. }
            | Self::InvalidJson { .. }
            | Self::InvalidPayload { .. }
            | Self::Validation(_) => KernelErrorCodeV2::InvalidRequest,
        }
    }
}

/// Decodes the version header before the typed fact. This guarantees that a
/// legacy payload receives the stable ABI error even when the rest of its
/// shape is not valid v2.
pub fn decode_kernel_fact_v2(input: &[u8]) -> Result<KernelFactEnvelopeV2, V2WireDecodeError> {
    if input.len() > MAX_FACT_WIRE_BYTES {
        return Err(V2WireDecodeError::PayloadTooLarge {
            maximum_bytes: MAX_FACT_WIRE_BYTES,
        });
    }
    let value = decode_strict_json(input)?;
    validate_wire_abi_header(&value)?;
    let fact: KernelFactEnvelopeV2 =
        serde_json::from_value(value).map_err(|error| V2WireDecodeError::InvalidPayload {
            message: error.to_string(),
        })?;
    fact.validate()?;
    Ok(fact)
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum V2ValidationError {
    #[error("unsupported ABI version `{actual}`; expected `{expected}`")]
    UnsupportedAbiVersion {
        actual: String,
        expected: &'static str,
    },
    #[error("`{field}` must not be empty")]
    EmptyField { field: &'static str },
    #[error("`{field}` must be greater than zero")]
    ZeroValue { field: &'static str },
    #[error("`{field}` exceeds the maximum size of {maximum_bytes} bytes")]
    FieldTooLarge {
        field: &'static str,
        maximum_bytes: usize,
    },
    #[error("`{field}` exceeds the maximum of {maximum} values")]
    TooManyValues { field: &'static str, maximum: usize },
    #[error("`{field}` is required when `{required_by}` is present")]
    MissingCausalIdentity {
        field: &'static str,
        required_by: &'static str,
    },
    #[error("`{field}` does not match `{payload_field}`")]
    IdentityMismatch {
        field: &'static str,
        payload_field: &'static str,
    },
    #[error("`{field}` {detail}")]
    InvalidRelation {
        field: &'static str,
        detail: &'static str,
    },
}

pub(crate) fn validate_wire_abi_header(value: &Value) -> Result<(), V2WireDecodeError> {
    let actual = match value
        .as_object()
        .and_then(|object| object.get("abiVersion"))
    {
        Some(Value::String(version)) => version.as_str(),
        Some(_) => "<non-string>",
        None => "<missing>",
    };
    if actual != KERNEL_ABI_V2_VERSION {
        return Err(V2WireDecodeError::UnsupportedAbiVersion {
            actual: actual.to_owned(),
            expected: KERNEL_ABI_V2_VERSION,
        });
    }
    Ok(())
}

pub(crate) fn decode_strict_json(input: &[u8]) -> Result<Value, V2WireDecodeError> {
    serde_json::from_slice::<StrictJsonValue>(input)
        .map(|value| value.0)
        .map_err(|error| V2WireDecodeError::InvalidJson {
            message: error.to_string(),
        })
}

struct StrictJsonValue(Value);

impl<'de> Deserialize<'de> for StrictJsonValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictJsonVisitor)
    }
}

struct StrictJsonVisitor;

impl<'de> Visitor<'de> for StrictJsonVisitor {
    type Value = StrictJsonValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value without duplicate object keys")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Number(value.into())))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Number(value.into())))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .map(StrictJsonValue)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.visit_string(value.to_owned())
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::String(value)))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Null))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Null))
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        StrictJsonValue::deserialize(deserializer)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(MAX_SCOPE_ITEMS));
        while let Some(value) = sequence.next_element::<StrictJsonValue>()? {
            values.push(value.0);
        }
        Ok(StrictJsonValue(Value::Array(values)))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut keys = BTreeSet::new();
        let mut values = serde_json::Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                return Err(serde::de::Error::custom(format!(
                    "duplicate JSON object key `{key}`"
                )));
            }
            let value = map.next_value::<StrictJsonValue>()?;
            values.insert(key, value.0);
        }
        Ok(StrictJsonValue(Value::Object(values)))
    }
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

fn validate_sequence(field: &'static str, value: u64) -> Result<(), V2ValidationError> {
    if value == 0 {
        return Err(V2ValidationError::ZeroValue { field });
    }
    Ok(())
}

fn validate_non_empty(field: &'static str, value: &str) -> Result<(), V2ValidationError> {
    if value.trim().is_empty() {
        return Err(V2ValidationError::EmptyField { field });
    }
    Ok(())
}

fn validate_bounded_text(
    field: &'static str,
    value: &str,
    maximum_bytes: usize,
) -> Result<(), V2ValidationError> {
    validate_non_empty(field, value)?;
    if value.len() > maximum_bytes {
        return Err(V2ValidationError::FieldTooLarge {
            field,
            maximum_bytes,
        });
    }
    Ok(())
}

fn validate_optional_bounded_text(
    field: &'static str,
    value: Option<&str>,
    maximum_bytes: usize,
) -> Result<(), V2ValidationError> {
    if let Some(value) = value {
        validate_bounded_text(field, value, maximum_bytes)?;
    }
    Ok(())
}

fn validate_non_empty_values(
    field: &'static str,
    values: &[String],
    maximum: usize,
) -> Result<(), V2ValidationError> {
    if values.is_empty() {
        return Err(V2ValidationError::EmptyField { field });
    }
    if values.len() > maximum {
        return Err(V2ValidationError::TooManyValues { field, maximum });
    }
    for value in values {
        validate_bounded_text(field, value, MAX_TEXT_BYTES)?;
    }
    Ok(())
}

fn require_present<'a, T>(
    value: Option<&'a T>,
    field: &'static str,
    required_by: &'static str,
) -> Result<&'a T, V2ValidationError> {
    value.ok_or(V2ValidationError::MissingCausalIdentity { field, required_by })
}

fn validate_optional_id<T>(field: &'static str, value: Option<&T>) -> Result<(), V2ValidationError>
where
    T: AsRef<str>,
{
    if let Some(value) = value {
        validate_bounded_text(field, value.as_ref(), MAX_ID_BYTES)?;
    }
    Ok(())
}

macro_rules! impl_as_ref {
    ($($name:ident),+ $(,)?) => {
        $(
            impl AsRef<str> for $name {
                fn as_ref(&self) -> &str {
                    self.as_str()
                }
            }
        )+
    };
}

impl_as_ref!(
    OperationId,
    RunId,
    InvocationId,
    AttemptId,
    GrantId,
    GrantReservationId,
    FactId,
    InputId,
    CancelRequestId,
    EffectId,
    ResourceId,
    CleanupId,
);
