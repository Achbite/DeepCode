use super::*;
use base64::Engine as _;
use serde_json::json;

const GITHUB_API_VERSION: &str = "2026-03-10";
const DEFAULT_WEB_SEARCH_ENDPOINT_TEMPLATE: &str =
    "https://www.bing.com/search?format=rss&q={query}&count={limit}";

pub(super) fn github_search_target_url(
    config: &KernelExecutorConfig,
    input: &Value,
) -> KernelResult<String> {
    let query = required_string(input, "query")?;
    let kind = get_string(input, "kind").unwrap_or_else(|| "repositories".to_string());
    let endpoint = match kind.as_str() {
        "repositories" => "repositories",
        "code" => "code",
        "issues" => "issues",
        _ => {
            return Err(KernelError::InvalidCommand(
                "github.search kind must be repositories, code, or issues".to_string(),
            ))
        }
    };
    let page = input
        .get("page")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(1, 100);
    let limit = input
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .clamp(1, 30);
    let url = format!(
        "{}/search/{endpoint}?q={}&page={page}&per_page={limit}",
        config.github_api_base_url.trim_end_matches('/'),
        percent_encode(&query),
    );
    validate_http_url(&url)?;
    Ok(url)
}

pub(super) fn github_read_target_url(
    config: &KernelExecutorConfig,
    input: &Value,
) -> KernelResult<String> {
    let repository = required_string(input, "repository")?;
    let path = get_string(input, "path").unwrap_or_else(|| ".".to_string());
    let repository_path = repository
        .split('/')
        .map(percent_encode)
        .collect::<Vec<_>>()
        .join("/");
    let content_path = if path == "." {
        String::new()
    } else {
        format!(
            "/{}",
            path.split('/')
                .map(percent_encode)
                .collect::<Vec<_>>()
                .join("/")
        )
    };
    let mut url = format!(
        "{}/repos/{repository_path}/contents{content_path}",
        config.github_api_base_url.trim_end_matches('/'),
    );
    if let Some(reference) = get_string(input, "ref") {
        url.push_str("?ref=");
        url.push_str(&percent_encode(&reference));
    }
    validate_http_url(&url)?;
    Ok(url)
}

pub(super) fn arxiv_search_target_url(
    config: &KernelExecutorConfig,
    input: &Value,
) -> KernelResult<String> {
    let query = required_string(input, "query")?;
    let field = match get_string(input, "field").as_deref().unwrap_or("all") {
        "all" => "all",
        "title" => "ti",
        "author" => "au",
        "abstract" => "abs",
        "category" => "cat",
        "id" => "id",
        _ => {
            return Err(KernelError::InvalidCommand(
                "arxiv.search field is unsupported".to_string(),
            ))
        }
    };
    let start = input
        .get("start")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(10_000);
    let limit = input
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .clamp(1, 30);
    let sort_by = get_string(input, "sortBy").unwrap_or_else(|| "relevance".to_string());
    let sort_order = get_string(input, "sortOrder").unwrap_or_else(|| "descending".to_string());
    let url = format!(
        "{}/query?search_query={field}:{}&start={start}&max_results={limit}&sortBy={}&sortOrder={}",
        config.arxiv_api_base_url.trim_end_matches('/'),
        percent_encode(&query),
        percent_encode(&sort_by),
        percent_encode(&sort_order),
    );
    validate_http_url(&url)?;
    Ok(url)
}

