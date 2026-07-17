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
    let binding = match root_path {
        Some(path) => match resolve_project_binding(&state.runtime, path) {
            Ok(binding) => Some(binding),
            Err(error) => return ApiResponse::error(error.code, error.message),
        },
        None => None,
    };
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
        return ApiResponse::error("agent_project_persist_failed", error);
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
    let binding = match resolve_project_binding(&state.runtime, root_path) {
        Ok(binding) => binding,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let mut gui = state.gui.lock().expect("gui state lock");
    let previous_projects = gui.projects.clone();
    let Some(project) = project_mut(&mut gui, &project_id) else {
        return ApiResponse::error("agent_project_not_found", "agent project not found");
    };
    project["kind"] = json!("folder");
    project["workspaceBinding"] = binding;
    project["rootStatus"] = json!("ready");
    project["updatedAt"] = json!(now_text());
    let result = project.clone();
    if let Err(error) = persist_agent_projects(&gui) {
        gui.projects = previous_projects;
        return ApiResponse::error("agent_project_persist_failed", error);
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
    if let Err(error) = persist_agent_projects(&gui).and_then(|_| persist_session_index(&gui)) {
        gui.projects = previous_projects;
        gui.sessions = previous_sessions;
        let rollback_error = persist_agent_projects(&gui)
            .and_then(|_| persist_session_index(&gui))
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

pub(crate) fn resolve_project_binding(
    runtime: &SharedRuntime,
    root_path: &str,
) -> Result<Value, KernelErrorEnvelope> {
    let result = dispatch_workspace_result(
        runtime,
        KernelCommand::HostWorkspaceBindingResolve {
            request_id: rid(&format!("project-binding-{}", now_millis())),
            path: root_path.to_string(),
        },
    )
    .map_err(|error| KernelErrorEnvelope {
        code: "project_root_unavailable".to_string(),
        message: format!("project workspace root is unavailable: {}", error.message),
        message_key: None,
        args: None,
    })?;
    let HostWorkspaceOutput::BindingResolved(output) = result.output else {
        return Err(KernelErrorEnvelope {
            code: "project_root_unavailable".to_string(),
            message: "Kernel did not return a workspace binding".to_string(),
            message_key: None,
            args: None,
        });
    };
    serde_json::to_value(output.workspace_binding).map_err(|error| KernelErrorEnvelope {
        code: "project_workspace_binding_encoding_failed".to_string(),
        message: error.to_string(),
        message_key: None,
        args: None,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot(PathBuf);

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn project_store_owns_binding_and_rebind_only_updates_future_sessions() {
        let root = std::env::temp_dir().join(format!(
            "deepcode-project-store-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let first_workspace = root.join("first-workspace");
        let second_workspace = root.join("second-workspace");
        fs::create_dir_all(&first_workspace).expect("create first workspace");
        fs::create_dir_all(&second_workspace).expect("create second workspace");
        let _test_root = TestRoot(root.clone());
        let state = test_state(&root);

        let created = agent_project_create(
            State(state.clone()),
            Json(json!({
                "title": "Folder project",
                "rootPath": first_workspace
            })),
        )
        .await
        .0;
        assert!(created.ok);
        let project = created
            .data
            .as_ref()
            .and_then(|data| data.get("project"))
            .cloned()
            .expect("created project");
        let project_id = project["id"].as_str().expect("project id").to_string();
        let first_hash = project["workspaceBinding"]["workspaceHash"]
            .as_str()
            .expect("first workspace hash")
            .to_string();

        let first_session = agent_session_create(
            State(state.clone()),
            Json(json!({
                "projectId": project_id,
                "workspaceId": "client-conflict",
                "workspaceHash": "client-conflict"
            })),
        )
        .await
        .0;
        assert!(first_session.ok);
        let first_session = first_session
            .data
            .as_ref()
            .and_then(|data| data.get("session"))
            .cloned()
            .expect("first session");
        assert_eq!(
            first_session["workspaceHash"].as_str(),
            Some(first_hash.as_str())
        );
        assert_ne!(
            first_session["workspaceId"].as_str(),
            Some("client-conflict")
        );
        assert_ne!(
            first_session["workspaceScopeKey"].as_str(),
            Some("unbound-workspace")
        );

        let rebound = agent_project_rebind(
            State(state.clone()),
            Path(project_id.clone()),
            Json(json!({ "rootPath": second_workspace })),
        )
        .await
        .0;
        assert!(rebound.ok);
        let second_hash = rebound
            .data
            .as_ref()
            .and_then(|data| data.get("project"))
            .and_then(|project| project.get("workspaceBinding"))
            .and_then(|binding| binding.get("workspaceHash"))
            .and_then(Value::as_str)
            .expect("second workspace hash")
            .to_string();
        assert_ne!(first_hash, second_hash);
        assert_eq!(
            first_session["workspaceHash"].as_str(),
            Some(first_hash.as_str())
        );

        let second_session = agent_session_create(
            State(state.clone()),
            Json(json!({ "projectId": project_id })),
        )
        .await
        .0;
        let second_session = second_session
            .data
            .as_ref()
            .and_then(|data| data.get("session"))
            .expect("second session");
        assert_eq!(
            second_session["workspaceHash"].as_str(),
            Some(second_hash.as_str())
        );

        let stored = restore_agent_projects(&root.join("projects.json"));
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0]["id"].as_str(), Some(project_id.as_str()));

        let deleted = agent_project_delete(State(state), Path(project_id)).await.0;
        assert!(deleted.ok);
        assert!(first_workspace.is_dir());
        assert!(second_workspace.is_dir());
    }

    #[test]
    fn project_binding_rejects_files() {
        let root = std::env::temp_dir().join(format!(
            "deepcode-project-binding-file-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&root).expect("create root");
        let _test_root = TestRoot(root.clone());
        let file = root.join("not-a-directory.txt");
        fs::write(&file, "text").expect("write file");
        let runtime = Arc::new(Mutex::new(DeepCodeKernelRuntime::new()));
        let error = resolve_project_binding(&runtime, &file.to_string_lossy())
            .expect_err("file binding must fail");
        assert_eq!(error.code, "project_root_unavailable");
    }

    fn test_state(root: &FsPath) -> AppState {
        let paths = HostPaths {
            settings_path: root.join("settings.json"),
            llm_profiles_path: root.join("profiles.json"),
            llm_secrets_path: root.join("secrets.json"),
            workflow_config_path: root.join("workflow.json"),
            projects_path: root.join("projects.json"),
            sessions_index_path: root.join("agent-sessions.json"),
            sessions_dir: root.join("sessions"),
            conversation_archives_dir: root.join("archives"),
            memory_archives_dir: root.join("memory"),
        };
        AppState {
            runtime: Arc::new(Mutex::new(DeepCodeKernelRuntime::new())),
            gui: Arc::new(Mutex::new(GuiState {
                paths,
                user_settings: json!({}),
                llm_profiles: json!({}),
                workflow_config: json!({}),
                projects: Vec::new(),
                sessions: Vec::new(),
                current_session_id: None,
                current_session_ids_by_scope: HashMap::new(),
                session_projection_cache: HashMap::new(),
                session_timeline_cache: HashMap::new(),
                trace_events: HashMap::new(),
            })),
            terminal_runtime: Arc::new(Mutex::new(crate::terminal_api::TerminalRuntime::new())),
            kernel_events: Arc::new(Mutex::new(Vec::new())),
            session_runs: Arc::new(Mutex::new(HashMap::new())),
            session_run_deltas: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
