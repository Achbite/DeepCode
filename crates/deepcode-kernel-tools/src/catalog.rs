use crate::registrations::{builtin_tool_registrations, KernelToolRegistration};
use crate::{
    KernelToolCatalogSnapshot, KernelToolCatalogTool, KernelToolContract, ToolPermissionMode,
};
use deepcode_kernel_abi::v2::V2ValidationError;
use deepcode_kernel_abi::{
    canonical_arguments_digest_v2, render_kernel_tool_prompt_v2, tool_catalog_digest_v2,
    tool_context_digest_v2, CanonicalArgumentsDigestV2, RawToolArgumentsV2, ToolAvailabilityV2,
    ToolContextBundleV2, ToolContextVersionV2, ToolIdV2, ToolInventoryV2,
    KERNEL_TOOL_REGISTRY_VERSION_V2, TOOL_CONTEXT_FORMAT_V2, TOOL_INVENTORY_FORMAT_V2,
};
use serde_json::Value;
use std::collections::BTreeMap;
use thiserror::Error;

pub const TOOL_REGISTRY_VERSION: &str = KERNEL_TOOL_REGISTRY_VERSION_V2;

#[derive(Debug, Error)]
pub enum KernelToolRegistryErrorV2 {
    #[error("tool `{0}` is not registered")]
    ToolNotRegistered(String),
    #[error("tool `{0}` is not ready")]
    ToolUnavailable(String),
    #[error("runtime availability for `{0}` may only shrink ready to revoked or unavailable")]
    InvalidRuntimeAvailability(String),
    #[error("tool `{tool_id}` arguments are invalid: {reason}")]
    InvalidArguments { tool_id: String, reason: String },
    #[error(transparent)]
    Contract(#[from] V2ValidationError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalToolInvocationV2 {
    pub tool_id: ToolIdV2,
    pub arguments: Value,
    pub arguments_digest: CanonicalArgumentsDigestV2,
    pub invocation: crate::ToolInvocationInputV4,
}

#[derive(Debug, Clone)]
pub struct KernelToolRegistry {
    registrations: BTreeMap<&'static str, KernelToolRegistration>,
    operation_index: BTreeMap<crate::ToolOperationKind, &'static str>,
}

impl Default for KernelToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl KernelToolRegistry {
    pub fn new() -> Self {
        let mut registrations = BTreeMap::new();
        let mut operation_index = BTreeMap::new();
        for registration in builtin_tool_registrations() {
            let tool_id = registration.tool_id();
            let operation_kind = registration.operation_kind();
            assert!(
                registrations.insert(tool_id, registration).is_none(),
                "duplicate canonical Kernel tool registration: {tool_id}"
            );
            assert!(
                operation_index.insert(operation_kind, tool_id).is_none(),
                "duplicate Kernel operation kind registration: {}",
                operation_kind.wire_name()
            );
        }
        let ready = registrations
            .values()
            .filter(|registration| {
                registration.descriptor_v2.availability == ToolAvailabilityV2::Ready
            })
            .count();
        assert_eq!(
            registrations.len(),
            19,
            "compiled Kernel registry must contain the frozen 19 registrations"
        );
        assert_eq!(
            ready, 13,
            "compiled Kernel registry must expose exactly 13 ready tools"
        );
        let executable = registrations
            .values()
            .filter(|registration| registration.executor_binding.is_some())
            .count();
        assert_eq!(
            executable, 13,
            "only the frozen 13 ready tools may install executors"
        );
        let disabled = registrations
            .values()
            .filter(|registration| {
                registration.descriptor_v2.availability == ToolAvailabilityV2::Disabled
            })
            .map(KernelToolRegistration::tool_id)
            .collect::<Vec<_>>();
        assert_eq!(
            disabled,
            vec![
                "fs.rename",
                "git.commit",
                "git.diff",
                "git.stage",
                "git.status",
                "git.unstage",
            ],
            "compiled Kernel registry must preserve the frozen six disabled identities"
        );
        for registration in registrations.values() {
            let ready = registration.descriptor_v2.availability == ToolAvailabilityV2::Ready;
            assert_eq!(
                ready,
                registration.executor_binding.is_some()
                    && registration.execution_mode() == crate::OperationExecutionMode::Execute,
                "tool availability and executor binding diverged for {}",
                registration.tool_id()
            );
        }
        Self {
            registrations,
            operation_index,
        }
    }

