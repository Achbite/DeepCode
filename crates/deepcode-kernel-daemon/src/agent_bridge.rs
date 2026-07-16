use crate::prelude::*;
use crate::*;

pub(crate) fn run_response(state: &AppState, session_id: &str, run_id: &str) -> Json<ApiResponse> {
    let run = {
        let runs = state.session_runs.lock().expect("session run state lock");
        runs.get(run_id)
            .filter(|run| run.session_id == session_id)
            .cloned()
    };
    let Some(run) = run else {
        return ApiResponse::error("agent_run_not_found", "agent run not found");
    };
    let Some((session, events)) = session_payload(state, session_id) else {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    };
    ApiResponse::ok(json!({
        "run": run,
        "session": session,
        "events": events
    }))
}

pub(crate) fn session_payload(state: &AppState, session_id: &str) -> Option<(Value, Vec<Value>)> {
    let gui = state.gui.lock().expect("gui state lock");
    let session = session_by_id(&gui, session_id)?.clone();
    let events = gui
        .session_projection_cache
        .get(session_id)
        .cloned()
        .unwrap_or_else(|| read_session_projection_jsonl(&gui.paths.sessions_dir, session_id));
    Some((session, events))
}

pub(crate) fn host_bridge_request(
    session_id: &str,
    host_run_id: &str,
    body: &AgentSessionRunRequest,
    intervention_level: Option<String>,
    project_memory_mode: String,
    autonomy_mode: String,
    project_context: Option<&Value>,
) -> Value {
    let op = body.op.as_deref().unwrap_or_else(|| {
        if body.decision_kind.is_some() {
            "resolveDecision"
        } else {
            "ask"
        }
    });
    let prompt = body
        .prompt
        .as_ref()
        .or(body.content.as_ref())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let project_binding = project_context
        .and_then(|context| context.get("workspaceBinding"))
        .filter(|binding| binding.is_object())
        .cloned();
    let project_workspace_path = project_binding
        .as_ref()
        .and_then(|binding| binding.get("openPath"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let project_is_blank = project_context
        .and_then(|context| context.get("kind"))
        .and_then(Value::as_str)
        == Some("blank");
    let workspace_path = if project_context.is_some() {
        project_workspace_path
    } else {
        body.workspace_path.clone()
    };
    let no_workspace = if project_context.is_some() {
        project_is_blank
    } else {
        body.no_workspace.unwrap_or(false)
    };

    json!({
        "op": op,
        "apiBase": daemon_api_base(),
        "sessionId": session_id,
        "hostRunId": host_run_id,
        "prompt": prompt,
        "title": body.title.clone(),
        "attachments": body.attachments.clone().unwrap_or_default(),
        "workspacePath": workspace_path,
        "workspaceBinding": project_binding,
        "noWorkspace": no_workspace,
        "projectId": project_context.and_then(|context| context.get("projectId")).cloned(),
        "projectKind": project_context.and_then(|context| context.get("kind")).cloned(),
        "projectRootStatus": project_context.and_then(|context| context.get("rootStatus")).cloned(),
        "profileId": body.profile_id.clone(),
        "workflow": body.workflow.clone(),
        "requirementConfirmationMode": body.requirement_confirmation_mode.clone(),
        "reviewContinuationMode": body.review_continuation_mode.clone(),
        "interventionLevel": intervention_level,
        "projectMemoryMode": project_memory_mode,
        "autonomyMode": autonomy_mode,
        "decisionKind": body.decision_kind.clone(),
        "decision": body.decision.clone(),
        "guidance": body.guidance.clone(),
        "runId": body.run_id.clone(),
        "targetId": body.target_id.clone()
    })
}

pub(crate) fn authoritative_project_run_context(
    state: &AppState,
    session: &Value,
    continuing_run: bool,
) -> Result<Option<Value>, KernelErrorEnvelope> {
    let Some(project_id) = session
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let project = {
        let gui = state.gui.lock().expect("gui state lock");
        project_by_id(&gui, project_id).cloned()
    }
    .ok_or_else(|| KernelErrorEnvelope {
        code: "project_root_unavailable".to_string(),
        message: "project record is unavailable; rebind the project directory".to_string(),
        message_key: None,
        args: None,
    })?;
    let kind = project
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("blank");
    if kind == "blank" {
        return Ok(Some(json!({
            "projectId": project_id,
            "kind": "blank",
            "rootStatus": "unbound"
        })));
    }
    let stored_binding = if continuing_run {
        session
            .get("workspaceBinding")
            .filter(|binding| binding.is_object())
            .cloned()
            .or_else(|| project_workspace_binding(&project))
    } else {
        project_workspace_binding(&project)
    }
    .ok_or_else(|| {
        if !continuing_run {
            set_project_root_status(state, project_id, "unavailable");
        }
        KernelErrorEnvelope {
            code: "project_root_unavailable".to_string(),
            message: "project workspace binding is unavailable; rebind the project directory"
                .to_string(),
            message_key: None,
            args: None,
        }
    })?;
    let open_path = stored_binding
        .get("openPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            if !continuing_run {
                set_project_root_status(state, project_id, "unavailable");
            }
            KernelErrorEnvelope {
                code: "project_root_unavailable".to_string(),
                message: "project workspace root is unavailable; rebind the project directory"
                    .to_string(),
                message_key: None,
                args: None,
            }
        })?;
    let resolved_binding = resolve_project_binding(&state.runtime, open_path).map_err(|error| {
        if !continuing_run {
            set_project_root_status(state, project_id, "unavailable");
        }
        KernelErrorEnvelope {
            code: "project_root_unavailable".to_string(),
            message: format!("project workspace root is unavailable: {}", error.message),
            message_key: None,
            args: None,
        }
    })?;
    if stored_binding.get("workspaceHash") != resolved_binding.get("workspaceHash") {
        if !continuing_run {
            set_project_root_status(state, project_id, "unavailable");
        }
        return Err(KernelErrorEnvelope {
            code: "project_workspace_binding_mismatch".to_string(),
            message: "project workspace binding no longer matches the configured directory; rebind the project"
                .to_string(),
            message_key: None,
            args: None,
        });
    }
    if !continuing_run {
        set_project_root_status(state, project_id, "ready");
    }
    Ok(Some(json!({
        "projectId": project_id,
        "kind": "folder",
        "rootStatus": "ready",
        "workspaceBinding": resolved_binding
    })))
}

