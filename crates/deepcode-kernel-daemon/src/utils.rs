use crate::api_response::ApiResponse;
use crate::prelude::*;
use axum::extract::Request;
use axum::http::request::Parts;
use axum::http::HeaderValue;
use axum::middleware::Next;
use tower_http::cors::AllowOrigin;

pub(crate) fn localhost_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(
            |origin: &HeaderValue, _request: &Parts| trusted_cors_origin(origin),
        ))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::HeaderName::from_static(
                crate::host_admission_v2::HOST_SHELL_CAPABILITY_HEADER_V2,
            ),
            header::HeaderName::from_static(
                crate::provider_trace_api::PROVIDER_TRACE_CAPABILITY_HEADER_V1,
            ),
        ])
        .expose_headers([header::HeaderName::from_static(
            crate::provider_trace_api::PROVIDER_TRACE_DIGEST_HEADER_V1,
        )])
}

pub(crate) async fn trusted_local_origin_gate(request: Request, next: Next) -> Response {
    if crate::session_metadata_v2::trusted_private_storage_origin(request.headers()) {
        return next.run(request).await;
    }
    (
        StatusCode::FORBIDDEN,
        ApiResponse::error(
            "host_origin_forbidden",
            "DeepCode Host APIs accept only non-browser local clients, the same loopback application origin, or deepcode-gui://localhost",
        ),
    )
        .into_response()
}

pub(crate) async fn trusted_host_admission_gate(
    axum::extract::State(authority): axum::extract::State<
        crate::host_admission_v2::HostShellAuthorityV2,
    >,
    request: Request,
    next: Next,
) -> Response {
    if crate::host_admission_v2::route_uses_specialized_transport(
        request.method(),
        request.uri().path(),
    ) || authority.authorize(request.headers())
    {
        return next.run(request).await;
    }
    (
        StatusCode::UNAUTHORIZED,
        ApiResponse::error(
            "host_admission_required",
            "This Host API requires the process-private Host shell admission capability",
        ),
    )
        .into_response()
}

fn trusted_cors_origin(origin: &HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    if origin == "deepcode-gui://localhost" {
        return true;
    }
    origin
        .strip_prefix("http://")
        .map(is_loopback_origin_authority)
        .unwrap_or(false)
}

fn is_loopback_origin_authority(authority: &str) -> bool {
    authority == "localhost"
        || authority.starts_with("localhost:")
        || authority == "127.0.0.1"
        || authority.starts_with("127.0.0.1:")
        || authority == "[::1]"
        || authority.starts_with("[::1]:")
}

pub(crate) fn distribution_root() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

pub(crate) fn env_truthy(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}

pub(crate) fn user_config_root() -> PathBuf {
    if let Some(path) = std::env::var_os("DEEPCODE_CONFIG_DIR") {
        return PathBuf::from(path);
    }
    if env_truthy("DEEPCODE_PORTABLE") {
        return distribution_root()
            .join("config")
            .join("user")
            .join("local");
    }
    if cfg!(windows) {
        if let Some(path) = std::env::var_os("APPDATA") {
            return PathBuf::from(path).join("DeepCode");
        }
    } else if let Some(path) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(path).join("deepcode");
    }
    home_dir()
        .map(|path| {
            if cfg!(windows) {
                path.join("AppData").join("Roaming").join("DeepCode")
            } else {
                path.join(".config").join("deepcode")
            }
        })
        .unwrap_or_else(|| distribution_root().join(".deepcode-user"))
}

pub(crate) struct DriveLocation {
    pub(crate) display: String,
    pub(crate) path: PathBuf,
}

pub(crate) fn platform_id() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        other => other,
    }
}

pub(crate) fn drive_locations() -> Vec<DriveLocation> {
    if !cfg!(windows) {
        return Vec::new();
    }
    ('A'..='Z')
        .filter_map(|letter| {
            let display = format!("{letter}:\\");
            let path = PathBuf::from(&display);
            path.exists().then_some(DriveLocation { display, path })
        })
        .collect()
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

pub(crate) fn read_json_file(path: &PathBuf) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

pub(crate) fn atomic_write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&tmp, content).map_err(|error| format!("write {}: {error}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|error| format!("rename {}: {error}", path.display()))
}

pub(crate) fn safe_path_segment(input: &str) -> String {
    input
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

pub(crate) fn merge_object(target: &mut Value, patch: &Value) {
    let Some(target_object) = target.as_object_mut() else {
        return;
    };
    let Some(patch_object) = patch.as_object() else {
        return;
    };
    for (key, value) in patch_object {
        if value.is_null() {
            target_object.remove(key);
        } else {
            target_object.insert(key.clone(), value.clone());
        }
    }
}

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

pub(crate) fn now_text() -> String {
    now_millis().to_string()
}

pub(crate) fn now_rfc3339_text() -> String {
    let millis = now_millis();
    let seconds = (millis / 1_000) as i64;
    let fractional = (millis % 1_000) as u32;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_date_from_unix_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fractional:03}Z")
}

fn civil_date_from_unix_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}
