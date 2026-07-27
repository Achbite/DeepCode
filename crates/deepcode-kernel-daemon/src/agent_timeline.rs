use crate::prelude::*;
use crate::*;

pub(crate) async fn agent_session_timeline(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
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
