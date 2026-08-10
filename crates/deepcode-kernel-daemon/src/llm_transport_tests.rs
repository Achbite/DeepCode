use super::*;

// Supporting development contracts only. They verify transport invariants but
// do not replace a real configured Provider conversation or user acceptance.

fn test_profile() -> ResolvedLlmProfile {
    ResolvedLlmProfile {
        id: "profile-1".to_string(),
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
fn provider_public_error_event_uses_bounded_message_and_ignores_raw_detail() {
    let event = provider_public_error_event(
        "request-public-error-contract",
        "ProviderJsonDecodeFailed",
        "token: should-not-leak\n<html>bad gateway</html>",
    );

    assert!(event.contains("provider_error"));
    assert!(event.contains("request-public-error-contract"));
    assert!(event.contains("ProviderJsonDecodeFailed"));
    assert!(event.contains("Provider stream failed before a validated terminal receipt."));
    assert!(!event.contains("should-not-leak"));
    assert!(!event.contains("bad gateway"));
}

#[test]
fn openai_request_body_preserves_current_profile_max_output_tokens() {
    let mut profile = test_profile();
    profile.max_output_tokens = Some(384_000);
    let expected_max_output_tokens = effective_openai_compatible_max_tokens(&profile);

    assert_eq!(
        expected_max_output_tokens,
        Some(384_000),
        "the current resolved Provider Profile output budget must pass through without transport-local reduction"
    );

    let body = openai_compatible_request_body(
        &profile,
        vec![json!({ "role": "user", "content": "hello" })],
        &[],
        None,
        false,
    );

    assert_eq!(
        body["max_tokens"].as_u64(),
        expected_max_output_tokens.map(u64::from)
    );
}

#[test]
fn openai_request_body_keeps_configured_profile_output_budget() {
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

#[test]
fn provider_native_stream_completion_and_reasoning_gate() {
    let mut openai =
        ProviderNativeStreamAccumulatorV1::new(ProviderNativeStreamKindV1::OpenAiCompatible);
    openai
        .ingest_payload(br#"{"choices":[{"index":0,"delta":{"reasoning_content":"reason "}}]}"#)
        .unwrap();
    openai
        .ingest_payload(
            br#"{"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}"#,
        )
        .unwrap();
    openai.ingest_payload(b"[DONE]").unwrap();
    let openai = openai.finalize().unwrap();
    assert_eq!(
        openai.completion.provider_kind,
        ProviderNativeStreamKindV1::OpenAiCompatible
    );
    assert_eq!(openai.completion.finish_reason.as_deref(), Some("stop"));
    assert_eq!(openai.output.reasoning.as_deref(), Some("reason "));
    assert_eq!(openai.output.content, "OK");

    let mut anthropic =
        ProviderNativeStreamAccumulatorV1::new(ProviderNativeStreamKindV1::Anthropic);
    anthropic
        .ingest_payload(
            br#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason "}}"#,
        )
        .unwrap();
    anthropic
        .ingest_payload(
            br#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"OK"}}"#,
        )
        .unwrap();
    anthropic
        .ingest_payload(br#"{"type":"message_stop"}"#)
        .unwrap();
    let anthropic = anthropic.finalize().unwrap();
    assert_eq!(
        anthropic.completion.provider_kind,
        ProviderNativeStreamKindV1::Anthropic
    );
    assert_eq!(anthropic.output.reasoning.as_deref(), Some("reason "));
    assert_eq!(anthropic.output.content, "OK");

    let mut ollama = ProviderNativeStreamAccumulatorV1::new(ProviderNativeStreamKindV1::Ollama);
    ollama
        .ingest_payload(br#"{"message":{"thinking":"reason ","content":"OK"},"done":true}"#)
        .unwrap();
    let ollama = ollama.finalize().unwrap();
    assert_eq!(
        ollama.completion.provider_kind,
        ProviderNativeStreamKindV1::Ollama
    );
    assert_eq!(ollama.output.reasoning.as_deref(), Some("reason "));
    assert_eq!(ollama.output.content, "OK");

    for (kind, terminal) in [
        (
            ProviderNativeStreamKindV1::OpenAiCompatible,
            vec![
                br#"{"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}"#
                    .as_slice(),
                b"[DONE]".as_slice(),
            ],
        ),
        (
            ProviderNativeStreamKindV1::Anthropic,
            vec![br#"{"type":"message_stop"}"#.as_slice()],
        ),
        (
            ProviderNativeStreamKindV1::Ollama,
            vec![br#"{"message":{"content":"OK"},"done":true}"#.as_slice()],
        ),
    ] {
        let mut accumulator = ProviderNativeStreamAccumulatorV1::new(kind);
        for payload in terminal {
            accumulator.ingest_payload(payload).unwrap();
        }
        let error = accumulator.finalize().unwrap_err();
        assert_eq!(error.code, "provider_reasoning_missing");
    }
}

#[test]
fn provider_native_stream_eof_and_invalid_finish_fail_closed() {
    for (kind, payload) in [
        (
            ProviderNativeStreamKindV1::OpenAiCompatible,
            br#"{"choices":[{"index":0,"delta":{"reasoning":"reason"}}]}"#.as_slice(),
        ),
        (
            ProviderNativeStreamKindV1::Anthropic,
            br#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}"#.as_slice(),
        ),
        (
            ProviderNativeStreamKindV1::Ollama,
            br#"{"message":{"thinking":"reason"},"done":false}"#.as_slice(),
        ),
    ] {
        let mut accumulator = ProviderNativeStreamAccumulatorV1::new(kind);
        accumulator.ingest_payload(payload).unwrap();
        let error = accumulator.finalize().unwrap_err();
        assert_eq!(error.code, "provider_stream_native_terminal_missing");
    }

    let mut invalid_finish =
        ProviderNativeStreamAccumulatorV1::new(ProviderNativeStreamKindV1::OpenAiCompatible);
    let error = invalid_finish
        .ingest_payload(
            br#"{"choices":[{"index":0,"delta":{"reasoning":"reason"},"finish_reason":"length"}]}"#,
        )
        .unwrap_err();
    assert_eq!(error.code, "provider_stream_finish_reason_invalid");
    assert!(!invalid_finish.source_done());
}

#[test]
fn ollama_complete_arguments_are_deduplicated_and_conflicts_fail() {
    let first = br#"{"message":{"thinking":"reason","tool_calls":[{"function":{"name":"fs__read","arguments":{"path":"README.md"}}}]},"done":false}"#;
    let repeated = br#"{"message":{"tool_calls":[{"function":{"name":"fs__read","arguments":{"path":"README.md"}}}]},"done":false}"#;
    let conflict = br#"{"message":{"tool_calls":[{"function":{"name":"fs__read","arguments":{"path":"NOTICE.md"}}}]},"done":false}"#;

    let mut deduplicated =
        ProviderNativeStreamAccumulatorV1::new(ProviderNativeStreamKindV1::Ollama);
    let first_emissions = deduplicated.ingest_payload(first).unwrap();
    assert_eq!(first_emissions.len(), 2);
    assert!(deduplicated.ingest_payload(repeated).unwrap().is_empty());
    deduplicated.ingest_payload(br#"{"done":true}"#).unwrap();
    let result = deduplicated.finalize().unwrap();
    assert_eq!(result.output.tool_calls.len(), 1);
    assert_eq!(
        result.output.tool_calls[0].arguments["path"].as_str(),
        Some("README.md")
    );

    let mut conflicting =
        ProviderNativeStreamAccumulatorV1::new(ProviderNativeStreamKindV1::Ollama);
    conflicting.ingest_payload(first).unwrap();
    let error = conflicting.ingest_payload(conflict).unwrap_err();
    assert_eq!(error.code, "provider_tool_call_arguments_conflict");
    assert!(!conflicting.source_done());
}

#[test]
fn provider_probe_timeout_mapping_is_stable() {
    assert_eq!(LLM_PROFILE_PROBE_TIMEOUT, Duration::from_secs(60));
    let error = provider_probe_timeout_error();
    assert_eq!(error.code, "provider_probe_timeout");
    assert_eq!(error.http_status, None);
    assert_eq!(
        error.safe_message(),
        "Provider probe did not reach a validated native completion before its deadline."
    );
}
