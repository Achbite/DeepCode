use deepcode_kernel_abi::{HostStatus, KernelCommand, KernelEvent, RequestId};

#[test]
fn crate_root_exports_command_and_event_round_trip() {
    let command = KernelCommand::HealthCheck {
        request_id: RequestId("req-root".to_string()),
    };
    let encoded = serde_json::to_value(&command).expect("serialize command");
    assert_eq!(encoded["kind"], "healthCheck");
    let decoded: KernelCommand = serde_json::from_value(encoded).expect("deserialize command");
    assert_eq!(decoded, command);

    let event = KernelEvent::HostStatus {
        request_id: Some(RequestId("req-root".to_string())),
        status: HostStatus::Ready,
        detail: Some("ready".to_string()),
        message_key: None,
        args: None,
    };
    let encoded = serde_json::to_value(&event).expect("serialize event");
    assert_eq!(encoded["kind"], "host.status");
    let decoded: KernelEvent = serde_json::from_value(encoded).expect("deserialize event");
    assert_eq!(decoded, event);
}
