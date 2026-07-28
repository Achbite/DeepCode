use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};

use crate::tool_protocol_v2::{
    CapabilityAuthorizationDigestV2, CapabilityLeaseIdV2, CapabilityLeaseRefV2,
    CapabilityScopeDigestV2, CapabilityScopePreviewIdV2, PlanActionIdV2, PlanRevisionV2,
    ToolContextRefV2, TrustLeaseDigestV2, TrustPolicyIdV2,
};
use crate::v2::{
    decode_strict_json, invalid_value, typed_digest, validate_wire_abi_header,
    CommandRequestDigestV2, CommandRequestId, ControlEpoch, FactId, InputId, RunId,
    UserDecisionRefV2, V2ValidationError, V2WireDecodeError,
};
use crate::v2_command::{CommandHandlingV2, KernelWireErrorV2};
use crate::KERNEL_ABI_V2_VERSION;

pub const MAX_USER_DECISION_BYTES_V2: usize = 256 * 1024;

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct DecisionCapabilityV2(String);

impl DecisionCapabilityV2 {
    pub fn new(value: impl Into<String>) -> Result<Self, V2ValidationError> {
        let value = value.into();
        validate_secret_token("decisionCapability", &value)?;
        Ok(Self(value))
    }

    pub fn expose_to_transport(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for DecisionCapabilityV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DecisionCapabilityV2([REDACTED])")
    }
}

impl<'de> Deserialize<'de> for DecisionCapabilityV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserDecisionEnvelopeV2 {
    pub abi_version: String,
    pub request_id: CommandRequestId,
    pub run_id: RunId,
    pub decision_capability: DecisionCapabilityV2,
    pub expected_control_epoch: ControlEpoch,
    pub decision: UserDecisionV2,
}

impl UserDecisionEnvelopeV2 {
    pub fn new(
        request_id: CommandRequestId,
        run_id: RunId,
        decision_capability: DecisionCapabilityV2,
        expected_control_epoch: ControlEpoch,
        decision: UserDecisionV2,
    ) -> Self {
        Self {
            abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
            request_id,
            run_id,
            decision_capability,
            expected_control_epoch,
            decision,
        }
    }

    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if self.abi_version != KERNEL_ABI_V2_VERSION {
            return Err(V2ValidationError::UnsupportedAbiVersion {
                actual: self.abi_version.clone(),
            });
        }
        self.decision.validate()
    }
}

