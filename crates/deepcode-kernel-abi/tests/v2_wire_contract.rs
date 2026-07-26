use deepcode_kernel_abi::v2::{
    decode_kernel_fact_v2, AttemptId, CausalIdentityV2, ControlEpoch, CorrelationRefV2,
    EffectFactV2, EffectId, EffectOutcomeV2, FactId, GrantFactKindV2, GrantFactV2, GrantId,
    GrantReservationId, GrantUsePolicyV2, InvocationFactKindV2, InvocationFactV2, InvocationId,
    KernelErrorCodeV2, KernelFactDraftV2, KernelFactPayloadV2, OperationId, RunId,
    V2ValidationError, V2WireDecodeError,
};
use deepcode_kernel_abi::v2_command::{
    decode_kernel_command_v2, GrantDecisionV2, KernelCommandEnvelopeV2, KernelCommandV2,
    ResourceTargetV2,
};
use deepcode_kernel_abi::KERNEL_ABI_V2_VERSION;

fn effect_draft() -> KernelFactDraftV2 {
    let invocation_id = InvocationId::from("invocation-1");
    let attempt_id = AttemptId::from("attempt-1");
    KernelFactDraftV2::new(
        FactId::from("fact-1"),
        "2026-07-26T04:00:00Z",
        CausalIdentityV2 {
            run_id: RunId::from("run-1"),
            control_epoch: ControlEpoch::new(1).expect("non-zero epoch"),
            operation_id: Some(OperationId::from("operation-1")),
            capability_grant_id: Some(GrantId::from("grant-1")),
            grant_reservation_id: Some(GrantReservationId::from("reservation-1")),
            invocation_id: Some(invocation_id.clone()),
            attempt_id: Some(attempt_id.clone()),
            causation_id: Some(FactId::from("fact-0")),
            correlation_refs: vec![CorrelationRefV2 {
                kind: "planActionId".to_owned(),
                value: "opaque-plan-action-1".to_owned(),
            }],
            idempotency_key_hash: Some("sha256:idempotency-1".to_owned()),
        },
        KernelFactPayloadV2::Effect(EffectFactV2 {
            effect_id: EffectId::from("effect-1"),
            invocation_id,
            attempt_id,
            outcome: EffectOutcomeV2::Observed,
            affected_resources: Vec::new(),
            receipt: Some(serde_json::json!({"digest": "sha256:effect-1"})),
        }),
    )
}

#[test]
fn v2_wire_vectors_round_trip_with_complete_causal_identity() {
    let envelope = effect_draft()
        .with_sequences(41, 7)
        .expect("valid sequenced fact");
    let encoded = serde_json::to_vec(&envelope).expect("serialize v2 fact");
    let encoded_value: serde_json::Value =
        serde_json::from_slice(&encoded).expect("inspect serialized v2 fact");

    assert_eq!(encoded_value["abiVersion"], KERNEL_ABI_V2_VERSION);
    assert_eq!(encoded_value["ledgerSequence"], 41);
    assert_eq!(encoded_value["runSequence"], 7);
    assert_eq!(encoded_value["occurredAt"], "2026-07-26T04:00:00Z");
    assert_eq!(encoded_value["identity"]["runId"], "run-1");
    assert_eq!(encoded_value["identity"]["capabilityGrantId"], "grant-1");
    assert_eq!(
        encoded_value["identity"]["grantReservationId"],
        "reservation-1"
    );
    assert_eq!(encoded_value["payload"]["domain"], "effect");
    assert_eq!(encoded_value["payload"]["fact"]["effectId"], "effect-1");

    let decoded = decode_kernel_fact_v2(&encoded).expect("decode and validate v2 fact");
    assert_eq!(decoded, envelope);
}

#[test]
fn v2_wire_rejects_missing_required_causal_identity() {
    let mut encoded = serde_json::to_value(
        effect_draft()
            .with_sequences(1, 1)
            .expect("valid sequenced fact"),
    )
    .expect("serialize v2 fact");
    encoded["identity"]
        .as_object_mut()
        .expect("identity object")
        .remove("operationId");

    let error =
        decode_kernel_fact_v2(&serde_json::to_vec(&encoded).expect("serialize incomplete vector"))
            .expect_err("effect must retain operation identity");
    assert_eq!(
        error,
        V2WireDecodeError::Validation(V2ValidationError::MissingCausalIdentity {
            field: "identity.operationId",
            required_by: "effect fact",
        })
    );
}

