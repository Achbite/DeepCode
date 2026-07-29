use super::V2Harness;
use crate::v2::PendingCapabilityDecisionClassV2;
use deepcode_kernel_abi::v2::{
    AuthorizationFactV2, CommandRequestId, KernelFactPayloadV2, UserDecisionRefV2,
};
use deepcode_kernel_abi::v2_command::{CommandHandlingV2, ToolIntentSubmitReplyV2};
use deepcode_kernel_abi::{UserDecisionReplyV2, UserDecisionV2};

#[test]
fn awaiting_capability_is_effect_fenced_and_command_replay_is_fact_stable() {
    let harness = V2Harness::new("effect-fence-replay");
    let envelope = harness.plan_intent(
        "request-effect-fence",
        "operation-effect-fence",
        "must-not-exist",
        None,
    );
    let (handling, first_reply) = harness.submit(envelope.clone());
    assert_eq!(handling, CommandHandlingV2::Evaluated);
    let awaiting_invocation = match &first_reply {
        ToolIntentSubmitReplyV2::AwaitingCapability { invocation_id, .. } => invocation_id.clone(),
        other => panic!("unapproved mutation must await capability, got {other:?}"),
    };
    assert!(!harness.temp.workspace().join("must-not-exist").exists());

    let facts = harness.facts_for_operation("operation-effect-fence");
    assert!(facts.iter().any(|fact| {
        matches!(
            &fact.payload,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityAwaiting { .. })
        ) && fact.payload.invocation_id() == Some(&awaiting_invocation)
    }));
    assert!(!facts.iter().any(|fact| {
        matches!(
            &fact.payload,
            KernelFactPayloadV2::Invocation(_) | KernelFactPayloadV2::Effect(_)
        )
    }));

    let high_water = harness
        .service
        .fact_reader()
        .ledger_sequence_high_water()
        .expect("read fact high-water");
    let (handling, replayed_reply) = harness.submit(envelope);
    assert_eq!(handling, CommandHandlingV2::Replayed);
    assert_eq!(replayed_reply, first_reply);
    assert_eq!(
        harness
            .service
            .fact_reader()
            .ledger_sequence_high_water()
            .expect("read replay high-water"),
        high_water
    );
}

#[test]
fn denied_plan_action_records_guidance_without_attempt_or_effect() {
    let harness = V2Harness::new("deny-before-effect");
    let (_, awaiting) =
        harness.submit(harness.plan_intent("request-deny", "operation-deny", "denied", None));
    let preview_id = match awaiting {
        ToolIntentSubmitReplyV2::AwaitingCapability { preview, .. } => preview.preview_id,
        other => panic!("mutation must await a decision, got {other:?}"),
    };
    let pending = harness
        .service
        .resolve_pending_capability_decision_host(
            preview_id,
            UserDecisionRefV2::new("decision-ref-deny").expect("valid decision ref"),
        )
        .expect("resolve pending decision")
        .expect("preview remains current");
    assert_eq!(pending.class, PendingCapabilityDecisionClassV2::Capability);
    let guidance = "Replan without creating this directory.".to_owned();
    let (reply, handling) = harness
        .service
        .apply_host_user_decision(
            CommandRequestId::new("decision-request-deny").expect("valid request id"),
            pending.run_id,
            pending.expected_control_epoch,
            UserDecisionV2::CapabilityDeny {
                binding: pending.binding,
                guidance: guidance.clone(),
            },
        )
        .expect("apply trusted denial");
    assert_eq!(handling, CommandHandlingV2::Evaluated);
    assert!(matches!(
        reply,
        UserDecisionReplyV2::CapabilityDenied { .. }
    ));
    assert!(!harness.temp.workspace().join("denied").exists());

    let facts = harness.facts_for_operation("operation-deny");
    assert!(facts.iter().any(|fact| {
        matches!(
            &fact.payload,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityDenied {
                guidance: recorded,
                ..
            }) if recorded == &guidance
        )
    }));
    assert!(!facts.iter().any(|fact| {
        matches!(
            &fact.payload,
            KernelFactPayloadV2::Invocation(_) | KernelFactPayloadV2::Effect(_)
        )
    }));
}
