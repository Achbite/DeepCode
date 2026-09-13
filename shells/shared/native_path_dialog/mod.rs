//! Desktop-only selection adapter shared by the Editor and conversation shells.
//! A mixed selection returns the actual path kind; it does not read file contents.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathOptions {
    title: String,
    select_label: String,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    cancel_label: String,
    default_path: Option<String>,
    #[serde(default)]
    filters: Vec<PathFilter>,
}

#[derive(Deserialize)]
pub struct PathFilter {
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    name: String,
    extensions: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSelection {
    path: String,
    kind: &'static str,
}

fn describe_selection(path: PathBuf) -> Result<PathSelection, String> {
    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    let kind = if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        return Err("native_path_selection_not_file_or_directory".into());
    };
    let path = path
        .into_os_string()
        .into_string()
        .map_err(|_| "native_path_selection_not_unicode")?;
    Ok(PathSelection { path, kind })
}

#[tauri::command]
pub async fn deepcode_pick_path(
    window: tauri::Window,
    options: PathOptions,
) -> Result<Option<PathSelection>, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let parent = window.clone();
    window
        .run_on_main_thread(move || {
            #[cfg(windows)]
            let result = windows::pick(&parent, &options);
            #[cfg(target_os = "macos")]
            let result = macos::pick(&parent, &options);
            #[cfg(target_os = "linux")]
            let result = linux::pick(&parent, &options);
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv()
            .map_err(|error| error.to_string())??
            .map(describe_selection)
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}
