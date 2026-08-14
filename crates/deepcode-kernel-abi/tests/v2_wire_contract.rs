use std::collections::BTreeMap;

use deepcode_kernel_abi::v2::*;
use deepcode_kernel_abi::v2_command::{
    decode_kernel_command_v2, CapabilityApprovalViewV2, CapabilityResourcePresentationKindV2,
    CapabilityResourcePresentationV2, CapabilityScopeDispositionV2,
    CapabilityScopePreviewOriginV3, CapabilityScopePreviewRecordV2,
    CommandHandlingV2, DeadlineRequestV2, KernelCommandEnvelopeV2, KernelCommandV2,
    KernelFactProjectionPageV2, KernelFactProjectionV2, KernelFactsQueryScopedV2, KernelReplyV2,
    KernelWireErrorV2, MutationCommandKindV2, ToolIntentRejectionReasonV2, ToolIntentSubmitReplyV2,
    ToolIntentSubmitV2,
};
use deepcode_kernel_abi::{
    canonical_arguments_digest_v2, capability_authorization_digest_v2, capability_scope_digest_v2,
    render_kernel_tool_prompt_v2, tool_catalog_digest_v2, tool_context_digest_v2,
    CanonicalArgumentsDigestV2, CapabilityAuthorizationBindingV2, CapabilityLeaseIdV2,
    CapabilityLeaseRefV2, CapabilityLeaseVersionV2, CapabilityScopeDigestV2,
    CapabilityScopePreviewIdV2, DecisionCapabilityV2, PlanActionIdV2, PlanRevisionV2,
    RawToolArgumentsV2, RunCapabilityV2, ToolAuthorizationShapeV2, ToolAvailabilityV2,
    ToolCatalogDigestV2, ToolContextBundleV2, ToolContextDigestV2, ToolContextRefV2,
    ToolContextVersionV2, ToolContractDigestV2, ToolDescriptorV2, ToolEffectClassV2,
    ToolEffectScopeV2, ToolIdV2, ToolInputSchemaV2, ToolIntentAuthorityV2, ToolRiskV2,
    UserDecisionReplyV2, UserDecisionResponseEnvelopeV2, KERNEL_ABI_V2_VERSION,
    TOOL_CONTEXT_FORMAT_V2,
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

fn golden_capability_lease() -> CapabilityLeaseRefV2 {
    CapabilityLeaseRefV2 {
        lease_id: CapabilityLeaseIdV2::new("lease-golden-1").expect("valid lease id"),
        version: CapabilityLeaseVersionV2::new(2).expect("valid lease version"),
        scope_digest: CapabilityScopeDigestV2::parse(format!("sha256:{}", "3".repeat(64)))
            .expect("valid scope digest"),
    }
}

fn golden_invocation_authority() -> InvocationAuthorityV2 {
    InvocationAuthorityV2::PlanAction {
        plan_revision: PlanRevisionV2::new("plan-revision-golden-1").expect("valid plan revision"),
        plan_action_id: PlanActionIdV2::new("plan-action-golden-1").expect("valid plan action"),
        lease: golden_capability_lease(),
        policy_evaluation_digest: PolicyEvaluationDigestV2::parse(format!(
            "sha256:{}",
            "4".repeat(64)
        ))
        .expect("valid policy evaluation digest"),
    }
}

fn golden_effect_identity() -> ToolEffectIdentityV2 {
    ToolEffectIdentityV2 {
        run_id: run_id("run-1"),
        control_epoch: ControlEpoch::new(2).expect("non-zero epoch"),
        operation_id: operation_id("operation-golden-readme"),
        authority: golden_invocation_authority(),
        invocation_id: InvocationId::new("invocation-golden-readme-1")
            .expect("valid invocation id"),
        attempt_id: AttemptId::new("attempt-golden-readme-1").expect("valid attempt id"),
        effect_id: EffectId::new("effect-golden-readme-1").expect("valid effect id"),
        idempotency_key_hash: IdempotencyKeyHashV2::parse(format!("sha256:{}", "5".repeat(64)))
            .expect("valid idempotency key hash"),
        causation_fact_id: fact_id("fact-execution-started-golden-1"),
    }
}

fn golden_terminal_identity() -> ToolObservedTerminalIdentityV2 {
    let identity = golden_effect_identity();
    ToolObservedTerminalIdentityV2 {
        run_id: identity.run_id,
        control_epoch: identity.control_epoch,
        operation_id: identity.operation_id,
        authority: identity.authority,
        invocation_id: identity.invocation_id,
        attempt_id: identity.attempt_id,
        effect_id: identity.effect_id,
        idempotency_key_hash: identity.idempotency_key_hash,
        causation_fact_id: fact_id("fact-effect-observed-golden-1"),
        correlation_set: Default::default(),
    }
}

fn golden_tool_observed_fact() -> KernelFactEnvelopeV2 {
    let content = b"DeepCode golden README\n";
    let evidence = EffectEvidenceV2::ContentRead {
        content_digest: content_digest_v2(content),
        byte_length: content.len() as u64,
    };
    let evidence_digest =
        executor_evidence_digest_v2(&evidence).expect("materialize evidence digest");
    KernelFactEnvelopeV2 {
        abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
        fact_id: fact_id("fact-effect-observed-golden-1"),
        ledger_sequence: 42,
        run_sequence: 8,
        recorded_at: RecordedAtV2::new("2026-07-29T00:00:01.000Z").expect("valid recorded time"),
        payload: KernelFactPayloadV2::Effect(EffectFactV2::ToolObserved {
            identity: golden_effect_identity(),
            affected_resource_ids: vec![
                ResourceId::new("resource-01-readme").expect("valid resource id"),
                ResourceId::new("resource-02-workspace-index").expect("valid resource id"),
            ],
            evidence,
            evidence_digest,
        }),
    }
}

fn golden_tool_completed_fact() -> KernelFactEnvelopeV2 {
    KernelFactEnvelopeV2 {
        abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
        fact_id: fact_id("fact-invocation-completed-golden-1"),
        ledger_sequence: 43,
        run_sequence: 9,
        recorded_at: RecordedAtV2::new("2026-07-29T00:00:02.000Z").expect("valid recorded time"),
        payload: KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCompleted {
            identity: golden_terminal_identity(),
            output: serde_json::json!({
                "bytesRead": 23,
                "path": "README.md"
            }),
        }),
    }
}

fn digest_text(fill: char) -> String {
    format!("sha256:{}", fill.to_string().repeat(64))
}

#[derive(Clone)]
struct MutationPreviewVector<'a> {
    run_id: &'a str,
    plan_revision: &'a str,
    plan_action_id: &'a str,
    operation_id: &'a str,
    preview_id: &'a str,
    path: &'a str,
    approved_paths: &'a [&'a str],
    scope_delta: &'a [&'a str],
    target_observation_fill: char,
    decision_class: &'a str,
    origin: CapabilityScopePreviewOriginV3,
}

fn mutation_preview(vector: MutationPreviewVector<'_>) -> CapabilityScopePreviewRecordV2 {
    let context_ref = golden_mutation_tool_context().context_ref();
    let descriptor = golden_mutation_tool_context().tools[1].clone();
    let tool_id = descriptor.tool_id.clone();
    let authorization_binding = CapabilityAuthorizationBindingV2::ResourceScope {};
    let canonical_scope = ResourceScopeV2::Workspace {
        targets: vec![WorkspaceScopeTargetV2 {
            relative_path: vector.path.to_owned(),
            object_kind: WorkspaceObjectKindV2::File,
            access: ResourceAccessV2::Write,
            target_observation_digest: ResourceStateDigestV2::parse(digest_text(
                vector.target_observation_fill,
            ))
            .expect("valid target observation digest"),
        }],
    };
    let approved_targets = vector
        .approved_paths
        .iter()
        .map(|path| {
            serde_json::json!({
                "kind": "workspace",
                "path": path,
                "access": "write",
            })
        })
        .collect::<Vec<_>>();
    let run_id = run_id(vector.run_id);
    let control_epoch = ControlEpoch::new(1).expect("valid preview epoch");
    let plan_revision =
        PlanRevisionV2::new(vector.plan_revision).expect("valid preview plan revision");
    let plan_action_id =
        PlanActionIdV2::new(vector.plan_action_id).expect("valid preview plan action");
    let operation_id = operation_id(vector.operation_id);
    let preview_id = CapabilityScopePreviewIdV2::new(vector.preview_id).expect("valid preview id");
    let workspace_binding_digest =
        WorkspaceBindingDigestV2::parse(digest_text('d')).expect("valid workspace binding digest");
    let scope_digest = capability_scope_digest_v2(&serde_json::json!({
        "runId": run_id,
        "workspaceBindingDigest": workspace_binding_digest,
        "controlEpoch": control_epoch,
        "planRevision": plan_revision,
        "planActionId": plan_action_id,
        "toolId": tool_id,
        "authorizationBinding": authorization_binding,
        "targets": approved_targets,
        "canonicalResourceScope": canonical_scope,
        "toolContractDigest": descriptor.contract_digest,
        "toolContext": context_ref,
        "effectClass": descriptor.effect_class,
        "effectScope": descriptor.effect_scope,
        "risk": descriptor.risk,
    }))
    .expect("materialize mutation preview scope digest");
    let authorization_digest = capability_authorization_digest_v2(&serde_json::json!({
        "previewId": preview_id,
        "runId": run_id,
        "workspaceBindingDigest": workspace_binding_digest,
        "controlEpoch": control_epoch,
        "planRevision": plan_revision,
        "planActionId": plan_action_id,
        "operationId": operation_id,
        "toolId": tool_id,
        "authorizationBinding": authorization_binding,
        "scopeDigest": scope_digest,
        "decisionClass": vector.decision_class,
        "toolContractDigest": descriptor.contract_digest,
        "toolContext": context_ref,
    }))
    .expect("materialize mutation preview authorization digest");
    let canonical_targets = vector
        .approved_paths
        .iter()
        .map(|path| format!("workspace:Write:{path}"))
        .collect::<Vec<_>>();
    let scope_delta = vector
        .scope_delta
        .iter()
        .map(|path| format!("workspace:Write:{path}"))
        .collect::<Vec<_>>();
    let resource_presentation = vector
        .approved_paths
        .iter()
        .map(|path| CapabilityResourcePresentationV2 {
            kind: CapabilityResourcePresentationKindV2::WorkspacePath,
            label: (*path).to_owned(),
            workspace_relative_path: Some((*path).to_owned()),
            canonical_resource_ref: Some(format!("workspace:Write:{path}")),
        })
        .collect::<Vec<_>>();
    let effective_deadline_ms = 30_000;
    CapabilityScopePreviewRecordV2 {
        preview_id,
        run_id,
        control_epoch,
        plan_revision,
        plan_action_id,
        operation_id,
        tool_id,
        origin: vector.origin,
        authorization_binding,
        canonical_scope,
        scope_digest: scope_digest.clone(),
        authorization_digest,
        tool_contract_digest: descriptor.contract_digest,
        context_ref,
        effect_class: descriptor.effect_class,
        effect_scope: descriptor.effect_scope,
        risk: descriptor.risk,
        effective_deadline_ms,
        disposition: CapabilityScopeDispositionV2::RequiresUserDecision,
        approval_view: CapabilityApprovalViewV2 {
            summary: format!(
                "Mutate using fs.write within {} canonical target(s)",
                canonical_targets.len()
            ),
            canonical_targets,
            scope_delta,
            resource_presentation,
            risk: descriptor.risk,
            effect_class: descriptor.effect_class,
            effect_scope: descriptor.effect_scope,
            effective_deadline_ms,
            scope_digest,
        },
    }
}

