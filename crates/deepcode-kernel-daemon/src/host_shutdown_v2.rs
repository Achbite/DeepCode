use crate::api_response::ApiResponse;
use crate::prelude::*;
use crate::AppState;
use deepcode_kernel_abi::{is_valid_host_instance_id_v2, HOST_INSTANCE_ID_ENV_V2};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static HOST_SHUTDOWN_REQUESTED_V2: AtomicBool = AtomicBool::new(false);
static HOST_PROCESS_IDENTITY_V2: OnceLock<HostProcessIdentityV2> = OnceLock::new();

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostProcessIdentityV2 {
    service: &'static str,
    instance_id: String,
    pid: u32,
    address: String,
}

impl HostProcessIdentityV2 {
    fn daemon_from_environment(address: SocketAddr) -> Result<Self, &'static str> {
        let instance_id = std::env::var(HOST_INSTANCE_ID_ENV_V2)
            .map_err(|_| "Host instance identity is not configured")?;
        if !is_valid_host_instance_id_v2(&instance_id) {
            return Err("Host instance identity must use the v2 format with 256 bits of entropy");
        }
        Ok(Self {
            service: "deepcode-kernel-daemon",
            instance_id,
            pid: std::process::id(),
            address: format!("http://{address}"),
        })
    }
}

pub(crate) fn configure_host_process_identity_v2(address: SocketAddr) -> Result<(), &'static str> {
    let identity = HostProcessIdentityV2::daemon_from_environment(address)?;
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

pub(crate) async fn host_shutdown_v2(State(state): State<AppState>) -> Json<ApiResponse> {
    let bridge_cleanup_ok = state.kernel_session_v2.shutdown_all_owned_bridges().is_ok();
    let terminal_cleanup_ok = state
        .terminal_runtime
        .lock()
        .map(|mut terminal| {
            terminal.shutdown_all();
            true
        })
        .unwrap_or(false);
    let cleanup_complete = bridge_cleanup_ok && terminal_cleanup_ok;
    HOST_SHUTDOWN_REQUESTED_V2.store(true, Ordering::SeqCst);
    ApiResponse::ok(json!({
        "accepted": true,
        "owner": "hostShell",
        "identity": host_process_identity_v2(),
        "cleanupComplete": cleanup_complete
    }))
}

pub(crate) async fn wait_for_host_shutdown_v2() {
    while !HOST_SHUTDOWN_REQUESTED_V2.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
