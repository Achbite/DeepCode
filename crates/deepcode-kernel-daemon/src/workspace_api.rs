use crate::prelude::*;
use crate::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenWorkspaceRequest {
    pub(crate) path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileQuery {
    pub(crate) path: Option<String>,
}

pub(crate) async fn workspace_current(State(state): State<AppState>) -> Json<ApiResponse> {
    let service = &state.host_services.workspace;
    match service.current() {
        Ok(result) => match host_workspace_payload(result.output) {
            Ok(output) => ApiResponse::ok(output),
            Err(error) => ApiResponse::error(error.code, error.message),
        },
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn workspace_default_path() -> Json<ApiResponse> {
    let path = std::env::var_os("DEEPCODE_DEFAULT_WORKSPACE")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .map(|path| path.to_string_lossy().to_string());
    ApiResponse::ok(json!({ "path": path }))
}

pub(crate) async fn workspace_open(
    State(state): State<AppState>,
    Json(body): Json<OpenWorkspaceRequest>,
) -> Json<ApiResponse> {
    let service = &state.host_services.workspace;
    match service.open(body.path) {
        Ok(result) => match host_workspace_payload(result.output) {
            Ok(output) => ApiResponse::ok(output),
            Err(error) => ApiResponse::error(error.code, error.message),
        },
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn workspace_save_file(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let service = &state.host_services.workspace;
    match service.save(
        body.get("fileName")
            .and_then(Value::as_str)
            .map(str::to_string),
    ) {
        Ok(result) => match host_workspace_payload(result.output) {
            Ok(output) => ApiResponse::ok(output),
            Err(error) => ApiResponse::error(error.code, error.message),
        },
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn workspace_patch_settings(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let settings = body.get("settings").cloned().unwrap_or_else(|| json!({}));
    match state.host_services.workspace.patch_settings(settings) {
        Ok(settings) => ApiResponse::ok(json!({ "settings": settings })),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn fs_initial_locations(State(state): State<AppState>) -> Json<ApiResponse> {
    let mut locations = Vec::new();
    if let Some(home) = home_dir() {
        locations.push(json!({
            "label": "Home",
            "absolutePath": home.to_string_lossy(),
            "kind": "home"
        }));
    }
    for drive in drive_locations() {
        locations.push(json!({
            "label": drive.display,
            "absolutePath": drive.path.to_string_lossy(),
            "kind": "drive"
        }));
    }
    if let Ok(current) = current_workspace(&state.host_services.workspace) {
        if let Some(path) = current
            .current
            .as_ref()
            .and_then(|workspace| workspace.folders.first())
            .map(|folder| folder.absolute_path.as_str())
        {
            locations.push(json!({
                "label": "Current Workspace",
                "absolutePath": path,
                "kind": "workspace"
            }));
        }
    }
    ApiResponse::ok(json!({
        "platform": platform_id(),
        "locations": locations
    }))
}

pub(crate) async fn fs_browse(
    State(state): State<AppState>,
    Query(query): Query<FileQuery>,
) -> Json<ApiResponse> {
    let service = &state.host_services.inspection;
    match service.query(HostInspectionQuery::Browse { path: query.path }) {
        Ok(HostInspectionResult {
            output: HostInspectionOutput::Browse(output),
            ..
        }) => ApiResponse::ok(json!(output)),
        Ok(_) => ApiResponse::error("unexpected_event", "expected browse host inspection result"),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn host_inspect(
    State(state): State<AppState>,
    Json(query): Json<HostInspectionQuery>,
) -> Json<ApiResponse> {
    let service = &state.host_services.inspection;
    match service.query(query) {
        Ok(result) => ApiResponse::ok(json!(result)),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

fn host_workspace_payload(output: HostWorkspaceOutput) -> Result<Value, KernelErrorEnvelope> {
    match output {
        HostWorkspaceOutput::BindingResolved(value) => encode_host_payload(value),
        HostWorkspaceOutput::Opened(value) => encode_host_payload(value),
        HostWorkspaceOutput::Current(value) => encode_host_payload(value),
        HostWorkspaceOutput::Saved(value) => encode_host_payload(value),
    }
}

fn encode_host_payload<T: serde::Serialize>(value: T) -> Result<Value, KernelErrorEnvelope> {
    serde_json::to_value(value).map_err(|error| KernelErrorEnvelope {
        code: "host_projection_encoding_failed".to_string(),
        message: error.to_string(),
        message_key: None,
        args: None,
    })
}

pub(crate) fn current_workspace(
    service: &HostWorkspaceService,
) -> Result<HostWorkspaceCurrent, KernelErrorEnvelope> {
    let result = service.current()?;
    match result.output {
        HostWorkspaceOutput::Current(current) => Ok(current),
        _ => Err(KernelErrorEnvelope {
            code: "unexpected_event".to_string(),
            message: "expected current workspace result".to_string(),
            message_key: None,
            args: None,
        }),
    }
}
