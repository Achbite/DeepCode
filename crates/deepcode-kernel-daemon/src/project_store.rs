use crate::prelude::*;
use crate::*;

const PROJECT_STORE_SCHEMA: &str = "deepcode.agent.projects.v1";

pub(crate) fn restore_agent_projects(path: &PathBuf) -> Vec<Value> {
    read_json_file(path)
        .and_then(|value| value.get("projects").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

pub(crate) fn persist_agent_projects(gui: &GuiState) -> Result<(), String> {
    atomic_write_json(
        &gui.paths.projects_path,
        &json!({
            "schemaVersion": PROJECT_STORE_SCHEMA,
            "projects": gui.projects
        }),
    )
}

pub(crate) async fn agent_projects_list(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({ "projects": gui.projects }))
}

pub(crate) async fn agent_project_get(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    match project_by_id(&gui, &project_id) {
        Some(project) => ApiResponse::ok(json!({ "project": project })),
        None => ApiResponse::error("agent_project_not_found", "agent project not found"),
    }
}

pub(crate) async fn agent_project_create(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let root_path = body
        .get("rootPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let binding_change = match root_path {
        Some(path) => match state
            .host_services
            .workspace
            .begin_project_binding(None, path)
        {
            Ok(change) => Some(change),
            Err(error) => return ApiResponse::error(error.code, error.message),
        },
        None => None,
    };
    let binding = binding_change.as_ref().map(|change| change.value.clone());
    let now = now_text();
    let id = format!("project-{}", now_millis());
    let default_title = root_path
        .and_then(|path| FsPath::new(path).file_name())
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("New Project");
    let project = json!({
        "id": id,
        "title": body.get("title").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).unwrap_or(default_title),
        "kind": if binding.is_some() { "folder" } else { "blank" },
        "workspaceBinding": binding,
        "rootStatus": if root_path.is_some() { "ready" } else { "unbound" },
        "createdAt": now,
        "updatedAt": now
    });
    let mut gui = state.gui.lock().expect("gui state lock");
    gui.projects.insert(0, project.clone());
    if let Err(error) = persist_agent_projects(&gui) {
        gui.projects.remove(0);
        let message = rollback_project_binding_after_persist_failure(
            &state.host_services.workspace,
            binding_change,
            error,
        );
        return ApiResponse::error("agent_project_persist_failed", message);
    }
    ApiResponse::ok(json!({ "project": project }))
}

pub(crate) async fn agent_project_update(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut gui = state.gui.lock().expect("gui state lock");
    let previous_projects = gui.projects.clone();
    let Some(project) = project_mut(&mut gui, &project_id) else {
        return ApiResponse::error("agent_project_not_found", "agent project not found");
    };
    if let Some(title) = title {
        project["title"] = json!(title);
    }
    project["updatedAt"] = json!(now_text());
    let result = project.clone();
    if let Err(error) = persist_agent_projects(&gui) {
        gui.projects = previous_projects;
        return ApiResponse::error("agent_project_persist_failed", error);
    }
    ApiResponse::ok(json!({ "project": result }))
}

pub(crate) async fn agent_project_rebind(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let Some(root_path) = body
        .get("rootPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return ApiResponse::error("project_root_required", "project root path is required");
    };
    let existing_binding = {
        let gui = state.gui.lock().expect("gui state lock");
        let Some(project) = project_by_id(&gui, &project_id) else {
            return ApiResponse::error("agent_project_not_found", "agent project not found");
        };
        project_workspace_binding(project)
    };
    let binding_change = match state
        .host_services
        .workspace
        .begin_project_binding(existing_binding.as_ref(), root_path)
    {
        Ok(change) => change,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let mut gui = state.gui.lock().expect("gui state lock");
    let previous_projects = gui.projects.clone();
    let Some(project) = project_mut(&mut gui, &project_id) else {
        let _ = state
            .host_services
            .workspace
            .rollback_project_binding(binding_change);
        return ApiResponse::error("agent_project_not_found", "agent project not found");
    };
    project["kind"] = json!("folder");
    project["workspaceBinding"] = binding_change.value.clone();
    project["rootStatus"] = json!("ready");
    project["updatedAt"] = json!(now_text());
    let result = project.clone();
    if let Err(error) = persist_agent_projects(&gui) {
        gui.projects = previous_projects;
        let message = rollback_project_binding_after_persist_failure(
            &state.host_services.workspace,
            Some(binding_change),
            error,
        );
        return ApiResponse::error("agent_project_persist_failed", message);
    }
    ApiResponse::ok(json!({ "project": result }))
}

pub(crate) async fn agent_project_delete(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let previous_projects = gui.projects.clone();
    let previous_sessions = gui.sessions.clone();
    let Some(index) = gui
        .projects
        .iter()
        .position(|project| project.get("id").and_then(Value::as_str) == Some(project_id.as_str()))
    else {
        return ApiResponse::error("agent_project_not_found", "agent project not found");
    };
    gui.projects.remove(index);
    for session in &mut gui.sessions {
        if session.get("projectId").and_then(Value::as_str) == Some(project_id.as_str()) {
            session["projectId"] = Value::Null;
            session["workspaceBinding"] = Value::Null;
            session["workspaceId"] = Value::Null;
            session["workspaceHash"] = Value::Null;
            session["workspaceScopeKey"] = json!("unbound-workspace");
            session["updatedAt"] = json!(now_text());
        }
    }
    if let Err(error) = persist_agent_projects(&gui)
        .and_then(|_| crate::session_metadata_v2::persist_session_index(&gui))
    {
        gui.projects = previous_projects;
        gui.sessions = previous_sessions;
        let rollback_error = persist_agent_projects(&gui)
            .and_then(|_| crate::session_metadata_v2::persist_session_index(&gui))
            .err();
        let message = rollback_error
            .map(|rollback| format!("{error}; rollback failed: {rollback}"))
            .unwrap_or(error);
        return ApiResponse::error("agent_project_persist_failed", message);
    }
    ApiResponse::ok(json!({ "projects": gui.projects }))
}

pub(crate) fn project_by_id<'a>(gui: &'a GuiState, project_id: &str) -> Option<&'a Value> {
    gui.projects
        .iter()
        .find(|project| project.get("id").and_then(Value::as_str) == Some(project_id))
}

pub(crate) fn project_mut<'a>(gui: &'a mut GuiState, project_id: &str) -> Option<&'a mut Value> {
    gui.projects
        .iter_mut()
        .find(|project| project.get("id").and_then(Value::as_str) == Some(project_id))
}

pub(crate) fn project_workspace_binding(project: &Value) -> Option<Value> {
    project
        .get("workspaceBinding")
        .filter(|binding| binding.is_object())
        .cloned()
}

fn rollback_project_binding_after_persist_failure(
    workspace: &HostWorkspaceService,
    change: Option<HostProjectBindingChange>,
    persist_error: String,
) -> String {
    let Some(change) = change else {
        return persist_error;
    };
    match workspace.rollback_project_binding(change) {
        Ok(()) => persist_error,
        Err(rollback_error) => {
            format!(
                "{persist_error}; workspace registry rollback failed: {}",
                rollback_error.message
            )
        }
    }
}

pub(crate) fn set_project_root_status(state: &AppState, project_id: &str, status: &str) {
    let mut gui = state.gui.lock().expect("gui state lock");
    let Some(project) = project_mut(&mut gui, project_id) else {
        return;
    };
    if project.get("rootStatus").and_then(Value::as_str) == Some(status) {
        return;
    }
    project["rootStatus"] = json!(status);
    project["updatedAt"] = json!(now_text());
    let _ = persist_agent_projects(&gui);
}
