use crate::registration_contracts::{build_tool_template, hard_deny_rules_for_tool};
use crate::{
    KernelToolDescriptor, KernelToolTemplate, OperationExecutionMode, ToolFamily,
    ToolPermissionMode, ToolRiskLevel,
};
use serde_json::Value;

#[derive(Debug, Clone)]
pub(crate) struct ToolRegistration {
    pub(crate) descriptor: KernelToolDescriptor,
    pub(crate) template: KernelToolTemplate,
    pub(crate) hard_deny_rules: Vec<String>,
}

fn provider_schema_for_tool(tool_id: &str) -> Option<Value> {
    Some(match tool_id {
        "fs.read" => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" },
                "startLine": { "type": "integer", "minimum": 1 },
                "endLine": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        "fs.list" => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" },
                "depth": { "type": "integer", "minimum": 1 },
                "includeHidden": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        "fs.glob" => serde_json::json!({
            "type": "object",
            "required": ["pattern"],
            "properties": {
                "pattern": { "type": "string" },
                "path": { "type": "string" },
                "maxResults": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        "fs.diff" => serde_json::json!({
            "type": "object",
            "required": ["path", "contentBlockId"],
            "properties": {
                "path": { "type": "string" },
                "contentBlockId": { "type": "string" }
            },
            "additionalProperties": false
        }),
        "fs.delete" => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" },
                "targetKind": { "type": "string", "enum": ["file", "directory"] },
                "recursive": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        "code.grep" => serde_json::json!({
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": { "type": "string" },
                "include": { "type": "array", "items": { "type": "string" } },
                "exclude": { "type": "array", "items": { "type": "string" } },
                "path": { "type": "string" },
                "strategy": { "type": "string", "enum": ["literal", "regex"] },
                "contextLines": { "type": "integer", "minimum": 0 },
                "maxResults": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        "fs.create" => serde_json::json!({
            "type": "object",
            "required": ["path", "contentBlockId"],
            "properties": {
                "path": { "type": "string" },
                "contentBlockId": { "type": "string" },
                "temporary": { "type": "boolean" },
                "executable": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        "fs.write" => serde_json::json!({
            "type": "object",
            "required": ["path", "contentBlockId"],
            "properties": {
                "path": { "type": "string" },
                "contentBlockId": { "type": "string" },
                "temporary": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        "fs.ensure_directory" => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" }
            },
            "additionalProperties": false
        }),
        "fs.edit" => serde_json::json!({
            "type": "object",
            "required": ["path", "patchSpec", "replacementBlockId"],
            "properties": {
                "path": { "type": "string" },
                "patchSpec": { "type": "object" },
                "replacementBlockId": { "type": "string" }
            },
            "additionalProperties": false
        }),
        "fs.rename" => serde_json::json!({
            "type": "object",
            "required": ["path", "destinationPath"],
            "properties": {
                "path": { "type": "string" },
                "destinationPath": { "type": "string" }
            },
            "additionalProperties": false
        }),
        "document.read" => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" },
                "startPage": { "type": "integer", "minimum": 1 },
                "endPage": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        "git.status" => {
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false })
        }
        "git.diff" => serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "staged": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        "git.stage" | "git.unstage" => serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "paths": { "type": "array", "items": { "type": "string" } }
            },
            "additionalProperties": false
        }),
        "git.commit" => serde_json::json!({
            "type": "object",
            "required": ["message"],
            "properties": {
                "message": { "type": "string" }
            },
            "additionalProperties": false
        }),
        "git.push" => serde_json::json!({
            "type": "object",
            "properties": {
                "remote": { "type": "string" },
                "branch": { "type": "string" }
            },
            "additionalProperties": false
        }),
        "process.exec" => serde_json::json!({
            "type": "object",
            "required": ["argv"],
            "properties": {
                "argv": { "type": "array", "items": { "type": "string" } },
                "cwd": { "type": "string" },
                "timeoutMs": { "type": "integer", "minimum": 1 },
                "envPolicy": { "type": "string" }
            },
            "additionalProperties": false
        }),
        "web.search" => serde_json::json!({
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        "web.fetch" => serde_json::json!({
            "type": "object",
            "required": ["url"],
            "properties": {
                "url": { "type": "string" },
                "maxBytes": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        "browser.open" => serde_json::json!({
            "type": "object",
            "required": ["url"],
            "properties": {
                "url": { "type": "string" }
            },
            "additionalProperties": false
        }),
        "browser.click" => serde_json::json!({
            "type": "object",
            "required": ["selector"],
            "properties": {
                "selector": { "type": "string" }
            },
            "additionalProperties": false
        }),
        "browser.snapshot" => serde_json::json!({
            "type": "object",
            "properties": {
                "selector": { "type": "string" }
            },
            "additionalProperties": false
        }),
        "browser.inspect" => serde_json::json!({
            "type": "object",
            "properties": {
                "inspectState": { "type": "string" }
            },
            "additionalProperties": false
        }),
        "browser.type" => serde_json::json!({
            "type": "object",
            "required": ["selector", "text"],
            "properties": {
                "selector": { "type": "string" },
                "text": { "type": "string" }
            },
            "additionalProperties": false
        }),
        "browser.scroll" => serde_json::json!({
            "type": "object",
            "properties": {
                "deltaY": { "type": "integer" }
            },
            "additionalProperties": false
        }),
        "browser.reload" => serde_json::json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
        "provider.call" => serde_json::json!({
            "type": "object",
            "properties": {
                "profileRef": { "type": "string" },
                "budgetRef": { "type": "string" }
            },
            "additionalProperties": false
        }),
        _ => return None,
    })
}

pub(crate) fn builtin_tool_registrations() -> Vec<ToolRegistration> {
    builtin_tool_descriptors()
        .into_iter()
        .map(|descriptor| {
            let provider_schema =
                provider_schema_for_tool(descriptor.tool_id).unwrap_or_else(|| {
                    panic!(
                        "canonical Kernel tool {} has no provider schema",
                        descriptor.tool_id
                    )
                });
            let provider_visible = descriptor.execution_mode != OperationExecutionMode::Blocked
                && descriptor.tool_id != "fs.ensure_directory";
            let template = build_tool_template(&descriptor, provider_schema, provider_visible);
            let hard_deny_rules = hard_deny_rules_for_tool(descriptor.tool_id);
            ToolRegistration {
                descriptor,
                template,
                hard_deny_rules,
            }
        })
        .collect()
}

fn builtin_tool_descriptors() -> Vec<KernelToolDescriptor> {
    vec![
        workspace_tool(
            "fs.read",
            "workspace.read",
            ToolRiskLevel::Low,
            ToolPermissionMode::Allow,
            true,
            true,
        ),
        workspace_tool(
            "fs.list",
            "workspace.read",
            ToolRiskLevel::Low,
            ToolPermissionMode::Allow,
            true,
            true,
        ),
        workspace_tool(
            "fs.glob",
            "workspace.read",
            ToolRiskLevel::Low,
            ToolPermissionMode::Allow,
            true,
            true,
        ),
        workspace_tool(
            "fs.diff",
            "workspace.read",
            ToolRiskLevel::Low,
            ToolPermissionMode::Allow,
            true,
            true,
        ),
        workspace_tool(
            "code.grep",
            "workspace.read",
            ToolRiskLevel::Low,
            ToolPermissionMode::Allow,
            true,
            true,
        ),
        workspace_tool(
            "fs.create",
            "workspace.write",
            ToolRiskLevel::Medium,
            ToolPermissionMode::Ask,
            true,
            false,
        ),
        workspace_tool(
            "fs.write",
            "workspace.write",
            ToolRiskLevel::Medium,
            ToolPermissionMode::Ask,
            true,
            false,
        ),
        workspace_tool(
            "fs.edit",
            "workspace.write",
            ToolRiskLevel::Medium,
            ToolPermissionMode::Ask,
            true,
            false,
        ),
        workspace_tool(
            "fs.rename",
            "workspace.write",
            ToolRiskLevel::High,
            ToolPermissionMode::Ask,
            true,
            false,
        ),
        workspace_tool(
            "fs.delete",
            "workspace.write",
            ToolRiskLevel::High,
            ToolPermissionMode::Ask,
            true,
            false,
        ),
        workspace_tool(
            "fs.ensure_directory",
            "workspace.write",
            ToolRiskLevel::Medium,
            ToolPermissionMode::Ask,
            true,
            false,
        ),
        KernelToolDescriptor {
            tool_id: "document.read",
            capability: "workspace.read",
            family: ToolFamily::Document,
            risk: ToolRiskLevel::Low,
            permission_mode: ToolPermissionMode::Allow,
            executor_ref: "kernel.document.read",
            execution_mode: OperationExecutionMode::Execute,
            needs_workspace: true,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "git.status",
            capability: "git.read",
            family: ToolFamily::Git,
            risk: ToolRiskLevel::Low,
            permission_mode: ToolPermissionMode::Allow,
            executor_ref: "kernel.cli.git.status",
            execution_mode: OperationExecutionMode::Execute,
            needs_workspace: true,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "git.diff",
            capability: "git.read",
            family: ToolFamily::Git,
            risk: ToolRiskLevel::Low,
            permission_mode: ToolPermissionMode::Allow,
            executor_ref: "kernel.cli.git.diff",
            execution_mode: OperationExecutionMode::Execute,
            needs_workspace: true,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "git.stage",
            capability: "git.write",
            family: ToolFamily::Git,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.cli.git.stage",
            execution_mode: OperationExecutionMode::Execute,
            needs_workspace: true,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "git.unstage",
            capability: "git.write",
            family: ToolFamily::Git,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.cli.git.unstage",
            execution_mode: OperationExecutionMode::Execute,
            needs_workspace: true,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "git.commit",
            capability: "git.write",
            family: ToolFamily::Git,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.cli.git.commit",
            execution_mode: OperationExecutionMode::Execute,
            needs_workspace: true,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "git.push",
            capability: "git.push",
            family: ToolFamily::Git,
            risk: ToolRiskLevel::Critical,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.blocked.git.push",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: true,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "process.exec",
            capability: "process.exec",
            family: ToolFamily::Process,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.blocked.process.exec",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "web.search",
            capability: "network.egress",
            family: ToolFamily::Network,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.http.web.search",
            execution_mode: OperationExecutionMode::Execute,
            needs_workspace: false,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "web.fetch",
            capability: "network.egress",
            family: ToolFamily::Network,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.http.web.fetch",
            execution_mode: OperationExecutionMode::Execute,
            needs_workspace: false,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "browser.open",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.blocked.browser.open",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "browser.reload",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.blocked.browser.reload",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "browser.snapshot",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.blocked.browser.snapshot",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "browser.inspect",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.blocked.browser.inspect",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "browser.click",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.blocked.browser.click",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "browser.type",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.blocked.browser.type",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "browser.scroll",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.blocked.browser.scroll",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "provider.call",
            capability: "provider.egress",
            family: ToolFamily::Provider,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "daemon.provider.transport",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: true,
        },
    ]
}

fn workspace_tool(
    tool_id: &'static str,
    capability: &'static str,
    risk: ToolRiskLevel,
    permission_mode: ToolPermissionMode,
    needs_workspace: bool,
    read_only: bool,
) -> KernelToolDescriptor {
    KernelToolDescriptor {
        tool_id,
        capability,
        family: ToolFamily::Workspace,
        risk,
        permission_mode,
        executor_ref: "kernel.builtin.workspace",
        execution_mode: OperationExecutionMode::Execute,
        needs_workspace,
        read_only,
    }
}
