//! Physical native page owner. This module never advances a Session or executes a
//! tool policy: Kernel invokes the same exact page operations as the GUI controls.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, WebviewUrl};
#[cfg(target_os = "macos")]
mod computer_macos;
mod services;

static PAGE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBinding {
    pub host_instance_id: String,
    pub window_label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    #[serde(flatten)]
    binding: HostBinding,
    preview_id: String,
    url: String,
    status: String,
    visible: bool,
    service_owner: String,
    session_id: Option<String>,
    service_id: Option<String>,
    kind: String,
}

impl Page {
    fn matches_target(
        &self,
        session_id: &Option<String>,
        url: &str,
        service_id: &Option<String>,
        kind: &str,
    ) -> bool {
        self.session_id == *session_id
            && self.url == url
            && self.service_id == *service_id
            && self.kind == kind
    }
}

pub struct NativeBrowser {
    directories: deepcode_host_connection::UserDirectories,
    binding: HostBinding,
    pages: Mutex<HashMap<String, Page>>,
    page_changed: Condvar,
    opening: tauri::async_runtime::Mutex<()>,
    stop: Arc<AtomicBool>,
    services: Mutex<HashMap<String, services::DevelopmentService>>,
    self_bootstrap: String,
    on_stop: Box<dyn Fn() + Send + Sync>,
}

impl NativeBrowser {
    pub fn stop(&self) {
        if self.stop.swap(true, Ordering::AcqRel) {
            return;
        }
        (self.on_stop)();
        if let Ok(mut services) = self.services.lock() {
            services.clear();
        }
    }
}

pub fn start(
    app: &tauri::AppHandle,
    directories: deepcode_host_connection::UserDirectories,
    host_instance_id: String,
    token: String,
    self_bootstrap: String,
    on_stop: Box<dyn Fn() + Send + Sync>,
) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let endpoint = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .to_string();
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    app.manage(NativeBrowser {
        directories,
        binding: HostBinding {
            host_instance_id,
            window_label: "main".into(),
        },
        pages: Mutex::new(HashMap::new()),
        page_changed: Condvar::new(),
        opening: tauri::async_runtime::Mutex::new(()),
        stop: Arc::clone(&stop),
        services: Mutex::new(HashMap::new()),
        self_bootstrap,
        on_stop,
    });
    let app = app.clone();
    std::thread::spawn(move || {
        while !stop.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let app = app.clone();
                    let token = token.clone();
                    std::thread::spawn(move || serve_connection(app, stream, &token));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(40))
                }
                Err(_) => break,
            }
        }
    });
    Ok(endpoint)
}

fn serve_connection(app: tauri::AppHandle, mut stream: TcpStream, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut line = String::new();
    let read = BufReader::new((&stream).take(1024 * 1024)).read_line(&mut line);
    let response = read.map_err(|error| error.to_string()).and_then(|_| {
        let request: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        if request.get("token").and_then(Value::as_str) != Some(token) {
            return Err("native_browser_connection_rejected".into());
        }
        tauri::async_runtime::block_on(execute(
            app,
            request["binding"].clone(),
            request["input"].clone(),
        ))
    });
    let envelope = match response {
        Ok(data) => json!({"ok":true,"data":data}),
        Err(message) => json!({"ok":false,"message":message}),
    };
    if let Ok(mut encoded) = serde_json::to_vec(&envelope) {
        encoded.push(b'\n');
        let _ = stream.write_all(&encoded);
    }
}

#[tauri::command]
pub fn deepcode_browser_host(
    app: tauri::AppHandle,
    webview: tauri::Webview,
) -> Result<HostBinding, String> {
    require_main(&webview)?;
    Ok(app.state::<NativeBrowser>().binding.clone())
}

