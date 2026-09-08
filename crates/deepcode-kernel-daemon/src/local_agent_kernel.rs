use crate::local_agent_mcp::McpRuntime;
use crate::local_agent_store::{LocalAgentJournal, LocalAgentStoreError};
use crate::local_agent_tool_catalog::{
    CatalogEffectScope, PreparedCatalogBinding, ToolCatalogError, ToolCatalogSnapshot,
};
use deepcode_kernel_runtime::executors::{
    resolved_network_target, KernelCancellationToken, KernelExecutorConfig,
    KernelToolExecutionContext, KernelToolExecutionOutcome, KernelToolExecutionResult,
    SecretProvider,
};
use deepcode_kernel_runtime::workspace_boundary::WorkspaceBoundary;
use deepcode_kernel_tools::{ToolAvailability, ToolInputIssue};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const KERNEL_REQUEST_VERSION: &str = "deepcode.kernel-request";
const KERNEL_REPLY_VERSION: &str = "deepcode.kernel-reply";
const TOOL_RECORD_SCHEMA: &str = include_str!("../../../contracts/agent-runtime/tool-record.sql");
const TOOL_RECORD_STORE_VERSION: u32 = 1;
const ATTEMPT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub(crate) struct LocalAgentKernelError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    input_issues: Option<Vec<ToolInputIssue>>,
}

impl LocalAgentKernelError {
    fn input(path: &str, rule: &str, message: &str, expected: Option<Value>) -> Self {
        Self {
            code: "tool_input_invalid",
            message: message.into(),
            input_issues: Some(vec![ToolInputIssue::new(path, rule, message, expected)]),
        }
    }
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            input_issues: None,
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
pub(crate) enum PermissionMode {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkspaceMutationMode {
    Plan,
    Allow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreparedEffectScope {
    LocalRead,
    WorkspaceRead,
    WorkspaceMutation,
    Process,
    Network,
    External,
}

/// Workspace reads and the project-debugging process capability are authorized
/// by the frozen binding. Structured fs.* mutation either requires an exact
/// confirmed Plan revision or is allowed by the explicit workspace-autonomy
/// setting. Neither path permits a prepared target outside the bound workspace.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LocalAgentPermissionPolicy {
    workspace_mutation: WorkspaceMutationMode,
    network: PermissionMode,
    external: PermissionMode,
}

impl LocalAgentPermissionPolicy {
    pub(crate) fn from_settings(settings: &Value) -> Result<Self, LocalAgentKernelError> {
        Ok(Self {
            workspace_mutation: workspace_mutation_mode(settings)?,
            network: permission_mode(
                settings,
                "agent.permissions.networkRead",
                PermissionMode::Allow,
            )?,
            external: permission_mode(settings, "agent.permissions.external", PermissionMode::Ask)?,
        })
    }

    fn mode(self, scope: PreparedEffectScope) -> Option<PermissionMode> {
        match scope {
            PreparedEffectScope::Network => Some(self.network),
            PreparedEffectScope::External => Some(self.external),
            PreparedEffectScope::LocalRead
            | PreparedEffectScope::WorkspaceRead
            | PreparedEffectScope::WorkspaceMutation
            | PreparedEffectScope::Process => None,
        }
    }

