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
        context_window_tokens: Some(128_000),
        max_output_tokens: Some(1024),
        temperature: None,
        reasoning_effort: None,
        thinking: None,
        api_key: Some("secret".to_string()),
    }
}

#[test]
fn planning_control_continuation_uses_current_plan_v5_contract() {
    let tool_name =
        provider_native_session_control_contract(&SessionProviderTargetBindingSidecarV2::Planning)
            .expect("planning must have a Session control continuation contract");

    assert_eq!(tool_name, "deepcode_session_plan_propose_v5");
    assert_ne!(tool_name, "deepcode_session_plan_propose_v4");
}

fn plan_reject_control_settlement_value() -> Value {
    let mut settlement = json!({
        "kind": "planDecision",
        "schemaVersion": "deepcode.session.provider-control-settlement.v2",
        "runId": "run-control-settlement",
        "inputId": "input-control-settlement",
        "controlEpoch": 1,
        "predecessorProviderTurnId": "provider-turn-plan",
        "nextTargetKind": "finalAnswer",
        "control": {
            "schemaVersion": "deepcode.session.plan-proposal.v5",
            "callId": "call-plan-proposal",
            "toolName": "deepcode_session_plan_propose_v5",
            "argumentsDigest": format!("sha256:{}", "a".repeat(64)),
        },
        "decision": {
            "planRevision": "plan-revision-1",
            "decision": "reject",
            "recordedAt": "2026-08-17T00:00:00.000Z",
        },
        "recordedAt": "2026-08-17T00:00:00.000Z",
    });
    let digest = crate::host_v2_storage::stable_json_sha256(&settlement)
        .expect("settlement fixture must have a stable digest");
    settlement
        .as_object_mut()
        .expect("settlement fixture must be an object")
        .insert("settlementDigest".to_string(), Value::String(digest));
    settlement
}

fn plan_preview_rejected_control_settlement_value() -> Value {
    let mut settlement = json!({
        "kind": "planPreviewRejected",
        "schemaVersion": "deepcode.session.provider-control-settlement.v2",
        "runId": "run-control-settlement",
        "inputId": "input-control-settlement",
        "controlEpoch": 1,
        "predecessorProviderTurnId": "provider-turn-plan",
        "nextTargetKind": "planning",
        "control": {
            "schemaVersion": "deepcode.session.plan-proposal.v5",
            "callId": "call-plan-proposal",
            "toolName": "deepcode_session_plan_propose_v5",
            "argumentsDigest": format!("sha256:{}", "a".repeat(64)),
        },
        "preview": {
            "planRevision": "plan-revision-1",
            "rejections": [{
                "planActionId": "plan-action-1",
                "operationId": "operation-1",
                "toolId": "fs.write",
                "reason": "requestedScopeInvalid",
                "guidance": "Use a workspace resource admitted by the current tool contract.",
            }],
        },
        "recordedAt": "2026-08-17T00:00:00.000Z",
    });
    let digest = crate::host_v2_storage::stable_json_sha256(&settlement)
        .expect("settlement fixture must have a stable digest");
    settlement
        .as_object_mut()
        .expect("settlement fixture must be an object")
        .insert("settlementDigest".to_string(), Value::String(digest));
    settlement
}

#[test]
fn plan_reject_control_settlement_closes_into_final_answer() {
    let settlement = serde_json::from_value::<SessionProviderControlSettlementSidecarV2>(
        plan_reject_control_settlement_value(),
    )
    .expect("the exact Plan rejection settlement must decode");

    settlement
        .validate()
        .expect("the exact Plan rejection settlement must validate");
    assert_eq!(settlement.next_target_kind(), "finalAnswer");
    assert_eq!(
        settlement.expected_parent_tool_name(),
        "deepcode_session_plan_propose_v5"
    );
    assert_eq!(
        settlement.continuation_output(),
        json!({
            "schemaVersion": "deepcode.session.control-continuation-result.v2",
            "status": "settled",
            "control": "deepcode_session_plan_propose_v5",
            "nextTargetKind": "finalAnswer",
            "decision": "reject",
            "planRevision": "plan-revision-1",
        })
    );

    let mut tampered = plan_reject_control_settlement_value();
    tampered["decision"]["decision"] = Value::String("accept".to_string());
    let tampered = serde_json::from_value::<SessionProviderControlSettlementSidecarV2>(tampered)
        .expect("the tampered settlement still has a decodable wire shape");
    assert!(
        tampered.validate().is_err(),
        "changing the decision without resealing the digest must fail closed"
    );
}

