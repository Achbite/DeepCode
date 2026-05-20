// main.rs
//
// Tauri 应用入口
//
// 注册所有 command 和 managed state，启动 Tauri 窗口。

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
