use crate::prelude::*;
use crate::*;
use axum::routing::delete;

pub(crate) fn build_app(state: AppState) -> Router {
    let host_connection = state.host_connection.clone();
    Router::new()
        .route("/api/host/identity", get(host_identity))
        .route("/api/health", get(health))
        .route("/api/host/shutdown", post(host_shutdown))
        .route("/api/workspaces/current", get(workspace_current))
        .route("/api/workspaces/default-path", get(workspace_default_path))
        .route("/api/workspaces/open", post(workspace_open))
        .route("/api/workspaces/save-file", post(workspace_save_file))
        .route(
            "/api/workspaces/current/settings",
            patch(workspace_patch_settings),
        )
        .route("/api/fs/initial-locations", get(fs_initial_locations))
        .route("/api/fs/browse", get(fs_browse))
        .route("/api/host/inspect", post(host_inspect))
        .route(
            "/api/user-settings",
            get(user_settings_get).patch(user_settings_patch),
        )
        .route(
            "/api/llm/profiles",
            get(llm_profiles_get).patch(llm_profiles_patch),
        )
        .route("/api/llm/probe", post(llm_probe))
        .route(
            "/api/local-agent/journal/sessions",
            post(local_agent_session_create),
        )
        .route(
            "/api/local-agent/journal/sessions/:session_id",
            delete(local_agent_session_delete),
        )
        .route(
            "/api/local-agent/journal/events",
            post(local_agent_event_append),
        )
        .route(
            "/api/local-agent/journal/events/batch",
            post(local_agent_events_append_batch),
        )
        .route(
            "/api/local-agent/journal/commands",
            post(local_agent_command_commit),
        )
        .route(
            "/api/local-agent/journal/sessions/:session_id/events",
            get(local_agent_events_read),
        )
        .route(
            "/api/local-agent/journal/sessions/:session_id/commands/:command_id",
            get(local_agent_command_read),
        )
        .route("/api/local-agent/kernel/tools", get(local_agent_tools))
        .route(
            "/api/local-agent/kernel/execute",
            post(local_agent_tool_execute),
        )
        .route(
            "/api/local-agent/kernel/cancel",
            post(local_agent_tool_cancel),
        )
        .route(
            "/api/local-agent/kernel/records/:call_id",
            get(local_agent_tool_record),
        )
        .route(
            "/api/local-agent/provider/stream",
            post(local_agent_provider_stream)
                .layer(DefaultBodyLimit::max(LARGE_JSON_BODY_LIMIT_BYTES)),
        )
        .route(
            "/api/conversation/sessions",
            post(conversation_session_create),
        )
        .route("/api/conversation/catalog", get(conversation_catalog_get))
        .route(
            "/api/conversation/catalog/manage",
            get(conversation_catalog_management_get),
        )
        .route(
            "/api/conversation/projects",
            post(conversation_project_create),
        )
        .route(
            "/api/conversation/projects/:project_id",
            patch(conversation_project_update).delete(conversation_project_delete),
        )
        .route(
            "/api/conversation/sessions/:session_id",
            patch(conversation_session_update).delete(conversation_session_delete),
        )
        .route(
            "/api/conversation/sessions/:session_id/commands",
            post(conversation_command_submit),
        )
        .route(
            "/api/conversation/sessions/:session_id/directory-indexes",
            post(conversation_directory_index_attach),
        )
        .route(
            "/api/conversation/sessions/:session_id/directory-indexes/:workspace_id",
            delete(conversation_directory_index_detach),
        )
        .route(
            "/api/conversation/sessions/:session_id/projection",
            get(conversation_projection_get),
        )
        .route(
            "/api/conversation/sessions/:session_id/resources/read",
            post(conversation_resource_read),
        )
        .route("/api/runtime/shell", get(runtime_shell))
        .route("/api/terminal/capabilities", get(terminal_capabilities))
        .route(
            "/api/terminal/warmup",
            get(terminal_warmup).post(terminal_warmup),
        )
        .route(
            "/api/terminal/sessions",
            get(terminal_sessions).post(terminal_create_session),
        )
        .route(
            "/api/terminal/sessions/:session_id/input",
            post(terminal_input),
        )
        .route(
            "/api/terminal/sessions/:session_id/resize",
            post(terminal_resize),
        )
        .route(
            "/api/terminal/sessions/:session_id/restart",
            post(terminal_restart),
        )
        .route(
            "/api/terminal/sessions/:session_id",
            patch(terminal_update).delete(terminal_delete),
        )
        .route("/api/terminal/events", get(terminal_events))
        .route("/api/browser/runtime-status", get(browser_status))
        .route("/api/browser/open", post(browser_open))
        .route("/api/browser/reload", post(browser_reload))
        .route("/api/browser/inspect-mode", post(browser_inspect_mode))
        .route("/api/*path", any(api_route_not_found))
        .with_state(state)
        .layer(localhost_cors_layer())
        .layer(axum::middleware::from_fn_with_state(
            host_connection,
            trusted_host_connection_gate,
        ))
        .layer(axum::middleware::from_fn(trusted_local_origin_gate))
}
