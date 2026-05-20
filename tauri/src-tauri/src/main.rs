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
mod workspace;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(workspace::WorkspaceManager::new())
        .invoke_handler(tauri::generate_handler![
            // 运行时状态
            commands::get_runtime_status,
            // 工作区
            commands::get_current_workspace,
            commands::open_workspace,
            // 文件系统浏览
            commands::get_initial_locations,
            commands::browse_path,
            // 文件
            commands::list_file_tree,
            commands::read_text_file,
            commands::write_text_file,
            // 原生对话框
            commands::pick_workspace_directory,
            commands::pick_workspace_file,
            // Stub
            commands::llm_invoke_stub,
            commands::skill_invoke_stub,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
