use crate::prelude::*;
use crate::*;

pub(crate) async fn agent_session_timeline(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    match session_timeline(&state, &session_id) {
        Some(timeline) => ApiResponse::ok(timeline),
        None => ApiResponse::error(
            "agent_timeline_unavailable",
            "canonical session timeline is not available",
        ),
    }
}
