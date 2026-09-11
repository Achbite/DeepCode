use crate::api_response::ApiResponse;
use crate::prelude::*;
use crate::AppState;
use deepcode_kernel_abi::{
    is_valid_host_instance_id, HostProcessIdentity, HostShutdownReceipt, HostShutdownRequest,
    HOST_INSTANCE_ID_ENV, HOST_SHUTDOWN_IDENTITY_CONFLICT, HOST_SHUTDOWN_OWNER,
    KERNEL_DAEMON_SERVICE,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static HOST_SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);
static HOST_PROCESS_IDENTITY: OnceLock<HostProcessIdentity> = OnceLock::new();

fn daemon_identity_from_environment(
    address: SocketAddr,
) -> Result<HostProcessIdentity, &'static str> {
    let instance_id = std::env::var(HOST_INSTANCE_ID_ENV)
        .map_err(|_| "Host instance identity is not configured")?;
    if !is_valid_host_instance_id(&instance_id) {
        return Err("Host instance identity must contain 256 bits of entropy");
    }
    Ok(HostProcessIdentity {
        service: KERNEL_DAEMON_SERVICE.to_string(),
        instance_id,
        pid: std::process::id(),
        address: format!("http://{address}"),
    })
}

pub(crate) fn configure_host_process_identity(address: SocketAddr) -> Result<(), &'static str> {
    let identity = daemon_identity_from_environment(address)?;
    HOST_PROCESS_IDENTITY
        .set(identity)
        .map_err(|_| "Host process identity is already configured")
}

pub(crate) fn host_process_identity() -> &'static HostProcessIdentity {
    HOST_PROCESS_IDENTITY
        .get()
        .expect("Host process identity must be configured before serving")
}

pub(crate) async fn host_identity() -> Json<ApiResponse> {
    ApiResponse::ok(
        serde_json::to_value(host_process_identity())
            .expect("Host process identity must serialize"),
    )
}

pub(crate) async fn host_shutdown(
    State(state): State<AppState>,
    Json(request): Json<HostShutdownRequest>,
) -> Response {
    let identity = host_process_identity();
    if request.expected_identity != *identity {
        return (
            StatusCode::CONFLICT,
            ApiResponse::error(
                HOST_SHUTDOWN_IDENTITY_CONFLICT,
                "Host shutdown token does not match the running process identity",
            ),
        )
            .into_response();
    }
    let cleanup_complete = shutdown_owned_host_resources(&state).await;
    request_host_shutdown();
    let receipt = HostShutdownReceipt {
        accepted: true,
        owner: HOST_SHUTDOWN_OWNER.to_string(),
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

pub(crate) async fn shutdown_owned_host_resources(state: &AppState) -> bool {
    let terminal_cleanup_ok = state
        .terminal_runtime
        .lock()
        .map(|mut terminal| {
            terminal.shutdown_all();
            true
        })
        .unwrap_or(false);
    let session_service = state.session_service.clone();
    let session_cleanup_ok = tokio::task::spawn_blocking(move || session_service.shutdown())
        .await
        .is_ok_and(|result| result.is_ok());
    let local_agent = state.local_agent.clone();
    let plugin_cleanup_ok = tokio::task::spawn_blocking(move || local_agent.shutdown_plugins())
        .await
        .is_ok_and(|result| result.is_ok());
    session_cleanup_ok && plugin_cleanup_ok && terminal_cleanup_ok
}

pub(crate) fn request_host_shutdown() {
    HOST_SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
}

pub(crate) async fn wait_for_host_shutdown() {
    while !HOST_SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