pub fn decode_user_decision_v2(input: &[u8]) -> Result<UserDecisionEnvelopeV2, V2WireDecodeError> {
    if input.len() > MAX_USER_DECISION_BYTES_V2 {
        return Err(V2WireDecodeError::PayloadTooLarge {
            maximum: MAX_USER_DECISION_BYTES_V2,
        });
    }
    let value = decode_strict_json(input)?;
    validate_wire_abi_header(&value)?;
    match value.as_object().and_then(|object| object.get("requestId")) {
        Some(serde_json::Value::String(request_id)) => {
            CommandRequestId::new(request_id.clone())
                .map_err(|_| V2WireDecodeError::InvalidPayload("invalid requestId".to_owned()))?;
        }
        Some(_) => {
            return Err(V2WireDecodeError::InvalidPayload(
                "invalid requestId".to_owned(),
            ))
        }
        None => {
            return Err(V2WireDecodeError::InvalidPayload(
                "missing requestId".to_owned(),
            ))
        }
    }
    let decision = serde_json::from_value::<UserDecisionEnvelopeV2>(value)
        .map_err(|error| V2WireDecodeError::InvalidPayload(error.to_string()))?;
    decision.validate()?;
    Ok(decision)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum UserDecisionV2 {
    CapabilityAllow(CapabilityDecisionBindingV2),
    CapabilityDeny {
        binding: CapabilityDecisionBindingV2,
        guidance: String,
    },
    ScopeExpansionAllow(CapabilityDecisionBindingV2),
    ScopeExpansionDeny {
        binding: CapabilityDecisionBindingV2,
        guidance: String,
    },
    TrustGrant(TrustGrantDecisionV2),
    Revoke(UserDecisionRevokeV2),
}

/// Digests only the durable decision subject. The short-lived decision
/// capability and public request identity are deliberately excluded.
pub fn user_decision_request_digest_v2(
    run_id: &RunId,
    expected_control_epoch: ControlEpoch,
    decision: &UserDecisionV2,
) -> Result<CommandRequestDigestV2, V2ValidationError> {
    Ok(CommandRequestDigestV2::from_raw_digest(typed_digest(
        "deepcode.kernel.abi.v2/user-decision-request",
        &serde_json::json!({
            "abiVersion": KERNEL_ABI_V2_VERSION,
            "runId": run_id,
            "expectedControlEpoch": expected_control_epoch,
            "decision": decision,
        }),
    )?))
}

impl UserDecisionV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        match self {
            Self::CapabilityAllow(binding) | Self::ScopeExpansionAllow(binding) => {
                binding.validate()
            }
            Self::CapabilityDeny { binding, guidance }
            | Self::ScopeExpansionDeny { binding, guidance } => {
                binding.validate()?;
                validate_guidance(guidance)
            }
            Self::TrustGrant(decision) => decision.validate(),
            Self::Revoke(decision) => decision.validate(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityDecisionBindingV2 {
    pub input_id: InputId,
    pub decision_ref: UserDecisionRefV2,
    pub scope_preview_id: CapabilityScopePreviewIdV2,
    pub expected_authorization_digest: CapabilityAuthorizationDigestV2,
    pub plan_revision: PlanRevisionV2,
    pub plan_action_id: PlanActionIdV2,
    pub scope_digest: CapabilityScopeDigestV2,
    pub tool_context_ref: ToolContextRefV2,
}

impl CapabilityDecisionBindingV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustGrantDecisionV2 {
    pub binding: CapabilityDecisionBindingV2,
    pub trust_policy_id: TrustPolicyIdV2,
    pub expires_at: Option<crate::v2::RecordedAtV2>,
}

impl TrustGrantDecisionV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        self.binding.validate()
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
pub enum UserDecisionRevokeTargetV2 {
    CapabilityLease { lease_id: CapabilityLeaseIdV2 },
    TrustPolicy { trust_policy_id: TrustPolicyIdV2 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserDecisionRevokeV2 {
    pub input_id: InputId,
    pub decision_ref: UserDecisionRefV2,
    pub target: UserDecisionRevokeTargetV2,
    pub reason: String,
}

impl UserDecisionRevokeV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_guidance(&self.reason)
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
pub enum UserDecisionResponseEnvelopeV2 {
    Correlated {
        server_abi_version: String,
        request_id: CommandRequestId,
        handling: CommandHandlingV2,
        reply: UserDecisionReplyV2,
    },
    UncorrelatedWireFailure {
        server_abi_version: String,
        error: KernelWireErrorV2,
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
pub enum UserDecisionReplyV2 {
    CapabilityIssued {
        lease: CapabilityLeaseRefV2,
        fact_id: FactId,
        ledger_sequence: u64,
    },
    CapabilityDenied {
        fact_id: FactId,
        ledger_sequence: u64,
    },
    ScopeExpansionRecorded {
        lease: CapabilityLeaseRefV2,
        fact_id: FactId,
        ledger_sequence: u64,
    },
    ScopeExpansionDenied {
        fact_id: FactId,
        ledger_sequence: u64,
    },
    TrustGranted {
        trust_policy_id: TrustPolicyIdV2,
        trust_lease_digest: TrustLeaseDigestV2,
        fact_id: FactId,
        ledger_sequence: u64,
    },
    Revoked {
        fact_id: FactId,
        ledger_sequence: u64,
    },
    Stale {
        submitted: ControlEpoch,
        current: ControlEpoch,
    },
    Error(UserDecisionErrorV2),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserDecisionErrorV2 {
    DecisionCapabilityRequired,
    DecisionCapabilityInvalid,
    ScopePreviewNotFound,
    ScopePreviewStale,
    AuthorizationDigestMismatch,
    PlanBindingMismatch,
    ToolContextStale,
    CapabilityLeaseNotFound,
    TrustPolicyNotFound,
    DuplicateRequestDigestMismatch,
    FactStoreUnavailable,
}

fn validate_guidance(value: &str) -> Result<(), V2ValidationError> {
    if value.is_empty() || value.len() > 16 * 1024 || value.chars().any(char::is_control) {
        return Err(invalid_value(
            "guidance",
            "must contain 1..=16384 bytes without control characters",
        ));
    }
    Ok(())
}

fn validate_secret_token(field: &'static str, value: &str) -> Result<(), V2ValidationError> {
    if value.len() < 16
        || value.len() > 2048
        || !value
            .as_bytes()
            .iter()
            .all(|byte| (0x21..=0x7e).contains(byte))
    {
        return Err(invalid_value(
            field,
            "must contain 16..=2048 printable non-whitespace ASCII bytes",
        ));
    }
    Ok(())
}