#[tauri::command]
pub async fn deepcode_browser_command(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    binding: Value,
    input: Value,
) -> Result<Value, String> {
    require_main(&webview)?;
    if input["action"]
        .as_str()
        .is_some_and(|action| action.starts_with("computer:"))
    {
        return Err("Computer control requires a Kernel-approved tool call.".into());
    }
    execute(app, binding, input).await
}

fn require_main(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Browser controls belong to the primary GUI view.".into());
    }
    Ok(())
}

fn checked_binding(app: &tauri::AppHandle, binding: &Value) -> Result<HostBinding, String> {
    let state = app.state::<NativeBrowser>();
    let expected = &state.binding;
    if binding["hostInstanceId"].as_str() != Some(expected.host_instance_id.as_str())
        || binding["windowLabel"].as_str() != Some(expected.window_label.as_str())
    {
        return Err("native_browser_host_binding_mismatch".into());
    }
    Ok(expected.clone())
}

fn string<'a>(input: &'a Value, field: &str) -> Result<&'a str, String> {
    input
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{field} is required"))
}

fn page_state(app: &tauri::AppHandle, preview_id: &str) -> Result<Page, String> {
    let state = app.state::<NativeBrowser>();
    let pages = state
        .pages
        .lock()
        .map_err(|_| "native_browser_state_unavailable")?;
    pages
        .get(preview_id)
        .cloned()
        .ok_or_else(|| format!("native_browser_page_closed: {preview_id}"))
}

fn publish(app: &tauri::AppHandle, page: &Page) {
    let _ = app.emit_to("main", "deepcode:browser-page", page);
}

async fn activate(app: tauri::AppHandle, page: Page) -> Result<Value, String> {
    app.emit_to("main", "deepcode:browser-activate", &page)
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<NativeBrowser>();
        let pages = state.pages.lock().map_err(|_| "native_browser_state_unavailable")?;
        let (pages, _) = state.page_changed.wait_timeout_while(pages, Duration::from_secs(5), |pages| {
            pages.get(&page.preview_id).is_some_and(|page| !page.visible)
        }).map_err(|_| "native_browser_state_unavailable")?;
        let page = pages.get(&page.preview_id).ok_or_else(|| format!("native_browser_page_closed: {}", page.preview_id))?;
        if !page.visible {
            return Err(format!("native_browser_page_not_visible: {}; select this session and close any dialog covering the Reader", page.preview_id));
        }
        serde_json::to_value(page).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

fn page_url(input: &Value) -> Result<tauri::Url, String> {
    if let Some(path) = input.get("filePath").and_then(Value::as_str) {
        let path = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| format!("Browser file: {error}"))?;
        if !path.is_file() {
            return Err("Browser target is not a file.".into());
        }
        return tauri::Url::from_file_path(path).map_err(|_| "Invalid browser file path.".into());
    }
    let url = tauri::Url::parse(string(input, "url")?).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(
            "Browser URLs require HTTP or HTTPS; use filePath for a local HTML file.".into(),
        );
    }
    Ok(url)
}

