use crate::prelude::*;
use crate::*;
use deepcode_kernel_skills::scan_skill_mount;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillMountScanRequest {
    pub(crate) path: String,
}

pub(crate) async fn skill_mount_scan(Json(body): Json<SkillMountScanRequest>) -> Json<ApiResponse> {
    match scan_skill_mount(FsPath::new(body.path.trim())) {
        Ok(result) => ApiResponse::ok(
            serde_json::to_value(result).expect("typed skill mount result must serialize"),
        ),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}
