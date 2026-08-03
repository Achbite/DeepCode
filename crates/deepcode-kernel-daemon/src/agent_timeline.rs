use crate::prelude::*;
use crate::*;
use deepcode_kernel_abi::RunCapabilityV2;

pub(crate) async fn agent_session_timeline(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Json<ApiResponse> {
    if !state.host_shell_authority.authorize(&headers) {
        let run_id =
            match headers
                .get("x-deepcode-run-id")
                .and_then(|value| value.to_str().ok())
            {
                Some(run_id) if !run_id.is_empty() => run_id,
                _ => return ApiResponse::error(
                    "host_run_transport_capability_required",
                    "Session timeline requires Host authority or an active Run transport binding",
                ),
            };
        let capability =
            match headers
                .get(crate::kernel_v2_transport::RUN_TRANSPORT_CAPABILITY_HEADER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| RunCapabilityV2::new(value.to_string()).ok())
            {
                Some(capability) => capability,
                None => return ApiResponse::error(
                    "host_run_transport_capability_required",
                    "Session timeline requires Host authority or an active Run transport binding",
                ),
            };
        if let Err(error) = state
            .host_services
            .active_runs_v2
            .authorize_session_run_transport(&session_id, run_id, &capability)
        {
            return ApiResponse::error(error.code, error.message);
        }
    }
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    let _io_guard = session_private_io_lock(&session_id).read_owned().await;
    {
        let gui = state.gui.lock().expect("gui state lock");
        if let Err(response) = verified_selectable_session(&gui, &session_id) {
            return response;
        }
    }
    match state
        .host_services
        .projection_v2
        .latest_timeline(&session_id)
    {
        Ok(Some(timeline)) => ApiResponse::ok(timeline),
        Ok(None) => ApiResponse::error(
            "agent_timeline_unavailable",
            "Session v2 public timeline is not available",
        ),
        Err(error) => ApiResponse::error(
            error.code,
            format!(
                "Session v2 public timeline is unavailable: {}",
                error.message
            ),
        ),
    }
}
