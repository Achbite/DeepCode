use deepcode_kernel_abi::v2::{
    decode_fact_v2, CommandRequestId, ControlEpoch, ControlFactV2, FactId, InputId,
    KernelFactEnvelopeV2, KernelFactPayloadV2, OperationId, RecordedAtV2, RunId,
    TransitionIdentityV2, V2ValidationError, V2WireDecodeError,
};
use deepcode_kernel_abi::v2_command::{
    decode_kernel_command_v2, DeadlineRequestV2, KernelCommandEnvelopeV2, KernelCommandV2,
    ToolIntentSubmitV2,
};
use deepcode_kernel_abi::{
    DecisionCapabilityV2, PlanActionIdV2, PlanRevisionV2, RawToolArgumentsV2, RunCapabilityV2,
    ToolCatalogDigestV2, ToolContextDigestV2, ToolContextRefV2, ToolContextVersionV2, ToolIdV2,
    ToolIntentAuthorityV2, KERNEL_ABI_V2_VERSION,
};

fn fact_id(value: &str) -> FactId {
    FactId::new(value).expect("valid fact id")
}

fn run_id(value: &str) -> RunId {
    RunId::new(value).expect("valid run id")
}

fn operation_id(value: &str) -> OperationId {
    OperationId::new(value).expect("valid operation id")
}

fn epoch_advanced_fact() -> KernelFactEnvelopeV2 {
    KernelFactEnvelopeV2 {
        abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
        fact_id: fact_id("fact-epoch-2"),
        ledger_sequence: 41,
        run_sequence: 7,
        recorded_at: RecordedAtV2::new("2026-07-29T00:00:00.000Z").expect("valid recorded time"),
        payload: KernelFactPayloadV2::Control(ControlFactV2::EpochAdvanced {
            identity: TransitionIdentityV2 {
                run_id: run_id("run-1"),
                control_epoch: ControlEpoch::new(2).expect("non-zero epoch"),
                causation_fact_id: fact_id("fact-input-recorded"),
            },
            input_id: InputId::new("input-2").expect("valid input id"),
            previous_epoch: Some(ControlEpoch::new(1).expect("previous epoch")),
            opaque_input_ref: "session-input:2".to_owned(),
        }),
    }
}

fn tool_context_ref() -> ToolContextRefV2 {
    ToolContextRefV2 {
        context_version: ToolContextVersionV2::new(1).expect("context version"),
        catalog_digest: ToolCatalogDigestV2::parse(format!("sha256:{}", "1".repeat(64)))
            .expect("catalog digest"),
        context_digest: ToolContextDigestV2::parse(format!("sha256:{}", "2".repeat(64)))
            .expect("context digest"),
    }
}

fn tool_intent_envelope() -> KernelCommandEnvelopeV2 {
    KernelCommandEnvelopeV2::new(
        CommandRequestId::new("request-1").expect("request id"),
        KernelCommandV2::ToolIntentSubmit(ToolIntentSubmitV2 {
            run_id: run_id("run-1"),
            expected_control_epoch: ControlEpoch::new(3).expect("non-zero epoch"),
            operation_id: operation_id("operation-1"),
            idempotency_key: "session-owned-idempotency-key".to_owned(),
            tool_id: ToolIdV2::parse("fs.read").expect("namespaced tool id"),
            raw_arguments: RawToolArgumentsV2::new(serde_json::json!({
                "path": "README.md"
            }))
            .expect("object arguments"),
            authority: ToolIntentAuthorityV2::PlanAction {
                plan_revision: PlanRevisionV2::new("plan-revision-1").expect("plan revision"),
                plan_action_id: PlanActionIdV2::new("plan-action-1").expect("plan action"),
                lease: None,
            },
            deadline: DeadlineRequestV2::ExactMilliseconds { value: 10_000 },
            tool_context_ref: tool_context_ref(),
        }),
    )
}

#[test]
fn v2_fact_wire_round_trips_with_control_identity() {
    let envelope = epoch_advanced_fact();
    envelope.validate().expect("valid v2 fact");
    let encoded = serde_json::to_vec(&envelope).expect("serialize v2 fact");
    let value: serde_json::Value =
        serde_json::from_slice(&encoded).expect("inspect serialized v2 fact");

    assert_eq!(value["abiVersion"], KERNEL_ABI_V2_VERSION);
    assert_eq!(value["ledgerSequence"], 41);
    assert_eq!(value["runSequence"], 7);
    assert_eq!(value["payload"]["domain"], "control");
    assert_eq!(value["payload"]["fact"]["kind"], "epochAdvanced");
    assert_eq!(
        value["payload"]["fact"]["data"]["identity"]["runId"],
        "run-1"
    );
    assert_eq!(
        decode_fact_v2(&encoded).expect("decode strict v2 fact"),
        envelope
    );
}

#[test]
fn v2_fact_decoder_rejects_missing_unknown_and_invalid_identity_fields() {
    let mut missing = serde_json::to_value(epoch_advanced_fact()).expect("serialize v2 fact");
    missing["payload"]["fact"]["data"]["identity"]
        .as_object_mut()
        .expect("identity object")
        .remove("causationFactId");
    assert!(matches!(
        decode_fact_v2(&serde_json::to_vec(&missing).expect("serialize missing identity")),
        Err(V2WireDecodeError::InvalidPayload(_))
    ));

    let mut unknown = serde_json::to_value(epoch_advanced_fact()).expect("serialize v2 fact");
    unknown["payload"]["fact"]["data"]["identity"]["sessionId"] =
        serde_json::json!("legacy-session");
    assert!(matches!(
        decode_fact_v2(&serde_json::to_vec(&unknown).expect("serialize unknown identity")),
        Err(V2WireDecodeError::InvalidPayload(_))
    ));

    let mut empty = serde_json::to_value(epoch_advanced_fact()).expect("serialize v2 fact");
    empty["payload"]["fact"]["data"]["identity"]["runId"] = serde_json::json!(" ");
    assert!(matches!(
        decode_fact_v2(&serde_json::to_vec(&empty).expect("serialize empty identity")),
        Err(V2WireDecodeError::InvalidPayload(_))
    ));

    let mut zero_sequence = serde_json::to_value(epoch_advanced_fact()).expect("serialize v2 fact");
    zero_sequence["ledgerSequence"] = serde_json::json!(0);
    assert_eq!(
        decode_fact_v2(&serde_json::to_vec(&zero_sequence).expect("serialize zero sequence")),
        Err(V2WireDecodeError::Validation(
            V2ValidationError::ZeroValue {
                field: "ledgerSequence"
            }
        ))
    );
}

