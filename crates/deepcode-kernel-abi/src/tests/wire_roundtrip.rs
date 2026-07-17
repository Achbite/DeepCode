use crate::*;

#[test]
fn command_envelope_roundtrips() {
    let envelope = KernelCommandEnvelope {
        request_id: Some("wire-request".to_string()),
        command: KernelCommand::HealthCheck {
            request_id: RequestId("health-request".to_string()),
        },
        idempotency_key: Some("wire-idempotency".to_string()),
        expected_snapshot_seq: Some(17),
    };

    let encoded = serde_json::to_value(&envelope).expect("encode command envelope");
    let decoded: KernelCommandEnvelope =
        serde_json::from_value(encoded).expect("decode command envelope");
    assert_eq!(decoded, envelope);
}

#[test]
fn reply_roundtrips_typed_events() {
    let reply = KernelReply {
        ok: false,
        events: vec![KernelEvent::Error {
            request_id: Some(RequestId("wire-request".to_string())),
            run_id: None,
            session_id: None,
            error: KernelErrorEnvelope {
                code: "wire_failure".to_string(),
                message: "typed wire failure".to_string(),
                message_key: None,
                args: None,
            },
            message_key: None,
            args: None,
        }],
        snapshot: None,
        error: Some(KernelErrorEnvelope {
            code: "wire_failure".to_string(),
            message: "typed wire failure".to_string(),
            message_key: None,
            args: None,
        }),
    };

    let encoded = serde_json::to_value(&reply).expect("encode reply");
    let decoded: KernelReply = serde_json::from_value(encoded).expect("decode reply");
    assert_eq!(decoded, reply);
}