pub(super) fn arxiv_read_target_url(
    config: &KernelExecutorConfig,
    input: &Value,
) -> KernelResult<String> {
    let id = required_string(input, "id")?;
    let url = format!(
        "{}/query?id_list={}&max_results=1",
        config.arxiv_api_base_url.trim_end_matches('/'),
        percent_encode(&id),
    );
    validate_http_url(&url)?;
    Ok(url)
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
pub(super) struct GithubSearchExecutor {
    pub(super) config: KernelExecutorConfig,
    pub(super) secret_provider: Arc<dyn SecretProvider>,
}
pub(super) struct GithubReadExecutor {
    pub(super) config: KernelExecutorConfig,
    pub(super) secret_provider: Arc<dyn SecretProvider>,
}
pub(super) struct ArxivSearchExecutor {
    pub(super) config: KernelExecutorConfig,
}
pub(super) struct ArxivReadExecutor {
    pub(super) config: KernelExecutorConfig,
}

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

impl KernelToolExecutor for GithubSearchExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        _context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let url = github_search_target_url(&self.config, &invocation.input)?;
        let kind =
            get_string(&invocation.input, "kind").unwrap_or_else(|| "repositories".to_string());
        let response = http_get_complete_with_headers(
            &url,
            512 * 1024,
            github_headers(&self.config, self.secret_provider.as_ref(), kind == "code")?,
        )?;
        let body = serde_json::from_str::<Value>(&response.body).map_err(|error| {
            KernelError::InvalidCommand(format!("GitHub search response is invalid JSON: {error}"))
        })?;
        let items = body.get("items").and_then(Value::as_array).ok_or_else(|| {
            KernelError::InvalidCommand(
                "GitHub search response requires an items array".to_string(),
            )
        })?;
        let limit = invocation
            .input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(10)
            .clamp(1, 30) as usize;
        let results = items
            .iter()
            .take(limit)
            .map(|item| github_search_result(&kind, item))
            .collect::<KernelResult<Vec<_>>>()?;
        let page = invocation
            .input
            .get("page")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .clamp(1, 100);
        let total_count = body.get("total_count").and_then(Value::as_u64).unwrap_or(0);
        let has_more = page.saturating_mul(limit as u64) < total_count;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "backendId": "github",
                "query": required_string(&invocation.input, "query")?,
                "kind": kind,
                "page": page,
                "nextPage": has_more.then_some(page + 1),
                "totalCount": total_count,
                "incomplete": body.get("incomplete_results").and_then(Value::as_bool).unwrap_or(false),
                "results": results,
                "retrievedAtMs": unix_millis(),
                "sourceUrl": response.final_url,
                "rateLimit": github_rate_limit(&response.headers),
                "truncated": response.truncated
            }),
        ))
    }
}

impl KernelToolExecutor for GithubReadExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        _context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let url = github_read_target_url(&self.config, &invocation.input)?;
        let max_bytes = invocation
            .input
            .get("maxBytes")
            .and_then(Value::as_u64)
            .unwrap_or(262_144)
            .clamp(1_024, 262_144) as usize;
        let response = http_get_complete_with_headers(
            &url,
            max_bytes.saturating_mul(2).saturating_add(64 * 1024),
            github_headers(&self.config, self.secret_provider.as_ref(), false)?,
        )?;
        let body = serde_json::from_str::<Value>(&response.body).map_err(|error| {
            KernelError::InvalidCommand(format!(
                "GitHub contents response is invalid JSON: {error}"
            ))
        })?;
        let repository = required_string(&invocation.input, "repository")?;
        let path = get_string(&invocation.input, "path").unwrap_or_else(|| ".".to_string());
        let reference = get_string(&invocation.input, "ref");
        let mut output = serde_json::json!({
            "sourceId": format!("github:{repository}:{path}"),
            "backendId": "github",
            "repository": repository,
            "path": path,
            "ref": reference,
            "retrievedAtMs": unix_millis(),
            "sourceUrl": response.final_url,
            "rateLimit": github_rate_limit(&response.headers),
            "truncated": response.truncated
        });
        if let Some(entries) = body.as_array() {
            output["type"] = json!("directory");
            output["entries"] = Value::Array(
                entries
                    .iter()
                    .map(github_directory_entry)
                    .collect::<KernelResult<Vec<_>>>()?,
            );
            return Ok(ok(invocation.id, output));
        }
        let record = body.as_object().ok_or_else(|| {
            KernelError::InvalidCommand(
                "GitHub contents response has an unsupported shape".to_string(),
            )
        })?;
        let kind = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        output["type"] = json!(kind);
        for (source, target) in [
            ("sha", "sha"),
            ("html_url", "htmlUrl"),
            ("download_url", "downloadUrl"),
        ] {
            if let Some(value) = record.get(source).and_then(Value::as_str) {
                output[target] = json!(value);
            }
        }
        if let Some(size) = record.get("size").and_then(Value::as_u64) {
            output["sizeBytes"] = json!(size);
        }
        if kind == "file" {
            let encoding = record.get("encoding").and_then(Value::as_str).unwrap_or("");
            let encoded = record
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    KernelError::InvalidCommand(
                        "GitHub file response does not include inline content".to_string(),
                    )
                })?;
            if encoding != "base64" {
                return Err(KernelError::InvalidCommand(format!(
                    "GitHub file encoding is unsupported: {encoding}"
                )));
            }
            let compact = encoded
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>();
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(compact)
                .map_err(|error| {
                    KernelError::InvalidCommand(format!("decode GitHub content: {error}"))
                })?;
            let content_truncated = decoded.len() > max_bytes;
            let clipped = &decoded[..decoded.len().min(max_bytes)];
            let content = std::str::from_utf8(clipped).map_err(|_| {
                KernelError::InvalidCommand(
                    "GitHub file content is not UTF-8 text; use the download URL as an artifact source"
                        .to_string(),
                )
            })?;
            output["content"] = json!(content);
            output["contentHash"] = json!(deepcode_kernel_tools::hash_bytes(&decoded));
            output["truncated"] = json!(response.truncated || content_truncated);
        }
        Ok(ok(invocation.id, output))
    }
}