#[test]
fn v2_wire_rejects_unknown_kind_and_version_mismatch() {
    let mut unknown = serde_json::to_value(
        effect_draft()
            .with_sequences(1, 1)
            .expect("valid sequenced fact"),
    )
    .expect("serialize v2 fact");
    unknown["payload"]["domain"] = serde_json::Value::String("narrative".to_owned());
    let unknown_error = decode_kernel_fact_v2(
        &serde_json::to_vec(&unknown).expect("serialize unknown-domain vector"),
    )
    .expect_err("unknown fact domain must fail");
    assert!(matches!(
        unknown_error,
        V2WireDecodeError::InvalidPayload { .. }
    ));

    let v1_shape = br#"{"abiVersion":"deepcode.kernel.abi.v1","legacy":true}"#;
    let version_error = decode_kernel_fact_v2(v1_shape).expect_err("v1 must fail before v2 decode");
    assert_eq!(
        version_error.code(),
        KernelErrorCodeV2::UnsupportedAbiVersion
    );
    assert_eq!(
        version_error,
        V2WireDecodeError::UnsupportedAbiVersion {
            actual: "deepcode.kernel.abi.v1".to_owned(),
            expected: KERNEL_ABI_V2_VERSION,
        }
    );
}

#[test]
fn v2_wire_rejects_unknown_fields_empty_ids_and_zero_epoch() {
    let mut unknown_field = serde_json::to_value(
        effect_draft()
            .with_sequences(1, 1)
            .expect("valid sequenced fact"),
    )
    .expect("serialize v2 fact");
    unknown_field["identity"]["sessionId"] = serde_json::json!("legacy-session");
    assert!(matches!(
        decode_kernel_fact_v2(
            &serde_json::to_vec(&unknown_field).expect("serialize unknown-field vector")
        ),
        Err(V2WireDecodeError::InvalidPayload { .. })
    ));

    let mut empty_id = serde_json::to_value(
        effect_draft()
            .with_sequences(1, 1)
            .expect("valid sequenced fact"),
    )
    .expect("serialize v2 fact");
    empty_id["identity"]["runId"] = serde_json::json!(" ");
    assert!(matches!(
        decode_kernel_fact_v2(&serde_json::to_vec(&empty_id).expect("serialize empty-id vector")),
        Err(V2WireDecodeError::InvalidPayload { .. })
    ));

    let mut zero_epoch = serde_json::to_value(
        effect_draft()
            .with_sequences(1, 1)
            .expect("valid sequenced fact"),
    )
    .expect("serialize v2 fact");
    zero_epoch["identity"]["controlEpoch"] = serde_json::json!(0);
    assert!(matches!(
        decode_kernel_fact_v2(
            &serde_json::to_vec(&zero_epoch).expect("serialize zero-epoch vector")
        ),
        Err(V2WireDecodeError::InvalidPayload { .. })
    ));
}

#[test]
fn v2_admitted_invocation_requires_a_grant_reservation() {
    let invocation_id = InvocationId::from("invocation-without-reservation");
    let draft = KernelFactDraftV2::new(
        FactId::from("fact-admitted"),
        "2026-07-26T04:00:00Z",
        CausalIdentityV2 {
            run_id: RunId::from("run-1"),
            control_epoch: ControlEpoch::new(1).expect("non-zero epoch"),
            operation_id: Some(OperationId::from("operation-1")),
            capability_grant_id: None,
            grant_reservation_id: None,
            invocation_id: Some(invocation_id.clone()),
            attempt_id: None,
            causation_id: None,
            correlation_refs: Vec::new(),
            idempotency_key_hash: Some("sha256:idempotency-1".to_owned()),
        },
        KernelFactPayloadV2::Invocation(InvocationFactV2 {
            kind: InvocationFactKindV2::Admitted,
            invocation_id,
            tool_id: "fs.read".to_owned(),
            request_digest: "sha256:request-1".to_owned(),
            idempotency_key_hash: "sha256:idempotency-1".to_owned(),
            attempt_id: None,
            error_code: None,
            retryable: None,
        }),
    );

    assert_eq!(
        draft.validate(),
        Err(V2ValidationError::MissingCausalIdentity {
            field: "identity.capabilityGrantId",
            required_by: "admitted or later invocation fact",
        })
    );
}