    pub fn get(&self, tool_id: &str) -> Option<&KernelToolRegistration> {
        self.registrations.get(tool_id)
    }

    pub fn get_by_operation_kind(
        &self,
        operation_kind: crate::ToolOperationKind,
    ) -> Option<&KernelToolRegistration> {
        self.operation_index
            .get(&operation_kind)
            .and_then(|tool_id| self.registrations.get(tool_id))
    }

    pub fn registrations(&self) -> impl Iterator<Item = &KernelToolRegistration> {
        self.registrations.values()
    }

    pub fn get_v2(&self, tool_id: &ToolIdV2) -> Option<&KernelToolRegistration> {
        self.registrations.get(tool_id.as_str())
    }

    pub fn tool_inventory_v2(&self) -> Result<ToolInventoryV2, KernelToolRegistryErrorV2> {
        let tools = self
            .registrations
            .values()
            .map(|registration| registration.descriptor_v2.clone())
            .collect::<Vec<_>>();
        let inventory = ToolInventoryV2 {
            format_version: TOOL_INVENTORY_FORMAT_V2.to_owned(),
            catalog_version: KERNEL_TOOL_REGISTRY_VERSION_V2.to_owned(),
            catalog_digest: tool_catalog_digest_v2(&tools)?,
            tools,
        };
        inventory.validate()?;
        Ok(inventory)
    }

    pub fn tool_context_v2(
        &self,
        context_version: ToolContextVersionV2,
    ) -> Result<ToolContextBundleV2, KernelToolRegistryErrorV2> {
        self.tool_context_v2_with_runtime_availability(context_version, &BTreeMap::new())
    }

    pub fn tool_context_v2_with_runtime_availability(
        &self,
        context_version: ToolContextVersionV2,
        runtime_availability: &BTreeMap<ToolIdV2, ToolAvailabilityV2>,
    ) -> Result<ToolContextBundleV2, KernelToolRegistryErrorV2> {
        for (tool_id, availability) in runtime_availability {
            let registration = self
                .get_v2(tool_id)
                .ok_or_else(|| KernelToolRegistryErrorV2::ToolNotRegistered(tool_id.to_string()))?;
            if registration.descriptor_v2.availability != ToolAvailabilityV2::Ready
                || !matches!(
                    availability,
                    ToolAvailabilityV2::Revoked | ToolAvailabilityV2::Unavailable
                )
            {
                return Err(KernelToolRegistryErrorV2::InvalidRuntimeAvailability(
                    tool_id.to_string(),
                ));
            }
        }
        let inventory = self.tool_inventory_v2()?;
        let tools = self
            .registrations
            .values()
            .filter(|registration| {
                registration.descriptor_v2.availability == ToolAvailabilityV2::Ready
                    && !runtime_availability.contains_key(&registration.descriptor_v2.tool_id)
            })
            .map(|registration| registration.descriptor_v2.clone())
            .collect::<Vec<_>>();
        let fixed_prompt = render_kernel_tool_prompt_v2(&tools)?;
        let context_digest = tool_context_digest_v2(
            context_version,
            &inventory.catalog_digest,
            &fixed_prompt,
            &tools,
        )?;
        let context = ToolContextBundleV2 {
            format_version: TOOL_CONTEXT_FORMAT_V2.to_owned(),
            context_version,
            catalog_digest: inventory.catalog_digest,
            context_digest,
            fixed_prompt,
            tools,
        };
        context.validate()?;
        Ok(context)
    }