#[test]
fn plan_preview_rejection_closes_into_replanning() {
    let settlement = serde_json::from_value::<SessionProviderControlSettlementSidecarV2>(
        plan_preview_rejected_control_settlement_value(),
    )
    .expect("the exact Plan preview rejection settlement must decode");

    settlement
        .validate()
        .expect("the exact Plan preview rejection settlement must validate");
    assert_eq!(settlement.next_target_kind(), "planning");
    assert_eq!(
        settlement.expected_parent_tool_name(),
        "deepcode_session_plan_propose_v5"
    );
    assert_eq!(
        settlement.continuation_output(),
        json!({
            "schemaVersion": "deepcode.session.control-continuation-result.v2",
            "status": "rejected",
            "control": "deepcode_session_plan_propose_v5",
            "reasonCode": "planPreviewRejected",
            "nextTargetKind": "planning",
            "planRevision": "plan-revision-1",
            "rejections": [{
                "planActionId": "plan-action-1",
                "operationId": "operation-1",
                "toolId": "fs.write",
                "reason": "requestedScopeInvalid",
                "guidance": "Use a workspace resource admitted by the current tool contract.",
            }],
        })
    );

    let mut unsorted = plan_preview_rejected_control_settlement_value();
    unsorted["preview"]["rejections"] = json!([
        {
            "planActionId": "plan-action-2",
            "operationId": "operation-2",
            "toolId": "fs.write",
            "reason": "settingsDenied",
            "guidance": "Use an allowed resource.",
        },
        {
            "planActionId": "plan-action-1",
            "operationId": "operation-1",
            "toolId": "fs.write",
            "reason": "requestedScopeInvalid",
            "guidance": "Use a valid resource.",
        }
    ]);
    unsorted
        .as_object_mut()
        .expect("unsorted settlement must be an object")
        .remove("settlementDigest");
    let digest = crate::host_v2_storage::stable_json_sha256(&unsorted)
        .expect("unsorted settlement fixture must have a stable digest");
    unsorted["settlementDigest"] = Value::String(digest);
    let unsorted = serde_json::from_value::<SessionProviderControlSettlementSidecarV2>(unsorted)
        .expect("the unsorted settlement still has a decodable wire shape");
    assert!(
        unsorted.validate().is_err(),
        "Plan preview rejection items must be canonical, unique, and sorted"
    );
}