fn corpus_normal_preview() -> CapabilityScopePreviewRecordV2 {
    mutation_preview(MutationPreviewVector {
        run_id: "run-1",
        plan_revision: "plan-revision-golden-1",
        plan_action_id: "plan-action-golden-1",
        operation_id: "planned-operation-golden-output",
        preview_id: "preview-golden-output-1",
        path: "output.txt",
        approved_paths: &["output.txt"],
        scope_delta: &[],
        target_observation_fill: '9',
        decision_class: "capability",
        origin: CapabilityScopePreviewOriginV3::Plan {},
    })
}

fn corpus_expanded_allow_preview() -> CapabilityScopePreviewRecordV2 {
    mutation_preview(MutationPreviewVector {
        run_id: "run-1",
        plan_revision: "plan-revision-golden-1",
        plan_action_id: "plan-action-golden-1",
        operation_id: "operation-c4cbe96134b04cf4963b4f50d5672870167c9dd3826e9aca6a3ce3a468367e64",
        preview_id: "preview-golden-expanded-allow-1",
        path: "expanded.txt",
        approved_paths: &["expanded.txt", "output.txt"],
        scope_delta: &["expanded.txt"],
        target_observation_fill: '7',
        decision_class: "scopeExpansion",
        origin: CapabilityScopePreviewOriginV3::Plan {},
    })
}

fn corpus_deny_normal_preview() -> CapabilityScopePreviewRecordV2 {
    mutation_preview(MutationPreviewVector {
        run_id: "run-1",
        plan_revision: "plan-revision-golden-deny-1",
        plan_action_id: "plan-action-golden-deny-1",
        operation_id: "planned-operation-golden-deny-output",
        preview_id: "preview-golden-deny-output-1",
        path: "output.txt",
        approved_paths: &["output.txt"],
        scope_delta: &[],
        target_observation_fill: '9',
        decision_class: "capability",
        origin: CapabilityScopePreviewOriginV3::Plan {},
    })
}

fn corpus_expanded_deny_preview() -> CapabilityScopePreviewRecordV2 {
    mutation_preview(MutationPreviewVector {
        run_id: "run-1",
        plan_revision: "plan-revision-golden-deny-1",
        plan_action_id: "plan-action-golden-deny-1",
        operation_id: "operation-9bf7e05374580c4630967e5c9a584a26f5884d63df3fba7ff17338c2da906bb6",
        preview_id: "preview-golden-expanded-deny-1",
        path: "expanded.txt",
        approved_paths: &["expanded.txt", "output.txt"],
        scope_delta: &["expanded.txt"],
        target_observation_fill: '7',
        decision_class: "scopeExpansion",
        origin: CapabilityScopePreviewOriginV3::Plan {},
    })
}

fn session_default_preview() -> CapabilityScopePreviewRecordV2 {
    mutation_preview(MutationPreviewVector {
        run_id: "run-session-v2-contract",
        plan_revision: "plan-revision-1",
        plan_action_id: "plan-action-write-output",
        operation_id: "planned-operation-write-output",
        preview_id: "preview-plan-action-write-output",
        path: "output.txt",
        approved_paths: &["output.txt"],
        scope_delta: &[],
        target_observation_fill: '9',
        decision_class: "capability",
        origin: CapabilityScopePreviewOriginV3::Plan {},
    })
}

fn session_second_action_preview() -> CapabilityScopePreviewRecordV2 {
    mutation_preview(MutationPreviewVector {
        run_id: "run-session-v2-contract",
        plan_revision: "plan-two-actions",
        plan_action_id: "plan-action-write-second",
        operation_id: "planned-operation-write-second",
        preview_id: "preview-plan-action-write-second",
        path: "second.txt",
        approved_paths: &["second.txt"],
        scope_delta: &[],
        target_observation_fill: '8',
        decision_class: "capability",
        origin: CapabilityScopePreviewOriginV3::Plan {},
    })
}

fn session_first_action_preview() -> CapabilityScopePreviewRecordV2 {
    mutation_preview(MutationPreviewVector {
        run_id: "run-session-v2-contract",
        plan_revision: "plan-two-actions",
        plan_action_id: "plan-action-write-first",
        operation_id: "planned-operation-write-first",
        preview_id: "preview-plan-action-write-first",
        path: "output.txt",
        approved_paths: &["output.txt"],
        scope_delta: &[],
        target_observation_fill: '9',
        decision_class: "capability",
        origin: CapabilityScopePreviewOriginV3::Plan {},
    })
}

fn session_plan_discovery_preview() -> CapabilityScopePreviewRecordV2 {
    mutation_preview(MutationPreviewVector {
        run_id: "run-session-v2-contract",
        plan_revision: "plan-revision-1",
        plan_action_id: "plan-action-write-output",
        operation_id: "operation-plan-discovery-expanded",
        preview_id: "preview-plan-discovery-expanded",
        path: "expanded.txt",
        approved_paths: &["expanded.txt"],
        scope_delta: &["expanded.txt"],
        target_observation_fill: '7',
        decision_class: "planDiscovery",
        origin: CapabilityScopePreviewOriginV3::PlanDiscovery {
            discovery_id: "discovery-wire-golden-1".to_owned(),
        },
    })
}

fn session_intervention_candidate_selected_preview() -> CapabilityScopePreviewRecordV2 {
    mutation_preview(MutationPreviewVector {
        run_id: "run-session-v2-contract",
        plan_revision: "plan-revision-intervention-selected",
        plan_action_id: "plan-action-intervention-selected",
        operation_id: "operation-intervention-selected",
        preview_id: "preview-intervention-selected",
        path: "expanded.txt",
        approved_paths: &["expanded.txt"],
        scope_delta: &["expanded.txt"],
        target_observation_fill: '7',
        decision_class: "interventionCandidate",
        origin: CapabilityScopePreviewOriginV3::InterventionCandidate {
            interaction_id: "user-intervention-wire-golden-1".to_owned(),
            interaction_revision: "intervention-revision-wire-golden-1".to_owned(),
            candidate_set_digest: digest_text('a'),
            option_id: "option-selected".to_owned(),
        },
    })
}

fn session_intervention_candidate_superseded_preview() -> CapabilityScopePreviewRecordV2 {
    mutation_preview(MutationPreviewVector {
        run_id: "run-session-v2-contract",
        plan_revision: "plan-revision-intervention-superseded",
        plan_action_id: "plan-action-intervention-superseded",
        operation_id: "operation-intervention-superseded",
        preview_id: "preview-intervention-superseded",
        path: "alternate.txt",
        approved_paths: &["alternate.txt"],
        scope_delta: &["alternate.txt"],
        target_observation_fill: '6',
        decision_class: "interventionCandidate",
        origin: CapabilityScopePreviewOriginV3::InterventionCandidate {
            interaction_id: "user-intervention-wire-golden-1".to_owned(),
            interaction_revision: "intervention-revision-wire-golden-1".to_owned(),
            candidate_set_digest: digest_text('a'),
            option_id: "option-superseded".to_owned(),
        },
    })
}

fn kernel_capability_previews() -> BTreeMap<&'static str, CapabilityScopePreviewRecordV2> {
    BTreeMap::from([
        ("corpusExpandedAllow", corpus_expanded_allow_preview()),
        ("corpusExpandedDeny", corpus_expanded_deny_preview()),
        ("corpusNormal", corpus_normal_preview()),
        ("corpusNormalDeny", corpus_deny_normal_preview()),
        ("sessionDefault", session_default_preview()),
        ("sessionFirstAction", session_first_action_preview()),
        ("sessionInterventionCandidateSelected", session_intervention_candidate_selected_preview()),
        ("sessionInterventionCandidateSuperseded", session_intervention_candidate_superseded_preview()),
        ("sessionPlanDiscovery", session_plan_discovery_preview()),
        ("sessionSecondAction", session_second_action_preview()),
    ])
}