    pub(crate) fn network_mode(self) -> PermissionMode {
        self.network
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
    extension_generation_ref: String,
    kernel_catalog_snapshot_ref: String,
    tool_binding_ref: String,
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
pub(crate) struct PrepareToolCatalogRequest {
    session_id: String,
    run_id: String,
    extension_generation_ref: String,
}

impl PrepareToolCatalogRequest {
    pub(crate) fn new(
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        extension_generation_ref: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            run_id: run_id.into(),
            extension_generation_ref: extension_generation_ref.into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReleaseToolCatalogRequest {
    session_id: String,
    run_id: String,
    kernel_catalog_snapshot_ref: String,
}

impl ReleaseToolCatalogRequest {
    pub(crate) fn new(
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        kernel_catalog_snapshot_ref: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            run_id: run_id.into(),
            kernel_catalog_snapshot_ref: kernel_catalog_snapshot_ref.into(),
        }
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }

    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }

    pub(crate) fn kernel_catalog_snapshot_ref(&self) -> &str {
        &self.kernel_catalog_snapshot_ref
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NonWorkspaceAuthority {
    authority_id: String,
    decision: String,
}

#[derive(Clone)]
pub(crate) struct LocalAgentKernel {
    output_root: PathBuf,
    records: LocalToolRecordStore,
    journal: LocalAgentJournal,
    resolver: Arc<dyn WorkspaceResolverPort>,
    generations: Arc<Mutex<KernelGenerationState>>,
    active: Arc<Mutex<HashMap<String, ActiveCall>>>,
}

#[derive(Clone)]
pub(crate) struct PreparedKernelGeneration {
    generation: Arc<KernelGeneration>,
}

struct KernelGeneration {
    catalog: Arc<ToolCatalogSnapshot>,
    executor_config: KernelExecutorConfig,
    permissions: LocalAgentPermissionPolicy,
}

#[derive(Clone, Eq, PartialEq, Hash)]
struct RunCatalogKey {
    session_id: String,
    run_id: String,
}

struct KernelGenerationState {
    run_bindings: HashMap<RunCatalogKey, Arc<KernelGeneration>>,
    released_run_bindings: HashMap<RunCatalogKey, ReleasedRunBinding>,
}

struct ReleasedRunBinding {
    snapshot_ref: String,
    dispose_error: Option<LocalAgentKernelError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActivePhase {
    Prepared,
    Executing,
}

#[derive(Clone)]
struct ActiveCall {
    request: LocalToolExecutionRequest,
    phase: ActivePhase,
    control: AttemptControl,
}

#[derive(Default)]
struct AttemptCompletion {
    cancel_phase: Option<ActivePhase>,
    outcome_claimed: bool,
    complete: bool,
}

#[derive(Clone, Default)]
struct AttemptControl {
    cancellation: KernelCancellationToken,
    completion: Arc<(Mutex<AttemptCompletion>, Condvar)>,
}

impl AttemptControl {
    fn cancellation(&self) -> KernelCancellationToken {
        self.cancellation.clone()
    }

    fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    fn request_cancel(&self, phase: ActivePhase) {
        let (state, _) = self.completion.as_ref();
        let mut state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.outcome_claimed || state.complete {
            return;
        }
        state.cancel_phase.get_or_insert(phase);
        self.cancellation.cancel();
    }

    fn claim_outcome(&self) -> Option<ActivePhase> {
        let (state, _) = self.completion.as_ref();
        let mut state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.outcome_claimed = true;
        state.cancel_phase
    }

    fn finish(&self) {
        let (state, complete) = self.completion.as_ref();
        let mut state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.complete = true;
        complete.notify_all();
    }

    fn wait_complete(&self, timeout: Duration) -> bool {
        let (state, complete) = self.completion.as_ref();
        let state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.complete {
            return true;
        }
        let (state, _) = complete
            .wait_timeout_while(state, timeout, |state| !state.complete)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.complete
    }
}

impl LocalAgentKernel {
    pub(crate) fn open(
        record_path: &Path,
        journal: LocalAgentJournal,
        resolver: Arc<dyn WorkspaceResolverPort>,
    ) -> Result<Self, LocalAgentKernelError> {
        Ok(Self {
            records: LocalToolRecordStore::open(record_path)?,
            output_root: record_path.with_extension("outputs"),
            journal,
            resolver,
            generations: Arc::new(Mutex::new(KernelGenerationState {
                run_bindings: HashMap::new(),
                released_run_bindings: HashMap::new(),
            })),
            active: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub(crate) fn prepare_generation(
        extension_generation_ref: &str,
        kernel_runtime_generation_key: &str,
        executor_config: KernelExecutorConfig,
        secret_provider: Arc<dyn SecretProvider>,
        mcp: McpRuntime,
        permissions: LocalAgentPermissionPolicy,
        enable_web_search: bool,
        product: Arc<crate::local_agent_product_tools::ProductTools>,
    ) -> Result<PreparedKernelGeneration, LocalAgentKernelError> {
        let catalog = ToolCatalogSnapshot::prepare(
            extension_generation_ref,
            kernel_runtime_generation_key,
            executor_config.clone(),
            secret_provider,
            mcp,
            enable_web_search,
            product,
        )
        .map_err(catalog_error)?;
        Ok(PreparedKernelGeneration {
            generation: Arc::new(KernelGeneration {
                catalog,
                executor_config,
                permissions,
            }),
        })
    }

    pub(crate) fn bind_run_catalog(
        &self,
        request: PrepareToolCatalogRequest,
        prepared: PreparedKernelGeneration,
    ) -> Result<Value, LocalAgentKernelError> {
        for (field, value) in [
            ("sessionId", request.session_id.as_str()),
            ("runId", request.run_id.as_str()),
            (
                "extensionGenerationRef",
                request.extension_generation_ref.as_str(),
            ),
        ] {
            validate_id(field, value)?;
        }
        let key = RunCatalogKey {
            session_id: request.session_id.clone(),
            run_id: request.run_id.clone(),
        };
        let generation = prepared.generation;
        {
            let mut state = self.lock_generations()?;
            if state.released_run_bindings.contains_key(&key) {
                return Err(LocalAgentKernelError::new(
                    "tool_catalog_run_already_released",
                    "当前 run 的 catalog lease 已经释放，不能重新获取。",
                ));
            }
            if let Some(existing) = state.run_bindings.get(&key) {
                if existing.catalog.extension_generation_ref() != request.extension_generation_ref
                    || existing.catalog.snapshot_ref() != generation.catalog.snapshot_ref()
                {
                    return Err(LocalAgentKernelError::new(
                        "tool_catalog_run_identity_conflict",
                        "当前 run 已固定到其他 ExtensionGenerationRef 或 catalog snapshot。",
                    ));
                }
            } else {
                if generation.catalog.extension_generation_ref() != request.extension_generation_ref
                {
                    return Err(LocalAgentKernelError::new(
                        "extension_generation_identity_conflict",
                        "Prepared generation 与请求的 ExtensionGenerationRef 不一致。",
                    ));
                }
                state.run_bindings.insert(key, Arc::clone(&generation));
            }
        }
        Ok(catalog_prepare_reply(&request, &generation.catalog))
    }

    pub(crate) fn release_catalog(
        &self,
        request: ReleaseToolCatalogRequest,
    ) -> Result<Value, LocalAgentKernelError> {
        for (field, value) in [
            ("sessionId", request.session_id.as_str()),
            ("runId", request.run_id.as_str()),
            (
                "kernelCatalogSnapshotRef",
                request.kernel_catalog_snapshot_ref.as_str(),
            ),
        ] {
            validate_id(field, value)?;
        }
        let key = RunCatalogKey {
            session_id: request.session_id.clone(),
            run_id: request.run_id.clone(),
        };
        let has_live_binding = {
            let state = self.lock_generations()?;
            if let Some(released) = state.released_run_bindings.get(&key) {
                if released.snapshot_ref != request.kernel_catalog_snapshot_ref {
                    return Err(LocalAgentKernelError::new(
                        "tool_catalog_release_identity_conflict",
                        "当前 run 已释放的是其他 KernelCatalogSnapshotRef。",
                    ));
                }
                if let Some(error) = released.dispose_error.clone() {
                    return Err(error);
                }
                return Ok(catalog_release_reply(&request, true));
            } else {
                if let Some(generation) = state.run_bindings.get(&key) {
                    if generation.catalog.snapshot_ref() != request.kernel_catalog_snapshot_ref {
                        return Err(LocalAgentKernelError::new(
                            "tool_catalog_release_identity_conflict",
                            "KernelCatalogSnapshotRef 与当前 run 的 catalog lease 不一致。",
                        ));
                    }
                    true
                } else {
                    false
                }
            }
        };
        if !has_live_binding {
            let runtime = self
                .journal
                .run_runtime_snapshot(&request.session_id, &request.run_id)?;
            if runtime
                .get("kernelCatalogSnapshotRef")
                .and_then(Value::as_str)
                != Some(request.kernel_catalog_snapshot_ref.as_str())
            {
                return Err(LocalAgentKernelError::new(
                    "tool_catalog_release_identity_conflict",
                    "KernelCatalogSnapshotRef 与持久化 run.runtime snapshot 不一致。",
                ));
            }
            self.lock_generations()?.released_run_bindings.insert(
                key,
                ReleasedRunBinding {
                    snapshot_ref: request.kernel_catalog_snapshot_ref.clone(),
                    dispose_error: None,
                },
            );
            return Ok(catalog_release_reply(&request, true));
        }
        self.cancel_and_drain_attempts(Some((&request.session_id, &request.run_id)))?;
        let already_released = {
            let mut state = self.lock_generations()?;
            if let Some(released) = state.released_run_bindings.get(&key) {
                if released.snapshot_ref != request.kernel_catalog_snapshot_ref {
                    return Err(LocalAgentKernelError::new(
                        "tool_catalog_release_identity_conflict",
                        "当前 run 已释放的是其他 KernelCatalogSnapshotRef。",
                    ));
                }
                if let Some(error) = released.dispose_error.clone() {
                    return Err(error);
                }
                true
            } else {
                let generation = state.run_bindings.get(&key).ok_or_else(|| {
                    LocalAgentKernelError::new(
                        "tool_catalog_run_binding_not_found",
                        "当前 run 没有可释放的 catalog lease。",
                    )
                })?;
                if generation.catalog.snapshot_ref() != request.kernel_catalog_snapshot_ref {
                    return Err(LocalAgentKernelError::new(
                        "tool_catalog_release_identity_conflict",
                        "KernelCatalogSnapshotRef 与当前 run 的 catalog lease 不一致。",
                    ));
                }
                if generation.catalog.active_attempts() != 0 {
                    return Err(LocalAgentKernelError::new(
                        "tool_catalog_release_cleanup_incomplete",
                        "当前 run 的物理 attempt lease 尚未归零，不能释放 catalog。",
                    ));
                }
                let generation = state
                    .run_bindings
                    .remove(&key)
                    .expect("validated run binding exists");
                let still_pinned = state
                    .run_bindings
                    .values()
                    .any(|candidate| Arc::ptr_eq(candidate, &generation));
                let dispose_error = if still_pinned {
                    None
                } else {
                    generation.catalog.dispose().err().map(catalog_error)
                };
                state.released_run_bindings.insert(
                    key,
                    ReleasedRunBinding {
                        snapshot_ref: request.kernel_catalog_snapshot_ref.clone(),
                        dispose_error: dispose_error.clone(),
                    },
                );
                if let Some(error) = dispose_error {
                    return Err(error);
                }
                false
            }
        };
        Ok(catalog_release_reply(&request, already_released))
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

        let prepared = match self.prepare_tool(&request) {
            Ok(prepared) => prepared,
            Err(mut error) => {
                if let Some(issues) = error.input_issues.take() {
                    return Ok(json!({
                        "schemaVersion": KERNEL_REPLY_VERSION,
                        "type": "tool.execution",
                        "requestId": request.request_id,
                        "callId": request.call_id,
                        "status": "inputRejected",
                        "rejection": {
                            "sessionId": request.session_id,
                            "runId": request.run_id,
                            "extensionGenerationRef": request.extension_generation_ref,
                            "kernelCatalogSnapshotRef": request.kernel_catalog_snapshot_ref,
                            "toolBindingRef": request.tool_binding_ref,
                            "callId": request.call_id,
                            "attemptId": request.attempt_id,
                            "toolName": request.tool_name,
                            "input": request.input,
                            "rejectedAt": crate::now_text(),
                            "error": { "code": error.code, "message": error.message, "issues": issues }
                        }
                    }));
                }
                return Err(error);
            }
        };
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
                let control = AttemptControl::default();
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
                            phase: ActivePhase::Prepared,
                            control: control.clone(),
                        },
                    );
                }

                let start_execution = {
                    let mut active = self.lock_active()?;
                    match active.get_mut(&request.call_id) {
                        Some(call)
                            if call.request.attempt_id == request.attempt_id
                                && !call.control.is_cancelled() =>
                        {
                            call.phase = ActivePhase::Executing;
                            true
                        }
                        _ => false,
                    }
                };
                let result = start_execution
                    .then(|| self.execute_prepared(&prepared, &request, control.cancellation()));
                let cancel_phase = control.claim_outcome();
                let completed_at = crate::now_text();
                let record_result = match (cancel_phase, result) {
                    (Some(ActivePhase::Prepared), _) => tool_record(
                        &request,
                        &prepared,
                        authority,
                        &started_at,
                        &completed_at,
                        "cancelled",
                        None,
                        None,
                    ),
                    (Some(ActivePhase::Executing), _) => tool_record(
                        &request,
                        &prepared,
                        authority,
                        &started_at,
                        &completed_at,
                        "indeterminate",
                        None,
                        Some(json!({
                            "code": "tool_effect_outcome_unknown",
                            "message": "取消发生时工具 effect 已进入执行边界，结果无法确定。",
                        })),
                    ),
                    (None, Some(Ok(result))) => tool_record_from_execution_result(
                        &request,
                        &prepared,
                        authority,
                        &started_at,
                        &completed_at,
                        result,
                    ),
                    (None, Some(Err(message))) => tool_record(
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
                    ),
                    (None, None) => Err(LocalAgentKernelError::new(
                        "tool_call_state_lost",
                        "工具调用在进入执行前丢失了确定状态。",
                    )),
                };
                let final_result = record_result.and_then(|record| {
                    self.records.insert(&record)?;
                    Ok(execution_reply(&request, &record))
                });
                let remove_result = self
                    .lock_active()
                    .map(|mut active| active.remove(&request.call_id));
                control.finish();
                remove_result?;
                final_result
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
            return Ok(cancel_reply(call_id, attempt_id, "notFound", None));
        };
        if active.request.attempt_id != attempt_id {
            return Err(LocalAgentKernelError::new(
                "tool_call_identity_conflict",
                "callId 已绑定到其他 attemptId。",
            ));
        }
        active.control.request_cancel(active.phase);
        if !active.control.wait_complete(ATTEMPT_CLEANUP_TIMEOUT) {
            return Err(LocalAgentKernelError::new(
                "tool_cancel_cleanup_timeout",
                "工具取消后物理资源未在限定时间内完成回收。",
            ));
        }
        let record = self.records.read(call_id)?.ok_or_else(|| {
            LocalAgentKernelError::new(
                "tool_call_state_lost",
                "工具执行 owner 完成清理后没有写入唯一终态记录。",
            )
        })?;
        validate_record_replay(&record, &active.request)?;
        let outcome = required_record_string(&record, "outcome")?.to_string();
        Ok(cancel_reply(call_id, attempt_id, &outcome, Some(record)))
    }

    pub(crate) fn read_record(
        &self,
        call_id: &str,
    ) -> Result<Option<Value>, LocalAgentKernelError> {
        validate_id("callId", call_id)?;
        self.records.read(call_id)
    }

    pub(crate) fn shutdown_plugins(&self) -> Result<(), LocalAgentKernelError> {
        self.cancel_and_drain_attempts(None)?;
        let generations = {
            let state = self.lock_generations()?;
            let mut generations = Vec::new();
            for generation in state.run_bindings.values() {
                if !generations
                    .iter()
                    .any(|candidate| Arc::ptr_eq(candidate, generation))
                {
                    generations.push(Arc::clone(generation));
                }
            }
            generations
        };
        if generations
            .iter()
            .any(|generation| generation.catalog.active_attempts() != 0)
        {
            return Err(LocalAgentKernelError::new(
                "tool_runtime_busy",
                "Kernel 仍有物理 attempt lease，不能释放 ToolProvider。",
            ));
        }
        dispose_generations(generations)
    }

    fn cancel_and_drain_attempts(
        &self,
        target_run: Option<(&str, &str)>,
    ) -> Result<(), LocalAgentKernelError> {
        let matches_target = |call: &ActiveCall| {
            target_run.map_or(true, |(session_id, run_id)| {
                call.request.session_id == session_id && call.request.run_id == run_id
            })
        };
        let attempts = {
            let active = self.lock_active()?;
            active
                .values()
                .filter(|call| matches_target(call))
                .map(|call| (call.phase, call.control.clone()))
                .collect::<Vec<_>>()
        };
        for (phase, control) in &attempts {
            control.request_cancel(*phase);
        }
        let deadline = Instant::now() + ATTEMPT_CLEANUP_TIMEOUT;
        for (_, control) in attempts {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || !control.wait_complete(remaining) {
                return Err(LocalAgentKernelError::new(
                    "tool_runtime_cleanup_timeout",
                    "Kernel attempt 资源未在限定时间内完成回收。",
                ));
            }
        }
        if self
            .lock_active()?
            .values()
            .any(|call| matches_target(call))
        {
            return Err(LocalAgentKernelError::new(
                "tool_runtime_cleanup_incomplete",
                "Kernel attempt 完成清理后仍保留 active call。",
            ));
        }
        Ok(())
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
        let generation = self.bound_generation(request)?;
        let binding = generation
            .catalog
            .binding(&request.tool_binding_ref, &request.tool_name)
            .map_err(catalog_error)?;
        if binding.availability() == ToolAvailability::Blocked {
            return Err(LocalAgentKernelError::new(
                "tool_blocked",
                format!("Kernel 工具 {} 当前被阻止，不能执行。", request.tool_name),
            ));
        }
        let scope = match binding.effect_scope() {
            CatalogEffectScope::LocalRead => PreparedEffectScope::LocalRead,
            CatalogEffectScope::WorkspaceRead => PreparedEffectScope::WorkspaceRead,
            CatalogEffectScope::WorkspaceMutation => PreparedEffectScope::WorkspaceMutation,
            CatalogEffectScope::Process => PreparedEffectScope::Process,
            CatalogEffectScope::Network => PreparedEffectScope::Network,
            CatalogEffectScope::External => PreparedEffectScope::External,
        };
        let mut tool_input = request.input.clone();
        let workspace_id = match scope {
            PreparedEffectScope::WorkspaceRead
            | PreparedEffectScope::WorkspaceMutation
            | PreparedEffectScope::Process => Some(take_workspace_id(&mut tool_input)?),
            PreparedEffectScope::LocalRead
            | PreparedEffectScope::Network
            | PreparedEffectScope::External => {
                if tool_input.get("workspaceId").is_some() {
                    return Err(LocalAgentKernelError::input(
                        "$.workspaceId",
                        "additionalProperties",
                        "非 workspace 工具不能携带 workspaceId。",
                        None,
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
        let arguments = binding.canonicalize(tool_input).map_err(catalog_error)?;
        let mut logical_targets = match binding
            .binding_logical_targets(&arguments)
            .map_err(catalog_error)?
        {
            Some(targets) => targets,
            None => canonical_logical_targets(&request.tool_name, &arguments)?,
        };
        if matches!(
            scope,
            PreparedEffectScope::Network | PreparedEffectScope::External
        ) {
            if let Some(target) = binding.logical_target() {
                logical_targets.push(target.to_string());
            }
        }
        if let Some(target) = resolved_network_target(
            request.tool_name.as_str(),
            &arguments,
            &generation.executor_config,
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
                let resolve_target = |target: &str| match scope {
                    PreparedEffectScope::WorkspaceRead | PreparedEffectScope::Process => {
                        boundary.resolve_read(target)
                    }
                    PreparedEffectScope::WorkspaceMutation => boundary.resolve_mutation(target),
                    PreparedEffectScope::LocalRead
                    | PreparedEffectScope::Network
                    | PreparedEffectScope::External => {
                        unreachable!("workspace target scope")
                    }
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
                Some("directoryTree") => Some("directoryTree".to_string()),
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
        let process_workspace_mode = if request.tool_name == "bash" {
            match arguments.get("workspaceMode").and_then(Value::as_str) {
                Some("read") => Some("read".to_string()),
                Some("write") => Some("write".to_string()),
                _ => {
                    return Err(LocalAgentKernelError::new(
                        "tool_input_invalid",
                        "bash 必须显式声明 workspaceMode=read 或 write。",
                    ))
                }
            }
        } else {
            None
        };
        let process_execution_scope = if request.tool_name == "bash" {
            match arguments.get("executionScope").and_then(Value::as_str) {
                Some("workspace") => Some("workspace".to_string()),
                Some("host") => Some("host".to_string()),
                _ => {
                    return Err(LocalAgentKernelError::new(
                        "tool_input_invalid",
                        "bash 必须显式声明 executionScope=workspace 或 host。",
                    ))
                }
            }
        } else {
            None
        };
        Ok(PreparedEffect {
            generation,
            binding,
            scope,
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
            process_workspace_mode,
            process_execution_scope,
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
            PreparedEffectScope::LocalRead => Ok(Admission::Allowed(
                json!({"decision":"allow", "source":"localRead"}),
            )),
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
            PreparedEffectScope::Process => {
                let workspace_admission =
                    if prepared.process_workspace_mode.as_deref() == Some("read") {
                        let workspace_id = prepared
                            .workspace_id
                            .as_deref()
                            .expect("prepared process workspace");
                        Admission::Allowed(json!({
                            "decision": "allow",
                            "source": "workspaceBinding",
                            "workspaceId": workspace_id,
                        }))
                    } else {
                        self.admit_workspace_mutation(request, prepared)?
                    };
                if prepared.process_execution_scope.as_deref() != Some("host") {
                    return Ok(workspace_admission);
                }
                let workspace_authority = match workspace_admission {
                    Admission::Allowed(authority) => authority,
                    denied @ Admission::Denied { .. } => return Ok(denied),
                    Admission::ApprovalRequired => {
                        unreachable!("workspace admission never requests approval")
                    }
                };
                match self.admit_non_workspace(
                    request,
                    prepared,
                    PreparedEffectScope::External,
                    "用户拒绝了 Host Shell 的外部 effect。",
                )? {
                    Admission::ApprovalRequired => Ok(Admission::ApprovalRequired),
                    Admission::Allowed(external_authority) => Ok(Admission::Allowed(json!({
                        "decision": "allow",
                        "source": "composite",
                        "workspaceAuthority": workspace_authority,
                        "externalAuthority": external_authority,
                    }))),
                    Admission::Denied {
                        authority: external_authority,
                        error,
                    } => Ok(Admission::Denied {
                        authority: json!({
                            "decision": "deny",
                            "source": "composite",
                            "workspaceAuthority": workspace_authority,
                            "externalAuthority": external_authority,
                        }),
                        error,
                    }),
                }
            }
            PreparedEffectScope::WorkspaceMutation => {
                self.admit_workspace_mutation(request, prepared)
            }
            PreparedEffectScope::Network | PreparedEffectScope::External => self
                .admit_non_workspace(
                    request,
                    prepared,
                    prepared.scope,
                    "用户拒绝了该非 workspace effect。",
                ),
        }
    }

    fn admit_non_workspace(
        &self,
        request: &LocalToolExecutionRequest,
        prepared: &PreparedEffect,
        scope: PreparedEffectScope,
        denial_message: &str,
    ) -> Result<Admission, LocalAgentKernelError> {
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
                    "message": denial_message,
                }),
            });
        }
        match prepared
            .generation
            .permissions
            .mode(scope)
            .expect("non-workspace policy")
        {
            PermissionMode::Allow => Ok(Admission::Allowed(json!({
                "decision": "allow",
                "source": "userSetting",
                "authorityId": permission_setting_id(scope),
            }))),
            PermissionMode::Ask => Ok(Admission::ApprovalRequired),
            PermissionMode::Deny => Ok(Admission::Denied {
                authority: json!({
                    "decision": "deny",
                    "source": "userSetting",
                    "reason": "用户设置拒绝了该非 workspace effect。",
                }),
                error: json!({
                    "code": "tool_effect_denied_by_setting",
                    "message": "用户设置拒绝了该非 workspace effect。",
                }),
            }),
        }
    }

    fn admit_workspace_mutation(
        &self,
        request: &LocalToolExecutionRequest,
        prepared: &PreparedEffect,
    ) -> Result<Admission, LocalAgentKernelError> {
        if prepared.generation.permissions.workspace_mutation == WorkspaceMutationMode::Allow {
            return Ok(Admission::Allowed(json!({
                "decision": "allow",
                "source": "userSetting",
                "authorityId": "user-setting:agent.permissions.workspaceMutation",
                "workspaceId": prepared.workspace_id,
            })));
        }
        for authority in &request.plan_authorities {
            if !authority_matches_identity(authority, request, prepared) {
                continue;
            }
            if !self
                .journal
                .plan_authority_is_committed(&request.session_id, authority)?
            {
                continue;
            }
            if authority_covers(authority, prepared) {
                return Ok(Admission::Allowed(json!({
                    "decision": "allow",
                    "source": "plan",
                    "workspaceId": prepared.workspace_id,
                    "authorityId": authority.get("authorityId"),
                    "planId": authority.get("planId"),
                    "revision": authority.get("revision"),
                    "decisionId": authority.get("decisionId"),
                })));
            }
        }
        Ok(Admission::denied(
            "workspace_mutation_plan_required",
            "本调用未执行：目标文件、删除类型或 Bash 执行范围未被当前已确认 Plan 覆盖。只有扩大这些范围才需修订 Plan；同一文件的 edit/write 切换与同一执行范围内的命令细节调整无需重新确认。",
        ))
    }

    fn execute_prepared(
        &self,
        prepared: &PreparedEffect,
        request: &LocalToolExecutionRequest,
        cancellation: KernelCancellationToken,
    ) -> Result<KernelToolExecutionResult, String> {
        let _private_targets = &prepared.private_resolved_targets;
        let lease = prepared.binding.begin_attempt();
        let result = prepared
            .binding
            .invoke(
                &request.attempt_id,
                prepared.canonical_arguments.clone(),
                KernelToolExecutionContext {
                    output_directory: Some(
                        self.session_output_directory(&request.session_id).join(
                            deepcode_kernel_tools::hash_bytes(request.attempt_id.as_bytes()),
                        ),
                    ),
                    workspace_root: prepared.workspace_root.clone(),
                    workspace_id: prepared.workspace_id.clone(),
                    private_resolved_targets: prepared.private_resolved_targets.clone(),
                    cancellation,
                },
            )
            .map_err(|error| format!("{}: {}", error.code, error.message));
        drop(lease);
        result
    }

    fn session_output_directory(&self, session_id: &str) -> PathBuf {
        self.output_root
            .join(deepcode_kernel_tools::hash_bytes(session_id.as_bytes()))
    }

    pub(crate) fn delete_session_outputs(
        &self,
        session_id: &str,
    ) -> Result<(), LocalAgentKernelError> {
        match std::fs::remove_dir_all(self.session_output_directory(session_id)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(LocalAgentKernelError::new(
                "tool_output_cleanup_failed",
                error.to_string(),
            )),
        }
    }

    fn bound_generation(
        &self,
        request: &LocalToolExecutionRequest,
    ) -> Result<Arc<KernelGeneration>, LocalAgentKernelError> {
        let key = RunCatalogKey {
            session_id: request.session_id.clone(),
            run_id: request.run_id.clone(),
        };
        let state = self.lock_generations()?;
        let generation = state.run_bindings.get(&key).ok_or_else(|| {
            LocalAgentKernelError::new(
                "tool_catalog_run_binding_missing",
                "当前 run 尚未 prepare immutable Kernel catalog。",
            )
        })?;
        if generation.catalog.extension_generation_ref() != request.extension_generation_ref
            || generation.catalog.snapshot_ref() != request.kernel_catalog_snapshot_ref
        {
            return Err(LocalAgentKernelError::new(
                "tool_catalog_execution_identity_conflict",
                "工具请求的 generation/catalog identity 与当前 run lease 不一致。",
            ));
        }
        Ok(Arc::clone(generation))
    }

    fn lock_active(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, ActiveCall>>, LocalAgentKernelError> {
        self.active.lock().map_err(|_| {
            LocalAgentKernelError::new("tool_runtime_lock_failed", "Kernel 工具运行状态锁已损坏。")
        })
    }

    fn lock_generations(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, KernelGenerationState>, LocalAgentKernelError> {
        self.generations.lock().map_err(|_| {
            LocalAgentKernelError::new(
                "tool_catalog_generation_lock_failed",
                "Kernel catalog generation 状态锁已损坏。",
            )
        })
    }
}

fn catalog_prepare_reply(
    request: &PrepareToolCatalogRequest,
    catalog: &ToolCatalogSnapshot,
) -> Value {
    json!({
        "schemaVersion": KERNEL_REPLY_VERSION,
        "type": "tool.catalog.prepared",
        "sessionId": request.session_id,
        "runId": request.run_id,
        "extensionGenerationRef": catalog.extension_generation_ref(),
        "kernelCatalogSnapshotRef": catalog.snapshot_ref(),
        "tools": catalog.provider_view(),
    })
}

fn catalog_release_reply(request: &ReleaseToolCatalogRequest, already_released: bool) -> Value {
    json!({
        "schemaVersion": KERNEL_REPLY_VERSION,
        "type": "tool.catalog.released",
        "sessionId": request.session_id,
        "runId": request.run_id,
        "kernelCatalogSnapshotRef": request.kernel_catalog_snapshot_ref,
        "released": true,
        "alreadyReleased": already_released,
    })
}

fn dispose_generations(
    generations: Vec<Arc<KernelGeneration>>,
) -> Result<(), LocalAgentKernelError> {
    let mut errors = Vec::new();
    for generation in generations {
        if let Err(error) = generation.catalog.dispose() {
            errors.push(format!("{}: {}", error.code, error.message));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(LocalAgentKernelError::new(
            "tool_provider_dispose_failed",
            errors.join("；"),
        ))
    }
}

fn catalog_error(error: ToolCatalogError) -> LocalAgentKernelError {
    LocalAgentKernelError {
        code: error.code,
        message: error.message,
        input_issues: error.input_issues,
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
    generation: Arc<KernelGeneration>,
    binding: PreparedCatalogBinding,
    scope: PreparedEffectScope,
    workspace_id: Option<String>,
    operation: String,
    logical_targets: Vec<String>,
    private_resolved_targets: Vec<String>,
    canonical_invocation: Value,
    canonical_arguments: Value,
    workspace_root: Option<String>,
    delete_target_kind: Option<String>,
    process_workspace_mode: Option<String>,
    process_execution_scope: Option<String>,
}

impl PreparedEffect {
    fn projection(&self, request: &LocalToolExecutionRequest) -> Value {
        let mut projection = json!({
            "callId": request.call_id,
            "attemptId": request.attempt_id,
            "sessionId": request.session_id,
            "runId": request.run_id,
            "extensionGenerationRef": self.binding.extension_generation_ref(),
            "kernelCatalogSnapshotRef": self.binding.snapshot_ref(),
            "toolBindingRef": self.binding.binding_ref(),
            "contributionRef": self.binding.contribution_ref(),
            "providerRef": self.binding.provider_ref(),
            "origin": self.binding.origin(),
            "toolName": request.tool_name,
            "operation": self.operation,
            "logicalTargets": self.logical_targets,
            "canonicalInvocation": self.canonical_invocation,
        });
        if let Some(workspace_id) = self.workspace_id.as_deref() {
            projection["workspaceId"] = json!(workspace_id);
        }
        if let Some(plugin_instance_ref) = self.binding.plugin_instance_ref() {
            projection["pluginInstanceRef"] = json!(plugin_instance_ref);
        }
        if let Some(workspace_mode) = self.process_workspace_mode.as_deref() {
            projection["processWorkspaceMode"] = json!(workspace_mode);
        }
        if let Some(execution_scope) = self.process_execution_scope.as_deref() {
            projection["processExecutionScope"] = json!(execution_scope);
        }
        projection
    }

    fn preview(&self, tool_name: &str) -> Value {
        json!({
            "summary": effect_summary(tool_name, &self.logical_targets, &self.canonical_arguments),
            "effects": process_effect_names(self),
            "logicalTargets": self.logical_targets,
        })
    }
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
            0 if !existed || sqlite_is_empty(&connection)? => {
                connection.execute_batch(TOOL_RECORD_SCHEMA).map_err(|error| {
                    LocalAgentKernelError::new(
                        "tool_record_schema_failed",
                        format!("创建 ToolRecord schema 失败：{error}"),
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
                    format!("ToolRecord Store schema {other} 不受支持；当前只接受 schema {TOOL_RECORD_STORE_VERSION}。"),
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
        (
            "extensionGenerationRef",
            request.extension_generation_ref.as_str(),
        ),
        (
            "kernelCatalogSnapshotRef",
            request.kernel_catalog_snapshot_ref.as_str(),
        ),
        ("toolBindingRef", request.tool_binding_ref.as_str()),
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
    let object = input.as_object_mut().ok_or_else(|| {
        LocalAgentKernelError::input("$", "type", "工具输入必须是对象。", Some(json!("object")))
    })?;
    let value = object.remove("workspaceId").ok_or_else(|| {
        LocalAgentKernelError::input(
            "$.workspaceId",
            "required",
            "Workspace 工具必须显式携带 workspaceId。",
            Some(json!("string")),
        )
    })?;
    let workspace_id = value.as_str().ok_or_else(|| {
        LocalAgentKernelError::input(
            "$.workspaceId",
            "type",
            "workspaceId 必须是字符串。",
            Some(json!("string")),
        )
    })?;
    validate_id("workspaceId", workspace_id)?;
    Ok(workspace_id.to_string())
}

fn canonical_logical_targets(
    tool_name: &str,
    arguments: &Value,
) -> Result<Vec<String>, LocalAgentKernelError> {
    if tool_name == "bash" {
        return Ok(vec![".".to_string()]);
    }
    let field = match tool_name {
        "fs.read" | "fs.write" | "fs.edit" | "fs.delete" => Some("path"),
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
    if matches!(tool_name, "fs.write" | "fs.edit" | "fs.delete") && targets.len() != 1 {
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
        "revision",
        "decisionId",
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
        && object
            .get("revision")
            .and_then(Value::as_u64)
            .is_some_and(|value| value > 0)
        && object.get("decisionId").and_then(Value::as_str).is_some()
        && object
            .get("coveredOperations")
            .and_then(Value::as_array)
            .is_some()
}

fn authority_covers(authority: &Value, prepared: &PreparedEffect) -> bool {
    if prepared.operation == "bash" {
        let arguments = prepared
            .canonical_arguments
            .as_object()
            .expect("canonical process arguments");
        return authority
            .get("coveredOperations")
            .and_then(Value::as_array)
            .is_some_and(|operations| {
                operations.iter().any(|operation| {
                    let Some(object) = operation.as_object() else {
                        return false;
                    };
                    object.get("workspaceId").and_then(Value::as_str)
                        == prepared.workspace_id.as_deref()
                        && object.get("operation").and_then(Value::as_str) == Some("bash")
                        && object.get("workspaceMode").and_then(Value::as_str) == Some("write")
                        && object.get("executionScope").and_then(Value::as_str)
                            == arguments.get("executionScope").and_then(Value::as_str)
                })
            });
    }
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
                    && (object.get("operation").and_then(Value::as_str)
                        == Some(prepared.operation.as_str())
                        || matches!(prepared.operation.as_str(), "fs.write" | "fs.edit")
                            && matches!(
                                object.get("operation").and_then(Value::as_str),
                                Some("fs.write" | "fs.edit")
                            ))
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

fn workspace_mutation_mode(
    settings: &Value,
) -> Result<WorkspaceMutationMode, LocalAgentKernelError> {
    match settings
        .get("agent.permissions.workspaceMutation")
        .and_then(Value::as_str)
        .unwrap_or("plan")
    {
        "plan" => Ok(WorkspaceMutationMode::Plan),
        "allow" => Ok(WorkspaceMutationMode::Allow),
        _ => Err(LocalAgentKernelError::new(
            "agent_permission_setting_invalid",
            "agent.permissions.workspaceMutation 必须是 plan 或 allow。",
        )),
    }
}

fn permission_setting_id(scope: PreparedEffectScope) -> &'static str {
    match scope {
        PreparedEffectScope::Network => "user-setting:agent.permissions.networkRead",
        PreparedEffectScope::External => "user-setting:agent.permissions.external",
        PreparedEffectScope::LocalRead
        | PreparedEffectScope::WorkspaceRead
        | PreparedEffectScope::WorkspaceMutation
        | PreparedEffectScope::Process => {
            unreachable!("workspace effects are not setting-authorized")
        }
    }
}

fn effect_names(scope: PreparedEffectScope) -> Vec<&'static str> {
    match scope {
        PreparedEffectScope::LocalRead => vec!["localRead"],
        PreparedEffectScope::WorkspaceRead => vec!["workspaceRead"],
        PreparedEffectScope::WorkspaceMutation => vec!["workspaceMutation"],
        PreparedEffectScope::Process => vec!["process"],
        PreparedEffectScope::Network => vec!["network"],
        PreparedEffectScope::External => vec!["external"],
    }
}

fn process_effect_names(prepared: &PreparedEffect) -> Vec<&'static str> {
    if prepared.scope != PreparedEffectScope::Process {
        return effect_names(prepared.scope);
    }
    let mut effects = vec!["process"];
    if prepared.process_workspace_mode.as_deref() == Some("write") {
        effects.push("workspaceMutation");
    }
    if prepared.process_execution_scope.as_deref() == Some("host") {
        effects.push("external");
    }
    effects
}

fn effect_summary(tool_name: &str, targets: &[String], canonical_arguments: &Value) -> String {
    if tool_name == "bash" {
        let command = canonical_arguments
            .get("command")
            .and_then(Value::as_str)
            .expect("canonical bash arguments include command");
        return format!("执行 bash：{command}");
    }
    if targets.is_empty() {
        format!("执行 {tool_name}")
    } else {
        format!("执行 {tool_name}：{}", targets.join(", "))
    }
}

fn tool_record_from_execution_result(
    request: &LocalToolExecutionRequest,
    prepared: &PreparedEffect,
    authority: Value,
    started_at: &str,
    completed_at: &str,
    result: KernelToolExecutionResult,
) -> Result<Value, LocalAgentKernelError> {
    match result.outcome {
        KernelToolExecutionOutcome::Completed => {
            if result.error.is_some() {
                return Err(LocalAgentKernelError::new(
                    "tool_execution_result_invalid",
                    "Kernel completed result 不能携带 failure。",
                ));
            }
            tool_record(
                request,
                prepared,
                authority,
                started_at,
                completed_at,
                "completed",
                Some(result.output),
                None,
            )
        }
        KernelToolExecutionOutcome::Failed => {
            let error = result.error.ok_or_else(|| {
                LocalAgentKernelError::new(
                    "tool_execution_result_invalid",
                    "Kernel failed result 缺少 failure。",
                )
            })?;
            tool_record(
                request,
                prepared,
                authority,
                started_at,
                completed_at,
                "failed",
                Some(result.output),
                Some(json!({
                    "code": error.code,
                    "message": error.message,
                })),
            )
        }
    }
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
        "extensionGenerationRef": request.extension_generation_ref,
        "kernelCatalogSnapshotRef": request.kernel_catalog_snapshot_ref,
        "toolBindingRef": request.tool_binding_ref,
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
        (
            "extensionGenerationRef",
            request.extension_generation_ref.as_str(),
        ),
        (
            "kernelCatalogSnapshotRef",
            request.kernel_catalog_snapshot_ref.as_str(),
        ),
        ("toolBindingRef", request.tool_binding_ref.as_str()),
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
            "tool_record_store_version_mismatch",
            format!(
                "ToolRecord Store schema {version} 不是当前 schema {TOOL_RECORD_STORE_VERSION}。"
            ),
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
mod attempt_control_tests {
    use super::*;

    #[test]
    fn invalid_bound_tool_input_returns_a_rejection_before_resolution_or_tool_record_creation() {
        struct UnexpectedResolver;
        impl WorkspaceResolverPort for UnexpectedResolver {
            fn resolve(&self, _: &str) -> Result<String, LocalAgentKernelError> {
                panic!("input rejection must precede filesystem resolution")
            }
        }
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        let bindings = json!([{"workspaceId":"workspace:test", "displayName":"Fixture"}]);
        journal
            .create_session("session:reject", "Input rejection", &bindings, None)
            .unwrap();
        let kernel = LocalAgentKernel::open(
            Path::new(":memory:"),
            journal.clone(),
            Arc::new(UnexpectedResolver),
        )
        .unwrap();
        let generation = LocalAgentKernel::prepare_generation(
            "extension:test",
            "kernel-generation:test",
            KernelExecutorConfig::default(),
            Arc::new(deepcode_kernel_runtime::executors::EmptySecretProvider),
            McpRuntime::default(),
            LocalAgentPermissionPolicy::from_settings(&json!({})).unwrap(),
            false,
            crate::local_agent_product_tools::test_product_tools(),
        )
        .unwrap();
        let catalog = kernel
            .bind_run_catalog(
                PrepareToolCatalogRequest::new("session:reject", "run:reject", "extension:test"),
                generation,
            )
            .unwrap();
        let tools = catalog["tools"].as_array().unwrap();
        let binding =
            tools.iter().find(|tool| tool["name"] == "bash").unwrap()["toolBindingRef"].clone();
        let mut aliases: Vec<Value> = tools.iter().filter(|tool| tool["availability"] == "callable").map(|tool| json!({"canonicalName":tool["name"],"wireName":tool["name"].as_str().unwrap().replace('.', "_")})).collect();
        aliases.extend([
            json!({"canonicalName":"interaction.request","wireName":"interaction_request"}),
            json!({"canonicalName":"plan.publish","wireName":"plan_publish"}),
        ]);
        journal.append(&json!({
            "type":"run.started", "sessionId":"session:reject", "runId":"run:reject",
            "payload":{"inputMessageId":"message:reject", "workspaceBindings":bindings,
                "runtimeSnapshot":{
                    "runRuntimeSnapshotRef":"runtime:test", "extensionGenerationRef":"extension:test",
                    "kernelCatalogSnapshotRef":catalog["kernelCatalogSnapshotRef"],
                    "provider":{"providerRuntimeRef":"provider:test", "profileId":"profile:test", "contextWindowTokens":4096, "maxOutputTokens":512, "apiSurface":"chatCompletions", "hostedWebSearch":"none"},
                    "webSearch":{"owner":"unavailable"}, "instructions":[], "tools":tools,
                    "toolPromptContributions":[], "providerToolAliases":aliases,
                    "selectedPlugins":{"catalogRevision":"plugins:test","plugins":[]}
                }}
        })).unwrap();
        let request: LocalToolExecutionRequest = serde_json::from_value(json!({
            "schemaVersion":KERNEL_REQUEST_VERSION, "type":"tool.execute", "requestId":"request:reject", "sessionId":"session:reject", "runId":"run:reject",
            "extensionGenerationRef":"extension:test", "kernelCatalogSnapshotRef":catalog["kernelCatalogSnapshotRef"],
            "toolBindingRef":binding, "callId":"call:reject", "attemptId":"attempt:reject", "toolName":"bash",
            "workspaceBindings":["workspace:test"], "input":{"workspaceId":"workspace:test", "command":"pwd", "executionMode":"read"}
        })).unwrap();
        let reply = kernel.execute(request.clone()).unwrap();
        assert_eq!(reply["status"], "inputRejected");
        assert_eq!(reply["rejection"]["input"], request.input);
        assert_eq!(reply["rejection"]["callId"], request.call_id);
        assert!(reply.get("record").is_none());
        assert!(reply["rejection"].get("preparedEffect").is_none());
        assert!(reply["rejection"]["error"]["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| issue["path"] == "$.workspaceMode" && issue["rule"] == "required"));
        assert!(kernel.records.read(&request.call_id).unwrap().is_none());
        let mut wrong_binding = request;
        wrong_binding.tool_binding_ref = "binding:unknown".into();
        assert!(kernel
            .execute(wrong_binding)
            .unwrap_err()
            .input_issues
            .is_none());
        kernel
            .release_catalog(ReleaseToolCatalogRequest::new(
                "session:reject",
                "run:reject",
                catalog["kernelCatalogSnapshotRef"].as_str().unwrap(),
            ))
            .unwrap();
    }

    #[test]
    fn bash_effect_summary_preserves_the_complete_canonical_command() {
        let command = "docker image inspect cpp-dev:latest >/dev/null 2>&1 && {\n  docker build -t cpp-dev:latest .\n}";
        assert_eq!(
            effect_summary("bash", &[".".to_string()], &json!({ "command": command })),
            format!("执行 bash：{command}"),
        );
    }

    #[test]
    fn plan_scope_allows_execution_details_but_preserves_targets_and_boundaries() {
        let generation = LocalAgentKernel::prepare_generation(
            "extension:scope",
            "generation:scope",
            KernelExecutorConfig::default(),
            Arc::new(deepcode_kernel_runtime::executors::EmptySecretProvider),
            McpRuntime::default(),
            LocalAgentPermissionPolicy::from_settings(&json!({})).unwrap(),
            false,
            crate::local_agent_product_tools::test_product_tools(),
        )
        .unwrap()
        .generation;
        let view = generation.catalog.provider_view();
        let tool = view
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "bash")
            .unwrap();
        let binding = generation
            .catalog
            .binding(tool["toolBindingRef"].as_str().unwrap(), "bash")
            .unwrap();
        let mut effect = PreparedEffect {
            generation: Arc::clone(&generation),
            binding,
            scope: PreparedEffectScope::Process,
            workspace_id: Some("workspace:scope".into()),
            operation: "bash".into(),
            logical_targets: vec![".".into()],
            private_resolved_targets: vec![],
            canonical_invocation: json!({}),
            canonical_arguments: json!({"command":"make shell", "executionScope":"host", "workspaceMode":"write", "terminal":{"stdin":"./build.sh\nexit\n"}}),
            workspace_root: None,
            delete_target_kind: None,
            process_workspace_mode: Some("write".into()),
            process_execution_scope: Some("host".into()),
        };
        let authority = json!({"coveredOperations":[{"workspaceId":"workspace:scope", "operation":"bash", "workspaceMode":"write", "executionScope":"host", "command":"make build"}]});
        assert!(authority_covers(&authority, &effect));
        effect.canonical_arguments["executionScope"] = json!("workspace");
        assert!(!authority_covers(&authority, &effect));
        effect.canonical_arguments["executionScope"] = json!("host");
        effect.workspace_id = Some("workspace:other".into());
        assert!(!authority_covers(&authority, &effect));
        effect.workspace_id = Some("workspace:scope".into());
        effect.operation = "fs.write".into();
        effect.logical_targets = vec!["src/pool.hpp".into()];
        let file = json!({"coveredOperations":[{"workspaceId":"workspace:scope", "operation":"fs.edit", "target":"src/pool.hpp"}]});
        assert!(authority_covers(&file, &effect));
        effect.logical_targets = vec!["src/other.hpp".into()];
        assert!(!authority_covers(&file, &effect));
        effect.logical_targets = vec!["src/pool.hpp".into()];
        effect.operation = "fs.delete".into();
        effect.delete_target_kind = Some("file".into());
        assert!(!authority_covers(&file, &effect));
        let deletion = json!({"coveredOperations":[{"workspaceId":"workspace:scope", "operation":"fs.delete", "target":"src/pool.hpp", "targetKind":"file"}]});
        assert!(authority_covers(&deletion, &effect));
        effect.delete_target_kind = Some("directoryTree".into());
        assert!(!authority_covers(&deletion, &effect));
        generation.catalog.dispose().unwrap();
    }

    #[test]
    fn first_cancel_phase_is_frozen_for_the_execution_owner() {
        let control = AttemptControl::default();
        control.request_cancel(ActivePhase::Prepared);
        control.request_cancel(ActivePhase::Executing);

        assert!(control.is_cancelled());
        assert_eq!(control.claim_outcome(), Some(ActivePhase::Prepared));
        control.finish();
        assert!(control.wait_complete(Duration::ZERO));
    }

    #[test]
    fn cancellation_after_outcome_claim_does_not_rewrite_the_result() {
        let control = AttemptControl::default();
        assert_eq!(control.claim_outcome(), None);
        control.request_cancel(ActivePhase::Executing);

        assert!(!control.is_cancelled());
        control.finish();
        assert!(control.wait_complete(Duration::ZERO));
    }
}