#[test]
fn session_control_append_without_durable_settlement_fails_closed() {
    let digest = format!("sha256:{}", "b".repeat(64));
    let sidecar = json!({
        "schemaVersion": SESSION_PROVIDER_ADMISSION_SIDECAR_SCHEMA_V2,
        "sessionId": "session-control-settlement",
        "runId": "run-control-settlement",
        "providerTurnId": "provider-turn-continuation",
        "userTurnId": "input-control-settlement",
        "controlEpoch": 1,
        "purpose": "continuation",
        "targetKind": "planning",
        "targetBinding": { "kind": "planning" },
        "providerProfileRevisionDigest": digest,
        "currentInputDigest": digest,
        "contextAssemblyDigest": digest,
        "semanticMessagesDigest": digest,
        "toolSchemaDigest": digest,
        "responseFormatDigest": digest,
        "toolContextRef": {
            "contextVersion": 1,
            "catalogDigest": digest,
            "contextDigest": digest,
        },
        "authority": {},
        "continuationOperationIds": [],
        "continuationOutcomes": [],
        "cacheLane": {
            "laneId": "lane-control-settlement",
            "laneRevision": 1,
            "mode": "append",
            "relationKind": "sameTurnSessionControlContinuation",
            "stablePrefixDigest": digest,
            "predecessorRequestId": "provider-turn-plan",
            "predecessorExternalDigest": digest,
        },
    });

    let error = SessionProviderAdmissionSidecarV2::decode_private_value(sidecar)
        .expect_err("a Session control append without its durable settlement must be rejected");
    assert_eq!(error.0, "provider_control_continuation_invalid");
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
fn provider_public_structured_error_event_exposes_only_safe_failure_metadata() {
    let structured_failure = json!({
        "schemaVersion": PROVIDER_STRUCTURED_OUTPUT_FAILURE_SCHEMA_V1,
        "disposition": "repairableNoMutation",
        "errorCode": "provider_tool_call_arguments_invalid",
        "failureDigest": format!("sha256:{}", "a".repeat(64)),
        "nativeCompletion": {
            "providerKind": "openaiCompatible",
            "terminalSignal": "[DONE]",
            "finishReason": "tool_calls",
        },
        "calls": [{
            "index": 0,
            "callId": "call-safe-identity",
            "toolName": "deepcode_session_plan_propose_v5",
            "originalArgumentsDigest": format!("sha256:{}", "b".repeat(64)),
        }],
    });
    let event = provider_public_structured_error_event(
        "request-structured-error-contract",
        "provider_tool_call_arguments_invalid",
        structured_failure,
    );

    assert!(event.contains("provider_error"));
    assert!(event.contains("request-structured-error-contract"));
    assert!(event.contains("repairableNoMutation"));
    assert!(event.contains("originalArgumentsDigest"));
    assert!(!event.contains("rawArguments"));
    assert!(!event.contains("secret-value"));
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
fn deepseek_tool_continuation_replays_reasoning_content_without_rewriting_it() {
    let reasoning = "private reasoning bytes must remain exact";
    let body = openai_compatible_request_body(
        &test_profile(),
        vec![
            json!({
                "role": "assistant",
                "content": "",
                "reasoningContent": reasoning,
                "toolCalls": [{
                    "id": "call-deepseek-read",
                    "name": "fs.read",
                    "arguments": { "path": "README.md" }
                }]
            }),
            json!({
                "role": "tool",
                "toolCallId": "call-deepseek-read",
                "content": { "ok": true }
            }),
        ],
        &[],
        None,
        true,
    );

    let assistant = &body["messages"][0];
    assert_eq!(assistant["content"].as_str(), Some(""));
    assert_eq!(assistant["reasoning_content"].as_str(), Some(reasoning));
    assert!(assistant.get("reasoningContent").is_none());
    assert_eq!(
        assistant["tool_calls"][0]["function"]["name"].as_str(),
        Some("fs__read")
    );
    assert_eq!(
        body["messages"][1]["tool_call_id"].as_str(),
        Some("call-deepseek-read")
    );
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
fn proposal_control_eof_json_is_normalized_after_native_completion() {
    let original_arguments =
        r#"{"schemaVersion":"deepcode.session.plan-proposal.v5","plan":{"title":"Inspect""#;
    let mut accumulator =
        ProviderNativeStreamAccumulatorV1::new(ProviderNativeStreamKindV1::OpenAiCompatible);
    let payload = serde_json::to_vec(&json!({
        "choices": [{
            "index": 0,
            "delta": {
                "reasoning_content": "The proposal is complete apart from its EOF delimiters.",
                "tool_calls": [{
                    "index": 0,
                    "id": "call-proposal-eof",
                    "function": {
                        "name": "deepcode_session_plan_propose_v5",
                        "arguments": original_arguments,
                    },
                }],
            },
        }],
    }))
    .unwrap();
    accumulator.ingest_payload(&payload).unwrap();
    let terminal = serde_json::to_vec(&json!({
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": "tool_calls",
        }],
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "total_tokens": 120,
        },
    }))
    .unwrap();
    accumulator.ingest_payload(&terminal).unwrap();
    accumulator.ingest_payload(b"[DONE]").unwrap();

    let result = accumulator.finalize().unwrap();
    let recovery = result
        .structured_output_recovery
        .expect("proposal EOF normalization must produce a safe recovery receipt");
    assert_eq!(recovery.disposition, "normalizedProposalControl");
    assert_eq!(recovery.calls.len(), 1);
    assert_eq!(recovery.calls[0].appended_suffix.as_deref(), Some("}}"));
    assert_eq!(
        result.output.tool_calls[0].arguments["plan"]["title"].as_str(),
        Some("Inspect")
    );
    assert_eq!(
        result.output.usage.unwrap()["total_tokens"].as_u64(),
        Some(120)
    );
    assert_eq!(
        result.normalized_tool_arguments.get(&0).map(String::as_str),
        Some(concat!(
            r#"{"schemaVersion":"deepcode.session.plan-proposal.v5","plan":{"title":"Inspect""#,
            "}}"
        ))
    );
}

