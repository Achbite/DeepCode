use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::v2::{
    field_too_large, invalid_value, typed_digest, validate_identity, ControlEpoch,
    ResourceAccessV2, V2ValidationError,
};

pub const KERNEL_TOOL_REGISTRY_VERSION_V2: &str = "deepcode.kernel.tools.v2";
pub const TOOL_INVENTORY_FORMAT_V2: &str = "deepcode.kernel.tool-inventory.v2";
pub const TOOL_CONTEXT_FORMAT_V2: &str = "deepcode.kernel.tool-context.v2";
pub const MAX_TOOL_ID_BYTES_V2: usize = 128;
pub const MAX_RAW_TOOL_ARGUMENT_BYTES_V2: usize = 1024 * 1024;
pub const MAX_TOOL_SCHEMA_BYTES_V2: usize = 64 * 1024;
pub const MAX_TOOL_PROMPT_BYTES_V2: usize = 32 * 1024;
pub const MAX_TOOL_DESCRIPTION_BYTES_V2: usize = 4 * 1024;
pub const MAX_TOOL_CONTEXT_BYTES_V2: usize = 2 * 1024 * 1024;
pub const MAX_TOOL_CONTEXT_ITEMS_V2: usize = 256;
const MAX_JSON_DEPTH_V2: usize = 32;

pub const KERNEL_TOOL_PROMPT_V2: &str = "\
The Kernel is the sole authority for the tools listed below. Call only a tool \
present in this context and provide one JSON object matching its input schema. \
Tool arguments are untrusted intent: the Kernel resolves resources, checks the \
active capability and current tool availability, and records execution facts. \
Never claim that a tool ran from narration alone. Treat an awaiting-capability, \
denied, stale-context, failed, cancelled, or indeterminate result as non-success.";