fn corpus_context_ref() -> ToolContextRefV2 {
    golden_tool_context().context_ref()
}

fn corpus_previous_context_ref() -> ToolContextRefV2 {
    golden_mutation_tool_context().context_ref()
}

fn corpus_correlation_set() -> CorrelationSetV2 {
    CorrelationSetV2::materialize(vec![CorrelationRefV2::PlanAction {
        value: "plan-action-golden-1".to_owned(),
    }])
    .expect("valid corpus correlation set")
}

fn corpus_lease_identity(
    version: u64,
    operation: &str,
    preview: &str,
    causation_fact: &str,
) -> CapabilityLeaseFactIdentityV2 {
    CapabilityLeaseFactIdentityV2 {
        run_id: run_id("run-1"),
        control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
        plan_revision: PlanRevisionV2::new("plan-revision-golden-1").expect("valid plan revision"),
        plan_action_id: PlanActionIdV2::new("plan-action-golden-1").expect("valid plan action"),
        operation_id: operation_id(operation),
        preview_id: CapabilityScopePreviewIdV2::new(preview).expect("valid preview id"),
        lease_id: CapabilityLeaseIdV2::new("lease-golden-1").expect("valid lease id"),
        lease_version: CapabilityLeaseVersionV2::new(version).expect("valid lease version"),
        causation_fact_id: fact_id(causation_fact),
        correlation_set: corpus_correlation_set(),
    }
}

fn corpus_lease(version: u64) -> CapabilityLeaseRefV2 {
    CapabilityLeaseRefV2 {
        lease_id: CapabilityLeaseIdV2::new("lease-golden-1").expect("valid lease id"),
        version: CapabilityLeaseVersionV2::new(version).expect("valid lease version"),
        scope_digest: if version == 1 {
            corpus_normal_preview().scope_digest
        } else {
            corpus_expanded_allow_preview().scope_digest
        },
    }
}

fn corpus_invocation_authority(version: u64) -> InvocationAuthorityV2 {
    InvocationAuthorityV2::PlanAction {
        plan_revision: PlanRevisionV2::new("plan-revision-golden-1").expect("valid plan revision"),
        plan_action_id: PlanActionIdV2::new("plan-action-golden-1").expect("valid plan action"),
        lease: corpus_lease(version),
        policy_evaluation_digest: PolicyEvaluationDigestV2::parse(digest_text('4'))
            .expect("valid policy evaluation digest"),
    }
}

fn corpus_context_read_authority() -> InvocationAuthorityV2 {
    InvocationAuthorityV2::Read {
        tool_context_ref: corpus_context_ref(),
        settings_digest: SettingsCeilingDigestV2::parse(digest_text('e'))
            .expect("valid settings digest"),
        policy_evaluation_digest: PolicyEvaluationDigestV2::parse(digest_text('4'))
            .expect("valid policy evaluation digest"),
    }
}

fn corpus_mutation_context_read_authority() -> InvocationAuthorityV2 {
    InvocationAuthorityV2::Read {
        tool_context_ref: corpus_previous_context_ref(),
        settings_digest: SettingsCeilingDigestV2::parse(digest_text('e'))
            .expect("valid settings digest"),
        policy_evaluation_digest: PolicyEvaluationDigestV2::parse(digest_text('4'))
            .expect("valid policy evaluation digest"),
    }
}

fn corpus_context_read_canonical_arguments_digest() -> CanonicalArgumentsDigestV2 {
    canonical_arguments_digest_v2(
        &ToolIdV2::parse("fs.read").expect("valid context-read tool id"),
        &serde_json::json!({"path": "README.md"}),
    )
    .expect("materialize context-read canonical arguments digest")
}

fn corpus_context_read_tool_contract_digest() -> ToolContractDigestV2 {
    golden_tool_context().tools[0].contract_digest.clone()
}

fn corpus_write_tool_contract_digest() -> ToolContractDigestV2 {
    golden_mutation_tool_context().tools[1]
        .contract_digest
        .clone()
}

fn corpus_normal_canonical_arguments_digest() -> CanonicalArgumentsDigestV2 {
    canonical_arguments_digest_v2(
        &ToolIdV2::parse("fs.write").expect("valid mutation tool id"),
        &serde_json::json!({
            "content": "contract output",
            "path": "output.txt"
        }),
    )
    .expect("materialize normal mutation canonical arguments digest")
}

fn corpus_expanded_canonical_arguments_digest() -> CanonicalArgumentsDigestV2 {
    canonical_arguments_digest_v2(
        &ToolIdV2::parse("fs.write").expect("valid mutation tool id"),
        &serde_json::json!({
            "content": "expanded",
            "path": "expanded.txt"
        }),
    )
    .expect("materialize expanded mutation canonical arguments digest")
}

fn corpus_attempt_identity(
    operation: &str,
    invocation: &str,
    attempt: &str,
    lease_version: u64,
    causation_fact: &str,
) -> ToolAttemptIdentityV2 {
    ToolAttemptIdentityV2 {
        run_id: run_id("run-1"),
        control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
        operation_id: operation_id(operation),
        authority: corpus_invocation_authority(lease_version),
        invocation_id: InvocationId::new(invocation).expect("valid invocation id"),
        attempt_id: AttemptId::new(attempt).expect("valid attempt id"),
        idempotency_key_hash: IdempotencyKeyHashV2::parse(digest_text('5'))
            .expect("valid idempotency hash"),
        causation_fact_id: fact_id(causation_fact),
        correlation_set: corpus_correlation_set(),
    }
}

fn corpus_effect_identity(
    operation: &str,
    invocation: &str,
    attempt: &str,
    effect: &str,
    lease_version: u64,
    causation_fact: &str,
) -> ToolEffectIdentityV2 {
    ToolEffectIdentityV2 {
        run_id: run_id("run-1"),
        control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
        operation_id: operation_id(operation),
        authority: corpus_invocation_authority(lease_version),
        invocation_id: InvocationId::new(invocation).expect("valid invocation id"),
        attempt_id: AttemptId::new(attempt).expect("valid attempt id"),
        effect_id: EffectId::new(effect).expect("valid effect id"),
        idempotency_key_hash: IdempotencyKeyHashV2::parse(digest_text('5'))
            .expect("valid idempotency hash"),
        causation_fact_id: fact_id(causation_fact),
    }
}

fn corpus_context_read_attempt_identity(causation_fact: &str) -> ToolAttemptIdentityV2 {
    ToolAttemptIdentityV2 {
        run_id: run_id("run-1"),
        control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
        operation_id: operation_id("operation-golden-context-read"),
        authority: corpus_context_read_authority(),
        invocation_id: InvocationId::new("invocation-golden-context-read-1")
            .expect("valid invocation id"),
        attempt_id: AttemptId::new("attempt-golden-context-read-1").expect("valid attempt id"),
        idempotency_key_hash: IdempotencyKeyHashV2::parse(digest_text('5'))
            .expect("valid idempotency hash"),
        causation_fact_id: fact_id(causation_fact),
        correlation_set: CorrelationSetV2::default(),
    }
}

fn corpus_context_read_effect_identity() -> ToolEffectIdentityV2 {
    ToolEffectIdentityV2 {
        run_id: run_id("run-1"),
        control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
        operation_id: operation_id("operation-golden-context-read"),
        authority: corpus_context_read_authority(),
        invocation_id: InvocationId::new("invocation-golden-context-read-1")
            .expect("valid invocation id"),
        attempt_id: AttemptId::new("attempt-golden-context-read-1").expect("valid attempt id"),
        effect_id: EffectId::new("effect-golden-context-read-1").expect("valid effect id"),
        idempotency_key_hash: IdempotencyKeyHashV2::parse(digest_text('5'))
            .expect("valid idempotency hash"),
        causation_fact_id: fact_id("fact-context-read-execution-started-golden-1"),
    }
}

fn corpus_context_read_terminal_identity() -> ToolObservedTerminalIdentityV2 {
    ToolObservedTerminalIdentityV2 {
        run_id: run_id("run-1"),
        control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
        operation_id: operation_id("operation-golden-context-read"),
        authority: corpus_context_read_authority(),
        invocation_id: InvocationId::new("invocation-golden-context-read-1")
            .expect("valid invocation id"),
        attempt_id: AttemptId::new("attempt-golden-context-read-1").expect("valid attempt id"),
        effect_id: EffectId::new("effect-golden-context-read-1").expect("valid effect id"),
        idempotency_key_hash: IdempotencyKeyHashV2::parse(digest_text('5'))
            .expect("valid idempotency hash"),
        causation_fact_id: fact_id("fact-context-read-effect-observed-golden-1"),
        correlation_set: CorrelationSetV2::default(),
    }
}

fn corpus_mutation_context_read_attempt_identity(causation_fact: &str) -> ToolAttemptIdentityV2 {
    ToolAttemptIdentityV2 {
        run_id: run_id("run-1"),
        control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
        operation_id: operation_id("operation-golden-context-read"),
        authority: corpus_mutation_context_read_authority(),
        invocation_id: InvocationId::new("invocation-golden-context-read-1")
            .expect("valid invocation id"),
        attempt_id: AttemptId::new("attempt-golden-context-read-1").expect("valid attempt id"),
        idempotency_key_hash: IdempotencyKeyHashV2::parse(digest_text('5'))
            .expect("valid idempotency hash"),
        causation_fact_id: fact_id(causation_fact),
        correlation_set: CorrelationSetV2::default(),
    }
}

