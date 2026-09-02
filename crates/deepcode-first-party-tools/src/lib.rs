mod arxiv;
mod github;
mod pdf;

use reqwest::blocking::Client;
use reqwest::header::{HeaderName, HeaderValue, USER_AGENT};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const MAX_HTTP_ERROR_BYTES: usize = 8 * 1024;

const GITHUB_MANIFEST: &str = include_str!("../manifests/github.json");
const ARXIV_MANIFEST: &str = include_str!("../manifests/arxiv.json");
const PDF_MANIFEST: &str = include_str!("../manifests/pdf.json");

#[derive(Clone, Copy)]
enum PluginKind {
    Github,
    Arxiv,
    Pdf,
}

impl PluginKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "github" => Ok(Self::Github),
            "arxiv" => Ok(Self::Arxiv),
            "pdf" => Ok(Self::Pdf),
            _ => Err(format!("unknown first-party plugin: {value}")),
        }
    }

    fn manifest(self) -> &'static str {
        match self {
            Self::Github => GITHUB_MANIFEST,
            Self::Arxiv => ARXIV_MANIFEST,
            Self::Pdf => PDF_MANIFEST,
        }
    }

    fn call(self, name: &str, arguments: &Value, metadata: Option<&Value>) -> ToolResult<Value> {
        match self {
            Self::Github => github::call(name, arguments),
            Self::Arxiv => arxiv::call(name, arguments),
            Self::Pdf => pdf::call(name, arguments, metadata),
        }
    }
}

#[derive(Debug)]
pub(crate) struct ToolError {
    code: &'static str,
    message: String,
}

impl ToolError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub(crate) type ToolResult<T> = Result<T, ToolError>;

pub fn run_from_args(arguments: impl Iterator<Item = String>) -> Result<(), String> {
    let arguments = arguments.collect::<Vec<_>>();
    if arguments.len() != 2 || arguments[0] != "--plugin" {
        return Err("usage: deepcode-first-party-provider --plugin <github|arxiv|pdf>".to_string());
    }
    let plugin = PluginKind::parse(&arguments[1])?;
    let manifest: Value = serde_json::from_str(plugin.manifest())
        .map_err(|error| format!("invalid embedded plugin manifest: {error}"))?;
    serve(plugin, &manifest)
}

fn serve(plugin: PluginKind, manifest: &Value) -> Result<(), String> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("read MCP request: {error}"))?;
        let request: Value =
            serde_json::from_str(&line).map_err(|error| format!("decode MCP request: {error}"))?;
        let Some(method) = request.get("method").and_then(Value::as_str) else {
            continue;
        };
        if request.get("id").is_none() {
            if method == "exit" {
                break;
            }
            continue;
        }
        let id = request["id"].clone();
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let response = match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": { "tools": {} },
                    "serverInfo": {
                        "name": manifest["displayName"],
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            }),
            "tools/list" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "tools": manifest_tools(manifest)? }
            }),
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "tools/call requires name".to_string())?;
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let result = match plugin.call(name, &arguments, params.get("_meta")) {
                    Ok(value) => tool_success(value),
                    Err(error) => tool_failure(error),
                };
                json!({ "jsonrpc": "2.0", "id": id, "result": result })
            }
            _ => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("method not found: {method}") }
            }),
        };
        serde_json::to_writer(&mut output, &response)
            .map_err(|error| format!("encode MCP response: {error}"))?;
        output
            .write_all(b"\n")
            .and_then(|_| output.flush())
            .map_err(|error| format!("write MCP response: {error}"))?;
    }
    Ok(())
}

fn manifest_tools(manifest: &Value) -> Result<Vec<Value>, String> {
    manifest
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| "plugin manifest requires tools".to_string())?
        .iter()
        .map(|tool| {
            Ok(json!({
                "name": tool.get("remoteName").and_then(Value::as_str)
                    .ok_or_else(|| "plugin tool requires remoteName".to_string())?,
                "description": tool.get("description").and_then(Value::as_str)
                    .ok_or_else(|| "plugin tool requires description".to_string())?,
                "inputSchema": tool.get("inputSchema").filter(|value| value.is_object())
                    .ok_or_else(|| "plugin tool requires inputSchema".to_string())?,
            }))
        })
        .collect()
}

