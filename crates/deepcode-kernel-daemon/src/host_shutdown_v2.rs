use crate::api_response::ApiResponse;
use crate::prelude::*;
use crate::AppState;
use deepcode_kernel_abi::{
    is_valid_host_instance_id_v2, HostProcessIdentityV2, HostShutdownReceiptV2,
    HostShutdownRequestV2, HOST_INSTANCE_ID_ENV_V2, HOST_KERNEL_DAEMON_SERVICE_V2,
    HOST_SHUTDOWN_IDENTITY_CONFLICT_V2, HOST_SHUTDOWN_OWNER_HOST_SHELL_V2,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static HOST_SHUTDOWN_REQUESTED_V2: AtomicBool = AtomicBool::new(false);
static HOST_PROCESS_IDENTITY_V2: OnceLock<HostProcessIdentityV2> = OnceLock::new();

fn daemon_identity_from_environment(
    address: SocketAddr,
) -> Result<HostProcessIdentityV2, &'static str> {
    let instance_id = std::env::var(HOST_INSTANCE_ID_ENV_V2)
        .map_err(|_| "Host instance identity is not configured")?;
    if !is_valid_host_instance_id_v2(&instance_id) {
        return Err("Host instance identity must use the v2 format with 256 bits of entropy");
    }
    Ok(HostProcessIdentityV2 {
        service: HOST_KERNEL_DAEMON_SERVICE_V2.to_string(),
        instance_id,
        pid: std::process::id(),
        address: format!("http://{address}"),
    })
}

pub(crate) fn configure_host_process_identity_v2(address: SocketAddr) -> Result<(), &'static str> {
    let identity = daemon_identity_from_environment(address)?;
    HOST_PROCESS_IDENTITY_V2
        .set(identity)
        .map_err(|_| "Host process identity is already configured")
}

fn host_process_identity_v2() -> &'static HostProcessIdentityV2 {
    HOST_PROCESS_IDENTITY_V2
        .get()
        .expect("Host process identity must be configured before serving")
}

pub(crate) async fn host_identity_v2() -> Json<ApiResponse> {
    ApiResponse::ok(
        serde_json::to_value(host_process_identity_v2())
            .expect("Host process identity must serialize"),
    )
}

pub(crate) async fn host_shutdown_v2(
    State(state): State<AppState>,
    Json(request): Json<HostShutdownRequestV2>,
) -> Response {
    let identity = host_process_identity_v2();
    if request.expected_identity != *identity {
        return (
            StatusCode::CONFLICT,
            ApiResponse::error(
                HOST_SHUTDOWN_IDENTITY_CONFLICT_V2,
                "Host shutdown authority does not match the running process identity",
            ),
        )
            .into_response();
    }
    let cleanup_complete = shutdown_owned_host_resources_v2(&state).await;
    request_host_shutdown_v2();
    let receipt = HostShutdownReceiptV2 {
        accepted: true,
        owner: HOST_SHUTDOWN_OWNER_HOST_SHELL_V2.to_string(),
        identity: identity.clone(),
        cleanup_complete,
    };
    (
        StatusCode::OK,
        ApiResponse::ok(
            serde_json::to_value(receipt).expect("Host shutdown receipt must serialize"),
        ),
    )
        .into_response()
}

pub(crate) async fn shutdown_owned_host_resources_v2(state: &AppState) -> bool {
    let wake_cleanup_ok = state.kernel_wake_v2.shutdown().await.is_ok();
    let bridge_cleanup_ok = state.kernel_session_v2.shutdown_all_owned_bridges().is_ok();
    let terminal_cleanup_ok = state
        .terminal_runtime
        .lock()
        .map(|mut terminal| {
            terminal.shutdown_all();
            true
        })
        .unwrap_or(false);
    wake_cleanup_ok && bridge_cleanup_ok && terminal_cleanup_ok
}

pub(crate) fn request_host_shutdown_v2() {
    HOST_SHUTDOWN_REQUESTED_V2.store(true, Ordering::SeqCst);
}

pub(crate) fn host_shutdown_requested_v2() -> bool {
    HOST_SHUTDOWN_REQUESTED_V2.load(Ordering::SeqCst)
}

pub(crate) async fn wait_for_host_shutdown_v2() {
    while !HOST_SHUTDOWN_REQUESTED_V2.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