impl KernelToolExecutor for ArxivSearchExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        _context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let url = arxiv_search_target_url(&self.config, &invocation.input)?;
        let response = http_get_complete(&url, 512 * 1024, None)?;
        let feed = parse_arxiv_feed(&response.body)?;
        let start = invocation
            .input
            .get("start")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let limit = invocation
            .input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(10)
            .clamp(1, 30);
        let has_more = start.saturating_add(feed.entries.len() as u64) < feed.total_results;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "backendId": "arxiv",
                "query": required_string(&invocation.input, "query")?,
                "start": start,
                "nextStart": has_more.then_some(start + limit),
                "totalCount": feed.total_results,
                "results": feed.entries,
                "retrievedAtMs": unix_millis(),
                "sourceUrl": response.final_url,
                "truncated": response.truncated
            }),
        ))
    }
}

impl KernelToolExecutor for ArxivReadExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        _context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let url = arxiv_read_target_url(&self.config, &invocation.input)?;
        let response = http_get_complete(&url, 256 * 1024, None)?;
        let mut feed = parse_arxiv_feed(&response.body)?;
        let entry = feed.entries.pop().ok_or_else(|| {
            KernelError::InvalidCommand("arXiv did not return the requested paper".to_string())
        })?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "backendId": "arxiv",
                "paper": entry,
                "retrievedAtMs": unix_millis(),
                "sourceUrl": response.final_url,
                "truncated": response.truncated
            }),
        ))
    }
}

fn github_headers(
    config: &KernelExecutorConfig,
    secret_provider: &dyn SecretProvider,
    authentication_required: bool,
) -> KernelResult<Vec<(String, String)>> {
    let secret_ref = config.github_auth_secret_ref.trim();
    let token = if secret_ref.is_empty() {
        None
    } else {
        Some(secret_provider.resolve(secret_ref).ok_or_else(|| {
            KernelError::PermissionDenied("GitHub auth SecretRef could not be resolved".to_string())
        })?)
    };
    if authentication_required && token.is_none() {
        return Err(KernelError::Structured {
            code: "github_code_search_auth_required",
            stage: "execution",
            message: "github.search kind=code requires DEEPCODE_GITHUB_TOKEN at daemon startup"
                .to_string(),
            details: serde_json::json!({ "toolId": "github.search", "kind": "code" }),
        });
    }
    let mut headers = vec![
        (
            "Accept".to_string(),
            "application/vnd.github+json".to_string(),
        ),
        (
            "X-GitHub-Api-Version".to_string(),
            GITHUB_API_VERSION.to_string(),
        ),
    ];
    if let Some(token) = token {
        headers.push(("Authorization".to_string(), format!("Bearer {token}")));
    }
    Ok(headers)
}

