use deepcode_kernel_runtime::executors::KernelToolExecutionContext;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    time::Duration,
};

#[derive(Clone)]
struct NativeEndpoint {
    address: String,
    token: String,
}
static ENDPOINTS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, NativeEndpoint>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Registration {
    host_instance_id: String,
    endpoint: String,
    callback_token: String,
    remove: bool,
}

pub(crate) async fn register(
    axum::Json(registration): axum::Json<Registration>,
) -> axum::Json<Value> {
    let result = (|| -> Result<(), String> {
        if !deepcode_kernel_abi::is_valid_host_instance_id(&registration.host_instance_id)
            || !deepcode_kernel_abi::is_valid_host_shell_token(&registration.callback_token)
        {
            return Err("native_browser_registration_invalid".into());
        }
        let address: std::net::SocketAddr = registration
            .endpoint
            .parse()
            .map_err(|_| "native_browser_endpoint_invalid")?;
        if !address.ip().is_loopback() {
            return Err("native_browser_endpoint_requires_loopback".into());
        }
        if registration.remove {
            let mut endpoints = ENDPOINTS
                .lock()
                .map_err(|_| "native_browser_registry_unavailable")?;
            if endpoints
                .get(&registration.host_instance_id)
                .is_some_and(|entry| entry.token == registration.callback_token)
            {
                endpoints.remove(&registration.host_instance_id);
            }
            return Ok(());
        }
        let endpoint = NativeEndpoint {
            address: registration.endpoint,
            token: registration.callback_token,
        };
        exchange(
            &endpoint,
            &json!({"hostInstanceId":registration.host_instance_id,"windowLabel":"main"}),
            &json!({"action":"hostStatus"}),
        )?;
        ENDPOINTS
            .lock()
            .map_err(|_| "native_browser_registry_unavailable")?
            .insert(registration.host_instance_id, endpoint);
        Ok(())
    })();
    axum::Json(match result {
        Ok(()) => json!({"ok":true}),
        Err(message) => json!({"ok":false,"message":message}),
    })
}

pub(crate) fn call(binding: &Value, input: &Value) -> Result<Value, String> {
    let id = binding["hostInstanceId"]
        .as_str()
        .ok_or("native_browser_host_binding_missing")?;
    let endpoint = ENDPOINTS
        .lock()
        .map_err(|_| "native_browser_registry_unavailable")?
        .get(id)
        .cloned()
        .ok_or("native_browser_host_unavailable")?;
    exchange(&endpoint, binding, input)
}

