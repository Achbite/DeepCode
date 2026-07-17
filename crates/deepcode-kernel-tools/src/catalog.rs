use crate::registrations::{builtin_tool_registrations, KernelToolRegistration};
use crate::{
    KernelToolCatalogSnapshot, KernelToolCatalogTool, KernelToolContract, ToolPermissionMode,
};
use std::collections::BTreeMap;

pub const TOOL_REGISTRY_VERSION: &str = "deepcode.kernel.tools.v3";

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
