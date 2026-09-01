use super::*;
use serde_json::json;

const DEFAULT_WEB_SEARCH_ENDPOINT_TEMPLATE: &str =
    "https://www.bing.com/search?format=rss&q={query}&count={limit}";

pub(super) fn web_search_target_url(
    config: &KernelExecutorConfig,
    query: &str,
    limit: u64,
) -> KernelResult<String> {
    let query = query.trim();
    if query.is_empty() {
        return Err(KernelError::InvalidCommand(
            "web.search query is required".to_string(),
        ));
    }
    let endpoint = if config.web_search_endpoint_template.trim().is_empty() {
        DEFAULT_WEB_SEARCH_ENDPOINT_TEMPLATE
    } else {
        config.web_search_endpoint_template.as_str()
    };
    if !endpoint.contains("{query}") {
        return Err(KernelError::InvalidCommand(
            "web.search endpoint template requires {query}".to_string(),
        ));
    }
    Ok(endpoint
        .replace("{query}", &percent_encode(query))
        .replace("{limit}", &limit.clamp(1, 10).to_string()))
}

pub(super) struct WebSearchExecutor {
    pub(super) config: KernelExecutorConfig,
    pub(super) secret_provider: Arc<dyn SecretProvider>,
}
pub(super) struct WebFetchExecutor;

impl KernelToolExecutor for WebSearchExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        _context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let query = get_string(&invocation.input, "query").unwrap_or_default();
        if query.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "web.search query is required".to_string(),
            ));
        }
        let limit = invocation
            .input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(5)
            .clamp(1, 10) as usize;
        let uses_builtin_backend = self.config.web_search_endpoint_template.trim().is_empty();
        let url = web_search_target_url(&self.config, &query, limit as u64)?;
        validate_http_url(&url)?;
        let auth_value = (!uses_builtin_backend
            && !self.config.web_search_auth_secret_ref.trim().is_empty())
        .then(|| {
            self.secret_provider
                .resolve(&self.config.web_search_auth_secret_ref)
        })
        .flatten();
        if !uses_builtin_backend
            && !self.config.web_search_auth_secret_ref.trim().is_empty()
            && auth_value.is_none()
        {
            return Err(KernelError::PermissionDenied(
                "web.search auth SecretRef could not be resolved".to_string(),
            ));
        }
        let auth_header = auth_value.as_ref().map(|value| {
            (
                self.config.web_search_auth_header_name.as_str(),
                value.as_str(),
            )
        });
        let response = http_get_complete(&url, 96 * 1024, auth_header)?;
        let (provider, results) = if uses_builtin_backend {
            ("bing-rss", parse_bing_rss_results(&response.body, limit)?)
        } else {
            let parsed = serde_json::from_str::<Value>(&response.body).map_err(|error| {
                KernelError::InvalidCommand(format!(
                    "web.search response is not valid JSON: {error}"
                ))
            })?;
            (
                "configured-endpoint",
                validate_search_results(&parsed, limit)?,
            )
        };
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "query": query,
                "provider": provider,
                "results": results,
                "untrustedEvidence": true,
                "sourceUrl": url,
                "finalUrl": response.final_url,
                "retrievedAtMs": unix_millis(),
                "truncated": response.truncated,
                "contentHash": deepcode_kernel_tools::hash_bytes(response.body.as_bytes())
            }),
        ))
    }
}

impl KernelToolExecutor for WebFetchExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        _context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        invoke_web_fetch(invocation)
    }
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn invoke_web_fetch(invocation: KernelToolInvocation) -> KernelResult<KernelToolExecutionResult> {
    let url = get_string(&invocation.input, "url").unwrap_or_default();
    validate_http_url(&url)?;
    let max_bytes = invocation
        .input
        .get("maxBytes")
        .and_then(Value::as_u64)
        .unwrap_or(96 * 1024)
        .clamp(1024, 256 * 1024) as usize;
    let response = http_get_complete(&url, max_bytes, None)?;
    Ok(ok(
        invocation.id,
        serde_json::json!({
            "url": url,
            "content": response.body,
            "sizeBytes": response.body.len(),
            "contentHash": deepcode_kernel_tools::hash_bytes(response.body.as_bytes()),
            "contentType": response.content_type,
            "finalUrl": response.final_url,
            "statusCode": response.status_code,
            "retrievedAtMs": unix_millis(),
            "truncated": response.truncated,
            "untrustedEvidence": true
        }),
    ))
}

