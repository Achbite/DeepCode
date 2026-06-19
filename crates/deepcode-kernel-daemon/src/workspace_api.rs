#![allow(dead_code)]
#![allow(unused_imports)]

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
    pub(crate) folder_id: Option<String>,
    pub(crate) path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileWriteRequest {
    pub(crate) folder_id: Option<String>,
    pub(crate) path: String,
    pub(crate) content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileCreateRequest {
    pub(crate) folder_id: Option<String>,
    pub(crate) path: String,
    pub(crate) content: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderCreateRequest {
    pub(crate) folder_id: Option<String>,
    pub(crate) path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileDeleteRequest {
    pub(crate) folder_id: Option<String>,
    pub(crate) path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileRenameRequest {
    pub(crate) folder_id: Option<String>,
    pub(crate) old_path: String,
    pub(crate) new_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchRequest {
    pub(crate) folder_id: Option<String>,
    pub(crate) query: String,
    pub(crate) include: Option<Vec<String>>,
    pub(crate) context_lines: Option<u32>,
    pub(crate) max_results: Option<u32>,
    pub(crate) is_regex: Option<bool>,
}

pub(crate) async fn workspace_current(State(state): State<AppState>) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceCurrent {
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
        KernelCommand::WorkspaceOpen {
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
    let Ok(current) = current_workspace_json(&state.runtime) else {
        return ApiResponse::error("no_workspace", "current workspace is missing");
    };
    let Some(workspace) = current.get("current").filter(|value| !value.is_null()) else {
        return ApiResponse::error("no_workspace", "current workspace is missing");
    };
    let default_file_name = workspace
        .get("name")
        .and_then(Value::as_str)
        .map(workspace_file_name_from_label)
        .unwrap_or_else(|| "DeepCode.code-workspace".to_string());
    let file_name = match normalize_workspace_file_name(
        body.get("fileName")
            .and_then(Value::as_str)
            .unwrap_or(&default_file_name),
    ) {
        Ok(file_name) => file_name,
        Err(message) => return ApiResponse::error("invalid_workspace_file_name", message),
    };
    let folder_path = workspace
        .get("folders")
        .and_then(Value::as_array)
        .and_then(|folders| folders.first())
        .and_then(|folder| folder.get("absolutePath"))
        .or_else(|| {
            workspace
                .get("folders")
                .and_then(Value::as_array)
                .and_then(|folders| folders.first())
                .and_then(|folder| folder.get("path"))
        })
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let Some(folder_path) = folder_path else {
        return ApiResponse::error("no_workspace_folder", "current workspace folder is missing");
    };
    let workspace_file_path = folder_path.join(&file_name);
    let overwritten = workspace_file_path.exists();
    let content = json!({
        "folders": [{ "path": "." }],
        "settings": workspace.get("settings").cloned().unwrap_or_else(|| json!({}))
    });
    if let Err(error) = atomic_write_json(&workspace_file_path, &content) {
        return ApiResponse::error("write_workspace_file_failed", error);
    }
    let reopened = match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceOpen {
            request_id: rid("workspace-save-open"),
            path: workspace_file_path.to_string_lossy().to_string(),
        },
    ) {
        Ok(output) => output,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let workspace = reopened.get("workspace").cloned().unwrap_or(Value::Null);
    ApiResponse::ok(json!({
        "workspaceFilePath": workspace_file_path.to_string_lossy(),
        "workspace": workspace,
        "created": !overwritten,
        "overwritten": overwritten
    }))
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
    if let Ok(current) = current_workspace_json(&state.runtime) {
        if let Some(path) = current
            .get("current")
            .and_then(|workspace| workspace.get("folders"))
            .and_then(Value::as_array)
            .and_then(|folders| folders.first())
            .and_then(|folder| folder.get("absolutePath"))
            .or_else(|| {
                current
                    .get("current")
                    .and_then(|workspace| workspace.get("folders"))
                    .and_then(Value::as_array)
                    .and_then(|folders| folders.first())
                    .and_then(|folder| folder.get("path"))
            })
            .and_then(Value::as_str)
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

pub(crate) async fn fs_browse(Query(query): Query<FileQuery>) -> Json<ApiResponse> {
    let path = query
        .path
        .map(PathBuf::from)
        .or_else(home_dir)
        .unwrap_or_else(|| PathBuf::from("/"));
    let target = if path.is_dir() {
        path
    } else {
        path.parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"))
    };
    let entries = match sorted_dir_entries(&target) {
        Ok(entries) => entries
            .into_iter()
            .map(|entry| {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                let is_dir = path.is_dir();
                json!({
                    "name": name,
                    "absolutePath": path.to_string_lossy(),
                    "type": if is_dir { "directory" } else { "file" },
                    "isCodeWorkspace": path.extension().and_then(|ext| ext.to_str()) == Some("code-workspace"),
                    "hidden": name.starts_with('.')
                })
            })
            .collect::<Vec<_>>(),
        Err(error) => return ApiResponse::error("browse_failed", format!("browse {}: {error}", target.display())),
    };
    ApiResponse::ok(json!({
        "absolutePath": target.to_string_lossy(),
        "parentPath": target.parent().map(|path| path.to_string_lossy().to_string()),
        "entries": entries
    }))
}

pub(crate) async fn file_tree(
    State(state): State<AppState>,
    Query(query): Query<FileQuery>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceList {
            request_id: rid("workspace-list"),
            folder_id: query.folder_id,
            path: query.path,
            depth: Some(2),
        },
    ) {
        Ok(output) => {
            let nodes = output
                .get("nodes")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            ApiResponse::ok(nodes)
        }
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn file_read(
    State(state): State<AppState>,
    Query(query): Query<FileQuery>,
) -> Json<ApiResponse> {
    let Some(path) = query.path else {
        return ApiResponse::error("invalid_request", "path is required");
    };
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceRead {
            request_id: rid("workspace-read"),
            folder_id: query.folder_id,
            path,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn file_write(
    State(state): State<AppState>,
    Json(body): Json<FileWriteRequest>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceWrite {
            request_id: rid("workspace-write"),
            folder_id: body.folder_id,
            path: body.path,
            content: body.content,
            create: true,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn file_create(
    State(state): State<AppState>,
    Json(body): Json<FileCreateRequest>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceCreate {
            request_id: rid("workspace-create"),
            folder_id: body.folder_id,
            path: body.path,
            content: body.content,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn folder_create(
    State(state): State<AppState>,
    Json(body): Json<FolderCreateRequest>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceCreateFolder {
            request_id: rid("workspace-create-folder"),
            folder_id: body.folder_id,
            path: body.path,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn file_delete(
    State(state): State<AppState>,
    Json(body): Json<FileDeleteRequest>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceDelete {
            request_id: rid("workspace-delete"),
            folder_id: body.folder_id,
            path: body.path,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn file_rename(
    State(state): State<AppState>,
    Json(body): Json<FileRenameRequest>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceRename {
            request_id: rid("workspace-rename"),
            folder_id: body.folder_id,
            old_path: body.old_path,
            new_path: body.new_path,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn code_search(
    State(state): State<AppState>,
    Json(body): Json<SearchRequest>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceSearch {
            request_id: rid("workspace-search"),
            folder_id: body.folder_id,
            query: body.query,
            include: body.include,
            context_lines: body.context_lines,
            max_results: body.max_results,
            is_regex: body.is_regex.unwrap_or(false),
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) fn dispatch_workspace(
    runtime: &SharedRuntime,
    command: KernelCommand,
) -> Result<Value, KernelErrorEnvelope> {
    let mut runtime = runtime.lock().expect("kernel runtime lock");
    let events = runtime
        .dispatch(command)
        .map_err(|error| KernelErrorEnvelope::from(&error))?;
    match events.into_iter().next() {
        Some(KernelEvent::WorkspaceResult {
            ok: true,
            output: Some(output),
            ..
        }) => Ok(output),
        Some(KernelEvent::WorkspaceResult {
            ok: false,
            error: Some(error),
            ..
        }) => Err(error),
        other => Err(KernelErrorEnvelope {
            code: "unexpected_event".to_string(),
            message: format!("expected workspace result, got {other:?}"),
            message_key: None,
            args: None,
        }),
    }
}

pub(crate) fn ensure_workspace_binding(
    runtime: &SharedRuntime,
    binding: Option<&WorkspaceBinding>,
) -> Result<(), KernelErrorEnvelope> {
    let current = current_workspace_json(runtime)?;
    if current
        .get("current")
        .map(|value| !value.is_null())
        .unwrap_or(false)
    {
        return Ok(());
    }
    let Some(open_path) = binding.and_then(|value| value.open_path.as_ref()) else {
        return Err(KernelErrorEnvelope {
            code: "no_workspace".to_string(),
            message:
                "current workspace is missing and no host workspaceBinding.openPath was provided"
                    .to_string(),
            message_key: None,
            args: None,
        });
    };
    dispatch_workspace(
        runtime,
        KernelCommand::WorkspaceOpen {
            request_id: rid("workspace-restore"),
            path: open_path.clone(),
        },
    )?;
    Ok(())
}

pub(crate) fn current_workspace_json(
    runtime: &SharedRuntime,
) -> Result<Value, KernelErrorEnvelope> {
    dispatch_workspace(
        runtime,
        KernelCommand::WorkspaceCurrent {
            request_id: rid("workspace-current"),
        },
    )
}

pub(crate) fn needs_workspace(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "fs.list"
            | "fs.read"
            | "fs.write"
            | "fs.diff"
            | "fs.delete"
            | "code.search"
            | "git.status"
            | "git.diff"
            | "git.stage"
            | "git.unstage"
            | "git.commit"
            | "git.push"
    )
}