#[test]
fn invalid_kernel_tool_arguments_fail_with_usage_and_stable_semantic_digest() {
    fn invalid_tool_failure(call_id: &str) -> ProviderNativeStreamErrorV1 {
        let mut accumulator =
            ProviderNativeStreamAccumulatorV1::new(ProviderNativeStreamKindV1::OpenAiCompatible);
        let payload = serde_json::to_vec(&json!({
            "choices": [{
                "index": 0,
                "delta": {
                    "reasoning_content": "The native response reached a complete tool terminal.",
                    "tool_calls": [{
                        "index": 0,
                        "id": call_id,
                        "function": {
                            "name": "fs__read",
                            "arguments": "{\"path\":\"README.md\"",
                        },
                    }],
                },
            }],
        }))
        .unwrap();
        accumulator.ingest_payload(&payload).unwrap();
        let terminal = serde_json::to_vec(&json!({
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": "tool_calls",
            }],
            "usage": {
                "prompt_cache_hit_tokens": 75,
                "prompt_cache_miss_tokens": 25,
                "prompt_tokens": 100,
                "completion_tokens": 16,
                "total_tokens": 116,
            },
        }))
        .unwrap();
        accumulator.ingest_payload(&terminal).unwrap();
        accumulator.ingest_payload(b"[DONE]").unwrap();
        accumulator.finalize().unwrap_err()
    }

    let first = invalid_tool_failure("call-kernel-invalid-1");
    let second = invalid_tool_failure("call-kernel-invalid-2");
    assert_eq!(first.code, "provider_tool_call_arguments_invalid");
    assert_eq!(
        first.usage.as_ref().unwrap()["total_tokens"].as_u64(),
        Some(116)
    );
    let first_failure = first.structured_failure.unwrap();
    let second_failure = second.structured_failure.unwrap();
    assert_eq!(first_failure.disposition, "repairableNoMutation");
    assert_eq!(first_failure.calls[0].normalized_arguments_digest, None);
    assert_eq!(first_failure.calls[0].appended_suffix, None);
    assert_eq!(
        first_failure.failure_digest, second_failure.failure_digest,
        "Provider call identities must not defeat semantic no-progress detection"
    );
    assert_ne!(
        first_failure.calls[0].call_id,
        second_failure.calls[0].call_id
    );
}

#[test]
fn proposal_control_non_eof_json_is_not_locally_rewritten() {
    let mut accumulator =
        ProviderNativeStreamAccumulatorV1::new(ProviderNativeStreamKindV1::OpenAiCompatible);
    let payload = serde_json::to_vec(&json!({
        "choices": [{
            "index": 0,
            "delta": {
                "reasoning_content": "The response contains non-EOF structural corruption.",
                "tool_calls": [{
                    "index": 0,
                    "id": "call-proposal-invalid",
                    "function": {
                        "name": "deepcode_session_plan_propose_v5",
                        "arguments": "{\"plan\":{]}junk",
                    },
                }],
            },
        }],
    }))
    .unwrap();
    accumulator.ingest_payload(&payload).unwrap();
    let terminal = serde_json::to_vec(&json!({
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": "tool_calls",
        }],
    }))
    .unwrap();
    accumulator.ingest_payload(&terminal).unwrap();
    accumulator.ingest_payload(b"[DONE]").unwrap();

    let error = accumulator.finalize().unwrap_err();
    assert_eq!(error.code, "provider_tool_call_arguments_invalid");
    let failure = error.structured_failure.unwrap();
    assert_eq!(failure.disposition, "repairableNoMutation");
    assert_eq!(failure.calls[0].normalized_arguments_digest, None);
    assert_eq!(failure.calls[0].appended_suffix, None);
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
