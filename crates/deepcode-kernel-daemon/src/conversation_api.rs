use crate::conversation_catalog::{
    automatic_conversation_title, canonical_folder_path, clean_title, workspace_display_name,
    ConversationCatalog, ConversationProjectRecord, ConversationSessionRecord,
    ConversationWorkspaceRecord, WorkspaceBindingDisplayRecord,
};
use crate::host_inspection::HostInspectionExecutor;
use crate::prelude::*;
use crate::{ApiResponse, AppState, SessionServiceError, SessionServiceProcess};
use deepcode_kernel_abi::{HostInspectionOutput, HostInspectionQuery};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path as StdPath;

const MAX_MESSAGE_FILESYSTEM_REFERENCES: usize = 8;
const MAX_REFERENCE_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateConversationSessionRequest {
    session_id: Option<String>,
    workspace_paths: Option<Vec<String>>,
    project_id: Option<String>,
    profile_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateConversationProjectRequest {
    title: String,
    #[serde(default)]
    workspace_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateConversationProjectRequest {
    title: Option<String>,
    workspace_paths: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateConversationSessionRequest {
    title: Option<String>,
    /// Missing keeps the current classification; JSON null moves to the independent list.
    project_id: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadConversationResourceRequest {
    workspace_id: String,
    logical_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AttachConversationDirectoryIndexRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResolveConversationFilesystemReferencesRequest {
    references: Vec<FilesystemReferencePathInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FilesystemReferencePathInput {
    path: String,
    kind: String,
}

pub(crate) async fn conversation_read(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(mut body): Json<Value>,
) -> Json<ApiResponse> {
    let Some(query) = body.as_object_mut() else {
        return ApiResponse::error("conversation_read_invalid", "读取选项必须是对象。");
    };
    if query.contains_key("sessionId") {
        return ApiResponse::error("conversation_read_invalid", "sessionId 使用请求路径。");
    }
    query.insert("sessionId".into(), Value::String(session_id));
    match request_service(state.session_service.clone(), "read", body).await {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => session_service_error(error),
    }
}

pub(crate) async fn conversation_catalog_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.conversation_catalog_error.as_deref() {
        return ApiResponse::error("conversation_catalog_unavailable", error);
    }
    ApiResponse::ok(gui.conversation_catalog.public_value())
}

pub(crate) async fn conversation_plugin_catalog_get(
    State(state): State<AppState>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    match crate::local_agent_plugins::plugin_catalog_projection(&gui.user_settings) {
        Ok(catalog) => ApiResponse::ok(catalog),
        Err(error) => ApiResponse::error("plugin_catalog_unavailable", error),
    }
}

pub(crate) async fn conversation_resource_read(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<ReadConversationResourceRequest>,
) -> Json<ApiResponse> {
    if !valid_id(&session_id) || !valid_id(&body.workspace_id) {
        return ApiResponse::error("conversation_resource_identity_invalid", "资源身份无效。");
    }
    let projection = match request_service(
        state.session_service.clone(),
        "snapshot",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    if !projection_references_workspace(&projection, &body.workspace_id) {
        return ApiResponse::error(
            "conversation_resource_workspace_not_bound",
            "资源不属于当前 Session 的有效目录集合。",
        );
    }
    let root = {
        let gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        if gui.conversation_catalog.session(&session_id).is_none() {
            return ApiResponse::error("conversation_session_not_found", "对话不存在。");
        }
        let Some(workspace) = gui.conversation_catalog.workspace(&body.workspace_id) else {
            return ApiResponse::error("conversation_workspace_not_found", "工作目录不存在。");
        };
        workspace.canonical_root.clone()
    };

    match HostInspectionExecutor.execute(
        HostInspectionQuery::Read {
            folder_id: Some(body.workspace_id.clone()),
            path: body.logical_path.clone(),
        },
        Some(StdPath::new(&root)),
    ) {
        Ok(HostInspectionOutput::Read(read)) => ApiResponse::ok(json!({
            "workspaceId": body.workspace_id,
            "logicalPath": read.path,
            "content": read.content,
            "sizeBytes": read.size_bytes,
            "startLine": read.start_line,
            "endLine": read.end_line,
        })),
        Ok(_) => ApiResponse::error(
            "conversation_resource_kind_invalid",
            "资源读取返回了非文件结果。",
        ),
        Err(error) => ApiResponse::error(error.code, "无法读取所选工作区资源。"),
    }
}

pub(crate) async fn conversation_filesystem_references_resolve(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<ResolveConversationFilesystemReferencesRequest>,
) -> Json<ApiResponse> {
    if !valid_id(&session_id) {
        return ApiResponse::error("conversation_session_identity_invalid", "对话身份无效。");
    }
    if body.references.is_empty() || body.references.len() > MAX_MESSAGE_FILESYSTEM_REFERENCES {
        return ApiResponse::error(
            "conversation_filesystem_references_invalid",
            "单次消息必须附加一至八个文件系统引用。",
        );
    }
    let references = {
        let mut gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        if gui.conversation_catalog.session(&session_id).is_none() {
            return ApiResponse::error("conversation_session_not_found", "对话不存在。");
        }
        let previous = gui.conversation_catalog.clone();
        let attachment_store_root = gui.paths.attachment_store_root.clone();
        let mut created_snapshot_roots = Vec::new();
        let references = match resolve_filesystem_references(
            &mut gui.conversation_catalog,
            &attachment_store_root,
            &session_id,
            &body.references,
            &crate::now_text(),
            &mut created_snapshot_roots,
        ) {
            Ok(value) => value,
            Err((code, message)) => {
                gui.conversation_catalog = previous;
                cleanup_created_snapshot_roots(&created_snapshot_roots);
                return ApiResponse::error(code, message);
            }
        };
        if let Err(error) = persist_catalog_or_rollback(&mut gui, previous) {
            cleanup_created_snapshot_roots(&created_snapshot_roots);
            return ApiResponse::error("conversation_catalog_write_failed", error);
        }
        references
    };
    ApiResponse::ok(json!(references))
}

pub(crate) async fn conversation_directory_index_attach(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<AttachConversationDirectoryIndexRequest>,
) -> Json<ApiResponse> {
    if !valid_id(&session_id) {
        return ApiResponse::error("conversation_session_identity_invalid", "对话身份无效。");
    }
    let canonical_root = match canonical_folder_path(&body.path) {
        Ok(value) => value,
        Err(error) => return ApiResponse::error("conversation_directory_index_invalid", error),
    };
    let binding = {
        let mut gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        if gui.conversation_catalog.session(&session_id).is_none() {
            return ApiResponse::error("conversation_session_not_found", "对话不存在。");
        }
        let previous = gui.conversation_catalog.clone();
        let workspace_ids = match register_roots(
            &mut gui.conversation_catalog,
            vec![canonical_root],
            &crate::now_text(),
        ) {
            Ok(value) => value,
            Err(error) => return session_service_error(error),
        };
        let binding = binding_snapshot(&gui.conversation_catalog, &workspace_ids)
            .into_iter()
            .next()
            .expect("registered workspace has display binding");
        if let Err(error) = persist_catalog_or_rollback(&mut gui, previous) {
            return ApiResponse::error("conversation_catalog_write_failed", error);
        }
        binding
    };
    let before = match request_service(
        state.session_service.clone(),
        "snapshot",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    if before
        .get("workspaceBindings")
        .and_then(Value::as_array)
        .is_some_and(|bindings| {
            bindings.iter().any(|candidate| {
                candidate.get("workspaceId").and_then(Value::as_str)
                    == Some(binding.workspace_id.as_str())
            })
        })
    {
        return ApiResponse::ok(before);
    }
    let command_id = match random_id("command") {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    let reply = match request_service(
        state.session_service.clone(),
        "submit",
        json!({
            "command": {
                "schemaVersion": "deepcode.command.v3",
                "type": "session.directory-index.attach",
                "commandId": command_id,
                "sessionId": session_id,
                "workspaceBinding": {
                    "workspaceId": binding.workspace_id,
                    "displayName": binding.display_name,
                },
            }
        }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    if reply.get("status").and_then(Value::as_str) == Some("rejected") {
        return ApiResponse::error(
            reply
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("session_directory_index_rejected"),
            reply
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("目录索引未被 Session 接受。"),
        );
    }
    match request_service(
        state.session_service,
        "snapshot",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => session_service_error(error),
    }
}

pub(crate) async fn conversation_directory_index_detach(
    State(state): State<AppState>,
    Path((session_id, workspace_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    if !valid_id(&session_id) || !valid_id(&workspace_id) {
        return ApiResponse::error(
            "conversation_directory_index_identity_invalid",
            "目录索引身份无效。",
        );
    }
    let before = match request_service(
        state.session_service.clone(),
        "snapshot",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    if !before
        .get("sessionDirectoryIndexes")
        .and_then(Value::as_array)
        .is_some_and(|bindings| {
            bindings.iter().any(|binding| {
                binding.get("workspaceId").and_then(Value::as_str) == Some(&workspace_id)
            })
        })
    {
        return ApiResponse::error(
            "session_directory_index_not_attached",
            "该目录不是当前 Session 可移除的对话目录索引。",
        );
    }
    let command_id = match random_id("command") {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    let reply = match request_service(
        state.session_service.clone(),
        "submit",
        json!({
            "command": {
                "schemaVersion": "deepcode.command.v3",
                "type": "session.directory-index.detach",
                "commandId": command_id,
                "sessionId": session_id,
                "workspaceId": workspace_id,
            }
        }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    if reply.get("status").and_then(Value::as_str) == Some("rejected") {
        return ApiResponse::error(
            reply
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("session_directory_index_rejected"),
            reply
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("目录索引未被 Session 接受。"),
        );
    }
    match request_service(
        state.session_service,
        "snapshot",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => session_service_error(error),
    }
}

/// This is the only catalog surface allowed to reveal canonical roots. It is
/// consumed by an explicit folder picker/project-management dialog, never by
/// an ordinary conversation projection.
pub(crate) async fn conversation_catalog_management_get(
    State(state): State<AppState>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.conversation_catalog_error.as_deref() {
        return ApiResponse::error("conversation_catalog_unavailable", error);
    }
    ApiResponse::ok(gui.conversation_catalog.management_value())
}

pub(crate) async fn conversation_project_create(
    State(state): State<AppState>,
    Json(body): Json<CreateConversationProjectRequest>,
) -> Json<ApiResponse> {
    let title = match clean_title(&body.title) {
        Ok(value) => value,
        Err(error) => return ApiResponse::error("conversation_project_title_invalid", error),
    };
    let roots = match canonical_roots(&body.workspace_paths) {
        Ok(value) => value,
        Err(error) => return ApiResponse::error("conversation_project_workspace_invalid", error),
    };
    let id = match random_id("project") {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    let now = crate::now_text();
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.conversation_catalog_error.as_deref() {
        return ApiResponse::error("conversation_catalog_unavailable", error);
    }
    let previous = gui.conversation_catalog.clone();
    let workspace_ids = match register_roots(&mut gui.conversation_catalog, roots, &now) {
        Ok(value) => value,
        Err(error) => {
            gui.conversation_catalog = previous;
            return session_service_error(error);
        }
    };
    gui.conversation_catalog
        .insert_project(ConversationProjectRecord {
            id,
            title,
            workspace_ids,
            created_at: now.clone(),
            updated_at: now,
        });
    if let Err(error) = persist_catalog_or_rollback(&mut gui, previous) {
        return ApiResponse::error("conversation_catalog_write_failed", error);
    }
    ApiResponse::ok(gui.conversation_catalog.public_value())
}

pub(crate) async fn conversation_project_update(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(body): Json<UpdateConversationProjectRequest>,
) -> Json<ApiResponse> {
    if body.title.is_none() && body.workspace_paths.is_none() {
        return ApiResponse::error(
            "conversation_project_update_empty",
            "项目更新至少需要 title 或 workspacePaths。",
        );
    }
    let title = match body.title.as_deref() {
        Some(value) => match clean_title(value) {
            Ok(value) => Some(value),
            Err(error) => return ApiResponse::error("conversation_project_title_invalid", error),
        },
        None => None,
    };
    let roots = match body.workspace_paths.as_deref() {
        Some(paths) => match canonical_roots(paths) {
            Ok(value) => Some(value),
            Err(error) => {
                return ApiResponse::error("conversation_project_workspace_invalid", error)
            }
        },
        None => None,
    };
    let now = crate::now_text();
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.conversation_catalog_error.as_deref() {
        return ApiResponse::error("conversation_catalog_unavailable", error);
    }
    if gui.conversation_catalog.project(&project_id).is_none() {
        return ApiResponse::error("conversation_project_not_found", "项目不存在。");
    }
    let previous = gui.conversation_catalog.clone();
    if let Some(title) = title {
        gui.conversation_catalog
            .rename_project(&project_id, &title, &now);
    }
    if let Some(roots) = roots {
        let workspace_ids = match register_roots(&mut gui.conversation_catalog, roots, &now) {
            Ok(value) => value,
            Err(error) => {
                gui.conversation_catalog = previous;
                return session_service_error(error);
            }
        };
        if let Err(code) =
            gui.conversation_catalog
                .replace_project_bindings(&project_id, workspace_ids, &now)
        {
            gui.conversation_catalog = previous;
            return ApiResponse::error(code, "项目或工作目录不存在。");
        }
    }
    if let Err(error) = persist_catalog_or_rollback(&mut gui, previous) {
        return ApiResponse::error("conversation_catalog_write_failed", error);
    }
    ApiResponse::ok(gui.conversation_catalog.public_value())
}

pub(crate) async fn conversation_project_delete(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Json<ApiResponse> {
    let now = crate::now_text();
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.conversation_catalog_error.as_deref() {
        return ApiResponse::error("conversation_catalog_unavailable", error);
    }
    let previous = gui.conversation_catalog.clone();
    if !gui.conversation_catalog.delete_project(&project_id, &now) {
        return ApiResponse::error("conversation_project_not_found", "项目不存在。");
    }
    if let Err(error) = persist_catalog_or_rollback(&mut gui, previous) {
        return ApiResponse::error("conversation_catalog_write_failed", error);
    }
    ApiResponse::ok(gui.conversation_catalog.public_value())
}

pub(crate) async fn conversation_session_create(
    State(state): State<AppState>,
    Json(body): Json<CreateConversationSessionRequest>,
) -> Json<ApiResponse> {
    let session_id = match body.session_id {
        Some(value) if valid_id(&value) => value,
        Some(_) => {
            return ApiResponse::error(
                "session_identity_invalid",
                "sessionId 不是有效本地会话标识。",
            )
        }
        None => match random_id("session") {
            Ok(value) => value,
            Err(error) => return session_service_error(error),
        },
    };
    if body.project_id.is_some() && body.workspace_paths.is_some() {
        return ApiResponse::error(
            "conversation_binding_source_conflict",
            "项目会话使用项目 binding 模板，不能同时提交 workspacePaths。",
        );
    }

    let now = crate::now_text();
    let (profile_id, bindings) = {
        let mut gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        if gui.conversation_catalog.session(&session_id).is_some() {
            return ApiResponse::error("conversation_session_exists", "对话已经存在。");
        }
        let profile_id = match selected_profile_id(&gui, body.profile_id.as_deref()) {
            Ok(value) => value,
            Err((code, message)) => return ApiResponse::error(code, message),
        };
        let previous = gui.conversation_catalog.clone();
        let bindings = if let Some(project_id) = body.project_id.as_deref() {
            match gui
                .conversation_catalog
                .project_binding_snapshot(project_id)
            {
                Ok(value) => value,
                Err(code) => return ApiResponse::error(code, "项目不存在。"),
            }
        } else {
            let roots = match canonical_roots(body.workspace_paths.as_deref().unwrap_or(&[])) {
                Ok(value) => value,
                Err(error) => return ApiResponse::error("conversation_workspace_invalid", error),
            };
            let workspace_ids = match register_roots(&mut gui.conversation_catalog, roots, &now) {
                Ok(value) => value,
                Err(error) => {
                    gui.conversation_catalog = previous;
                    return session_service_error(error);
                }
            };
            let bindings = binding_snapshot(&gui.conversation_catalog, &workspace_ids);
            if let Err(error) = persist_catalog_or_rollback(&mut gui, previous) {
                return ApiResponse::error("conversation_catalog_write_failed", error);
            }
            bindings
        };
        (profile_id, bindings)
    };

    let projection = match request_service(
        state.session_service.clone(),
        "createSession",
        json!({
            "sessionId": session_id,
            "displayTitle": "新对话",
            "workspaceBindings": bindings,
            "profileId": profile_id,
        }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };

    let persist_result: Result<(), (&'static str, String)> = {
        let mut gui = state.gui.lock().expect("gui state lock");
        if gui.conversation_catalog.session(&session_id).is_some() {
            Err((
                "conversation_session_exists",
                "同一 sessionId 在创建期间被占用。".to_string(),
            ))
        } else if body
            .project_id
            .as_deref()
            .is_some_and(|project_id| gui.conversation_catalog.project(project_id).is_none())
        {
            Err((
                "conversation_project_changed_during_creation",
                "项目在 Session 创建期间已被删除。".to_string(),
            ))
        } else {
            let previous = gui.conversation_catalog.clone();
            gui.conversation_catalog
                .insert_session(ConversationSessionRecord {
                    id: session_id.clone(),
                    title: "新对话".to_string(),
                    workspace_bindings: bindings.clone(),
                    project_id: body.project_id.clone(),
                    profile_id: Some(profile_id.clone()),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                });
            persist_catalog_or_rollback(&mut gui, previous)
                .map_err(|error| ("conversation_catalog_write_failed", error))
        }
    };
    if let Err((code, error)) = persist_result {
        let _ = request_service(
            state.session_service.clone(),
            "deleteSession",
            json!({ "sessionId": session_id }),
        )
        .await;
        return ApiResponse::error(code, error);
    }
    ApiResponse::ok(projection)
}

pub(crate) async fn conversation_session_update(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<UpdateConversationSessionRequest>,
) -> Json<ApiResponse> {
    if body.title.is_none() && body.project_id.is_none() {
        return ApiResponse::error(
            "conversation_session_update_empty",
            "会话更新至少需要 title 或 projectId。",
        );
    }
    let title = match body.title.as_deref() {
        Some(value) => match clean_title(value) {
            Ok(value) => Some(value),
            Err(error) => return ApiResponse::error("conversation_session_title_invalid", error),
        },
        None => None,
    };
    let now = crate::now_text();
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.conversation_catalog_error.as_deref() {
        return ApiResponse::error("conversation_catalog_unavailable", error);
    }
    if gui.conversation_catalog.session(&session_id).is_none() {
        return ApiResponse::error("conversation_session_not_found", "对话不存在。");
    }
    let previous = gui.conversation_catalog.clone();
    if let Some(title) = title {
        gui.conversation_catalog
            .rename_session(&session_id, &title, &now);
    }
    if let Some(project_id) = body.project_id.as_ref() {
        if let Err(code) =
            gui.conversation_catalog
                .move_session(&session_id, project_id.as_deref(), &now)
        {
            gui.conversation_catalog = previous;
            return ApiResponse::error(
                code,
                if code == "conversation_project_not_found" {
                    "项目不存在。"
                } else {
                    "对话不存在。"
                },
            );
        }
    }
    if let Err(error) = persist_catalog_or_rollback(&mut gui, previous) {
        return ApiResponse::error("conversation_catalog_write_failed", error);
    }
    ApiResponse::ok(gui.conversation_catalog.public_value())
}

pub(crate) async fn conversation_session_delete(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    {
        let gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        let Some(_) = gui.conversation_catalog.session(&session_id) else {
            return ApiResponse::error("conversation_session_not_found", "对话不存在。");
        };
    }
    let (deleted, deleted_workspaces) = {
        let mut gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        let Some(deleted) = gui.conversation_catalog.session(&session_id).cloned() else {
            return ApiResponse::error("conversation_session_not_found", "对话不存在。");
        };
        let deleted_workspaces = gui
            .conversation_catalog
            .workspaces
            .iter()
            .filter(|workspace| workspace.owner_session_id.as_deref() == Some(session_id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if !gui.conversation_catalog.delete_session(&session_id) {
            return ApiResponse::error("conversation_session_not_found", "对话不存在。");
        }
        if let Err(error) = gui
            .conversation_catalog
            .persist(&gui.paths.catalog_store_path)
        {
            gui.conversation_catalog.insert_session(deleted);
            return ApiResponse::error("conversation_catalog_write_failed", error);
        }
        (deleted, deleted_workspaces)
    };

    if let Err(error) = request_service(
        state.session_service.clone(),
        "deleteSession",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        let mut gui = state.gui.lock().expect("gui state lock");
        if gui.conversation_catalog.session(&session_id).is_some() {
            return ApiResponse::error(
                "conversation_delete_rollback_conflict",
                format!(
                    "Session Store 删除失败（{}）；但相同 sessionId 已重新出现，未覆盖当前 Catalog。",
                    error.message
                ),
            );
        }
        gui.conversation_catalog.insert_session(deleted);
        for workspace in deleted_workspaces {
            gui.conversation_catalog.register_workspace(workspace);
        }
        if let Err(rollback_error) = gui
            .conversation_catalog
            .persist(&gui.paths.catalog_store_path)
        {
            return ApiResponse::error(
                "conversation_delete_rollback_failed",
                format!(
                    "Session Store 删除失败（{}）；Catalog 回滚也失败：{}",
                    error.message, rollback_error
                ),
            );
        }
        if error.code == "session_delete_active_run" {
            return ApiResponse::error(
                "conversation_session_active",
                "请先停止当前运行，再删除对话。",
            );
        }
        if error.code == "session_not_found" {
            return ApiResponse::error("conversation_session_not_found", "对话不存在。");
        }
        return session_service_error(error);
    }
    if let Err(error) = state.local_agent.kernel.delete_session_outputs(&session_id) {
        return ApiResponse::error(error.code, error.message);
    }
    let attachment_root = {
        let gui = state.gui.lock().expect("gui state lock");
        session_attachment_root(&gui.paths.attachment_store_root, &session_id)
    };
    if let Err(error) = fs::remove_dir_all(&attachment_root) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return ApiResponse::error(
                "conversation_attachment_cleanup_failed",
                format!(
                    "对话已删除，但 Host 文件引用目录清理失败（{}）：{error}",
                    attachment_root.display()
                ),
            );
        }
    }
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(gui.conversation_catalog.public_value())
}

pub(crate) async fn conversation_command_submit(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(command): Json<Value>,
) -> Json<ApiResponse> {
    if command.get("sessionId").and_then(Value::as_str) != Some(&session_id) {
        return ApiResponse::error("session_identity_mismatch", "命令 sessionId 与路径不一致。");
    }
    if command.get("type").and_then(Value::as_str) == Some("session.directory-index.attach") {
        let gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        if let Err((code, message)) = validate_directory_index_attach_command(
            &gui.conversation_catalog,
            &session_id,
            &command,
        ) {
            return ApiResponse::error(code, message);
        }
    }
    if matches!(
        command.get("type").and_then(Value::as_str),
        Some("message.submit" | "context.focus")
    ) {
        let gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        if let Err((code, message)) =
            validate_message_filesystem_references(&gui.conversation_catalog, &session_id, &command)
        {
            return ApiResponse::error(code, message);
        }
        if let Err((code, message)) =
            validate_required_filesystem_plugins(&gui.user_settings, &command)
        {
            return ApiResponse::error(code, message);
        }
    }
    let reply = match request_service(
        state.session_service,
        "submit",
        json!({ "command": command.clone() }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return session_service_error(error),
    };
    if reply.get("status").and_then(Value::as_str) != Some("rejected") {
        let automatic_title = command
            .get("type")
            .and_then(Value::as_str)
            .filter(|kind| matches!(*kind, "message.submit" | "context.focus"))
            .and_then(|kind| {
                command
                    .get(if kind == "message.submit" {
                        "text"
                    } else {
                        "task"
                    })
                    .and_then(Value::as_str)
            })
            .map(automatic_conversation_title);
        let active_profile_id = command
            .get("type")
            .and_then(Value::as_str)
            .filter(|kind| matches!(*kind, "message.submit" | "context.focus"))
            .and_then(|_| command.get("profileId"))
            .and_then(Value::as_str);
        let mut gui = state.gui.lock().expect("gui state lock");
        if gui.conversation_catalog_error.is_none() {
            let previous = gui.conversation_catalog.clone();
            if gui.conversation_catalog.touch_session(
                &session_id,
                automatic_title.as_deref(),
                active_profile_id,
                &crate::now_text(),
            ) {
                if let Err(error) = persist_catalog_or_rollback(&mut gui, previous) {
                    eprintln!("[conversation-catalog] {error}");
                }
            }
        }
    }
    ApiResponse::ok(reply)
}

pub(crate) async fn conversation_projection_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    match request_service(
        state.session_service,
        "snapshot",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => session_service_error(error),
    }
}

pub(crate) async fn conversation_context_composition_get(
    State(state): State<AppState>,
    Path((session_id, provider_request_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    match request_service(
        state.session_service,
        "contextComposition",
        json!({ "sessionId": session_id, "providerRequestId": provider_request_id }),
    )
    .await
    {
        Ok(value) => ApiResponse::ok(value),
        Err(error) => session_service_error(error),
    }
}

async fn request_service(
    service: SessionServiceProcess,
    operation: &'static str,
    data: Value,
) -> Result<Value, SessionServiceError> {
    tokio::task::spawn_blocking(move || service.request(operation, data))
        .await
        .map_err(|error| {
            SessionServiceError::new(
                "session_service_join_failed",
                format!("Session Service 请求任务结束异常：{error}"),
            )
        })?
}

fn session_service_error(error: SessionServiceError) -> Json<ApiResponse> {
    ApiResponse::error(error.code, error.message)
}

fn persist_catalog_or_rollback(
    gui: &mut crate::GuiState,
    previous: ConversationCatalog,
) -> Result<(), String> {
    if let Err(error) = gui
        .conversation_catalog
        .persist(&gui.paths.catalog_store_path)
    {
        gui.conversation_catalog = previous;
        return Err(error);
    }
    Ok(())
}

fn canonical_roots(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.len() > 32 {
        return Err("一个项目或 Session 最多绑定 32 个工作目录。".to_string());
    }
    let mut seen = HashSet::new();
    let mut roots = Vec::with_capacity(paths.len());
    for path in paths {
        let root = canonical_folder_path(path)?;
        if seen.insert(root.clone()) {
            roots.push(root);
        }
    }
    Ok(roots)
}

fn resolve_filesystem_references(
    catalog: &mut ConversationCatalog,
    attachment_store_root: &FsPath,
    session_id: &str,
    inputs: &[FilesystemReferencePathInput],
    now: &str,
    created_snapshot_roots: &mut Vec<PathBuf>,
) -> Result<Vec<Value>, (&'static str, String)> {
    let mut references = Vec::with_capacity(inputs.len());
    let mut seen_sources = HashSet::new();
    let mut total_file_bytes = 0u64;
    for input in inputs {
        match input.kind.as_str() {
            "directory" => {
                let canonical_root = canonical_folder_path(&input.path)
                    .map_err(|message| ("conversation_filesystem_reference_invalid", message))?;
                if !seen_sources.insert(format!("directory\0{canonical_root}")) {
                    return Err((
                        "conversation_filesystem_reference_duplicate",
                        "同一目录不能在一条消息中重复附加。".to_string(),
                    ));
                }
                let workspace_ids =
                    register_roots(catalog, vec![canonical_root], now).map_err(|error| {
                        (
                            "conversation_filesystem_reference_identity_failed",
                            format!("{}: {}", error.code, error.message),
                        )
                    })?;
                let binding = binding_snapshot(catalog, &workspace_ids)
                    .into_iter()
                    .next()
                    .ok_or((
                        "conversation_workspace_not_found",
                        "Host 未能登记目录引用。".to_string(),
                    ))?;
                let reference_id = random_id("filesystem-reference").map_err(|error| {
                    (
                        "conversation_filesystem_reference_identity_failed",
                        format!("{}: {}", error.code, error.message),
                    )
                })?;
                references.push(json!({
                    "referenceId": reference_id,
                    "workspaceId": binding.workspace_id,
                    "logicalPath": ".",
                    "displayName": binding.display_name,
                    "kind": "directory",
                }));
            }
            "file" => {
                let source = fs::canonicalize(&input.path).map_err(|error| {
                    (
                        "conversation_filesystem_reference_invalid",
                        format!("本地文件不可用：{error}"),
                    )
                })?;
                let metadata = source.metadata().map_err(|error| {
                    (
                        "conversation_filesystem_reference_invalid",
                        format!("读取本地文件元数据失败：{error}"),
                    )
                })?;
                if !metadata.is_file() {
                    return Err((
                        "conversation_filesystem_reference_invalid",
                        "文件引用必须指向普通文件。".to_string(),
                    ));
                }
                if metadata.len() > MAX_REFERENCE_FILE_BYTES {
                    return Err((
                        "conversation_filesystem_reference_too_large",
                        format!("单个文件引用不能超过 {} 字节。", MAX_REFERENCE_FILE_BYTES),
                    ));
                }
                total_file_bytes = total_file_bytes.checked_add(metadata.len()).ok_or((
                    "conversation_filesystem_reference_too_large",
                    "文件引用总大小溢出。".to_string(),
                ))?;
                if total_file_bytes > MAX_REFERENCE_TOTAL_BYTES {
                    return Err((
                        "conversation_filesystem_reference_too_large",
                        format!(
                            "单条消息的文件引用总计不能超过 {} 字节。",
                            MAX_REFERENCE_TOTAL_BYTES
                        ),
                    ));
                }
                let canonical_source = source.to_string_lossy().to_string();
                if !seen_sources.insert(format!("file\0{canonical_source}")) {
                    return Err((
                        "conversation_filesystem_reference_duplicate",
                        "同一文件不能在一条消息中重复附加。".to_string(),
                    ));
                }
                let file_name = source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .filter(|name| !name.trim().is_empty())
                    .ok_or((
                        "conversation_filesystem_reference_invalid",
                        "文件名不是有效 UTF-8。".to_string(),
                    ))?
                    .to_string();
                let reference_id = random_id("filesystem-reference").map_err(|error| {
                    (
                        "conversation_filesystem_reference_identity_failed",
                        format!("{}: {}", error.code, error.message),
                    )
                })?;
                let workspace_id = random_id("workspace").map_err(|error| {
                    (
                        "conversation_filesystem_reference_identity_failed",
                        format!("{}: {}", error.code, error.message),
                    )
                })?;
                let snapshot_root = session_attachment_root(attachment_store_root, session_id)
                    .join(reference_storage_segment(&reference_id));
                if snapshot_root.exists() {
                    return Err((
                        "conversation_filesystem_reference_identity_conflict",
                        "文件引用的 Host 存储身份冲突。".to_string(),
                    ));
                }
                fs::create_dir_all(&snapshot_root).map_err(|error| {
                    (
                        "conversation_filesystem_reference_import_failed",
                        format!("创建文件引用存储目录失败：{error}"),
                    )
                })?;
                created_snapshot_roots.push(snapshot_root.clone());
                let destination = snapshot_root.join(&file_name);
                let copied = fs::copy(&source, &destination).map_err(|error| {
                    (
                        "conversation_filesystem_reference_import_failed",
                        format!("导入文件引用失败：{error}"),
                    )
                })?;
                if copied != metadata.len() {
                    return Err((
                        "conversation_filesystem_reference_import_failed",
                        "导入文件引用时复制字节数不一致。".to_string(),
                    ));
                }
                let canonical_snapshot_root = fs::canonicalize(&snapshot_root)
                    .map_err(|error| {
                        (
                            "conversation_filesystem_reference_import_failed",
                            format!("解析文件引用存储目录失败：{error}"),
                        )
                    })?
                    .to_string_lossy()
                    .to_string();
                let display_name = bounded_display_name(&file_name);
                let media_type = filesystem_reference_media_type(&source);
                catalog.register_workspace(ConversationWorkspaceRecord {
                    workspace_id: workspace_id.clone(),
                    display_name: display_name.clone(),
                    canonical_root: canonical_snapshot_root,
                    owner_session_id: Some(session_id.to_string()),
                    created_at: now.to_string(),
                });
                references.push(json!({
                    "referenceId": reference_id,
                    "workspaceId": workspace_id,
                    "logicalPath": file_name,
                    "displayName": display_name,
                    "kind": "file",
                    "mediaType": media_type,
                    "byteLength": metadata.len(),
                }));
            }
            _ => {
                return Err((
                    "conversation_filesystem_reference_kind_invalid",
                    "文件系统引用 kind 必须是 file 或 directory。".to_string(),
                ))
            }
        }
    }
    Ok(references)
}

fn cleanup_created_snapshot_roots(roots: &[PathBuf]) {
    for root in roots.iter().rev() {
        if let Err(error) = fs::remove_dir_all(root) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[conversation-filesystem-reference-cleanup] {error}");
            }
        }
    }
}

fn session_attachment_root(root: &FsPath, session_id: &str) -> PathBuf {
    root.join(reference_storage_segment(session_id))
}

fn reference_storage_segment(value: &str) -> String {
    deepcode_kernel_tools::hash_bytes(value.as_bytes())
}

fn bounded_display_name(value: &str) -> String {
    value.chars().take(120).collect()
}

fn filesystem_reference_media_type(path: &FsPath) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => "application/pdf",
        "md" | "mdx" => "text/markdown",
        "json" => "application/json",
        "toml" => "application/toml",
        "yaml" | "yml" => "application/yaml",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "xml" | "svg" => "application/xml",
        "txt" | "c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx" | "rs" | "py" | "java"
        | "go" | "sh" | "zsh" | "bash" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn register_roots(
    catalog: &mut ConversationCatalog,
    roots: Vec<String>,
    now: &str,
) -> Result<Vec<String>, SessionServiceError> {
    let mut workspace_ids = Vec::with_capacity(roots.len());
    for root in roots {
        if let Some(workspace) = catalog.workspace_by_root(&root) {
            workspace_ids.push(workspace.workspace_id.clone());
            continue;
        }
        let workspace_id = random_id("workspace")?;
        catalog.register_workspace(ConversationWorkspaceRecord {
            workspace_id: workspace_id.clone(),
            display_name: workspace_display_name(&root),
            canonical_root: root,
            owner_session_id: None,
            created_at: now.to_string(),
        });
        workspace_ids.push(workspace_id);
    }
    Ok(workspace_ids)
}

fn binding_snapshot(
    catalog: &ConversationCatalog,
    workspace_ids: &[String],
) -> Vec<WorkspaceBindingDisplayRecord> {
    workspace_ids
        .iter()
        .filter_map(|workspace_id| catalog.workspace(workspace_id))
        .map(|workspace| WorkspaceBindingDisplayRecord {
            workspace_id: workspace.workspace_id.clone(),
            display_name: workspace.display_name.clone(),
        })
        .collect()
}

fn projection_references_workspace(projection: &Value, workspace_id: &str) -> bool {
    let bindings_contain = |value: Option<&Value>| {
        value.and_then(Value::as_array).is_some_and(|bindings| {
            bindings.iter().any(|binding| {
                binding.get("workspaceId").and_then(Value::as_str) == Some(workspace_id)
            })
        })
    };
    bindings_contain(projection.get("workspaceBindings"))
        || projection
            .get("messages")
            .and_then(Value::as_array)
            .is_some_and(|messages| {
                messages
                    .iter()
                    .any(|message| bindings_contain(message.get("filesystemReferences")))
            })
}

fn validate_message_filesystem_references(
    catalog: &ConversationCatalog,
    session_id: &str,
    command: &Value,
) -> Result<(), (&'static str, String)> {
    catalog
        .session(session_id)
        .ok_or(("conversation_session_not_found", "对话不存在。".to_string()))?;
    let Some(value) = command.get("filesystemReferences") else {
        return Ok(());
    };
    let references = value.as_array().ok_or((
        "conversation_filesystem_references_invalid",
        "filesystemReferences 必须是数组。".to_string(),
    ))?;
    if references.len() > MAX_MESSAGE_FILESYSTEM_REFERENCES {
        return Err((
            "conversation_filesystem_references_invalid",
            "单次消息最多附加八个文件系统引用。".to_string(),
        ));
    }
    let mut reference_ids = HashSet::new();
    let mut targets = HashSet::new();
    for reference in references {
        let object = reference.as_object().ok_or((
            "conversation_filesystem_reference_invalid",
            "文件系统引用必须是对象。".to_string(),
        ))?;
        let reference_id = reference
            .get("referenceId")
            .and_then(Value::as_str)
            .filter(|value| valid_id(value))
            .ok_or((
                "conversation_filesystem_reference_invalid",
                "文件系统引用缺少有效 referenceId。".to_string(),
            ))?;
        let workspace_id = reference
            .get("workspaceId")
            .and_then(Value::as_str)
            .filter(|value| valid_id(value))
            .ok_or((
                "conversation_filesystem_reference_invalid",
                "文件系统引用缺少有效 workspaceId。".to_string(),
            ))?;
        let logical_path = reference
            .get("logicalPath")
            .and_then(Value::as_str)
            .filter(|value| valid_reference_logical_path(value))
            .ok_or((
                "conversation_filesystem_reference_invalid",
                "文件系统引用缺少有效 logicalPath。".to_string(),
            ))?;
        let display_name = reference
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or((
                "conversation_filesystem_reference_invalid",
                "文件系统引用缺少 displayName。".to_string(),
            ))?;
        let kind = reference.get("kind").and_then(Value::as_str).ok_or((
            "conversation_filesystem_reference_invalid",
            "文件系统引用缺少 kind。".to_string(),
        ))?;
        let workspace = catalog.workspace(workspace_id).ok_or((
            "conversation_filesystem_reference_not_found",
            "文件系统引用不在 Host workspace catalog 中。".to_string(),
        ))?;
        if workspace.display_name != display_name
            || !reference_ids.insert(reference_id)
            || !targets.insert(format!("{workspace_id}\0{logical_path}"))
        {
            return Err((
                "conversation_filesystem_reference_mismatch",
                "文件系统引用与 Host workspace catalog 不一致或重复。".to_string(),
            ));
        }
        let target = resolve_catalog_reference_path(workspace, logical_path)?;
        match kind {
            "directory" => {
                if object.len() != 5
                    || logical_path != "."
                    || workspace.owner_session_id.is_some()
                    || !target.is_dir()
                {
                    return Err((
                        "conversation_filesystem_reference_mismatch",
                        "目录引用与 Host 登记事实不一致。".to_string(),
                    ));
                }
            }
            "file" => {
                let media_type = reference
                    .get("mediaType")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or((
                        "conversation_filesystem_reference_invalid",
                        "文件引用缺少 mediaType。".to_string(),
                    ))?;
                let byte_length = reference.get("byteLength").and_then(Value::as_u64).ok_or((
                    "conversation_filesystem_reference_invalid",
                    "文件引用缺少 byteLength。".to_string(),
                ))?;
                let metadata = target.metadata().map_err(|error| {
                    (
                        "conversation_filesystem_reference_unavailable",
                        format!("读取 Host 文件快照失败：{error}"),
                    )
                })?;
                if object.len() != 7
                    || logical_path == "."
                    || workspace.owner_session_id.as_deref() != Some(session_id)
                    || !metadata.is_file()
                    || metadata.len() != byte_length
                    || filesystem_reference_media_type(&target) != media_type
                {
                    return Err((
                        "conversation_filesystem_reference_mismatch",
                        "文件引用与 Host 导入快照不一致。".to_string(),
                    ));
                }
            }
            _ => {
                return Err((
                    "conversation_filesystem_reference_kind_invalid",
                    "文件系统引用 kind 必须是 file 或 directory。".to_string(),
                ))
            }
        }
    }
    Ok(())
}

fn valid_reference_logical_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 4_096 || value.contains('\0') || value.contains('\\') {
        return false;
    }
    if value == "." {
        return true;
    }
    !value.starts_with('/')
        && !value.ends_with('/')
        && value
            .split('/')
            .all(|segment| !segment.is_empty() && !matches!(segment, "." | ".."))
}

fn resolve_catalog_reference_path(
    workspace: &ConversationWorkspaceRecord,
    logical_path: &str,
) -> Result<PathBuf, (&'static str, String)> {
    let canonical_root = fs::canonicalize(&workspace.canonical_root).map_err(|error| {
        (
            "conversation_filesystem_reference_unavailable",
            format!("Host workspace 根不可用：{error}"),
        )
    })?;
    let requested = if logical_path == "." {
        canonical_root.clone()
    } else {
        canonical_root.join(logical_path)
    };
    let canonical = fs::canonicalize(requested).map_err(|error| {
        (
            "conversation_filesystem_reference_unavailable",
            format!("Host 文件系统引用不可用：{error}"),
        )
    })?;
    if !canonical.starts_with(&canonical_root) {
        return Err((
            "conversation_filesystem_reference_escape",
            "文件系统引用逃逸 Host workspace 根。".to_string(),
        ));
    }
    Ok(canonical)
}

fn validate_required_filesystem_plugins(
    settings: &Value,
    command: &Value,
) -> Result<(), (&'static str, String)> {
    let selected_uris = command
        .get("pluginSelections")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|selection| selection.get("uri").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let Some(references) = command
        .get("filesystemReferences")
        .and_then(Value::as_array)
    else {
        return Ok(());
    };
    for media_type in references.iter().filter_map(|reference| {
        (reference.get("kind").and_then(Value::as_str) == Some("file"))
            .then(|| reference.get("mediaType").and_then(Value::as_str))
            .flatten()
    }) {
        let required_uri =
            crate::local_agent_plugins::plugin_uri_for_activation_media_type(settings, media_type)
                .map_err(|message| ("plugin_catalog_unavailable", message))?;
        if media_type == "application/pdf" && required_uri.is_none() {
            return Err((
                "plugin_selection_unavailable",
                "PDF 文件引用需要一个声明 application/pdf 激活类型的可用插件。".to_string(),
            ));
        }
        if let Some(uri) = required_uri {
            if !selected_uris.contains(uri.as_str()) {
                return Err((
                    "plugin_selection_required",
                    format!("文件类型 {media_type} 需要显式选择插件 {uri}。"),
                ));
            }
        }
    }
    Ok(())
}

fn validate_directory_index_attach_command(
    catalog: &ConversationCatalog,
    session_id: &str,
    command: &Value,
) -> Result<(), (&'static str, String)> {
    catalog
        .session(session_id)
        .ok_or(("conversation_session_not_found", "对话不存在。".to_string()))?;
    let binding = command
        .get("workspaceBinding")
        .and_then(Value::as_object)
        .ok_or((
            "conversation_directory_index_binding_invalid",
            "目录索引命令缺少 Host 登记的 workspaceBinding。".to_string(),
        ))?;
    let workspace_id = binding
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|value| valid_id(value))
        .ok_or((
            "conversation_directory_index_binding_invalid",
            "目录索引命令 workspaceId 无效。".to_string(),
        ))?;
    let display_name = binding
        .get("displayName")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or((
            "conversation_directory_index_binding_invalid",
            "目录索引命令 displayName 无效。".to_string(),
        ))?;
    let workspace = catalog.workspace(workspace_id).ok_or((
        "conversation_workspace_not_found",
        "目录索引尚未由 Host 登记。".to_string(),
    ))?;
    if workspace.display_name != display_name {
        return Err((
            "conversation_directory_index_binding_mismatch",
            "目录索引显示身份与 Host Catalog 不一致。".to_string(),
        ));
    }
    Ok(())
}

fn selected_profile_id(
    gui: &crate::GuiState,
    requested: Option<&str>,
) -> Result<String, (&'static str, String)> {
    if !crate::llm_profile_store_is_current(&gui.llm_profiles) {
        return Err((
            "llm_profile_store_invalid",
            "本地模型 Profile 配置不是当前格式。".to_string(),
        ));
    }
    let profiles = gui
        .llm_profiles
        .get("profiles")
        .and_then(Value::as_array)
        .expect("validated LLM profile store");
    let selected = requested
        .or_else(|| {
            gui.llm_profiles
                .get("defaultProfileId")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            profiles
                .iter()
                .find(|profile| crate::llm_profile_value_is_enabled(profile))
                .and_then(|profile| profile.get("id"))
                .and_then(Value::as_str)
        })
        .ok_or((
            "llm_profile_unavailable",
            "没有可用于新对话的模型 Profile。".to_string(),
        ))?;
    let enabled = profiles.iter().any(|profile| {
        profile.get("id").and_then(Value::as_str) == Some(selected)
            && crate::llm_profile_value_is_enabled(profile)
    });
    if !enabled {
        return Err((
            "llm_profile_unavailable",
            format!("模型 Profile 不存在或未启用：{selected}"),
        ));
    }
    Ok(selected.to_string())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

fn random_id(prefix: &str) -> Result<String, SessionServiceError> {
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy).map_err(|error| {
        SessionServiceError::new(
            "local_agent_entropy_failed",
            format!("生成本地标识失败：{error}"),
        )
    })?;
    let mut value = format!("{prefix}:");
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TemporaryTree(PathBuf);

    impl TemporaryTree {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(
                random_id(label)
                    .expect("temporary tree identity")
                    .replace(':', "-"),
            );
            std::fs::create_dir_all(&path).expect("create temporary tree");
            Self(path)
        }
    }

    impl Drop for TemporaryTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn catalog_fixture() -> ConversationCatalog {
        ConversationCatalog {
            workspaces: vec![ConversationWorkspaceRecord {
                workspace_id: "workspace:test".to_string(),
                display_name: "Test".to_string(),
                canonical_root: "/private/host/Test".to_string(),
                owner_session_id: None,
                created_at: "1".to_string(),
            }],
            projects: Vec::new(),
            sessions: vec![ConversationSessionRecord {
                id: "session:test".to_string(),
                title: "Test".to_string(),
                workspace_bindings: Vec::new(),
                project_id: None,
                profile_id: Some("profile:test".to_string()),
                created_at: "1".to_string(),
                updated_at: "1".to_string(),
            }],
        }
    }

    #[test]
    fn generic_attach_command_must_match_host_catalog_binding() {
        let catalog = catalog_fixture();
        let valid = json!({
            "workspaceBinding": {
                "workspaceId": "workspace:test",
                "displayName": "Test",
            }
        });
        assert!(validate_directory_index_attach_command(&catalog, "session:test", &valid,).is_ok());

        let forged_name = json!({
            "workspaceBinding": {
                "workspaceId": "workspace:test",
                "displayName": "Forged",
            }
        });
        assert_eq!(
            validate_directory_index_attach_command(&catalog, "session:test", &forged_name,)
                .expect_err("forged display rejected")
                .0,
            "conversation_directory_index_binding_mismatch"
        );

        let unknown = json!({
            "workspaceBinding": {
                "workspaceId": "workspace:unknown",
                "displayName": "Unknown",
            }
        });
        assert_eq!(
            validate_directory_index_attach_command(&catalog, "session:test", &unknown)
                .expect_err("unknown workspace rejected")
                .0,
            "conversation_workspace_not_found"
        );
    }

    #[test]
    fn message_filesystem_references_must_match_host_catalog() {
        let root = std::env::temp_dir().join(
            random_id("deepcode-filesystem-reference-test")
                .expect("temporary reference identity")
                .replace(':', "-"),
        );
        std::fs::create_dir_all(&root).expect("create temporary reference directory");
        let mut catalog = catalog_fixture();
        catalog.workspaces[0].canonical_root = root.to_string_lossy().to_string();
        let command = json!({
            "filesystemReferences": [{
                "referenceId": "reference:test",
                "workspaceId": "workspace:test",
                "logicalPath": ".",
                "displayName": "Test",
                "kind": "directory",
            }]
        });
        assert!(validate_message_filesystem_references(&catalog, "session:test", &command).is_ok());

        let forged = json!({
            "filesystemReferences": [{
                "referenceId": "reference:test",
                "workspaceId": "workspace:test",
                "logicalPath": ".",
                "displayName": "Forged",
                "kind": "directory",
            }]
        });
        assert_eq!(
            validate_message_filesystem_references(&catalog, "session:test", &forged)
                .expect_err("forged reference rejected")
                .0,
            "conversation_filesystem_reference_mismatch"
        );

        let projection = json!({
            "workspaceBindings": [],
            "messages": [{
                "filesystemReferences": [{
                    "referenceId": "reference:test",
                    "workspaceId": "workspace:test",
                    "logicalPath": ".",
                    "displayName": "Test",
                    "kind": "directory",
                }]
            }]
        });
        assert!(projection_references_workspace(
            &projection,
            "workspace:test"
        ));
        assert!(!projection_references_workspace(
            &projection,
            "workspace:other"
        ));
        std::fs::remove_dir_all(root).expect("remove temporary reference directory");
    }

    #[test]
    fn file_reference_is_imported_as_session_owned_snapshot() {
        let source_tree = TemporaryTree::new("deepcode-reference-source");
        let attachment_tree = TemporaryTree::new("deepcode-reference-store");
        let source = source_tree.0.join("fixture.pdf");
        std::fs::write(&source, b"%PDF fixture bytes").expect("write source fixture");
        let mut catalog = catalog_fixture();
        let inputs = vec![FilesystemReferencePathInput {
            path: source.to_string_lossy().to_string(),
            kind: "file".to_string(),
        }];
        let mut created_snapshot_roots = Vec::new();

        let references = resolve_filesystem_references(
            &mut catalog,
            &attachment_tree.0,
            "session:test",
            &inputs,
            "now",
            &mut created_snapshot_roots,
        )
        .expect("import file reference");
        assert_eq!(references.len(), 1);
        let reference = &references[0];
        assert_eq!(reference["kind"], "file");
        assert_eq!(reference["logicalPath"], "fixture.pdf");
        assert_eq!(reference["mediaType"], "application/pdf");
        assert_eq!(reference["byteLength"], 18);
        let workspace_id = reference["workspaceId"]
            .as_str()
            .expect("workspace identity");
        let workspace = catalog.workspace(workspace_id).expect("snapshot workspace");
        assert_eq!(workspace.owner_session_id.as_deref(), Some("session:test"));
        let imported = PathBuf::from(&workspace.canonical_root).join("fixture.pdf");
        assert_eq!(
            std::fs::read(&imported).expect("read imported snapshot"),
            b"%PDF fixture bytes"
        );

        std::fs::write(&source, b"changed source").expect("mutate source fixture");
        assert_eq!(
            std::fs::read(&imported).expect("read stable snapshot"),
            b"%PDF fixture bytes"
        );
        assert!(validate_message_filesystem_references(
            &catalog,
            "session:test",
            &json!({ "filesystemReferences": references }),
        )
        .is_ok());
        assert_eq!(created_snapshot_roots.len(), 1);
        assert!(created_snapshot_roots[0].starts_with(&attachment_tree.0));
    }

    #[test]
    fn pdf_reference_requires_the_declared_media_type_plugin_selection() {
        let settings = json!({});
        let required_uri = crate::local_agent_plugins::plugin_uri_for_activation_media_type(
            &settings,
            "application/pdf",
        )
        .expect("resolve activation owner")
        .expect("PDF activation owner");
        assert_eq!(required_uri, "plugin://pdf@first-party");
        let mut command = json!({
            "filesystemReferences": [{
                "referenceId": "reference:pdf",
                "workspaceId": "workspace:pdf",
                "logicalPath": "fixture.pdf",
                "displayName": "fixture.pdf",
                "kind": "file",
                "mediaType": "application/pdf",
                "byteLength": 18,
            }],
        });

        assert_eq!(
            validate_required_filesystem_plugins(&settings, &command)
                .expect_err("missing PDF plugin selection")
                .0,
            "plugin_selection_required"
        );
        command["pluginSelections"] = json!([{
            "selectionId": "selection:pdf",
            "uri": required_uri,
            "label": "PDF reader",
        }]);
        assert!(validate_required_filesystem_plugins(&settings, &command).is_ok());
    }
}