fn corpus_mutation_context_read_effect_identity() -> ToolEffectIdentityV2 {
    ToolEffectIdentityV2 {
        run_id: run_id("run-1"),
        control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
        operation_id: operation_id("operation-golden-context-read"),
        authority: corpus_mutation_context_read_authority(),
        invocation_id: InvocationId::new("invocation-golden-context-read-1")
            .expect("valid invocation id"),
        attempt_id: AttemptId::new("attempt-golden-context-read-1").expect("valid attempt id"),
        effect_id: EffectId::new("effect-golden-context-read-1").expect("valid effect id"),
        idempotency_key_hash: IdempotencyKeyHashV2::parse(digest_text('5'))
            .expect("valid idempotency hash"),
        causation_fact_id: fact_id("fact-mutation-context-read-execution-started-golden-1"),
    }
}

fn corpus_mutation_context_read_terminal_identity() -> ToolObservedTerminalIdentityV2 {
    ToolObservedTerminalIdentityV2 {
        run_id: run_id("run-1"),
        control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
        operation_id: operation_id("operation-golden-context-read"),
        authority: corpus_mutation_context_read_authority(),
        invocation_id: InvocationId::new("invocation-golden-context-read-1")
            .expect("valid invocation id"),
        attempt_id: AttemptId::new("attempt-golden-context-read-1").expect("valid attempt id"),
        effect_id: EffectId::new("effect-golden-context-read-1").expect("valid effect id"),
        idempotency_key_hash: IdempotencyKeyHashV2::parse(digest_text('5'))
            .expect("valid idempotency hash"),
        causation_fact_id: fact_id("fact-mutation-context-read-effect-observed-golden-1"),
        correlation_set: CorrelationSetV2::default(),
    }
}

fn corpus_terminal_identity(
    operation: &str,
    invocation: &str,
    attempt: &str,
    effect: &str,
    lease_version: u64,
    causation_fact: &str,
) -> ToolObservedTerminalIdentityV2 {
    ToolObservedTerminalIdentityV2 {
        run_id: run_id("run-1"),
        control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
        operation_id: operation_id(operation),
        authority: corpus_invocation_authority(lease_version),
        invocation_id: InvocationId::new(invocation).expect("valid invocation id"),
        attempt_id: AttemptId::new(attempt).expect("valid attempt id"),
        effect_id: EffectId::new(effect).expect("valid effect id"),
        idempotency_key_hash: IdempotencyKeyHashV2::parse(digest_text('5'))
            .expect("valid idempotency hash"),
        causation_fact_id: fact_id(causation_fact),
        correlation_set: corpus_correlation_set(),
    }
}

fn corpus_fact(
    fact_id_value: &str,
    ledger_sequence: u64,
    run_sequence: u64,
    recorded_second: u64,
    payload: KernelFactPayloadV2,
) -> KernelFactEnvelopeV2 {
    KernelFactEnvelopeV2 {
        abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
        fact_id: fact_id(fact_id_value),
        ledger_sequence,
        run_sequence,
        recorded_at: RecordedAtV2::new(format!("2026-07-29T00:01:{recorded_second:02}.000Z"))
            .expect("valid corpus recorded time"),
        payload,
    }
}

