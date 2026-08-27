use crate::local_agent_mcp::{McpRuntime, McpTool};
use crate::local_agent_store::{LocalAgentJournal, LocalAgentStoreError};
use deepcode_kernel_runtime::executors::{
    builtin_executors, resolved_network_target, KernelExecutorConfig, KernelExecutorRegistry,
    KernelToolExecutionContext, KernelToolInvocation, SecretProvider,
};
use deepcode_kernel_runtime::workspace_boundary::WorkspaceBoundary;
use deepcode_kernel_tools::{KernelToolRegistry, ToolEffectClass, ToolEffectScope};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

const KERNEL_REQUEST_VERSION: &str = "deepcode.kernel-request.v2";
const KERNEL_REPLY_VERSION: &str = "deepcode.kernel-reply.v2";
const TOOL_RECORD_SCHEMA: &str =
    include_str!("../../../contracts/agent-runtime-v2/tool-record.sql");
const TOOL_RECORD_V2_TO_V3: &str =
    include_str!("../../../contracts/agent-runtime-v2/tool-record-v2-to-v3.sql");
const TOOL_RECORD_STORE_VERSION: u32 = 3;

#[derive(Debug, Clone)]
pub(crate) struct LocalAgentKernelError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl LocalAgentKernelError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<LocalAgentStoreError> for LocalAgentKernelError {
    fn from(value: LocalAgentStoreError) -> Self {
        Self::new(value.code, value.message)
    }
}

pub(crate) trait WorkspaceResolverPort: Send + Sync {
    fn resolve(&self, workspace_id: &str) -> Result<String, LocalAgentKernelError>;
}

#[derive(Clone)]
pub(crate) struct HostWorkspaceResolver {
    gui: Arc<Mutex<crate::GuiState>>,
}

impl HostWorkspaceResolver {
    pub(crate) fn new(gui: Arc<Mutex<crate::GuiState>>) -> Self {
        Self { gui }
    }
}