/// Every operation names an exact Host/window; existing page operations also
/// require an exact preview id. No lookup by the most recently focused window.
pub async fn execute(app: tauri::AppHandle, binding: Value, input: Value) -> Result<Value, String> {
    let session_id = binding["sessionId"].as_str().map(str::to_string);
    let tool_request = binding["runId"].is_string();
    let binding = checked_binding(&app, &binding)?;
    let action = string(&input, "action")?;
    if action.starts_with("computer:") {
        #[cfg(target_os = "macos")]
        return computer_macos::execute(&input);
        #[cfg(not(target_os = "macos"))]
        return Err("External computer control currently requires a macOS GUI Host.".into());
    }
    if action.starts_with("service") {
        let directory = app
            .state::<NativeBrowser>()
            .directories
            .log_dir
            .join("development-services")
            .join(&binding.host_instance_id);
        let state = app.state::<NativeBrowser>();
        let mut services = state
            .services
            .lock()
            .map_err(|_| "native_browser_state_unavailable")?;
        return services::execute(&mut services, directory, session_id.as_deref(), &input);
    }
    if action == "hostStatus" {
        return Ok(
            json!({"binding":binding,"ready":true,"captureAvailable":cfg!(target_os="macos")}),
        );
    }
    if action == "list" {
        let pages = app
            .state::<NativeBrowser>()
            .pages
            .lock()
            .map_err(|_| "native_browser_state_unavailable")?
            .values()
            .filter(|page| session_id.is_none() || page.session_id == session_id)
            .cloned()
            .collect::<Vec<_>>();
        return Ok(json!({"pages":pages}));
    }
    if matches!(action, "open" | "openSelf") {
        let state = app.state::<NativeBrowser>();
        let opening = state.opening.lock().await;
        let service_id = input["serviceId"].as_str().map(str::to_string);
        let url = if action == "openSelf" {
            tauri::Url::parse("deepcode-gui://localhost/index.html")
                .map_err(|error| error.to_string())?
        } else if let Some(service_id) = service_id.as_deref() {
            let state = app.state::<NativeBrowser>();
            let services = state
                .services
                .lock()
                .map_err(|_| "native_browser_state_unavailable")?;
            let service = services
                .get(service_id)
                .ok_or("Development service is not owned by this Host.")?;
            if session_id.is_some()
                && service.description["sessionId"].as_str() != session_id.as_deref()
            {
                return Err("native_browser_service_session_mismatch".into());
            }
            page_url(&service.description)?
        } else {
            page_url(&input)?
        };
        let kind = if action == "openSelf" {
            "deepcode"
        } else {
            "page"
        };
        let existing = state
            .pages
            .lock()
            .map_err(|_| "native_browser_state_unavailable")?
            .values()
            .find(|page| page.matches_target(&session_id, url.as_str(), &service_id, kind))
            .cloned();
        if let Some(page) = existing {
            drop(opening);
            return if tool_request {
                activate(app.clone(), page).await
            } else {
                serde_json::to_value(page).map_err(|error| error.to_string())
            };
        }
        let id = format!("preview-{}", PAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed));
        let page = Page {
            binding: binding.clone(),
            preview_id: id.clone(),
            url: url.to_string(),
            status: "loading".into(),
            visible: false,
            service_owner: if service_id.is_some() {
                "host"
            } else if action == "openSelf" {
                "sharedHost"
            } else if url.scheme() == "file" {
                "file"
            } else {
                "external"
            }
            .into(),
            session_id,
            service_id,
            kind: kind.into(),
        };
        app.state::<NativeBrowser>()
            .pages
            .lock()
            .map_err(|_| "native_browser_state_unavailable")?
            .insert(id.clone(), page.clone());
        let app_for_create = app.clone();
        let id_for_create = id.clone();
        let self_bootstrap =
            (action == "openSelf").then(|| app.state::<NativeBrowser>().self_bootstrap.clone());
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let outcome = (|| {
                let window = app_for_create
                    .get_window(&binding.window_label)
                    .ok_or("native_browser_window_closed")?;
                let mut builder =
                    tauri::webview::WebviewBuilder::new(&id_for_create, WebviewUrl::External(url))
                        .data_directory(
                            app_for_create
                                .state::<NativeBrowser>()
                                .directories
                                .cache_dir
                                .join("webview"),
                        )
                        .on_page_load(|webview, payload| {
                            let app = webview.app_handle();
                            let state = app.state::<NativeBrowser>();
                            if let Ok(mut pages) = state.pages.lock() {
                                if let Some(page) = pages.get_mut(webview.label()) {
                                    page.url = payload.url().to_string();
                                    page.status = match payload.event() {
                                        tauri::webview::PageLoadEvent::Started => "loading",
                                        tauri::webview::PageLoadEvent::Finished => "ready",
                                    }
                                    .into();
                                    publish(app, page);
                                }
                            };
                        });
                if let Some(script) = self_bootstrap {
                    builder = builder.initialization_script(script).on_navigation(|url| {
                        (url.scheme() == "deepcode-gui" && url.host_str() == Some("localhost"))
                            || (url.scheme() == "about" && matches!(url.path(), "srcdoc" | "blank"))
                    });
                }
                let view = window
                    .add_child(
                        builder,
                        tauri::LogicalPosition::new(0.0, 0.0),
                        tauri::LogicalSize::new(1.0, 1.0),
                    )
                    .map_err(|error| error.to_string())?;
                view.hide().map_err(|error| error.to_string())?;
                Ok::<_, String>(())
            })();
            let _ = tx.send(outcome);
        })
        .map_err(|error| error.to_string())?;
        let created = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(Duration::from_secs(15))
                .map_err(|error| error.to_string())?
        })
        .await
        .map_err(|error| error.to_string())?;
        if let Err(error) = created {
            app.state::<NativeBrowser>()
                .pages
                .lock()
                .map_err(|_| "native_browser_state_unavailable")?
                .remove(&id);
            return Err(error);
        }
        let page = page_state(&app, &id)?;
        publish(&app, &page);
        drop(opening);
        if tool_request {
            return activate(app.clone(), page).await;
        }
        return serde_json::to_value(page).map_err(|error| error.to_string());
    }
    let id = string(&input, "previewId")?;
    let mut page = page_state(&app, id)?;
    if session_id.is_some() && page.session_id != session_id {
        return Err("native_browser_page_session_mismatch".into());
    }
    let view = app.get_webview(id).ok_or("native_browser_page_closed")?;
    match action {
        "activate" => return activate(app.clone(), page).await,
        "reviewStart" => {
            if !page.visible {
                return Err("Open the page before annotating it.".into());
            }
            let options = json!({"labels": input["labels"], "annotation": input["annotation"], "reviewId": input["reviewId"]});
            return eval(view, format!("{}({options})", include_str!("review.js"))).await;
        }
        "reviewRead" => {
            return eval(view, "JSON.parse(JSON.stringify({active:Boolean(window.__deepcodeReview?.active),exitReason:window.__deepcodeReview?.exitReason??null,pending:window.__deepcodeReview?.pending??null}))".into()).await;
        }
        "reviewAcknowledge" => {
            let id =
                serde_json::to_string(string(&input, "id")?).map_err(|error| error.to_string())?;
            return eval(
                view,
                format!(
                    "(()=>{{window.__deepcodeReview?.acknowledge({id});return {{ok:true}}}})()"
                ),
            )
            .await;
        }
        "reviewEnd" => {
            let review_id =
                serde_json::to_string(&input["reviewId"]).map_err(|error| error.to_string())?;
            return eval(
                view,
                format!("(()=>{{const state=window.__deepcodeReview;if(state?.reviewId==={review_id})state.dispose();return {{active:Boolean(window.__deepcodeReview?.active)}}}})()"),
            )
            .await;
        }
        "status" => {
            return serde_json::to_value(page).map_err(|error| error.to_string());
        }
        "navigate" => {
            if page.kind == "deepcode" {
                return Err("The DeepCode preview remains connected to its original Host; open a separate page to navigate.".into());
            }
            let url = page_url(&input)?;
            {
                let state = app.state::<NativeBrowser>();
                let mut pages = state
                    .pages
                    .lock()
                    .map_err(|_| "native_browser_state_unavailable")?;
                let current = pages.get_mut(id).ok_or("native_browser_page_closed")?;
                current.url = url.to_string();
                current.status = "loading".into();
            }
            view.navigate(url).map_err(|error| error.to_string())?;
        }
        "reload" => {
            app.state::<NativeBrowser>()
                .pages
                .lock()
                .map_err(|_| "native_browser_state_unavailable")?
                .get_mut(id)
                .ok_or("native_browser_page_closed")?
                .status = "loading".into();
            view.reload().map_err(|error| error.to_string())?;
        }
        "layout" => {
            let visible = input["visible"].as_bool().ok_or("visible is required")?;
            if visible {
                let coordinate = |field: &str| {
                    input[field]
                        .as_f64()
                        .filter(|n| n.is_finite() && *n >= 0.0)
                        .ok_or_else(|| format!("Invalid browser {field}"))
                };
                let (x, y, width, height) = (
                    coordinate("x")?,
                    coordinate("y")?,
                    coordinate("width")?,
                    coordinate("height")?,
                );
                if width < 1.0 || height < 1.0 {
                    return Err("Browser bounds are empty.".into());
                }
                view.set_bounds(tauri::Rect {
                    position: tauri::LogicalPosition::new(x, y).into(),
                    size: tauri::LogicalSize::new(width, height).into(),
                })
                .map_err(|error| error.to_string())?;
                view.show().map_err(|error| error.to_string())?;
            } else {
                view.hide().map_err(|error| error.to_string())?;
            }
            app.state::<NativeBrowser>()
                .pages
                .lock()
                .map_err(|_| "native_browser_state_unavailable")?
                .get_mut(id)
                .ok_or("native_browser_page_closed")?
                .visible = visible;
            app.state::<NativeBrowser>().page_changed.notify_all();
        }
        "focus" => {
            view.set_focus().map_err(|error| error.to_string())?;
        }
        "act" => {
            let operation = string(&input, "operation")?;
            let selector = serde_json::to_string(input.get("selector").unwrap_or(&Value::Null))
                .map_err(|error| error.to_string())?;
            let text = serde_json::to_string(input.get("text").unwrap_or(&Value::Null))
                .map_err(|error| error.to_string())?;
            let code = match operation {
                "click" => format!("const e=document.querySelector({selector});if(!e)throw Error('Element not found');e.click();return {{clicked:true}};"),
                "type" => format!("const e=document.querySelector({selector});if(!(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement))throw Error('Element is not a text input');e.focus();const p=e instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,{text});e.dispatchEvent(new Event('input',{{bubbles:true}}));e.dispatchEvent(new Event('change',{{bubbles:true}}));return {{typed:true}};"),
                "scroll" => format!("window.scrollBy({x},{y});return {{x:scrollX,y:scrollY}};",x=input["x"].as_f64().unwrap_or(0.0),y=input["y"].as_f64().unwrap_or(0.0)),
                "inspect" => include_str!("observe.js").into(),
                _ => return Err("Unsupported browser operation.".into()),
            };
            let result = eval(view, format!("(()=>{{try{{const data=(()=>{{{code}}})();return {{ok:true,data}}}}catch(e){{return {{ok:false,message:String(e)}}}}}})()")).await?;
            if result["ok"].as_bool() != Some(true) {
                return Err(result["message"]
                    .as_str()
                    .unwrap_or("Browser operation failed.")
                    .into());
            }
            return Ok(json!({"page":page,"result":result["data"]}));
        }
        "capture" => {
            if !page.visible {
                return Err(format!(
                    "Cannot capture a hidden page; activate previewId {id} first."
                ));
            }
            page.url = view.url().map_err(|error| error.to_string())?.to_string();
            let capture = capture(view).await?;
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_millis();
            let directory = match input.get("captureDirectory").and_then(Value::as_str) {
                Some(path) => PathBuf::from(path),
                None => app
                    .state::<NativeBrowser>()
                    .directories
                    .cache_dir
                    .join("browser-captures")
                    .join(&binding.host_instance_id),
            };
            std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            let path = directory.join(format!(
                "{id}-{stamp}-{}.png",
                PAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .map_err(|error| error.to_string())?;
            file.write_all(&capture.bytes)
                .map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            return Ok(
                json!({"contentRef":path,"contentType":"image/png","width":capture.width,"height":capture.height,"sourcePage":{"hostInstanceId":binding.host_instance_id,"windowLabel":binding.window_label,"previewId":id,"url":page.url,"capturedAt":stamp.to_string(),"range":"viewport"}}),
            );
        }
        "close" => {
            view.close().map_err(|error| error.to_string())?;
            app.state::<NativeBrowser>()
                .pages
                .lock()
                .map_err(|_| "native_browser_state_unavailable")?
                .remove(id);
            app.state::<NativeBrowser>().page_changed.notify_all();
            page.status = "closed".into();
            page.visible = false;
            publish(&app, &page);
            return Ok(json!({"previewId":id,"status":"closed"}));
        }
        _ => return Err(format!("Unsupported browser action: {action}")),
    }
    // Page-load callbacks own navigation state. A layout/focus request must not
    // restore an older cloned URL or status after one of those callbacks.
    let page = page_state(&app, id)?;
    if action != "layout" {
        publish(&app, &page);
    }
    serde_json::to_value(page).map_err(|error| error.to_string())
}

async fn eval(view: tauri::Webview, script: String) -> Result<Value, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    view.eval_with_callback(script, move |value| {
        let _ = tx.send(value);
    })
    .map_err(|error| error.to_string())?;
    let value =
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(10)))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
    serde_json::from_str(&value).map_err(|error| format!("Browser evaluation: {error}"))
}

