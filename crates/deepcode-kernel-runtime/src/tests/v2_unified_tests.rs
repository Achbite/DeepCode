use super::{open_run, plan_intent, preview_plan_action, tool_intent_response, TempWorkspace};
use crate::executors::{EmptySecretProvider, KernelExecutorConfig};
use crate::v2::{HostRunResumeDispositionV2, KernelSessionServiceV2, SettingsCeilingV2};
use deepcode_kernel_abi::v2::{
    AuthorizationFactV2, CommandRequestId, ControlFactV2, InputId, KernelFactPayloadV2,
    MutationCommandResultV2, OperationId, ResourceAccessV2, UserDecisionRefV2,
};
use deepcode_kernel_abi::v2_command::{
    CapabilityScopePreviewBatchV2, CapabilityScopePreviewItemV2, CapabilityScopePreviewOriginV3,
    CapabilityScopePreviewRecordV2, CapabilityScopePreviewReplyV2, CommandHandlingV2,
    DeadlineRequestV2, KernelCommandEnvelopeV2, KernelCommandResponseEnvelopeV2, KernelCommandV2,
    KernelErrorV2, KernelReplyV2, StorageFaultCodeV2, ToolIntentRejectionReasonV2,
    ToolIntentSubmitReplyV2,
};
use deepcode_kernel_abi::{
    InterventionSelectDecisionV3, PlanActionIdV2, PlanRevisionV2, RequestedResourceV2,
    ScopeIntentV2, ToolIdV2, UserDecisionReplyV2, UserDecisionV2, WorkspaceBindingRefV2,
};
use deepcode_kernel_ledger::v2::FactQueryV2;
use std::sync::Arc;