fn kernel_fact_corpus() -> BTreeMap<&'static str, KernelFactEnvelopeV2> {
    let mut corpus = BTreeMap::new();
    corpus.insert(
        "controlCommandRecordedRejectedToolIntent",
        corpus_fact(
            "fact-command-rejected-golden-1",
            31,
            1,
            1,
            KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded {
                identity: CommandReceiptIdentityV2 {
                    run_id: run_id("run-1"),
                    epoch_context: CommandEpochContextV2::Exact {
                        control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
                    },
                    command_request_identity: CommandRequestIdentityV2 {
                        command_request_id: CommandRequestId::new(
                            "request-golden-tool-intent-rejected-1",
                        )
                        .expect("valid command request id"),
                        command_request_digest: CommandRequestDigestV2::parse(digest_text('f'))
                            .expect("valid command request digest"),
                    },
                },
                command_kind: MutationCommandKindV2::ToolIntentSubmit,
                result: MutationCommandResultV2::ToolIntentSubmission {
                    reply: ToolIntentSubmitReplyV2::Rejected {
                        run_id: run_id("run-1"),
                        operation_id: operation_id("operation-golden-rejected"),
                        current_control_epoch: ControlEpoch::new(1).expect("valid current epoch"),
                        reason: ToolIntentRejectionReasonV2::StaleControlEpoch,
                        guidance: "Refresh the current control epoch before re-planning."
                            .to_owned(),
                        rejection_fact_id: fact_id("fact-command-rejected-golden-1"),
                        rejection_batch_high_water: 31,
                    },
                },
            }),
        ),
    );
    corpus.insert(
        "controlCommandRecordedRejectedInvalidPathToolIntent",
        corpus_fact(
            "fact-command-invalid-path-golden-1",
            32,
            2,
            2,
            KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded {
                identity: CommandReceiptIdentityV2 {
                    run_id: run_id("run-1"),
                    epoch_context: CommandEpochContextV2::Exact {
                        control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
                    },
                    command_request_identity: CommandRequestIdentityV2 {
                        command_request_id: CommandRequestId::new(
                            "request-golden-invalid-path-tool-intent-1",
                        )
                        .expect("valid command request id"),
                        command_request_digest: CommandRequestDigestV2::parse(digest_text('0'))
                            .expect("valid command request digest"),
                    },
                },
                command_kind: MutationCommandKindV2::ToolIntentSubmit,
                result: MutationCommandResultV2::ToolIntentSubmission {
                    reply: ToolIntentSubmitReplyV2::Rejected {
                        run_id: run_id("run-1"),
                        operation_id: operation_id("operation-golden-invalid-path"),
                        current_control_epoch: ControlEpoch::new(1)
                            .expect("valid current epoch"),
                        reason: ToolIntentRejectionReasonV2::InvalidArguments,
                        guidance:
                            "Use a workspace-relative path that resolves inside the bound workspace."
                                .to_owned(),
                        rejection_fact_id: fact_id("fact-command-invalid-path-golden-1"),
                        rejection_batch_high_water: 32,
                    },
                },
            }),
        ),
    );
    corpus.insert(
        "controlEpochAdvanced",
        corpus_fact(
            "fact-epoch-advanced-golden-1",
            52,
            22,
            22,
            KernelFactPayloadV2::Control(ControlFactV2::EpochAdvanced {
                identity: TransitionIdentityV2 {
                    run_id: run_id("run-1"),
                    control_epoch: ControlEpoch::new(2).expect("valid advanced epoch"),
                    causation_fact_id: fact_id("fact-input-recorded-golden-2"),
                },
                input_id: InputId::new("input-golden-2").expect("valid input id"),
                previous_epoch: Some(ControlEpoch::new(1).expect("valid previous epoch")),
                opaque_input_ref: "session-input:golden:2".to_owned(),
            }),
        ),
    );
    corpus.insert(
        "controlCancellationRequested",
        corpus_fact(
            "fact-cancellation-requested-golden-1",
            53,
            23,
            23,
            KernelFactPayloadV2::Control(ControlFactV2::CancellationRequested {
                identity: CancellationIdentityV2 {
                    run_id: run_id("run-1"),
                    control_epoch: ControlEpoch::new(2).expect("valid cancellation epoch"),
                    invocation_id: InvocationId::new("invocation-golden-active-at-epoch-1")
                        .expect("valid invocation id"),
                    cancel_request_id: CancelRequestId::new("cancel-golden-1")
                        .expect("valid cancellation id"),
                    causation_fact_id: fact_id("fact-epoch-advanced-golden-1"),
                },
                source: CancellationSourceV2::EpochAdvance,
                reason_code: CancellationReasonCodeV2::EpochSuperseded,
                reason: Some("new user input superseded the previous turn".to_owned()),
            }),
        ),
    );
    corpus.insert(
        "authorizationCapabilityIssued",
        corpus_fact(
            "fact-capability-issued-golden-1",
            33,
            3,
            3,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityIssued {
                identity: corpus_lease_identity(
                    1,
                    "planned-operation-golden-output",
                    "preview-golden-output-1",
                    "fact-user-allowed-golden-1",
                ),
                tool_id: ToolIdV2::parse("fs.write").expect("valid tool id"),
                scope_digest: corpus_lease(1).scope_digest,
                authorization_digest: corpus_normal_preview().authorization_digest,
                tool_contract_digest: corpus_write_tool_contract_digest(),
                context_ref: corpus_previous_context_ref(),
            }),
        ),
    );
    corpus.insert(
        "authorizationLeaseRevoked",
        corpus_fact(
            "fact-lease-revoked-golden-1",
            55,
            25,
            25,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::LeaseRevoked {
                identity: corpus_lease_identity(
                    1,
                    "planned-operation-golden-output",
                    "preview-golden-output-1",
                    "fact-user-revoked-golden-1",
                ),
                scope_digest: corpus_lease(1).scope_digest,
                reason: CapabilityLeaseRevokeReasonV2::UserRevoked,
            }),
        ),
    );
    corpus.insert(
        "authorizationLeaseSuperseded",
        corpus_fact(
            "fact-lease-superseded-golden-1",
            56,
            26,
            26,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::LeaseSuperseded {
                identity: corpus_lease_identity(
                    2,
                    "planned-operation-golden-output",
                    "preview-golden-output-1",
                    "fact-epoch-advanced-golden-2",
                ),
                scope_digest: corpus_lease(2).scope_digest,
                reason: CapabilityLeaseSupersessionReasonV2::ControlEpochAdvanced,
            }),
        ),
    );
    corpus.insert(
        "authorizationCapabilityAwaiting",
        corpus_fact(
            "fact-capability-awaiting-golden-1",
            34,
            4,
            4,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityAwaiting {
                identity: CapabilityAwaitingIdentityV2 {
                    run_id: run_id("run-1"),
                    control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
                    plan_revision: PlanRevisionV2::new("plan-revision-golden-1")
                        .expect("valid plan revision"),
                    plan_action_id: PlanActionIdV2::new("plan-action-golden-1")
                        .expect("valid plan action"),
                    operation_id: operation_id(
                        "operation-c4cbe96134b04cf4963b4f50d5672870167c9dd3826e9aca6a3ce3a468367e64",
                    ),
                    invocation_id: InvocationId::new("invocation-golden-expanded-1")
                        .expect("valid invocation id"),
                    idempotency_key_hash: IdempotencyKeyHashV2::parse(digest_text('5'))
                        .expect("valid idempotency hash"),
                    causation_fact_id: fact_id("fact-tool-intent-command-golden-1"),
                    correlation_set: corpus_correlation_set(),
                },
                preview_id: CapabilityScopePreviewIdV2::new(
                    "preview-golden-expanded-allow-1",
                )
                    .expect("valid preview id"),
                tool_id: ToolIdV2::parse("fs.write").expect("valid tool id"),
                canonical_arguments_digest: corpus_expanded_canonical_arguments_digest(),
                scope_digest: corpus_expanded_allow_preview().scope_digest,
                tool_contract_digest: corpus_write_tool_contract_digest(),
                context_ref: corpus_previous_context_ref(),
            }),
        ),
    );
    corpus.insert(
        "authorizationExpansionAllowed",
        corpus_fact(
            "fact-expansion-allowed-golden-1",
            35,
            5,
            5,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::ExpansionAllowed {
                identity: corpus_lease_identity(
                    2,
                    "operation-c4cbe96134b04cf4963b4f50d5672870167c9dd3826e9aca6a3ce3a468367e64",
                    "preview-golden-expanded-allow-1",
                    "fact-user-expanded-golden-1",
                ),
                previous_lease_id: CapabilityLeaseIdV2::new("lease-golden-1")
                    .expect("valid previous lease id"),
                previous_scope_digest: corpus_lease(1).scope_digest,
                expanded_scope_digest: corpus_lease(2).scope_digest,
                authorization_digest: corpus_expanded_allow_preview().authorization_digest,
            }),
        ),
    );
    corpus.insert(
        "authorizationCapabilityIssuedDeny",
        corpus_fact(
            "fact-capability-issued-deny-golden-1",
            36,
            6,
            6,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityIssued {
                identity: CapabilityLeaseFactIdentityV2 {
                    run_id: run_id("run-1"),
                    control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
                    plan_revision: PlanRevisionV2::new("plan-revision-golden-deny-1")
                        .expect("valid plan revision"),
                    plan_action_id: PlanActionIdV2::new("plan-action-golden-deny-1")
                        .expect("valid plan action"),
                    operation_id: operation_id("planned-operation-golden-deny-output"),
                    preview_id: CapabilityScopePreviewIdV2::new("preview-golden-deny-output-1")
                        .expect("valid preview id"),
                    lease_id: CapabilityLeaseIdV2::new("lease-golden-deny-1")
                        .expect("valid lease id"),
                    lease_version: CapabilityLeaseVersionV2::new(1).expect("valid lease version"),
                    causation_fact_id: fact_id("fact-user-allowed-deny-golden-1"),
                    correlation_set: CorrelationSetV2::materialize(vec![
                        CorrelationRefV2::PlanAction {
                            value: "plan-action-golden-deny-1".to_owned(),
                        },
                    ])
                    .expect("valid deny correlation set"),
                },
                tool_id: ToolIdV2::parse("fs.write").expect("valid tool id"),
                scope_digest: corpus_deny_normal_preview().scope_digest,
                authorization_digest: corpus_deny_normal_preview().authorization_digest,
                tool_contract_digest: corpus_write_tool_contract_digest(),
                context_ref: corpus_previous_context_ref(),
            }),
        ),
    );
    corpus.insert(
        "authorizationCapabilityAwaitingDeny",
        corpus_fact(
            "fact-capability-awaiting-deny-golden-1",
            37,
            7,
            7,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityAwaiting {
                identity: CapabilityAwaitingIdentityV2 {
                    run_id: run_id("run-1"),
                    control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
                    plan_revision: PlanRevisionV2::new("plan-revision-golden-deny-1")
                        .expect("valid plan revision"),
                    plan_action_id: PlanActionIdV2::new("plan-action-golden-deny-1")
                        .expect("valid plan action"),
                    operation_id: operation_id(
                        "operation-9bf7e05374580c4630967e5c9a584a26f5884d63df3fba7ff17338c2da906bb6",
                    ),
                    invocation_id: InvocationId::new("invocation-golden-expanded-deny-1")
                        .expect("valid invocation id"),
                    idempotency_key_hash: IdempotencyKeyHashV2::parse(digest_text('5'))
                        .expect("valid idempotency hash"),
                    causation_fact_id: fact_id("fact-tool-intent-command-deny-golden-1"),
                    correlation_set: CorrelationSetV2::materialize(vec![
                        CorrelationRefV2::PlanAction {
                            value: "plan-action-golden-deny-1".to_owned(),
                        },
                    ])
                    .expect("valid deny correlation set"),
                },
                preview_id: CapabilityScopePreviewIdV2::new(
                    "preview-golden-expanded-deny-1",
                )
                .expect("valid preview id"),
                tool_id: ToolIdV2::parse("fs.write").expect("valid tool id"),
                canonical_arguments_digest: corpus_expanded_canonical_arguments_digest(),
                scope_digest: corpus_expanded_deny_preview().scope_digest,
                tool_contract_digest: corpus_write_tool_contract_digest(),
                context_ref: corpus_previous_context_ref(),
            }),
        ),
    );
    corpus.insert(
        "authorizationExpansionDenied",
        corpus_fact(
            "fact-expansion-denied-golden-1",
            38,
            8,
            8,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::ExpansionDenied {
                identity: AuthorizationIdentityV2 {
                    run_id: run_id("run-1"),
                    control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
                    plan_revision: PlanRevisionV2::new("plan-revision-golden-deny-1")
                        .expect("valid plan revision"),
                    plan_action_id: PlanActionIdV2::new("plan-action-golden-deny-1")
                        .expect("valid plan action"),
                    operation_id: operation_id(
                        "operation-9bf7e05374580c4630967e5c9a584a26f5884d63df3fba7ff17338c2da906bb6",
                    ),
                    causation_fact_id: fact_id("fact-user-denied-golden-1"),
                    correlation_set: CorrelationSetV2::materialize(vec![
                        CorrelationRefV2::PlanAction {
                            value: "plan-action-golden-deny-1".to_owned(),
                        },
                    ])
                    .expect("valid deny correlation set"),
                },
                preview_id: CapabilityScopePreviewIdV2::new(
                    "preview-golden-expanded-deny-1",
                )
                    .expect("valid preview id"),
                requested_scope_digest: corpus_expanded_deny_preview().scope_digest,
                authorization_digest: corpus_expanded_deny_preview().authorization_digest,
                guidance:
                    "User denied scope expansion; re-plan within the approved workspace scope."
                        .to_owned(),
            }),
        ),
    );
    corpus.insert(
        "authorizationContextInvalidated",
        corpus_fact(
            "fact-context-invalidated-golden-1",
            48,
            18,
            18,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::ContextInvalidated {
                identity: ToolContextInvalidationIdentityV2 {
                    run_id: run_id("run-1"),
                    control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
                    causation_fact_id: fact_id("fact-tool-revoked-golden-1"),
                },
                previous_context: corpus_previous_context_ref(),
                next_context_version: corpus_context_ref().context_version,
                next_context_ref: corpus_context_ref(),
                settings_ceiling_digest: SettingsCeilingDigestV2::parse(digest_text('e'))
                    .expect("valid settings ceiling digest"),
                tool_id: Some(ToolIdV2::parse("fs.write").expect("valid tool id")),
                availability: Some(ToolAvailabilityV2::Revoked),
                reason: ToolContextInvalidationReasonV2::ToolRevoked,
            }),
        ),
    );
    corpus.insert(
        "invocationToolIntentAdmitted",
        corpus_fact(
            "fact-tool-intent-admitted-golden-1",
            39,
            9,
            9,
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolIntentAdmitted {
                identity: corpus_attempt_identity(
                    "operation-golden-output",
                    "invocation-golden-output-1",
                    "attempt-golden-output-1",
                    1,
                    "fact-capability-issued-golden-1",
                ),
                tool_id: ToolIdV2::parse("fs.write").expect("valid tool id"),
                canonical_arguments_digest: corpus_normal_canonical_arguments_digest(),
                tool_contract_digest: corpus_write_tool_contract_digest(),
                resource_scope: ResourceScopeV2::Workspace {
                    targets: vec![WorkspaceScopeTargetV2 {
                        relative_path: "output.txt".to_owned(),
                        object_kind: WorkspaceObjectKindV2::File,
                        access: ResourceAccessV2::Write,
                        target_observation_digest: ResourceStateDigestV2::parse(digest_text('9'))
                            .expect("valid target observation digest"),
                    }],
                },
                workspace_binding_digest: WorkspaceBindingDigestV2::parse(digest_text('d'))
                    .expect("valid workspace binding digest"),
                effective_deadline_ms: 10_000,
            }),
        ),
    );
    let mutation_evidence = EffectEvidenceV2::MutationReadBack {
        before_digest: ResourceStateDigestV2::parse(digest_text('9'))
            .expect("valid before-state digest"),
        after_digest: ResourceStateDigestV2::parse(digest_text('0'))
            .expect("valid after-state digest"),
        target_kind: WorkspaceObjectKindV2::File,
    };
    corpus.insert(
        "effectToolObserved",
        corpus_fact(
            "fact-effect-observed-corpus-golden-1",
            40,
            10,
            10,
            KernelFactPayloadV2::Effect(EffectFactV2::ToolObserved {
                identity: corpus_effect_identity(
                    "operation-golden-output",
                    "invocation-golden-output-1",
                    "attempt-golden-output-1",
                    "effect-golden-output-1",
                    1,
                    "fact-normal-execution-started-golden-1",
                ),
                affected_resource_ids: vec![
                    ResourceId::new("resource-golden-output").expect("valid resource id")
                ],
                evidence: mutation_evidence.clone(),
                evidence_digest: executor_evidence_digest_v2(&mutation_evidence)
                    .expect("materialize mutation evidence digest"),
            }),
        ),
    );
    corpus.insert(
        "invocationToolCompleted",
        corpus_fact(
            "fact-tool-completed-corpus-golden-1",
            41,
            11,
            11,
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCompleted {
                identity: corpus_terminal_identity(
                    "operation-golden-output",
                    "invocation-golden-output-1",
                    "attempt-golden-output-1",
                    "effect-golden-output-1",
                    1,
                    "fact-effect-observed-corpus-golden-1",
                ),
                output: serde_json::json!({
                    "bytesWritten": 15,
                    "path": "output.txt"
                }),
            }),
        ),
    );
    corpus.insert(
        "invocationToolIndeterminate",
        corpus_fact(
            "fact-tool-indeterminate-corpus-golden-1",
            42,
            12,
            12,
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolIndeterminate {
                identity: corpus_terminal_identity(
                    "operation-golden-indeterminate",
                    "invocation-golden-indeterminate-1",
                    "attempt-golden-indeterminate-1",
                    "effect-golden-indeterminate-1",
                    1,
                    "fact-effect-indeterminate-golden-1",
                ),
                reason_code: IndeterminateReasonV2::RecoveryEvidenceInsufficient,
            }),
        ),
    );
    corpus.insert(
        "invocationExpandedToolIntentAdmitted",
        corpus_fact(
            "fact-expanded-tool-intent-admitted-golden-1",
            43,
            13,
            13,
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolIntentAdmitted {
                identity: corpus_attempt_identity(
                    "operation-c4cbe96134b04cf4963b4f50d5672870167c9dd3826e9aca6a3ce3a468367e64",
                    "invocation-golden-expanded-1",
                    "attempt-golden-expanded-2",
                    2,
                    "fact-expansion-allowed-golden-1",
                ),
                tool_id: ToolIdV2::parse("fs.write").expect("valid tool id"),
                canonical_arguments_digest: corpus_expanded_canonical_arguments_digest(),
                tool_contract_digest: corpus_write_tool_contract_digest(),
                resource_scope: ResourceScopeV2::Workspace {
                    targets: vec![WorkspaceScopeTargetV2 {
                        relative_path: "expanded.txt".to_owned(),
                        object_kind: WorkspaceObjectKindV2::File,
                        access: ResourceAccessV2::Write,
                        target_observation_digest: ResourceStateDigestV2::parse(digest_text('7'))
                            .expect("valid target observation digest"),
                    }],
                },
                workspace_binding_digest: WorkspaceBindingDigestV2::parse(digest_text('d'))
                    .expect("valid workspace binding digest"),
                effective_deadline_ms: 10_000,
            }),
        ),
    );
    let expanded_mutation_evidence = EffectEvidenceV2::MutationReadBack {
        before_digest: ResourceStateDigestV2::parse(digest_text('7'))
            .expect("valid expanded before-state digest"),
        after_digest: ResourceStateDigestV2::parse(digest_text('8'))
            .expect("valid expanded after-state digest"),
        target_kind: WorkspaceObjectKindV2::File,
    };
    corpus.insert(
        "effectExpandedToolObserved",
        corpus_fact(
            "fact-expanded-effect-observed-golden-1",
            44,
            14,
            14,
            KernelFactPayloadV2::Effect(EffectFactV2::ToolObserved {
                identity: corpus_effect_identity(
                    "operation-c4cbe96134b04cf4963b4f50d5672870167c9dd3826e9aca6a3ce3a468367e64",
                    "invocation-golden-expanded-1",
                    "attempt-golden-expanded-2",
                    "effect-golden-expanded-1",
                    2,
                    "fact-expanded-execution-started-golden-1",
                ),
                affected_resource_ids: vec![
                    ResourceId::new("resource-golden-expanded").expect("valid resource id")
                ],
                evidence: expanded_mutation_evidence.clone(),
                evidence_digest: executor_evidence_digest_v2(&expanded_mutation_evidence)
                    .expect("materialize expanded mutation evidence digest"),
            }),
        ),
    );
    corpus.insert(
        "invocationExpandedToolCompleted",
        corpus_fact(
            "fact-expanded-tool-completed-golden-1",
            45,
            15,
            15,
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCompleted {
                identity: corpus_terminal_identity(
                    "operation-c4cbe96134b04cf4963b4f50d5672870167c9dd3826e9aca6a3ce3a468367e64",
                    "invocation-golden-expanded-1",
                    "attempt-golden-expanded-2",
                    "effect-golden-expanded-1",
                    2,
                    "fact-expanded-effect-observed-golden-1",
                ),
                output: serde_json::json!({
                    "bytesWritten": 8,
                    "path": "expanded.txt"
                }),
            }),
        ),
    );
    corpus.insert(
        "invocationContextReadAdmitted",
        corpus_fact(
            "fact-context-read-admitted-golden-1",
            49,
            19,
            19,
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolIntentAdmitted {
                identity: corpus_context_read_attempt_identity(
                    "fact-context-read-command-golden-1",
                ),
                tool_id: ToolIdV2::parse("fs.read").expect("valid tool id"),
                canonical_arguments_digest: corpus_context_read_canonical_arguments_digest(),
                tool_contract_digest: corpus_context_read_tool_contract_digest(),
                resource_scope: ResourceScopeV2::Workspace {
                    targets: vec![WorkspaceScopeTargetV2 {
                        relative_path: "README.md".to_owned(),
                        object_kind: WorkspaceObjectKindV2::File,
                        access: ResourceAccessV2::Read,
                        target_observation_digest: ResourceStateDigestV2::parse(digest_text('9'))
                            .expect("valid target observation digest"),
                    }],
                },
                workspace_binding_digest: WorkspaceBindingDigestV2::parse(digest_text('d'))
                    .expect("valid workspace binding digest"),
                effective_deadline_ms: 10_000,
            }),
        ),
    );
    let context_read_content = b"DeepCode golden README\n";
    let context_read_evidence = EffectEvidenceV2::ContentRead {
        content_digest: content_digest_v2(context_read_content),
        byte_length: context_read_content.len() as u64,
    };
    corpus.insert(
        "effectContextReadObserved",
        corpus_fact(
            "fact-context-read-effect-observed-golden-1",
            50,
            20,
            20,
            KernelFactPayloadV2::Effect(EffectFactV2::ToolObserved {
                identity: corpus_context_read_effect_identity(),
                affected_resource_ids: vec![
                    ResourceId::new("resource-01-readme").expect("valid resource id")
                ],
                evidence: context_read_evidence.clone(),
                evidence_digest: executor_evidence_digest_v2(&context_read_evidence)
                    .expect("materialize context-read evidence digest"),
            }),
        ),
    );
    corpus.insert(
        "invocationContextReadCompleted",
        corpus_fact(
            "fact-context-read-completed-golden-1",
            51,
            21,
            21,
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCompleted {
                identity: corpus_context_read_terminal_identity(),
                output: serde_json::json!({
                    "bytesRead": 23,
                    "path": "README.md"
                }),
            }),
        ),
    );
    corpus.insert(
        "invocationMutationContextReadAdmitted",
        corpus_fact(
            "fact-mutation-context-read-admitted-golden-1",
            54,
            24,
            24,
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolIntentAdmitted {
                identity: corpus_mutation_context_read_attempt_identity(
                    "fact-mutation-context-read-command-golden-1",
                ),
                tool_id: ToolIdV2::parse("fs.read").expect("valid tool id"),
                canonical_arguments_digest: corpus_context_read_canonical_arguments_digest(),
                tool_contract_digest: corpus_context_read_tool_contract_digest(),
                resource_scope: ResourceScopeV2::Workspace {
                    targets: vec![WorkspaceScopeTargetV2 {
                        relative_path: "README.md".to_owned(),
                        object_kind: WorkspaceObjectKindV2::File,
                        access: ResourceAccessV2::Read,
                        target_observation_digest: ResourceStateDigestV2::parse(digest_text('9'))
                            .expect("valid target observation digest"),
                    }],
                },
                workspace_binding_digest: WorkspaceBindingDigestV2::parse(digest_text('d'))
                    .expect("valid workspace binding digest"),
                effective_deadline_ms: 10_000,
            }),
        ),
    );
    corpus.insert(
        "effectMutationContextReadObserved",
        corpus_fact(
            "fact-mutation-context-read-effect-observed-golden-1",
            55,
            25,
            25,
            KernelFactPayloadV2::Effect(EffectFactV2::ToolObserved {
                identity: corpus_mutation_context_read_effect_identity(),
                affected_resource_ids: vec![
                    ResourceId::new("resource-01-readme").expect("valid resource id")
                ],
                evidence: context_read_evidence.clone(),
                evidence_digest: executor_evidence_digest_v2(&context_read_evidence)
                    .expect("materialize mutation-context read evidence digest"),
            }),
        ),
    );
    corpus.insert(
        "invocationMutationContextReadCompleted",
        corpus_fact(
            "fact-mutation-context-read-completed-golden-1",
            56,
            26,
            26,
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCompleted {
                identity: corpus_mutation_context_read_terminal_identity(),
                output: serde_json::json!({
                    "bytesRead": 23,
                    "path": "README.md"
                }),
            }),
        ),
    );
    let cleanup_identity = CleanupIdentityV2 {
        run_id: run_id("run-1"),
        control_epoch: ControlEpoch::new(1).expect("valid corpus epoch"),
        operation_id: operation_id("operation-golden-output"),
        invocation_id: InvocationId::new("invocation-golden-output-1")
            .expect("valid invocation id"),
        attempt_id: AttemptId::new("attempt-golden-output-1").expect("valid attempt id"),
        resource_id: ResourceId::new("resource-golden-output").expect("valid resource id"),
        cleanup_id: CleanupId::new("cleanup-golden-output-1").expect("valid cleanup id"),
        causation_fact_id: fact_id("fact-tool-completed-corpus-golden-1"),
    };
    corpus.insert(
        "cleanupScheduled",
        corpus_fact(
            "fact-cleanup-scheduled-golden-1",
            46,
            16,
            16,
            KernelFactPayloadV2::Cleanup(CleanupFactV2::Scheduled {
                identity: cleanup_identity.clone(),
            }),
        ),
    );
    corpus.insert(
        "cleanupCompleted",
        corpus_fact(
            "fact-cleanup-completed-golden-1",
            47,
            17,
            17,
            KernelFactPayloadV2::Cleanup(CleanupFactV2::Completed {
                identity: CleanupIdentityV2 {
                    causation_fact_id: fact_id("fact-cleanup-scheduled-golden-1"),
                    ..cleanup_identity
                },
                cleanup_attempt: 1,
            }),
        ),
    );
    corpus
}