impl WorkspaceResolverPort for HostWorkspaceResolver {
    fn resolve(&self, workspace_id: &str) -> Result<String, LocalAgentKernelError> {
        validate_id("workspaceId", workspace_id)?;
        let gui = self.gui.lock().map_err(|_| {
            LocalAgentKernelError::new(
                "workspace_catalog_lock_failed",
                "Workspace Catalog 锁已损坏。",
            )
        })?;
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return Err(LocalAgentKernelError::new(
                "workspace_catalog_unavailable",
                error,
            ));
        }
        gui.conversation_catalog
            .workspace(workspace_id)
            .map(|workspace| workspace.canonical_root.clone())
            .ok_or_else(|| {
                LocalAgentKernelError::new(
                    "workspace_not_found",
                    format!("Workspace 不存在：{workspace_id}"),
                )
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PermissionMode {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreparedEffectScope {
    WorkspaceRead,
    WorkspaceMutation,
    Network,
    External,
}

/// Workspace read and mutation are hard-cut semantics, not configurable policy:
/// a bound workspace grants reads and only a selected structured Plan grants
/// mutations. Settings remain relevant only to non-workspace effects.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LocalAgentPermissionPolicy {
    network: PermissionMode,
    external: PermissionMode,
}

impl LocalAgentPermissionPolicy {
    pub(crate) fn from_settings(settings: &Value) -> Result<Self, LocalAgentKernelError> {
        Ok(Self {
            network: permission_mode(
                settings,
                "agent.permissions.networkRead",
                PermissionMode::Ask,
            )?,
            external: permission_mode(settings, "agent.permissions.external", PermissionMode::Ask)?,
        })
    }

    fn mode(self, scope: PreparedEffectScope) -> Option<PermissionMode> {
        match scope {
            PreparedEffectScope::Network => Some(self.network),
            PreparedEffectScope::External => Some(self.external),
            PreparedEffectScope::WorkspaceRead | PreparedEffectScope::WorkspaceMutation => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalToolExecutionRequest {
    schema_version: String,
    #[serde(rename = "type")]
    request_type: String,
    request_id: String,
    session_id: String,
    run_id: String,
    call_id: String,
    attempt_id: String,
    tool_name: String,
    input: Value,
    workspace_bindings: Vec<String>,
    #[serde(default)]
    plan_authorities: Vec<Value>,
    non_workspace_authority: Option<NonWorkspaceAuthority>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NonWorkspaceAuthority {
    authority_id: String,
    decision: String,
}

#[derive(Clone)]
pub(crate) struct LocalAgentKernel {
    registry: Arc<KernelToolRegistry>,
    executors: Arc<KernelExecutorRegistry>,
    executor_config: KernelExecutorConfig,
    records: LocalToolRecordStore,
    journal: LocalAgentJournal,
    resolver: Arc<dyn WorkspaceResolverPort>,
    mcp: McpRuntime,
    permissions: LocalAgentPermissionPolicy,
    active: Arc<Mutex<HashMap<String, ActiveCall>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActivePhase {
    Prepared,
    Executing,
}

#[derive(Clone)]
struct ActiveCall {
    request: LocalToolExecutionRequest,
    prepared: PreparedEffect,
    authority: Value,
    started_at: String,
    phase: ActivePhase,
}

impl LocalAgentKernel {
    pub(crate) fn open(
        record_path: &Path,
        journal: LocalAgentJournal,
        resolver: Arc<dyn WorkspaceResolverPort>,
        executor_config: KernelExecutorConfig,
        secret_provider: Arc<dyn SecretProvider>,
        mcp: McpRuntime,
        permissions: LocalAgentPermissionPolicy,
    ) -> Result<Self, LocalAgentKernelError> {
        let registry = Arc::new(KernelToolRegistry::new());
        let executors = Arc::new(KernelExecutorRegistry::from_executors(builtin_executors(
            registry.as_ref(),
            executor_config.clone(),
            secret_provider,
        )));
        Ok(Self {
            registry,
            executors,
            executor_config,
            records: LocalToolRecordStore::open(record_path)?,
            journal,
            resolver,
            mcp,
            permissions,
            active: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub(crate) fn list_tools(&self) -> Result<Value, LocalAgentKernelError> {
        let mut tools = self
            .registry
            .descriptors()
            .map(|tool| {
                let input_schema = match tool.effect_scope {
                    ToolEffectScope::WorkspaceRead | ToolEffectScope::WorkspaceWrite => {
                        schema_requiring_workspace_id(tool.input_schema.clone())
                    }
                    ToolEffectScope::NetworkRead => tool.input_schema.clone(),
                };
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": input_schema,
                    "possibleEffects": possible_effects(tool.effect_class, tool.effect_scope),
                })
            })
            .collect::<Vec<_>>();
        tools.extend(self.mcp.tools().map(|tool| {
            json!({
                "name": tool.public_name,
                "description": tool.description,
                "inputSchema": tool.input_schema,
                "possibleEffects": ["external"],
            })
        }));
        Ok(Value::Array(tools))
    }

    pub(crate) fn execute(
        &self,
        request: LocalToolExecutionRequest,
    ) -> Result<Value, LocalAgentKernelError> {
        validate_request(&request)?;
        self.validate_session_snapshot(&request)?;
        if let Some(record) = self.records.read(&request.call_id)? {
            validate_record_replay(&record, &request)?;
            return Ok(execution_reply(&request, &record));
        }

        let prepared = self.prepare_tool(&request)?;
        let preview = prepared.preview(&request.tool_name);
        let admission = self.admit(&request, &prepared)?;
        match admission {
            Admission::ApprovalRequired => Ok(json!({
                "schemaVersion": KERNEL_REPLY_VERSION,
                "type": "tool.execution",
                "requestId": request.request_id,
                "callId": request.call_id,
                "status": "approvalRequired",
                "approvalId": random_id("approval")?,
                "preview": preview,
            })),
            Admission::Denied { authority, error } => {
                let now = crate::now_text();
                let record = tool_record(
                    &request,
                    &prepared,
                    authority,
                    &now,
                    &now,
                    "denied",
                    None,
                    Some(error),
                )?;
                self.records.insert(&record)?;
                Ok(execution_reply(&request, &record))
            }
            Admission::Allowed(authority) => {
                let started_at = crate::now_text();
                {
                    let mut active = self.lock_active()?;
                    if active.contains_key(&request.call_id) {
                        return Err(LocalAgentKernelError::new(
                            "tool_call_in_progress",
                            "相同 callId 的工具调用仍在执行。",
                        ));
                    }
                    active.insert(
                        request.call_id.clone(),
                        ActiveCall {
                            request: request.clone(),
                            prepared: prepared.clone(),
                            authority: authority.clone(),
                            started_at: started_at.clone(),
                            phase: ActivePhase::Prepared,
                        },
                    );
                }

                let start_execution = {
                    let mut active = self.lock_active()?;
                    match active.get_mut(&request.call_id) {
                        Some(call) if call.request.attempt_id == request.attempt_id => {
                            call.phase = ActivePhase::Executing;
                            true
                        }
                        _ => false,
                    }
                };
                if !start_execution {
                    let record = self.records.read(&request.call_id)?.ok_or_else(|| {
                        LocalAgentKernelError::new(
                            "tool_call_state_lost",
                            "工具调用在进入执行前丢失了确定状态。",
                        )
                    })?;
                    validate_record_replay(&record, &request)?;
                    return Ok(execution_reply(&request, &record));
                }

                let result = self.execute_prepared(&prepared, &request);
                self.lock_active()?.remove(&request.call_id);
                if let Some(record) = self.records.read(&request.call_id)? {
                    validate_record_replay(&record, &request)?;
                    return Ok(execution_reply(&request, &record));
                }
                let completed_at = crate::now_text();
                let record = match result {
                    Ok(output) => tool_record(
                        &request,
                        &prepared,
                        authority,
                        &started_at,
                        &completed_at,
                        "completed",
                        Some(output),
                        None,
                    )?,
                    Err(message) => tool_record(
                        &request,
                        &prepared,
                        authority,
                        &started_at,
                        &completed_at,
                        "failed",
                        None,
                        Some(json!({
                            "code": "tool_execution_failed",
                            "message": message,
                        })),
                    )?,
                };
                self.records.insert(&record)?;
                Ok(execution_reply(&request, &record))
            }
        }
    }

    pub(crate) fn cancel(
        &self,
        call_id: &str,
        attempt_id: &str,
    ) -> Result<Value, LocalAgentKernelError> {
        validate_id("callId", call_id)?;
        validate_id("attemptId", attempt_id)?;
        if let Some(record) = self.records.read(call_id)? {
            if record.get("attemptId").and_then(Value::as_str) != Some(attempt_id) {
                return Err(LocalAgentKernelError::new(
                    "tool_call_identity_conflict",
                    "callId 已绑定到其他 attemptId。",
                ));
            }
            let outcome = required_record_string(&record, "outcome")?.to_string();
            return Ok(cancel_reply(call_id, attempt_id, &outcome, Some(record)));
        }
        let active = self.lock_active()?.get(call_id).cloned();
        let Some(active) = active else {
            return Ok(cancel_reply(call_id, attempt_id, "notFound", None));
        };
        if active.request.attempt_id != attempt_id {
            return Err(LocalAgentKernelError::new(
                "tool_call_identity_conflict",
                "callId 已绑定到其他 attemptId。",
            ));
        }
        let completed_at = crate::now_text();
        let (outcome, error) = match active.phase {
            ActivePhase::Prepared => ("cancelled", None),
            ActivePhase::Executing => (
                "indeterminate",
                Some(json!({
                    "code": "tool_effect_outcome_unknown",
                    "message": "取消发生时工具 effect 已进入执行边界，结果无法确定。",
                })),
            ),
        };
        let record = tool_record(
            &active.request,
            &active.prepared,
            active.authority,
            &active.started_at,
            &completed_at,
            outcome,
            None,
            error,
        )?;
        self.records.insert(&record)?;
        self.lock_active()?.remove(call_id);
        Ok(cancel_reply(call_id, attempt_id, outcome, Some(record)))
    }

    pub(crate) fn read_record(
        &self,
        call_id: &str,
    ) -> Result<Option<Value>, LocalAgentKernelError> {
        validate_id("callId", call_id)?;
        self.records.read(call_id)
    }

    pub(crate) fn shutdown_plugins(&self) -> Result<(), LocalAgentKernelError> {
        self.mcp
            .shutdown()
            .map_err(|error| LocalAgentKernelError::new(error.code, error.message))
    }

    fn validate_session_snapshot(
        &self,
        request: &LocalToolExecutionRequest,
    ) -> Result<(), LocalAgentKernelError> {
        let committed = self
            .journal
            .run_workspace_binding_ids(&request.session_id, &request.run_id)?;
        if committed != request.workspace_bindings {
            return Err(LocalAgentKernelError::new(
                "session_workspace_snapshot_mismatch",
                "Kernel 请求的 workspaceBindings 与当前 run 冻结快照不一致。",
            ));
        }
        Ok(())
    }

    fn prepare_tool(
        &self,
        request: &LocalToolExecutionRequest,
    ) -> Result<PreparedEffect, LocalAgentKernelError> {
        if let Some(tool) = self.mcp.tool(&request.tool_name) {
            return Ok(PreparedEffect {
                scope: PreparedEffectScope::External,
                workspace_id: None,
                operation: request.tool_name.clone(),
                logical_targets: vec![tool.target.clone()],
                private_resolved_targets: Vec::new(),
                canonical_invocation: json!({
                    "toolName": request.tool_name,
                    "arguments": request.input,
                }),
                canonical_arguments: request.input.clone(),
                workspace_root: None,
                delete_target_kind: None,
                adapter: PreparedToolAdapter::Mcp(tool),
            });
        }
        let descriptor = self
            .registry
            .descriptor(&request.tool_name)
            .ok_or_else(|| {
                LocalAgentKernelError::new("tool_not_found", "Kernel 工具目录中不存在该工具。")
            })?;
        let mut tool_input = request.input.clone();
        let workspace_id = match descriptor.effect_scope {
            ToolEffectScope::WorkspaceRead | ToolEffectScope::WorkspaceWrite => {
                Some(take_workspace_id(&mut tool_input)?)
            }
            ToolEffectScope::NetworkRead => {
                if tool_input.get("workspaceId").is_some() {
                    return Err(LocalAgentKernelError::new(
                        "tool_input_invalid",
                        "非 workspace 工具不能携带 workspaceId。",
                    ));
                }
                None
            }
        };
        if let Some(workspace_id) = workspace_id.as_deref() {
            if !request
                .workspace_bindings
                .iter()
                .any(|id| id == workspace_id)
            {
                return Err(LocalAgentKernelError::new(
                    "workspace_not_bound",
                    "工具引用的 workspaceId 不在当前 Session creation snapshot 中。",
                ));
            }
        }
        let canonical = self
            .registry
            .canonicalize(&request.tool_name, tool_input)
            .map_err(|error| LocalAgentKernelError::new("tool_input_invalid", error.to_string()))?;
        let arguments = canonical.arguments;
        let mut logical_targets = canonical_logical_targets(&request.tool_name, &arguments)?;
        if let Some(target) = resolved_network_target(
            request.tool_name.as_str(),
            &arguments,
            &self.executor_config,
        )
        .map_err(|error| LocalAgentKernelError::new("tool_target_invalid", error.to_string()))?
        {
            logical_targets.push(target);
            logical_targets.sort();
            logical_targets.dedup();
        }
        let (workspace_root, private_resolved_targets) = match workspace_id.as_deref() {
            Some(workspace_id) => {
                let root = self.resolver.resolve(workspace_id)?;
                let canonical_root = std::fs::canonicalize(&root).map_err(|error| {
                    LocalAgentKernelError::new(
                        "workspace_root_unavailable",
                        format!("Workspace root 不可用：{error}"),
                    )
                })?;
                if !canonical_root.is_dir() {
                    return Err(LocalAgentKernelError::new(
                        "workspace_root_invalid",
                        "Workspace root 不是目录。",
                    ));
                }
                let boundary = WorkspaceBoundary::new(canonical_root.clone());
                let resolve_target = |target: &str| match descriptor.effect_scope {
                    ToolEffectScope::WorkspaceRead => boundary.resolve_read(target),
                    ToolEffectScope::WorkspaceWrite => boundary.resolve_mutation(target),
                    ToolEffectScope::NetworkRead => unreachable!("workspace target scope"),
                };
                let private = logical_targets
                    .iter()
                    .map(|target| {
                        resolve_target(target)
                            .map(|path| path.to_string_lossy().to_string())
                            .map_err(|error| {
                                LocalAgentKernelError::new(
                                    "workspace_target_invalid",
                                    error.to_string(),
                                )
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                (Some(canonical_root.to_string_lossy().to_string()), private)
            }
            None => (None, Vec::new()),
        };
        let delete_target_kind = if request.tool_name == "fs.delete" {
            match arguments.get("targetKind").and_then(Value::as_str) {
                Some("file") => Some("file".to_string()),
                Some("directory")
                    if arguments.get("recursive").and_then(Value::as_bool) == Some(true) =>
                {
                    Some("directoryTree".to_string())
                }
                _ => {
                    return Err(LocalAgentKernelError::new(
                        "tool_input_invalid",
                        "fs.delete canonical targetKind 无效。",
                    ))
                }
            }
        } else {
            None
        };
        Ok(PreparedEffect {
            scope: match descriptor.effect_scope {
                ToolEffectScope::WorkspaceRead => PreparedEffectScope::WorkspaceRead,
                ToolEffectScope::WorkspaceWrite => PreparedEffectScope::WorkspaceMutation,
                ToolEffectScope::NetworkRead => PreparedEffectScope::Network,
            },
            workspace_id,
            operation: request.tool_name.clone(),
            logical_targets,
            private_resolved_targets,
            canonical_invocation: json!({
                "toolName": request.tool_name,
                "arguments": arguments,
            }),
            canonical_arguments: arguments,
            workspace_root,
            delete_target_kind,
            adapter: PreparedToolAdapter::Builtin,
        })
    }

    fn admit(
        &self,
        request: &LocalToolExecutionRequest,
        prepared: &PreparedEffect,
    ) -> Result<Admission, LocalAgentKernelError> {
        if self
            .journal
            .run_is_settled(&request.session_id, &request.run_id)?
        {
            return Ok(Admission::denied(
                "run_already_settled",
                "当前 run 已 settled，所有 authority 均已失效。",
            ));
        }
        match prepared.scope {
            PreparedEffectScope::WorkspaceRead => {
                let workspace_id = prepared
                    .workspace_id
                    .as_deref()
                    .expect("prepared workspace");
                Ok(Admission::Allowed(json!({
                    "decision": "allow",
                    "source": "workspaceBinding",
                    "workspaceId": workspace_id,
                })))
            }
            PreparedEffectScope::WorkspaceMutation => {
                for authority in &request.plan_authorities {
                    if !authority_matches_identity(authority, request, prepared) {
                        continue;
                    }
                    if !self.journal.plan_authority_is_committed(
                        &request.session_id,
                        &request.run_id,
                        authority,
                    )? {
                        continue;
                    }
                    if authority_covers(authority, prepared) {
                        return Ok(Admission::Allowed(json!({
                            "decision": "allow",
                            "source": "plan",
                            "workspaceId": prepared.workspace_id,
                            "authorityId": authority.get("authorityId"),
                            "planId": authority.get("planId"),
                        })));
                    }
                }
                Ok(Admission::denied(
                    "workspace_mutation_plan_required",
                    "Workspace mutation 没有被当前 run 的已选择结构化 Plan 精确覆盖。",
                ))
            }
            PreparedEffectScope::Network | PreparedEffectScope::External => {
                if let Some(authority) = request.non_workspace_authority.as_ref() {
                    validate_id("authorityId", &authority.authority_id)?;
                    if !matches!(authority.decision.as_str(), "allow" | "deny")
                        || !self.journal.non_workspace_authority_is_committed(
                            &request.session_id,
                            &request.run_id,
                            &request.call_id,
                            &authority.authority_id,
                            &authority.decision,
                        )?
                    {
                        return Err(LocalAgentKernelError::new(
                            "non_workspace_authority_invalid",
                            "非 workspace authority 与当前 journal fact 不一致。",
                        ));
                    }
                    if authority.decision == "allow" {
                        return Ok(Admission::Allowed(json!({
                            "decision": "allow",
                            "source": "user",
                            "authorityId": authority.authority_id,
                        })));
                    }
                    return Ok(Admission::Denied {
                        authority: json!({
                            "decision": "deny",
                            "source": "user",
                            "authorityId": authority.authority_id,
                        }),
                        error: json!({
                            "code": "tool_effect_denied",
                            "message": "用户拒绝了该非 workspace effect。",
                        }),
                    });
                }
                match self
                    .permissions
                    .mode(prepared.scope)
                    .expect("non-workspace policy")
                {
                    PermissionMode::Allow => Ok(Admission::Allowed(json!({
                        "decision": "allow",
                        "source": "userSetting",
                        "authorityId": permission_setting_id(prepared.scope),
                    }))),
                    PermissionMode::Ask => Ok(Admission::ApprovalRequired),
                    PermissionMode::Deny => Ok(Admission::denied(
                        "tool_effect_denied_by_setting",
                        "用户设置拒绝了该非 workspace effect。",
                    )),
                }
            }
        }
    }

    fn execute_prepared(
        &self,
        prepared: &PreparedEffect,
        request: &LocalToolExecutionRequest,
    ) -> Result<Value, String> {
        let _private_targets = &prepared.private_resolved_targets;
        match &prepared.adapter {
            PreparedToolAdapter::Builtin => self
                .executors
                .invoke(
                    &request.tool_name,
                    KernelToolInvocation {
                        id: request.attempt_id.clone(),
                        tool_id: request.tool_name.clone(),
                        input: prepared.canonical_arguments.clone(),
                    },
                    KernelToolExecutionContext {
                        workspace_root: prepared.workspace_root.clone(),
                        workspace_id: prepared.workspace_id.clone(),
                        private_resolved_targets: prepared.private_resolved_targets.clone(),
                    },
                )
                .map(|result| result.output)
                .map_err(|error| error.to_string()),
            PreparedToolAdapter::Mcp(tool) => tool
                .call(prepared.canonical_arguments.clone())
                .map_err(|error| format!("{}: {}", error.code, error.message)),
        }
    }

    fn lock_active(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, ActiveCall>>, LocalAgentKernelError> {
        self.active.lock().map_err(|_| {
            LocalAgentKernelError::new("tool_runtime_lock_failed", "Kernel 工具运行状态锁已损坏。")
        })
    }
}

enum Admission {
    ApprovalRequired,
    Allowed(Value),
    Denied { authority: Value, error: Value },
}

impl Admission {
    fn denied(code: &str, message: &str) -> Self {
        Self::Denied {
            authority: json!({
                "decision": "deny",
                "source": "kernel",
                "reason": message,
            }),
            error: json!({ "code": code, "message": message }),
        }
    }
}

#[derive(Clone)]
struct PreparedEffect {
    scope: PreparedEffectScope,
    workspace_id: Option<String>,
    operation: String,
    logical_targets: Vec<String>,
    private_resolved_targets: Vec<String>,
    canonical_invocation: Value,
    canonical_arguments: Value,
    workspace_root: Option<String>,
    delete_target_kind: Option<String>,
    adapter: PreparedToolAdapter,
}

impl PreparedEffect {
    fn projection(&self, request: &LocalToolExecutionRequest) -> Value {
        let mut projection = json!({
            "callId": request.call_id,
            "attemptId": request.attempt_id,
            "sessionId": request.session_id,
            "runId": request.run_id,
            "toolName": request.tool_name,
            "operation": self.operation,
            "logicalTargets": self.logical_targets,
            "canonicalInvocation": self.canonical_invocation,
        });
        if let Some(workspace_id) = self.workspace_id.as_deref() {
            projection["workspaceId"] = json!(workspace_id);
        }
        projection
    }

    fn preview(&self, tool_name: &str) -> Value {
        json!({
            "summary": effect_summary(tool_name, &self.logical_targets),
            "effects": effect_names(self.scope),
            "logicalTargets": self.logical_targets,
        })
    }
}

#[derive(Clone)]
enum PreparedToolAdapter {
    Builtin,
    Mcp(McpTool),
}

#[derive(Clone)]
struct LocalToolRecordStore {
    connection: Arc<Mutex<Connection>>,
}

impl LocalToolRecordStore {
    fn open(path: &Path) -> Result<Self, LocalAgentKernelError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                LocalAgentKernelError::new(
                    "tool_record_directory_failed",
                    format!("创建 ToolRecord Store 目录失败：{error}"),
                )
            })?;
        }
        let existed = path.exists();
        let connection = Connection::open(path).map_err(|error| {
            LocalAgentKernelError::new(
                "tool_record_store_open_failed",
                format!("打开 ToolRecord Store 失败：{error}"),
            )
        })?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| {
                LocalAgentKernelError::new("tool_record_store_pragma_failed", error.to_string())
            })?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;")
            .map_err(|error| {
                LocalAgentKernelError::new("tool_record_store_pragma_failed", error.to_string())
            })?;
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| {
                LocalAgentKernelError::new("tool_record_store_version_failed", error.to_string())
            })?;
        match version {
            0 if !existed || sqlite_is_empty(&connection)? => connection
                .execute_batch(TOOL_RECORD_SCHEMA)
                .map_err(|error| {
                    LocalAgentKernelError::new(
                        "tool_record_schema_failed",
                        format!("创建 ToolRecord v2 schema 失败：{error}"),
                    )
                })?,
            2 => {
                connection
                    .execute_batch(TOOL_RECORD_V2_TO_V3)
                    .map_err(|error| {
                        LocalAgentKernelError::new(
                            "tool_record_store_v2_to_v3_failed",
                            error.to_string(),
                        )
                    })?;
                verify_tool_record_store(&connection)?;
                verify_tool_record_store_version(&connection)?;
            }
            TOOL_RECORD_STORE_VERSION => {
                verify_tool_record_store(&connection)?;
                verify_tool_record_store_version(&connection)?;
            }
            other => {
                return Err(LocalAgentKernelError::new(
                    "tool_record_store_version_unsupported",
                    format!(
                        "ToolRecord Store 版本 {other} 不是当前 active-v2 store；hard cut 只接受 schema 2 的单向升级或 schema 3。"
                    ),
                ))
            }
        }
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    fn read(&self, call_id: &str) -> Result<Option<Value>, LocalAgentKernelError> {
        let connection = self.connection.lock().map_err(|_| {
            LocalAgentKernelError::new("tool_record_lock_failed", "ToolRecord Store 锁已损坏。")
        })?;
        let encoded = connection
            .query_row(
                "SELECT record_json FROM tool_records
                 WHERE call_id=?1 ORDER BY completed_at DESC, rowid DESC LIMIT 1",
                params![call_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| {
                LocalAgentKernelError::new("tool_record_read_failed", error.to_string())
            })?;
        encoded
            .map(|encoded| {
                serde_json::from_str(&encoded).map_err(|error| {
                    LocalAgentKernelError::new(
                        "tool_record_corrupt",
                        format!("ToolRecord JSON 损坏：{error}"),
                    )
                })
            })
            .transpose()
    }

    fn insert(&self, record: &Value) -> Result<(), LocalAgentKernelError> {
        let prepared = record
            .get("preparedEffect")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                LocalAgentKernelError::new(
                    "tool_record_invalid",
                    "ToolRecord 缺少 PreparedEffect。",
                )
            })?;
        let encoded = serde_json::to_string(record).map_err(|error| {
            LocalAgentKernelError::new("tool_record_encode_failed", error.to_string())
        })?;
        self.connection
            .lock()
            .map_err(|_| {
                LocalAgentKernelError::new("tool_record_lock_failed", "ToolRecord Store 锁已损坏。")
            })?
            .execute(
                "INSERT INTO tool_records(
                     record_id, session_id, run_id, call_id, attempt_id, tool_name,
                     workspace_id, operation, logical_targets_json, authority_id,
                     outcome, record_json, started_at, completed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    required_record_string(record, "recordId")?,
                    required_record_string(record, "sessionId")?,
                    required_record_string(record, "runId")?,
                    required_record_string(record, "callId")?,
                    required_record_string(record, "attemptId")?,
                    required_record_string(record, "toolName")?,
                    prepared.get("workspaceId").and_then(Value::as_str),
                    prepared.get("operation").and_then(Value::as_str),
                    serde_json::to_string(
                        prepared
                            .get("logicalTargets")
                            .unwrap_or(&Value::Array(Vec::new()))
                    )
                    .map_err(|error| LocalAgentKernelError::new(
                        "tool_record_encode_failed",
                        error.to_string(),
                    ))?,
                    record
                        .pointer("/authority/authorityId")
                        .and_then(Value::as_str),
                    required_record_string(record, "outcome")?,
                    encoded,
                    required_record_string(record, "startedAt")?,
                    required_record_string(record, "completedAt")?,
                ],
            )
            .map_err(|error| {
                LocalAgentKernelError::new("tool_record_append_failed", error.to_string())
            })?;
        Ok(())
    }
}

fn validate_request(request: &LocalToolExecutionRequest) -> Result<(), LocalAgentKernelError> {
    if request.schema_version != KERNEL_REQUEST_VERSION || request.request_type != "tool.execute" {
        return Err(LocalAgentKernelError::new(
            "kernel_request_version_invalid",
            "Kernel 请求协议版本或类型无效。",
        ));
    }
    for (field, value) in [
        ("requestId", request.request_id.as_str()),
        ("sessionId", request.session_id.as_str()),
        ("runId", request.run_id.as_str()),
        ("callId", request.call_id.as_str()),
        ("attemptId", request.attempt_id.as_str()),
        ("toolName", request.tool_name.as_str()),
    ] {
        validate_id(field, value)?;
    }
    if !request.input.is_object() {
        return Err(LocalAgentKernelError::new(
            "tool_input_invalid",
            "工具输入必须是 JSON 对象。",
        ));
    }
    let mut seen = HashSet::new();
    for workspace_id in &request.workspace_bindings {
        validate_id("workspaceId", workspace_id)?;
        if !seen.insert(workspace_id) {
            return Err(LocalAgentKernelError::new(
                "session_workspace_snapshot_invalid",
                "workspaceBindings 不能重复。",
            ));
        }
    }
    Ok(())
}

fn validate_id(field: &str, value: &str) -> Result<(), LocalAgentKernelError> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(LocalAgentKernelError::new(
            "kernel_request_identity_invalid",
            format!("{field} 不是有效标识。"),
        ));
    }
    Ok(())
}

fn take_workspace_id(input: &mut Value) -> Result<String, LocalAgentKernelError> {
    let object = input.as_object_mut().expect("validated tool input object");
    let value = object.remove("workspaceId").ok_or_else(|| {
        LocalAgentKernelError::new(
            "workspace_identity_required",
            "Workspace 工具必须显式携带 workspaceId。",
        )
    })?;
    let workspace_id = value.as_str().ok_or_else(|| {
        LocalAgentKernelError::new("workspace_identity_invalid", "workspaceId 必须是字符串。")
    })?;
    validate_id("workspaceId", workspace_id)?;
    Ok(workspace_id.to_string())
}

fn canonical_logical_targets(
    tool_name: &str,
    arguments: &Value,
) -> Result<Vec<String>, LocalAgentKernelError> {
    let field = match tool_name {
        "fs.read"
        | "fs.list"
        | "fs.glob"
        | "fs.diff"
        | "code.grep"
        | "fs.create"
        | "fs.write"
        | "fs.edit"
        | "fs.delete"
        | "fs.ensure_directory"
        | "document.read" => Some("path"),
        "web.fetch" => Some("url"),
        "web.search" => None,
        _ => None,
    };
    let mut targets = field
        .and_then(|field| arguments.get(field).and_then(Value::as_str))
        .map(|target| vec![target.to_string()])
        .unwrap_or_default();
    targets.sort();
    targets.dedup();
    if matches!(
        tool_name,
        "fs.create" | "fs.write" | "fs.edit" | "fs.delete" | "fs.ensure_directory"
    ) && targets.len() != 1
    {
        return Err(LocalAgentKernelError::new(
            "prepared_effect_target_invalid",
            "闭合 workspace mutation 必须解析为一个精确逻辑 target。",
        ));
    }
    Ok(targets)
}

fn authority_matches_identity(
    authority: &Value,
    request: &LocalToolExecutionRequest,
    prepared: &PreparedEffect,
) -> bool {
    let Some(object) = authority.as_object() else {
        return false;
    };
    let allowed = [
        "authorityId",
        "planId",
        "optionId",
        "sessionId",
        "runId",
        "workspaceId",
        "coveredOperations",
    ];
    if object.len() != allowed.len() || object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return false;
    }
    object.get("sessionId").and_then(Value::as_str) == Some(&request.session_id)
        && object.get("runId").and_then(Value::as_str) == Some(&request.run_id)
        && object.get("workspaceId").and_then(Value::as_str) == prepared.workspace_id.as_deref()
        && object.get("authorityId").and_then(Value::as_str).is_some()
        && object.get("planId").and_then(Value::as_str).is_some()
        && object.get("optionId").and_then(Value::as_str).is_some()
        && object
            .get("coveredOperations")
            .and_then(Value::as_array)
            .is_some()
}

fn authority_covers(authority: &Value, prepared: &PreparedEffect) -> bool {
    if prepared.logical_targets.len() != 1 {
        return false;
    }
    let target = &prepared.logical_targets[0];
    authority
        .get("coveredOperations")
        .and_then(Value::as_array)
        .is_some_and(|operations| {
            operations.iter().any(|operation| {
                let Some(object) = operation.as_object() else {
                    return false;
                };
                let base = object.get("workspaceId").and_then(Value::as_str)
                    == prepared.workspace_id.as_deref()
                    && object.get("operation").and_then(Value::as_str)
                        == Some(prepared.operation.as_str())
                    && object.get("target").and_then(Value::as_str) == Some(target.as_str());
                if !base {
                    return false;
                }
                if prepared.operation == "fs.delete" {
                    object.len() == 4
                        && object.get("targetKind").and_then(Value::as_str)
                            == prepared.delete_target_kind.as_deref()
                } else {
                    object.len() == 3 && object.get("targetKind").is_none()
                }
            })
        })
}

fn permission_mode(
    settings: &Value,
    key: &'static str,
    default: PermissionMode,
) -> Result<PermissionMode, LocalAgentKernelError> {
    let Some(value) = settings.get(key) else {
        return Ok(default);
    };
    match value.as_str() {
        Some("allow") => Ok(PermissionMode::Allow),
        Some("ask") => Ok(PermissionMode::Ask),
        Some("deny") => Ok(PermissionMode::Deny),
        _ => Err(LocalAgentKernelError::new(
            "agent_permission_setting_invalid",
            format!("{key} 必须是 allow、ask 或 deny。"),
        )),
    }
}

fn permission_setting_id(scope: PreparedEffectScope) -> &'static str {
    match scope {
        PreparedEffectScope::Network => "user-setting:agent.permissions.networkRead",
        PreparedEffectScope::External => "user-setting:agent.permissions.external",
        PreparedEffectScope::WorkspaceRead | PreparedEffectScope::WorkspaceMutation => {
            unreachable!("workspace effects are not setting-authorized")
        }
    }
}

fn possible_effects(class: ToolEffectClass, scope: ToolEffectScope) -> Vec<&'static str> {
    match (class, scope) {
        (_, ToolEffectScope::NetworkRead) => vec!["network"],
        (ToolEffectClass::Read, ToolEffectScope::WorkspaceRead) => vec!["workspaceRead"],
        (ToolEffectClass::Mutation, ToolEffectScope::WorkspaceWrite) => {
            vec!["workspaceMutation"]
        }
        _ => Vec::new(),
    }
}

fn effect_names(scope: PreparedEffectScope) -> Vec<&'static str> {
    match scope {
        PreparedEffectScope::WorkspaceRead => vec!["workspaceRead"],
        PreparedEffectScope::WorkspaceMutation => vec!["workspaceMutation"],
        PreparedEffectScope::Network => vec!["network"],
        PreparedEffectScope::External => vec!["external"],
    }
}

fn effect_summary(tool_name: &str, targets: &[String]) -> String {
    if targets.is_empty() {
        format!("执行 {tool_name}")
    } else {
        format!("执行 {tool_name}：{}", targets.join(", "))
    }
}

fn schema_requiring_workspace_id(mut schema: Value) -> Value {
    fn inject(value: &mut Value) {
        let Some(object) = value.as_object_mut() else {
            return;
        };
        if let Some(one_of) = object.get_mut("oneOf").and_then(Value::as_array_mut) {
            for branch in one_of {
                inject(branch);
            }
            return;
        }
        if object.get("type").and_then(Value::as_str) != Some("object") {
            return;
        }
        object
            .entry("properties")
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) {
            properties.insert(
                "workspaceId".to_string(),
                json!({ "type": "string", "minLength": 1, "maxLength": 128 }),
            );
        }
        let required = object
            .entry("required")
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Some(required) = required.as_array_mut() {
            if !required
                .iter()
                .any(|item| item.as_str() == Some("workspaceId"))
            {
                required.push(json!("workspaceId"));
            }
        }
    }
    inject(&mut schema);
    schema
}