#[test]
fn v2_fact_decoder_rejects_unknown_domain_and_v1_version() {
    let mut unknown = serde_json::to_value(epoch_advanced_fact()).expect("serialize v2 fact");
    unknown["payload"]["domain"] = serde_json::json!("narrative");
    assert!(matches!(
        decode_fact_v2(&serde_json::to_vec(&unknown).expect("serialize unknown domain")),
        Err(V2WireDecodeError::InvalidPayload(_))
    ));

    let legacy = br#"{"abiVersion":"deepcode.kernel.abi.v1","legacy":true}"#;
    assert_eq!(
        decode_fact_v2(legacy),
        Err(V2WireDecodeError::UnsupportedAbiVersion {
            received: "deepcode.kernel.abi.v1".to_owned()
        })
    );
}

#[test]
fn v2_fact_decoder_rejects_duplicate_keys_and_oversized_ids() {
    let encoded = serde_json::to_string(&epoch_advanced_fact()).expect("serialize v2 fact");
    let duplicate = encoded.replacen(
        "\"runId\":\"run-1\"",
        "\"runId\":\"run-1\",\"runId\":\"run-shadow\"",
        1,
    );
    assert_eq!(
        decode_fact_v2(duplicate.as_bytes()),
        Err(V2WireDecodeError::DuplicateKey)
    );
    assert!(matches!(
        RunId::new("x".repeat(513)),
        Err(V2ValidationError::FieldTooLarge {
            maximum_bytes: 512,
            ..
        })
    ));
}

#[test]
fn v2_tool_intent_round_trips_without_caller_asserted_scope() {
    let envelope = tool_intent_envelope();
    let encoded = serde_json::to_vec(&envelope).expect("serialize v2 tool intent");
    let value: serde_json::Value =
        serde_json::from_slice(&encoded).expect("inspect v2 tool intent");

    assert_eq!(value["abiVersion"], KERNEL_ABI_V2_VERSION);
    assert_eq!(value["requestId"], "request-1");
    assert_eq!(value["command"]["kind"], "toolIntentSubmit");
    assert_eq!(value["command"]["data"]["operationId"], "operation-1");
    assert_eq!(
        value["command"]["data"]["idempotencyKey"],
        "session-owned-idempotency-key"
    );
    for forbidden in ["risk", "resourceScope", "effectScope", "requestDigest"] {
        assert!(
            value["command"]["data"].get(forbidden).is_none(),
            "caller must not assert {forbidden}"
        );
    }
    assert_eq!(
        decode_kernel_command_v2(&encoded).expect("decode strict v2 command"),
        envelope
    );
}

#[test]
fn v2_command_decoder_rejects_v1_duplicate_and_unknown_authority_fields() {
    let legacy = br#"{
        "abiVersion":"deepcode.kernel.abi.v1",
        "requestId":"legacy-request",
        "command":{"kind":"healthCheck"}
    }"#;
    assert_eq!(
        decode_kernel_command_v2(legacy),
        Err(V2WireDecodeError::UnsupportedAbiVersion {
            received: "deepcode.kernel.abi.v1".to_owned()
        })
    );

    let command = tool_intent_envelope();
    let mut injected = serde_json::to_value(&command).expect("serialize tool intent");
    injected["command"]["data"]["grantId"] = serde_json::json!("caller-asserted-grant");
    assert!(matches!(
        decode_kernel_command_v2(
            &serde_json::to_vec(&injected).expect("serialize injected tool intent")
        ),
        Err(V2WireDecodeError::InvalidPayload(_))
    ));

    let encoded = serde_json::to_string(&command).expect("serialize tool intent");
    let duplicate = encoded.replacen(
        "\"runId\":\"run-1\"",
        "\"runId\":\"run-1\",\"runId\":\"run-shadow\"",
        1,
    );
    assert_eq!(
        decode_kernel_command_v2(duplicate.as_bytes()),
        Err(V2WireDecodeError::DuplicateKey)
    );
}

#[test]
fn v2_transport_capabilities_validate_and_redact() {
    let run_secret = "run-capability-secret-0001";
    let decision_secret = "decision-capability-secret-0001";
    let run_capability = RunCapabilityV2::new(run_secret).expect("valid run capability");
    let decision_capability =
        DecisionCapabilityV2::new(decision_secret).expect("valid decision capability");

    assert_eq!(format!("{run_capability:?}"), "RunCapabilityV2([REDACTED])");
    assert_eq!(
        format!("{decision_capability:?}"),
        "DecisionCapabilityV2([REDACTED])"
    );
    assert!(!format!("{run_capability:?}").contains(run_secret));
    assert!(!format!("{decision_capability:?}").contains(decision_secret));
    assert!(RunCapabilityV2::new("short").is_err());
    assert!(DecisionCapabilityV2::new("contains whitespace").is_err());
}