fn golden_read_tool_descriptor() -> ToolDescriptorV2 {
    ToolDescriptorV2::materialize(
        ToolIdV2::parse("fs.read").expect("valid tool id"),
        "Read one UTF-8 file inside the bound workspace.".to_owned(),
        ToolInputSchemaV2::new(serde_json::json!({
            "additionalProperties": false,
            "properties": {
                "path": {
                    "type": "string"
                }
            },
            "required": ["path"],
            "type": "object"
        }))
        .expect("valid input schema"),
        "Read one workspace-relative path and return its current UTF-8 contents.".to_owned(),
        ToolAvailabilityV2::Ready,
        ToolEffectClassV2::Read,
        ToolEffectScopeV2::WorkspaceRead,
        ToolRiskV2::Low,
        ToolAuthorizationShapeV2::ResourceScope,
    )
    .expect("materialize the ready read tool")
}

fn golden_write_tool_descriptor() -> ToolDescriptorV2 {
    ToolDescriptorV2::materialize(
        ToolIdV2::parse("fs.write").expect("valid tool id"),
        "Write one UTF-8 file inside the bound workspace.".to_owned(),
        ToolInputSchemaV2::new(serde_json::json!({
            "additionalProperties": false,
            "properties": {
                "content": {
                    "type": "string"
                },
                "path": {
                    "type": "string"
                }
            },
            "required": ["path", "content"],
            "type": "object"
        }))
        .expect("valid input schema"),
        "Write one workspace-relative path with the exact supplied UTF-8 contents.".to_owned(),
        ToolAvailabilityV2::Ready,
        ToolEffectClassV2::Mutation,
        ToolEffectScopeV2::WorkspaceWrite,
        ToolRiskV2::Medium,
        ToolAuthorizationShapeV2::ResourceScope,
    )
    .expect("materialize the ready write tool")
}