fn tool_record(
    request: &LocalToolExecutionRequest,
    prepared: &PreparedEffect,
    authority: Value,
    started_at: &str,
    completed_at: &str,
    outcome: &str,
    output: Option<Value>,
    error: Option<Value>,
) -> Result<Value, LocalAgentKernelError> {
    let mut record = json!({
        "recordId": random_id("record")?,
        "sessionId": request.session_id,
        "runId": request.run_id,
        "callId": request.call_id,
        "attemptId": request.attempt_id,
        "toolName": request.tool_name,
        "input": request.input,
        "preparedEffect": prepared.projection(request),
        "authority": authority,
        "startedAt": started_at,
        "completedAt": completed_at,
        "outcome": outcome,
    });
    if let Some(output) = output {
        record["output"] = output;
    }
    if let Some(error) = error {
        record["error"] = error;
    }
    Ok(record)
}

fn execution_reply(request: &LocalToolExecutionRequest, record: &Value) -> Value {
    json!({
        "schemaVersion": KERNEL_REPLY_VERSION,
        "type": "tool.execution",
        "requestId": request.request_id,
        "callId": request.call_id,
        "status": record.get("outcome").cloned().unwrap_or(Value::Null),
        "record": record,
    })
}

fn cancel_reply(call_id: &str, attempt_id: &str, status: &str, record: Option<Value>) -> Value {
    let mut reply = json!({
        "schemaVersion": KERNEL_REPLY_VERSION,
        "type": "tool.cancelled",
        "requestId": format!("cancel:{call_id}"),
        "callId": call_id,
        "attemptId": attempt_id,
        "status": status,
    });
    if let Some(record) = record {
        reply["record"] = record;
    }
    reply
}