struct Capture {
    bytes: Vec<u8>,
    width: i64,
    height: i64,
}

#[cfg(target_os = "macos")]
async fn capture(view: tauri::Webview) -> Result<Capture, String> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |platform| unsafe {
        let webview = &*(platform.inner() as *const WKWebView);
        let completion = block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let outcome = (|| {
                if let Some(error) = error.as_ref() {
                    return Err(error.localizedDescription().to_string());
                }
                let image = image
                    .as_ref()
                    .ok_or("WKWebView returned no snapshot image")?;
                let tiff = image
                    .TIFFRepresentation()
                    .ok_or("Snapshot image encoding failed")?;
                let bitmap = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)
                    .ok_or("Snapshot bitmap encoding failed")?;
                let data = bitmap
                    .representationUsingType_properties(
                        NSBitmapImageFileType::PNG,
                        &NSDictionary::new(),
                    )
                    .ok_or("Snapshot PNG encoding failed")?;
                Ok(Capture {
                    bytes: data.to_vec(),
                    width: bitmap.pixelsWide() as i64,
                    height: bitmap.pixelsHigh() as i64,
                })
            })();
            let _ = tx.send(outcome);
        });
        webview.takeSnapshotWithConfiguration_completionHandler(None, &completion);
    })
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(15))
            .map_err(|error| error.to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(not(target_os = "macos"))]
async fn capture(_view: tauri::Webview) -> Result<Capture, String> {
    Err("Native viewport capture is not implemented for this platform.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_reuse_preserves_resource_and_session_identity() {
        let page = Page {
            binding: HostBinding {
                host_instance_id: "host".into(),
                window_label: "main".into(),
            },
            preview_id: "preview-1".into(),
            url: "file:///input/interactive-test.html".into(),
            session_id: Some("session:one".into()),
            service_id: None,
            kind: "page".into(),
            service_owner: "file".into(),
            status: "ready".into(),
            visible: false,
        };
        assert!(
            page.matches_target(&page.session_id, &page.url, &None, "page"),
            "a hidden user page can be reused by a tool"
        );
        assert!(!page.matches_target(&Some("session:two".into()), &page.url, &None, "page"));
        assert!(!page.matches_target(
            &page.session_id,
            "file:///project/interactive-test.html",
            &None,
            "page"
        ));
        assert!(!page.matches_target(
            &page.session_id,
            &page.url,
            &Some("service:one".into()),
            "page"
        ));
        assert!(!page.matches_target(&page.session_id, &page.url, &None, "deepcode"));
    }
}
