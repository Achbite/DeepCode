use crate::prelude::*;
use crate::*;

pub(crate) async fn agent_session_timeline(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    match state
        .host_services
        .projection_v2
        .latest_timeline(&session_id)
    {
        Ok(Some(timeline)) => return ApiResponse::ok(timeline),
        Ok(None) => {}
        Err(error) => {
            return ApiResponse::error(
                error.code,
                format!(
                    "Session v2 public timeline is unavailable: {}",
                    error.message
                ),
            )
        }
    }
    match session_timeline_with_staleness(&state, &session_id) {
        Some((timeline, false)) => ApiResponse::ok(timeline),
        Some((timeline, true)) => ApiResponse::error_with_data(
            "agent_timeline_stale",
            "canonical session timeline does not match the durable AgentEvent version",
            timeline,
        ),
        None => ApiResponse::error(
            "agent_timeline_unavailable",
            "canonical session timeline is not available",
        ),
    }
}