const INTERVENTION_ID: &str = "intervention-runtime-1";
const INTERVENTION_REVISION: &str = "intervention-revision-runtime-1";
const INTERVENTION_CANDIDATE_SET_DIGEST: &str =
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn preview_intervention_candidate(
    harness: &super::V2Harness,
    request_id: &str,
    plan_revision: &str,
    plan_action_id: &str,
    operation_id: &str,
    option_id: &str,
    path: &str,
) -> CapabilityScopePreviewRecordV2 {
    let envelope = KernelCommandEnvelopeV2::new(
        CommandRequestId::new(request_id).expect("valid candidate preview request"),
        KernelCommandV2::CapabilityScopePreviewBatch(CapabilityScopePreviewBatchV2 {
            run_id: harness.opened.run_id.clone(),
            expected_control_epoch: harness.opened.control_epoch,
            plan_revision: PlanRevisionV2::new(plan_revision).expect("valid candidate revision"),
            items: vec![CapabilityScopePreviewItemV2 {
                plan_action_id: PlanActionIdV2::new(plan_action_id)
                    .expect("valid candidate PlanAction"),
                operation_id: OperationId::new(operation_id).expect("valid candidate operation"),
                idempotency_key: format!("idempotency-{operation_id}"),
                tool_id: ToolIdV2::parse("fs.ensure_directory")
                    .expect("registered mutation ToolId"),
                scope_intent: Some(ScopeIntentV2::ResourceScope {
                    requested_resources: vec![RequestedResourceV2::WorkspacePath {
                        path: path.to_owned(),
                        access: ResourceAccessV2::Write,
                    }],
                }),
                raw_arguments: None,
                deadline: DeadlineRequestV2::ContractDefault {},
                origin: CapabilityScopePreviewOriginV3::InterventionCandidate {
                    interaction_id: INTERVENTION_ID.to_owned(),
                    interaction_revision: INTERVENTION_REVISION.to_owned(),
                    candidate_set_digest: INTERVENTION_CANDIDATE_SET_DIGEST.to_owned(),
                    option_id: option_id.to_owned(),
                },
            }],
            tool_context_ref: harness.opened.tool_context_ref.clone(),
        }),
    );
    match harness
        .service
        .handle_session_command(envelope, &harness.opened.run_capability)
    {
        KernelCommandResponseEnvelopeV2::Correlated {
            handling: CommandHandlingV2::Evaluated,
            reply: KernelReplyV2::CapabilityScopePreviewBatchResult(result),
            ..
        } => match result.results.as_slice() {
            [CapabilityScopePreviewReplyV2::Previewed { preview }] => preview.clone(),
            other => panic!("expected one intervention candidate preview, got {other:?}"),
        },
        other => panic!("expected evaluated intervention candidate preview, got {other:?}"),
    }
}

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
    preview_plan_action(
        &service,
        &opened,
        "request-preview-recover-pending",
        "operation-recover-pending",
        "still-pending",
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
    let (awaiting_invocation_id, awaiting_preview_id, awaiting_fact_id, awaiting_high_water) =
        match &first_reply {
            ToolIntentSubmitReplyV2::AwaitingCapability {
                invocation_id,
                preview,
                awaiting_fact_id,
                awaiting_batch_high_water,
                ..
            } => (
                invocation_id.clone(),
                preview.preview_id.clone(),
                awaiting_fact_id.clone(),
                *awaiting_batch_high_water,
            ),
            other => panic!("expected AwaitingCapability, got {other:?}"),
        };
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
    let awaiting_facts = facts
        .iter()
        .filter(|fact| {
            matches!(
                &fact.payload,
                KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityAwaiting { .. })
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(awaiting_facts.len(), 1);
    assert_eq!(awaiting_facts[0].fact_id, awaiting_fact_id);
    assert_eq!(awaiting_facts[0].ledger_sequence, awaiting_high_water);
    assert!(matches!(
        &awaiting_facts[0].payload,
        KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityAwaiting {
            identity,
            preview_id,
            ..
        }) if identity.invocation_id == awaiting_invocation_id
            && preview_id == &awaiting_preview_id
    ));
    let command_facts = facts
        .iter()
        .filter(|fact| {
            matches!(
                &fact.payload,
                KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded {
                    result: MutationCommandResultV2::ToolIntentSubmission { reply },
                    ..
                }) if reply == &first_reply
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(command_facts.len(), 1);
    assert!(
        command_facts[0].ledger_sequence < awaiting_facts[0].ledger_sequence,
        "CommandRecorded must durably precede the exact CapabilityAwaiting fact"
    );
    assert!(!facts.iter().any(|fact| {
        matches!(
            &fact.payload,
            KernelFactPayloadV2::Invocation(_) | KernelFactPayloadV2::Effect(_)
        )
    }));
    assert!(!temp.workspace().join("still-pending").exists());
}

#[test]
fn invalid_workspace_path_is_durably_rejected_replayed_and_never_admitted() {
    let temp = TempWorkspace::new("invalid-path-rejection");
    let service = KernelSessionServiceV2::open(
        temp.store_path(),
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    )
    .expect("open file-backed v2 service");
    let opened = open_run(
        &service,
        temp.workspace(),
        WorkspaceBindingRefV2::new("workspace-invalid-path").expect("valid workspace binding"),
        "invalid-path-rejection",
    );
    let envelope = plan_intent(
        &opened,
        "request-invalid-path",
        "operation-invalid-path",
        "../outside-workspace",
        None,
    );

    let (handling, first_reply) = tool_intent_response(
        service.handle_session_command(envelope.clone(), &opened.run_capability),
    );
    assert_eq!(handling, CommandHandlingV2::Evaluated);
    let (rejection_fact_id, rejection_high_water) = match &first_reply {
        ToolIntentSubmitReplyV2::Rejected {
            reason,
            guidance,
            rejection_fact_id,
            rejection_batch_high_water,
            ..
        } => {
            assert_eq!(*reason, ToolIntentRejectionReasonV2::InvalidArguments);
            assert!(
                !guidance.trim().is_empty(),
                "typed rejection must include actionable guidance"
            );
            assert!(
                !guidance.contains(temp.root.to_string_lossy().as_ref()),
                "rejection guidance must not expose the host workspace path"
            );
            (rejection_fact_id.clone(), *rejection_batch_high_water)
        }
        other => panic!("expected typed invalid-path rejection, got {other:?}"),
    };

    let (handling, replayed_reply) =
        tool_intent_response(service.handle_session_command(envelope, &opened.run_capability));
    assert_eq!(handling, CommandHandlingV2::Replayed);
    assert_eq!(replayed_reply, first_reply);

    let facts = service
        .fact_reader()
        .query(&FactQueryV2 {
            run_id: Some(opened.run_id.to_string()),
            command_request_id: Some("request-invalid-path".to_owned()),
            ..FactQueryV2::default()
        })
        .expect("query durable rejection facts");
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].fact_id, rejection_fact_id);
    assert_eq!(facts[0].ledger_sequence, rejection_high_water);
    assert_eq!(
        facts[0]
            .payload
            .operation_id()
            .map(ToString::to_string)
            .as_deref(),
        Some("operation-invalid-path")
    );
    assert!(matches!(
        &facts[0].payload,
        KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded {
            result: MutationCommandResultV2::ToolIntentSubmission {
                reply: ToolIntentSubmitReplyV2::Rejected {
                    reason: ToolIntentRejectionReasonV2::InvalidArguments,
                    ..
                },
            },
            ..
        })
    ));
    let operation_facts = service
        .fact_reader()
        .query(&FactQueryV2 {
            run_id: Some(opened.run_id.to_string()),
            operation_id: Some("operation-invalid-path".to_owned()),
            ..FactQueryV2::default()
        })
        .expect("query rejection by operation lineage");
    assert_eq!(operation_facts, facts);
    let run_facts = service
        .fact_reader()
        .query(&FactQueryV2 {
            run_id: Some(opened.run_id.to_string()),
            ..FactQueryV2::default()
        })
        .expect("query complete Run facts after rejection");
    assert_eq!(
        run_facts
            .iter()
            .filter(|fact| {
                matches!(
                    &fact.payload,
                    KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded {
                        result: MutationCommandResultV2::ToolIntentSubmission {
                            reply: ToolIntentSubmitReplyV2::Rejected { .. },
                        },
                        ..
                    })
                )
            })
            .count(),
        1
    );
    assert!(!run_facts.iter().any(|fact| {
        matches!(
            &fact.payload,
            KernelFactPayloadV2::Invocation(_)
                | KernelFactPayloadV2::Effect(_)
                | KernelFactPayloadV2::Resource(_)
        )
    }));
    assert!(!temp.root.join("outside-workspace").exists());

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("resolver-loop", temp.workspace().join("resolver-loop"))
            .expect("create resolver loop");
        let resolver_envelope = plan_intent(
            &opened,
            "request-resolver-unavailable",
            "operation-resolver-unavailable",
            "resolver-loop",
            None,
        );
        for _ in 0..2 {
            match service.handle_session_command(resolver_envelope.clone(), &opened.run_capability)
            {
                KernelCommandResponseEnvelopeV2::Correlated {
                    handling: CommandHandlingV2::Evaluated,
                    reply:
                        KernelReplyV2::Error(KernelErrorV2::FactStoreUnavailable {
                            fault_code: StorageFaultCodeV2::Unavailable,
                        }),
                    ..
                } => {}
                other => panic!("expected non-durable resolver error, got {other:?}"),
            }
        }
        assert!(service
            .fact_reader()
            .query(&FactQueryV2 {
                run_id: Some(opened.run_id.to_string()),
                command_request_id: Some("request-resolver-unavailable".to_owned()),
                ..FactQueryV2::default()
            })
            .expect("query resolver error facts")
            .is_empty());
    }
}

