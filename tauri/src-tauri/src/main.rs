// main.rs
//
// Tauri 应用入口
//
// 注册所有 command 和 managed state，启动 Tauri 窗口。
//
// `windows_subsystem = "windows"` 仅在 release 编译时生效；让 PE 加载器把进程
// 当作 GUI 子系统启动，不再分配控制台窗口（消除黑色 cmd 闪窗）。
// debug 模式仍保留控制台便于查看 println! / panic 信息。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod fs;
mod llm_profiles;
mod terminal;
mod user_settings;
mod workspace;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(workspace::WorkspaceManager::new())
        .manage(terminal::TerminalManager::new())
        .invoke_handler(tauri::generate_handler![
            // 运行时状态
            commands::get_runtime_status,
            // 工作区
            commands::get_current_workspace,
            commands::open_workspace,
            commands::save_workspace_file,
            commands::patch_workspace_settings,
            // 文件系统浏览
            commands::get_initial_locations,
            commands::browse_path,
            // 文件
            commands::list_file_tree,
            commands::read_text_file,
            commands::write_text_file,
            commands::create_file,
            commands::create_folder,
            commands::rename_entry,
            // 原生对话框
            commands::pick_workspace_directory,
            commands::pick_workspace_file,
            // 用户设置
            commands::get_user_settings,
            commands::patch_user_settings,
            commands::get_terminal_capabilities,
            commands::get_terminal_warmup_status,
            commands::warmup_terminal_runtime,
            commands::list_terminal_sessions,
            commands::create_terminal_session,
            commands::send_terminal_input,
            commands::resize_terminal_session,
            commands::update_terminal_session,
            commands::restart_terminal_session,
            commands::delete_terminal_session,
            commands::get_terminal_events,
            // 阶段 6 桥接
            commands::get_llm_profiles,
            commands::patch_llm_profiles,
            commands::probe_llm_profile,
            commands::llm_chat,
            commands::get_agent_workflow_config,
            commands::patch_agent_workflow_config,
            commands::code_search,
            commands::create_agent_session,
            commands::get_current_agent_session,
            commands::append_agent_events,
            commands::list_agent_tools,
            commands::evaluate_agent_permission,
            commands::execute_agent_tool,
            commands::send_agent_message,
            commands::resolve_agent_permission,
            commands::submit_agent_feedback,
            commands::get_browser_runtime_status,
            commands::open_browser_preview,
            commands::reload_browser_preview,
            commands::set_browser_inspect_mode,
            commands::get_selected_panel_snapshot,
            commands::attach_panel_snapshot_to_agent,
            // Stub
            commands::llm_invoke_stub,
            commands::skill_invoke_stub,
            // 窗口管理
            commands::window_close_ask_status,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
