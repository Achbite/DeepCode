use crate::local_agent_kernel::{
    LocalAgentKernel, LocalAgentKernelError, LocalAgentPermissionPolicy, LocalToolExecutionRequest,
    PermissionMode, PrepareToolCatalogRequest, ReleaseToolCatalogRequest, WorkspaceResolverPort,
};
use crate::local_agent_provider_runtime::{ProviderRuntimeRegistry, ProviderRuntimeSnapshot};
use crate::local_agent_store::{
    delete_session_archive, LocalAgentJournal, LocalAgentStoreError, RunProviderRuntime,
};
use crate::prelude::*;
use crate::*;
use axum::http::HeaderMap;
use deepcode_kernel_runtime::executors::web_search_availability;
use deepcode_kernel_tools::ToolAvailability;

const SESSION_SERVICE_TOKEN_HEADER: &str = "x-deepcode-session-service-token";

#[derive(Clone)]
pub(crate) struct LocalAgentRuntime {
    token: Arc<str>,
    pub(crate) journal: LocalAgentJournal,
    pub(crate) kernel: LocalAgentKernel,
    provider_runtimes: ProviderRuntimeRegistry,
    runtime_transition: Arc<Mutex<()>>,
    prepared_runs: Arc<Mutex<HashMap<PreparedRunKey, PreparedRunRecord>>>,
    active_runtime_settings: Arc<Mutex<Value>>,
    session_store_path: Arc<std::path::PathBuf>,
    tool_record_store_path: Arc<std::path::PathBuf>,
}

impl std::fmt::Debug for LocalAgentRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("LocalAgentRuntime([REDACTED])")
    }
}

impl LocalAgentRuntime {
    pub(crate) fn open(
        session_store_path: &FsPath,
        tool_record_store_path: &FsPath,
        workspace_resolver: Arc<dyn WorkspaceResolverPort>,
        settings: &Value,
    ) -> Result<Self, String> {
        let journal = LocalAgentJournal::open(session_store_path)
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        let kernel =
            LocalAgentKernel::open(tool_record_store_path, journal.clone(), workspace_resolver)
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
        Ok(Self {
            token: Arc::from(random_service_token()?),
            journal,
            kernel,
            provider_runtimes: ProviderRuntimeRegistry::default(),
            runtime_transition: Arc::new(Mutex::new(())),
            prepared_runs: Arc::new(Mutex::new(HashMap::new())),
            active_runtime_settings: Arc::new(Mutex::new(settings.clone())),
            session_store_path: Arc::new(session_store_path.to_path_buf()),
            tool_record_store_path: Arc::new(tool_record_store_path.to_path_buf()),
        })
    }

    pub(crate) fn service_token(&self) -> &str {
        &self.token
    }

    pub(crate) fn shutdown_plugins(&self) -> Result<(), String> {
        self.kernel
            .shutdown_plugins()
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        self.provider_runtimes.clear()
    }

    pub(crate) fn runtime_transition(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.runtime_transition
            .lock()
            .map_err(|_| "Agent runtime transition 锁已损坏。".to_string())
    }

    pub(crate) fn active_runtime_settings(&self) -> Result<Value, String> {
        self.active_runtime_settings
            .lock()
            .map(|settings| settings.clone())
            .map_err(|_| "Agent active runtime settings 锁已损坏。".to_string())
    }

    pub(crate) fn apply_immediate_runtime_settings(&self, patch: &Value) -> Result<(), String> {
        let mut settings = self
            .active_runtime_settings
            .lock()
            .map_err(|_| "Agent active runtime settings 锁已损坏。".to_string())?;
        merge_object(&mut settings, patch);
        Ok(())
    }

