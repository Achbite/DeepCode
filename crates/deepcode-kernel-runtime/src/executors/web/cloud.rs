use super::*;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

const RESPONSE_LIMIT: usize = 1024 * 1024;

pub(super) fn invoke(
    query: &str,
    limit: usize,
    config: CloudWebSearchConfig,
    api_key: String,
    cancellation: &KernelCancellationToken,
    archive: &mut ExecutionArchive,
) -> KernelResult<Value> {
    validate_http_url(&config.endpoint)?;
    if config.provider == CloudWebSearchProvider::Glm && query.chars().count() > 70 {
        return Err(KernelError::InvalidCommand(
            "GLM search query must be at most 70 characters".into(),
        ));
    }
    let body = request_body(config.provider, query, limit);
    archive
        .record(
            "request.started",
            json!({ "method": "POST", "url": config.endpoint, "body": body }),
        )
        .map_err(archive_error)?;
    // Own and join the transport worker; cancellation drops the active request.
    std::thread::scope(|scope| {
        std::thread::Builder::new().name("deepcode-cloud-search".into()).spawn_scoped(scope, || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()
                .map_err(|error| KernelError::Other(error.to_string()))?;
            let bytes = runtime.block_on(async {
                tokio::select! {
                    result = request(&config, &api_key, &body, archive) => result,
                    _ = cancelled(cancellation) => Err(search_error("web_search_cancelled", "Search was cancelled")),
                }
            })?;
            let parsed: Value = serde_json::from_slice(&bytes)
                .map_err(|error| search_error("web_search_response_invalid", &error.to_string()))?;
            let mut output = parse_response(config.provider, &parsed, limit)?;
            output["query"] = search_query_metadata(query, None);
            output["sourceUrl"] = json!(config.endpoint);
            output["retrievedAtMs"] = json!(unix_millis());
            output["contentHash"] = json!(deepcode_kernel_tools::hash_bytes(&bytes));
            output["untrustedEvidence"] = json!(true);
            Ok(output)
        }).map_err(|error| KernelError::Other(format!("start search worker: {error}")))?
            .join().map_err(|_| KernelError::Other("search worker panicked".into()))?
    })
}