#[test]
fn v2_wire_rejects_duplicate_keys_and_bounded_identity_overflow() {
    let encoded = serde_json::to_string(
        &effect_draft()
            .with_sequences(1, 1)
            .expect("valid sequenced fact"),
    )
    .expect("serialize v2 fact");
    let duplicate = encoded.replacen(
        "\"runId\":\"run-1\"",
        "\"runId\":\"run-1\",\"runId\":\"run-shadow\"",
        1,
    );
    let duplicate_error =
        decode_kernel_fact_v2(duplicate.as_bytes()).expect_err("duplicate keys must fail");
    assert!(matches!(
        duplicate_error,
        V2WireDecodeError::InvalidJson { .. }
    ));
    assert!(duplicate_error
        .to_string()
        .contains("duplicate JSON object key"));

    let mut oversized_id = serde_json::to_value(
        effect_draft()
            .with_sequences(1, 1)
            .expect("valid sequenced fact"),
    )
    .expect("serialize v2 fact");
    oversized_id["identity"]["runId"] = serde_json::json!("x".repeat(513));
    assert!(matches!(
        decode_kernel_fact_v2(
            &serde_json::to_vec(&oversized_id).expect("serialize oversized identity vector")
        ),
        Err(V2WireDecodeError::InvalidPayload { .. })
    ));

    let mut internal_draft = effect_draft();
    internal_draft.identity.operation_id = Some(OperationId::new("x".repeat(513)));
    assert_eq!(
        internal_draft.validate(),
        Err(V2ValidationError::FieldTooLarge {
            field: "identity.operationId",
            maximum_bytes: 512,
        })
    );
}

#[test]
fn v2_invocation_command_round_trips_without_caller_asserted_authority() {
    let envelope = KernelCommandEnvelopeV2::new(
        "request-1",
        KernelCommandV2::InvocationSubmit {
            run_id: RunId::from("run-1"),
            operation_id: OperationId::from("operation-1"),
            control_epoch: ControlEpoch::new(3).expect("non-zero epoch"),
            grant_id: GrantId::from("grant-1"),
            tool_id: "fs.read".to_owned(),
            args: serde_json::json!({"path": "README.md"}),
            target_refs: vec![ResourceTargetV2 {
                resource_kind: "workspaceFile".to_owned(),
                target: "README.md".to_owned(),
                expected_digest: None,
            }],
            idempotency_key: "session-owned-idempotency-key".to_owned(),
            requested_deadline_ms: Some(10_000),
            correlation_refs: vec![CorrelationRefV2 {
                kind: "planActionId".to_owned(),
                value: "opaque-action-1".to_owned(),
            }],
        },
    );
    let encoded = serde_json::to_vec(&envelope).expect("serialize v2 invocation command");
    let value: serde_json::Value =
        serde_json::from_slice(&encoded).expect("inspect v2 invocation command");

    assert_eq!(value["abiVersion"], KERNEL_ABI_V2_VERSION);
    assert_eq!(value["requestId"], "request-1");
    assert_eq!(value["command"]["kind"], "invocationSubmit");
    assert_eq!(value["command"]["operationId"], "operation-1");
    assert_eq!(
        value["command"]["idempotencyKey"],
        "session-owned-idempotency-key"
    );
    for forbidden in ["risk", "resourceScope", "effectScope", "requestDigest"] {
        assert!(
            value["command"].get(forbidden).is_none(),
            "caller must not assert {forbidden}"
        );
    }

    assert_eq!(
        decode_kernel_command_v2(&encoded).expect("decode strict v2 command"),
        envelope
    );
}

#[test]
fn v2_command_decoder_rejects_legacy_duplicate_and_authority_fields() {
    let legacy = br#"{"abiVersion":"deepcode.kernel.abi.v1","command":{"kind":"healthCheck"}}"#;
    assert_eq!(
        decode_kernel_command_v2(legacy)
            .expect_err("legacy command must fail before typed decoding")
            .code(),
        KernelErrorCodeV2::UnsupportedAbiVersion
    );

    let decision = KernelCommandEnvelopeV2::new(
        "decision-1",
        KernelCommandV2::GrantDecisionSubmit {
            run_id: RunId::from("run-1"),
            operation_id: OperationId::from("operation-1"),
            control_epoch: ControlEpoch::new(3).expect("non-zero epoch"),
            request_digest: "sha256:preview-request".to_owned(),
            decision: GrantDecisionV2::Allow,
            reason: None,
        },
    );
    let mut injected = serde_json::to_value(&decision).expect("serialize decision");
    injected["command"]["grantId"] = serde_json::json!("host-minted-grant");
    assert!(matches!(
        decode_kernel_command_v2(
            &serde_json::to_vec(&injected).expect("serialize injected decision")
        ),
        Err(V2WireDecodeError::InvalidPayload { .. })
    ));

    let encoded = serde_json::to_string(&decision).expect("serialize decision");
    let duplicate = encoded.replacen(
        "\"runId\":\"run-1\"",
        "\"runId\":\"run-1\",\"runId\":\"run-shadow\"",
        1,
    );
    assert!(matches!(
        decode_kernel_command_v2(duplicate.as_bytes()),
        Err(V2WireDecodeError::InvalidJson { .. })
    ));
}