fn exchange(endpoint: &NativeEndpoint, binding: &Value, input: &Value) -> Result<Value, String> {
    let token = &endpoint.token;
    let address = endpoint
        .address
        .parse()
        .map_err(|error| format!("Native browser endpoint: {error}"))?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))
        .map_err(|error| format!("native_browser_host_unavailable: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    let mut request = serde_json::to_vec(&json!({"binding":binding,"input":input,"token":token}))
        .map_err(|error| error.to_string())?;
    request.push(b'\n');
    stream
        .write_all(&request)
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    BufReader::new(stream.take(1024 * 1024))
        .read_line(&mut response)
        .map_err(|error| error.to_string())?;
    let response: Value = serde_json::from_str(&response)
        .map_err(|error| format!("native_browser_response_invalid: {error}"))?;
    if response["ok"] != true {
        return Err(response["message"]
            .as_str()
            .unwrap_or("native_browser_command_failed")
            .into());
    }
    Ok(response["data"].clone())
}

pub(crate) fn execute(
    binding: &Value,
    name: &str,
    mut input: Value,
    context: &KernelToolExecutionContext,
    invocation_id: &str,
) -> Result<Value, String> {
    if context.cancellation.is_cancelled() {
        return Err("tool_cancelled".into());
    }
    if name == "browser.service" {
        let action = input["action"]
            .as_str()
            .ok_or("browser_service_action_missing")?;
        input["action"] = json!(match action {
            "start" => "serviceStart",
            "list" => "serviceList",
            "status" => "serviceStatus",
            "stop" => "serviceStop",
            _ => return Err("browser_service_action_invalid".into()),
        });
    }
    if name != "browser.capture" {
        return call(binding, &input);
    }
    let directory = context
        .output_directory
        .as_ref()
        .ok_or("artifact_storage_unavailable")?;
    let [target] = context.private_resolved_targets.as_slice() else {
        return Err("browser_capture_target_invalid".into());
    };
    let workspace_id = context
        .workspace_id
        .as_deref()
        .ok_or("workspace_binding_required")?;
    let logical_path = input["path"]
        .as_str()
        .ok_or("browser_capture_path_missing")?
        .to_string();
    let before = deepcode_kernel_runtime::executors::capture_file_change_side(
        std::path::Path::new(target),
        context,
        0,
        "before",
    );
    input["action"] = json!("capture");
    input["captureDirectory"] = json!(directory);
    let output = call(binding, &input)?;
    let content_ref = output["contentRef"]
        .as_str()
        .ok_or("browser_capture_content_missing")?;
    let target = std::path::Path::new(target);
    std::fs::create_dir_all(target.parent().ok_or("browser_capture_parent_missing")?)
        .map_err(|error| error.to_string())?;
    std::fs::copy(content_ref, target)
        .map_err(|error| format!("browser_capture_delivery_failed: {error}"))?;
    let after = json!({"exists":true,"contentRef":content_ref,"sizeBytes":std::fs::metadata(content_ref).map_err(|error|error.to_string())?.len()});
    let change =
        deepcode_kernel_runtime::executors::file_change_fact(context, &logical_path, before, after)
            .map_err(|error| error.to_string())?;
    Ok(
        json!({"page":output["sourcePage"],"fileChanges":[change],"artifacts":[{
            "artifactId":format!("artifact:{invocation_id}"),"label":target.file_name().map(|name|name.to_string_lossy()),
            "workspaceId":workspace_id,"logicalPath":logical_path,"uri":format!("artifact://artifact:{invocation_id}"),
            "contentRef":content_ref,"contentType":"image/png","contentMode":"fixed","sourcePage":output["sourcePage"]
        }]}),
    )
}

pub(crate) fn definitions() -> Vec<(&'static str, &'static str, Value)> {
    vec![
    ("browser.page","Operate only the native preview belonging to this task's GUI Host and Session. Open an HTTP(S) URL or explicit absolute filePath; openSelf shows the actual DeepCode GUI connected to this Host. Supply serviceId to open an owned development service. list pages, navigate, reload, inspect visible text, click/type/scroll, or close an exact previewId. Existing URLs are externally owned; closing a page does not stop their service.",json!({
        "type":"object","additionalProperties":false,"required":["action"],"properties":{
            "action":{"type":"string","enum":["open","openSelf","list","status","navigate","reload","act","close"]},
            "previewId":{"type":"string"},"url":{"type":"string"},"filePath":{"type":"string","description":"Explicit absolute HTML file path; preserve its relative resources."},"serviceId":{"type":"string"},"operation":{"type":"string","enum":["inspect","click","type","scroll"]},
            "selector":{"type":"string"},"text":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"}
        }})),
    ("browser.service","Manage development services owned by this GUI Host and Session. Read the project configuration first; start its actual command and args in the explicit absolute directory, supplying its loopback URL. This runs a Host process with external effects and uses Kernel external permission. A started process is not proof of a ready URL: open the URL and inspect its actual page. list/status report the process and logPath. stop only terminates this Host's exact owned process group. Closing a page leaves the service running; Host exit releases owned services.",json!({
        "type":"object","additionalProperties":false,"required":["action"],"properties":{
            "action":{"type":"string","enum":["start","list","status","stop"]},"serviceId":{"type":"string"},
            "directory":{"type":"string"},"command":{"type":"string"},"args":{"type":"array","items":{"type":"string"}},"url":{"type":"string"}
        }})),
    ("browser.capture","Capture the visible native page viewport from this task's GUI Host as a fixed PNG artifact. Requires exact previewId and workspace-relative .png path. The page must be visible in the Reader. The screenshot is preserved in the execution archive.",json!({
        "type":"object","additionalProperties":false,"required":["previewId","path"],"properties":{"previewId":{"type":"string"},"path":{"type":"string"}}}))
]
}
