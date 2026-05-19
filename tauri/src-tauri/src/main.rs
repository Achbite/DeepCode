// 应用入口
//
// 仅做 Tauri Builder 装配；具体命令在 commands.rs 中实现。
// 当前阶段所有 LLM / Skill 命令均以"空操作 stub"形式存在，留给后续阶段填实。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::pick_workspace_path,
            commands::get_app_version,
            commands::llm_invoke_stub,
            commands::skill_invoke_stub,
        ])
        .run(tauri::generate_context!())
        .expect("启动 DeepCode Tauri 应用失败");
}
