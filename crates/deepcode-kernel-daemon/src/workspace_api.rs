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
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::HostWorkspaceCurrent {
            request_id: rid("workspace-current"),
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
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
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::HostWorkspaceOpen {
            request_id: rid("workspace-open"),
            path: body.path,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn workspace_save_file(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::HostWorkspaceSave {
            request_id: rid("workspace-save"),
            file_name: body
                .get("fileName")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn workspace_patch_settings(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let settings = body.get("settings").cloned().unwrap_or_else(|| json!({}));
    let mut gui = state.gui.lock().expect("gui state lock");
    merge_object(&mut gui.user_settings, &settings);
    let write_result = atomic_write_json(&gui.paths.settings_path, &gui.user_settings);
    match write_result {
        Ok(()) => ApiResponse::ok(json!({ "settings": settings })),
        Err(error) => ApiResponse::error("write_settings_failed", error),
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
    if let Ok(current) = current_workspace(&state.runtime) {
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
    match dispatch_host_inspection(
        &state.runtime,
        HostInspectionQuery::Browse { path: query.path },
    ) {
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
    match dispatch_host_inspection(&state.runtime, query) {
        Ok(result) => ApiResponse::ok(json!(result)),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

fn dispatch_host_inspection(
    runtime: &SharedRuntime,
    query: HostInspectionQuery,
) -> Result<HostInspectionResult, KernelErrorEnvelope> {
    let mut runtime = runtime.lock().expect("kernel runtime lock");
    let events = runtime
        .dispatch(KernelCommand::HostResourceQuery {
            request_id: rid("host-inspection"),
            query,
        })
        .map_err(|error| KernelErrorEnvelope::from(&error))?;
    for event in events {
        if let KernelEvent::HostInspectionCompleted { result, .. } = event {
            return Ok(result);
        }
    }
    Err(KernelErrorEnvelope {
        code: "unexpected_event".to_string(),
        message: "expected typed host inspection result".to_string(),
        message_key: None,
        args: None,
    })
}

pub(crate) fn dispatch_workspace(
    runtime: &SharedRuntime,
    command: KernelCommand,
) -> Result<Value, KernelErrorEnvelope> {
    let result = dispatch_workspace_result(runtime, command)?;
    host_workspace_payload(result.output)
}

pub(crate) fn dispatch_workspace_result(
    runtime: &SharedRuntime,
    command: KernelCommand,
) -> Result<HostWorkspaceResult, KernelErrorEnvelope> {
    let mut runtime = runtime.lock().expect("kernel runtime lock");
    let events = runtime
        .dispatch(command)
        .map_err(|error| KernelErrorEnvelope::from(&error))?;
    for event in events {
        if let KernelEvent::HostWorkspaceCompleted { result, .. } = event {
            return Ok(result);
        }
    }
    Err(KernelErrorEnvelope {
        code: "unexpected_event".to_string(),
        message: "expected workspace host projection result".to_string(),
        message_key: None,
        args: None,
    })
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
    runtime: &SharedRuntime,
) -> Result<HostWorkspaceCurrent, KernelErrorEnvelope> {
    let result = dispatch_workspace_result(
        runtime,
        KernelCommand::HostWorkspaceCurrent {
            request_id: rid("workspace-current"),
        },
    )?;
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
