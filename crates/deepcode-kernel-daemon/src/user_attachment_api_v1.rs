use crate::prelude::*;
use crate::*;
use deepcode_kernel_abi::AgentInputAttachmentScopeV3;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateUserAttachmentGrantRequestV1 {
    pub(crate) absolute_path: String,
    pub(crate) scope: AgentInputAttachmentScopeV3,
    pub(crate) caller_request_id: String,
}

pub(crate) async fn user_attachment_grant_create_v1(
    State(state): State<AppState>,
    Json(body): Json<CreateUserAttachmentGrantRequestV1>,
) -> Json<ApiResponse> {
    let store = state.host_services.user_attachments_v1.clone();
    let result = tokio::task::spawn_blocking(move || {
        store.create_grant(&body.absolute_path, body.scope, &body.caller_request_id)
    })
    .await;
    match result {
        Err(_) => ApiResponse::error(
            "user_attachment_worker_failed",
            "User attachment snapshot worker ended unexpectedly",
        ),
        Ok(Err(error)) => ApiResponse::error(error.code, error.message),
        Ok(Ok(grant)) => ApiResponse::ok(json!({
            "schemaVersion": "deepcode.host.user-attachment-grant.v1",
            "attachment": grant.attachment,
            "snapshot": grant.snapshot,
        })),
    }
}

pub(crate) async fn user_attachment_grant_revoke_v1(
    State(state): State<AppState>,
    Path(attachment_id): Path<String>,
) -> Json<ApiResponse> {
    let store = state.host_services.user_attachments_v1.clone();
    let result = tokio::task::spawn_blocking(move || store.revoke(&attachment_id)).await;
    match result {
        Err(_) => ApiResponse::error(
            "user_attachment_worker_failed",
            "User attachment revocation worker ended unexpectedly",
        ),
        Ok(Err(error)) => ApiResponse::error(error.code, error.message),
        Ok(Ok(grant)) => ApiResponse::ok(json!({
            "schemaVersion": "deepcode.host.user-attachment-revocation.v1",
            "attachmentId": grant.attachment.attachment_id,
            "resourceId": grant.attachment.resource_id,
            "revokedAt": grant.revoked_at,
        })),
    }
}
