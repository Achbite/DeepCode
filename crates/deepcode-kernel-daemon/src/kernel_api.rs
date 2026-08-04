use crate::prelude::*;
use crate::*;

pub(crate) async fn health(State(state): State<AppState>) -> Json<ApiResponse> {
    let startup_readiness = state.startup_readiness_v2.status();
    let ready = startup_readiness.ready;
    let (status, kernel) = match startup_readiness.phase {
        crate::startup_readiness_v2::HostStartupReadinessPhaseV2::Ready => ("ok", "ready"),
        crate::startup_readiness_v2::HostStartupReadinessPhaseV2::Recovering => {
            ("recovering", "recovering")
        }
        crate::startup_readiness_v2::HostStartupReadinessPhaseV2::Failed => {
            ("failed", "unavailable")
        }
    };
    let workspace = current_workspace(&state.host_services.workspace)
        .ok()
        .and_then(|workspace| serde_json::to_value(workspace).ok())
        .unwrap_or(Value::Null);
    let build_info = packaged_build_info().unwrap_or(Value::Null);
    ApiResponse::ok(json!({
        "service": "deepcode-kernel-daemon",
        "ok": ready,
        "status": status,
        "kernel": kernel,
        "buildCommit": build_commit(),
        "buildInfo": build_info,
        "kernelAbiVersion": deepcode_kernel_abi::KERNEL_ABI_V2_VERSION,
        "protocolVersion": deepcode_kernel_abi::KERNEL_ABI_V2_VERSION,
        "workspace": workspace,
        "hostWorkspaceRegistry": format!("{:?}", state.host_services.workspace.readiness()).to_ascii_lowercase(),
        "hostActiveRunBrokerV2": state.host_services.active_runs_v2.status(),
        "hostKernelStartupRecoveryV2": state.kernel_session_v2.startup_recovery_status(),
        "hostStartupReadinessV2": startup_readiness,
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