fn materialize_golden_tool_context(
    context_version: u64,
    tools: Vec<ToolDescriptorV2>,
) -> ToolContextBundleV2 {
    let context_version =
        ToolContextVersionV2::new(context_version).expect("valid context version");
    let catalog_digest = tool_catalog_digest_v2(&[
        golden_read_tool_descriptor(),
        golden_write_tool_descriptor(),
    ])
    .expect("materialize complete inventory catalog digest");
    let fixed_prompt = render_kernel_tool_prompt_v2(&tools).expect("render Kernel prompt");
    let context_digest =
        tool_context_digest_v2(context_version, &catalog_digest, &fixed_prompt, &tools)
            .expect("materialize context digest");
    let context = ToolContextBundleV2 {
        format_version: TOOL_CONTEXT_FORMAT_V2.to_owned(),
        context_version,
        catalog_digest,
        context_digest,
        fixed_prompt,
        tools,
    };
    context.validate().expect("valid Kernel ToolContext");
    context
}

fn golden_mutation_tool_context() -> ToolContextBundleV2 {
    materialize_golden_tool_context(
        3,
        vec![
            golden_read_tool_descriptor(),
            golden_write_tool_descriptor(),
        ],
    )
}

fn golden_tool_context() -> ToolContextBundleV2 {
    materialize_golden_tool_context(4, vec![golden_read_tool_descriptor()])
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
fn shared_kernel_session_v2_golden_vectors_decode_in_rust() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/kernel-session-v2/wire-golden.json"
    )))
    .expect("parse shared Kernel-Session v2 golden fixture");
    assert_eq!(
        fixture["schemaVersion"],
        "deepcode.kernel-session.wire-golden.v3"
    );

    let context_value = fixture["kernelToolContext"].clone();
    let context = golden_tool_context();
    assert_eq!(
        serde_json::to_value(&context).expect("encode Kernel-generated ToolContext"),
        context_value,
        "the shared ToolContext vector must be materialized by the real Rust ABI"
    );
    let decoded_context: ToolContextBundleV2 =
        serde_json::from_value(context_value.clone()).expect("decode shared ToolContext");
    decoded_context
        .validate()
        .expect("validate shared ToolContext");
    assert_eq!(
        serde_json::to_value(decoded_context).expect("re-encode shared ToolContext"),
        context_value
    );

    let mutation_context_value = fixture["kernelMutationToolContext"].clone();
    let mutation_context = golden_mutation_tool_context();
    assert_eq!(
        serde_json::to_value(&mutation_context).expect("encode mutation ToolContext"),
        mutation_context_value,
        "the shared v3 mutation ToolContext must be materialized by the real Rust ABI"
    );
    let decoded_mutation_context: ToolContextBundleV2 =
        serde_json::from_value(mutation_context_value.clone())
            .expect("decode shared mutation ToolContext");
    decoded_mutation_context
        .validate()
        .expect("validate shared mutation ToolContext");
    assert_eq!(
        decoded_mutation_context
            .tools
            .iter()
            .map(|tool| tool.tool_id.as_str())
            .collect::<Vec<_>>(),
        vec!["fs.read", "fs.write"]
    );

    let preview_values = fixture["kernelCapabilityPreviews"]
        .as_object()
        .expect("shared fixture must contain typed capability previews");
    let previews = kernel_capability_previews();
    assert_eq!(preview_values.len(), previews.len());
    for (key, preview) in previews {
        preview
            .validate()
            .unwrap_or_else(|error| panic!("validate capability preview {key}: {error}"));
        let expected = preview_values
            .get(key)
            .unwrap_or_else(|| panic!("shared fixture must contain capability preview {key}"));
        assert_eq!(
            serde_json::to_value(preview)
                .unwrap_or_else(|error| panic!("encode capability preview {key}: {error}")),
            *expected,
            "the shared capability preview {key} must be generated by the real Rust ABI"
        );
    }

    let command_value = fixture["sessionToKernelToolIntent"].clone();
    let command_bytes =
        serde_json::to_vec(&command_value).expect("serialize shared ToolIntent command");
    let command =
        decode_kernel_command_v2(&command_bytes).expect("decode shared ToolIntent command");
    assert!(matches!(
        command.command,
        KernelCommandV2::ToolIntentSubmit(_)
    ));
    let KernelCommandV2::ToolIntentSubmit(intent) = &command.command else {
        unreachable!("checked ToolIntent command")
    };
    assert_eq!(
        intent.tool_context_ref,
        context.context_ref(),
        "ToolIntent must bind the exact Kernel-generated ToolContext"
    );
    assert_eq!(
        serde_json::to_value(command).expect("re-encode shared ToolIntent command"),
        command_value
    );

    let fact_value = fixture["kernelToSessionFactProjection"].clone();
    let projected = KernelFactProjectionV2::from_envelope(&golden_tool_observed_fact())
        .expect("project the real Kernel fact used by the shared fixture");
    assert_eq!(
        serde_json::to_value(&projected).expect("encode Kernel-generated fact projection"),
        fact_value,
        "the shared Kernel-to-Session vector must be generated by the real Rust projection"
    );
    let fact: KernelFactProjectionV2 =
        serde_json::from_value(fact_value.clone()).expect("decode shared fact projection");
    fact.validate().expect("validate shared fact projection");
    assert_eq!(
        serde_json::to_value(fact).expect("re-encode shared fact projection"),
        fact_value
    );

    let corpus_value = fixture["kernelFactCorpus"]
        .as_object()
        .expect("shared fixture must contain a Kernel fact projection corpus");
    let corpus = kernel_fact_corpus();
    assert_eq!(
        corpus_value.len(),
        corpus.len(),
        "the shared fixture must not omit or add corpus fact templates"
    );
    for (key, envelope) in corpus {
        let projected = KernelFactProjectionV2::from_envelope(&envelope)
            .unwrap_or_else(|error| panic!("project real Kernel corpus fact {key}: {error}"));
        let expected = corpus_value
            .get(key)
            .unwrap_or_else(|| panic!("shared fixture must contain corpus fact {key}"));
        assert_eq!(
            serde_json::to_value(projected)
                .unwrap_or_else(|error| panic!("encode Kernel corpus fact {key}: {error}")),
            *expected,
            "the shared corpus fact {key} must be generated by the real Rust projection"
        );
    }
}

