//! Physical read adapter for an explicitly selected local file. It does not
//! attach a workspace or add anything to the conversation/model context.
use std::io::Read;

#[tauri::command]
pub async fn deepcode_read_local_file(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::PathBuf::from(path);
        if !path.is_absolute() {
            return Err("file_read_path_invalid: absolute path required".into());
        }
        let file =
            std::fs::File::open(&path).map_err(|error| format!("file_open_failed: {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("file_metadata_failed: {error}"))?;
        if !metadata.is_file() {
            return Err("file_read_not_regular: select a file".into());
        }
        const LIMIT: u64 = 32 * 1024 * 1024;
        if metadata.len() > LIMIT {
            return Err("file_read_limit_exceeded: 32 MiB".into());
        }
        let mut bytes = Vec::new();
        file.take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("file_read_failed: {error}"))?;
        if bytes.len() as u64 > LIMIT {
            return Err("file_read_limit_exceeded: 32 MiB".into());
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|error| format!("file_reader_failed: {error}"))?
}