fn validate_record_replay(
    record: &Value,
    request: &LocalToolExecutionRequest,
) -> Result<(), LocalAgentKernelError> {
    let exact = [
        ("sessionId", request.session_id.as_str()),
        ("runId", request.run_id.as_str()),
        ("callId", request.call_id.as_str()),
        ("attemptId", request.attempt_id.as_str()),
        ("toolName", request.tool_name.as_str()),
    ]
    .into_iter()
    .all(|(field, expected)| record.get(field).and_then(Value::as_str) == Some(expected));
    if !exact || record.get("input") != Some(&request.input) {
        return Err(LocalAgentKernelError::new(
            "tool_call_identity_conflict",
            "callId 已绑定到其他工具调用。",
        ));
    }
    Ok(())
}

fn required_record_string<'a>(
    record: &'a Value,
    field: &str,
) -> Result<&'a str, LocalAgentKernelError> {
    record.get(field).and_then(Value::as_str).ok_or_else(|| {
        LocalAgentKernelError::new("tool_record_invalid", format!("ToolRecord 缺少 {field}。"))
    })
}

fn random_id(prefix: &str) -> Result<String, LocalAgentKernelError> {
    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).map_err(|_| {
        LocalAgentKernelError::new("local_agent_entropy_failed", "无法生成本地记录标识。")
    })?;
    let mut value = format!("{prefix}:");
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(value)
}

