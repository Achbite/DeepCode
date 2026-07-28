use crate::prelude::*;
use crate::*;

pub(crate) async fn health(State(state): State<AppState>) -> Json<ApiResponse> {
    let workspace = current_workspace(&state.host_services.workspace)
        .ok()
        .and_then(|workspace| serde_json::to_value(workspace).ok())
        .unwrap_or(Value::Null);
    let tool_catalog_snapshot = deepcode_kernel_runtime::kernel_tool_catalog_snapshot();
    let build_info = packaged_build_info().unwrap_or(Value::Null);
    ApiResponse::ok(json!({
        "service": "deepcode-kernel-daemon",
        "status": "ok",
        "kernel": "ready",
        "buildCommit": build_commit(),
        "buildInfo": build_info,
        "kernelAbiVersion": deepcode_kernel_runtime::KERNEL_ABI_VERSION,
        "protocolVersion": deepcode_kernel_runtime::AGENT_PROTOCOL_VERSION,
        "toolCatalogVersion": deepcode_kernel_runtime::TOOL_CATALOG_VERSION,
        "toolCatalogCount": deepcode_kernel_runtime::kernel_visible_tool_catalog_count(),
        "toolCatalogHash": &tool_catalog_snapshot.catalog_hash,
        "toolCatalogSnapshot": tool_catalog_snapshot,
        "workspace": workspace,
        "hostWorkspaceRegistry": format!("{:?}", state.host_services.workspace.readiness()).to_ascii_lowercase(),
        "hostActiveRunBrokerV2": state.host_services.active_runs_v2.status(),
        "sessionKernelProjectionV2": state.host_services.projection_v2.status(),
        "audit": state.host_services.audit.status()
    }))
}

fn build_commit() -> String {
    std::env::var("DEEPCODE_BUILD_COMMIT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| option_env!("DEEPCODE_BUILD_COMMIT").map(str::to_string))
        .or_else(read_packaged_build_commit)
        .unwrap_or_else(|| "unknown".to_string())
}

fn read_packaged_build_commit() -> Option<String> {
    packaged_build_info()
        .and_then(|value| {
            value
                .get("buildCommit")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|commit| !commit.trim().is_empty())
}

fn packaged_build_info() -> Option<Value> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))?;
    [
        exe_dir.join("build-info.json"),
        exe_dir.join("..").join("build-info.json"),
    ]
    .into_iter()
    .find_map(|path| read_json_file(&path))
}

pub(crate) async fn kernel_commands(
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> Json<KernelReply> {
    let body = match serde_json::from_slice::<KernelCommandEnvelope>(&body) {
        Ok(body) => body,
        Err(error) => {
            return Json(KernelReply {
                ok: false,
                events: Vec::new(),
                snapshot: None,
                error: Some(KernelErrorEnvelope {
                    code: "kernel_command_decode_failed".to_string(),
                    message: format!("Kernel command JSON decode failed: {error}"),
                    message_key: None,
                    args: Some(json!({
                        "expected": "KernelCommandEnvelope { command: KernelCommand }",
                        "bodyPreview": kernel_command_body_preview(&body)
                    })),
                }),
            });
        }
    };
    Json(dispatch_kernel_command(&state, body))
}

fn kernel_command_body_preview(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let mut preview = String::new();
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("authorization")
            || lower.contains("api_key")
            || lower.contains("apikey")
            || lower.contains("secret")
            || lower.contains("password")
            || lower.contains("token")
            || lower.contains("bearer ")
        {
            preview.push_str("[redacted-kernel-command-line]\n");
        } else {
            preview.push_str(line);
            preview.push('\n');
        }
        if preview.chars().count() >= 1200 {
            break;
        }
    }
    preview.trim().chars().take(1200).collect()
}

pub(crate) async fn kernel_snapshot(
    State(state): State<AppState>,
    Query(query): Query<KernelSnapshotQuery>,
) -> Json<KernelReply> {
    let snapshot = {
        let runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime.snapshot(query.session_id.as_deref())
    };
    Json(KernelReply {
        ok: true,
        events: Vec::new(),
        snapshot: Some(snapshot),
        error: None,
    })
}

pub(crate) async fn kernel_events_stream(
    State(state): State<AppState>,
    Query(query): Query<KernelEventStreamQuery>,
) -> Response {
    let events = {
        let events = state
            .kernel_events
            .lock()
            .expect("kernel event stream lock");
        events
            .iter()
            .filter(|event| {
                query
                    .session_id
                    .as_deref()
                    .map(|session_id| kernel_event_session_id(event).as_deref() == Some(session_id))
                    .unwrap_or(true)
            })
            .cloned()
            .collect::<Vec<_>>()
    };

    let mut body = String::new();
    if events.is_empty() {
        body.push_str(": deepcode kernel event stream ready\n\n");
    } else {
        for event in events {
            let data = serde_json::to_string(&event)
                .unwrap_or_else(|_| "{\"kind\":\"error\"}".to_string());
            body.push_str("event: kernel\n");
            body.push_str("data: ");
            body.push_str(&data);
            body.push_str("\n\n");
        }
    }

    (
        [
            (header::CONTENT_TYPE, "text/event-stream; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

pub(crate) async fn api_route_not_found(
    method: Method,
    Path(path): Path<String>,
) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        ApiResponse::error(
            "api_route_not_found",
            format!("{method} /api/{path} does not match a registered API route"),
        ),
    )
}
