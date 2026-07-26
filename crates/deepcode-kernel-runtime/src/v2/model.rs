use deepcode_kernel_abi::v2::{
    AttemptId, ControlEpoch, GrantId, GrantReservationId, InvocationId, KernelErrorCodeV2,
    OperationId, RunId,
};
use serde_json::Value;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityScope {
    pub tool_id: String,
    pub resource_scope: Vec<String>,
    pub effect_scope: Vec<String>,
}

impl CapabilityScope {
    pub fn new(
        tool_id: impl Into<String>,
        resource_scope: Vec<String>,
        effect_scope: Vec<String>,
    ) -> AuthorityResult<Self> {
        let scope = Self {
            tool_id: tool_id.into(),
            resource_scope: normalize_scope("resourceScope", resource_scope)?,
            effect_scope: normalize_scope("effectScope", effect_scope)?,
        };
        require_non_empty("toolId", &scope.tool_id)?;
        Ok(scope)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantIssueRequest {
    pub run_id: RunId,
    pub operation_id: OperationId,
    pub control_epoch: ControlEpoch,
    pub scope: CapabilityScope,
    pub request_digest: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantLifecycle {
    Issued,
    Revoked,
    Expired,
    Superseded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantReservationLifecycle {
    Reserved,
    Consumed,
    Released,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantSnapshot {
    pub grant_id: GrantId,
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub scope: CapabilityScope,
    pub request_digest: String,
    pub lifecycle: GrantLifecycle,
    pub observed_use_count: u64,
    pub reservations: Vec<(GrantReservationId, GrantReservationLifecycle)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvocationSubmitRequest {
    pub run_id: RunId,
    pub operation_id: OperationId,
    pub control_epoch: ControlEpoch,
    pub grant_id: GrantId,
    pub scope: CapabilityScope,
    pub request_digest: String,
    pub idempotency_key_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvocationLifecycle {
    Admitted,
    AttemptPrepared,
    EffectStarted,
    Completed,
    Failed,
    Indeterminate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvocationAdmission {
    pub invocation_id: InvocationId,
    pub admitted: bool,
    pub rejection_code: Option<KernelErrorCodeV2>,
    pub retryable: bool,
    pub replayed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvocationSnapshot {
    pub invocation_id: InvocationId,
    pub run_id: RunId,
    pub operation_id: OperationId,
    pub control_epoch: ControlEpoch,
    pub grant_id: GrantId,
    pub reservation_id: GrantReservationId,
    pub attempt_id: Option<AttemptId>,
    pub lifecycle: InvocationLifecycle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalInvocationOutcome {
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EffectCompletion {
    pub receipt: Value,
    pub affected_resource_ids: Vec<deepcode_kernel_abi::v2::ResourceId>,
    pub terminal_outcome: TerminalInvocationOutcome,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlAdvance {
    pub previous_epoch: Option<ControlEpoch>,
    pub control_epoch: ControlEpoch,
    pub superseded_grant_ids: Vec<GrantId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorityError {
    InvalidRequest {
        field: &'static str,
        reason: String,
    },
    DuplicateOperationDigestMismatch {
        run_id: RunId,
        operation_id: OperationId,
    },
    GrantRequired {
        grant_id: GrantId,
    },
    GrantScopeMismatch {
        grant_id: GrantId,
    },
    StaleControlEpoch {
        expected: Option<ControlEpoch>,
        actual: ControlEpoch,
    },
    InvocationNotFound {
        invocation_id: InvocationId,
    },
    InvalidInvocationState {
        invocation_id: InvocationId,
        expected: &'static str,
        actual: InvocationLifecycle,
    },
    FactStoreUnavailable {
        operation: &'static str,
        message: String,
    },
}

pub type AuthorityResult<T> = Result<T, AuthorityError>;

impl AuthorityError {
    pub const fn code(&self) -> KernelErrorCodeV2 {
        match self {
            Self::DuplicateOperationDigestMismatch { .. } => {
                KernelErrorCodeV2::DuplicateOperationDigestMismatch
            }
            Self::GrantRequired { .. } => KernelErrorCodeV2::GrantRequired,
            Self::GrantScopeMismatch { .. } => KernelErrorCodeV2::GrantScopeMismatch,
            Self::StaleControlEpoch { .. } => KernelErrorCodeV2::StaleControlEpoch,
            Self::FactStoreUnavailable { .. } => KernelErrorCodeV2::FactStoreUnavailable,
            Self::InvalidRequest { .. }
            | Self::InvocationNotFound { .. }
            | Self::InvalidInvocationState { .. } => KernelErrorCodeV2::InvalidRequest,
        }
    }
}

impl fmt::Display for AuthorityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest { field, reason } => {
                write!(formatter, "invalid {field}: {reason}")
            }
            Self::DuplicateOperationDigestMismatch {
                run_id,
                operation_id,
            } => write!(
                formatter,
                "operation {operation_id} in run {run_id} was already bound to another digest"
            ),
            Self::GrantRequired { grant_id } => {
                write!(formatter, "active capability grant {grant_id} is required")
            }
            Self::GrantScopeMismatch { grant_id } => {
                write!(
                    formatter,
                    "capability grant {grant_id} does not match the request scope"
                )
            }
            Self::StaleControlEpoch { expected, actual } => write!(
                formatter,
                "control epoch {actual:?} is stale; current epoch is {expected:?}"
            ),
            Self::InvocationNotFound { invocation_id } => {
                write!(formatter, "invocation {invocation_id} was not found")
            }
            Self::InvalidInvocationState {
                invocation_id,
                expected,
                actual,
            } => write!(
                formatter,
                "invocation {invocation_id} is {actual:?}; expected {expected}"
            ),
            Self::FactStoreUnavailable { operation, message } => {
                write!(
                    formatter,
                    "fact store unavailable during {operation}: {message}"
                )
            }
        }
    }
}

impl std::error::Error for AuthorityError {}

pub(crate) fn require_non_empty(field: &'static str, value: &str) -> AuthorityResult<()> {
    if value.trim().is_empty() {
        return Err(AuthorityError::InvalidRequest {
            field,
            reason: "must not be empty".to_string(),
        });
    }
    Ok(())
}

fn normalize_scope(field: &'static str, values: Vec<String>) -> AuthorityResult<Vec<String>> {
    if values.is_empty() {
        return Err(AuthorityError::InvalidRequest {
            field,
            reason: "must contain at least one exact value".to_string(),
        });
    }
    let mut normalized = Vec::with_capacity(values.len());
    for value in values {
        require_non_empty(field, &value)?;
        if !normalized.contains(&value) {
            normalized.push(value);
        }
    }
    normalized.sort();
    Ok(normalized)
}
