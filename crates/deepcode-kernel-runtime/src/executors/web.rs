use super::*;
use serde_json::json;

const BRAVE_WEB_SEARCH_ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_AUTH_HEADER: &str = "X-Subscription-Token";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WebSearchBackend {
    Brave,
    ConfiguredEndpoint,
}

fn web_search_backend(config: &KernelExecutorConfig) -> WebSearchBackend {
    if config.web_search_endpoint_template.trim().is_empty() {
        WebSearchBackend::Brave
    } else {
        WebSearchBackend::ConfiguredEndpoint
    }
}

pub(super) fn web_search_availability(config: &KernelExecutorConfig) -> ToolAvailability {
    match web_search_backend(config) {
        WebSearchBackend::Brave if config.web_search_auth_secret_ref.trim().is_empty() => {
            ToolAvailability::Blocked
        }
        WebSearchBackend::Brave | WebSearchBackend::ConfiguredEndpoint => {
            ToolAvailability::Callable
        }
    }
}

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
    let limit = limit.clamp(1, 10);
    match web_search_backend(config) {
        WebSearchBackend::Brave => Ok(format!(
            "{BRAVE_WEB_SEARCH_ENDPOINT}?q={}&count={limit}&result_filter=web&text_decorations=false",
            percent_encode(query)
        )),
        WebSearchBackend::ConfiguredEndpoint => {
            let endpoint = config.web_search_endpoint_template.as_str();
            if !endpoint.contains("{query}") {
                return Err(KernelError::InvalidCommand(
                    "web.search endpoint template requires {query}".to_string(),
                ));
            }
            Ok(endpoint
                .replace("{query}", &percent_encode(query))
                .replace("{limit}", &limit.to_string()))
        }
    }
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
        let backend = web_search_backend(&self.config);
        let url = web_search_target_url(&self.config, &query, limit as u64)?;
        validate_http_url(&url)?;
        let auth_header =
            web_search_auth_header(&self.config, self.secret_provider.as_ref(), backend)?;
        let auth_header = auth_header
            .as_ref()
            .map(|(name, value)| (name.as_str(), value.as_str()));
        let response = http_get_complete(&url, 96 * 1024, auth_header)?;
        let parsed = serde_json::from_str::<Value>(&response.body).map_err(|error| {
            KernelError::InvalidCommand(format!("web.search response is not valid JSON: {error}"))
        })?;
        let (provider, query, results) = match backend {
            WebSearchBackend::Brave => {
                let (query, results) = parse_brave_search_results(&parsed, &query, limit)?;
                ("brave-search", query, results)
            }
            WebSearchBackend::ConfiguredEndpoint => (
                "configured-endpoint",
                search_query_metadata(&query, None),
                validate_search_results(&parsed, limit)?,
            ),
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

fn web_search_auth_header(
    config: &KernelExecutorConfig,
    secret_provider: &dyn SecretProvider,
    backend: WebSearchBackend,
) -> KernelResult<Option<(String, String)>> {
    let secret_ref = config.web_search_auth_secret_ref.trim();
    if backend == WebSearchBackend::Brave && secret_ref.is_empty() {
        return Err(KernelError::PermissionDenied(
            "web.search built-in Brave backend requires agent.web.search.authSecretRef".to_string(),
        ));
    }
    if secret_ref.is_empty() {
        return Ok(None);
    }
    let value = secret_provider.resolve(secret_ref).ok_or_else(|| {
        KernelError::PermissionDenied("web.search auth SecretRef could not be resolved".to_string())
    })?;
    let name = match backend {
        WebSearchBackend::Brave => BRAVE_AUTH_HEADER,
        WebSearchBackend::ConfiguredEndpoint => config.web_search_auth_header_name.as_str(),
    };
    Ok(Some((name.to_string(), value)))
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
            let snippet = optional_string(item, "snippet")?;
            let published_at = optional_string(item, "publishedAt")?;
            Ok(serde_json::json!({
                "sourceId": url,
                "backendId": "configuredEndpoint",
                "title": title,
                "url": url,
                "snippet": snippet,
                "publishedAt": published_at,
                "truncated": false,
                "untrustedEvidence": true
            }))
        })
        .collect()
}

