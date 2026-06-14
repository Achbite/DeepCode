#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

pub(crate) async fn health(State(state): State<AppState>) -> Json<ApiResponse> {
    let workspace = current_workspace_json(&state.runtime).unwrap_or(Value::Null);
    ApiResponse::ok(json!({
        "service": "deepcode-kernel-daemon",
        "status": "ok",
        "kernel": "ready",
        "buildCommit": build_commit(),
        "protocolVersion": deepcode_kernel_runtime::AGENT_PROTOCOL_VERSION,
        "toolCatalogVersion": deepcode_kernel_runtime::TOOL_CATALOG_VERSION,
        "toolCatalogCount": deepcode_kernel_runtime::kernel_visible_tool_catalog_count(),
        "workspace": workspace
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
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))?;
    for path in [
        exe_dir.join("build-info.json"),
        exe_dir.join("..").join("build-info.json"),
    ] {
        let value = read_json_file(&path)?;
        if let Some(commit) = value.get("buildCommit").and_then(Value::as_str) {
            if !commit.trim().is_empty() {
                return Some(commit.to_string());
            }
        }
    }
    None
}

pub(crate) async fn kernel_commands(
    State(state): State<AppState>,
    Json(body): Json<KernelCommandEnvelope>,
) -> Json<KernelReply> {
    Json(dispatch_kernel_command(&state, body))
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

pub(crate) async fn api_not_implemented(
    method: Method,
    Path(path): Path<String>,
) -> Json<ApiResponse> {
    ApiResponse::error(
        "not_implemented",
        format!("{} /api/{} is not implemented", method, path),
    )
}