    fn prepare_run_runtime(
        &self,
        gui: &Arc<Mutex<GuiState>>,
        session_service: SessionServiceProcess,
        request: PrepareRunRuntimeRequest,
    ) -> Result<Value, RunPreparationError> {
        for (field, value) in [
            ("sessionId", request.session_id.as_str()),
            ("runId", request.run_id.as_str()),
        ] {
            if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
                return Err(RunPreparationError::new(
                    "run_runtime_identity_invalid",
                    format!("{field} 不是有效标识。"),
                ));
            }
        }
        let _transition = self.runtime_transition().map_err(|message| {
            RunPreparationError::new("runtime_transition_lock_failed", message)
        })?;
        let key = PreparedRunKey {
            session_id: request.session_id.clone(),
            run_id: request.run_id.clone(),
        };
        let requested_plugin_identity = json!({
            "pluginCatalogRevision": request.plugin_catalog_revision.clone(),
            "pluginSelections": request.plugin_selections.clone(),
        });
        let mut prepared_runs = self.prepared_runs.lock().map_err(|_| {
            RunPreparationError::new(
                "prepared_run_registry_lock_failed",
                "Prepared run registry 锁已损坏。",
            )
        })?;
        if let Some(prepared) = prepared_runs.get(&key) {
            let effective_profile_id = prepared
                .response
                .pointer("/provider/profileId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    RunPreparationError::new(
                        "prepared_run_registry_corrupt",
                        "Prepared run 缺少有效的 Provider Profile identity。",
                    )
                })?;
            if request
                .profile_id
                .as_deref()
                .is_some_and(|requested| requested != effective_profile_id)
            {
                return Err(RunPreparationError::new(
                    "run_runtime_identity_conflict",
                    "当前 run 已使用不同的有效 Profile 完成运行时准备。",
                ));
            }
            if prepared
                .response
                .pointer("/provider/reasoningEffortOverride")
                .and_then(Value::as_str)
                != request.reasoning_effort_override.as_deref()
            {
                return Err(RunPreparationError::new(
                    "run_runtime_identity_conflict",
                    "当前 run 已使用不同推理强度完成运行时准备。",
                ));
            }
            if prepared.requested_plugin_identity != requested_plugin_identity {
                return Err(RunPreparationError::new(
                    "run_runtime_identity_conflict",
                    "当前 run 已使用不同的插件选择完成运行时准备。",
                ));
            }
            return Ok(prepared.response.clone());
        }
        let gui = gui.lock().map_err(|_| {
            RunPreparationError::new("gui_state_lock_failed", "GUI state 锁已损坏。")
        })?;
        let settings = &gui.user_settings;
        // Validate and freeze the requested Provider before starting any new
        // out-of-process plugin generation. A bad Profile must not replace the
        // currently usable tool generation or leave an unused MCP process set.
        let provider_binding = ProviderRuntimeRegistry::prepare(
            &gui,
            request.profile_id.as_deref(),
            request.reasoning_effort_override.as_deref(),
        )
        .map_err(|message| RunPreparationError::new("provider_runtime_prepare_failed", message))?;
        let provider_runtime = provider_binding.snapshot().clone();
        let plugin_selection = crate::local_agent_plugins::resolve_plugin_selection(
            settings,
            request.plugin_catalog_revision.as_deref(),
            &request.plugin_selections,
        )
        .map_err(|message| {
            RunPreparationError::new("extension_snapshot_prepare_failed", message)
        })?;
        let mut plugin_config =
            crate::local_agent_plugins::local_agent_plugin_config(settings, &plugin_selection)
                .map_err(|message| {
                    RunPreparationError::new("extension_snapshot_prepare_failed", message)
                })?;
        let mcp = crate::local_agent_mcp::McpRuntime::from_selected_settings(
            settings,
            plugin_selection.mcp_plugin_instances(),
        )
        .map_err(|error| RunPreparationError::new(error.code, error.message))?;
        let extension_generation_ref =
            crate::local_agent_plugins::extension_generation_ref(&plugin_config, &mcp).map_err(
                |message| RunPreparationError::new("extension_identity_prepare_failed", message),
            )?;
        let next_kernel_runtime_key = crate::local_agent_plugins::kernel_runtime_generation_key(
            &extension_generation_ref,
            settings,
        )
        .map_err(|message| {
            RunPreparationError::new("kernel_runtime_identity_prepare_failed", message)
        })?;
        let (mut executor_config, mut secrets) =
            crate::runtime_tool_configuration(&gui).map_err(|message| {
                RunPreparationError::new("kernel_runtime_config_prepare_failed", message)
            })?;
        crate::local_agent_search::bind_cloud_search(
            &mut executor_config,
            &mut secrets,
            &provider_binding.profile(),
            &provider_runtime.profile_id,
        );
        let permissions = LocalAgentPermissionPolicy::from_settings(settings)
            .map_err(RunPreparationError::from)?;
        let web_search = prepare_web_search_binding(
            &provider_runtime,
            permissions,
            web_search_availability(&executor_config) == ToolAvailability::Callable,
        );
        let enable_kernel_web_search =
            web_search.get("owner").and_then(Value::as_str) == Some("kernelAdapter");
        let prepared = LocalAgentKernel::prepare_generation(
            &extension_generation_ref,
            &next_kernel_runtime_key,
            executor_config,
            Arc::new(secrets),
            mcp,
            permissions,
            enable_kernel_web_search,
            Arc::new(crate::local_agent_product_tools::ProductTools::new(
                Arc::new(session_service),
            )),
        )
        .map_err(RunPreparationError::from)?;
        *self.active_runtime_settings.lock().map_err(|_| {
            RunPreparationError::new(
                "active_runtime_settings_lock_failed",
                "Agent active runtime settings 锁已损坏。",
            )
        })? = settings.clone();

        let catalog = self
            .kernel
            .bind_run_catalog(
                PrepareToolCatalogRequest::new(
                    &request.session_id,
                    &request.run_id,
                    &extension_generation_ref,
                ),
                prepared,
            )
            .map_err(RunPreparationError::from)?;
        let kernel_catalog_snapshot_ref = catalog["kernelCatalogSnapshotRef"]
            .as_str()
            .ok_or_else(|| {
                RunPreparationError::new(
                    "tool_catalog_reply_invalid",
                    "Kernel catalog reply 缺少 KernelCatalogSnapshotRef。",
                )
            })?
            .to_string();
        if let Err(message) =
            self.provider_runtimes
                .bind(&request.session_id, &request.run_id, provider_binding)
        {
            let _ = self.kernel.release_catalog(ReleaseToolCatalogRequest::new(
                &request.session_id,
                &request.run_id,
                &kernel_catalog_snapshot_ref,
            ));
            return Err(RunPreparationError::new(
                "provider_runtime_bind_failed",
                message,
            ));
        }
        plugin_config["extensionGenerationRef"] = json!(extension_generation_ref.clone());
        let selected_plugins = crate::local_agent_plugins::selected_plugin_snapshot(
            &plugin_selection,
            extension_generation_ref.as_str(),
        );
        let response = json!({
            "schemaVersion": "deepcode.local-agent",
            "type": "run.runtime.prepared",
            "sessionId": request.session_id,
            "runId": request.run_id,
            "provider": provider_runtime,
            "webSearch": web_search,
            "extensionGenerationRef": plugin_config["extensionGenerationRef"],
            "kernelCatalogSnapshotRef": catalog["kernelCatalogSnapshotRef"],
            "tools": catalog["tools"],
            "toolPromptProviders": crate::local_agent_tool_prompts::run_tool_prompt_providers(
                &plugin_selection,
            ),
            "pluginConfig": plugin_config,
            "selectedPlugins": selected_plugins,
        });
        prepared_runs.insert(
            key,
            PreparedRunRecord {
                kernel_catalog_snapshot_ref,
                requested_plugin_identity,
                response: response.clone(),
            },
        );
        Ok(response)
    }

    fn release_run_runtime(
        &self,
        request: ReleaseToolCatalogRequest,
    ) -> Result<Value, RunPreparationError> {
        let _transition = self.runtime_transition().map_err(|message| {
            RunPreparationError::new("runtime_transition_lock_failed", message)
        })?;
        let key = PreparedRunKey {
            session_id: request.session_id().to_string(),
            run_id: request.run_id().to_string(),
        };
        let mut prepared_runs = self.prepared_runs.lock().map_err(|_| {
            RunPreparationError::new(
                "prepared_run_registry_lock_failed",
                "Prepared run registry 锁已损坏。",
            )
        })?;
        if let Some(prepared) = prepared_runs.get(&key) {
            if prepared.kernel_catalog_snapshot_ref != request.kernel_catalog_snapshot_ref() {
                return Err(RunPreparationError::new(
                    "tool_catalog_release_identity_conflict",
                    "KernelCatalogSnapshotRef 与当前 prepared run 不一致。",
                ));
            }
        }
        let response = self
            .kernel
            .release_catalog(request)
            .map_err(RunPreparationError::from)?;
        self.provider_runtimes
            .release(&key.session_id, &key.run_id)
            .map_err(|message| {
                RunPreparationError::new("provider_runtime_release_failed", message)
            })?;
        prepared_runs.remove(&key);
        Ok(response)
    }

    fn delete_session_archive(&self, session_id: &str) -> Result<usize, LocalAgentStoreError> {
        delete_session_archive(
            self.session_store_path.as_ref(),
            self.tool_record_store_path.as_ref(),
            session_id,
        )
    }

    fn authorize(&self, headers: &HeaderMap) -> bool {
        headers
            .get(SESSION_SERVICE_TOKEN_HEADER)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value == self.token.as_ref())
    }
}