macro_rules! identity_type {
    ($name:ident, $field:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, V2ValidationError> {
                let value = value.into();
                validate_identity($field, &value)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

identity_type!(WorkspaceBindingRefV2, "workspaceBindingRef");
identity_type!(PlanRevisionV2, "planRevision");
identity_type!(PlanActionIdV2, "planActionId");
identity_type!(CapabilityScopePreviewIdV2, "scopePreviewId");
identity_type!(CapabilityLeaseIdV2, "capabilityLeaseId");
identity_type!(FactQueryContinuationV2, "factQueryContinuation");
identity_type!(TrustPolicyIdV2, "trustPolicyId");

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct RunCapabilityV2(String);

impl RunCapabilityV2 {
    pub fn new(value: impl Into<String>) -> Result<Self, V2ValidationError> {
        let value = value.into();
        validate_secret_token("runCapability", &value)?;
        Ok(Self(value))
    }

    pub fn expose_to_transport(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for RunCapabilityV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RunCapabilityV2([REDACTED])")
    }
}

impl<'de> Deserialize<'de> for RunCapabilityV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ToolIdV2(String);

impl ToolIdV2 {
    pub fn parse(value: impl Into<String>) -> Result<Self, V2ValidationError> {
        let value = value.into();
        if value.is_empty() || value.len() > MAX_TOOL_ID_BYTES_V2 {
            return Err(invalid_value("toolId", "must contain 1..=128 ASCII bytes"));
        }
        let mut segments = value.split('.');
        let mut count = 0usize;
        for segment in segments.by_ref() {
            count += 1;
            let bytes = segment.as_bytes();
            if bytes.is_empty()
                || !bytes[0].is_ascii_lowercase()
                || !bytes.iter().skip(1).all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'_' | b'-')
                })
            {
                return Err(invalid_value(
                    "toolId",
                    "must use lowercase namespaced segments",
                ));
            }
        }
        if count < 2 {
            return Err(invalid_value(
                "toolId",
                "must contain at least one namespace separator",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ToolIdV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ToolIdV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::parse(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

macro_rules! digest_type {
    ($name:ident, $field:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, V2ValidationError> {
                let value = value.into();
                validate_sha256($field, &value)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            fn from_raw_digest(bytes: [u8; 32]) -> Self {
                Self(format!("sha256:{}", encode_lower_hex(&bytes)))
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                Self::parse(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }
    };
}

digest_type!(ToolContractDigestV2, "toolContractDigest");
digest_type!(ToolCatalogDigestV2, "toolCatalogDigest");
digest_type!(ToolContextDigestV2, "toolContextDigest");
digest_type!(CanonicalArgumentsDigestV2, "canonicalArgumentsDigest");
digest_type!(CapabilityScopeDigestV2, "capabilityScopeDigest");
digest_type!(ExactInvocationDigestV2, "exactInvocationDigest");
digest_type!(
    CapabilityAuthorizationDigestV2,
    "capabilityAuthorizationDigest"
);
digest_type!(TrustLeaseDigestV2, "trustLeaseDigest");

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ToolContextVersionV2(u64);

impl ToolContextVersionV2 {
    pub fn new(value: u64) -> Result<Self, V2ValidationError> {
        if value == 0 {
            return Err(invalid_value("contextVersion", "must be greater than zero"));
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for ToolContextVersionV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(u64::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct CapabilityLeaseVersionV2(u64);

impl CapabilityLeaseVersionV2 {
    pub fn new(value: u64) -> Result<Self, V2ValidationError> {
        if value == 0 {
            return Err(invalid_value(
                "capabilityLeaseVersion",
                "must be greater than zero",
            ));
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for CapabilityLeaseVersionV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(u64::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct RawToolArgumentsV2(Value);

impl RawToolArgumentsV2 {
    pub fn new(value: Value) -> Result<Self, V2ValidationError> {
        if !value.is_object() {
            return Err(invalid_value("rawArguments", "must be a JSON object"));
        }
        validate_json_value("rawArguments", &value, 0, MAX_RAW_TOOL_ARGUMENT_BYTES_V2)?;
        Ok(Self(value))
    }

    pub fn as_value(&self) -> &Value {
        &self.0
    }

    pub fn into_value(self) -> Value {
        self.0
    }
}

impl<'de> Deserialize<'de> for RawToolArgumentsV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(Value::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ToolInputSchemaV2(Value);

impl ToolInputSchemaV2 {
    pub fn new(value: Value) -> Result<Self, V2ValidationError> {
        if !value.is_object() {
            return Err(invalid_value("inputSchema", "must be a JSON object"));
        }
        validate_json_value("inputSchema", &value, 0, MAX_TOOL_SCHEMA_BYTES_V2)?;
        Ok(Self(value))
    }

    pub fn as_value(&self) -> &Value {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ToolInputSchemaV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(Value::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolAvailabilityV2 {
    Ready,
    Disabled,
    Revoked,
    Unavailable,
}

impl ToolAvailabilityV2 {
    pub const fn provider_visible(self) -> bool {
        matches!(self, Self::Ready)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolEffectClassV2 {
    Read,
    Mutation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolEffectScopeV2 {
    WorkspaceRead,
    WorkspaceWrite,
    RepositoryRead,
    RepositoryIndexWrite,
    RepositoryHistoryWrite,
    NetworkRead,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolRiskV2 {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolDescriptorV2 {
    pub tool_id: ToolIdV2,
    pub description: String,
    pub input_schema: ToolInputSchemaV2,
    pub prompt_template: String,
    pub availability: ToolAvailabilityV2,
    pub effect_class: ToolEffectClassV2,
    pub effect_scope: ToolEffectScopeV2,
    pub risk: ToolRiskV2,
    pub contract_digest: ToolContractDigestV2,
}

impl ToolDescriptorV2 {
    #[allow(clippy::too_many_arguments)]
    pub fn materialize(
        tool_id: ToolIdV2,
        description: String,
        input_schema: ToolInputSchemaV2,
        prompt_template: String,
        availability: ToolAvailabilityV2,
        effect_class: ToolEffectClassV2,
        effect_scope: ToolEffectScopeV2,
        risk: ToolRiskV2,
    ) -> Result<Self, V2ValidationError> {
        let mut descriptor = Self {
            tool_id,
            description,
            input_schema,
            prompt_template,
            availability,
            effect_class,
            effect_scope,
            risk,
            contract_digest: ToolContractDigestV2::parse(
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            )?,
        };
        descriptor.contract_digest = tool_contract_digest_v2(&descriptor)?;
        descriptor.validate()?;
        Ok(descriptor)
    }

    pub fn validate(&self) -> Result<(), V2ValidationError> {
        validate_bounded_text(
            "tool.description",
            &self.description,
            MAX_TOOL_DESCRIPTION_BYTES_V2,
        )?;
        validate_bounded_text(
            "tool.promptTemplate",
            &self.prompt_template,
            MAX_TOOL_PROMPT_BYTES_V2,
        )?;
        if tool_contract_digest_v2(self)? != self.contract_digest {
            return Err(invalid_value(
                "tool.contractDigest",
                "does not match descriptor content",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolInventoryV2 {
    pub format_version: String,
    pub catalog_version: String,
    pub catalog_digest: ToolCatalogDigestV2,
    pub tools: Vec<ToolDescriptorV2>,
}

impl ToolInventoryV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if self.format_version != TOOL_INVENTORY_FORMAT_V2 {
            return Err(invalid_value(
                "formatVersion",
                "must be deepcode.kernel.tool-inventory.v2",
            ));
        }
        if self.catalog_version != KERNEL_TOOL_REGISTRY_VERSION_V2 {
            return Err(invalid_value(
                "catalogVersion",
                "must be deepcode.kernel.tools.v2",
            ));
        }
        validate_descriptor_order(&self.tools, false)?;
        if tool_catalog_digest_v2(&self.tools)? != self.catalog_digest {
            return Err(invalid_value(
                "catalogDigest",
                "does not match descriptor leaves",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolContextRefV2 {
    pub context_version: ToolContextVersionV2,
    pub catalog_digest: ToolCatalogDigestV2,
    pub context_digest: ToolContextDigestV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolContextBundleV2 {
    pub format_version: String,
    pub context_version: ToolContextVersionV2,
    pub catalog_digest: ToolCatalogDigestV2,
    pub context_digest: ToolContextDigestV2,
    pub fixed_prompt: String,
    pub tools: Vec<ToolDescriptorV2>,
}

impl ToolContextBundleV2 {
    pub fn context_ref(&self) -> ToolContextRefV2 {
        ToolContextRefV2 {
            context_version: self.context_version,
            catalog_digest: self.catalog_digest.clone(),
            context_digest: self.context_digest.clone(),
        }
    }

    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if self.format_version != TOOL_CONTEXT_FORMAT_V2 {
            return Err(invalid_value(
                "formatVersion",
                "must be deepcode.kernel.tool-context.v2",
            ));
        }
        if self.fixed_prompt != KERNEL_TOOL_PROMPT_V2 {
            return Err(invalid_value(
                "fixedPrompt",
                "must equal the compiled Kernel prompt",
            ));
        }
        validate_descriptor_order(&self.tools, true)?;
        if tool_context_digest_v2(
            self.context_version,
            &self.catalog_digest,
            &self.fixed_prompt,
            &self.tools,
        )? != self.context_digest
        {
            return Err(invalid_value(
                "contextDigest",
                "does not match context content",
            ));
        }
        let encoded =
            serde_json::to_vec(self).map_err(|_| invalid_value("toolContext", "must serialize"))?;
        if encoded.len() > MAX_TOOL_CONTEXT_BYTES_V2 {
            return Err(field_too_large("toolContext", MAX_TOOL_CONTEXT_BYTES_V2));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityLeaseRefV2 {
    pub lease_id: CapabilityLeaseIdV2,
    pub version: CapabilityLeaseVersionV2,
    pub scope_digest: CapabilityScopeDigestV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RequestedResourceV2 {
    WorkspacePath {
        path: String,
        access: ResourceAccessV2,
    },
    Repository {
        area: crate::v2::RepositoryAreaV2,
    },
    NetworkUrl {
        url: String,
    },
    NetworkQuery {
        query: String,
    },
    ExactInvocation {
        invocation_digest: ExactInvocationDigestV2,
    },
}

impl RequestedResourceV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        match self {
            Self::WorkspacePath { path, .. } => {
                validate_bounded_text("requestedResource.path", path, 16 * 1024)
            }
            Self::NetworkUrl { url } => {
                validate_bounded_text("requestedResource.url", url, 16 * 1024)
            }
            Self::NetworkQuery { query } => {
                validate_bounded_text("requestedResource.query", query, 16 * 1024)
            }
            Self::Repository { .. } | Self::ExactInvocation { .. } => Ok(()),
        }
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
pub enum ToolIntentAuthorityV2 {
    PlanAction {
        plan_revision: PlanRevisionV2,
        plan_action_id: PlanActionIdV2,
        lease: Option<CapabilityLeaseRefV2>,
    },
    ContextRead {
        purpose: String,
    },
}

impl ToolIntentAuthorityV2 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        match self {
            Self::PlanAction { .. } => Ok(()),
            Self::ContextRead { purpose } => {
                validate_bounded_text("contextRead.purpose", purpose, 1024)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunAuthorityV2 {
    pub run_capability: RunCapabilityV2,
    pub expected_control_epoch: ControlEpoch,
}

pub fn tool_contract_digest_v2(
    descriptor: &ToolDescriptorV2,
) -> Result<ToolContractDigestV2, V2ValidationError> {
    Ok(ToolContractDigestV2::from_raw_digest(typed_digest(
        "deepcode.kernel.tools.v2/contract",
        &serde_json::json!({
            "toolId": descriptor.tool_id,
            "description": descriptor.description,
            "inputSchema": descriptor.input_schema,
            "promptTemplate": descriptor.prompt_template,
            "availability": descriptor.availability,
            "effectClass": descriptor.effect_class,
            "effectScope": descriptor.effect_scope,
            "risk": descriptor.risk,
        }),
    )?))
}

pub fn tool_catalog_digest_v2(
    tools: &[ToolDescriptorV2],
) -> Result<ToolCatalogDigestV2, V2ValidationError> {
    let leaves = tools
        .iter()
        .map(|tool| {
            serde_json::json!({
                "toolId": tool.tool_id,
                "contractDigest": tool.contract_digest,
            })
        })
        .collect::<Vec<_>>();
    Ok(ToolCatalogDigestV2::from_raw_digest(typed_digest(
        "deepcode.kernel.tools.v2/catalog",
        &serde_json::json!({
            "catalogVersion": KERNEL_TOOL_REGISTRY_VERSION_V2,
            "tools": leaves,
        }),
    )?))
}

pub fn tool_context_digest_v2(
    context_version: ToolContextVersionV2,
    catalog_digest: &ToolCatalogDigestV2,
    fixed_prompt: &str,
    tools: &[ToolDescriptorV2],
) -> Result<ToolContextDigestV2, V2ValidationError> {
    let leaves = tools
        .iter()
        .map(|tool| {
            serde_json::json!({
                "toolId": tool.tool_id,
                "contractDigest": tool.contract_digest,
            })
        })
        .collect::<Vec<_>>();
    Ok(ToolContextDigestV2::from_raw_digest(typed_digest(
        "deepcode.kernel.tool-context.v2/bundle",
        &serde_json::json!({
            "formatVersion": TOOL_CONTEXT_FORMAT_V2,
            "contextVersion": context_version,
            "catalogDigest": catalog_digest,
            "fixedPrompt": fixed_prompt,
            "tools": leaves,
        }),
    )?))
}

pub fn canonical_arguments_digest_v2(
    tool_id: &ToolIdV2,
    canonical_arguments: &Value,
) -> Result<CanonicalArgumentsDigestV2, V2ValidationError> {
    validate_json_value(
        "canonicalArguments",
        canonical_arguments,
        0,
        MAX_RAW_TOOL_ARGUMENT_BYTES_V2,
    )?;
    Ok(CanonicalArgumentsDigestV2::from_raw_digest(typed_digest(
        "deepcode.kernel.tools.v2/canonical-arguments",
        &serde_json::json!({
            "toolId": tool_id,
            "arguments": canonical_arguments,
        }),
    )?))
}

pub fn capability_scope_digest_v2<T: Serialize>(
    scope: &T,
) -> Result<CapabilityScopeDigestV2, V2ValidationError> {
    Ok(CapabilityScopeDigestV2::from_raw_digest(typed_digest(
        "deepcode.kernel.authority.v2/capability-scope",
        scope,
    )?))
}

pub fn capability_authorization_digest_v2<T: Serialize>(
    authorization: &T,
) -> Result<CapabilityAuthorizationDigestV2, V2ValidationError> {
    Ok(CapabilityAuthorizationDigestV2::from_raw_digest(
        typed_digest(
            "deepcode.kernel.authority.v2/capability-authorization",
            authorization,
        )?,
    ))
}

pub fn exact_invocation_digest_v2<T: Serialize>(
    invocation: &T,
) -> Result<ExactInvocationDigestV2, V2ValidationError> {
    Ok(ExactInvocationDigestV2::from_raw_digest(typed_digest(
        "deepcode.kernel.authority.v2/exact-invocation",
        invocation,
    )?))
}

pub fn trust_lease_digest_v2<T: Serialize>(
    trust_lease: &T,
) -> Result<TrustLeaseDigestV2, V2ValidationError> {
    Ok(TrustLeaseDigestV2::from_raw_digest(typed_digest(
        "deepcode.kernel.authority.v2/trust-lease",
        trust_lease,
    )?))
}

fn validate_descriptor_order(
    tools: &[ToolDescriptorV2],
    ready_only: bool,
) -> Result<(), V2ValidationError> {
    if tools.len() > MAX_TOOL_CONTEXT_ITEMS_V2 {
        return Err(invalid_value("tools", "contains too many descriptors"));
    }
    let mut previous: Option<&ToolIdV2> = None;
    for tool in tools {
        tool.validate()?;
        if ready_only && !tool.availability.provider_visible() {
            return Err(invalid_value(
                "tools",
                "provider context may contain only ready tools",
            ));
        }
        if previous.is_some_and(|value| value >= &tool.tool_id) {
            return Err(invalid_value(
                "tools",
                "must be strictly sorted by unique toolId",
            ));
        }
        previous = Some(&tool.tool_id);
    }
    Ok(())
}

fn validate_json_value(
    field: &'static str,
    value: &Value,
    depth: usize,
    maximum_bytes: usize,
) -> Result<(), V2ValidationError> {
    if depth > MAX_JSON_DEPTH_V2 {
        return Err(invalid_value(field, "JSON nesting exceeds 32"));
    }
    match value {
        Value::Array(values) => {
            for value in values {
                validate_json_value(field, value, depth + 1, maximum_bytes)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if key.len() > 1024 || key.chars().any(char::is_control) {
                    return Err(invalid_value(field, "contains an invalid object key"));
                }
                validate_json_value(field, value, depth + 1, maximum_bytes)?;
            }
        }
        Value::String(value) if value.len() > maximum_bytes => {
            return Err(field_too_large(field, maximum_bytes));
        }
        _ => {}
    }
    let encoded = serde_json::to_vec(value).map_err(|_| invalid_value(field, "must serialize"))?;
    if encoded.len() > maximum_bytes {
        return Err(field_too_large(field, maximum_bytes));
    }
    Ok(())
}

fn validate_bounded_text(
    field: &'static str,
    value: &str,
    maximum_bytes: usize,
) -> Result<(), V2ValidationError> {
    if value.is_empty() {
        return Err(invalid_value(field, "must not be empty"));
    }
    if value.len() > maximum_bytes {
        return Err(field_too_large(field, maximum_bytes));
    }
    if value.chars().any(char::is_control) {
        return Err(invalid_value(field, "must not contain control characters"));
    }
    Ok(())
}

fn validate_secret_token(field: &'static str, value: &str) -> Result<(), V2ValidationError> {
    if value.len() < 16 || value.len() > 2048 {
        return Err(invalid_value(
            field,
            "must contain 16..=2048 printable non-whitespace ASCII bytes",
        ));
    }
    if !value
        .as_bytes()
        .iter()
        .all(|byte| (0x21..=0x7e).contains(byte))
    {
        return Err(invalid_value(
            field,
            "must contain printable non-whitespace ASCII only",
        ));
    }
    Ok(())
}

fn validate_sha256(field: &'static str, value: &str) -> Result<(), V2ValidationError> {
    let valid = value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .as_bytes()
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    });
    if valid {
        Ok(())
    } else {
        Err(invalid_value(field, "must be sha256:<64 lowercase hex>"))
    }
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