pub(super) fn parse_brave_search_results(
    response: &Value,
    requested_query: &str,
    limit: usize,
) -> KernelResult<(Value, Vec<Value>)> {
    let root = response.as_object().ok_or_else(|| {
        KernelError::InvalidCommand("Brave Search response must be an object".to_string())
    })?;
    let backend_query = match root.get("query") {
        None | Some(Value::Null) => None,
        Some(Value::Object(query)) => Some(query),
        Some(_) => {
            return Err(KernelError::InvalidCommand(
                "Brave Search response query must be an object".to_string(),
            ))
        }
    };
    let original = backend_query
        .map(|query| optional_string_in_object(query, "original"))
        .transpose()?
        .flatten()
        .unwrap_or_else(|| requested_query.to_string());
    let altered = backend_query
        .map(|query| optional_string_in_object(query, "altered"))
        .transpose()?
        .flatten();
    let items = match root.get("web") {
        None | Some(Value::Null) => None,
        Some(Value::Object(web)) => Some(web.get("results").and_then(Value::as_array).ok_or_else(
            || {
                KernelError::InvalidCommand(
                    "Brave Search response web requires results array".to_string(),
                )
            },
        )?),
        Some(_) => {
            return Err(KernelError::InvalidCommand(
                "Brave Search response web must be an object".to_string(),
            ))
        }
    };
    let results = items
        .into_iter()
        .flatten()
        .take(limit)
        .map(|item| {
            let title = required_string(item, "title")?;
            let url = required_string(item, "url")?;
            validate_http_url(&url)?;
            let snippet = optional_string(item, "description")?;
            let language = optional_string(item, "language")?;
            let published_at = optional_string(item, "page_age")?;
            Ok(json!({
                "sourceId": url,
                "backendId": "braveWeb",
                "title": title,
                "url": url,
                "snippet": snippet,
                "language": language,
                "publishedAt": published_at,
                "truncated": false,
                "untrustedEvidence": true
            }))
        })
        .collect::<KernelResult<Vec<_>>>()?;
    Ok((
        search_query_metadata(&original, altered.as_deref()),
        results,
    ))
}

fn search_query_metadata(original: &str, altered: Option<&str>) -> Value {
    let mut query =
        serde_json::Map::from_iter([("original".to_string(), Value::String(original.to_string()))]);
    if let Some(altered) = altered {
        query.insert("altered".to_string(), Value::String(altered.to_string()));
    }
    Value::Object(query)
}

fn optional_string(value: &Value, key: &str) -> KernelResult<Option<String>> {
    let object = value.as_object().ok_or_else(|| {
        KernelError::InvalidCommand(format!("web.search result requires object item for {key}"))
    })?;
    optional_string_in_object(object, key)
}