#[test]
fn intervention_candidates_settle_atomically_without_executing_an_effect() {
    let harness = super::V2Harness::new("intervention-settlement");
    let selected = preview_intervention_candidate(
        &harness,
        "request-preview-intervention-selected",
        "candidate-plan-revision-selected",
        "candidate-plan-action-selected",
        "candidate-operation-selected",
        "option-selected",
        "selected-target",
    );
    let superseded = preview_intervention_candidate(
        &harness,
        "request-preview-intervention-superseded",
        "candidate-plan-revision-superseded",
        "candidate-plan-action-superseded",
        "candidate-operation-superseded",
        "option-superseded",
        "superseded-target",
    );
    assert!(selected.origin.is_preview_only());
    assert!(superseded.origin.is_preview_only());

    let facts_before = harness
        .service
        .fact_reader()
        .query(&FactQueryV2 {
            run_id: Some(harness.opened.run_id.to_string()),
            ..FactQueryV2::default()
        })
        .expect("query candidate-only facts");
    assert!(!facts_before.iter().any(|fact| {
        matches!(
            &fact.payload,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityIssued { .. })
                | KernelFactPayloadV2::Invocation(_)
                | KernelFactPayloadV2::Effect(_)
        )
    }));

    let decision_ref = UserDecisionRefV2::new("decision-ref-intervention-settlement")
        .expect("valid intervention decision ref");
    let selected_binding = harness
        .service
        .resolve_pending_capability_decision_host(selected.preview_id.clone(), decision_ref.clone())
        .expect("resolve selected candidate")
        .expect("selected candidate remains current")
        .binding;
    let decision = UserDecisionV2::InterventionSelect(InterventionSelectDecisionV3 {
        input_id: InputId::new("input-intervention-settlement").expect("valid current input id"),
        decision_ref,
        interaction_id: INTERVENTION_ID.to_owned(),
        interaction_revision: INTERVENTION_REVISION.to_owned(),
        candidate_set_digest: INTERVENTION_CANDIDATE_SET_DIGEST.to_owned(),
        selected_option_id: "option-selected".to_owned(),
        selected_bindings: vec![selected_binding],
        superseded_preview_ids: vec![superseded.preview_id.clone()],
    });
    let request_id = CommandRequestId::new("request-select-intervention")
        .expect("valid intervention selection request");
    let (reply, handling) = harness
        .service
        .apply_host_user_decision(
            request_id.clone(),
            harness.opened.run_id.clone(),
            harness.opened.control_epoch,
            decision.clone(),
        )
        .expect("atomically settle intervention candidates");
    assert_eq!(handling, CommandHandlingV2::Evaluated);
    let (leases, selected_fact_ids, superseded_fact_ids) = match &reply {
        UserDecisionReplyV2::InterventionSelected {
            leases,
            selected_fact_ids,
            superseded_fact_ids,
            ..
        } => (leases, selected_fact_ids, superseded_fact_ids),
        other => panic!("expected InterventionSelected, got {other:?}"),
    };
    assert_eq!(leases.len(), 1);
    assert_eq!(selected_fact_ids.len(), 1);
    assert_eq!(superseded_fact_ids.len(), 1);

    let (replayed, replay_handling) = harness
        .service
        .apply_host_user_decision(
            request_id.clone(),
            harness.opened.run_id.clone(),
            harness.opened.control_epoch,
            decision.clone(),
        )
        .expect("replay exact intervention selection");
    assert_eq!(replay_handling, CommandHandlingV2::Replayed);
    assert_eq!(replayed, reply);

    let mut conflicting = decision;
    let UserDecisionV2::InterventionSelect(conflicting_selection) = &mut conflicting else {
        unreachable!("test decision is interventionSelect");
    };
    conflicting_selection.selected_option_id = "option-conflict".to_owned();
    assert!(matches!(
        harness.service.apply_host_user_decision(
            request_id,
            harness.opened.run_id.clone(),
            harness.opened.control_epoch,
            conflicting,
        ),
        Err(KernelErrorV2::DuplicateCommandDigestMismatch { .. })
    ));

    let facts = harness
        .service
        .fact_reader()
        .query(&FactQueryV2 {
            run_id: Some(harness.opened.run_id.to_string()),
            ..FactQueryV2::default()
        })
        .expect("query settled intervention facts");
    assert_eq!(
        facts
            .iter()
            .filter(|fact| matches!(
                &fact.payload,
                KernelFactPayloadV2::Authorization(
                    AuthorizationFactV2::CapabilityIssued { identity, .. }
                ) if identity.preview_id == selected.preview_id
            ))
            .count(),
        1
    );
    assert_eq!(
        facts
            .iter()
            .filter(|fact| matches!(
                &fact.payload,
                KernelFactPayloadV2::Authorization(
                    AuthorizationFactV2::InterventionCandidateSuperseded {
                        preview_id,
                        selected_option_id,
                        ..
                    }
                ) if preview_id == &superseded.preview_id
                    && selected_option_id == "option-selected"
            ))
            .count(),
        1
    );
    assert!(!facts.iter().any(|fact| matches!(
        &fact.payload,
        KernelFactPayloadV2::Invocation(_) | KernelFactPayloadV2::Effect(_)
    )));
    assert!(!harness.temp.workspace().join("selected-target").exists());
    assert!(!harness.temp.workspace().join("superseded-target").exists());
}
