use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use deepcode_kernel_abi::{
    is_valid_host_instance_id_v2, is_valid_host_shell_capability_v2,
    is_valid_host_ui_capability_v2, HOST_INSTANCE_ID_ENV_V2, HOST_SHELL_CAPABILITY_ENV_V2,
    HOST_SHELL_CAPABILITY_HEADER_V2, HOST_UI_CAPABILITY_ENV_V2, HOST_UI_CAPABILITY_HEADER_V2,
};
use serde::Serialize;
use serde_json::Value;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
struct AppState {
    daemon_base_url: String,
    client: reqwest::Client,
    host_ui_capability: String,
    identity: HostProcessIdentityV2,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostProcessIdentityV2 {
    service: &'static str,
    instance_id: String,
    pid: u32,
    address: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiResponse {
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
    message: Option<String>,
}

impl ApiResponse {
    fn ok(data: Value) -> axum::Json<Self> {
        axum::Json(Self {
            ok: true,
            data: Some(data),
            error: None,
            message: None,
        })
    }

    fn error(code: impl Into<String>, message: impl Into<String>) -> axum::Json<Self> {
        axum::Json(Self {
            ok: false,
            data: None,
            error: Some(code.into()),
            message: Some(message.into()),
        })
    }
}

#[tokio::main]
async fn main() {
    let host = std::env::var("DEEPCODE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DEEPCODE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(31245);
    let daemon_host =
        std::env::var("DEEPCODE_DAEMON_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let daemon_port = std::env::var("DEEPCODE_DAEMON_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or_else(|| port.saturating_add(1));
    assert!(
        is_loopback_host(&host) && is_loopback_host(&daemon_host),
        "DeepCode Host proxy and daemon targets must both be loopback"
    );
    let daemon_base_url = format!("http://{daemon_host}:{daemon_port}");
    assert!(
        std::env::var("DEEPCODE_HOST_WEB_SPAWN_DAEMON").as_deref() == Ok("0"),
        "DeepCode Host proxy must be launched by the owning Host process with DEEPCODE_HOST_WEB_SPAWN_DAEMON=0"
    );
    let host_ui_capability =
        required_authority_value(HOST_UI_CAPABILITY_ENV_V2, is_valid_host_ui_capability_v2);
    let daemon_host_capability = required_authority_value(
        HOST_SHELL_CAPABILITY_ENV_V2,
        is_valid_host_shell_capability_v2,
    );
    assert!(
        host_ui_capability != daemon_host_capability,
        "Host UI and daemon capabilities must be independent"
    );
    let instance_id = required_instance_id();
    let addr: SocketAddr = format!("{host}:{port}").parse().expect("valid host/port");
    assert!(
        addr.ip().is_loopback(),
        "DeepCode Host private API requires a loopback listener"
    );

    let state = AppState {
        daemon_base_url,
        client: daemon_client(&daemon_host_capability),
        host_ui_capability,
        identity: HostProcessIdentityV2 {
            service: "deepcode-host-web",
            instance_id,
            pid: std::process::id(),
            address: format!("http://{addr}"),
        },
    };

    let mut app = Router::new()
        .route("/", get(gui_index))
        .route("/index.html", get(gui_index))
        .route("/api/host/identity", get(proxy_identity))
        .route("/api/health", get(proxy_health))
        .route("/api/*path", any(proxy_api))
        .route("/assets/*asset_path", get(gui_asset));

    if let Some(client_dist) = client_dist_dir() {
        let index_path = client_dist.join("index.html");
        app = app.fallback_service(
            ServeDir::new(client_dist.clone()).not_found_service(ServeFile::new(index_path)),
        );
        println!(
            "DeepCode dev Host GUI assets served from {}",
            client_dist.display()
        );
    }

    let app = app
        .with_state(state)
        .layer(localhost_cors_layer())
        .layer(axum::middleware::from_fn(trusted_local_origin_gate));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind deepcode dev host");
    println!("DeepCode dev Host listening on http://{addr}");
    println!(
        "DeepCode dev Host proxies /api/* to Kernel daemon at http://{daemon_host}:{daemon_port}"
    );
    axum::serve(listener, app)
        .await
        .expect("serve deepcode dev host");
}

fn localhost_cors_layer() -> CorsLayer {
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
            header::HeaderName::from_static(HOST_UI_CAPABILITY_HEADER_V2),
        ])
}

async fn trusted_local_origin_gate(request: Request, next: Next) -> Response {
    if trusted_local_origin(request.headers()) {
        return next.run(request).await;
    }
    (
        StatusCode::FORBIDDEN,
        ApiResponse::error(
            "host_origin_forbidden",
            "DeepCode Host APIs accept only non-browser local clients, the same loopback application origin, or a trusted DeepCode desktop origin",
        ),
    )
        .into_response()
}

fn trusted_local_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return true;
    };
    if trusted_desktop_origin(origin) {
        return true;
    }
    let Some(origin_authority) = origin.strip_prefix("http://") else {
        return false;
    };
    let Some(request_authority) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    origin_authority == request_authority && is_loopback_authority(origin_authority)
}