fn tool_success(value: Value) -> Value {
    let text = serde_json::to_string(&value).expect("JSON value serialization cannot fail");
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": value,
        "isError": false
    })
}

fn tool_failure(error: ToolError) -> Value {
    let failure = json!({ "error": { "code": error.code, "message": error.message } });
    let text = serde_json::to_string(&failure).expect("JSON value serialization cannot fail");
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": failure,
        "isError": true
    })
}

pub(crate) fn input_object<'a>(
    value: &'a Value,
    allowed: &[&str],
) -> ToolResult<&'a Map<String, Value>> {
    let object = value
        .as_object()
        .ok_or_else(|| ToolError::new("tool_input_invalid", "tool input must be an object"))?;
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(ToolError::new(
            "tool_input_invalid",
            format!("unsupported tool input field: {field}"),
        ));
    }
    Ok(object)
}

pub(crate) fn required_string(object: &Map<String, Value>, field: &str) -> ToolResult<String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| ToolError::new("tool_input_invalid", format!("{field} is required")))
}

pub(crate) fn optional_string(
    object: &Map<String, Value>,
    field: &str,
) -> ToolResult<Option<String>> {
    match object.get(field) {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| ToolError::new("tool_input_invalid", format!("{field} must be text"))),
    }
}

pub(crate) fn optional_u64(
    object: &Map<String, Value>,
    field: &str,
    default: u64,
    minimum: u64,
    maximum: u64,
) -> ToolResult<u64> {
    let value = match object.get(field) {
        None => default,
        Some(value) => value.as_u64().ok_or_else(|| {
            ToolError::new("tool_input_invalid", format!("{field} must be an integer"))
        })?,
    };
    if !(minimum..=maximum).contains(&value) {
        return Err(ToolError::new(
            "tool_input_invalid",
            format!("{field} must be between {minimum} and {maximum}"),
        ));
    }
    Ok(value)
}

pub(crate) struct HttpResponse {
    pub(crate) body: Vec<u8>,
    pub(crate) final_url: String,
    pub(crate) headers: BTreeMap<String, String>,
}

pub(crate) fn http_get(
    url: reqwest::Url,
    max_bytes: usize,
    headers: Vec<(HeaderName, HeaderValue)>,
) -> ToolResult<HttpResponse> {
    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| ToolError::new("network_client_failed", error.to_string()))?;
    let mut request = client
        .get(url)
        .header(USER_AGENT, "DeepCode-first-party-tools/0.5");
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .map_err(|error| ToolError::new("network_request_failed", error.to_string()))?;
    let status = response.status();
    let final_url = response.url().to_string();
    let response_headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
        })
        .collect::<BTreeMap<_, _>>();
    let read_limit = if status.is_success() {
        max_bytes
    } else {
        MAX_HTTP_ERROR_BYTES
    };
    let mut body = Vec::new();
    response
        .take(read_limit.saturating_add(1) as u64)
        .read_to_end(&mut body)
        .map_err(|error| ToolError::new("network_response_read_failed", error.to_string()))?;
    if !status.is_success() {
        body.truncate(read_limit);
        let detail = String::from_utf8_lossy(&body);
        return Err(ToolError::new(
            "network_response_failed",
            format!("HTTP {} from {final_url}: {detail}", status.as_u16()),
        ));
    }
    if body.len() > max_bytes {
        return Err(ToolError::new(
            "network_response_too_large",
            format!("response from {final_url} exceeds {max_bytes} bytes"),
        ));
    }
    Ok(HttpResponse {
        body,
        final_url,
        headers: response_headers,
    })
}

pub(crate) fn response_text(response: &HttpResponse) -> ToolResult<&str> {
    std::str::from_utf8(&response.body)
        .map_err(|error| ToolError::new("network_response_encoding_invalid", error.to_string()))
}

pub(crate) fn now_millis() -> ToolResult<u128> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| ToolError::new("system_clock_invalid", error.to_string()))
}

pub(crate) fn limit_text(value: &str, max_bytes: usize) -> (&str, bool) {
    if value.len() <= max_bytes {
        return (value, false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (&value[..end], true)
}