#[test]
fn terminal_tool_completed_projection_retains_observed_effect_lineage() {
    let projected = KernelFactProjectionV2::from_envelope(&golden_tool_completed_fact())
        .expect("project terminal ToolCompleted fact");
    assert_eq!(
        projected.lineage.effect_id.as_ref().map(EffectId::as_str),
        Some("effect-golden-readme-1")
    );
    assert_eq!(
        projected.details["identity"]["causationFactId"],
        "fact-effect-observed-golden-1"
    );
}

#[test]
fn v2_public_wire_numbers_fail_closed_above_the_safe_integer_boundary() {
    let maximum = MAX_CROSS_LANGUAGE_SAFE_INTEGER_V2;
    let above_maximum = maximum + 1;

    assert_eq!(
        ControlEpoch::new(maximum)
            .expect("maximum safe epoch")
            .get(),
        maximum
    );
    assert!(ControlEpoch::new(above_maximum).is_err());
    assert_eq!(
        ToolContextVersionV2::new(maximum)
            .expect("maximum safe context version")
            .get(),
        maximum
    );
    assert!(ToolContextVersionV2::new(above_maximum).is_err());
    assert_eq!(
        CapabilityLeaseVersionV2::new(maximum)
            .expect("maximum safe lease version")
            .get(),
        maximum
    );
    assert!(CapabilityLeaseVersionV2::new(above_maximum).is_err());

    let query = KernelFactsQueryScopedV2 {
        run_id: run_id("run-safe-number-query"),
        after_ledger_sequence: maximum,
        limit: 1,
        continuation: None,
    };
    query.validate().expect("maximum safe facts cursor");
    let mut unsafe_query = query;
    unsafe_query.after_ledger_sequence = above_maximum;
    assert!(unsafe_query.validate().is_err());

    let mut envelope = golden_tool_completed_fact();
    envelope.ledger_sequence = maximum;
    envelope.run_sequence = maximum;
    envelope
        .validate()
        .expect("maximum safe fact envelope sequences");
    envelope.ledger_sequence = above_maximum;
    assert!(envelope.validate().is_err());
    envelope.ledger_sequence = maximum;
    envelope.run_sequence = above_maximum;
    assert!(envelope.validate().is_err());

    let mut unsafe_payload = golden_tool_completed_fact().payload;
    let KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCompleted { output, .. }) =
        &mut unsafe_payload
    else {
        panic!("golden terminal fact must contain ToolCompleted");
    };
    *output = serde_json::json!({
        "nested": {
            "count": maximum
        }
    });
    unsafe_payload
        .validate()
        .expect("maximum safe nested fact payload number");
    let KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCompleted { output, .. }) =
        &mut unsafe_payload
    else {
        panic!("golden terminal fact must contain ToolCompleted");
    };
    *output = serde_json::json!({
        "nested": {
            "count": above_maximum
        }
    });
    assert!(unsafe_payload.validate().is_err());

    let mut projection = KernelFactProjectionV2::from_envelope(&golden_tool_completed_fact())
        .expect("project safe terminal fact");
    projection.details = serde_json::json!({
        "nested": {
            "count": maximum
        }
    });
    projection
        .validate()
        .expect("maximum safe nested projection number");
    projection.details = serde_json::json!({
        "nested": {
            "count": above_maximum
        }
    });
    assert!(projection.validate().is_err());

    let page = KernelFactProjectionPageV2 {
        requested_after_ledger_sequence: maximum,
        snapshot_high_water: maximum,
        facts: Vec::new(),
        has_more: false,
        next_after_ledger_sequence: maximum,
        next_continuation: None,
    };
    page.validate().expect("maximum safe facts page cursors");
    let mut unsafe_page = page;
    unsafe_page.snapshot_high_water = above_maximum;
    assert!(unsafe_page.validate().is_err());
    assert!(KernelReplyV2::KernelFactsProjected(unsafe_page)
        .validate()
        .is_err());

    let decision_reply = UserDecisionReplyV2::CapabilityDenied {
        fact_id: fact_id("fact-decision-safe-boundary"),
        ledger_sequence: maximum,
    };
    decision_reply
        .validate()
        .expect("maximum safe user-decision fact sequence");
    let unsafe_decision_reply = UserDecisionReplyV2::CapabilityDenied {
        fact_id: fact_id("fact-decision-unsafe-boundary"),
        ledger_sequence: above_maximum,
    };
    assert!(unsafe_decision_reply.validate().is_err());
    let zero_decision_reply = UserDecisionReplyV2::CapabilityDenied {
        fact_id: fact_id("fact-decision-zero-sequence"),
        ledger_sequence: 0,
    };
    assert!(zero_decision_reply.validate().is_err());
    let unsafe_decision_response = UserDecisionResponseEnvelopeV2::Correlated {
        server_abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
        request_id: CommandRequestId::new("request-decision-unsafe-boundary")
            .expect("valid request id"),
        handling: CommandHandlingV2::Evaluated,
        reply: unsafe_decision_reply,
    };
    assert!(unsafe_decision_response.validate().is_err());
    if let Ok(maximum_bytes) = usize::try_from(above_maximum) {
        let unsafe_wire_response = UserDecisionResponseEnvelopeV2::UncorrelatedWireFailure {
            server_abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
            error: KernelWireErrorV2::PayloadTooLarge { maximum_bytes },
        };
        assert!(unsafe_wire_response.validate().is_err());
    }

    let zero_cancel_reply = deepcode_kernel_abi::v2_command::InvocationCancelReplyV2::Requested {
        cancel_request_id: CancelRequestId::new("cancel-zero-sequence")
            .expect("valid cancellation request id"),
        invocation_id: InvocationId::new("invocation-zero-sequence").expect("valid invocation id"),
        fact_id: fact_id("fact-cancel-zero-sequence"),
        ledger_sequence: 0,
    };
    assert!(KernelReplyV2::InvocationCancelResult(zero_cancel_reply)
        .validate()
        .is_err());

    let zero_rejection_reply = ToolIntentSubmitReplyV2::Rejected {
        run_id: run_id("run-zero-rejection-sequence"),
        operation_id: operation_id("operation-zero-rejection-sequence"),
        current_control_epoch: ControlEpoch::new(1).expect("valid rejection epoch"),
        reason: ToolIntentRejectionReasonV2::InvalidArguments,
        guidance: "Use valid tool arguments.".to_owned(),
        rejection_fact_id: fact_id("fact-zero-rejection-sequence"),
        rejection_batch_high_water: 0,
    };
    assert!(KernelReplyV2::ToolIntentSubmission(zero_rejection_reply)
        .validate()
        .is_err());

    let awaiting_preview = corpus_expanded_allow_preview();
    let awaiting_reply = ToolIntentSubmitReplyV2::AwaitingCapability {
        run_id: awaiting_preview.run_id.clone(),
        operation_id: awaiting_preview.operation_id.clone(),
        accepted_control_epoch: awaiting_preview.control_epoch,
        invocation_id: InvocationId::new("invocation-awaiting-capability")
            .expect("valid awaiting invocation id"),
        preview: awaiting_preview.clone(),
        awaiting_fact_id: fact_id("fact-awaiting-capability"),
        awaiting_batch_high_water: 1,
    };
    awaiting_reply
        .validate()
        .expect("AwaitingCapability reply must bind its preview identity");
    let mut mismatched_awaiting_run = awaiting_reply.clone();
    let ToolIntentSubmitReplyV2::AwaitingCapability {
        run_id: reply_run_id,
        ..
    } = &mut mismatched_awaiting_run
    else {
        unreachable!("constructed AwaitingCapability reply");
    };
    *reply_run_id = run_id("run-awaiting-mismatch");
    assert!(mismatched_awaiting_run.validate().is_err());
    let mut mismatched_awaiting_operation = awaiting_reply.clone();
    let ToolIntentSubmitReplyV2::AwaitingCapability {
        operation_id: reply_operation_id,
        ..
    } = &mut mismatched_awaiting_operation
    else {
        unreachable!("constructed AwaitingCapability reply");
    };
    *reply_operation_id = operation_id("operation-awaiting-mismatch");
    assert!(mismatched_awaiting_operation.validate().is_err());
    let mut mismatched_awaiting_epoch = awaiting_reply;
    let ToolIntentSubmitReplyV2::AwaitingCapability {
        accepted_control_epoch,
        ..
    } = &mut mismatched_awaiting_epoch
    else {
        unreachable!("constructed AwaitingCapability reply");
    };
    *accepted_control_epoch = ControlEpoch::new(2).expect("valid mismatched awaiting epoch");
    assert!(mismatched_awaiting_epoch.validate().is_err());

    let zero_epoch_reply = deepcode_kernel_abi::v2_command::ControlEpochAdvancedReplyV2 {
        run_id: run_id("run-zero-epoch-high-water"),
        accepted_control_epoch: ControlEpoch::new(2).expect("valid advanced epoch"),
        epoch_fact_id: fact_id("fact-zero-epoch-high-water"),
        superseded_capability_count: 0,
        cancellation: deepcode_kernel_abi::v2_command::ControlCancellationReplyV2::None {},
        command_batch_high_water: 0,
    };
    assert!(KernelReplyV2::ControlEpochAdvanced(zero_epoch_reply)
        .validate()
        .is_err());
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
