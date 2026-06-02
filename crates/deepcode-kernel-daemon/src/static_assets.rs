#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

pub(crate) fn client_dist_dir() -> Option<PathBuf> {
    let path = std::env::var_os("DEEPCODE_CLIENT_DIST").map(PathBuf::from)?;
    if path.join("index.html").is_file() {
        Some(path)
    } else {
        eprintln!(
            "DEEPCODE_CLIENT_DIST={} does not contain index.html; static GUI disabled",
            path.display()
        );
        None
    }
}

pub(crate) async fn gui_index() -> Response {
    let Some(client_dist) = client_dist_dir() else {
        return ApiResponse::error(
            "gui_not_configured",
            "DEEPCODE_CLIENT_DIST is not configured",
        )
        .into_response();
    };
    let index_path = client_dist.join("index.html");
    match fs::read(index_path) {
        Ok(content) => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache, no-store, must-revalidate"),
            ],
            content,
        )
            .into_response(),
        Err(error) => {
            ApiResponse::error("gui_index_unavailable", error.to_string()).into_response()
        }
    }
}

pub(crate) async fn gui_asset(Path(asset_path): Path<String>) -> Response {
    let Some(client_dist) = client_dist_dir() else {
        return ApiResponse::error(
            "gui_not_configured",
            "DEEPCODE_CLIENT_DIST is not configured",
        )
        .into_response();
    };
    let asset_root = client_dist.join("assets");
    let Some(relative_path) = safe_asset_path(&asset_path) else {
        return ApiResponse::error("invalid_asset_path", "Invalid asset path").into_response();
    };
    let requested_path = asset_root.join(&relative_path);
    if requested_path.is_file() {
        return serve_asset_file(&requested_path, false);
    }
    if asset_path.starts_with("heartbeatSocket-") && asset_path.ends_with(".js") {
        if let Some(current_heartbeat) = find_current_heartbeat_asset(&asset_root) {
            return serve_asset_file(&current_heartbeat, true);
        }
    }
    ApiResponse::error("asset_not_found", "Asset not found").into_response()
}

pub(crate) fn safe_asset_path(asset_path: &str) -> Option<PathBuf> {
    let path = FsPath::new(asset_path);
    if path.components().all(|component| {
        matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    }) {
        Some(path.to_path_buf())
    } else {
        None
    }
}

pub(crate) fn find_current_heartbeat_asset(asset_root: &FsPath) -> Option<PathBuf> {
    let entries = fs::read_dir(asset_root).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("heartbeatSocket-") && name.ends_with(".js"))
                .unwrap_or(false)
        })
}

pub(crate) fn serve_asset_file(path: &FsPath, disable_cache: bool) -> Response {
    match fs::read(path) {
        Ok(content) => (
            [
                (header::CONTENT_TYPE, asset_content_type(path)),
                (
                    header::CACHE_CONTROL,
                    if disable_cache {
                        "no-cache, no-store, must-revalidate"
                    } else {
                        "public, max-age=31536000, immutable"
                    },
                ),
            ],
            content,
        )
            .into_response(),
        Err(error) => ApiResponse::error("asset_unavailable", error.to_string()).into_response(),
    }
}

pub(crate) fn asset_content_type(path: &FsPath) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        _ => "application/octet-stream",
    }
}
