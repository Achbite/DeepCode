use crate::prelude::*;
use crate::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillMountScanRequest {
    pub(crate) path: String,
}

pub(crate) async fn skill_mount_scan(
    State(state): State<AppState>,
    Json(body): Json<SkillMountScanRequest>,
) -> Json<ApiResponse> {
    match state
        .host_services
        .skill_admin
        .scan_mount(FsPath::new(body.path.trim()))
    {
        Ok(result) => ApiResponse::ok(
            serde_json::to_value(result).expect("typed skill mount result must serialize"),
        ),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}
