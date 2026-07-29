use crate::prelude::*;
use crate::*;

pub(crate) async fn agent_session_timeline(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
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
