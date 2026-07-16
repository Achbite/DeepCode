use super::*;

fn test_profile() -> ResolvedLlmProfile {
    ResolvedLlmProfile {
        id: "profile-1".to_string(),
        name: "DeepSeek V4 Pro".to_string(),
        kind: "openaiCompatible".to_string(),
        provider_flavor: Some("deepseek".to_string()),
        base_url: Some("https://api.example.test/v1".to_string()),
        model: "deepseek-v4-pro".to_string(),
        max_output_tokens: Some(1024),
        temperature: None,
        reasoning_effort: None,
        thinking: None,
        api_key: Some("secret".to_string()),
    }
}

#[test]
fn provider_json_decode_diagnostic_keeps_raw_response_context() {
    let profile = test_profile();
    let diagnostic = provider_response_error(ProviderDiagnosticInput {
        profile: &profile,
        provider: "openaiCompatible",
        reason: "ProviderJsonDecodeFailed",
        error_layer: LlmProviderErrorLayer::JsonDecode,
        status: Some(200),
        content_type: Some("text/html"),
        body: "token: should-not-leak\n<html>bad gateway</html>",
        body_hash: Some("abc123"),
        is_stream: false,
        expected_schema: "openai.chat.completion.v1: choices[0].message",
        message: "expected value at line 1 column 1".to_string(),
    });

    assert_eq!(diagnostic.reason, "ProviderJsonDecodeFailed");
    assert_eq!(diagnostic.status, Some(200));
    assert_eq!(diagnostic.content_type, "text/html");
    assert!(!diagnostic.is_stream);
    assert_eq!(
        diagnostic.expected_schema,
        "openai.chat.completion.v1: choices[0].message"
    );
    assert!(diagnostic
        .body_preview
        .contains("[redacted-provider-error-line]"));
    assert!(!diagnostic.body_preview.contains("should-not-leak"));
    let archive_text = diagnostic.archive_text();
    assert!(archive_text.contains("ProviderJsonDecodeFailed:"));
    assert!(archive_text.contains("content_type = text/html"));
    assert!(archive_text.contains("expected_schema = openai.chat.completion.v1"));
}

#[test]
fn openai_request_body_clamps_excessive_max_tokens() {
    let mut profile = test_profile();
    profile.max_output_tokens = Some(384_000);

    let body = openai_compatible_request_body(
        &profile,
        vec![json!({ "role": "user", "content": "hello" })],
        &[],
        None,
        false,
    );

    assert_eq!(
        body["max_tokens"].as_u64(),
        Some(OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS_CAP as u64)
    );
}

#[test]
fn openai_request_body_keeps_configured_max_tokens_under_cap() {
    let mut profile = test_profile();
    profile.max_output_tokens = Some(2048);

    let body = openai_compatible_request_body(
        &profile,
        vec![json!({ "role": "user", "content": "hello" })],
        &[],
        None,
        false,
    );

    assert_eq!(body["max_tokens"].as_u64(), Some(2048));
}

#[test]
fn openai_request_body_preserves_json_response_format() {
    let body = openai_compatible_request_body(
        &test_profile(),
        vec![json!({ "role": "user", "content": "hello" })],
        &[],
        Some(&json!({ "type": "json_object" })),
        false,
    );

    assert_eq!(
        body["response_format"]["type"].as_str(),
        Some("json_object")
    );
}

#[test]
fn deepseek_stream_request_includes_usage_options() {
    let body = openai_compatible_request_body(
        &test_profile(),
        vec![json!({ "role": "user", "content": "hello" })],
        &[],
        None,
        true,
    );

    assert_eq!(body["stream"].as_bool(), Some(true));
    assert_eq!(
        body["stream_options"]["include_usage"].as_bool(),
        Some(true)
    );
}