#[test]
fn v2_grant_fact_persists_the_typed_request_digest() {
    let grant_id = GrantId::from("grant-digest-1");
    let draft = KernelFactDraftV2::new(
        FactId::from("fact-grant-digest-1"),
        "2026-07-26T04:00:00Z",
        CausalIdentityV2 {
            run_id: RunId::from("run-1"),
            control_epoch: ControlEpoch::new(1).expect("non-zero epoch"),
            operation_id: Some(OperationId::from("grant-decision-1")),
            capability_grant_id: Some(grant_id.clone()),
            grant_reservation_id: None,
            invocation_id: None,
            attempt_id: None,
            causation_id: None,
            correlation_refs: Vec::new(),
            idempotency_key_hash: None,
        },
        KernelFactPayloadV2::Grant(GrantFactV2 {
            kind: GrantFactKindV2::Issued,
            grant_id,
            tool_id: "fs.write".to_owned(),
            request_digest: "sha256:kernel-derived-preview".to_owned(),
            resource_scope: vec!["workspace:/result.txt".to_owned()],
            effect_scope: vec!["filesystem.write".to_owned()],
            use_policy: GrantUsePolicyV2::UnboundedWithinEpoch,
            observed_use_count: 0,
            reason: None,
        }),
    );
    let encoded = serde_json::to_value(
        draft
            .with_sequences(1, 1)
            .expect("typed grant fact must validate"),
    )
    .expect("serialize grant fact");
    assert_eq!(
        encoded["payload"]["fact"]["requestDigest"],
        "sha256:kernel-derived-preview"
    );

    let mut missing = encoded;
    missing["payload"]["fact"]
        .as_object_mut()
        .expect("grant fact object")
        .remove("requestDigest");
    assert!(matches!(
        decode_kernel_fact_v2(
            &serde_json::to_vec(&missing).expect("serialize incomplete grant fact")
        ),
        Err(V2WireDecodeError::InvalidPayload { .. })
    ));
}

#[test]
fn v2_failed_before_attempt_keeps_authority_identity_and_has_no_attempt() {
    let invocation_id = InvocationId::from("invocation-pre-effect-failure");
    let draft = KernelFactDraftV2::new(
        FactId::from("fact-pre-effect-failure"),
        "2026-07-26T04:00:00Z",
        CausalIdentityV2 {
            run_id: RunId::from("run-1"),
            control_epoch: ControlEpoch::new(1).expect("non-zero epoch"),
            operation_id: Some(OperationId::from("operation-1")),
            capability_grant_id: Some(GrantId::from("grant-1")),
            grant_reservation_id: Some(GrantReservationId::from("reservation-1")),
            invocation_id: Some(invocation_id.clone()),
            attempt_id: None,
            causation_id: Some(FactId::from("fact-reservation-release")),
            correlation_refs: Vec::new(),
            idempotency_key_hash: Some("sha256:idempotency-1".to_owned()),
        },
        KernelFactPayloadV2::Invocation(InvocationFactV2 {
            kind: InvocationFactKindV2::FailedBeforeAttempt,
            invocation_id,
            tool_id: "fs.write".to_owned(),
            request_digest: "sha256:request-1".to_owned(),
            idempotency_key_hash: "sha256:idempotency-1".to_owned(),
            attempt_id: None,
            error_code: Some("AuthoritySuperseded".to_owned()),
            retryable: Some(false),
        }),
    );
    draft
        .validate()
        .expect("pre-effect terminal fact retains admitted authority identity");

    let mut missing_cause = draft;
    missing_cause.identity.causation_id = None;
    assert_eq!(
        missing_cause.validate(),
        Err(V2ValidationError::MissingCausalIdentity {
            field: "identity.causationId",
            required_by: "admission or later invocation fact",
        })
    );
}