fn verify_tool_record_store(connection: &Connection) -> Result<(), LocalAgentKernelError> {
    let present: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tool_records')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| {
            LocalAgentKernelError::new("tool_record_store_verify_failed", error.to_string())
        })?;
    if !present {
        return Err(LocalAgentKernelError::new(
            "tool_record_store_schema_incomplete",
            "ToolRecord Store 缺少 tool_records 表。",
        ));
    }
    Ok(())
}

fn verify_tool_record_store_version(connection: &Connection) -> Result<(), LocalAgentKernelError> {
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| {
            LocalAgentKernelError::new("tool_record_store_version_failed", error.to_string())
        })?;
    if version != TOOL_RECORD_STORE_VERSION {
        return Err(LocalAgentKernelError::new(
            "tool_record_store_migration_incomplete",
            format!("ToolRecord Store schema 迁移后版本仍为 {version}。"),
        ));
    }
    Ok(())
}

fn sqlite_is_empty(connection: &Connection) -> Result<bool, LocalAgentKernelError> {
    connection
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| {
            LocalAgentKernelError::new("tool_record_store_empty_check_failed", error.to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_record_store_v2_migrates_to_session_purge_capable_v3() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-tool-record-v2-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let v2_schema = format!(
            "{}\n{}",
            TOOL_RECORD_SCHEMA.replace("PRAGMA user_version = 3;", "PRAGMA user_version = 2;"),
            "CREATE TRIGGER tool_records_are_not_deleted
             BEFORE DELETE ON tool_records BEGIN
                 SELECT RAISE(ABORT, 'tool records are immutable');
             END;"
        );
        {
            let connection = Connection::open(&path).expect("open v2 tool store");
            connection
                .execute_batch(&v2_schema)
                .expect("create v2 schema");
        }
        let store = LocalToolRecordStore::open(&path).expect("migrate tool store");
        let connection = store.connection.lock().expect("lock tool store");
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read tool store version");
        assert_eq!(version, TOOL_RECORD_STORE_VERSION);
        let delete_trigger_present: bool = connection
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM sqlite_schema
                     WHERE type='trigger' AND name='tool_records_are_not_deleted'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("read deletion trigger");
        assert!(!delete_trigger_present);
        drop(connection);
        drop(store);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn workspace_tool_schema_requires_explicit_workspace_id() {
        let kernel = KernelToolRegistry::new();
        let schema = schema_requiring_workspace_id(
            kernel.descriptor("fs.write").unwrap().input_schema.clone(),
        );
        assert!(schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "workspaceId"));
        assert!(schema["properties"].get("workspaceId").is_some());
    }

    #[test]
    fn plan_coverage_is_exact_in_workspace_operation_target_and_delete_kind() {
        let request = LocalToolExecutionRequest {
            schema_version: KERNEL_REQUEST_VERSION.to_string(),
            request_type: "tool.execute".to_string(),
            request_id: "request:test".to_string(),
            session_id: "session:test".to_string(),
            run_id: "run:test".to_string(),
            call_id: "call:test".to_string(),
            attempt_id: "attempt:test".to_string(),
            tool_name: "fs.delete".to_string(),
            input: json!({ "workspaceId": "workspace:test", "path": "src/a.rs" }),
            workspace_bindings: vec!["workspace:test".to_string()],
            plan_authorities: Vec::new(),
            non_workspace_authority: None,
        };
        let prepared = PreparedEffect {
            scope: PreparedEffectScope::WorkspaceMutation,
            workspace_id: Some("workspace:test".to_string()),
            operation: "fs.delete".to_string(),
            logical_targets: vec!["src/a.rs".to_string()],
            private_resolved_targets: Vec::new(),
            canonical_invocation: json!({}),
            canonical_arguments: json!({}),
            workspace_root: None,
            delete_target_kind: Some("file".to_string()),
            adapter: PreparedToolAdapter::Builtin,
        };
        let authority = json!({
            "authorityId": "authority:test",
            "planId": "plan:test",
            "optionId": "option:test",
            "sessionId": "session:test",
            "runId": "run:test",
            "workspaceId": "workspace:test",
            "coveredOperations": [{
                "workspaceId": "workspace:test",
                "operation": "fs.delete",
                "target": "src/a.rs",
                "targetKind": "file"
            }]
        });
        assert!(authority_matches_identity(&authority, &request, &prepared));
        assert!(authority_covers(&authority, &prepared));
        let mut wrong = authority.clone();
        wrong["coveredOperations"][0]["targetKind"] = json!("directoryTree");
        assert!(!authority_covers(&wrong, &prepared));
    }
}