pub(crate) fn user_setting_string(state: &AppState, key: &str) -> Option<String> {
    let gui = state.gui.lock().expect("gui state lock");
    gui.user_settings
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(crate) fn normalize_project_memory_mode(
    value: Option<Value>,
    setting: Option<String>,
) -> String {
    let raw = value
        .as_ref()
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(setting);
    match raw.as_deref() {
        Some("auto") => "auto".to_string(),
        Some("confirm") => "confirm".to_string(),
        _ => "confirm".to_string(),
    }
}

fn daemon_api_base() -> String {
    if let Ok(base_url) = std::env::var("DEEPCODE_API_URL") {
        let trimmed = base_url.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let host = std::env::var("DEEPCODE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DEEPCODE_PORT").unwrap_or_else(|_| "31245".to_string());
    format!("http://{host}:{port}")
}

pub(crate) fn run_session_bridge_worker(
    state: AppState,
    session_id: String,
    run_id: String,
    request: Value,
    start_event_count: usize,
) {
    let Some(bridge) = find_session_host_bridge_daemon() else {
        fail_run_with_event(
            &state,
            &session_id,
            &run_id,
            "session_bridge_unavailable",
            format!(
                "cannot find session host bridge; {}",
                session_host_bridge_hint_daemon()
            ),
        );
        return;
    };
    let node = find_session_host_node_daemon(&bridge);
    let mut child = match Command::new(&node)
        .arg(&bridge)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            fail_run_with_event(
                &state,
                &session_id,
                &run_id,
                "session_bridge_spawn_failed",
                format!(
                    "failed to start Node runtime `{}` for bridge `{}`: {error}; {}",
                    node.display(),
                    bridge.display(),
                    session_host_bridge_hint_daemon()
                ),
            );
            return;
        }
    };

    match child.stdin.take() {
        Some(mut stdin) => {
            let payload = match serde_json::to_vec(&request) {
                Ok(payload) => payload,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    fail_run_with_event(
                        &state,
                        &session_id,
                        &run_id,
                        "session_bridge_request_encode_failed",
                        format!("failed to encode session run request: {error}"),
                    );
                    return;
                }
            };
            if let Err(error) = stdin.write_all(&payload) {
                let _ = child.kill();
                let _ = child.wait();
                fail_run_with_event(
                    &state,
                    &session_id,
                    &run_id,
                    "session_bridge_write_failed",
                    format!("failed to write session run request: {error}"),
                );
                return;
            }
        }
        None => {
            let _ = child.kill();
            let _ = child.wait();
            fail_run_with_event(
                &state,
                &session_id,
                &run_id,
                "session_bridge_stdin_unavailable",
                "session bridge stdin is unavailable",
            );
            return;
        }
    }

    match wait_for_session_bridge_output(&state, &run_id, child) {
        Ok(output) => {
            finish_run_from_bridge_output(&state, &session_id, &run_id, output, start_event_count)
        }
        Err(BridgeWorkerStop::Cancelled) => {
            let _ = set_run_terminal(
                &state,
                &run_id,
                "cancelled",
                Some("Run cancelled by user.".to_string()),
                None,
            );
        }
        Err(BridgeWorkerStop::Failed(message)) => {
            fail_run_with_event(
                &state,
                &session_id,
                &run_id,
                "session_bridge_failed",
                message,
            );
        }
    }
}

