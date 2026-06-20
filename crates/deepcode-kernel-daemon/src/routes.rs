use crate::prelude::*;
use crate::*;

pub(crate) fn build_app(state: AppState) -> Router {
    let mut app = Router::new()
        .route("/", get(gui_index))
        .route("/index.html", get(gui_index))
        .route("/assets/*asset_path", get(gui_asset))
        .route("/api/health", get(health))
        .route("/api/kernel/commands", post(kernel_commands))
        .route("/api/kernel/snapshot", get(kernel_snapshot))
        .route("/api/kernel/events/stream", get(kernel_events_stream))
        .route("/api/session-store/index", get(session_store_index))
        .route(
            "/api/session-store/:session_id/projection",
            get(session_store_projection_get).post(session_store_projection_append),
        )
        .route(
            "/api/session-store/:session_id/transcript",
            get(session_store_transcript_get)
                .post(session_store_transcript_append)
                .layer(DefaultBodyLimit::max(LARGE_JSON_BODY_LIMIT_BYTES)),
        )
        .route(
            "/api/session-store/:session_id/archive",
            get(session_store_archive_get),
        )
        .route(
            "/api/session-store/:session_id/archive/file",
            get(session_store_archive_file_get),
        )
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
        .route("/api/skills/scan-mount", post(skill_mount_scan))
        .route("/api/files/tree", get(file_tree))
        .route("/api/files/read", get(file_read))
        .route("/api/files/write", post(file_write))
        .route("/api/files/create", post(file_create))
        .route("/api/files/delete", post(file_delete))
        .route("/api/files/rename", post(file_rename))
        .route("/api/folders/create", post(folder_create))
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
            "/api/llm/chat",
            post(llm_chat).layer(DefaultBodyLimit::max(LARGE_JSON_BODY_LIMIT_BYTES)),
        )
        .route(
            "/api/llm/chat/stream",
            post(llm_chat_stream).layer(DefaultBodyLimit::max(LARGE_JSON_BODY_LIMIT_BYTES)),
        )
        .route("/api/code/search", post(code_search))
        .route("/api/git/status", get(git_status))
        .route("/api/git/diff", get(git_diff))
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
        .route(
            "/api/agent/sessions",
            get(agent_sessions_list).post(agent_session_create),
        )
        .route("/api/agent/sessions/current", get(agent_session_current))
        .route(
            "/api/agent/sessions/:session_id/activate",
            post(agent_session_activate),
        )
        .route(
            "/api/agent/sessions/:session_id/archive",
            post(agent_session_archive),
        )
        .route(
            "/api/agent/sessions/:session_id/events",
            get(agent_session_events).post(agent_session_append_events),
        )
        .route(
            "/api/agent/sessions/:session_id/cancel",
            post(agent_session_cancel),
        )
        .route(
            "/api/agent/sessions/:session_id/runs",
            post(agent_session_run_start),
        )
        .route(
            "/api/agent/sessions/:session_id/runs/:run_id",
            get(agent_session_run_get),
        )
        .route(
            "/api/agent/sessions/:session_id/runs/:run_id/cancel",
            post(agent_session_run_cancel),
        )
        .route(
            "/api/agent/sessions/:session_id/runs/:run_id/deltas",
            post(agent_session_run_delta),
        )
        .route(
            "/api/agent/sessions/:session_id/runs/:run_id/guidance",
            post(agent_session_run_guidance),
        )
        .route(
            "/api/agent/sessions/:session_id/runs/:run_id/stream",
            get(agent_session_run_stream),
        )
        .route(
            "/api/agent/sessions/:session_id/trace",
            get(agent_session_trace),
        )
        .route(
            "/api/agent/sessions/:session_id/timeline",
            get(agent_session_timeline),
        )
        .route(
            "/api/agent/sessions/:session_id",
            patch(agent_session_rename).delete(agent_session_delete),
        )
        .route(
            "/api/agent/permissions/:permission_id/resolve",
            post(agent_permission_resolve),
        )
        .route("/api/agent/feedback", post(agent_feedback))
        .route(
            "/api/agent/workflow-config",
            get(agent_workflow_config_get).patch(agent_workflow_config_patch),
        )
        .route("/api/agent/tools", get(agent_tools))
        .route("/api/agent/skills", get(agent_tools))
        .route("/api/browser/runtime-status", get(browser_status))
        .route("/api/browser/open", post(browser_open))
        .route("/api/browser/reload", post(browser_reload))
        .route("/api/browser/inspect-mode", post(browser_inspect_mode))
        .route("/api/browser/panel-snapshot", get(browser_panel_snapshot))
        .route(
            "/api/browser/panel-snapshot/attach",
            post(browser_attach_snapshot),
        )
        .route("/api/*path", any(api_not_implemented));
    if let Some(client_dist) = client_dist_dir() {
        let index_path = client_dist.join("index.html");
        app = app.fallback_service(
            ServeDir::new(client_dist.clone()).not_found_service(ServeFile::new(index_path)),
        );
        println!(
            "DeepCode daemon GUI assets served from {}",
            client_dist.display()
        );
    }
    app.with_state(state).layer(localhost_cors_layer())
}
