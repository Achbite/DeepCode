use super::{open_run, plan_intent, tool_intent_response, TempWorkspace};
use crate::executors::{EmptySecretProvider, KernelExecutorConfig};
use crate::v2::{HostRunResumeDispositionV2, KernelSessionServiceV2, SettingsCeilingV2};
use deepcode_kernel_abi::v2::{AuthorizationFactV2, KernelFactPayloadV2};
use deepcode_kernel_abi::v2_command::{CommandHandlingV2, ToolIntentSubmitReplyV2};
use deepcode_kernel_abi::WorkspaceBindingRefV2;
use deepcode_kernel_ledger::v2::FactQueryV2;
use std::sync::Arc;

#[test]
fn sqlite_reopen_rotates_transport_and_replays_pending_intent_without_effect() {
    let temp = TempWorkspace::new("sqlite-recovery");
    let binding_ref =
        WorkspaceBindingRefV2::new("workspace-recovery").expect("valid workspace binding");
    let service = KernelSessionServiceV2::open(
        temp.store_path(),
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    )
    .expect("open file-backed v2 service");
    let opened = open_run(
        &service,
        temp.workspace(),
        binding_ref.clone(),
        "sqlite-recovery",
    );
    let envelope = plan_intent(
        &opened,
        "request-recover-pending",
        "operation-recover-pending",
        "still-pending",
        None,
    );
    let (handling, first_reply) = tool_intent_response(
        service.handle_session_command(envelope.clone(), &opened.run_capability),
    );
    assert_eq!(handling, CommandHandlingV2::Evaluated);
    assert!(matches!(
        &first_reply,
        ToolIntentSubmitReplyV2::AwaitingCapability { .. }
    ));
    let previous_capability = opened.run_capability.expose_to_transport().to_owned();
    drop(service);

    let recovered_service = KernelSessionServiceV2::open(
        temp.store_path(),
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    )
    .expect("reopen the durable v2 service");
    let resumed = recovered_service
        .resume_run_host(
            opened.run_id.clone(),
            binding_ref,
            temp.workspace(),
            SettingsCeilingV2::default(),
        )
        .expect("Host rebinds recovered Run");
    let (run_open_reply, recovered_capability, _, disposition) = resumed.into_parts();
    assert!(matches!(
        disposition,
        HostRunResumeDispositionV2::RotatedRecovered { .. }
    ));
    assert_eq!(
        run_open_reply.tool_context.context_ref(),
        opened.tool_context_ref
    );
    assert_ne!(
        recovered_capability.expose_to_transport(),
        previous_capability
    );

    let (handling, replayed_reply) = tool_intent_response(
        recovered_service.handle_session_command(envelope, &recovered_capability),
    );
    assert_eq!(handling, CommandHandlingV2::Replayed);
    assert_eq!(replayed_reply, first_reply);

    let facts = recovered_service
        .fact_reader()
        .query(&FactQueryV2 {
            run_id: Some(opened.run_id.to_string()),
            operation_id: Some("operation-recover-pending".to_owned()),
            ..FactQueryV2::default()
        })
        .expect("query recovered canonical facts");
    assert_eq!(
        facts
            .iter()
            .filter(|fact| {
                matches!(
                    &fact.payload,
                    KernelFactPayloadV2::Authorization(
                        AuthorizationFactV2::CapabilityAwaiting { .. }
                    )
                )
            })
            .count(),
        1
    );
    assert!(!facts.iter().any(|fact| {
        matches!(
            &fact.payload,
            KernelFactPayloadV2::Invocation(_) | KernelFactPayloadV2::Effect(_)
        )
    }));
    assert!(!temp.workspace().join("still-pending").exists());
}
