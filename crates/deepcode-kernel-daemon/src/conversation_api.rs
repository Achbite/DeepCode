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

pub(crate) async fn conversation_catalog_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.conversation_catalog_error.as_deref() {
        return ApiResponse::error("conversation_catalog_unavailable", error);
    }
    ApiResponse::ok(gui.conversation_catalog.public_value())
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
    if !projection
        .get("workspaceBindings")
        .and_then(Value::as_array)
        .is_some_and(|bindings| {
            bindings.iter().any(|binding| {
                binding.get("workspaceId").and_then(Value::as_str) == Some(&body.workspace_id)
            })
        })
    {
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
                "schemaVersion": "deepcode.command",
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
                "schemaVersion": "deepcode.command",
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
    let snapshot = match request_service(
        state.session_service.clone(),
        "snapshot",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        Ok(value) => value,
        Err(error) if error.code == "session_not_found" => {
            return ApiResponse::error("conversation_session_not_found", "对话不存在.")
        }
        Err(error) => return session_service_error(error),
    };
    let active = snapshot
        .pointer("/run/status")
        .and_then(Value::as_str)
        .is_some_and(|status| matches!(status, "running" | "waiting"));
    if active {
        return ApiResponse::error(
            "conversation_session_active",
            "请先停止当前运行，再删除对话。",
        );
    }

    let deleted = {
        let mut gui = state.gui.lock().expect("gui state lock");
        if let Some(error) = gui.conversation_catalog_error.as_deref() {
            return ApiResponse::error("conversation_catalog_unavailable", error);
        }
        let Some(deleted) = gui.conversation_catalog.session(&session_id).cloned() else {
            return ApiResponse::error("conversation_session_not_found", "对话不存在。");
        };
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
        deleted
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
        return session_service_error(error);
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
            .filter(|kind| *kind == "message.submit")
            .and_then(|_| command.get("text").and_then(Value::as_str))
            .map(automatic_conversation_title);
        let mut gui = state.gui.lock().expect("gui state lock");
        if gui.conversation_catalog_error.is_none() {
            let previous = gui.conversation_catalog.clone();
            if gui.conversation_catalog.touch_session(
                &session_id,
                automatic_title.as_deref(),
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

    fn catalog_fixture() -> ConversationCatalog {
        ConversationCatalog {
            workspaces: vec![ConversationWorkspaceRecord {
                workspace_id: "workspace:test".to_string(),
                display_name: "Test".to_string(),
                canonical_root: "/private/host/Test".to_string(),
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
}
