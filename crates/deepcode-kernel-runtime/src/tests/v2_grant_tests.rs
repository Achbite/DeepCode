use super::V2Harness;
use deepcode_kernel_abi::v2::{AuthorizationFactV2, KernelFactPayloadV2};
use deepcode_kernel_abi::v2_command::{CommandHandlingV2, ToolIntentSubmitReplyV2};
use deepcode_kernel_abi::{CapabilityLeaseRefV2, UserDecisionReplyV2};

fn issue_initial_lease(harness: &V2Harness, path: &str, label: &str) -> CapabilityLeaseRefV2 {
    let operation_id = format!("operation-await-{label}");
    let (_, awaiting) = harness.submit(harness.plan_intent(
        &format!("request-await-{label}"),
        &operation_id,
        path,
        None,
    ));
    let preview_id = match awaiting {
        ToolIntentSubmitReplyV2::AwaitingCapability { preview, .. } => preview.preview_id,
        other => panic!("mutation without a lease must await capability, got {other:?}"),
    };
    let lease = match harness.allow_preview(preview_id, label) {
        UserDecisionReplyV2::CapabilityIssued { lease, .. } => lease,
        other => panic!("first Allow must issue a capability lease, got {other:?}"),
    };
    harness.wait_for_effect(&operation_id);
    lease
}

#[test]
fn approved_plan_action_reuses_lease_within_exact_scope() {
    let harness = V2Harness::new("lease-reuse");
    let lease = issue_initial_lease(&harness, "approved", "lease-reuse");
    let (handling, reused) =
        harness.submit(harness.plan_intent("request-reuse", "operation-reuse", "approved", None));
    assert_eq!(handling, CommandHandlingV2::Evaluated);
    match reused {
        ToolIntentSubmitReplyV2::Admitted {
            lease: Some(reused_lease),
            ..
        } => assert_eq!(reused_lease, lease),
        other => panic!("in-scope PlanAction reuse must execute without another prompt: {other:?}"),
    }

    let facts = harness.wait_for_effect("operation-reuse");
    assert!(harness.temp.workspace().join("approved").is_dir());
    assert!(facts
        .iter()
        .any(|fact| matches!(&fact.payload, KernelFactPayloadV2::Invocation(_))));
    assert!(facts
        .iter()
        .any(|fact| matches!(&fact.payload, KernelFactPayloadV2::Effect(_))));
}

#[test]
fn scope_expansion_versions_lease_and_continues_pending_invocation() {
    let harness = V2Harness::new("lease-expansion");
    let lease_v1 = issue_initial_lease(&harness, "alpha", "lease-expansion-initial");

    let (_, awaiting) = harness.submit(harness.plan_intent(
        "request-expansion",
        "operation-expansion",
        "beta",
        Some(lease_v1.clone()),
    ));
    let (preview_id, pending_invocation_id) = match awaiting {
        ToolIntentSubmitReplyV2::AwaitingCapability {
            invocation_id,
            preview,
            ..
        } => {
            assert!(
                !preview.approval_view.scope_delta.is_empty(),
                "expansion preview must expose the exact added scope"
            );
            (preview.preview_id, invocation_id)
        }
        other => panic!("out-of-scope target must await expansion, got {other:?}"),
    };

    let lease_v2 = match harness.allow_preview(preview_id, "lease-expansion-allow") {
        UserDecisionReplyV2::ScopeExpansionRecorded { lease, .. } => lease,
        other => panic!("expansion Allow must version the existing lease, got {other:?}"),
    };
    assert_eq!(lease_v2.lease_id, lease_v1.lease_id);
    assert_eq!(lease_v2.version.get(), lease_v1.version.get() + 1);
    assert_ne!(lease_v2.scope_digest, lease_v1.scope_digest);

    let facts = harness.wait_for_effect("operation-expansion");
    assert!(harness.temp.workspace().join("beta").is_dir());
    assert!(facts.iter().any(|fact| {
        matches!(
            &fact.payload,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityAwaiting { .. })
        )
    }));
    assert!(facts.iter().any(|fact| {
        matches!(
            &fact.payload,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::ExpansionAllowed { .. })
        )
    }));
    assert!(facts.iter().any(|fact| {
        fact.payload.invocation_id() == Some(&pending_invocation_id)
            && matches!(&fact.payload, KernelFactPayloadV2::Invocation(_))
    }));
    assert!(facts
        .iter()
        .any(|fact| matches!(&fact.payload, KernelFactPayloadV2::Effect(_))));
}
