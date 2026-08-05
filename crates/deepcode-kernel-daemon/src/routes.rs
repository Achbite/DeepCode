use crate::kernel_v2_transport::{
    kernel_v2_commands, kernel_v2_user_decisions, KERNEL_V2_COMMANDS_PATH,
    KERNEL_V2_USER_DECISIONS_PATH,
};
use crate::prelude::*;
use crate::*;
use deepcode_kernel_abi::v2_command::MAX_COMMAND_BYTES_V2;
use deepcode_kernel_abi::MAX_USER_DECISION_BYTES_V2;

pub(crate) fn build_app(state: AppState) -> Router {
    let host_shell_authority = state.host_shell_authority.clone();
    Router::new()
        .route("/api/host/identity", get(host_identity_v2))
        .route("/api/health", get(health))
        .route("/api/host/shutdown", post(host_shutdown_v2))
        .route(
            KERNEL_V2_COMMANDS_PATH,
            post(kernel_v2_commands).layer(DefaultBodyLimit::max(MAX_COMMAND_BYTES_V2)),
        )
        .route(
            KERNEL_V2_USER_DECISIONS_PATH,
            post(kernel_v2_user_decisions).layer(DefaultBodyLimit::max(MAX_USER_DECISION_BYTES_V2)),
        )
        .route(
            "/api/session-store/:session_id/session-runs/:run_id",
            get(session_run_store_get)
                .post(session_run_store_append)
                .layer(DefaultBodyLimit::max(
                    SESSION_KERNEL_PRIVATE_BODY_LIMIT_BYTES,
                )),
        )
        .route(
            "/api/session-store/:session_id/session-runs/:run_id/records/:record_id",
            get(session_run_store_record_get),
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
        .route("/api/host/inspect", post(host_inspect))
        .route("/api/host/skills/scan-mount", post(skill_mount_scan))
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
            "/api/host/provider-traces/:session_id",
            get(provider_trace_metadata_list),
        )
        .route(
            "/api/host/provider-traces/:session_id/:provider_turn_id/export-capability",
            post(provider_trace_export_capability_mint),
        )
        .route(
            "/api/host/provider-traces/:session_id/:provider_turn_id/export",
            post(provider_trace_export).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/llm/chat/stream",
            post(llm_chat_stream).layer(DefaultBodyLimit::max(LARGE_JSON_BODY_LIMIT_BYTES)),
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
        .route(
            "/api/agent/sessions",
            get(agent_sessions_list).post(agent_session_create),
        )
        .route(
            "/api/agent/projects",
            get(agent_projects_list).post(agent_project_create),
        )
        .route(
            "/api/agent/projects/:project_id",
            get(agent_project_get)
                .patch(agent_project_update)
                .delete(agent_project_delete),
        )
        .route(
            "/api/agent/projects/:project_id/rebind",
            post(agent_project_rebind),
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
            "/api/agent/sessions/:session_id/runs",
            post(agent_session_run_start),
        )
        .route(
            "/api/agent/sessions/:session_id/runs/:host_run_id/kernel-v2/projections",
            post(session_kernel_v2_projection_append).layer(DefaultBodyLimit::max(
                SESSION_KERNEL_PRIVATE_BODY_LIMIT_BYTES,
            )),
        )
        .route(
            "/api/agent/sessions/:session_id/runs/:host_run_id/kernel-v2/prior-events",
            get(session_kernel_v2_prior_events_page),
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
            "/api/agent/sessions/:session_id/runs/:run_id/guidance",
            post(agent_session_run_guidance),
        )
        .route(
            "/api/agent/sessions/:session_id/runs/:run_id/authority/revoke",
            post(agent_session_run_authority_revoke),
        )
        .route(
            "/api/agent/sessions/:session_id/timeline",
            get(agent_session_timeline),
        )
        .route(
            "/api/agent/sessions/:session_id/timeline/stream",
            get(agent_session_timeline_stream),
        )
        .route(
            "/api/agent/sessions/:session_id",
            get(agent_session_get)
                .patch(agent_session_rename)
                .delete(agent_session_delete),
        )
        .route("/api/host/skills", get(host_skills))
        .route("/api/browser/runtime-status", get(browser_status))
        .route("/api/browser/open", post(browser_open))
        .route("/api/browser/reload", post(browser_reload))
        .route("/api/browser/inspect-mode", post(browser_inspect_mode))
        .route("/api/*path", any(api_route_not_found))
        .with_state(state.clone())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::startup_readiness_v2::host_startup_readiness_gate,
        ))
        .layer(localhost_cors_layer())
        .layer(axum::middleware::from_fn_with_state(
            host_shell_authority,
            trusted_host_admission_gate,
        ))
        .layer(axum::middleware::from_fn(trusted_local_origin_gate))
}
