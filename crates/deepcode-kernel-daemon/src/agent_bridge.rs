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
    let events = canonical_session_projection_events(
        gui.session_projection_cache
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| read_session_projection_jsonl(&gui.paths.sessions_dir, session_id)),
    );
    let events =
        merge_session_kernel_v2_public_agent_events(&gui.paths.sessions_dir, session_id, events)
            .ok()?;
    Some((session, events))
}

pub(crate) fn normalize_host_language(
    request: Option<&str>,
    setting: Option<String>,
) -> (String, &'static str) {
    if matches!(request, Some("zh-CN" | "en-US")) {
        return (request.unwrap_or("zh-CN").to_string(), "request");
    }
    if matches!(setting.as_deref(), Some("zh-CN" | "en-US")) {
        return (
            setting.unwrap_or_else(|| "zh-CN".to_string()),
            if request.is_some() {
                "daemonSettingAfterInvalidRequest"
            } else {
                "daemonSetting"
            },
        );
    }
    (
        "zh-CN".to_string(),
        if request.is_some() {
            "defaultAfterInvalidRequest"
        } else {
            "default"
        },
    )
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
    let resolved_binding = state
        .host_services
        .workspace
        .validate_project_binding(&stored_binding)
        .map_err(|error| {
            if !continuing_run {
                set_project_root_status(state, project_id, "unavailable");
            }
            KernelErrorEnvelope {
                code: error.code,
                message: format!("project workspace root is unavailable: {}", error.message),
                message_key: error.message_key,
                args: error.args,
            }
        })?;
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

pub(crate) fn run_readonly_session_bridge(request: Value) -> Result<Value, KernelErrorEnvelope> {
    let payload = serde_json::to_vec(&request).map_err(|error| KernelErrorEnvelope {
        code: "session_bridge_request_encode_failed".to_string(),
        message: format!("failed to encode read-only Session bridge request: {error}"),
        message_key: None,
        args: None,
    })?;
    let bridge = find_session_host_bridge_daemon().ok_or_else(|| KernelErrorEnvelope {
        code: "session_bridge_unavailable".to_string(),
        message: format!(
            "cannot find session host bridge; {}",
            session_host_bridge_hint_daemon()
        ),
        message_key: None,
        args: None,
    })?;
    let node = find_session_host_node_daemon(&bridge);
    let mut child = Command::new(&node)
        .arg(&bridge)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| KernelErrorEnvelope {
            code: "session_bridge_spawn_failed".to_string(),
            message: format!(
                "failed to start Node runtime `{}` for bridge `{}`: {error}",
                node.display(),
                bridge.display()
            ),
            message_key: None,
            args: None,
        })?;
    let write_result = child
        .stdin
        .take()
        .ok_or_else(|| KernelErrorEnvelope {
            code: "session_bridge_stdin_unavailable".to_string(),
            message: "read-only Session bridge stdin is unavailable".to_string(),
            message_key: None,
            args: None,
        })
        .and_then(|mut stdin| {
            stdin
                .write_all(&payload)
                .map_err(|error| KernelErrorEnvelope {
                    code: "session_bridge_write_failed".to_string(),
                    message: format!("failed to write read-only Session bridge request: {error}"),
                    message_key: None,
                    args: None,
                })
        });
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let output = wait_for_child_output_with_cancel_grace(
        child,
        || false,
        Some(Duration::from_secs(30)),
        Duration::ZERO,
    )
    .map_err(|error| KernelErrorEnvelope {
        code: "session_bridge_failed".to_string(),
        message: match error {
            BridgeWorkerStop::Cancelled => {
                "read-only Session bridge was unexpectedly cancelled".to_string()
            }
            BridgeWorkerStop::Failed(message) => message,
        },
        message_key: None,
        args: None,
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let result =
        serde_json::from_str::<Value>(stdout.trim()).map_err(|error| KernelErrorEnvelope {
            code: "session_bridge_invalid_json".to_string(),
            message: format!(
                "read-only Session bridge returned invalid JSON: {error}; stderr={}",
                stderr.trim()
            ),
            message_key: None,
            args: None,
        })?;
    if !output.status.success() || result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(KernelErrorEnvelope {
            code: result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("session_bridge_failed")
                .to_string(),
            message: result
                .get("message")
                .or_else(|| result.get("error"))
                .and_then(Value::as_str)
                .unwrap_or_else(|| stderr.trim())
                .to_string(),
            message_key: None,
            args: None,
        });
    }
    Ok(result)
}

#[derive(Debug)]
pub(crate) enum BridgeWorkerStop {
    Cancelled,
    Failed(String),
}

#[cfg(test)]
pub(crate) fn wait_for_child_output(
    child: Child,
    should_cancel: impl FnMut() -> bool,
    timeout: Option<Duration>,
) -> Result<Output, BridgeWorkerStop> {
    wait_for_child_output_with_cancel_grace(child, should_cancel, timeout, Duration::ZERO)
}

fn wait_for_child_output_with_cancel_grace(
    mut child: Child,
    mut should_cancel: impl FnMut() -> bool,
    timeout: Option<Duration>,
    cancel_grace: Duration,
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
    let mut cancellation_requested_at: Option<Instant> = None;
    loop {
        if should_cancel() {
            let cancellation_started = cancellation_requested_at.get_or_insert_with(Instant::now);
            if cancel_grace.is_zero() || cancellation_started.elapsed() >= cancel_grace {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(BridgeWorkerStop::Cancelled);
            }
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

pub(crate) fn find_session_host_node_daemon(bridge: &FsPath) -> PathBuf {
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
