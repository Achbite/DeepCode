use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use serde::Serialize;
use serde_json::Value;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
struct AppState {
    daemon_base_url: String,
    client: reqwest::Client,
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

    let daemon_base_url = format!("http://{daemon_host}:{daemon_port}");
    let _daemon_child = spawn_daemon_if_requested(&daemon_host, daemon_port);

    let state = AppState {
        daemon_base_url,
        client: reqwest::Client::new(),
    };

    let mut app = Router::new()
        .route("/", get(gui_index))
        .route("/index.html", get(gui_index))
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

    let app = app.with_state(state).layer(localhost_cors_layer());
    let addr: SocketAddr = format!("{host}:{port}").parse().expect("valid host/port");
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

fn spawn_daemon_if_requested(host: &str, port: u16) -> Option<Child> {
    if std::env::var("DEEPCODE_HOST_WEB_SPAWN_DAEMON").unwrap_or_else(|_| "1".to_string()) == "0" {
        return None;
    }

    let exe = std::env::current_exe().ok()?;
    let daemon = exe
        .parent()
        .map(|parent| {
            parent.join(if cfg!(windows) {
                "deepcode-kernel-daemon.exe"
            } else {
                "deepcode-kernel-daemon"
            })
        })
        .filter(|path| path.is_file())
        .or_else(|| {
            Some(PathBuf::from(if cfg!(windows) {
                "deepcode-kernel-daemon.exe"
            } else {
                "deepcode-kernel-daemon"
            }))
        })?;

    Command::new(daemon)
        .env("DEEPCODE_HOST", host)
        .env("DEEPCODE_PORT", port.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

fn localhost_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::CONTENT_TYPE])
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
    let path = client_dist.join(relative);
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

async fn proxy_health(State(state): State<AppState>) -> Response {
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

async fn proxy_api(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let path_and_query = uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/api/health");
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
    match request.timeout(Duration::from_secs(60)).send().await {
        Ok(response) => proxy_response(response).await,
        Err(error) => {
            ApiResponse::error("kernel_daemon_proxy_failed", error.to_string()).into_response()
        }
    }
}

async fn proxy_response(response: reqwest::Response) -> Response {
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
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