fn trusted_cors_origin(origin: &HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    if trusted_desktop_origin(origin) {
        return true;
    }
    origin
        .strip_prefix("http://")
        .map(is_loopback_authority)
        .unwrap_or(false)
}

fn trusted_desktop_origin(origin: &str) -> bool {
    matches!(
        origin,
        "deepcode-gui://localhost"
            | "deepcode-editor://localhost"
            | "http://deepcode-gui.localhost"
            | "http://deepcode-editor.localhost"
    )
}

fn is_loopback_authority(authority: &str) -> bool {
    authority == "localhost"
        || authority.starts_with("localhost:")
        || authority == "127.0.0.1"
        || authority.starts_with("127.0.0.1:")
        || authority == "[::1]"
        || authority.starts_with("[::1]:")
}

fn client_dist_dir() -> Option<PathBuf> {
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

async fn gui_index() -> Response {
    let Some(client_dist) = client_dist_dir() else {
        return ApiResponse::error(
            "gui_not_configured",
            "DEEPCODE_CLIENT_DIST is not configured",
        )
        .into_response();
    };
    let index_path = client_dist.join("index.html");
    match tokio::fs::read(index_path).await {
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

async fn gui_asset(State(_state): State<AppState>, uri: Uri) -> Response {
    let Some(client_dist) = client_dist_dir() else {
        return ApiResponse::error(
            "gui_not_configured",
            "DEEPCODE_CLIENT_DIST is not configured",
        )
        .into_response();
    };
    let relative = uri.path().trim_start_matches('/');
    let relative_path = Path::new(relative);
    if relative_path
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(client_dist) = tokio::fs::canonicalize(client_dist).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(path) = tokio::fs::canonicalize(client_dist.join(relative_path)).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !path.starts_with(&client_dist) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read(&path).await {
        Ok(content) => {
            let content_type = if path.extension().and_then(|value| value.to_str()) == Some("js") {
                "application/javascript"
            } else if path.extension().and_then(|value| value.to_str()) == Some("css") {
                "text/css"
            } else {
                "application/octet-stream"
            };
            ([(header::CONTENT_TYPE, content_type)], content).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn proxy_health(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !state.authorizes_host_request(&headers) {
        return host_admission_rejected();
    }
    match state
        .client
        .get(format!("{}/api/health", state.daemon_base_url))
        .timeout(Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => proxy_response(response).await,
        Err(error) => ApiResponse::error(
            "kernel_daemon_unavailable",
            format!("Kernel daemon is not reachable: {error}"),
        )
        .into_response(),
    }
}

async fn proxy_identity(State(state): State<AppState>) -> axum::Json<ApiResponse> {
    ApiResponse::ok(
        serde_json::to_value(&state.identity).expect("Host proxy identity must serialize"),
    )
}

async fn proxy_api(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !state.authorizes_host_request(&headers) {
        return host_admission_rejected();
    }
    let path_and_query = uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/api/health");
    if !host_proxy_path_allowed(method.as_str(), uri.path()) {
        return (
            StatusCode::NOT_FOUND,
            ApiResponse::error(
                "host_proxy_route_forbidden",
                "This transport is not exposed through the Host UI proxy",
            ),
        )
            .into_response();
    }
    let url = format!("{}{}", state.daemon_base_url, path_and_query);
    let body_bytes = match axum::body::to_bytes(body, 16 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return ApiResponse::error("proxy_body_read_failed", error.to_string()).into_response();
        }
    };
    let reqwest_method =
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut request = state.client.request(reqwest_method, url).body(body_bytes);
    if let Some(content_type) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    {
        request = request.header(reqwest::header::CONTENT_TYPE, content_type);
    }
    let request = if method == Method::GET && uri.path().ends_with("/stream") {
        request
    } else {
        request.timeout(Duration::from_secs(60))
    };
    match request.send().await {
        Ok(response) => proxy_response(response).await,
        Err(error) => {
            ApiResponse::error("kernel_daemon_proxy_failed", error.to_string()).into_response()
        }
    }
}

impl AppState {
    fn authorizes_host_request(&self, headers: &HeaderMap) -> bool {
        let Some(submitted) = headers
            .get(HOST_UI_CAPABILITY_HEADER_V2)
            .and_then(|value| value.to_str().ok())
        else {
            return false;
        };
        constant_time_eq(submitted.as_bytes(), self.host_ui_capability.as_bytes())
    }
}

fn host_proxy_path_allowed(method: &str, path: &str) -> bool {
    if method == Method::OPTIONS.as_str() {
        return true;
    }
    let segments = path
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    match (method, segments.as_slice()) {
        ("GET", ["api", "health"])
        | ("GET", ["api", "workspaces", "current"])
        | ("GET", ["api", "workspaces", "default-path"])
        | ("POST", ["api", "workspaces", "open"])
        | ("POST", ["api", "workspaces", "save-file"])
        | ("PATCH", ["api", "workspaces", "current", "settings"])
        | ("GET", ["api", "fs", "initial-locations"])
        | ("GET", ["api", "fs", "browse"])
        | ("POST", ["api", "host", "inspect"])
        | ("POST", ["api", "host", "skills", "scan-mount"])
        | ("GET", ["api", "host", "skills"])
        | ("GET", ["api", "user-settings"])
        | ("PATCH", ["api", "user-settings"])
        | ("GET", ["api", "llm", "profiles"])
        | ("PATCH", ["api", "llm", "profiles"])
        | ("POST", ["api", "llm", "probe"])
        | ("GET", ["api", "runtime", "shell"])
        | ("GET", ["api", "terminal", "capabilities"])
        | ("GET", ["api", "terminal", "warmup"])
        | ("POST", ["api", "terminal", "warmup"])
        | ("GET", ["api", "terminal", "sessions"])
        | ("POST", ["api", "terminal", "sessions"])
        | ("GET", ["api", "terminal", "events"])
        | ("GET", ["api", "agent", "sessions"])
        | ("POST", ["api", "agent", "sessions"])
        | ("GET", ["api", "agent", "projects"])
        | ("POST", ["api", "agent", "projects"])
        | ("GET", ["api", "agent", "sessions", "current"])
        | ("GET", ["api", "browser", "runtime-status"])
        | ("POST", ["api", "browser", "open"])
        | ("POST", ["api", "browser", "reload"])
        | ("POST", ["api", "browser", "inspect-mode"]) => true,
        ("POST", ["api", "terminal", "sessions", _, "input"])
        | ("POST", ["api", "terminal", "sessions", _, "resize"])
        | ("POST", ["api", "terminal", "sessions", _, "restart"])
        | ("PATCH", ["api", "terminal", "sessions", _])
        | ("DELETE", ["api", "terminal", "sessions", _])
        | ("GET", ["api", "agent", "projects", _])
        | ("PATCH", ["api", "agent", "projects", _])
        | ("DELETE", ["api", "agent", "projects", _])
        | ("POST", ["api", "agent", "projects", _, "rebind"])
        | ("POST", ["api", "agent", "sessions", _, "activate"])
        | ("POST", ["api", "agent", "sessions", _, "archive"])
        | ("POST", ["api", "agent", "sessions", _, "runs"])
        | ("GET", ["api", "agent", "sessions", _, "timeline"])
        | ("GET", ["api", "agent", "sessions", _])
        | ("PATCH", ["api", "agent", "sessions", _])
        | ("DELETE", ["api", "agent", "sessions", _])
        | ("GET", ["api", "agent", "sessions", _, "runs", _])
        | ("POST", ["api", "agent", "sessions", _, "runs", _, "cancel"])
        | ("POST", ["api", "agent", "sessions", _, "runs", _, "guidance"])
        | ("POST", ["api", "agent", "sessions", _, "runs", _, "authority", "revoke"])
        | ("GET", ["api", "agent", "sessions", _, "timeline", "stream"]) => true,
        _ => false,
    }
}

fn host_admission_rejected() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        ApiResponse::error(
            "host_admission_required",
            "This Host proxy requires its process-private Host UI admission capability",
        ),
    )
        .into_response()
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host.trim(), "127.0.0.1" | "::1" | "localhost")
}

fn required_authority_value(environment_key: &str, validator: fn(&str) -> bool) -> String {
    let value =
        std::env::var(environment_key).unwrap_or_else(|_| panic!("{environment_key} is required"));
    assert!(validator(&value), "{environment_key} is malformed");
    value
}

fn required_instance_id() -> String {
    let instance_id = std::env::var(HOST_INSTANCE_ID_ENV_V2)
        .unwrap_or_else(|_| panic!("{HOST_INSTANCE_ID_ENV_V2} is required"));
    assert!(
        is_valid_host_instance_id_v2(&instance_id),
        "{HOST_INSTANCE_ID_ENV_V2} is malformed"
    );
    instance_id
}

fn daemon_client(host_shell_capability: &str) -> reqwest::Client {
    let mut capability_header = reqwest::header::HeaderValue::from_str(host_shell_capability)
        .expect("validated Host shell capability must be an HTTP header value");
    capability_header.set_sensitive(true);
    let mut default_headers = reqwest::header::HeaderMap::new();
    default_headers.insert(
        reqwest::header::HeaderName::from_static(HOST_SHELL_CAPABILITY_HEADER_V2),
        capability_header,
    );
    reqwest::Client::builder()
        .default_headers(default_headers)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .expect("build private Host-to-Kernel client")
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let maximum = left.len().max(right.len());
    for index in 0..maximum {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

async fn proxy_response(response: reqwest::Response) -> Response {
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let cache_control = response
        .headers()
        .get(reqwest::header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let content_type_options = response
        .headers()
        .get("x-content-type-options")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if content_type
        .as_deref()
        .is_some_and(|value| value.starts_with("text/event-stream"))
    {
        let mut builder = Response::builder().status(status);
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        if let Some(cache_control) = cache_control {
            builder = builder.header(header::CACHE_CONTROL, cache_control);
        }
        if let Some(content_type_options) = content_type_options {
            builder = builder.header("x-content-type-options", content_type_options);
        }
        return builder
            .body(Body::from_stream(response.bytes_stream()))
            .unwrap_or_else(|error| {
                ApiResponse::error("proxy_response_build_failed", error.to_string()).into_response()
            });
    }
    match response.bytes().await {
        Ok(bytes) => {
            let mut builder = Response::builder().status(status);
            if let Some(content_type) = content_type {
                builder = builder.header(header::CONTENT_TYPE, content_type);
            }
            builder.body(Body::from(bytes)).unwrap_or_else(|error| {
                ApiResponse::error("proxy_response_build_failed", error.to_string()).into_response()
            })
        }
        Err(error) => {
            ApiResponse::error("proxy_response_read_failed", error.to_string()).into_response()
        }
    }
}
