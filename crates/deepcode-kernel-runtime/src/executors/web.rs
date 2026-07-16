use super::*;

pub(super) struct WebSearchExecutor {
    pub(super) config: KernelExecutorConfig,
    pub(super) secret_provider: Arc<dyn SecretProvider>,
}
pub(super) struct WebFetchExecutor;

impl SkillExecutor for WebSearchExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor("web.search")
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        _context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
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
        let endpoint = (!self.config.web_search_endpoint_template.trim().is_empty())
            .then_some(self.config.web_search_endpoint_template.as_str())
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
        let url = endpoint
            .replace("{query}", &percent_encode(&query))
            .replace("{limit}", &limit.to_string());
        validate_http_url(&url)?;
        let reviewed_target = reviewed_target(&invocation.input)?;
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
        let body = http_get_text(&url, 96 * 1024, auth_header, &reviewed_target)?;
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

impl SkillExecutor for WebFetchExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor("web.fetch")
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        _context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        let url = get_string(&invocation.input, "url").unwrap_or_default();
        validate_http_url(&url)?;
        let reviewed_target = reviewed_target(&invocation.input)?;
        let max_bytes = invocation
            .input
            .get("maxBytes")
            .and_then(Value::as_u64)
            .unwrap_or(96 * 1024)
            .clamp(1024, 256 * 1024) as usize;
        let body = http_get_text(&url, max_bytes, None, &reviewed_target)?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "url": url,
                "content": body,
                "sizeBytes": body.len(),
                "contentHash": deepcode_kernel_tools::hash_bytes(body.as_bytes()),
                "untrustedEvidence": true
            }),
        ))
    }
}

pub(super) fn validate_http_url(url: &str) -> KernelResult<()> {
    let parsed = crate::network_policy::validate_http_url_shape(url)?;
    let host = parsed.host_str().unwrap_or_default().trim_end_matches('.');
    if host.eq_ignore_ascii_case("metadata.google.internal")
        || host.eq_ignore_ascii_case("metadata")
        || host == "169.254.169.254"
        || host == "100.100.100.200"
    {
        return Err(KernelError::PermissionDenied(
            "network tools reject cloud metadata endpoints".to_string(),
        ));
    }
    Ok(())
}

pub(super) fn http_get_text(
    url: &str,
    max_bytes: usize,
    auth_header: Option<(&str, &str)>,
    reviewed_target: &crate::network_policy::ReviewedHttpTarget,
) -> KernelResult<String> {
    let url = url.to_string();
    let auth_header = auth_header.map(|(name, value)| (name.to_string(), value.to_string()));
    let reviewed_target = reviewed_target.clone();
    std::thread::Builder::new()
        .name("deepcode-http".to_string())
        .spawn(move || {
            http_get_text_blocking(
                &url,
                max_bytes,
                auth_header
                    .as_ref()
                    .map(|(name, value)| (name.as_str(), value.as_str())),
                &reviewed_target,
            )
        })
        .map_err(|error| KernelError::Other(format!("start HTTP worker: {error}")))?
        .join()
        .map_err(|_| KernelError::Other("HTTP worker panicked".to_string()))?
}

pub(super) fn http_get_text_blocking(
    url: &str,
    max_bytes: usize,
    auth_header: Option<(&str, &str)>,
    reviewed_target: &crate::network_policy::ReviewedHttpTarget,
) -> KernelResult<String> {
    crate::network_policy::verify_http_target(url, reviewed_target)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .resolve(&reviewed_target.host, reviewed_target.selected_address)
        .user_agent("DeepCode-Kernel/0.1 (+untrusted-evidence-fetch)")
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
    Ok(clip_bytes_to_string(&bytes, max_bytes))
}

fn reviewed_target(input: &Value) -> KernelResult<crate::network_policy::ReviewedHttpTarget> {
    input
        .get("kernelReviewedTarget")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| {
            KernelError::InvalidCommand(format!("decode Kernel-reviewed HTTP target: {error}"))
        })?
        .ok_or_else(|| {
            KernelError::PermissionDenied(
                "network operation requires a Kernel-reviewed HTTP target".to_string(),
            )
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