#[test]
fn zhipu_stream_request_enables_tool_stream_for_tools() {
    let mut profile = test_profile();
    profile.name = "Zhipu GLM".to_string();
    profile.provider_flavor = Some("zhipu".to_string());
    profile.base_url = Some("https://open.bigmodel.cn/api/paas/v4".to_string());
    profile.model = "glm-4.5".to_string();
    let tools = vec![LlmToolDefinition {
        name: "fs.read".to_string(),
        description: "Read a generic file.".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": { "path": { "type": "string" } }
        }),
    }];

    let body = openai_compatible_request_body(
        &profile,
        vec![json!({ "role": "user", "content": "hello" })],
        &tools,
        None,
        true,
    );

    assert_eq!(body["stream"].as_bool(), Some(true));
    assert_eq!(body["tool_stream"].as_bool(), Some(true));
    assert_eq!(
        body["tools"][0]["function"]["name"].as_str(),
        Some("fs__read")
    );
}

#[test]
fn openai_request_body_normalizes_internal_tool_messages() {
    let body = openai_compatible_request_body(
        &test_profile(),
        vec![
            json!({
                "role": "assistant",
                "content": "",
                "toolCalls": [{
                    "id": "call-generic",
                    "name": "fs.read",
                    "arguments": { "path": "generic.txt" }
                }]
            }),
            json!({
                "role": "tool",
                "toolCallId": "call-generic",
                "content": { "ok": true }
            }),
        ],
        &[],
        None,
        true,
    );

    let assistant = &body["messages"][0];
    assert!(assistant.get("toolCalls").is_none());
    assert_eq!(
        assistant["tool_calls"][0]["function"]["name"].as_str(),
        Some("fs__read")
    );
    let arguments = assistant["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap();
    let parsed: Value = serde_json::from_str(arguments).unwrap();
    assert_eq!(parsed["path"].as_str(), Some("generic.txt"));

    let tool = &body["messages"][1];
    assert!(tool.get("toolCallId").is_none());
    assert_eq!(tool["tool_call_id"].as_str(), Some("call-generic"));
    assert_eq!(tool["content"].as_str(), Some("{\"ok\":true}"));
}

#[test]
fn llm_output_payload_preserves_provider_usage() {
    let payload = llm_output_payload(LlmChatOutput {
        content: "done".to_string(),
        reasoning: None,
        tool_calls: Vec::new(),
        usage: Some(json!({
            "prompt_cache_hit_tokens": 80,
            "prompt_cache_miss_tokens": 20,
            "prompt_tokens": 100,
            "completion_tokens": 12,
            "total_tokens": 112
        })),
    });

    assert_eq!(
        payload["usage"]["prompt_cache_hit_tokens"].as_u64(),
        Some(80)
    );
    assert_eq!(
        payload["usage"]["prompt_cache_miss_tokens"].as_u64(),
        Some(20)
    );
    assert_eq!(payload["usage"]["prompt_tokens"].as_u64(), Some(100));
    assert_eq!(payload["usage"]["completion_tokens"].as_u64(), Some(12));
    assert_eq!(payload["usage"]["total_tokens"].as_u64(), Some(112));
}

#[test]
fn openai_sse_parser_collects_content_reasoning_and_usage() {
    let output = parse_openai_compatible_sse_text(
        r#"data: {"choices":[{"index":0,"delta":{"reasoning_content":"reason "}}]}

data: {"choices":[{"index":0,"delta":{"content":"hel"}}]}

data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}

data: [DONE]

"#,
    );

    assert_eq!(output.reasoning.as_deref(), Some("reason "));
    assert_eq!(output.content, "hello");
    assert_eq!(output.usage.unwrap()["total_tokens"].as_u64(), Some(6));
}

#[test]
fn openai_sse_parser_accumulates_tool_call_arguments() {
    let output = parse_openai_compatible_sse_text(
        r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-generic","function":{"name":"fs__read","arguments":"{\"pa"}}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"generic.txt\"}"}}]},"finish_reason":"tool_calls"}]}

data: [DONE]

"#,
    );

    assert_eq!(output.tool_calls.len(), 1);
    assert_eq!(output.tool_calls[0].id, "call-generic");
    assert_eq!(output.tool_calls[0].name, "fs.read");
    assert_eq!(
        output.tool_calls[0].arguments["path"].as_str(),
        Some("generic.txt")
    );
}