fn prepare_web_search_binding(
    provider: &ProviderRuntimeSnapshot,
    permissions: LocalAgentPermissionPolicy,
    kernel_adapter_callable: bool,
) -> Value {
    if permissions.network_mode() == PermissionMode::Deny {
        return json!({ "owner": "unavailable" });
    }
    if permissions.network_mode() == PermissionMode::Allow
        && provider.api_surface == "responses"
        && provider.hosted_web_search == "web_search"
    {
        return json!({
            "owner": "providerHosted",
            "providerToolType": "web_search",
        });
    }
    if kernel_adapter_callable {
        json!({ "owner": "kernelAdapter", "toolName": "web.search" })
    } else {
        json!({ "owner": "unavailable" })
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct PreparedRunKey {
    session_id: String,
    run_id: String,
}

#[derive(Clone, Debug)]
struct PreparedRunRecord {
    kernel_catalog_snapshot_ref: String,
    requested_plugin_identity: Value,
    response: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateLocalSessionRequest {
    session_id: String,
    display_title: String,
    workspace_bindings: Value,
    profile_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AppendLocalEventsRequest {
    events: Vec<Value>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct LocalSessionEventsQuery {
    after: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CancelLocalToolRequest {
    call_id: String,
    attempt_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareRunRuntimeRequest {
    session_id: String,
    run_id: String,
    profile_id: Option<String>,
    reasoning_effort_override: Option<String>,
    plugin_catalog_revision: Option<String>,
    #[serde(default)]
    plugin_selections: Vec<crate::local_agent_plugins::PluginSelectionInput>,
}

#[derive(Debug)]
struct RunPreparationError {
    code: &'static str,
    message: String,
}

impl RunPreparationError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<LocalAgentKernelError> for RunPreparationError {
    fn from(error: LocalAgentKernelError) -> Self {
        Self::new(error.code, error.message)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalProviderRequest {
    protocol_version: String,
    request_id: String,
    session_id: String,
    run_id: String,
    provider_runtime_ref: String,
    profile_id: String,
    purpose: String,
    response_constraint: String,
    max_output_tokens: u32,
    workspace_bindings: Vec<LocalProviderWorkspaceBinding>,
    messages: Vec<LocalProviderMessage>,
    tools: Vec<LocalProviderTool>,
    hosted_tools: Vec<LocalProviderHostedTool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalProviderWorkspaceBinding {
    workspace_id: String,
    display_name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalProviderMessage {
    role: String,
    content: String,
    reasoning_content: Option<String>,
    reasoning_signature: Option<String>,
    tool_call_id: Option<String>,
    provider_call_id: Option<String>,
    tool_calls: Option<Vec<LocalProviderToolCall>>,
    provider_items: Option<Vec<Value>>,
    provider_output_blocks: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalProviderToolCall {
    call_id: String,
    provider_call_id: String,
    name: String,
    input: Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalProviderTool {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalProviderHostedTool {
    #[serde(rename = "type")]
    tool_type: String,
    provider_tool_type: String,
}

pub(crate) async fn local_agent_session_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateLocalSessionRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.journal.create_session(
        &body.session_id,
        &body.display_title,
        &body.workspace_bindings,
        body.profile_id.as_deref(),
    ) {
        Ok(event) => ApiResponse::ok(event),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_session_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.delete_session_archive(&session_id) {
        Ok(tool_record_count) => ApiResponse::ok(json!({
            "deleted": true,
            "toolRecordCount": tool_record_count,
        })),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_event_append(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.journal.append(&body) {
        Ok(event) => ApiResponse::ok(event),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_events_append_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AppendLocalEventsRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.journal.append_batch(&body.events) {
        Ok(events) => ApiResponse::ok(Value::Array(events)),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_events_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<LocalSessionEventsQuery>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state
        .local_agent
        .journal
        .read_events(&session_id, query.after.unwrap_or(0))
    {
        Ok(events) => ApiResponse::ok(Value::Array(events)),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_command_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((session_id, command_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state
        .local_agent
        .journal
        .read_command(&session_id, &command_id)
    {
        Ok(command) => ApiResponse::ok(command.unwrap_or(Value::Null)),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_command_commit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.journal.commit_command(&body) {
        Ok(reply) => ApiResponse::ok(reply),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_run_runtime_prepare(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PrepareRunRuntimeRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state
        .local_agent
        .prepare_run_runtime(&state.gui, state.session_service.clone(), body)
    {
        Ok(runtime) => ApiResponse::ok(runtime),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn local_agent_run_runtime_release(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ReleaseToolCatalogRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.release_run_runtime(body) {
        Ok(release) => ApiResponse::ok(release),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn local_agent_tool_execute(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LocalToolExecutionRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    let kernel = state.local_agent.kernel.clone();
    match tokio::task::spawn_blocking(move || kernel.execute(body)).await {
        Ok(Ok(reply)) => ApiResponse::ok(reply),
        Ok(Err(error)) => kernel_error(error),
        Err(error) => ApiResponse::error(
            "tool_runtime_join_failed",
            format!("Kernel 工具任务结束异常：{error}"),
        ),
    }
}

pub(crate) async fn local_agent_tool_cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CancelLocalToolRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state
        .local_agent
        .kernel
        .cancel(&body.call_id, &body.attempt_id)
    {
        Ok(reply) => ApiResponse::ok(reply),
        Err(error) => kernel_error(error),
    }
}

pub(crate) async fn local_agent_tool_record(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(call_id): Path<String>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.kernel.read_record(&call_id) {
        Ok(record) => ApiResponse::ok(record.unwrap_or(Value::Null)),
        Err(error) => kernel_error(error),
    }
}

pub(crate) async fn local_agent_provider_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !state.local_agent.authorize(&headers) {
        return local_provider_error(
            body.get("requestId")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            "session_service_unauthorized",
            "Session Service transport token 无效。",
        );
    }
    let rejected_request_id = body
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let body: LocalProviderRequest = match serde_json::from_value(body) {
        Ok(body) => body,
        Err(_) => {
            return local_provider_error(
                &rejected_request_id,
                "provider_request_shape_invalid",
                "Provider 请求字段与当前闭合协议不一致。",
            )
        }
    };
    if body.protocol_version != "deepcode.local-agent" {
        return local_provider_error(
            &body.request_id,
            "provider_request_version_invalid",
            "Provider 请求版本无效。",
        );
    }
    if let Err(message) = validate_local_provider_request(&body) {
        return local_provider_error(&body.request_id, "provider_request_shape_invalid", &message);
    }
    let request_id = body.request_id.clone();
    match state
        .local_agent
        .journal
        .run_is_settled(&body.session_id, &body.run_id)
    {
        Ok(true) => {
            return local_provider_error(
                &request_id,
                "provider_run_settled",
                "Provider 请求引用的运行已经结束。",
            );
        }
        Ok(false) => {}
        Err(error) => {
            return local_provider_error(&request_id, error.code, &error.message);
        }
    }
    let frozen_provider_runtime = match state
        .local_agent
        .journal
        .run_provider_runtime(&body.session_id, &body.run_id)
    {
        Ok(runtime) => runtime,
        Err(error) => {
            return local_provider_error(&request_id, error.code, &error.message);
        }
    };
    if body.provider_runtime_ref != frozen_provider_runtime.provider_runtime_ref
        || body.profile_id != frozen_provider_runtime.profile_id
        || body.max_output_tokens != frozen_provider_runtime.max_output_tokens
    {
        return local_provider_error(
            &request_id,
            "provider_runtime_snapshot_mismatch",
            "Provider 请求与 run.started 固定的 runtime snapshot 不一致。",
        );
    }
    if frozen_provider_runtime.api_surface != "responses"
        && body.messages.iter().any(|message| {
            message
                .provider_items
                .as_ref()
                .is_some_and(|items| !items.is_empty())
                || message
                    .provider_output_blocks
                    .as_ref()
                    .is_some_and(|blocks| !blocks.is_empty())
        })
    {
        return local_provider_error(
            &request_id,
            "provider_item_api_surface_mismatch",
            "Provider 原生响应项只能回放到 Responses API surface。",
        );
    }
    if let Err((code, message)) = validate_provider_search_binding(
        &frozen_provider_runtime,
        &body.purpose,
        &body.hosted_tools,
    ) {
        return local_provider_error(&request_id, code, message);
    }
    let frozen_workspace_ids = match state
        .local_agent
        .journal
        .run_workspace_binding_ids(&body.session_id, &body.run_id)
    {
        Ok(bindings) => bindings,
        Err(error) => {
            return local_provider_error(&request_id, error.code, &error.message);
        }
    };
    let request_workspace_ids = body
        .workspace_bindings
        .iter()
        .map(|binding| binding.workspace_id.clone())
        .collect::<Vec<_>>();
    if request_workspace_ids != frozen_workspace_ids {
        return local_provider_error(
            &request_id,
            "provider_workspace_snapshot_mismatch",
            "Provider 请求的目录集合与 run.started 冻结快照不一致。",
        );
    }
    let runtime = {
        let gui = match state.gui.lock() {
            Ok(gui) => gui,
            Err(_) => {
                return local_provider_error(
                    &request_id,
                    "gui_state_lock_failed",
                    "GUI state 锁已损坏。",
                )
            }
        };
        state.local_agent.provider_runtimes.resolve(
            &gui,
            &body.session_id,
            &body.run_id,
            &body.provider_runtime_ref,
            &body.profile_id,
            frozen_provider_runtime.reasoning_effort_override.as_deref(),
        )
    };
    let runtime = match runtime {
        Ok(runtime) => runtime,
        Err(error) => {
            return local_provider_error(&request_id, "provider_runtime_unavailable", &error);
        }
    };
    if runtime.snapshot().max_output_tokens != body.max_output_tokens {
        return local_provider_error(
            &request_id,
            "provider_output_budget_mismatch",
            "Provider 请求的输出预算与 run.started 固定的 runtime 不一致。",
        );
    }
    let request_envelope = json!({
        "messages": body.messages,
        "tools": body.tools,
        "hostedTools": body.hosted_tools,
        "requireToolCall": body.response_constraint == "toolRequired",
    });
    let archive_directory = state
        .local_agent
        .kernel
        .session_output_directory(&body.session_id)
        .join(format!(
            "provider-{}",
            deepcode_kernel_tools::hash_bytes(request_id.as_bytes())
        ));
    let archive_identity = json!({
        "sessionId": body.session_id,
        "runId": body.run_id,
        "requestId": request_id,
        "purpose": body.purpose,
        "profileId": body.profile_id,
    });
    local_agent_provider_stream_response(
        runtime.profile(),
        request_envelope,
        request_id,
        archive_directory,
        archive_identity,
    )
}

fn valid_provider_text(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= 512
        && !value.chars().any(char::is_control)
}

fn valid_provider_tool_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validate_local_provider_request(body: &LocalProviderRequest) -> Result<(), String> {
    for (name, value) in [
        ("requestId", body.request_id.as_str()),
        ("sessionId", body.session_id.as_str()),
        ("runId", body.run_id.as_str()),
    ] {
        if !valid_provider_text(value) {
            return Err(format!("Provider 请求的 {name} 无效。"));
        }
    }
    if !valid_provider_text(&body.profile_id) || !valid_provider_text(&body.provider_runtime_ref) {
        return Err("Provider 请求的 profileId 无效。".to_string());
    }
    if !matches!(
        body.response_constraint.as_str(),
        "normal" | "toolRequired" | "answerOnly"
    ) {
        return Err("Provider 请求的 responseConstraint 无效。".to_string());
    }
    match body.purpose.as_str() {
        "agent" => {
            if !matches!(body.response_constraint.as_str(), "normal" | "toolRequired")
                || body.max_output_tokens == 0
            {
                return Err("普通 Agent 请求必须使用固定的完整输出预算。".to_string());
            }
            if body.response_constraint == "toolRequired" && body.tools.is_empty() {
                return Err("execution turn 必须提供至少一个可调用工具。".to_string());
            }
        }
        "contextCompaction" => {
            if body.response_constraint != "answerOnly"
                || !body.tools.is_empty()
                || !body.hosted_tools.is_empty()
                || body.max_output_tokens == 0
            {
                return Err(
                    "上下文压缩请求必须使用 answerOnly、空工具目录和固定的完整输出预算。"
                        .to_string(),
                );
            }
        }
        _ => return Err("Provider 请求的 purpose 无效。".to_string()),
    }
    let mut workspace_ids = std::collections::HashSet::new();
    for binding in &body.workspace_bindings {
        if !valid_provider_text(&binding.workspace_id)
            || binding.display_name.trim().is_empty()
            || binding.display_name.len() > 160
            || !workspace_ids.insert(binding.workspace_id.as_str())
        {
            return Err("Provider 请求的 workspaceBindings 无效或重复。".to_string());
        }
    }
    let mut call_ids = std::collections::HashSet::new();
    for message in &body.messages {
        if !matches!(
            message.role.as_str(),
            "system" | "user" | "assistant" | "tool"
        ) {
            return Err("Provider 请求包含无效消息角色。".to_string());
        }
        if matches!(message.role.as_str(), "system" | "user")
            && (message.content.trim().is_empty()
                || message.reasoning_content.is_some()
                || message.reasoning_signature.is_some()
                || message.tool_call_id.is_some()
                || message.provider_call_id.is_some()
                || message.tool_calls.is_some()
                || message.provider_items.is_some()
                || message.provider_output_blocks.is_some())
        {
            return Err("Provider 请求的 system/user 消息结构无效。".to_string());
        }
        if message.role == "tool" {
            if message.reasoning_content.is_some()
                || message.reasoning_signature.is_some()
                || message.tool_calls.is_some()
                || message.provider_items.is_some()
                || message.provider_output_blocks.is_some()
                || message
                    .tool_call_id
                    .as_deref()
                    .is_none_or(|call_id| !valid_provider_text(call_id))
                || message
                    .provider_call_id
                    .as_deref()
                    .is_none_or(|call_id| !valid_provider_text(call_id))
            {
                return Err("Provider 请求的 tool 消息结构无效。".to_string());
            }
        } else if message.tool_call_id.is_some() || message.provider_call_id.is_some() {
            return Err("只有 tool 消息可以携带 toolCallId 与 providerCallId。".to_string());
        }
        if message.role != "assistant" && message.reasoning_content.is_some() {
            return Err("只有 assistant 消息可以携带 reasoningContent。".to_string());
        }
        if message.role != "assistant" && message.reasoning_signature.is_some() {
            return Err("只有 assistant 消息可以携带 reasoningSignature。".to_string());
        }
        if message
            .reasoning_content
            .as_deref()
            .is_some_and(|reasoning| reasoning.trim().is_empty())
        {
            return Err("Provider 请求的 reasoningContent 不能为空。".to_string());
        }
        if message
            .reasoning_signature
            .as_deref()
            .is_some_and(|signature| signature.trim().is_empty())
        {
            return Err("Provider 请求的 reasoningSignature 不能为空。".to_string());
        }
        if message.reasoning_signature.is_some() && message.reasoning_content.is_none() {
            return Err("reasoningSignature 必须与 reasoningContent 一起提供。".to_string());
        }
        if message.role != "assistant" && message.tool_calls.is_some() {
            return Err("只有 assistant 消息可以携带 toolCalls。".to_string());
        }
        if message.role != "assistant" && message.provider_items.is_some() {
            return Err("只有 assistant 消息可以携带 providerItems。".to_string());
        }
        if message.role != "assistant" && message.provider_output_blocks.is_some() {
            return Err("只有 assistant 消息可以携带 providerOutputBlocks。".to_string());
        }
        let provider_items = message.provider_items.as_deref().unwrap_or_default();
        let mut provider_item_ids = std::collections::HashSet::new();
        for item in provider_items {
            let item_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
            if !crate::llm_transport::valid_responses_hosted_search_item(item)
                || !valid_provider_text(item_id)
                || !provider_item_ids.insert(item_id)
            {
                return Err("Provider 请求的 providerItems 无效或重复。".to_string());
            }
        }
        for call in message.tool_calls.as_deref().unwrap_or_default() {
            if !valid_provider_text(&call.call_id)
                || !valid_provider_text(&call.provider_call_id)
                || !valid_provider_tool_name(&call.name)
                || !call.input.is_object()
                || !call_ids.insert(call.call_id.as_str())
            {
                return Err("Provider 请求的 toolCalls 无效或重复。".to_string());
            }
        }
        if let Some(blocks) = message.provider_output_blocks.as_deref() {
            validate_provider_output_blocks(blocks)?;
            if !message.content.is_empty()
                || message.reasoning_content.is_some()
                || message.reasoning_signature.is_some()
                || message.tool_calls.is_some()
                || message.provider_items.is_some()
            {
                return Err("providerOutputBlocks 不能与聚合 assistant 字段混用。".to_string());
            }
        }
        if message.role == "assistant"
            && message.content.is_empty()
            && message.reasoning_content.is_none()
            && message.tool_calls.as_ref().is_none_or(Vec::is_empty)
            && provider_items.is_empty()
            && message
                .provider_output_blocks
                .as_ref()
                .is_none_or(Vec::is_empty)
        {
            return Err("Provider 请求的 assistant 消息没有正文或工具调用。".to_string());
        }
    }
    let mut tool_names = std::collections::HashSet::new();
    for tool in &body.tools {
        if !valid_provider_tool_name(&tool.name)
            || tool.description.trim().is_empty()
            || !tool.input_schema.is_object()
            || !tool_names.insert(tool.name.as_str())
        {
            return Err("Provider 请求的工具目录无效或重复。".to_string());
        }
    }
    if body.hosted_tools.len() > 1
        || body
            .hosted_tools
            .iter()
            .any(|tool| tool.tool_type != "webSearch" || tool.provider_tool_type != "web_search")
    {
        return Err("Provider 请求的 hostedTools 无效。".to_string());
    }
    Ok(())
}

fn validate_provider_output_blocks(blocks: &[Value]) -> Result<(), String> {
    if blocks.is_empty() {
        return Err("providerOutputBlocks 不能为空。".to_string());
    }
    let mut previous_output_index = None;
    let mut reference_ids = std::collections::HashSet::new();
    for block in blocks {
        let output_index = block
            .get("outputIndex")
            .and_then(Value::as_u64)
            .ok_or_else(|| "providerOutputBlock 缺少 outputIndex。".to_string())?;
        if previous_output_index.is_some_and(|previous| output_index <= previous) {
            return Err("providerOutputBlocks 没有按 outputIndex 递增。".to_string());
        }
        previous_output_index = Some(output_index);
        let kind = block
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| "providerOutputBlock 缺少 kind。".to_string())?;
        let item = block
            .get("item")
            .filter(|item| item.is_object())
            .ok_or_else(|| "providerOutputBlock 缺少原生 item。".to_string())?;
        let valid = match kind {
            "reasoning" => item.get("type").and_then(Value::as_str) == Some("reasoning"),
            "narrative" => {
                item.get("type").and_then(Value::as_str) == Some("message")
                    && block
                        .get("narrativeId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| valid_provider_text(id) && reference_ids.insert(id))
            }
            "finalMessage" => {
                item.get("type").and_then(Value::as_str) == Some("message")
                    && block
                        .get("messageId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| valid_provider_text(id) && reference_ids.insert(id))
            }
            "toolCall" | "toolCallRejected" => {
                let provider_call_id = block.get("providerCallId").and_then(Value::as_str);
                item.get("type").and_then(Value::as_str) == Some("function_call")
                    && block
                        .get("callId")
                        .and_then(Value::as_str)
                        .is_some_and(valid_provider_text)
                    && block
                        .get("toolName")
                        .and_then(Value::as_str)
                        .is_some_and(valid_provider_text)
                    && provider_call_id.is_some_and(valid_provider_text)
                    && item.get("call_id").and_then(Value::as_str) == provider_call_id
            }
            "providerHosted" => {
                let provider_call_id = block.get("providerCallId").and_then(Value::as_str);
                block.get("providerToolType").and_then(Value::as_str) == Some("web_search")
                    && provider_call_id.is_some_and(valid_provider_text)
                    && item.get("id").and_then(Value::as_str) == provider_call_id
                    && crate::llm_transport::valid_responses_hosted_search_item(item)
            }
            _ => false,
        };
        if !valid {
            return Err("providerOutputBlock 合同无效。".to_string());
        }
    }
    Ok(())
}

fn validate_provider_search_binding(
    runtime: &RunProviderRuntime,
    purpose: &str,
    hosted_tools: &[LocalProviderHostedTool],
) -> Result<(), (&'static str, &'static str)> {
    let hosted_search_requested = hosted_tools.len() == 1
        && hosted_tools[0].tool_type == "webSearch"
        && hosted_tools[0].provider_tool_type == "web_search";
    match runtime.web_search_owner.as_str() {
        "providerHosted" => {
            let request_matches_purpose = match purpose {
                "agent" => hosted_search_requested,
                "contextCompaction" => hosted_tools.is_empty(),
                _ => false,
            };
            if runtime.api_surface != "responses"
                || runtime.hosted_web_search != "web_search"
                || !request_matches_purpose
            {
                return Err((
                    "provider_hosted_search_binding_mismatch",
                    "Provider 请求与 run.started 固定的 hosted search binding 不一致。",
                ));
            }
            Ok(())
        }
        "kernelAdapter" | "unavailable" if hosted_tools.is_empty() => Ok(()),
        "kernelAdapter" | "unavailable" => Err((
            "provider_hosted_search_binding_mismatch",
            "当前 run 的搜索执行 owner 不是 Provider。",
        )),
        _ => Err((
            "provider_hosted_search_binding_invalid",
            "run.started 的搜索执行 owner 无效。",
        )),
    }
}

fn require_session_service(state: &AppState, headers: &HeaderMap) -> Result<(), Json<ApiResponse>> {
    state
        .local_agent
        .authorize(headers)
        .then_some(())
        .ok_or_else(|| {
            ApiResponse::error(
                "session_service_unauthorized",
                "Session Service transport token 无效。",
            )
        })
}

fn store_error(error: LocalAgentStoreError) -> Json<ApiResponse> {
    ApiResponse::error(error.code, error.message)
}

fn kernel_error(error: LocalAgentKernelError) -> Json<ApiResponse> {
    ApiResponse::error(error.code, error.message)
}

fn local_provider_error(request_id: &str, code: &str, message: &str) -> Response {
    let event = json!({
        "schemaVersion": "deepcode.provider-event",
        "requestId": request_id,
        "type": "failed",
        "data": { "code": code, "message": message },
    });
    (
        [
            (header::CONTENT_TYPE, "text/event-stream; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        format!("event: provider_event\ndata: {event}\n\n"),
    )
        .into_response()
}

fn random_service_token() -> Result<String, String> {
    let mut entropy = [0u8; 32];
    getrandom::fill(&mut entropy).map_err(|error| error.to_string())?;
    let mut token = String::from("session-service-v2:");
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut token, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn permission_policy(network: &str) -> LocalAgentPermissionPolicy {
        LocalAgentPermissionPolicy::from_settings(&json!({
            "agent.permissions.networkRead": network,
        }))
        .expect("valid permission policy")
    }

    fn provider_runtime(
        api_surface: &'static str,
        hosted_web_search: &'static str,
    ) -> ProviderRuntimeSnapshot {
        ProviderRuntimeSnapshot {
            reasoning_effort: None,
            reasoning_effort_override: None,
            thinking: None,
            provider_runtime_ref: "provider-runtime:test".to_string(),
            profile_id: "profile:test".to_string(),
            context_window_tokens: 4_096,
            max_output_tokens: 512,
            api_surface,
            hosted_web_search,
        }
    }

    #[test]
    fn search_owner_is_frozen_from_provider_permission_and_kernel_adapter() {
        let responses = provider_runtime("responses", "web_search");
        let chat = provider_runtime("chatCompletions", "none");

        assert_eq!(
            prepare_web_search_binding(&responses, permission_policy("allow"), true),
            json!({ "owner": "providerHosted", "providerToolType": "web_search" })
        );
        assert_eq!(
            prepare_web_search_binding(&responses, permission_policy("ask"), true),
            json!({ "owner": "kernelAdapter", "toolName": "web.search" })
        );
        assert_eq!(
            prepare_web_search_binding(&chat, permission_policy("allow"), true),
            json!({ "owner": "kernelAdapter", "toolName": "web.search" })
        );
        assert_eq!(
            prepare_web_search_binding(&responses, permission_policy("ask"), false),
            json!({ "owner": "unavailable" })
        );
        assert_eq!(
            prepare_web_search_binding(&responses, permission_policy("deny"), true),
            json!({ "owner": "unavailable" })
        );
    }

    #[test]
    fn provider_hosted_search_is_agent_only_and_compaction_remains_tool_free() {
        let runtime = RunProviderRuntime {
            reasoning_effort_override: None,
            provider_runtime_ref: "provider-runtime:test".to_string(),
            profile_id: "profile:test".to_string(),
            context_window_tokens: 4_096,
            max_output_tokens: 512,
            api_surface: "responses".to_string(),
            hosted_web_search: "web_search".to_string(),
            web_search_owner: "providerHosted".to_string(),
        };
        let hosted_tool = LocalProviderHostedTool {
            tool_type: "webSearch".to_string(),
            provider_tool_type: "web_search".to_string(),
        };

        assert!(validate_provider_search_binding(
            &runtime,
            "agent",
            std::slice::from_ref(&hosted_tool),
        )
        .is_ok());
        assert!(validate_provider_search_binding(&runtime, "contextCompaction", &[]).is_ok());
        assert!(validate_provider_search_binding(&runtime, "agent", &[]).is_err());
        assert!(
            validate_provider_search_binding(&runtime, "contextCompaction", &[hosted_tool],)
                .is_err()
        );
    }
}
