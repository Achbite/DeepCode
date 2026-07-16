use crate::registrations::{builtin_tool_registrations, ToolRegistration};
use crate::{
    GitOperationKind, KernelToolCatalogSnapshot, KernelToolCatalogTool, KernelToolDescriptor,
    KernelToolTemplate, ToolPermissionMode, WorkspaceOperationKind,
};
use std::collections::BTreeMap;

pub const TOOL_REGISTRY_VERSION: &str = "deepcode.kernel.tools.v3";

#[derive(Debug, Clone)]
pub struct KernelToolRegistry {
    registrations: BTreeMap<&'static str, ToolRegistration>,
}

impl Default for KernelToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl KernelToolRegistry {
    pub fn new() -> Self {
        let mut registrations = BTreeMap::new();
        for registration in builtin_tool_registrations() {
            let tool_id = registration.descriptor.tool_id;
            assert!(
                registrations.insert(tool_id, registration).is_none(),
                "duplicate canonical Kernel tool registration: {tool_id}"
            );
        }
        Self { registrations }
    }

    pub fn get(&self, tool_id: &str) -> Option<&KernelToolDescriptor> {
        self.registrations
            .get(tool_id)
            .map(|registration| &registration.descriptor)
    }

    pub fn all(&self) -> impl Iterator<Item = &KernelToolDescriptor> {
        self.registrations
            .values()
            .map(|registration| &registration.descriptor)
    }

    pub fn template(&self, tool_id: &str) -> Option<KernelToolTemplate> {
        self.registrations
            .get(tool_id)
            .map(|registration| registration.template.clone())
    }

    pub fn templates(&self) -> impl Iterator<Item = KernelToolTemplate> + '_ {
        self.registrations
            .values()
            .map(|registration| registration.template.clone())
    }

    pub fn snapshot(&self) -> KernelToolCatalogSnapshot {
        let mut tools = self
            .registrations
            .values()
            .map(|registration| {
                let template = &registration.template;
                KernelToolCatalogTool {
                    tool_id: template.tool_id,
                    capability: template.permission.capability,
                    family: template.family,
                    operation_kind: template.operation_kind,
                    provider_schema: template.input.schema.clone(),
                    planning_schema: template.input.planning_schema.clone(),
                    provider_visible: template.provider_visible,
                    forbidden_fields: template.input.forbidden_fields.clone(),
                    risk: template.permission.risk,
                    permission_mode: template.permission.mode,
                    permission_summary: permission_summary_for_template(template),
                    path_scope_policy: template.resource.path_scope_policy,
                    plan_target_mode: template.resource.plan_target_mode,
                    execution_mode: template.execution.execution_mode,
                    isolation: template.execution.isolation.clone(),
                    hard_deny_rules: registration.hard_deny_rules.clone(),
                    needs_workspace: template.resource.needs_workspace,
                    read_only: template.resource.read_only,
                    usage_constraints: template.usage_constraints.clone(),
                }
            })
            .collect::<Vec<_>>();
        tools.sort_by(|left, right| left.tool_id.cmp(right.tool_id));
        let hash_payload = serde_json::json!({
            "catalogVersion": TOOL_REGISTRY_VERSION,
            "tools": &tools
        });
        let catalog_hash = fnv1a64_hex(&serde_json::to_string(&hash_payload).unwrap_or_default());
        KernelToolCatalogSnapshot {
            catalog_version: TOOL_REGISTRY_VERSION,
            catalog_hash,
            tools,
        }
    }

    pub fn capability_for_tool(&self, tool_id: &str) -> Option<&'static str> {
        self.get(tool_id).map(|descriptor| descriptor.capability)
    }

    pub fn risk_for_tool(&self, tool_id: &str) -> Option<&'static str> {
        self.get(tool_id).map(|descriptor| descriptor.risk.as_str())
    }

    pub fn permission_mode_for_tool(&self, tool_id: &str) -> Option<ToolPermissionMode> {
        self.get(tool_id)
            .map(|descriptor| descriptor.permission_mode)
    }

    pub fn needs_workspace(&self, tool_id: &str) -> Option<bool> {
        self.get(tool_id)
            .map(|descriptor| descriptor.needs_workspace)
    }

    pub fn tool_for_workspace_kind(&self, kind: WorkspaceOperationKind) -> Option<&'static str> {
        Some(match kind {
            WorkspaceOperationKind::Read => "fs.read",
            WorkspaceOperationKind::List => "fs.list",
            WorkspaceOperationKind::Glob => "fs.glob",
            WorkspaceOperationKind::Search => "code.grep",
            WorkspaceOperationKind::Diff => "fs.diff",
            WorkspaceOperationKind::Write => "fs.write",
            WorkspaceOperationKind::Create => "fs.create",
            WorkspaceOperationKind::Patch => "fs.edit",
            WorkspaceOperationKind::Delete => "fs.delete",
            WorkspaceOperationKind::Rename => "fs.rename",
            WorkspaceOperationKind::DocumentRead => "document.read",
            WorkspaceOperationKind::EnsureDirectory => "fs.ensure_directory",
        })
    }

    pub fn tool_for_git_kind(&self, kind: GitOperationKind) -> Option<&'static str> {
        Some(match kind {
            GitOperationKind::Status => "git.status",
            GitOperationKind::Diff => "git.diff",
            GitOperationKind::Stage => "git.stage",
            GitOperationKind::Unstage => "git.unstage",
            GitOperationKind::Commit => "git.commit",
            GitOperationKind::Push => "git.push",
        })
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

fn permission_summary_for_template(template: &KernelToolTemplate) -> String {
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
