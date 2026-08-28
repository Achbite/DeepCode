use super::*;

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
    let endpoint = (!config.web_search_endpoint_template.trim().is_empty())
        .then_some(config.web_search_endpoint_template.as_str())
        .ok_or_else(|| {
            KernelError::InvalidCommand(
                "web.search endpoint template is not configured".to_string(),
            )
        })?;
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
        let url = web_search_target_url(&self.config, &query, limit as u64)?;
        validate_http_url(&url)?;
        let auth_value = (!self.config.web_search_auth_secret_ref.trim().is_empty())
            .then(|| {
                self.secret_provider
                    .resolve(&self.config.web_search_auth_secret_ref)
            })
            .flatten();
        if !self.config.web_search_auth_secret_ref.trim().is_empty() && auth_value.is_none() {
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
        let body = http_get_text(&url, 96 * 1024, auth_header)?;
        let response = serde_json::from_str::<Value>(&body).map_err(|error| {
            KernelError::InvalidCommand(format!("web.search response is not valid JSON: {error}"))
        })?;
        let results = validate_search_results(&response, limit)?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "query": query,
                "provider": "configured-endpoint",
                "results": results,
                "untrustedEvidence": true,
                "sourceUrl": url,
                "contentHash": deepcode_kernel_tools::hash_bytes(body.as_bytes())
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

pub(super) fn http_get_text(
    url: &str,
    max_bytes: usize,
    auth_header: Option<(&str, &str)>,
) -> KernelResult<String> {
    Ok(http_get_complete(url, max_bytes, auth_header)?.body)
}

struct HttpGetComplete {
    body: String,
}

fn http_get_complete(
    url: &str,
    max_bytes: usize,
    auth_header: Option<(&str, &str)>,
) -> KernelResult<HttpGetComplete> {
    let url = url.to_string();
    let auth_header = auth_header.map(|(name, value)| (name.to_string(), value.to_string()));
    std::thread::Builder::new()
        .name("deepcode-http".to_string())
        .spawn(move || {
            http_get_complete_blocking(
                &url,
                max_bytes,
                auth_header
                    .as_ref()
                    .map(|(name, value)| (name.as_str(), value.as_str())),
            )
        })
        .map_err(|error| KernelError::Other(format!("start HTTP worker: {error}")))?
        .join()
        .map_err(|_| KernelError::Other("HTTP worker panicked".to_string()))?
}

fn http_get_complete_blocking(
    url: &str,
    max_bytes: usize,
    auth_header: Option<(&str, &str)>,
) -> KernelResult<HttpGetComplete> {
    validate_http_url(url)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("DeepCode-Kernel/0.1")
        .build()
        .map_err(|error| KernelError::Other(format!("create HTTP client: {error}")))?;
    let mut request = client.get(url);
    if let Some((name, value)) = auth_header {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|error| {
            KernelError::InvalidCommand(format!("invalid web.search auth header name: {error}"))
        })?;
        let value = reqwest::header::HeaderValue::from_str(value).map_err(|_| {
            KernelError::InvalidCommand("invalid web.search auth header value".to_string())
        })?;
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
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    response
        .by_ref()
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| KernelError::Other(format!("read HTTP body: {error}")))?;
    Ok(HttpGetComplete {
        body: clip_bytes_to_string(&bytes, max_bytes),
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
                "title": title,
                "url": url,
                "snippet": get_string(item, "snippet"),
                "untrustedEvidence": true
            }))
        })
        .collect()
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
