use crate::local_agent_kernel::{
    LocalAgentKernel, LocalAgentKernelError, LocalAgentPermissionPolicy, LocalToolExecutionRequest,
    WorkspaceResolverPort,
};
use crate::local_agent_store::{delete_session_archive, LocalAgentJournal, LocalAgentStoreError};
use crate::prelude::*;
use crate::*;
use axum::http::HeaderMap;

const SESSION_SERVICE_TOKEN_HEADER: &str = "x-deepcode-session-service-token";

#[derive(Clone)]
pub(crate) struct LocalAgentRuntime {
    token: Arc<str>,
    pub(crate) journal: LocalAgentJournal,
    pub(crate) kernel: LocalAgentKernel,
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
        executor_config: deepcode_kernel_runtime::executors::KernelExecutorConfig,
        secret_provider: Arc<dyn deepcode_kernel_runtime::executors::SecretProvider>,
    ) -> Result<Self, String> {
        let journal = LocalAgentJournal::open(session_store_path)
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        let mcp = crate::local_agent_mcp::McpRuntime::from_settings(settings)
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        let permissions = LocalAgentPermissionPolicy::from_settings(settings)
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        let kernel = LocalAgentKernel::open(
            tool_record_store_path,
            journal.clone(),
            workspace_resolver,
            executor_config,
            secret_provider,
            mcp,
            permissions,
        )
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
        Ok(Self {
            token: Arc::from(random_service_token()?),
            journal,
            kernel,
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
            .map_err(|error| format!("{}: {}", error.code, error.message))
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalProviderRequest {
    protocol_version: String,
    request_id: String,
    session_id: String,
    run_id: String,
    profile_id: Option<String>,
    response_constraint: String,
    workspace_bindings: Vec<LocalProviderWorkspaceBinding>,
    messages: Vec<LocalProviderMessage>,
    tools: Vec<LocalProviderTool>,
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
    tool_call_id: Option<String>,
    tool_calls: Option<Vec<LocalProviderToolCall>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalProviderToolCall {
    call_id: String,
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

pub(crate) async fn local_agent_tools(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.kernel.list_tools() {
        Ok(tools) => ApiResponse::ok(tools),
        Err(error) => kernel_error(error),
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
    let profile = {
        let gui = state.gui.lock().expect("gui state lock");
        resolve_llm_profile(&gui, body.profile_id.as_deref())
    };
    let profile = match profile {
        Ok(profile) => profile,
        Err(error) => {
            return local_provider_error(&request_id, "llm_profile_unavailable", &error);
        }
    };
    let request_envelope = json!({
        "messages": body.messages,
        "tools": body.tools,
    });
    local_agent_provider_stream_response(profile, request_envelope, request_id)
}

fn validate_local_provider_request(body: &LocalProviderRequest) -> Result<(), String> {
    let valid_text = |value: &str| {
        !value.is_empty()
            && value.trim() == value
            && value.len() <= 512
            && !value.chars().any(char::is_control)
    };
    for (name, value) in [
        ("requestId", body.request_id.as_str()),
        ("sessionId", body.session_id.as_str()),
        ("runId", body.run_id.as_str()),
    ] {
        if !valid_text(value) {
            return Err(format!("Provider 请求的 {name} 无效。"));
        }
    }
    if body
        .profile_id
        .as_deref()
        .is_some_and(|value| !valid_text(value))
    {
        return Err("Provider 请求的 profileId 无效。".to_string());
    }
    if !matches!(body.response_constraint.as_str(), "normal" | "answerOnly") {
        return Err("Provider 请求的 responseConstraint 无效。".to_string());
    }
    let mut workspace_ids = std::collections::HashSet::new();
    for binding in &body.workspace_bindings {
        if !valid_text(&binding.workspace_id)
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
                || message.tool_call_id.is_some()
                || message.tool_calls.is_some())
        {
            return Err("Provider 请求的 system/user 消息结构无效。".to_string());
        }
        if message.role == "tool" {
            if message.reasoning_content.is_some()
                || message.tool_calls.is_some()
                || message
                    .tool_call_id
                    .as_deref()
                    .is_none_or(|call_id| !valid_text(call_id))
            {
                return Err("Provider 请求的 tool 消息结构无效。".to_string());
            }
        } else if message.tool_call_id.is_some() {
            return Err("只有 tool 消息可以携带 toolCallId。".to_string());
        }
        if message.role != "assistant" && message.reasoning_content.is_some() {
            return Err("只有 assistant 消息可以携带 reasoningContent。".to_string());
        }
        if message
            .reasoning_content
            .as_deref()
            .is_some_and(|reasoning| reasoning.trim().is_empty())
        {
            return Err("Provider 请求的 reasoningContent 不能为空。".to_string());
        }
        if message.role != "assistant" && message.tool_calls.is_some() {
            return Err("只有 assistant 消息可以携带 toolCalls。".to_string());
        }
        for call in message.tool_calls.as_deref().unwrap_or_default() {
            if !valid_text(&call.call_id)
                || !valid_text(&call.name)
                || !call.input.is_object()
                || !call_ids.insert(call.call_id.as_str())
            {
                return Err("Provider 请求的 toolCalls 无效或重复。".to_string());
            }
        }
        if message.role == "assistant"
            && message.content.is_empty()
            && message.tool_calls.as_ref().is_none_or(Vec::is_empty)
        {
            return Err("Provider 请求的 assistant 消息没有正文或工具调用。".to_string());
        }
    }
    let mut tool_names = std::collections::HashSet::new();
    for tool in &body.tools {
        if !valid_text(&tool.name)
            || tool.description.trim().is_empty()
            || !tool.input_schema.is_object()
            || !tool_names.insert(tool.name.as_str())
        {
            return Err("Provider 请求的工具目录无效或重复。".to_string());
        }
    }
    Ok(())
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
