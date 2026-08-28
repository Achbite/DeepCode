use crate::prelude::*;
use crate::*;

pub(crate) async fn health(State(state): State<AppState>) -> Json<ApiResponse> {
    let workspace = current_workspace(&state.host_services.workspace)
        .ok()
        .and_then(|workspace| serde_json::to_value(workspace).ok())
        .unwrap_or(Value::Null);
    let build_info = packaged_build_info().unwrap_or(Value::Null);
    let session_ready = state.session_service.is_ready();
    ApiResponse::ok(json!({
        "service": "deepcode-kernel-daemon",
        "ok": session_ready,
        "status": if session_ready { "ok" } else { "degraded" },
        "kernel": "ready",
        "session": if session_ready { "ready" } else { "unavailable" },
        "buildCommit": build_commit(),
        "buildInfo": build_info,
        "protocolVersion": "deepcode.local-agent",
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