fn optional_string_in_object(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> KernelResult<Option<String>> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok((!value.trim().is_empty()).then(|| value.to_string())),
        Some(_) => Err(KernelError::InvalidCommand(format!(
            "web.search response field {key} must be a string"
        ))),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    struct TestSecretProvider;

    impl SecretProvider for TestSecretProvider {
        fn resolve(&self, secret_ref: &str) -> Option<String> {
            (secret_ref == "local-secret:brave").then(|| "brave-token".to_string())
        }
    }

    fn config(endpoint: &str, header: &str, secret_ref: &str) -> KernelExecutorConfig {
        KernelExecutorConfig {
            web_search_endpoint_template: endpoint.to_string(),
            web_search_auth_header_name: header.to_string(),
            web_search_auth_secret_ref: secret_ref.to_string(),
        }
    }

    #[test]
    fn built_in_brave_target_and_custom_target_are_independent() {
        let built_in = config("", "Authorization", "local-secret:brave");
        assert_eq!(
            web_search_target_url(&built_in, "rust agent", 12).unwrap(),
            "https://api.search.brave.com/res/v1/web/search?q=rust+agent&count=10&result_filter=web&text_decorations=false"
        );

        let custom = config(
            "https://search.example/v1?q={query}&limit={limit}",
            "Authorization",
            "",
        );
        assert_eq!(
            web_search_target_url(&custom, "rust agent", 4).unwrap(),
            "https://search.example/v1?q=rust+agent&limit=4"
        );
    }

    #[test]
    fn brave_requires_a_resolvable_secret_and_uses_its_fixed_header() {
        let missing = config("", "Authorization", "");
        assert_eq!(web_search_availability(&missing), ToolAvailability::Blocked);
        assert!(
            web_search_auth_header(&missing, &TestSecretProvider, WebSearchBackend::Brave).is_err()
        );

        let configured = config("", "Authorization", "local-secret:brave");
        assert_eq!(
            web_search_availability(&configured),
            ToolAvailability::Callable
        );
        assert_eq!(
            web_search_auth_header(&configured, &TestSecretProvider, WebSearchBackend::Brave)
                .unwrap(),
            Some((BRAVE_AUTH_HEADER.to_string(), "brave-token".to_string()))
        );

        let unresolved = config("", "Authorization", "local-secret:unknown");
        assert!(
            web_search_auth_header(&unresolved, &TestSecretProvider, WebSearchBackend::Brave)
                .is_err()
        );
    }

    #[test]
    fn configured_endpoint_is_callable_without_auth_and_uses_configured_auth_when_present() {
        let anonymous = config("https://search.example/v1?q={query}", "Authorization", "");
        assert_eq!(
            web_search_availability(&anonymous),
            ToolAvailability::Callable
        );
        assert_eq!(
            web_search_auth_header(
                &anonymous,
                &TestSecretProvider,
                WebSearchBackend::ConfiguredEndpoint
            )
            .unwrap(),
            None
        );

        let authenticated = config(
            "https://search.example/v1?q={query}",
            "X-Search-Key",
            "local-secret:brave",
        );
        assert_eq!(
            web_search_auth_header(
                &authenticated,
                &TestSecretProvider,
                WebSearchBackend::ConfiguredEndpoint
            )
            .unwrap(),
            Some(("X-Search-Key".to_string(), "brave-token".to_string()))
        );
    }

    #[test]
    fn brave_response_maps_web_results_and_query_metadata_without_reranking() {
        let response = json!({
            "query": {"original": "rust agent", "altered": "rust agents"},
            "web": {
                "results": [
                    {
                        "title": "First",
                        "url": "https://example.com/first",
                        "description": "First result",
                        "language": "en",
                        "page_age": "2026-09-01T00:00:00Z"
                    },
                    {
                        "title": "Second",
                        "url": "https://example.com/second"
                    }
                ]
            }
        });
        let (query, results) = parse_brave_search_results(&response, "rust agent", 10).unwrap();

        assert_eq!(
            query,
            json!({"original": "rust agent", "altered": "rust agents"})
        );
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["backendId"], "braveWeb");
        assert_eq!(results[0]["snippet"], "First result");
        assert_eq!(results[0]["language"], "en");
        assert_eq!(results[0]["publishedAt"], "2026-09-01T00:00:00Z");
        assert_eq!(results[1]["title"], "Second");
    }

    #[test]
    fn brave_no_web_section_is_a_valid_empty_result() {
        let (query, results) =
            parse_brave_search_results(&json!({"query": null}), "no matches", 5).unwrap();
        assert_eq!(query, json!({"original": "no matches"}));
        assert!(results.is_empty());
    }

    #[test]
    fn brave_response_rejects_malformed_required_and_optional_fields() {
        let missing_url = json!({
            "web": {"results": [{"title": "Missing URL"}]}
        });
        assert!(parse_brave_search_results(&missing_url, "query", 5).is_err());

        let invalid_language = json!({
            "web": {
                "results": [{
                    "title": "Result",
                    "url": "https://example.com",
                    "language": 42
                }]
            }
        });
        assert!(parse_brave_search_results(&invalid_language, "query", 5).is_err());
    }
}