pub(super) async fn cancelled(cancellation: &KernelCancellationToken) {
    while !cancellation.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn request_body(provider: CloudWebSearchProvider, query: &str, limit: usize) -> Value {
    match provider {
        CloudWebSearchProvider::DeepSeek => json!({
            "model": "deepseek-flash", "max_tokens": 4096,
            "messages": [{ "role": "user", "content": [{ "type": "text",
                "text": format!("Perform a web search for the query: {query}") }] }],
            "tools": [{ "type": "web_search_20250305", "name": "web_search", "max_uses": 5 }]
        }),
        CloudWebSearchProvider::Glm => json!({
            "search_query": query, "search_engine": "search_std",
            "search_intent": false, "count": limit,
        }),
        CloudWebSearchProvider::Kimi => json!({
            "name": "web_search", "arguments": json!({ "query": query }).to_string(),
        }),
    }
}

async fn request(
    config: &CloudWebSearchConfig,
    key: &str,
    body: &Value,
    archive: &mut ExecutionArchive,
) -> KernelResult<Vec<u8>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("DeepCode-Kernel/0.1")
        .build()
        .map_err(|error| KernelError::Other(error.to_string()))?;
    let mut request = client.post(&config.endpoint).bearer_auth(key).json(body);
    if config.provider == CloudWebSearchProvider::DeepSeek {
        request = request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01");
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| search_error("web_search_request_failed", &error.to_string()))?;
    let status = response.status();
    archive.record("response.headers", json!({
        "statusCode": status.as_u16(),
        "contentType": response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
    })).map_err(archive_error)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| search_error("web_search_response_failed", &error.to_string()))?
    {
        archive
            .bytes("response.chunk", &chunk)
            .map_err(archive_error)?;
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err(search_error(
                "web_search_response_too_large",
                "Search response exceeds 1 MiB",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let detail = String::from_utf8_lossy(&bytes).replace(key, "[redacted]");
        let detail: String = detail.chars().take(512).collect();
        return Err(search_error(
            "web_search_provider_error",
            &format!("HTTP {}: {detail}", status.as_u16()),
        ));
    }
    Ok(bytes)
}

fn parse_response(
    provider: CloudWebSearchProvider,
    response: &Value,
    limit: usize,
) -> KernelResult<Value> {
    if let Some(error) = response.get("error").filter(|value| !value.is_null()) {
        return Err(search_error(
            "web_search_provider_error",
            &error.to_string(),
        ));
    }
    match provider {
        CloudWebSearchProvider::DeepSeek => parse_deepseek(response, limit),
        CloudWebSearchProvider::Glm => {
            let items = response
                .get("search_result")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    search_error(
                        "web_search_response_invalid",
                        "GLM response lacks search_result",
                    )
                })?;
            let results = items
                .iter()
                .take(limit)
                .map(|item| source(item, "link", "content", "publish_date", "glmSearch"))
                .collect::<KernelResult<Vec<_>>>()?;
            Ok(json!({ "provider": "glm-search", "results": results,
                "truncated": items.len() > limit, "responseId": response.get("id"), "usage": response.get("usage") }))
        }
        CloudWebSearchProvider::Kimi => {
            if response["status"] != "succeeded" {
                return Err(search_error(
                    "web_search_provider_error",
                    &format!("Kimi search fiber did not succeed: {}", response["status"]),
                ));
            }
            let content = response
                .pointer("/context/encrypted_output")
                .or_else(|| response.pointer("/context/output"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .ok_or_else(|| {
                    search_error(
                        "web_search_response_invalid",
                        "Kimi search fiber lacks output",
                    )
                })?;
            // Formula output is opaque provider evidence, not a local sources
            // list. The Moonshot transport passes it back verbatim as tool content.
            Ok(
                json!({ "provider": "kimi-formula", "providerContent": content,
                "responseId": response.get("id"), "truncated": false }),
            )
        }
    }
}

fn parse_deepseek(response: &Value, limit: usize) -> KernelResult<Value> {
    let blocks = response["content"].as_array().ok_or_else(|| {
        search_error(
            "web_search_response_invalid",
            "DeepSeek response lacks content blocks",
        )
    })?;
    let snippets: HashMap<&str, &str> = blocks
        .iter()
        .filter(|block| block["type"] == "text")
        .flat_map(|block| block["citations"].as_array().into_iter().flatten())
        .filter_map(|citation| Some((citation["url"].as_str()?, citation["cited_text"].as_str()?)))
        .collect();
    let result_blocks = blocks
        .iter()
        .filter(|block| block["type"] == "web_search_tool_result")
        .collect::<Vec<_>>();
    if result_blocks.is_empty() {
        return Err(search_error(
            "web_search_not_executed",
            "DeepSeek returned no web_search_tool_result",
        ));
    }
    let mut results = Vec::new();
    let mut issues = Vec::new();
    let mut seen = HashSet::new();
    for (block_index, block) in result_blocks.into_iter().enumerate() {
        if block["content"]["type"] == "web_search_tool_result_error" {
            issues.push(json!({ "blockIndex": block_index,
                "code": "web_search_provider_error", "providerError": block["content"] }));
            continue;
        }
        let items = block["content"].as_array().ok_or_else(|| {
            search_error(
                "web_search_response_invalid",
                "DeepSeek search result content must be an array",
            )
        })?;
        for (item_index, item) in items.iter().enumerate() {
            if item["type"] == "web_search_tool_result_error" {
                issues.push(json!({ "blockIndex": block_index, "itemIndex": item_index,
                    "code": "web_search_provider_error", "providerError": item }));
                continue;
            }
            if item["type"] != "web_search_result" {
                issues.push(json!({ "blockIndex": block_index, "itemIndex": item_index,
                    "code": "web_search_result_type_unknown", "type": item.get("type") }));
                continue;
            }
            let mut result = match source(item, "url", "snippet", "page_age", "deepseekSearch") {
                Ok(result) => result,
                Err(error) => {
                    issues.push(json!({ "blockIndex": block_index, "itemIndex": item_index,
                        "code": "web_search_result_invalid", "url": item.get("url"), "message": error.to_string() }));
                    continue;
                }
            };
            let url = result["url"].as_str().expect("validated source URL");
            if !seen.insert(url.to_string()) {
                continue;
            }
            if let Some(snippet) = snippets.get(url) {
                result["snippet"] = json!(snippet);
            }
            results.push(result);
        }
    }
    if results.is_empty() && !issues.is_empty() {
        let provider_error = issues.iter().find_map(|issue| issue.get("providerError"));
        return Err(KernelError::Structured {
            code: if provider_error.is_some() {
                "web_search_provider_error"
            } else {
                "web_search_response_invalid"
            },
            stage: "execution",
            message: provider_error
                .map(Value::to_string)
                .unwrap_or_else(|| "Search returned no usable source entries".into()),
            details: json!({"resultIssues": issues}),
        });
    }
    let truncated = results.len() > limit;
    results.truncate(limit);
    let calls = blocks
        .iter()
        .filter(|block| block["type"] == "server_tool_use" && block["name"] == "web_search")
        .cloned()
        .collect::<Vec<_>>();
    Ok(
        json!({ "provider": "deepseek-search", "results": results, "truncated": truncated,
        "responseId": response.get("id"), "model": response.get("model"),
        "searchCalls": calls, "usage": response.get("usage"),
        "partial": !issues.is_empty(), "resultIssues": issues }),
    )
}

fn source(
    item: &Value,
    url_field: &str,
    snippet_field: &str,
    date_field: &str,
    backend: &str,
) -> KernelResult<Value> {
    let url = required_string(item, url_field)?;
    validate_http_url(&url)?;
    Ok(json!({ "sourceId": url, "url": url, "backendId": backend,
        "title": optional_string(item, "title")?, "snippet": optional_string(item, snippet_field)?,
        "publishedAt": optional_string(item, date_field)?, "untrustedEvidence": true, "truncated": false }))
}

fn search_error(code: &'static str, message: &str) -> KernelError {
    KernelError::Structured {
        code,
        stage: "execution",
        message: message.into(),
        details: json!({}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_requests_use_each_providers_actual_search_protocol() {
        let query = "发布信息";
        let deepseek = request_body(CloudWebSearchProvider::DeepSeek, query, 3);
        assert_eq!(deepseek["tools"][0]["type"], "web_search_20250305");
        assert!(deepseek.get("thinking").is_none());
        let glm = request_body(CloudWebSearchProvider::Glm, query, 3);
        assert_eq!(
            glm,
            json!({ "search_query": query, "search_engine": "search_std", "search_intent": false, "count": 3 })
        );
        let kimi = request_body(CloudWebSearchProvider::Kimi, query, 3);
        assert_eq!(kimi["name"], "web_search");
        assert_eq!(
            serde_json::from_str::<Value>(kimi["arguments"].as_str().unwrap()).unwrap(),
            json!({ "query": query })
        );
    }

    #[test]
    fn deepseek_requires_real_results_and_joins_citations_without_prose_scraping() {
        let raw = json!({ "id": "response:1", "content": [
            { "type": "server_tool_use", "id": "search:1", "name": "web_search", "input": {"query": "release"} },
            { "type": "web_search_tool_result", "content": [
                { "type": "web_search_result", "url": "https://example.com/a", "title": "A" },
                { "type": "web_search_result", "url": "https://example.com/a", "title": "A duplicate" },
                { "type": "web_search_result", "url": "https://example.com/b", "title": "B" }
            ] },
            { "type": "text", "text": "not a search result", "citations": [{"url": "https://example.com/a", "cited_text": "excerpt"}] }
        ], "usage": {"server_tool_use": {"web_search_requests": 1}} });
        let output = parse_response(CloudWebSearchProvider::DeepSeek, &raw, 1).unwrap();
        assert_eq!(output["results"].as_array().unwrap().len(), 1);
        assert_eq!(output["results"][0]["snippet"], "excerpt");
        assert_eq!(output["searchCalls"][0]["id"], "search:1");
        assert_eq!(output["truncated"], true);
        assert!(parse_response(
            CloudWebSearchProvider::DeepSeek,
            &json!({"content": [{"type": "text", "text": "https://example.com"}]}),
            5
        )
        .is_err());
        assert!(parse_response(CloudWebSearchProvider::DeepSeek, &json!({"content": [{"type":"web_search_tool_result", "content":{"type":"web_search_tool_result_error", "error_code":"max_uses_exceeded"}}]}), 5).is_err());
        assert_eq!(
            parse_response(
                CloudWebSearchProvider::DeepSeek,
                &json!({"content": [{"type":"web_search_tool_result", "content":[]}]}),
                5
            )
            .unwrap()["results"],
            json!([])
        );
    }

    #[test]
    fn glm_sources_and_kimi_opaque_evidence_remain_distinct() {
        let glm = parse_response(CloudWebSearchProvider::Glm, &json!({"search_result": [
            {"title":"Release", "link":"https://example.com", "content":"Details", "publish_date":"2026-09-10"}
        ]}), 5).unwrap();
        assert_eq!(glm["results"][0]["snippet"], "Details");
        let encrypted = "----MOONSHOT ENCRYPTED BEGIN----test----MOONSHOT ENCRYPTED END----";
        let kimi = parse_response(CloudWebSearchProvider::Kimi, &json!({"status":"succeeded", "id":"fiber:1", "context":{"encrypted_output":encrypted}}), 5).unwrap();
        assert_eq!(kimi["providerContent"], encrypted);
        assert!(kimi.get("results").is_none());
        assert!(
            parse_response(CloudWebSearchProvider::Kimi, &json!({"status":"failed"}), 5).is_err()
        );
    }

    #[test]
    fn deepseek_keeps_usable_sources_and_exposes_bad_entries_without_inventing_urls() {
        let response = json!({"content": [{"type": "web_search_tool_result", "content": [
            {"type": "web_search_result", "url": "https://example.com/first", "title": "First"},
            {"type": "web_search_result", "url": "/relative", "title": "Invalid"},
            {"type": "unexpected_provider_item", "text": "https://example.com/not-a-source"},
            {"type": "web_search_result", "url": "https://example.com/last", "title": "Last"}
        ]}]});
        let output = parse_deepseek(&response, 5).unwrap();
        assert_eq!(output["results"].as_array().unwrap().len(), 2);
        assert_eq!(output["results"][1]["url"], "https://example.com/last");
        assert_eq!(output["partial"], true);
        assert_eq!(output["resultIssues"].as_array().unwrap().len(), 2);
        assert_eq!(output["resultIssues"][0]["url"], "/relative");
        assert!(parse_deepseek(
            &json!({"content": [{"type": "web_search_tool_result", "content": [
                {"type":"web_search_result", "url":"/relative"}
            ]}]}),
            5
        )
        .is_err());
        assert!(parse_deepseek(
            &json!({"content": [{"type": "web_search_tool_result", "content": [
                {"type":"web_search_tool_result_error", "error_code":"unavailable"}
            ]}]}),
            5
        )
        .is_err());
    }

    #[test]
    fn deepseek_retains_prior_sources_when_the_last_native_search_exhausts_its_limit() {
        // Shape observed in the real CLI archive: several result blocks, then
        // an error entry inside the last result array, not a failed HTTP request.
        let error =
            json!({"type":"web_search_tool_result_error", "error_code":"max_uses_exceeded"});
        let mut response = json!({"content":[
            {"type":"web_search_tool_result", "content":[{"type":"web_search_result", "url":"https://example.com/docs", "title":"Docs"}]},
            {"type":"web_search_tool_result", "content":[]},
            {"type":"web_search_tool_result", "content":[error.clone()]}
        ]});
        let output = parse_deepseek(&response, 5).unwrap();
        assert_eq!(output["results"].as_array().unwrap().len(), 1);
        assert_eq!(output["partial"], true);
        assert_eq!(output["resultIssues"][0]["providerError"], error);
        response["content"][0]["content"] = json!([]);
        assert!(matches!(
            parse_deepseek(&response, 5),
            Err(KernelError::Structured {
                code: "web_search_provider_error",
                ..
            })
        ));
    }
}
