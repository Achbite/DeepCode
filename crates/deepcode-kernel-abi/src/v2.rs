use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;
use thiserror::Error;

use crate::tool_protocol_v2::{
    CanonicalArgumentsDigestV2, CapabilityAuthorizationDigestV2, CapabilityLeaseIdV2,
    CapabilityLeaseRefV2, CapabilityLeaseVersionV2, CapabilityScopeDigestV2,
    CapabilityScopePreviewIdV2, PlanActionIdV2, PlanRevisionV2, ToolAvailabilityV2,
    ToolContextRefV2, ToolContractDigestV2, ToolIdV2, TrustLeaseDigestV2, TrustPolicyIdV2,
};
use crate::KERNEL_ABI_V2_VERSION;

pub const FACT_STORE_SCHEMA_CONTRACT_V2: &str = "deepcode.kernel.fact-store.v2.sqlite.5";
pub const MAX_ID_BYTES_V2: usize = 512;
pub const MAX_TEXT_BYTES_V2: usize = 16 * 1024;
pub const MAX_CORRELATION_REFS_V2: usize = 256;
pub const MAX_FACT_WIRE_BYTES_V2: usize = 5 * 1024 * 1024;
pub const MAX_FACT_PAGE_BYTES_V2: usize = 8 * 1024 * 1024;
pub const MAX_PAGE_ITEMS_V2: usize = 1_000;
const MAX_CANONICAL_DEPTH: usize = 32;

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, V2ValidationError> {
                let value = value.into();
                validate_identity(stringify!($name), &value)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(serde::de::Error::custom)
            }
        }

        impl TryFrom<String> for $name {
            type Error = V2ValidationError;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

string_id!(RunId);
string_id!(OperationId);
string_id!(InputId);
string_id!(CommandRequestId);
string_id!(InvocationId);
string_id!(AttemptId);
string_id!(EffectId);
string_id!(ResourceId);
string_id!(CleanupId);
string_id!(CancelRequestId);
string_id!(FactId);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ControlEpoch(u64);

impl ControlEpoch {
    pub fn new(value: u64) -> Result<Self, V2ValidationError> {
        if value == 0 {
            return Err(zero_value("controlEpoch"));
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for ControlEpoch {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(u64::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct UserDecisionRefV2(String);

impl UserDecisionRefV2 {
    pub fn new(value: impl Into<String>) -> Result<Self, V2ValidationError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_ID_BYTES_V2
            || !value
                .as_bytes()
                .iter()
                .all(|byte| (0x21..=0x7e).contains(byte))
        {
            return Err(invalid_value(
                "decisionRef",
                "must be 1..=512 printable non-whitespace ASCII bytes",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for UserDecisionRefV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct RecordedAtV2(String);

impl RecordedAtV2 {
    pub fn new(value: impl Into<String>) -> Result<Self, V2ValidationError> {
        let value = value.into();
        validate_recorded_at(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for RecordedAtV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

trait DigestFromRaw {
    fn from_raw_digest(bytes: [u8; 32]) -> Self;
}

macro_rules! digest_type {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, V2ValidationError> {
                let value = value.into();
                validate_digest(stringify!($name), &value)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub(crate) fn from_raw_digest(bytes: [u8; 32]) -> Self {
                Self(format!("sha256:{}", encode_lower_hex(&bytes)))
            }
        }

        impl DigestFromRaw for $name {
            fn from_raw_digest(bytes: [u8; 32]) -> Self {
                Self::from_raw_digest(bytes)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                Self::parse(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }
    };
}

digest_type!(CommandRequestDigestV2);
digest_type!(IdempotencyKeyHashV2);
digest_type!(WorkspaceBindingDigestV2);
digest_type!(PolicyEvaluationDigestV2);
digest_type!(SettingsCeilingDigestV2);
digest_type!(TargetRevalidationDigestV2);
digest_type!(TargetRevalidationSetDigestV2);
digest_type!(ExecutorEvidenceDigestV2);
digest_type!(SnapshotCursorDigestV2);
digest_type!(ContentDigestV2);
digest_type!(CollectionDigestV2);
digest_type!(ResourceStateDigestV2);
digest_type!(QueryDigestV2);
digest_type!(NetworkTargetObservationDigestV2);
digest_type!(NetworkResponseDigestV2);
digest_type!(ToolOutputDigestV2);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CorrelationRefV2 {
    PlanAction { value: String },
}

impl CorrelationRefV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        match self {
            Self::PlanAction { value } => validate_identity("correlationRef.value", value),
        }
    }

    pub fn sort_key(&self) -> (&'static str, &str) {
        match self {
            Self::PlanAction { value } => ("planAction", value),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CorrelationSetV2 {
    pub refs: Vec<CorrelationRefV2>,
}

impl CorrelationSetV2 {
    pub fn materialize(mut refs: Vec<CorrelationRefV2>) -> Result<Self, V2ValidationError> {
        if refs.len() > MAX_CORRELATION_REFS_V2 {
            return Err(too_many_values("correlationRefs", MAX_CORRELATION_REFS_V2));
        }
        for value in &refs {
            value.validate()?;
        }
        refs.sort_by(|left, right| left.sort_key().cmp(&right.sort_key()));
        refs.dedup_by(|left, right| left.sort_key() == right.sort_key());
        Ok(Self { refs })
    }

    pub fn validate(&self) -> Result<(), V2ValidationError> {
        let normalized = Self::materialize(self.refs.clone())?;
        if normalized.refs != self.refs {
            return Err(invalid_value(
                "correlationRefs",
                "must be sorted and unique",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlatformV2 {
    Macos,
    Linux,
    Windows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NetworkSchemeV2 {
    Http,
    Https,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NetworkHostV2 {
    DnsName { labels: Vec<String> },
    Ipv4 { octets: [u8; 4] },
    Ipv6 { octets: [u8; 16] },
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NetworkAddressV2 {
    Ipv4 { octets: [u8; 4] },
    Ipv6 { octets: [u8; 16] },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NetworkQueryV2 {
    None {},
    Exact { utf8: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkRequestTargetV2 {
    pub scheme: NetworkSchemeV2,
    pub host: NetworkHostV2,
    pub port: u16,
    pub path_utf8: String,
    pub query: NetworkQueryV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkOriginV2 {
    pub scheme: NetworkSchemeV2,
    pub host: NetworkHostV2,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CanonicalPrivateTargetV2 {
    Workspace {
        platform: PlatformV2,
        canonical_absolute_path_utf8: String,
    },
    Network {
        request_target: NetworkRequestTargetV2,
        reviewed_addresses: Vec<NetworkAddressV2>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceObjectKindV2 {
    File,
    Directory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceAccessV2 {
    Read,
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ResourceStateV2 {
    Absent {},
    File {
        content_digest: ContentDigestV2,
        byte_length: u64,
        executable: bool,
    },
    Directory {
        collection_digest: CollectionDigestV2,
        item_count: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceScopeTargetV2 {
    pub relative_path: String,
    pub object_kind: WorkspaceObjectKindV2,
    pub access: ResourceAccessV2,
    pub target_observation_digest: ResourceStateDigestV2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryAreaV2 {
    State,
    Index,
    History,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ResourceScopeV2 {
    Workspace {
        targets: Vec<WorkspaceScopeTargetV2>,
    },
    Repository {
        area: RepositoryAreaV2,
    },
    NetworkQuery {
        query_digest: QueryDigestV2,
        service_origin: NetworkOriginV2,
        target_observation_digest: NetworkTargetObservationDigestV2,
    },
    NetworkUrl {
        origin: NetworkOriginV2,
        target_observation_digest: NetworkTargetObservationDigestV2,
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
pub enum ResolvedResourceV2 {
    Workspace {
        object_kind: WorkspaceObjectKindV2,
        relative_path: String,
        resolution_state_digest: ResourceStateDigestV2,
    },
    NetworkQuery {
        query_digest: QueryDigestV2,
        service_origin: NetworkOriginV2,
        target_observation_digest: NetworkTargetObservationDigestV2,
    },
    NetworkEndpoint {
        origin: NetworkOriginV2,
        target_observation_digest: NetworkTargetObservationDigestV2,
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
pub enum PresentFileObservationV2 {
    PresentFile {
        content_digest: ContentDigestV2,
        byte_length: u64,
        executable: bool,
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
pub enum FileBeforeObservationV2 {
    Absent {},
    PresentFile {
        content_digest: ContentDigestV2,
        byte_length: u64,
        executable: bool,
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
pub enum DeletionBeforeObservationV2 {
    PresentFile { state_digest: ResourceStateDigestV2 },
    PresentDirectory { state_digest: ResourceStateDigestV2 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DirectoryBeforeObservationV2 {
    Absent {},
    PresentDirectory { state_digest: ResourceStateDigestV2 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TargetRevalidationObservationV2 {
    FileRead {
        observed: PresentFileObservationV2,
    },
    CollectionRead {
        listing_digest: CollectionDigestV2,
        item_count: u64,
    },
    FileMutationPrepared {
        before: FileBeforeObservationV2,
        expected_after: PresentFileObservationV2,
    },
    DeletionPrepared {
        before: DeletionBeforeObservationV2,
        expected_after: ResourceStateV2,
    },
    DirectoryPrepared {
        before: DirectoryBeforeObservationV2,
        expected_after: WorkspaceObjectKindV2,
    },
    WebQuery {
        query_digest: QueryDigestV2,
        reviewed_target_digest: NetworkTargetObservationDigestV2,
    },
    WebTarget {
        reviewed_target_digest: NetworkTargetObservationDigestV2,
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
pub enum ResourceProjectionObservationV2 {
    Resolution {
        source_fact_id: FactId,
        observation: ResolutionObservationV2,
    },
    Revalidated {
        source_fact_id: FactId,
        target_revalidation_digest: TargetRevalidationDigestV2,
        observation: TargetRevalidationObservationV2,
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
pub enum ResolutionObservationV2 {
    WorkspaceState {
        digest: ResourceStateDigestV2,
    },
    NetworkQuery {
        query_digest: QueryDigestV2,
        target_digest: NetworkTargetObservationDigestV2,
    },
    NetworkTarget {
        digest: NetworkTargetObservationDigestV2,
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
pub enum LastObservationV2 {
    None {},
    Content {
        digest: ContentDigestV2,
    },
    Collection {
        digest: CollectionDigestV2,
    },
    ResourceState {
        digest: ResourceStateDigestV2,
    },
    ToolOutput {
        digest: ToolOutputDigestV2,
    },
    NetworkTarget {
        digest: NetworkTargetObservationDigestV2,
    },
    NetworkResponse {
        digest: NetworkResponseDigestV2,
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
pub enum EffectEvidenceV2 {
    ContentRead {
        content_digest: ContentDigestV2,
        byte_length: u64,
    },
    CollectionRead {
        result_digest: CollectionDigestV2,
        item_count: u64,
    },
    MutationReadBack {
        before_digest: ResourceStateDigestV2,
        after_digest: ResourceStateDigestV2,
        target_kind: WorkspaceObjectKindV2,
    },
    DeletionReadBack {
        previous_digest: ResourceStateDigestV2,
    },
    SearchMatchesReadBack {
        output_digest: ToolOutputDigestV2,
        match_count: u64,
    },
    WebSearchReadBack {
        query_digest: QueryDigestV2,
        reviewed_target_digest: NetworkTargetObservationDigestV2,
        output_digest: ToolOutputDigestV2,
        result_count: u64,
    },
    WebReadBack {
        reviewed_target_digest: NetworkTargetObservationDigestV2,
        response_digest: NetworkResponseDigestV2,
        status_code: u16,
    },
    IndeterminateReadBack {
        last_observation: LastObservationV2,
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
pub enum CommandEpochContextV2 {
    NoCurrentEpoch {},
    Exact { control_epoch: ControlEpoch },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandRequestIdentityV2 {
    pub command_request_id: CommandRequestId,
    pub command_request_digest: CommandRequestDigestV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandReceiptIdentityV2 {
    pub run_id: RunId,
    pub epoch_context: CommandEpochContextV2,
    pub command_request_identity: CommandRequestIdentityV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransitionIdentityV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub causation_fact_id: FactId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancellationIdentityV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub invocation_id: InvocationId,
    pub cancel_request_id: CancelRequestId,
    pub causation_fact_id: FactId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizationIdentityV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub plan_revision: PlanRevisionV2,
    pub plan_action_id: PlanActionIdV2,
    pub operation_id: OperationId,
    pub causation_fact_id: FactId,
    pub correlation_set: CorrelationSetV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityLeaseFactIdentityV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub plan_revision: PlanRevisionV2,
    pub plan_action_id: PlanActionIdV2,
    pub operation_id: OperationId,
    pub preview_id: CapabilityScopePreviewIdV2,
    pub lease_id: CapabilityLeaseIdV2,
    pub lease_version: CapabilityLeaseVersionV2,
    pub causation_fact_id: FactId,
    pub correlation_set: CorrelationSetV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityAwaitingIdentityV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub plan_revision: PlanRevisionV2,
    pub plan_action_id: PlanActionIdV2,
    pub operation_id: OperationId,
    pub invocation_id: InvocationId,
    pub idempotency_key_hash: IdempotencyKeyHashV2,
    pub causation_fact_id: FactId,
    pub correlation_set: CorrelationSetV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InvocationAuthorityV2 {
    ContextRead {
        tool_context_ref: ToolContextRefV2,
        settings_digest: SettingsCeilingDigestV2,
        policy_evaluation_digest: PolicyEvaluationDigestV2,
    },
    PlanAction {
        plan_revision: PlanRevisionV2,
        plan_action_id: PlanActionIdV2,
        lease: CapabilityLeaseRefV2,
        policy_evaluation_digest: PolicyEvaluationDigestV2,
    },
}

impl InvocationAuthorityV2 {
    pub fn capability_lease(&self) -> Option<&CapabilityLeaseRefV2> {
        match self {
            Self::PlanAction { lease, .. } => Some(lease),
            Self::ContextRead { .. } => None,
        }
    }

    pub fn plan_action_id(&self) -> Option<&PlanActionIdV2> {
        match self {
            Self::PlanAction { plan_action_id, .. } => Some(plan_action_id),
            Self::ContextRead { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolContextInvalidationIdentityV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub causation_fact_id: FactId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolAttemptIdentityV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub operation_id: OperationId,
    pub authority: InvocationAuthorityV2,
    pub invocation_id: InvocationId,
    pub attempt_id: AttemptId,
    pub idempotency_key_hash: IdempotencyKeyHashV2,
    pub causation_fact_id: FactId,
    pub correlation_set: CorrelationSetV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolObservedTerminalIdentityV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub operation_id: OperationId,
    pub authority: InvocationAuthorityV2,
    pub invocation_id: InvocationId,
    pub attempt_id: AttemptId,
    pub effect_id: EffectId,
    pub idempotency_key_hash: IdempotencyKeyHashV2,
    pub causation_fact_id: FactId,
    pub correlation_set: CorrelationSetV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolEffectIdentityV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub operation_id: OperationId,
    pub authority: InvocationAuthorityV2,
    pub invocation_id: InvocationId,
    pub attempt_id: AttemptId,
    pub effect_id: EffectId,
    pub idempotency_key_hash: IdempotencyKeyHashV2,
    pub causation_fact_id: FactId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceResolvedIdentityV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub operation_id: OperationId,
    pub invocation_id: InvocationId,
    pub resource_id: ResourceId,
    pub idempotency_key_hash: IdempotencyKeyHashV2,
    pub causation_fact_id: FactId,
    pub correlation_set: CorrelationSetV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceAttemptIdentityV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub operation_id: OperationId,
    pub invocation_id: InvocationId,
    pub attempt_id: AttemptId,
    pub resource_id: ResourceId,
    pub idempotency_key_hash: IdempotencyKeyHashV2,
    pub causation_fact_id: FactId,
    pub correlation_set: CorrelationSetV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupIdentityV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub operation_id: OperationId,
    pub invocation_id: InvocationId,
    pub attempt_id: AttemptId,
    pub resource_id: ResourceId,
    pub cleanup_id: CleanupId,
    pub causation_fact_id: FactId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreEffectFailureCodeV2 {
    TargetRevalidationFailed,
    ExecutorUnavailable,
    Io,
    PermissionDenied,
    Network,
    BackendReportedFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PostObservedEffectFailureCodeV2 {
    VerificationFailed,
    OutputUnavailable,
    BackendReportedFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndeterminateReasonV2 {
    StorageFaultAfterPermit,
    ExecutorOutcomeLost,
    WorkspaceBindingMismatch,
    RecoveryEvidenceInsufficient,
    VerificationAmbiguous,
    CancelDeadlineRace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CancellationSourceV2 {
    ExplicitCommand,
    EpochAdvance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CancellationReasonCodeV2 {
    UserRequested,
    EpochSuperseded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunRetirementReasonCodeV2 {
    HostRequested,
    SessionEnded,
    RunOpenRollback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MutationCommandResultV2 {
    ToolIntentSubmission {
        reply: crate::v2_command::ToolIntentSubmitReplyV2,
    },
    EpochAdvance {
        reply: crate::v2_command::ControlEpochAdvancedReplyV2,
    },
    InvocationCancel {
        reply: crate::v2_command::InvocationCancelReplyV2,
    },
    RecordedSemanticError {
        error: crate::v2_command::RecordedCommandErrorV2,
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
pub enum ControlFactV2 {
    RunOpened {
        run_id: RunId,
        control_epoch: ControlEpoch,
        public_request_id: CommandRequestId,
        public_request_digest: CommandRequestDigestV2,
        causation_fact_id: FactId,
        workspace_binding_ref: crate::tool_protocol_v2::WorkspaceBindingRefV2,
        workspace_binding_digest: WorkspaceBindingDigestV2,
        settings_ceiling_digest: SettingsCeilingDigestV2,
        tool_context_ref: ToolContextRefV2,
    },
    RunTransportRebound {
        run_id: RunId,
        control_epoch: ControlEpoch,
        transport_generation: u64,
        causation_fact_id: FactId,
    },
    CommandRecorded {
        identity: CommandReceiptIdentityV2,
        command_kind: crate::v2_command::MutationCommandKindV2,
        result: MutationCommandResultV2,
    },
    EpochAdvanced {
        identity: TransitionIdentityV2,
        input_id: InputId,
        previous_epoch: Option<ControlEpoch>,
        opaque_input_ref: String,
    },
    CancellationRequested {
        identity: CancellationIdentityV2,
        source: CancellationSourceV2,
        reason_code: CancellationReasonCodeV2,
        reason: Option<String>,
    },
    RunRetirementFenced {
        run_id: RunId,
        control_epoch: ControlEpoch,
        reason_code: RunRetirementReasonCodeV2,
        reason: Option<String>,
        causation_fact_id: FactId,
    },
    RunRetired {
        run_id: RunId,
        control_epoch: ControlEpoch,
        reason_code: RunRetirementReasonCodeV2,
        reason: Option<String>,
        causation_fact_id: FactId,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityLeaseRevokeReasonV2 {
    UserRevoked,
    SettingsChanged,
    ToolRevoked,
    ToolContextChanged,
    RunRetired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityLeaseSupersessionReasonV2 {
    ControlEpochAdvanced,
    ScopeExpanded,
    ToolContextChanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolContextInvalidationReasonV2 {
    ToolRevoked,
    ToolUnavailable,
    SettingsChanged,
    RegistryChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AuthorizationFactV2 {
    ScopePreviewed {
        identity: AuthorizationIdentityV2,
        preview_id: CapabilityScopePreviewIdV2,
        tool_id: ToolIdV2,
        canonical_arguments_digest: CanonicalArgumentsDigestV2,
        scope_digest: CapabilityScopeDigestV2,
        tool_contract_digest: ToolContractDigestV2,
        context_ref: ToolContextRefV2,
        disposition: crate::v2_command::CapabilityScopeDispositionV2,
    },
    CapabilityIssued {
        identity: CapabilityLeaseFactIdentityV2,
        tool_id: ToolIdV2,
        scope_digest: CapabilityScopeDigestV2,
        authorization_digest: CapabilityAuthorizationDigestV2,
        tool_contract_digest: ToolContractDigestV2,
        context_ref: ToolContextRefV2,
    },
    CapabilityDenied {
        identity: AuthorizationIdentityV2,
        preview_id: CapabilityScopePreviewIdV2,
        tool_id: ToolIdV2,
        scope_digest: CapabilityScopeDigestV2,
        authorization_digest: CapabilityAuthorizationDigestV2,
        guidance: String,
    },
    CapabilityAwaiting {
        identity: CapabilityAwaitingIdentityV2,
        preview_id: CapabilityScopePreviewIdV2,
        tool_id: ToolIdV2,
        canonical_arguments_digest: CanonicalArgumentsDigestV2,
        scope_digest: CapabilityScopeDigestV2,
        tool_contract_digest: ToolContractDigestV2,
        context_ref: ToolContextRefV2,
    },
    ExpansionAllowed {
        identity: CapabilityLeaseFactIdentityV2,
        previous_lease_id: CapabilityLeaseIdV2,
        previous_scope_digest: CapabilityScopeDigestV2,
        expanded_scope_digest: CapabilityScopeDigestV2,
        authorization_digest: CapabilityAuthorizationDigestV2,
    },
    ExpansionDenied {
        identity: AuthorizationIdentityV2,
        preview_id: CapabilityScopePreviewIdV2,
        requested_scope_digest: CapabilityScopeDigestV2,
        authorization_digest: CapabilityAuthorizationDigestV2,
        guidance: String,
    },
    TrustGranted {
        identity: AuthorizationIdentityV2,
        trust_policy_id: TrustPolicyIdV2,
        trust_lease_digest: TrustLeaseDigestV2,
        tool_id: ToolIdV2,
        scope_digest: CapabilityScopeDigestV2,
        workspace_binding_digest: WorkspaceBindingDigestV2,
        context_ref: ToolContextRefV2,
        expires_at: Option<RecordedAtV2>,
    },
    TrustRevoked {
        identity: AuthorizationIdentityV2,
        trust_policy_id: TrustPolicyIdV2,
        trust_lease_digest: TrustLeaseDigestV2,
        tool_id: ToolIdV2,
        scope_digest: CapabilityScopeDigestV2,
        workspace_binding_digest: WorkspaceBindingDigestV2,
        context_ref: ToolContextRefV2,
        expires_at: Option<RecordedAtV2>,
    },
    LeaseRevoked {
        identity: CapabilityLeaseFactIdentityV2,
        scope_digest: CapabilityScopeDigestV2,
        reason: CapabilityLeaseRevokeReasonV2,
    },
    LeaseSuperseded {
        identity: CapabilityLeaseFactIdentityV2,
        scope_digest: CapabilityScopeDigestV2,
        reason: CapabilityLeaseSupersessionReasonV2,
    },
    ContextInvalidated {
        identity: ToolContextInvalidationIdentityV2,
        previous_context: ToolContextRefV2,
        next_context_version: crate::tool_protocol_v2::ToolContextVersionV2,
        next_context_ref: ToolContextRefV2,
        settings_ceiling_digest: SettingsCeilingDigestV2,
        tool_id: Option<ToolIdV2>,
        availability: Option<ToolAvailabilityV2>,
        reason: ToolContextInvalidationReasonV2,
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
pub enum InvocationFactV2 {
    ToolIntentAdmitted {
        identity: ToolAttemptIdentityV2,
        tool_id: ToolIdV2,
        canonical_arguments_digest: CanonicalArgumentsDigestV2,
        tool_contract_digest: ToolContractDigestV2,
        resource_scope: ResourceScopeV2,
        workspace_binding_digest: WorkspaceBindingDigestV2,
        effective_deadline_ms: u32,
    },
    ToolAttemptPrepared {
        identity: ToolAttemptIdentityV2,
    },
    ToolExecutionStarted {
        identity: ToolAttemptIdentityV2,
        target_revalidation_set_digest: TargetRevalidationSetDigestV2,
    },
    ToolCancellationObserved {
        identity: ToolAttemptIdentityV2,
        cancel_request_id: CancelRequestId,
    },
    ToolDeadlineObserved {
        identity: ToolAttemptIdentityV2,
    },
    ToolFailedBeforeEffect {
        identity: ToolAttemptIdentityV2,
        error_code: PreEffectFailureCodeV2,
    },
    ToolCancelledBeforeEffect {
        identity: ToolAttemptIdentityV2,
        cancel_request_id: CancelRequestId,
    },
    ToolTimedOutBeforeEffect {
        identity: ToolAttemptIdentityV2,
    },
    ToolCompleted {
        identity: ToolObservedTerminalIdentityV2,
        output: Value,
    },
    ToolFailedAfterObservedEffect {
        identity: ToolObservedTerminalIdentityV2,
        error_code: PostObservedEffectFailureCodeV2,
    },
    ToolIndeterminate {
        identity: ToolObservedTerminalIdentityV2,
        reason_code: IndeterminateReasonV2,
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
pub enum EffectFactV2 {
    ToolObserved {
        identity: ToolEffectIdentityV2,
        affected_resource_ids: Vec<ResourceId>,
        evidence: EffectEvidenceV2,
        evidence_digest: ExecutorEvidenceDigestV2,
    },
    ToolObservedAfterCancel {
        identity: ToolEffectIdentityV2,
        cancel_request_id: CancelRequestId,
        affected_resource_ids: Vec<ResourceId>,
        evidence: EffectEvidenceV2,
        evidence_digest: ExecutorEvidenceDigestV2,
    },
    ToolObservedAfterDeadline {
        identity: ToolEffectIdentityV2,
        affected_resource_ids: Vec<ResourceId>,
        evidence: EffectEvidenceV2,
        evidence_digest: ExecutorEvidenceDigestV2,
    },
    ToolObservedAfterCancelAndDeadline {
        identity: ToolEffectIdentityV2,
        cancel_request_id: CancelRequestId,
        affected_resource_ids: Vec<ResourceId>,
        evidence: EffectEvidenceV2,
        evidence_digest: ExecutorEvidenceDigestV2,
    },
    ToolIndeterminate {
        identity: ToolEffectIdentityV2,
        possible_affected_resource_ids: Vec<ResourceId>,
        reason_code: IndeterminateReasonV2,
        evidence: EffectEvidenceV2,
        evidence_digest: ExecutorEvidenceDigestV2,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupErrorCodeV2 {
    BackendUnavailable,
    Io,
    PermissionDenied,
    VerificationFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ResourceFactV2 {
    ResolvedForInvocation {
        identity: ResourceResolvedIdentityV2,
        resource: ResolvedResourceV2,
    },
    RevalidatedBeforeEffect {
        identity: ResourceAttemptIdentityV2,
        observation: TargetRevalidationObservationV2,
        target_revalidation_digest: TargetRevalidationDigestV2,
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
pub enum CleanupFactV2 {
    Scheduled {
        identity: CleanupIdentityV2,
    },
    Attempted {
        identity: CleanupIdentityV2,
        cleanup_attempt: u32,
    },
    Completed {
        identity: CleanupIdentityV2,
        cleanup_attempt: u32,
    },
    Failed {
        identity: CleanupIdentityV2,
        cleanup_attempt: u32,
        error_code: CleanupErrorCodeV2,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "domain",
    content = "fact",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum KernelFactPayloadV2 {
    Control(ControlFactV2),
    Authorization(AuthorizationFactV2),
    Invocation(InvocationFactV2),
    Effect(EffectFactV2),
    Resource(ResourceFactV2),
    Cleanup(CleanupFactV2),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelFactEnvelopeV2 {
    pub abi_version: String,
    pub fact_id: FactId,
    pub ledger_sequence: u64,
    pub run_sequence: u64,
    pub recorded_at: RecordedAtV2,
    pub payload: KernelFactPayloadV2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelFactDraftV2 {
    pub fact_id: FactId,
    pub payload: KernelFactPayloadV2,
}

impl KernelFactEnvelopeV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if self.abi_version != KERNEL_ABI_V2_VERSION {
            return Err(V2ValidationError::UnsupportedAbiVersion {
                actual: self.abi_version.clone(),
            });
        }
        if self.ledger_sequence == 0 {
            return Err(zero_value("ledgerSequence"));
        }
        if self.run_sequence == 0 {
            return Err(zero_value("runSequence"));
        }
        self.payload.validate()?;
        let bytes =
            serde_json::to_vec(self).map_err(|_| invalid_value("fact", "must serialize"))?;
        if bytes.len() > MAX_FACT_WIRE_BYTES_V2 {
            return Err(field_too_large("fact", MAX_FACT_WIRE_BYTES_V2));
        }
        Ok(())
    }
}

impl KernelFactPayloadV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if let Some(correlations) = self.correlation_set() {
            correlations.validate()?;
        }
        if let Self::Control(ControlFactV2::RunOpened {
            control_epoch,
            tool_context_ref,
            ..
        }) = self
        {
            if control_epoch.get() != 1 {
                return Err(invalid_value(
                    "fact.controlEpoch",
                    "RunOpened must bind control epoch 1",
                ));
            }
            if tool_context_ref.context_version.get() != 1 {
                return Err(invalid_value(
                    "fact.toolContextRef.contextVersion",
                    "RunOpened must bind ToolContext version 1",
                ));
            }
        }
        if let Self::Control(ControlFactV2::RunTransportRebound {
            transport_generation,
            ..
        }) = self
        {
            if *transport_generation < 2 {
                return Err(invalid_value(
                    "fact.transportGeneration",
                    "RunTransportRebound must advance beyond the initial transport generation",
                ));
            }
        }
        if let Self::Control(ControlFactV2::RunRetired {
            reason: Some(reason),
            ..
        }) = self
        {
            validate_bounded_text("fact.reason", reason)?;
        }
        if let Self::Control(ControlFactV2::RunRetirementFenced {
            reason: Some(reason),
            ..
        }) = self
        {
            validate_bounded_text("fact.reason", reason)?;
        }
        if let Self::Authorization(AuthorizationFactV2::ContextInvalidated {
            previous_context,
            next_context_version,
            next_context_ref,
            tool_id,
            availability,
            reason,
            ..
        }) = self
        {
            if next_context_ref.context_version != *next_context_version {
                return Err(invalid_value(
                    "fact.nextContextRef.contextVersion",
                    "must equal nextContextVersion",
                ));
            }
            if previous_context.context_version.get().checked_add(1)
                != Some(next_context_version.get())
            {
                return Err(invalid_value(
                    "fact.nextContextVersion",
                    "must immediately follow previousContext.contextVersion",
                ));
            }
            if previous_context == next_context_ref {
                return Err(invalid_value(
                    "fact.nextContextRef",
                    "must differ from previousContext",
                ));
            }
            let relation_is_valid = match reason {
                ToolContextInvalidationReasonV2::ToolRevoked => {
                    tool_id.is_some() && *availability == Some(ToolAvailabilityV2::Revoked)
                }
                ToolContextInvalidationReasonV2::ToolUnavailable => {
                    tool_id.is_some() && *availability == Some(ToolAvailabilityV2::Unavailable)
                }
                ToolContextInvalidationReasonV2::SettingsChanged
                | ToolContextInvalidationReasonV2::RegistryChanged => {
                    tool_id.is_none() && availability.is_none()
                }
            };
            if !relation_is_valid {
                return Err(invalid_value(
                    "fact.contextInvalidation",
                    "reason, toolId, and availability must describe one canonical transition",
                ));
            }
        }
        let resources = self.resource_ids();
        if !strictly_sorted_unique_ids(&resources) {
            return Err(invalid_value("resourceIds", "must be sorted and unique"));
        }
        if let Self::Cleanup(fact) = self {
            let attempt = match fact {
                CleanupFactV2::Attempted {
                    cleanup_attempt, ..
                }
                | CleanupFactV2::Completed {
                    cleanup_attempt, ..
                }
                | CleanupFactV2::Failed {
                    cleanup_attempt, ..
                } => Some(*cleanup_attempt),
                CleanupFactV2::Scheduled { .. } => None,
            };
            if attempt == Some(0) {
                return Err(zero_value("cleanupAttempt"));
            }
        }
        Ok(())
    }

    pub fn run_id(&self) -> &RunId {
        match self {
            Self::Control(fact) => fact.run_id(),
            Self::Authorization(fact) => fact.run_id(),
            Self::Invocation(fact) => fact.identity().run_id,
            Self::Effect(fact) => fact.identity().run_id,
            Self::Resource(fact) => fact.identity().run_id,
            Self::Cleanup(fact) => &fact.identity().run_id,
        }
    }

    pub fn control_epoch(&self) -> Option<ControlEpoch> {
        match self {
            Self::Control(ControlFactV2::RunOpened { control_epoch, .. }) => Some(*control_epoch),
            Self::Control(ControlFactV2::RunTransportRebound { control_epoch, .. }) => {
                Some(*control_epoch)
            }
            Self::Control(ControlFactV2::CommandRecorded { identity, .. }) => {
                match identity.epoch_context {
                    CommandEpochContextV2::NoCurrentEpoch {} => None,
                    CommandEpochContextV2::Exact { control_epoch } => Some(control_epoch),
                }
            }
            Self::Control(ControlFactV2::EpochAdvanced { identity, .. }) => {
                Some(identity.control_epoch)
            }
            Self::Control(ControlFactV2::CancellationRequested { identity, .. }) => {
                Some(identity.control_epoch)
            }
            Self::Control(ControlFactV2::RunRetired { control_epoch, .. }) => Some(*control_epoch),
            Self::Control(ControlFactV2::RunRetirementFenced { control_epoch, .. }) => {
                Some(*control_epoch)
            }
            Self::Authorization(fact) => Some(fact.control_epoch()),
            Self::Invocation(fact) => Some(fact.identity().control_epoch),
            Self::Effect(fact) => Some(fact.identity().control_epoch),
            Self::Resource(fact) => Some(fact.identity().control_epoch),
            Self::Cleanup(fact) => Some(fact.identity().control_epoch),
        }
    }

    pub fn causation_fact_id(&self) -> Option<&FactId> {
        match self {
            Self::Control(fact) => fact.causation(),
            Self::Authorization(fact) => Some(fact.causation_fact_id()),
            Self::Invocation(fact) => Some(fact.identity().causation_fact_id),
            Self::Effect(fact) => Some(fact.identity().causation_fact_id),
            Self::Resource(fact) => Some(fact.identity().causation_fact_id),
            Self::Cleanup(fact) => Some(&fact.identity().causation_fact_id),
        }
    }

    pub fn operation_id(&self) -> Option<&OperationId> {
        match self {
            Self::Control(_) => None,
            Self::Authorization(fact) => fact.operation_id(),
            Self::Invocation(fact) => Some(fact.identity().operation_id),
            Self::Effect(fact) => Some(fact.identity().operation_id),
            Self::Resource(fact) => Some(fact.identity().operation_id),
            Self::Cleanup(fact) => Some(&fact.identity().operation_id),
        }
    }

    pub fn invocation_id(&self) -> Option<&InvocationId> {
        match self {
            Self::Control(ControlFactV2::CancellationRequested { identity, .. }) => {
                Some(&identity.invocation_id)
            }
            Self::Control(_) => None,
            Self::Authorization(fact) => fact.invocation_id(),
            Self::Invocation(fact) => Some(fact.identity().invocation_id),
            Self::Effect(fact) => Some(fact.identity().invocation_id),
            Self::Resource(fact) => Some(fact.identity().invocation_id),
            Self::Cleanup(fact) => Some(&fact.identity().invocation_id),
        }
    }

    pub fn attempt_id(&self) -> Option<&AttemptId> {
        match self {
            Self::Invocation(fact) => Some(fact.identity().attempt_id),
            Self::Effect(fact) => Some(fact.identity().attempt_id),
            Self::Resource(fact) => fact.identity().attempt_id,
            Self::Cleanup(fact) => Some(&fact.identity().attempt_id),
            Self::Control(_) | Self::Authorization(_) => None,
        }
    }

    pub fn effect_id(&self) -> Option<&EffectId> {
        match self {
            Self::Invocation(
                InvocationFactV2::ToolCompleted { identity, .. }
                | InvocationFactV2::ToolFailedAfterObservedEffect { identity, .. }
                | InvocationFactV2::ToolIndeterminate { identity, .. },
            ) => Some(&identity.effect_id),
            Self::Effect(fact) => Some(fact.identity().effect_id),
            _ => None,
        }
    }

    pub fn capability_lease_id(&self) -> Option<&CapabilityLeaseIdV2> {
        match self {
            Self::Invocation(fact) => fact
                .identity()
                .authority
                .capability_lease()
                .map(|lease| &lease.lease_id),
            Self::Effect(fact) => fact
                .identity()
                .authority
                .capability_lease()
                .map(|lease| &lease.lease_id),
            Self::Authorization(
                AuthorizationFactV2::CapabilityIssued { identity, .. }
                | AuthorizationFactV2::ExpansionAllowed { identity, .. }
                | AuthorizationFactV2::LeaseRevoked { identity, .. }
                | AuthorizationFactV2::LeaseSuperseded { identity, .. },
            ) => Some(&identity.lease_id),
            _ => None,
        }
    }

    pub fn capability_lease(&self) -> Option<CapabilityLeaseRefV2> {
        match self {
            Self::Invocation(fact) => fact.identity().authority.capability_lease().cloned(),
            Self::Effect(fact) => fact.identity().authority.capability_lease().cloned(),
            Self::Authorization(AuthorizationFactV2::CapabilityIssued {
                identity,
                scope_digest,
                ..
            })
            | Self::Authorization(AuthorizationFactV2::LeaseRevoked {
                identity,
                scope_digest,
                ..
            })
            | Self::Authorization(AuthorizationFactV2::LeaseSuperseded {
                identity,
                scope_digest,
                ..
            }) => Some(CapabilityLeaseRefV2 {
                lease_id: identity.lease_id.clone(),
                version: identity.lease_version,
                scope_digest: scope_digest.clone(),
            }),
            Self::Authorization(AuthorizationFactV2::ExpansionAllowed {
                identity,
                expanded_scope_digest,
                ..
            }) => Some(CapabilityLeaseRefV2 {
                lease_id: identity.lease_id.clone(),
                version: identity.lease_version,
                scope_digest: expanded_scope_digest.clone(),
            }),
            _ => None,
        }
    }

    pub fn idempotency_hash(&self) -> Option<&IdempotencyKeyHashV2> {
        match self {
            Self::Authorization(fact) => fact.idempotency_key_hash(),
            Self::Invocation(fact) => Some(fact.identity().idempotency_key_hash),
            Self::Effect(fact) => Some(fact.identity().idempotency_key_hash),
            Self::Resource(fact) => Some(fact.identity().idempotency_key_hash),
            Self::Control(_) | Self::Cleanup(_) => None,
        }
    }

    pub fn command_request_id(&self) -> Option<&CommandRequestId> {
        match self {
            Self::Control(ControlFactV2::RunOpened {
                public_request_id, ..
            }) => Some(public_request_id),
            Self::Control(ControlFactV2::CommandRecorded { identity, .. }) => {
                Some(&identity.command_request_identity.command_request_id)
            }
            _ => None,
        }
    }

    pub fn resource_ids(&self) -> Vec<&ResourceId> {
        match self {
            Self::Effect(fact) => fact.resource_ids(),
            Self::Resource(fact) => vec![fact.identity().resource_id],
            Self::Cleanup(fact) => vec![&fact.identity().resource_id],
            Self::Control(_) | Self::Authorization(_) | Self::Invocation(_) => Vec::new(),
        }
    }

    pub fn correlation_set(&self) -> Option<&CorrelationSetV2> {
        match self {
            Self::Authorization(fact) => fact.correlation_set(),
            Self::Invocation(fact) => Some(fact.identity().correlation_set),
            Self::Resource(fact) => Some(fact.identity().correlation_set),
            Self::Control(_) | Self::Effect(_) | Self::Cleanup(_) => None,
        }
    }

    pub fn authorization_plan_action_id(&self) -> Option<&PlanActionIdV2> {
        match self {
            Self::Authorization(fact) => fact.plan_action_id(),
            Self::Invocation(fact) => fact.identity().authority.plan_action_id(),
            Self::Effect(fact) => fact.identity().authority.plan_action_id(),
            _ => None,
        }
    }

    pub fn kind_token(&self) -> &'static str {
        match self {
            Self::Control(_) => "control",
            Self::Authorization(_) => "authorization",
            Self::Invocation(_) => "invocation",
            Self::Effect(_) => "effect",
            Self::Resource(_) => "resource",
            Self::Cleanup(_) => "cleanup",
        }
    }
}

impl ControlFactV2 {
    fn run_id(&self) -> &RunId {
        match self {
            Self::RunOpened { run_id, .. } => run_id,
            Self::RunTransportRebound { run_id, .. } => run_id,
            Self::CommandRecorded { identity, .. } => &identity.run_id,
            Self::EpochAdvanced { identity, .. } => &identity.run_id,
            Self::CancellationRequested { identity, .. } => &identity.run_id,
            Self::RunRetirementFenced { run_id, .. } => run_id,
            Self::RunRetired { run_id, .. } => run_id,
        }
    }

    fn causation(&self) -> Option<&FactId> {
        match self {
            Self::RunOpened {
                causation_fact_id, ..
            } => Some(causation_fact_id),
            Self::RunTransportRebound {
                causation_fact_id, ..
            } => Some(causation_fact_id),
            Self::CommandRecorded { .. } => None,
            Self::EpochAdvanced { identity, .. } => Some(&identity.causation_fact_id),
            Self::CancellationRequested { identity, .. } => Some(&identity.causation_fact_id),
            Self::RunRetirementFenced {
                causation_fact_id, ..
            } => Some(causation_fact_id),
            Self::RunRetired {
                causation_fact_id, ..
            } => Some(causation_fact_id),
        }
    }
}

impl AuthorizationFactV2 {
    fn run_id(&self) -> &RunId {
        match self {
            Self::ScopePreviewed { identity, .. }
            | Self::CapabilityDenied { identity, .. }
            | Self::ExpansionDenied { identity, .. }
            | Self::TrustGranted { identity, .. }
            | Self::TrustRevoked { identity, .. } => &identity.run_id,
            Self::CapabilityIssued { identity, .. }
            | Self::ExpansionAllowed { identity, .. }
            | Self::LeaseRevoked { identity, .. }
            | Self::LeaseSuperseded { identity, .. } => &identity.run_id,
            Self::CapabilityAwaiting { identity, .. } => &identity.run_id,
            Self::ContextInvalidated { identity, .. } => &identity.run_id,
        }
    }

    fn control_epoch(&self) -> ControlEpoch {
        match self {
            Self::ScopePreviewed { identity, .. }
            | Self::CapabilityDenied { identity, .. }
            | Self::ExpansionDenied { identity, .. }
            | Self::TrustGranted { identity, .. }
            | Self::TrustRevoked { identity, .. } => identity.control_epoch,
            Self::CapabilityIssued { identity, .. }
            | Self::ExpansionAllowed { identity, .. }
            | Self::LeaseRevoked { identity, .. }
            | Self::LeaseSuperseded { identity, .. } => identity.control_epoch,
            Self::CapabilityAwaiting { identity, .. } => identity.control_epoch,
            Self::ContextInvalidated { identity, .. } => identity.control_epoch,
        }
    }

    fn causation_fact_id(&self) -> &FactId {
        match self {
            Self::ScopePreviewed { identity, .. }
            | Self::CapabilityDenied { identity, .. }
            | Self::ExpansionDenied { identity, .. }
            | Self::TrustGranted { identity, .. }
            | Self::TrustRevoked { identity, .. } => &identity.causation_fact_id,
            Self::CapabilityIssued { identity, .. }
            | Self::ExpansionAllowed { identity, .. }
            | Self::LeaseRevoked { identity, .. }
            | Self::LeaseSuperseded { identity, .. } => &identity.causation_fact_id,
            Self::CapabilityAwaiting { identity, .. } => &identity.causation_fact_id,
            Self::ContextInvalidated { identity, .. } => &identity.causation_fact_id,
        }
    }

    fn operation_id(&self) -> Option<&OperationId> {
        match self {
            Self::ScopePreviewed { identity, .. }
            | Self::CapabilityDenied { identity, .. }
            | Self::ExpansionDenied { identity, .. }
            | Self::TrustGranted { identity, .. }
            | Self::TrustRevoked { identity, .. } => Some(&identity.operation_id),
            Self::CapabilityIssued { identity, .. }
            | Self::ExpansionAllowed { identity, .. }
            | Self::LeaseRevoked { identity, .. }
            | Self::LeaseSuperseded { identity, .. } => Some(&identity.operation_id),
            Self::CapabilityAwaiting { identity, .. } => Some(&identity.operation_id),
            Self::ContextInvalidated { .. } => None,
        }
    }

    fn invocation_id(&self) -> Option<&InvocationId> {
        match self {
            Self::CapabilityAwaiting { identity, .. } => Some(&identity.invocation_id),
            _ => None,
        }
    }

    fn idempotency_key_hash(&self) -> Option<&IdempotencyKeyHashV2> {
        match self {
            Self::CapabilityAwaiting { identity, .. } => Some(&identity.idempotency_key_hash),
            _ => None,
        }
    }

    fn correlation_set(&self) -> Option<&CorrelationSetV2> {
        match self {
            Self::ScopePreviewed { identity, .. }
            | Self::CapabilityDenied { identity, .. }
            | Self::ExpansionDenied { identity, .. }
            | Self::TrustGranted { identity, .. }
            | Self::TrustRevoked { identity, .. } => Some(&identity.correlation_set),
            Self::CapabilityIssued { identity, .. }
            | Self::ExpansionAllowed { identity, .. }
            | Self::LeaseRevoked { identity, .. }
            | Self::LeaseSuperseded { identity, .. } => Some(&identity.correlation_set),
            Self::CapabilityAwaiting { identity, .. } => Some(&identity.correlation_set),
            Self::ContextInvalidated { .. } => None,
        }
    }

    fn plan_action_id(&self) -> Option<&PlanActionIdV2> {
        match self {
            Self::ScopePreviewed { identity, .. }
            | Self::CapabilityDenied { identity, .. }
            | Self::ExpansionDenied { identity, .. }
            | Self::TrustGranted { identity, .. }
            | Self::TrustRevoked { identity, .. } => Some(&identity.plan_action_id),
            Self::CapabilityIssued { identity, .. }
            | Self::ExpansionAllowed { identity, .. }
            | Self::LeaseRevoked { identity, .. }
            | Self::LeaseSuperseded { identity, .. } => Some(&identity.plan_action_id),
            Self::CapabilityAwaiting { identity, .. } => Some(&identity.plan_action_id),
            Self::ContextInvalidated { .. } => None,
        }
    }
}

struct InvocationFactIdentityRef<'a> {
    run_id: &'a RunId,
    control_epoch: ControlEpoch,
    operation_id: &'a OperationId,
    invocation_id: &'a InvocationId,
    attempt_id: &'a AttemptId,
    authority: &'a InvocationAuthorityV2,
    idempotency_key_hash: &'a IdempotencyKeyHashV2,
    causation_fact_id: &'a FactId,
    correlation_set: &'a CorrelationSetV2,
}

impl InvocationFactV2 {
    fn identity(&self) -> InvocationFactIdentityRef<'_> {
        match self {
            Self::ToolIntentAdmitted { identity, .. }
            | Self::ToolAttemptPrepared { identity }
            | Self::ToolExecutionStarted { identity, .. }
            | Self::ToolCancellationObserved { identity, .. }
            | Self::ToolDeadlineObserved { identity }
            | Self::ToolFailedBeforeEffect { identity, .. }
            | Self::ToolCancelledBeforeEffect { identity, .. }
            | Self::ToolTimedOutBeforeEffect { identity } => InvocationFactIdentityRef {
                run_id: &identity.run_id,
                control_epoch: identity.control_epoch,
                operation_id: &identity.operation_id,
                invocation_id: &identity.invocation_id,
                attempt_id: &identity.attempt_id,
                authority: &identity.authority,
                idempotency_key_hash: &identity.idempotency_key_hash,
                causation_fact_id: &identity.causation_fact_id,
                correlation_set: &identity.correlation_set,
            },
            Self::ToolCompleted { identity, .. }
            | Self::ToolFailedAfterObservedEffect { identity, .. }
            | Self::ToolIndeterminate { identity, .. } => InvocationFactIdentityRef {
                run_id: &identity.run_id,
                control_epoch: identity.control_epoch,
                operation_id: &identity.operation_id,
                invocation_id: &identity.invocation_id,
                attempt_id: &identity.attempt_id,
                authority: &identity.authority,
                idempotency_key_hash: &identity.idempotency_key_hash,
                causation_fact_id: &identity.causation_fact_id,
                correlation_set: &identity.correlation_set,
            },
        }
    }
}

struct EffectFactIdentityRef<'a> {
    run_id: &'a RunId,
    control_epoch: ControlEpoch,
    operation_id: &'a OperationId,
    authority: &'a InvocationAuthorityV2,
    invocation_id: &'a InvocationId,
    attempt_id: &'a AttemptId,
    effect_id: &'a EffectId,
    idempotency_key_hash: &'a IdempotencyKeyHashV2,
    causation_fact_id: &'a FactId,
}

impl EffectFactV2 {
    fn identity(&self) -> EffectFactIdentityRef<'_> {
        let identity = match self {
            Self::ToolObserved { identity, .. }
            | Self::ToolObservedAfterCancel { identity, .. }
            | Self::ToolObservedAfterDeadline { identity, .. }
            | Self::ToolObservedAfterCancelAndDeadline { identity, .. }
            | Self::ToolIndeterminate { identity, .. } => identity,
        };
        EffectFactIdentityRef {
            run_id: &identity.run_id,
            control_epoch: identity.control_epoch,
            operation_id: &identity.operation_id,
            authority: &identity.authority,
            invocation_id: &identity.invocation_id,
            attempt_id: &identity.attempt_id,
            effect_id: &identity.effect_id,
            idempotency_key_hash: &identity.idempotency_key_hash,
            causation_fact_id: &identity.causation_fact_id,
        }
    }

    fn resource_ids(&self) -> Vec<&ResourceId> {
        match self {
            Self::ToolObserved {
                affected_resource_ids,
                ..
            }
            | Self::ToolObservedAfterCancel {
                affected_resource_ids,
                ..
            }
            | Self::ToolObservedAfterDeadline {
                affected_resource_ids,
                ..
            }
            | Self::ToolObservedAfterCancelAndDeadline {
                affected_resource_ids,
                ..
            } => affected_resource_ids.iter().collect(),
            Self::ToolIndeterminate {
                possible_affected_resource_ids,
                ..
            } => possible_affected_resource_ids.iter().collect(),
        }
    }
}

struct ResourceFactIdentityRef<'a> {
    run_id: &'a RunId,
    control_epoch: ControlEpoch,
    operation_id: &'a OperationId,
    invocation_id: &'a InvocationId,
    attempt_id: Option<&'a AttemptId>,
    resource_id: &'a ResourceId,
    idempotency_key_hash: &'a IdempotencyKeyHashV2,
    causation_fact_id: &'a FactId,
    correlation_set: &'a CorrelationSetV2,
}

impl ResourceFactV2 {
    fn identity(&self) -> ResourceFactIdentityRef<'_> {
        match self {
            Self::ResolvedForInvocation { identity, .. } => ResourceFactIdentityRef {
                run_id: &identity.run_id,
                control_epoch: identity.control_epoch,
                operation_id: &identity.operation_id,
                invocation_id: &identity.invocation_id,
                attempt_id: None,
                resource_id: &identity.resource_id,
                idempotency_key_hash: &identity.idempotency_key_hash,
                causation_fact_id: &identity.causation_fact_id,
                correlation_set: &identity.correlation_set,
            },
            Self::RevalidatedBeforeEffect { identity, .. } => ResourceFactIdentityRef {
                run_id: &identity.run_id,
                control_epoch: identity.control_epoch,
                operation_id: &identity.operation_id,
                invocation_id: &identity.invocation_id,
                attempt_id: Some(&identity.attempt_id),
                resource_id: &identity.resource_id,
                idempotency_key_hash: &identity.idempotency_key_hash,
                causation_fact_id: &identity.causation_fact_id,
                correlation_set: &identity.correlation_set,
            },
        }
    }
}

impl CleanupFactV2 {
    fn identity(&self) -> &CleanupIdentityV2 {
        match self {
            Self::Scheduled { identity }
            | Self::Attempted { identity, .. }
            | Self::Completed { identity, .. }
            | Self::Failed { identity, .. } => identity,
        }
    }
}

pub fn decode_fact_v2(input: &[u8]) -> Result<KernelFactEnvelopeV2, V2WireDecodeError> {
    if input.len() > MAX_FACT_WIRE_BYTES_V2 {
        return Err(V2WireDecodeError::PayloadTooLarge {
            maximum: MAX_FACT_WIRE_BYTES_V2,
        });
    }
    let value = decode_strict_json(input)?;
    validate_wire_abi_header(&value)?;
    let fact = serde_json::from_value::<KernelFactEnvelopeV2>(value)
        .map_err(|error| V2WireDecodeError::InvalidPayload(error.to_string()))?;
    fact.validate()?;
    Ok(fact)
}

pub(crate) fn decode_strict_json(input: &[u8]) -> Result<Value, V2WireDecodeError> {
    serde_json::from_slice::<StrictJsonValue>(input)
        .map(|value| value.0)
        .map_err(|error| {
            if error.to_string().contains("duplicate JSON object key") {
                V2WireDecodeError::DuplicateKey
            } else {
                V2WireDecodeError::InvalidJson
            }
        })
}

pub(crate) fn validate_wire_abi_header(value: &Value) -> Result<(), V2WireDecodeError> {
    match value
        .as_object()
        .and_then(|object| object.get("abiVersion"))
    {
        Some(Value::String(version)) if version == KERNEL_ABI_V2_VERSION => Ok(()),
        Some(Value::String(version)) => Err(V2WireDecodeError::UnsupportedAbiVersion {
            received: version.clone(),
        }),
        Some(_) => Err(V2WireDecodeError::InvalidAbiVersion),
        None => Err(V2WireDecodeError::MissingAbiVersion),
    }
}

pub(crate) fn typed_digest<T: Serialize>(
    domain: &'static str,
    value: &T,
) -> Result<[u8; 32], V2ValidationError> {
    let value = serde_json::to_value(value)
        .map_err(|_| invalid_value("digestPreimage", "must serialize"))?;
    let canonical = canonical_json_bytes_v2(&value)?;
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update([0]);
    hasher.update(canonical);
    Ok(hasher.finalize().into())
}

fn typed_digest_newtype<D: DigestFromRaw, T: Serialize>(
    domain: &'static str,
    value: &T,
) -> Result<D, V2ValidationError> {
    typed_digest(domain, value).map(D::from_raw_digest)
}

pub fn command_request_digest_v2(
    command: &crate::v2_command::KernelCommandV2,
) -> Result<CommandRequestDigestV2, V2ValidationError> {
    let encoded =
        serde_json::to_value(command).map_err(|_| invalid_value("command", "must serialize"))?;
    let typed_command_data = encoded
        .as_object()
        .and_then(|object| object.get("data"))
        .ok_or_else(|| invalid_value("command", "must use the typed kind/data representation"))?;
    typed_digest_newtype(
        "deepcode.kernel.abi.v2/command-request",
        &serde_json::json!({
            "abiVersion": KERNEL_ABI_V2_VERSION,
            "commandKind": command.kind(),
            "typedCommandData": typed_command_data,
        }),
    )
}

pub fn idempotency_key_hash_v2(
    run_id: &RunId,
    idempotency_key: &str,
) -> Result<IdempotencyKeyHashV2, V2ValidationError> {
    validate_bounded_text("idempotencyKey", idempotency_key)?;
    typed_digest_newtype(
        "deepcode.kernel.abi.v2/idempotency-key",
        &serde_json::json!({"runId":run_id,"idempotencyKey":idempotency_key}),
    )
}

pub fn workspace_binding_digest_v2(
    platform: PlatformV2,
    canonical_root_utf8: &str,
) -> Result<WorkspaceBindingDigestV2, V2ValidationError> {
    validate_private_canonical_path(platform, "canonicalRootUtf8", canonical_root_utf8)?;
    typed_digest_newtype(
        "deepcode.kernel.abi.v2/workspace-binding",
        &serde_json::json!({
            "platform":platform,
            "canonicalRootUtf8":canonical_root_utf8,
        }),
    )
}

pub fn settings_ceiling_digest_v2(
    settings: &Value,
) -> Result<SettingsCeilingDigestV2, V2ValidationError> {
    if !settings.is_object() {
        return Err(invalid_value("settingsCeiling", "must be a JSON object"));
    }
    typed_digest_newtype("deepcode.kernel.abi.v2/settings-ceiling", settings)
}

pub fn invocation_policy_evaluation_digest_v2(
    run_id: &RunId,
    control_epoch: ControlEpoch,
    tool_id: &ToolIdV2,
    context_ref: &ToolContextRefV2,
    settings_digest: &SettingsCeilingDigestV2,
    lease: Option<&CapabilityLeaseRefV2>,
) -> Result<PolicyEvaluationDigestV2, V2ValidationError> {
    typed_digest_newtype(
        "deepcode.kernel.abi.v2/invocation-policy-evaluation",
        &serde_json::json!({
            "runId":run_id,
            "controlEpoch":control_epoch,
            "toolId":tool_id,
            "toolContextRef":context_ref,
            "settingsDigest":settings_digest,
            "authority":match lease {
                Some(lease) => serde_json::json!({
                    "kind":"planAction",
                    "lease":lease,
                }),
                None => serde_json::json!({"kind":"contextRead"}),
            },
        }),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn target_revalidation_digest_v2(
    run_id: &RunId,
    operation_id: &OperationId,
    invocation_id: &InvocationId,
    attempt_id: &AttemptId,
    tool_id: &ToolIdV2,
    resource_id: &ResourceId,
    workspace_binding_digest: &WorkspaceBindingDigestV2,
    canonical_private_target: &CanonicalPrivateTargetV2,
    pre_effect_observation: &TargetRevalidationObservationV2,
) -> Result<TargetRevalidationDigestV2, V2ValidationError> {
    typed_digest_newtype(
        "deepcode.kernel.abi.v2/target-revalidation",
        &serde_json::json!({
            "runId":run_id,
            "operationId":operation_id,
            "invocationId":invocation_id,
            "attemptId":attempt_id,
            "toolId":tool_id,
            "resourceId":resource_id,
            "workspaceBindingDigest":workspace_binding_digest,
            "canonicalPrivateTarget":canonical_private_target,
            "preEffectObservation":pre_effect_observation,
        }),
    )
}

pub fn target_revalidation_set_digest_v2(
    run_id: &RunId,
    operation_id: &OperationId,
    invocation_id: &InvocationId,
    attempt_id: &AttemptId,
    revalidations: &[(&ResourceId, &FactId, &TargetRevalidationDigestV2)],
) -> Result<TargetRevalidationSetDigestV2, V2ValidationError> {
    if !revalidations
        .windows(2)
        .all(|pair| pair[0].0.as_str().as_bytes() < pair[1].0.as_str().as_bytes())
    {
        return Err(invalid_value(
            "revalidations",
            "must be sorted and unique by ResourceId",
        ));
    }
    typed_digest_newtype(
        "deepcode.kernel.abi.v2/target-revalidation-set",
        &serde_json::json!({
            "runId":run_id,
            "operationId":operation_id,
            "invocationId":invocation_id,
            "attemptId":attempt_id,
            "revalidations":revalidations.iter().map(|(resource_id,fact_id,digest)| {
                serde_json::json!({
                    "resourceId":resource_id,
                    "revalidationFactId":fact_id,
                    "targetRevalidationDigest":digest,
                })
            }).collect::<Vec<_>>(),
        }),
    )
}

pub fn content_digest_v2(bytes: &[u8]) -> ContentDigestV2 {
    let mut hasher = Sha256::new();
    hasher.update(b"deepcode.kernel.observation.v2/content");
    hasher.update([0]);
    hasher.update(bytes);
    DigestFromRaw::from_raw_digest(hasher.finalize().into())
}

pub fn collection_digest_v2<T: Serialize>(
    value: &T,
) -> Result<CollectionDigestV2, V2ValidationError> {
    typed_digest_newtype("deepcode.kernel.observation.v2/collection", value)
}

pub fn resource_state_digest_v2(
    value: &ResourceStateV2,
) -> Result<ResourceStateDigestV2, V2ValidationError> {
    typed_digest_newtype("deepcode.kernel.observation.v2/resource-state", value)
}

pub fn query_digest_v2<T: Serialize>(value: &T) -> Result<QueryDigestV2, V2ValidationError> {
    typed_digest_newtype("deepcode.kernel.observation.v2/query", value)
}

pub fn network_target_digest_v2<T: Serialize>(
    value: &T,
) -> Result<NetworkTargetObservationDigestV2, V2ValidationError> {
    typed_digest_newtype("deepcode.kernel.observation.v2/network-target", value)
}

pub fn network_response_digest_v2<T: Serialize>(
    value: &T,
) -> Result<NetworkResponseDigestV2, V2ValidationError> {
    typed_digest_newtype("deepcode.kernel.observation.v2/network-response", value)
}

pub fn executor_evidence_digest_v2<T: Serialize>(
    value: &T,
) -> Result<ExecutorEvidenceDigestV2, V2ValidationError> {
    typed_digest_newtype("deepcode.kernel.abi.v2/executor-evidence", value)
}

pub fn canonical_json_bytes_v2(value: &Value) -> Result<Vec<u8>, V2ValidationError> {
    let mut output = Vec::new();
    write_canonical_json(value, &mut output, 0)?;
    Ok(output)
}

fn write_canonical_json(
    value: &Value,
    output: &mut Vec<u8>,
    depth: usize,
) -> Result<(), V2ValidationError> {
    if depth > MAX_CANONICAL_DEPTH {
        return Err(invalid_value(
            "digestPreimage",
            "maximum canonical nesting depth exceeded",
        ));
    }
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(value) => output.extend_from_slice(if *value { b"true" } else { b"false" }),
        Value::Number(number) => {
            write_canonical_number(number, output)?;
        }
        Value::String(value) => {
            output.extend_from_slice(
                serde_json::to_string(value)
                    .map_err(|_| invalid_value("digestPreimage", "string serialization failed"))?
                    .as_bytes(),
            );
        }
        Value::Array(values) => {
            output.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                write_canonical_json(value, output, depth + 1)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            output.push(b'{');
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                output.extend_from_slice(
                    serde_json::to_string(key)
                        .map_err(|_| invalid_value("digestPreimage", "key serialization failed"))?
                        .as_bytes(),
                );
                output.push(b':');
                write_canonical_json(&values[*key], output, depth + 1)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

fn write_canonical_number(
    number: &serde_json::Number,
    output: &mut Vec<u8>,
) -> Result<(), V2ValidationError> {
    let value = cross_language_safe_integer_number_v2(number).ok_or_else(|| {
        invalid_value(
            "digestPreimage",
            "must contain only cross-language safe integer numbers",
        )
    })?;
    output.extend_from_slice(value.to_string().as_bytes());
    Ok(())
}

pub(crate) fn cross_language_safe_integer_number_v2(number: &serde_json::Number) -> Option<i64> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    if let Some(value) = number.as_i64() {
        return (value.unsigned_abs() <= MAX_SAFE_INTEGER).then_some(value);
    }
    if let Some(value) = number.as_u64() {
        return (value <= MAX_SAFE_INTEGER).then_some(value as i64);
    }
    let value = number.as_f64()?;
    (value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER as f64)
        .then_some(value as i64)
}

pub(crate) const fn invalid_value(field: &'static str, reason: &'static str) -> V2ValidationError {
    V2ValidationError::InvalidValue { field, reason }
}

pub(crate) const fn empty_field(field: &'static str) -> V2ValidationError {
    V2ValidationError::EmptyField { field }
}

pub(crate) const fn zero_value(field: &'static str) -> V2ValidationError {
    V2ValidationError::ZeroValue { field }
}

pub(crate) const fn field_too_large(
    field: &'static str,
    maximum_bytes: usize,
) -> V2ValidationError {
    V2ValidationError::FieldTooLarge {
        field,
        maximum_bytes,
    }
}

pub(crate) const fn too_many_values(field: &'static str, maximum: usize) -> V2ValidationError {
    V2ValidationError::TooManyValues { field, maximum }
}

fn validate_bounded_text(field: &'static str, value: &str) -> Result<(), V2ValidationError> {
    if value.is_empty() {
        return Err(empty_field(field));
    }
    if value.len() > MAX_TEXT_BYTES_V2 {
        return Err(field_too_large(field, MAX_TEXT_BYTES_V2));
    }
    if value.contains('\0') || value.chars().any(char::is_control) {
        return Err(invalid_value(field, "contains a control character"));
    }
    Ok(())
}

fn validate_private_canonical_path(
    platform: PlatformV2,
    field: &'static str,
    value: &str,
) -> Result<(), V2ValidationError> {
    let (absolute, components): (bool, Box<dyn Iterator<Item = &str>>) = match platform {
        PlatformV2::Macos | PlatformV2::Linux => {
            (value.starts_with('/'), Box::new(value.split('/').skip(1)))
        }
        PlatformV2::Windows => {
            let drive_absolute = value.as_bytes().get(1) == Some(&b':')
                && value.as_bytes().get(2) == Some(&b'/')
                && value
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphabetic);
            let unc_absolute = value.starts_with("//");
            (
                drive_absolute || unc_absolute,
                if drive_absolute {
                    Box::new(value[3..].split('/'))
                } else {
                    Box::new(value[2..].split('/'))
                },
            )
        }
    };
    let malformed_component = components
        .filter(|part| !part.is_empty())
        .any(|part| part == "." || part == "..");
    if value.is_empty()
        || value.contains('\0')
        || value.contains('\\')
        || !absolute
        || malformed_component
    {
        return Err(invalid_value(
            field,
            "must be an absolute normalized slash-separated UTF-8 path",
        ));
    }
    Ok(())
}

fn strictly_sorted_unique_ids(values: &[&ResourceId]) -> bool {
    values
        .windows(2)
        .all(|pair| pair[0].as_str().as_bytes() < pair[1].as_str().as_bytes())
}

pub(crate) fn validate_identity(field: &'static str, value: &str) -> Result<(), V2ValidationError> {
    if value.is_empty() {
        return Err(empty_field(field));
    }
    if value.len() > MAX_ID_BYTES_V2 {
        return Err(field_too_large(field, MAX_ID_BYTES_V2));
    }
    if value.trim() != value || value.chars().any(char::is_control) {
        return Err(invalid_value(
            field,
            "contains surrounding whitespace or control characters",
        ));
    }
    Ok(())
}

fn validate_digest(field: &'static str, value: &str) -> Result<(), V2ValidationError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(invalid_value(field, "must start with sha256:"));
    };
    if hex.len() != 64
        || !hex
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(invalid_value(
            field,
            "must contain exactly 64 lowercase hexadecimal characters",
        ));
    }
    Ok(())
}

fn validate_recorded_at(value: &str) -> Result<(), V2ValidationError> {
    let bytes = value.as_bytes();
    let shape = bytes.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
        });
    if !shape {
        return Err(invalid_value(
            "recordedAt",
            "must be YYYY-MM-DDTHH:MM:SS.sssZ",
        ));
    }
    let parse = |range: std::ops::Range<usize>| {
        std::str::from_utf8(&bytes[range])
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
    };
    let year = parse(0..4).unwrap_or(0);
    let month = parse(5..7).unwrap_or(0);
    let day = parse(8..10).unwrap_or(0);
    let hour = parse(11..13).unwrap_or(99);
    let minute = parse(14..16).unwrap_or(99);
    let second = parse(17..19).unwrap_or(99);
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => 0,
    };
    if year == 0 || !(1..=days_in_month).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return Err(invalid_value(
            "recordedAt",
            "contains an out-of-range component",
        ));
    }
    Ok(())
}

fn encode_lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[(byte >> 4) as usize]));
        output.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    output
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
        formatter.write_str("strict JSON without duplicate object keys")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        let number = serde_json::Number::from(value);
        cross_language_safe_integer_number_v2(&number)
            .map(|value| StrictJsonValue(Value::Number(value.into())))
            .ok_or_else(|| E::custom("JSON numbers must be cross-language safe integers"))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        let number = serde_json::Number::from(value);
        cross_language_safe_integer_number_v2(&number)
            .map(|value| StrictJsonValue(Value::Number(value.into())))
            .ok_or_else(|| E::custom("JSON numbers must be cross-language safe integers"))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        let number = serde_json::Number::from_f64(value)
            .ok_or_else(|| E::custom("non-finite JSON numbers are unsupported"))?;
        cross_language_safe_integer_number_v2(&number)
            .map(|value| StrictJsonValue(Value::Number(value.into())))
            .ok_or_else(|| E::custom("JSON numbers must be cross-language safe integers"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::String(value.to_owned())))
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

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0));
        while let Some(value) = sequence.next_element::<StrictJsonValue>()? {
            values.push(value.0);
        }
        Ok(StrictJsonValue(Value::Array(values)))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut seen = BTreeSet::new();
        let mut values = serde_json::Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(serde::de::Error::custom(format!(
                    "duplicate JSON object key `{key}`"
                )));
            }
            values.insert(key, map.next_value::<StrictJsonValue>()?.0);
        }
        Ok(StrictJsonValue(Value::Object(values)))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum V2ValidationError {
    #[error("unsupported ABI version `{actual}`")]
    UnsupportedAbiVersion { actual: String },
    #[error("`{field}` must not be empty")]
    EmptyField { field: &'static str },
    #[error("`{field}` must be greater than zero")]
    ZeroValue { field: &'static str },
    #[error("`{field}` exceeds {maximum_bytes} bytes")]
    FieldTooLarge {
        field: &'static str,
        maximum_bytes: usize,
    },
    #[error("`{field}` exceeds {maximum} values")]
    TooManyValues { field: &'static str, maximum: usize },
    #[error("`{field}` {reason}")]
    InvalidValue {
        field: &'static str,
        reason: &'static str,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum V2WireDecodeError {
    #[error("payload exceeds {maximum} bytes")]
    PayloadTooLarge { maximum: usize },
    #[error("invalid JSON")]
    InvalidJson,
    #[error("duplicate JSON key")]
    DuplicateKey,
    #[error("missing ABI version")]
    MissingAbiVersion,
    #[error("invalid ABI version")]
    InvalidAbiVersion,
    #[error("unsupported ABI version `{received}`")]
    UnsupportedAbiVersion { received: String },
    #[error("invalid v2 payload: {0}")]
    InvalidPayload(String),
    #[error(transparent)]
    Validation(#[from] V2ValidationError),
}