fn github_search_result(kind: &str, item: &Value) -> KernelResult<Value> {
    let source_url = item
        .get("html_url")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            KernelError::InvalidCommand("GitHub search item requires html_url".to_string())
        })?;
    let (title, repository, path, snippet, updated_at) = match kind {
        "repositories" => (
            item.get("full_name")
                .and_then(Value::as_str)
                .unwrap_or(source_url)
                .to_string(),
            item.get("full_name")
                .and_then(Value::as_str)
                .map(str::to_string),
            None,
            item.get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            item.get("updated_at")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        "code" => (
            item.get("name")
                .and_then(Value::as_str)
                .unwrap_or(source_url)
                .to_string(),
            item.get("repository")
                .and_then(|value| value.get("full_name"))
                .and_then(Value::as_str)
                .map(str::to_string),
            item.get("path").and_then(Value::as_str).map(str::to_string),
            item.get("path").and_then(Value::as_str).map(str::to_string),
            None,
        ),
        "issues" => (
            item.get("title")
                .and_then(Value::as_str)
                .unwrap_or(source_url)
                .to_string(),
            item.get("repository_url")
                .and_then(Value::as_str)
                .and_then(github_repository_from_api_url),
            None,
            item.get("body").and_then(Value::as_str).map(str::to_string),
            item.get("updated_at")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        _ => {
            return Err(KernelError::InvalidCommand(
                "GitHub search result kind is unsupported".to_string(),
            ))
        }
    };
    Ok(json!({
        "sourceId": source_url,
        "backendId": "github",
        "title": title,
        "url": source_url,
        "repository": repository,
        "path": path,
        "snippet": snippet.map(|value| limit_text(&value, 4_096)),
        "updatedAt": updated_at,
        "truncated": false
    }))
}

fn github_repository_from_api_url(url: &str) -> Option<String> {
    let parts = url.trim_end_matches('/').split('/').collect::<Vec<_>>();
    (parts.len() >= 2).then(|| format!("{}/{}", parts[parts.len() - 2], parts[parts.len() - 1]))
}

fn github_directory_entry(item: &Value) -> KernelResult<Value> {
    let path = required_string(item, "path")?;
    Ok(json!({
        "name": required_string(item, "name")?,
        "path": path,
        "type": required_string(item, "type")?,
        "sizeBytes": item.get("size").and_then(Value::as_u64),
        "sha": item.get("sha").and_then(Value::as_str),
        "htmlUrl": item.get("html_url").and_then(Value::as_str),
        "downloadUrl": item.get("download_url").and_then(Value::as_str)
    }))
}

fn github_rate_limit(headers: &BTreeMap<String, String>) -> Value {
    json!({
        "limit": header_u64(headers, "x-ratelimit-limit"),
        "remaining": header_u64(headers, "x-ratelimit-remaining"),
        "used": header_u64(headers, "x-ratelimit-used"),
        "resetAtEpochSeconds": header_u64(headers, "x-ratelimit-reset"),
        "resource": headers.get("x-ratelimit-resource")
    })
}

fn header_u64(headers: &BTreeMap<String, String>, name: &str) -> Option<u64> {
    headers
        .get(name)
        .and_then(|value| value.parse::<u64>().ok())
}

struct ArxivFeed {
    total_results: u64,
    entries: Vec<Value>,
}

fn parse_arxiv_feed(body: &str) -> KernelResult<ArxivFeed> {
    let document = roxmltree::Document::parse(body).map_err(|error| {
        KernelError::InvalidCommand(format!("arXiv response is invalid Atom XML: {error}"))
    })?;
    let total_results = document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "totalResults")
        .and_then(|node| node.text())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let entries = document
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "entry")
        .map(arxiv_entry)
        .collect::<KernelResult<Vec<_>>>()?;
    Ok(ArxivFeed {
        total_results,
        entries,
    })
}

fn arxiv_entry(entry: roxmltree::Node<'_, '_>) -> KernelResult<Value> {
    let id_url = arxiv_child_text(entry, "id")
        .ok_or_else(|| KernelError::InvalidCommand("arXiv entry requires id".to_string()))?;
    let arxiv_id = id_url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(id_url.as_str())
        .to_string();
    let authors = entry
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "author")
        .filter_map(|author| arxiv_child_text(author, "name"))
        .collect::<Vec<_>>();
    let categories = entry
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "category")
        .filter_map(|node| node.attribute("term").map(str::to_string))
        .collect::<Vec<_>>();
    let primary_category = entry
        .children()
        .find(|node| node.is_element() && node.tag_name().name() == "primary_category")
        .and_then(|node| node.attribute("term"))
        .map(str::to_string)
        .or_else(|| categories.first().cloned());
    let pdf_url = entry
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "link")
        .find(|node| {
            node.attribute("title") == Some("pdf")
                || node.attribute("type") == Some("application/pdf")
        })
        .and_then(|node| node.attribute("href"))
        .map(str::to_string);
    let title = arxiv_child_text(entry, "title").unwrap_or_else(|| arxiv_id.clone());
    Ok(json!({
        "sourceId": format!("arxiv:{arxiv_id}"),
        "backendId": "arxiv",
        "arxivId": arxiv_id,
        "title": normalize_atom_text(&title),
        "url": id_url,
        "pdfUrl": pdf_url,
        "summary": arxiv_child_text(entry, "summary").map(|value| normalize_atom_text(&value)),
        "authors": authors,
        "publishedAt": arxiv_child_text(entry, "published"),
        "updatedAt": arxiv_child_text(entry, "updated"),
        "primaryCategory": primary_category,
        "categories": categories,
        "doi": arxiv_child_text(entry, "doi"),
        "truncated": false
    }))
}

fn arxiv_child_text(node: roxmltree::Node<'_, '_>, name: &str) -> Option<String> {
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
    headers: BTreeMap<String, String>,
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
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
        })
        .collect::<BTreeMap<_, _>>();
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
        headers,
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