#[derive(Debug)]
pub(crate) enum BridgeWorkerStop {
    Cancelled,
    Failed(String),
}

fn wait_for_session_bridge_output(
    state: &AppState,
    run_id: &str,
    child: Child,
) -> Result<Output, BridgeWorkerStop> {
    wait_for_child_output(
        child,
        || run_cancelled(state, run_id),
        session_host_bridge_timeout(),
    )
}

pub(crate) fn wait_for_child_output(
    mut child: Child,
    mut should_cancel: impl FnMut() -> bool,
    timeout: Option<Duration>,
) -> Result<Output, BridgeWorkerStop> {
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(BridgeWorkerStop::Failed(
            "session bridge stdout is unavailable".to_string(),
        ));
    };
    let Some(mut stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(BridgeWorkerStop::Failed(
            "session bridge stderr is unavailable".to_string(),
        ));
    };
    let stdout_reader = thread::spawn(move || {
        let mut output = Vec::new();
        stdout
            .read_to_end(&mut output)
            .map(|_| output)
            .map_err(|error| format!("failed to read session bridge stdout: {error}"))
    });
    let stderr_reader = thread::spawn(move || {
        let mut output = Vec::new();
        stderr
            .read_to_end(&mut output)
            .map(|_| output)
            .map_err(|error| format!("failed to read session bridge stderr: {error}"))
    });
    let started_at = Instant::now();
    loop {
        if should_cancel() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(BridgeWorkerStop::Cancelled);
        }
        if let Some(limit) = timeout {
            if started_at.elapsed() >= limit {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(BridgeWorkerStop::Failed(format!(
                    "session run timed out after {} ms; set DEEPCODE_SESSION_BRIDGE_TIMEOUT_MS=0 to disable the hard timeout",
                    limit.as_millis()
                )));
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_reader
                    .join()
                    .map_err(|_| {
                        BridgeWorkerStop::Failed(
                            "session bridge stdout reader panicked".to_string(),
                        )
                    })?
                    .map_err(BridgeWorkerStop::Failed)?;
                let stderr = stderr_reader
                    .join()
                    .map_err(|_| {
                        BridgeWorkerStop::Failed(
                            "session bridge stderr reader panicked".to_string(),
                        )
                    })?
                    .map_err(BridgeWorkerStop::Failed)?;
                return Ok(Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(BridgeWorkerStop::Failed(format!(
                    "failed to wait for session bridge output: {error}"
                )));
            }
        }
    }
}

