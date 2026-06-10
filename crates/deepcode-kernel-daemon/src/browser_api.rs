#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

pub(crate) async fn browser_status(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(browser_status_payload(&gui.browser))
}

pub(crate) async fn browser_open(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let url = body
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("http://127.0.0.1:31249/")
        .to_string();
    update_browser_action(&mut gui.browser, "open", "ok");
    gui.browser.current_url = Some(url);
    ApiResponse::ok(browser_status_payload(&gui.browser))
}

pub(crate) async fn browser_reload(State(state): State<AppState>) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    update_browser_action(&mut gui.browser, "reload", "ok");
    ApiResponse::ok(browser_status_payload(&gui.browser))
}

pub(crate) async fn browser_inspect_mode(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    gui.browser.inspect_state = body
        .get("inspectState")
        .and_then(Value::as_str)
        .unwrap_or("off")
        .to_string();
    update_browser_action(&mut gui.browser, "inspect", "ok");
    ApiResponse::ok(browser_status_payload(&gui.browser))
}

pub(crate) async fn browser_panel_snapshot(State(state): State<AppState>) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    update_browser_action(&mut gui.browser, "snapshot", "reserved");
    if gui.browser.snapshot.is_none() {
        gui.browser.snapshot = Some(default_panel_snapshot(gui.browser.current_url.as_deref()));
    }
    ApiResponse::ok(json!({
        "snapshot": gui.browser.snapshot,
        "message": "Panel snapshot capture is reserved in packaged Kernel Daemon; diagnostic snapshot returned."
    }))
}

pub(crate) async fn browser_attach_snapshot(State(state): State<AppState>) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    update_browser_action(&mut gui.browser, "attach", "reserved");
    if gui.browser.snapshot.is_none() {
        gui.browser.snapshot = Some(default_panel_snapshot(gui.browser.current_url.as_deref()));
    }
    gui.browser.attached = true;
    ApiResponse::ok(json!({
        "attached": true,
        "snapshot": gui.browser.snapshot,
        "message": "Panel snapshot attachment is recorded by Host compatibility layer."
    }))
}

pub(crate) fn browser_status_payload(browser: &BrowserState) -> Value {
    json!({
        "status": if browser.current_url.is_some() { "running" } else { "idle" },
        "inspectState": browser.inspect_state,
        "currentUrl": browser.current_url,
        "message": "Editor internal browser render bridge is available; DOM capture remains reserved.",
        "snapshot": browser.snapshot,
        "lastAction": browser.last_action,
        "lastActionAt": browser.last_action_at,
        "capabilities": {
            "status": "available",
            "openTargetRecording": "available",
            "reloadRecording": "available",
            "inspectModeRecording": "available",
            "domCapture": "reserved",
            "agentAttachment": "available"
        },
        "diagnostics": {
            "currentUrl": browser.current_url,
            "runtimeStatus": if browser.current_url.is_some() { "running" } else { "idle" },
            "inspectState": browser.inspect_state,
            "hasSnapshot": browser.snapshot.is_some(),
            "attached": browser.attached,
            "lastAction": browser.last_action,
            "lastActionAt": browser.last_action_at,
            "lastActionResult": browser.last_action_result
        }
    })
}

pub(crate) fn default_panel_snapshot(current_url: Option<&str>) -> Value {
    json!({
        "id": format!("snapshot-{}", now_millis()),
        "url": current_url.unwrap_or("http://127.0.0.1:31249/"),
        "capturedAt": now_text(),
        "selector": "body",
        "panelKind": "browser-preview",
        "panelTitle": "Packaged DeepCode preview",
        "textContent": "DOM capture is reserved; this diagnostic snapshot proves the GUI Host API is wired.",
        "sourceHints": ["userspace/gui"],
        "relatedFiles": ["userspace/gui/src/components/internal-browser/InternalBrowserPanel.tsx"]
    })
}