pub(super) fn validate_http_url(url: &str) -> KernelResult<()> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| KernelError::InvalidCommand(format!("invalid HTTP URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(KernelError::PermissionDenied(
            "network tools only accept http/https URLs".to_string(),
        ));
    }
    if parsed.host_str().is_none() {
        return Err(KernelError::InvalidCommand(
            "HTTP URL requires a host".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(KernelError::PermissionDenied(
            "network tools reject credential-bearing URLs".to_string(),
        ));
    }
    Ok(())
}

struct HttpGetComplete {
    body: String,
    final_url: String,
    content_type: Option<String>,
    status_code: u16,
    truncated: bool,
}

fn http_get_complete(
    url: &str,
    max_bytes: usize,
    auth_header: Option<(&str, &str)>,
) -> KernelResult<HttpGetComplete> {
    let headers = auth_header
        .map(|(name, value)| vec![(name.to_string(), value.to_string())])
        .unwrap_or_default();
    http_get_complete_with_headers(url, max_bytes, headers)
}

fn http_get_complete_with_headers(
    url: &str,
    max_bytes: usize,
    headers: Vec<(String, String)>,
) -> KernelResult<HttpGetComplete> {
    let url = url.to_string();
    std::thread::Builder::new()
        .name("deepcode-http".to_string())
        .spawn(move || http_get_complete_blocking(&url, max_bytes, headers))
        .map_err(|error| KernelError::Other(format!("start HTTP worker: {error}")))?
        .join()
        .map_err(|_| KernelError::Other("HTTP worker panicked".to_string()))?
}

fn http_get_complete_blocking(
    url: &str,
    max_bytes: usize,
    request_headers: Vec<(String, String)>,
) -> KernelResult<HttpGetComplete> {
    validate_http_url(url)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("DeepCode-Kernel/0.1")
        .build()
        .map_err(|error| KernelError::Other(format!("create HTTP client: {error}")))?;
    let mut request = client.get(url);
    for (name, value) in request_headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|error| {
            KernelError::InvalidCommand(format!("invalid HTTP header name: {error}"))
        })?;
        let value = reqwest::header::HeaderValue::from_str(&value)
            .map_err(|_| KernelError::InvalidCommand("invalid HTTP header value".to_string()))?;
        request = request.header(name, value);
    }
    let mut response = request
        .send()
        .map_err(|error| KernelError::Other(format!("HTTP GET {url}: {error}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(KernelError::Other(format!(
            "HTTP GET {url} returned {}",
            status.as_u16()
        )));
    }
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    response
        .by_ref()
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| KernelError::Other(format!("read HTTP body: {error}")))?;
    let truncated = bytes.len() > max_bytes;
    Ok(HttpGetComplete {
        body: clip_bytes_to_string(&bytes, max_bytes),
        final_url,
        content_type,
        status_code: status.as_u16(),
        truncated,
    })
}

pub(super) fn clip_bytes_to_string(bytes: &[u8], max_bytes: usize) -> String {
    let clipped = if bytes.len() <= max_bytes {
        bytes
    } else {
        &bytes[..max_bytes]
    };
    let text = String::from_utf8_lossy(clipped);
    if bytes.len() <= max_bytes {
        text.to_string()
    } else {
        format!("{text}\n[truncated]")
    }
}

pub(super) fn validate_search_results(response: &Value, limit: usize) -> KernelResult<Vec<Value>> {
    let items = response
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            KernelError::InvalidCommand("web.search response requires results array".to_string())
        })?;
    items
        .iter()
        .take(limit)
        .map(|item| {
            let title = required_string(item, "title")?;
            let url = required_string(item, "url")?;
            validate_http_url(&url)?;
            Ok(serde_json::json!({
                "sourceId": url,
                "backendId": "configuredEndpoint",
                "title": title,
                "url": url,
                "snippet": get_string(item, "snippet"),
                "publishedAt": get_string(item, "publishedAt"),
                "truncated": false,
                "untrustedEvidence": true
            }))
        })
        .collect()
}

pub(super) fn parse_bing_rss_results(body: &str, limit: usize) -> KernelResult<Vec<Value>> {
    let document = roxmltree::Document::parse(body).map_err(|error| {
        KernelError::InvalidCommand(format!("Bing RSS response is invalid XML: {error}"))
    })?;
    let results = document
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "item")
        .take(limit)
        .map(|item| {
            let title = rss_child_text(item, "title").ok_or_else(|| {
                KernelError::InvalidCommand("Bing RSS item requires title".to_string())
            })?;
            let url = rss_child_text(item, "link").ok_or_else(|| {
                KernelError::InvalidCommand("Bing RSS item requires link".to_string())
            })?;
            validate_http_url(&url)?;
            Ok(json!({
                "sourceId": url,
                "backendId": "bingRss",
                "title": normalize_atom_text(&title),
                "url": url,
                "snippet": rss_child_text(item, "description")
                    .map(|value| normalize_atom_text(&value)),
                "publishedAt": rss_child_text(item, "pubDate"),
                "truncated": false,
                "untrustedEvidence": true
            }))
        })
        .collect::<KernelResult<Vec<_>>>()?;
    if results.is_empty() {
        return Err(KernelError::InvalidCommand(
            "Bing RSS response contains no search results".to_string(),
        ));
    }
    Ok(results)
}

fn rss_child_text(node: roxmltree::Node<'_, '_>, name: &str) -> Option<String> {
    node.children()
        .find(|child| child.is_element() && child.tag_name().name() == name)
        .and_then(|child| child.text())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_atom_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(char::from(*byte));
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}