fn finish_run_from_bridge_output(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    output: Output,
    start_event_count: usize,
) {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let result = match serde_json::from_str::<Value>(stdout.trim()) {
        Ok(result) => result,
        Err(error) => {
            fail_run_with_event(
                state,
                session_id,
                run_id,
                "session_bridge_invalid_json",
                format!(
                    "session bridge returned invalid JSON: {error}; stdout={}; stderr={}",
                    stdout.trim(),
                    stderr.trim()
                ),
            );
            return;
        }
    };
    let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !output.status.success() || !ok {
        let message = result
            .get("message")
            .or_else(|| result.get("error"))
            .and_then(Value::as_str)
            .filter(|message| !message.trim().is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                let stderr = stderr.trim();
                if stderr.is_empty() {
                    "session bridge failed".to_string()
                } else {
                    stderr.to_string()
                }
            });
        fail_run_with_event(state, session_id, run_id, "session_bridge_failed", message);
        return;
    }

    let event_count = session_projection(state, session_id).len();
    let timeline = match validated_bridge_timeline(&result, session_id, event_count) {
        Ok(timeline) => timeline,
        Err(message) => {
            fail_run_with_event(
                state,
                session_id,
                run_id,
                "session_bridge_timeline_invalid",
                message,
            );
            return;
        }
    };
    if let Err(error) = store_session_timeline(state, session_id, timeline) {
        fail_run_with_event(
            state,
            session_id,
            run_id,
            "write_session_timeline_failed",
            format!("failed to persist canonical session timeline: {error}"),
        );
        return;
    }

    if let Some(run_status) = result.get("runStatus").and_then(Value::as_str) {
        match run_status {
            "waiting" => {
                let message = result
                    .get("terminalReason")
                    .and_then(Value::as_str)
                    .unwrap_or("Session run is waiting for user input.")
                    .to_string();
                let _ = set_run_terminal(state, run_id, "waiting", Some(message), None);
                return;
            }
            "failed" => {
                let message = result
                    .get("terminalReason")
                    .and_then(Value::as_str)
                    .unwrap_or("Session run failed.")
                    .to_string();
                let _ = set_run_terminal(state, run_id, "failed", Some(message), None);
                return;
            }
            "cancelled" => {
                let message = result
                    .get("terminalReason")
                    .and_then(Value::as_str)
                    .unwrap_or("Session run is cancelled.")
                    .to_string();
                let _ = set_run_terminal(state, run_id, "cancelled", Some(message), None);
                return;
            }
            "completed" => {}
            _ => {}
        }
    }

    let final_text = result
        .get("finalText")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| latest_final_text(state, session_id, start_event_count));
    let _ = set_run_terminal(state, run_id, "completed", None, final_text);
}

fn session_host_bridge_timeout() -> Option<Duration> {
    const DEFAULT_TIMEOUT_MS: u64 = 600_000;
    let millis = std::env::var("DEEPCODE_SESSION_BRIDGE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    if millis == 0 {
        None
    } else {
        Some(Duration::from_millis(millis))
    }
}

fn find_session_host_bridge_daemon() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("DEEPCODE_SESSION_BRIDGE") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    for root in roots {
        if let Some(path) = find_bridge_from_root_daemon(&root) {
            return Some(path);
        }
    }
    None
}

fn find_bridge_from_root_daemon(root: &FsPath) -> Option<PathBuf> {
    for ancestor in root.ancestors() {
        for candidate in [
            ancestor.join("session-core/dist/hostBridge.js"),
            ancestor.join("session-core/hostBridge.js"),
            ancestor.join("userspace/session-core/dist/hostBridge.js"),
            ancestor.join("DeepCode/userspace/session-core/dist/hostBridge.js"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn find_session_host_node_daemon(bridge: &FsPath) -> PathBuf {
    if let Ok(path) = std::env::var("DEEPCODE_NODE") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }

    let mut roots = Vec::new();
    if let Some(parent) = bridge.parent() {
        roots.push(parent.to_path_buf());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }

    for root in roots {
        if let Some(node) = find_node_from_root_daemon(&root) {
            return node;
        }
    }
    PathBuf::from(node_executable_name_daemon())
}

fn find_node_from_root_daemon(root: &FsPath) -> Option<PathBuf> {
    for ancestor in root.ancestors() {
        for candidate in [
            ancestor
                .join("node/bin")
                .join(node_executable_name_daemon()),
            ancestor.join("bin").join(node_executable_name_daemon()),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn node_executable_name_daemon() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn session_host_bridge_hint_daemon() -> &'static str {
    "run `pnpm --filter @deepcode/session-core build`, set DEEPCODE_SESSION_BRIDGE, set DEEPCODE_NODE, or use a packaged distribution that includes session-core/dist/hostBridge.js, node_modules/@deepcode/protocol, and node/bin/node"
}