    pub fn canonicalize_v2(
        &self,
        tool_id: &ToolIdV2,
        raw_arguments: RawToolArgumentsV2,
    ) -> Result<CanonicalToolInvocationV2, KernelToolRegistryErrorV2> {
        let registration = self
            .get_v2(tool_id)
            .ok_or_else(|| KernelToolRegistryErrorV2::ToolNotRegistered(tool_id.to_string()))?;
        if registration.descriptor_v2.availability != ToolAvailabilityV2::Ready
            || registration.executor_binding.is_none()
        {
            return Err(KernelToolRegistryErrorV2::ToolUnavailable(
                tool_id.to_string(),
            ));
        }
        let invocation = (registration.canonicalize_invocation)(raw_arguments.into_value())
            .map_err(|reason| KernelToolRegistryErrorV2::InvalidArguments {
                tool_id: tool_id.to_string(),
                reason,
            })?;
        let arguments = serde_json::to_value(&invocation)
            .ok()
            .and_then(|value| value.get("arguments").cloned())
            .ok_or_else(|| KernelToolRegistryErrorV2::InvalidArguments {
                tool_id: tool_id.to_string(),
                reason: "private invocation adapter omitted canonical arguments".to_owned(),
            })?;
        let arguments_digest = canonical_arguments_digest_v2(tool_id, &arguments)?;
        Ok(CanonicalToolInvocationV2 {
            tool_id: tool_id.clone(),
            arguments,
            arguments_digest,
            invocation,
        })
    }

    pub fn contract(&self, tool_id: &str) -> Option<KernelToolContract> {
        self.registrations
            .get(tool_id)
            .map(|registration| registration.contract.clone())
    }

    pub fn contracts(&self) -> impl Iterator<Item = KernelToolContract> + '_ {
        self.registrations
            .values()
            .map(|registration| registration.contract.clone())
    }

    pub fn snapshot(&self) -> KernelToolCatalogSnapshot {
        let mut tools = self
            .registrations
            .values()
            .map(|registration| {
                let template = &registration.contract;
                KernelToolCatalogTool {
                    tool_id: template.tool_id.to_string(),
                    capability: template.permission.capability.to_string(),
                    family: template.family,
                    operation_kind: template.operation_kind,
                    provider_schema: template.input.schema.clone(),
                    planning_schema: template.input.planning_schema.clone(),
                    provider_visible: template.provider_visible,
                    forbidden_fields: template.input.forbidden_fields.clone(),
                    risk: template.permission.risk,
                    permission_mode: template.permission.mode,
                    permission_summary: permission_summary_for_contract(template),
                    path_scope_policy: template.resource.path_scope_policy,
                    plan_target_mode: template.resource.plan_target_mode,
                    plan_target_source: template.resource.plan_target_source,
                    execution_mode: template.execution.execution_mode,
                    isolation: template.execution.isolation.clone(),
                    hard_deny_rules: template.hard_deny_rules.clone(),
                    needs_workspace: template.resource.needs_workspace,
                    read_only: template.resource.read_only,
                    usage_constraints: template.usage_constraints.clone(),
                }
            })
            .collect::<Vec<_>>();
        tools.sort_by(|left, right| left.tool_id.cmp(&right.tool_id));
        let hash_payload = serde_json::json!({
            "catalogVersion": TOOL_REGISTRY_VERSION,
            "tools": &tools
        });
        let catalog_hash = fnv1a64_hex(&serde_json::to_string(&hash_payload).unwrap_or_default());
        KernelToolCatalogSnapshot {
            catalog_version: TOOL_REGISTRY_VERSION.to_string(),
            catalog_hash,
            tools,
        }
    }

    pub fn capability_for_tool(&self, tool_id: &str) -> Option<&'static str> {
        self.get(tool_id).map(KernelToolRegistration::capability)
    }

    pub fn risk_for_tool(&self, tool_id: &str) -> Option<crate::ToolRiskLevel> {
        self.get(tool_id).map(KernelToolRegistration::risk)
    }

    pub fn permission_mode_for_tool(&self, tool_id: &str) -> Option<ToolPermissionMode> {
        self.get(tool_id)
            .map(KernelToolRegistration::permission_mode)
    }

    pub fn needs_workspace(&self, tool_id: &str) -> Option<bool> {
        self.get(tool_id)
            .map(KernelToolRegistration::needs_workspace)
    }
}

pub fn fnv1a64_hex(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

fn permission_summary_for_contract(template: &KernelToolContract) -> String {
    match template.permission.mode {
        ToolPermissionMode::Allow => {
            "Kernel policy allows this tool without user confirmation in the current mode."
                .to_string()
        }
        ToolPermissionMode::Ask => format!(
            "Kernel gate asks the user before executing {} operations.",
            template.permission.capability
        ),
        ToolPermissionMode::Deny => {
            "Kernel policy denies this tool unless policy is changed.".to_string()
        }
    }
}
