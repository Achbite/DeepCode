use super::authority::{
    canonicalize_network_scope_url, invalid_field, prepare_failure_error,
    resolve_workspace_binding, storage_fault,
};
use super::model::{AuthorityResult, AuthorizationTargetKey};
use super::service::{
    initial_run_transport_generation, run_capability_verifier_digest, AuthorityService,
    DirectToolIntentRequest, DurableRunCapabilityVerifierV2, InitialToolContextInvalidationV2,
    AUTHORITY_MATERIAL_RETIREMENT_PENDING, RUN_CAPABILITY_VERIFIER_BOUND,
    RUN_CAPABILITY_VERIFIER_MATERIAL_KIND,
};
use crate::executors::{KernelExecutorConfig, SecretProvider};
use deepcode_kernel_abi::v2::{
    command_request_digest_v2, idempotency_key_hash_v2, invocation_policy_evaluation_digest_v2,
    settings_ceiling_digest_v2, validate_cross_language_safe_json_value_v2,
    validate_cross_language_safe_u64_v2, AuthorizationFactV2, AuthorizationIdentityV2,
    CapabilityAwaitingIdentityV2, CapabilityLeaseFactIdentityV2, CapabilityLeaseRevokeReasonV2,
    CommandEpochContextV2, CommandReceiptIdentityV2, CommandRequestDigestV2, CommandRequestId,
    CommandRequestIdentityV2, ControlEpoch, ControlFactV2, CorrelationRefV2, CorrelationSetV2,
    FactId, InputId, InvocationAuthorityV2, InvocationFactV2, InvocationId, KernelFactEnvelopeV2,
    KernelFactPayloadV2, MutationCommandResultV2, OperationId, RecordedAtV2, ResourceScopeV2,
    RunId, RunRetirementReasonCodeV2, SettingsCeilingDigestV2, ToolContextInvalidationIdentityV2,
    ToolContextInvalidationReasonV2, UserDecisionRefV2, WorkspaceBindingDigestV2,
    WorkspaceScopeTargetV2,
};
use deepcode_kernel_abi::v2_command::{
    CapabilityApprovalViewV2, CapabilityResourcePresentationKindV2,
    CapabilityResourcePresentationV2, CapabilityScopeDispositionV2,
    CapabilityScopePreviewBatchReplyV2, CapabilityScopePreviewBatchV2,
    CapabilityScopePreviewRecordV2, CapabilityScopePreviewReplyV2,
    CapabilityScopeRejectionReasonV2, CommandHandlingV2, ControlEpochAdvanceV2, DeadlineRequestV2,
    EpochPreconditionV2, InvalidFieldViolationV2, InvalidRelationV2, InvalidRequestReasonV2,
    KernelCommandEnvelopeV2, KernelCommandResponseEnvelopeV2, KernelCommandV2, KernelErrorV2,
    KernelFactProjectionPageV2, KernelFactProjectionV2, KernelFactsQueryScopedV2, KernelReplyV2,
    MutationCommandKindV2, RunOpenReplyV2, RunOpenV2, ToolContextGetReplyV2, ToolContextGetV2,
    ToolIntentRejectionReasonV2, ToolIntentSubmitReplyV2, ToolIntentSubmitV2,
};
use deepcode_kernel_abi::KernelError as AbiKernelError;
use deepcode_kernel_abi::{
    canonical_arguments_digest_v2, capability_authorization_digest_v2, capability_scope_digest_v2,
    exact_invocation_digest_v2, render_kernel_tool_prompt_v2, tool_context_digest_v2,
    tool_contract_digest_v2, trust_lease_digest_v2, user_decision_request_digest_v2,
    CapabilityAuthorizationBindingV2, CapabilityAuthorizationDigestV2, CapabilityDecisionBindingV2,
    CapabilityLeaseIdV2, CapabilityLeaseRefV2, CapabilityLeaseVersionV2, CapabilityScopeDigestV2,
    CapabilityScopePreviewIdV2, PlanActionIdV2, PlanRevisionV2, RunCapabilityV2, ScopeIntentV2,
    ToolAuthorizationShapeV2, ToolAvailabilityV2, ToolContextBundleV2, ToolContextRefV2,
    ToolContextVersionV2, ToolDescriptorV2, ToolEffectClassV2, ToolEffectScopeV2, ToolIdV2,
    ToolIntentAuthorityV2, ToolInventoryV2, TrustGrantDecisionV2, TrustLeaseDigestV2,
    TrustPolicyIdV2, UserDecisionErrorV2, UserDecisionReplyV2, UserDecisionRevokeTargetV2,
    UserDecisionRevokeV2, UserDecisionV2, WorkspaceBindingRefV2, TOOL_CONTEXT_FORMAT_V2,
};
use deepcode_kernel_ledger::v2::CanonicalFactStore;
use deepcode_kernel_ledger::v2::{
    AuthorityMaterialDraftV2, AuthorityMaterialMutationV2, AuthorityMaterialRecordV2,
    ConsumeFactQueryContinuationOutcomeV2, FactQueryContinuationConsumerV2,
    FactQueryContinuationDraftV2, FactQueryContinuationExpectationV2, PublicCommandReceiptV2,
    PutFactQueryContinuationOutcomeV2, PutPublicCommandReceiptOutcomeV2,
};
use deepcode_kernel_tools::kernel_internal::KernelCanonicalInvocation;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const AUTHORITY_MATERIAL_PREVIEW: &str = "scopePreview";
const AUTHORITY_MATERIAL_LEASE: &str = "capabilityLease";
const AUTHORITY_MATERIAL_PENDING: &str = "pendingIntent";
const AUTHORITY_MATERIAL_INVOCATION: &str = "toolInvocation";
const AUTHORITY_MATERIAL_TRUST: &str = "trustLease";
const AUTHORITY_MATERIAL_ACTIVE: &str = "active";
const AUTHORITY_MATERIAL_AWAITING: &str = "awaiting";
const AUTHORITY_MATERIAL_ADMITTED: &str = "admitted";
const AUTHORITY_MATERIAL_REJECTED: &str = "rejected";
const AUTHORITY_MATERIAL_REVOKED: &str = "revoked";
const AUTHORITY_MATERIAL_STALE: &str = "stale";
const AUTHORITY_MATERIAL_TERMINAL: &str = "terminal";
const RUN_RETIREMENT_CONVERGENCE_BUDGET: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingsCeilingV2 {
    pub workspace_read: bool,
    pub workspace_write: bool,
    pub web_read: bool,
    pub auto_approve_plans: bool,
}

fn build_inventory() -> AuthorityResult<ToolInventoryV2> {
    crate::kernel_tool_registry()
        .tool_inventory_v2()
        .map_err(|_| storage_fault())
}

fn response(
    request_id: CommandRequestId,
    result: AuthorityResult<(KernelReplyV2, CommandHandlingV2)>,
) -> KernelCommandResponseEnvelopeV2 {
    let (mut reply, mut handling) = match result {
        Ok(value) => value,
        Err(error) => (KernelReplyV2::Error(error), CommandHandlingV2::Evaluated),
    };
    if reply.validate().is_err() {
        reply = KernelReplyV2::Error(storage_fault());
        handling = CommandHandlingV2::Evaluated;
    }
    KernelCommandResponseEnvelopeV2::Correlated {
        server_abi_version: deepcode_kernel_abi::KERNEL_ABI_V2_VERSION.to_owned(),
        request_id,
        handling,
        reply,
    }
}

fn map_store_open_error(error: AbiKernelError) -> KernelErrorV2 {
    match error {
        AbiKernelError::Structured {
            code: "unsupported_history_schema",
            details,
            ..
        } => {
            let received = json!({
                "schemaVersion": details.get("receivedVersion"),
                "schemaContract": details.get("receivedContract"),
                "abiVersion": details.get("receivedAbiVersion"),
            })
            .to_string();
            KernelErrorV2::UnsupportedHistorySchema { received }
        }
        _ => storage_fault(),
    }
}

fn unauthorized_run() -> KernelErrorV2 {
    KernelErrorV2::InvalidRequest {
        reason: InvalidRequestReasonV2::InvalidRelation {
            relation: InvalidRelationV2::RunMismatch,
        },
    }
}

fn constant_time_token_eq(expected: &RunCapabilityV2, submitted: &RunCapabilityV2) -> bool {
    constant_time_bytes_eq(
        expected.expose_to_transport().as_bytes(),
        submitted.expose_to_transport().as_bytes(),
    )
}

fn constant_time_bytes_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let maximum = left.len().max(right.len());
    for index in 0..maximum {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

fn settings_allow(settings: &SettingsCeilingV2, effect_scope: ToolEffectScopeV2) -> bool {
    match effect_scope {
        ToolEffectScopeV2::WorkspaceRead => settings.workspace_read,
        ToolEffectScopeV2::WorkspaceWrite => settings.workspace_write,
        ToolEffectScopeV2::RepositoryRead => settings.workspace_read,
        ToolEffectScopeV2::RepositoryIndexWrite | ToolEffectScopeV2::RepositoryHistoryWrite => {
            false
        }
        ToolEffectScopeV2::NetworkRead => settings.web_read,
    }
}

fn settings_digest(settings: &SettingsCeilingV2) -> AuthorityResult<SettingsCeilingDigestV2> {
    let value = serde_json::to_value(settings).map_err(|_| storage_fault())?;
    settings_ceiling_digest_v2(&value).map_err(|_| storage_fault())
}

fn run_open_host_request_digest(
    command: &KernelCommandV2,
    workspace_binding_digest: &WorkspaceBindingDigestV2,
    settings_ceiling_digest: &SettingsCeilingDigestV2,
) -> AuthorityResult<CommandRequestDigestV2> {
    let command_digest = command_request_digest_v2(command).map_err(|_| storage_fault())?;
    let mut hasher = Sha256::new();
    hasher.update(b"deepcode.kernel.runtime.v2/host-run-open-request\0");
    for component in [
        command_digest.as_str(),
        workspace_binding_digest.as_str(),
        settings_ceiling_digest.as_str(),
    ] {
        let length = u64::try_from(component.len()).map_err(|_| storage_fault())?;
        hasher.update(length.to_be_bytes());
        hasher.update(component.as_bytes());
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity("sha256:".len() + digest.len() * 2);
    encoded.push_str("sha256:");
    for byte in digest {
        use std::fmt::Write;
        write!(encoded, "{byte:02x}").map_err(|_| storage_fault())?;
    }
    CommandRequestDigestV2::parse(encoded).map_err(|_| storage_fault())
}

fn canonical_invocation(
    tool_id: &ToolIdV2,
    raw_arguments: &deepcode_kernel_abi::RawToolArgumentsV2,
) -> AuthorityResult<KernelCanonicalInvocation> {
    let canonical = crate::kernel_tool_registry()
        .canonicalize_v2(tool_id, raw_arguments.clone())
        .map_err(|_| invalid_field("rawArguments", InvalidFieldViolationV2::OutOfRange))?;
    let mut invocation = canonical.into_kernel_invocation();
    match &mut invocation {
        KernelCanonicalInvocation::WebSearch { query, .. } => {
            *query = query.trim().to_owned();
            if query.is_empty() || query.chars().any(char::is_control) {
                return Err(invalid_field(
                    "rawArguments.query",
                    InvalidFieldViolationV2::OutOfRange,
                ));
            }
        }
        KernelCanonicalInvocation::WebFetch { url, .. } => {
            let (canonical_url, _) = canonicalize_network_scope_url(url)
                .map_err(|failure| prepare_failure_error("rawArguments.url", failure))?;
            *url = canonical_url;
        }
        _ => {}
    }
    Ok(invocation)
}

fn canonical_argument_value(invocation: &KernelCanonicalInvocation) -> AuthorityResult<Value> {
    serde_json::to_value(invocation)
        .ok()
        .and_then(|value| value.get("arguments").cloned())
        .ok_or_else(storage_fault)
}

fn authorization_targets_for_invocation(
    invocation: &KernelCanonicalInvocation,
    canonical_scope: &ResourceScopeV2,
) -> AuthorityResult<Vec<ScopeTargetKey>> {
    match canonical_scope {
        ResourceScopeV2::Workspace { targets } => Ok(targets
            .iter()
            .map(|target| ScopeTargetKey::Workspace {
                path: target.relative_path.clone(),
                access: target.access,
                object_kind: target.object_kind,
            })
            .collect()),
        ResourceScopeV2::Repository { area } => {
            Ok(vec![ScopeTargetKey::Repository { area: *area }])
        }
        ResourceScopeV2::NetworkQuery { service_origin, .. } => match invocation {
            KernelCanonicalInvocation::WebSearch { query, .. } => {
                Ok(vec![ScopeTargetKey::NetworkQuery {
                    query: query.clone(),
                    service_origin: service_origin.clone(),
                }])
            }
            _ => Err(storage_fault()),
        },
        ResourceScopeV2::NetworkUrl { .. } => match invocation {
            KernelCanonicalInvocation::WebFetch { url, .. } => {
                Ok(vec![ScopeTargetKey::NetworkUrl { url: url.clone() }])
            }
            _ => Err(storage_fault()),
        },
    }
}

fn target_set_contains(approved: &[ScopeTargetKey], requested: &[ScopeTargetKey]) -> bool {
    requested.iter().all(|target| approved.contains(target))
}

fn union_targets(current: &[ScopeTargetKey], requested: &[ScopeTargetKey]) -> Vec<ScopeTargetKey> {
    let mut union = current.to_vec();
    union.extend_from_slice(requested);
    union.sort_by_key(scope_target_label);
    union.dedup();
    union
}

fn authorization_binding_allows(
    binding: &CapabilityAuthorizationBindingV2,
    approved_targets: &[ScopeTargetKey],
    invocation: &KernelCanonicalInvocation,
    actual_targets: &[ScopeTargetKey],
) -> AuthorityResult<bool> {
    match binding {
        CapabilityAuthorizationBindingV2::ResourceScope {} => {
            Ok(target_set_contains(approved_targets, actual_targets))
        }
        CapabilityAuthorizationBindingV2::ExactInvocation { invocation_digest } => Ok(
            exact_invocation_digest_v2(invocation).map_err(|_| storage_fault())?
                == *invocation_digest
                && target_set_contains(approved_targets, actual_targets),
        ),
    }
}

fn exact_invocation_digest_changed(
    binding: &CapabilityAuthorizationBindingV2,
    invocation: &KernelCanonicalInvocation,
) -> AuthorityResult<bool> {
    match binding {
        CapabilityAuthorizationBindingV2::ResourceScope {} => Ok(false),
        CapabilityAuthorizationBindingV2::ExactInvocation { invocation_digest } => Ok(
            exact_invocation_digest_v2(invocation).map_err(|_| storage_fault())?
                != *invocation_digest,
        ),
    }
}

fn authorization_binding_can_expand(
    previous: &CapabilityAuthorizationBindingV2,
    expanded: &CapabilityAuthorizationBindingV2,
) -> bool {
    match (previous, expanded) {
        (
            CapabilityAuthorizationBindingV2::ResourceScope {},
            CapabilityAuthorizationBindingV2::ResourceScope {},
        ) => true,
        (
            CapabilityAuthorizationBindingV2::ExactInvocation {
                invocation_digest: previous,
            },
            CapabilityAuthorizationBindingV2::ExactInvocation {
                invocation_digest: expanded,
            },
        ) => previous == expanded,
        _ => false,
    }
}

fn expanded_authorization_scope(
    binding: &CapabilityAuthorizationBindingV2,
    previous_scope: &ResourceScopeV2,
    previous_targets: &[ScopeTargetKey],
    actual_scope: &ResourceScopeV2,
    actual_targets: &[ScopeTargetKey],
) -> AuthorityResult<(ResourceScopeV2, Vec<ScopeTargetKey>, Vec<ScopeTargetKey>)> {
    let expanded_targets = union_targets(previous_targets, actual_targets);
    let scope_delta = match binding {
        CapabilityAuthorizationBindingV2::ResourceScope {} => actual_targets
            .iter()
            .filter(|target| !previous_targets.contains(target))
            .cloned()
            .collect::<Vec<_>>(),
        CapabilityAuthorizationBindingV2::ExactInvocation { .. } => actual_targets.to_vec(),
    };
    let canonical_scope = match (previous_scope, actual_scope) {
        (
            ResourceScopeV2::Workspace { targets: previous },
            ResourceScopeV2::Workspace { targets: actual },
        ) => {
            let mut targets: Vec<WorkspaceScopeTargetV2> =
                Vec::with_capacity(previous.len().saturating_add(actual.len()));
            for actual_target in previous.iter().chain(actual) {
                if let Some(existing) = targets.iter_mut().find(|existing| {
                    existing.relative_path == actual_target.relative_path
                        && existing.access == actual_target.access
                        && existing.object_kind == actual_target.object_kind
                }) {
                    *existing = actual_target.clone();
                } else {
                    targets.push(actual_target.clone());
                }
            }
            targets.sort_by_key(|target| {
                scope_target_label(&ScopeTargetKey::Workspace {
                    path: target.relative_path.clone(),
                    access: target.access,
                    object_kind: target.object_kind,
                })
            });
            let canonical_targets = targets
                .iter()
                .map(|target| ScopeTargetKey::Workspace {
                    path: target.relative_path.clone(),
                    access: target.access,
                    object_kind: target.object_kind,
                })
                .collect::<Vec<_>>();
            if !target_set_contains(&canonical_targets, &expanded_targets)
                || !target_set_contains(&expanded_targets, &canonical_targets)
            {
                return Err(invalid_field(
                    "authorizationBinding",
                    InvalidFieldViolationV2::InvalidRelation,
                ));
            }
            ResourceScopeV2::Workspace { targets }
        }
        (
            ResourceScopeV2::Repository { area: previous },
            ResourceScopeV2::Repository { area: actual },
        ) if previous == actual
            && matches!(
                expanded_targets.as_slice(),
                [ScopeTargetKey::Repository { area }] if area == actual
            ) =>
        {
            ResourceScopeV2::Repository { area: *actual }
        }
        (
            ResourceScopeV2::NetworkQuery {
                query_digest: previous_query,
                service_origin: previous_origin,
                ..
            },
            ResourceScopeV2::NetworkQuery {
                query_digest: actual_query,
                service_origin: actual_origin,
                ..
            },
        ) if previous_query == actual_query
            && previous_origin == actual_origin
            && matches!(
                expanded_targets.as_slice(),
                [ScopeTargetKey::NetworkQuery { service_origin, .. }]
                    if service_origin == actual_origin
            ) =>
        {
            actual_scope.clone()
        }
        (
            ResourceScopeV2::NetworkUrl {
                origin: previous_origin,
                ..
            },
            ResourceScopeV2::NetworkUrl {
                origin: actual_origin,
                ..
            },
        ) if previous_origin == actual_origin
            && matches!(
                expanded_targets.as_slice(),
                [ScopeTargetKey::NetworkUrl { .. }]
            ) =>
        {
            actual_scope.clone()
        }
        _ => {
            return Err(invalid_field(
                "authorizationBinding",
                InvalidFieldViolationV2::InvalidRelation,
            ))
        }
    };
    Ok((canonical_scope, expanded_targets, scope_delta))
}

fn scope_target_label(target: &ScopeTargetKey) -> String {
    match target {
        ScopeTargetKey::Workspace {
            path,
            access,
            object_kind,
        } => {
            format!("workspace:{access:?}:{object_kind:?}:{path}")
        }
        ScopeTargetKey::Repository { area } => {
            format!("repository:{area:?}")
        }
        ScopeTargetKey::NetworkUrl { url } => format!("network-url:{url}"),
        ScopeTargetKey::NetworkQuery {
            query,
            service_origin,
        } => {
            format!("network-query:{query}:{service_origin:?}")
        }
    }
}

fn scope_target_presentation(target: &ScopeTargetKey) -> CapabilityResourcePresentationV2 {
    let canonical_resource_ref = Some(scope_target_label(target));
    match target {
        ScopeTargetKey::Workspace { path, .. } => CapabilityResourcePresentationV2 {
            kind: CapabilityResourcePresentationKindV2::WorkspacePath,
            label: path.clone(),
            workspace_relative_path: Some(path.clone()),
            canonical_resource_ref,
        },
        ScopeTargetKey::Repository { area } => CapabilityResourcePresentationV2 {
            kind: CapabilityResourcePresentationKindV2::ResourceLabel,
            label: format!("repository {area:?}").to_lowercase(),
            workspace_relative_path: None,
            canonical_resource_ref,
        },
        ScopeTargetKey::NetworkUrl { url, .. } => CapabilityResourcePresentationV2 {
            kind: CapabilityResourcePresentationKindV2::ResourceLabel,
            label: url.clone(),
            workspace_relative_path: None,
            canonical_resource_ref,
        },
        ScopeTargetKey::NetworkQuery { query, .. } => CapabilityResourcePresentationV2 {
            kind: CapabilityResourcePresentationKindV2::ResourceLabel,
            label: query.clone(),
            workspace_relative_path: None,
            canonical_resource_ref,
        },
    }
}

fn plan_action_correlations(plan_action_id: &PlanActionIdV2) -> AuthorityResult<CorrelationSetV2> {
    CorrelationSetV2::materialize(vec![CorrelationRefV2::PlanAction {
        value: plan_action_id.to_string(),
    }])
    .map_err(|_| storage_fault())
}

fn project_fact(fact: KernelFactEnvelopeV2) -> AuthorityResult<KernelFactProjectionV2> {
    KernelFactProjectionV2::from_envelope(&fact).map_err(|_| storage_fault())
}

fn lower_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn recover_public_runs(
    facts: &[KernelFactEnvelopeV2],
) -> AuthorityResult<HashMap<RunId, RecoveredRunRecord>> {
    #[derive(Clone)]
    struct OpenMetadata {
        workspace_binding_ref: WorkspaceBindingRefV2,
        workspace_binding_digest: WorkspaceBindingDigestV2,
        settings_ceiling_digest: SettingsCeilingDigestV2,
        context_ref: ToolContextRefV2,
        context_fact_id: Option<FactId>,
    }

    let mut opened = HashMap::<RunId, OpenMetadata>::new();
    let mut epochs = HashMap::<RunId, (ControlEpoch, InputId, FactId)>::new();
    let mut retired = HashMap::<RunId, ()>::new();
    for envelope in facts {
        match &envelope.payload {
            KernelFactPayloadV2::Control(ControlFactV2::RunOpened {
                run_id,
                workspace_binding_ref,
                workspace_binding_digest,
                settings_ceiling_digest,
                tool_context_ref,
                ..
            }) => {
                if opened
                    .insert(
                        run_id.clone(),
                        OpenMetadata {
                            workspace_binding_ref: workspace_binding_ref.clone(),
                            workspace_binding_digest: workspace_binding_digest.clone(),
                            settings_ceiling_digest: settings_ceiling_digest.clone(),
                            context_ref: tool_context_ref.clone(),
                            context_fact_id: None,
                        },
                    )
                    .is_some()
                {
                    return Err(storage_fault());
                }
            }
            KernelFactPayloadV2::Control(ControlFactV2::EpochAdvanced {
                identity,
                input_id,
                ..
            }) => {
                epochs.insert(
                    identity.run_id.clone(),
                    (
                        identity.control_epoch,
                        input_id.clone(),
                        envelope.fact_id.clone(),
                    ),
                );
            }
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::ContextInvalidated {
                identity,
                next_context_ref,
                settings_ceiling_digest,
                ..
            }) => {
                if let Some(metadata) = opened.get_mut(&identity.run_id) {
                    metadata.context_ref = next_context_ref.clone();
                    metadata.settings_ceiling_digest = settings_ceiling_digest.clone();
                    metadata.context_fact_id = Some(envelope.fact_id.clone());
                }
            }
            KernelFactPayloadV2::Control(ControlFactV2::RunRetired { run_id, .. }) => {
                retired.insert(run_id.clone(), ());
            }
            _ => {}
        }
    }

    let mut recovered = HashMap::new();
    for (run_id, metadata) in opened {
        if retired.contains_key(&run_id) {
            continue;
        }
        let (control_epoch, current_input_id, control_fact_id) =
            epochs.remove(&run_id).ok_or_else(storage_fault)?;
        recovered.insert(
            run_id,
            RecoveredRunRecord {
                workspace_binding_ref: metadata.workspace_binding_ref,
                workspace_binding_digest: metadata.workspace_binding_digest,
                settings_ceiling_digest: metadata.settings_ceiling_digest,
                control_epoch,
                context_version: metadata.context_ref.context_version,
                context_ref: metadata.context_ref,
                current_input_id,
                control_fact_id: metadata.context_fact_id.unwrap_or(control_fact_id),
            },
        );
    }
    Ok(recovered)
}

fn recover_retired_runs(
    facts: &[KernelFactEnvelopeV2],
) -> AuthorityResult<HashMap<RunId, RetiredRunRecord>> {
    let mut retired = HashMap::new();
    for envelope in facts {
        if let KernelFactPayloadV2::Control(ControlFactV2::RunRetired {
            run_id,
            control_epoch,
            reason_code,
            reason,
            ..
        }) = &envelope.payload
        {
            let record = RetiredRunRecord {
                control_epoch: *control_epoch,
                reason_code: *reason_code,
                reason: reason.clone(),
                retirement_fact_id: envelope.fact_id.clone(),
                ledger_sequence: envelope.ledger_sequence,
            };
            if retired.insert(run_id.clone(), record).is_some() {
                return Err(storage_fault());
            }
        }
    }
    Ok(retired)
}

fn recover_retirement_fences(
    facts: &[KernelFactEnvelopeV2],
    retired_runs: &HashMap<RunId, RetiredRunRecord>,
) -> HashMap<RunId, RunRetirementFenceRecord> {
    let mut fences = HashMap::new();
    for envelope in facts {
        if let KernelFactPayloadV2::Control(ControlFactV2::RunRetirementFenced {
            run_id,
            control_epoch,
            reason_code,
            reason,
            ..
        }) = &envelope.payload
        {
            if !retired_runs.contains_key(run_id) {
                fences.insert(
                    run_id.clone(),
                    RunRetirementFenceRecord {
                        control_epoch: *control_epoch,
                        fence_fact_id: envelope.fact_id.clone(),
                        fence_ledger_sequence: envelope.ledger_sequence,
                        reason_code: *reason_code,
                        reason: reason.clone(),
                    },
                );
            }
        }
    }
    fences
}

fn recover_scope_preview_runs(
    facts: &[KernelFactEnvelopeV2],
) -> AuthorityResult<HashMap<CapabilityScopePreviewIdV2, RunId>> {
    let mut preview_runs = HashMap::new();
    for envelope in facts {
        if let KernelFactPayloadV2::Authorization(AuthorizationFactV2::ScopePreviewed {
            identity,
            preview_id,
            ..
        }) = &envelope.payload
        {
            match preview_runs.insert(preview_id.clone(), identity.run_id.clone()) {
                None => {}
                Some(existing) if existing == identity.run_id => {}
                Some(_) => return Err(storage_fault()),
            }
        }
    }
    Ok(preview_runs)
}

fn recover_runtime_availability(
    facts: &[KernelFactEnvelopeV2],
) -> HashMap<(RunId, ToolIdV2), ToolAvailabilityV2> {
    let mut runtime_availability = HashMap::new();
    for fact in facts {
        if let KernelFactPayloadV2::Authorization(AuthorizationFactV2::ContextInvalidated {
            identity,
            tool_id: Some(tool_id),
            availability: Some(next),
            reason,
            ..
        }) = &fact.payload
        {
            if *reason != ToolContextInvalidationReasonV2::SettingsChanged {
                runtime_availability.insert((identity.run_id.clone(), tool_id.clone()), *next);
            }
        }
    }
    runtime_availability
}

struct RecoveredAuthorityMaterialV2 {
    previews: HashMap<CapabilityScopePreviewIdV2, PreparedScopePreview>,
    leases: HashMap<CapabilityLeaseIdV2, CapabilityLeaseRecord>,
    trusts: HashMap<TrustPolicyIdV2, TrustLeaseRecord>,
    pending: HashMap<CapabilityScopePreviewIdV2, PendingIntent>,
    run_capability_verifiers: HashMap<RunId, String>,
}

fn valid_sha256_lower_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn capability_lease_fact_matches(
    payload: &KernelFactPayloadV2,
    durable: &DurableCapabilityLeaseV2,
) -> bool {
    match payload {
        KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityIssued {
            identity,
            tool_id,
            scope_digest,
            context_ref,
            ..
        }) => {
            identity.run_id == durable.run_id
                && identity.control_epoch == durable.control_epoch
                && identity.plan_revision == durable.plan_revision
                && identity.plan_action_id == durable.plan_action_id
                && identity.operation_id == durable.issuance_operation_id
                && identity.preview_id == durable.preview_id
                && identity.lease_id == durable.reference.lease_id
                && identity.lease_version == durable.reference.version
                && tool_id == &durable.tool_id
                && scope_digest == &durable.reference.scope_digest
                && context_ref == &durable.context_ref
        }
        KernelFactPayloadV2::Authorization(AuthorizationFactV2::ExpansionAllowed {
            identity,
            expanded_scope_digest,
            ..
        }) => {
            identity.run_id == durable.run_id
                && identity.control_epoch == durable.control_epoch
                && identity.plan_revision == durable.plan_revision
                && identity.plan_action_id == durable.plan_action_id
                && identity.operation_id == durable.issuance_operation_id
                && identity.preview_id == durable.preview_id
                && identity.lease_id == durable.reference.lease_id
                && identity.lease_version == durable.reference.version
                && expanded_scope_digest == &durable.reference.scope_digest
        }
        _ => false,
    }
}

fn trust_grant_fact_matches(payload: &KernelFactPayloadV2, durable: &DurableTrustLeaseV2) -> bool {
    let KernelFactPayloadV2::Authorization(AuthorizationFactV2::TrustGranted {
        identity,
        trust_policy_id,
        trust_lease_digest,
        tool_id,
        scope_digest,
        workspace_binding_digest,
        context_ref,
        expires_at,
    }) = payload
    else {
        return false;
    };
    identity.run_id == durable.run_id
        && identity.control_epoch == durable.control_epoch
        && identity.plan_revision == durable.plan_revision
        && identity.plan_action_id == durable.plan_action_id
        && identity.operation_id == durable.issuance_operation_id
        && trust_policy_id == &durable.trust_policy_id
        && trust_lease_digest == &durable.trust_lease_digest
        && tool_id == &durable.tool_id
        && scope_digest == &durable.scope_digest
        && workspace_binding_digest == &durable.workspace_binding_digest
        && context_ref == &durable.context_ref
        && expires_at == &durable.expires_at
}

fn recover_authority_material(
    facts: &[KernelFactEnvelopeV2],
    material: Vec<AuthorityMaterialRecordV2>,
) -> AuthorityResult<RecoveredAuthorityMaterialV2> {
    let facts_by_id = facts
        .iter()
        .map(|fact| (fact.fact_id.clone(), fact))
        .collect::<HashMap<_, _>>();
    let retired_runs = recover_retired_runs(facts)?;
    let retirement_fences = recover_retirement_fences(facts, &retired_runs);
    let mut previews = HashMap::new();
    let mut leases = HashMap::new();
    let mut trusts = HashMap::new();
    let mut pending = HashMap::new();
    let mut run_capability_verifiers = HashMap::new();
    for record in material {
        if record.lifecycle == AUTHORITY_MATERIAL_STALE {
            continue;
        }
        let retirement_pending = record.lifecycle == AUTHORITY_MATERIAL_RETIREMENT_PENDING;
        let retirement_fence = if retirement_pending {
            let fence = retirement_fences
                .get(&record.run_id)
                .ok_or_else(storage_fault)?;
            if record.last_fact_id != fence.fence_fact_id
                || record.last_ledger_sequence != fence.fence_ledger_sequence
                || record.control_epoch >= fence.control_epoch.get()
            {
                return Err(storage_fault());
            }
            Some(fence)
        } else {
            None
        };
        match record.material_kind.as_str() {
            AUTHORITY_MATERIAL_PREVIEW => {
                if (!retirement_pending && record.lifecycle != AUTHORITY_MATERIAL_ACTIVE)
                    || record.lease.is_some()
                {
                    return Err(storage_fault());
                }
                let durable: DurablePreparedScopePreviewV2 =
                    serde_json::from_value(record.payload_json).map_err(|_| storage_fault())?;
                durable.record.validate().map_err(|_| storage_fault())?;
                if durable.record.authorization_digest != durable.authorization_digest
                    || durable.record.run_id != record.run_id
                    || durable.record.control_epoch.get() != record.control_epoch
                    || durable.record.operation_id.as_str()
                        != record
                            .operation_id
                            .as_ref()
                            .map(OperationId::as_str)
                            .unwrap_or("")
                    || durable.record.preview_id.as_str() != record.material_id
                    || record.invocation_id.is_some()
                {
                    return Err(storage_fault());
                }
                let source = facts_by_id
                    .get(&record.source_fact_id)
                    .copied()
                    .ok_or_else(storage_fault)?;
                let KernelFactPayloadV2::Authorization(AuthorizationFactV2::ScopePreviewed {
                    identity,
                    preview_id,
                    tool_id,
                    authorization_binding,
                    scope_digest,
                    tool_contract_digest,
                    context_ref,
                    disposition,
                }) = &source.payload
                else {
                    return Err(storage_fault());
                };
                if identity.run_id != durable.record.run_id
                    || identity.control_epoch != durable.record.control_epoch
                    || identity.plan_revision != durable.record.plan_revision
                    || identity.plan_action_id != durable.record.plan_action_id
                    || identity.operation_id != durable.record.operation_id
                    || preview_id != &durable.record.preview_id
                    || tool_id != &durable.record.tool_id
                    || authorization_binding != &durable.record.authorization_binding
                    || scope_digest != &durable.record.scope_digest
                    || tool_contract_digest != &durable.record.tool_contract_digest
                    || context_ref != &durable.record.context_ref
                    || disposition != &durable.record.disposition
                {
                    return Err(storage_fault());
                }
                let preview_id = durable.record.preview_id.clone();
                if previews
                    .insert(preview_id, durable.into_prepared(record.source_fact_id))
                    .is_some()
                {
                    return Err(storage_fault());
                }
            }
            AUTHORITY_MATERIAL_LEASE => {
                if !retirement_pending && record.lifecycle != AUTHORITY_MATERIAL_ACTIVE {
                    if record.lifecycle == AUTHORITY_MATERIAL_REVOKED {
                        continue;
                    }
                    return Err(storage_fault());
                }
                let durable: DurableCapabilityLeaseV2 =
                    serde_json::from_value(record.payload_json).map_err(|_| storage_fault())?;
                if durable.run_id != record.run_id
                    || durable.control_epoch.get() != record.control_epoch
                    || durable.issuance_operation_id
                        != *record.operation_id.as_ref().ok_or_else(storage_fault)?
                    || durable.reference.lease_id.as_str() != record.material_id
                    || record.invocation_id.is_some()
                    || record.lease.as_ref() != Some(&durable.reference)
                {
                    return Err(storage_fault());
                }
                let issuance = match retirement_fence {
                    Some(fence) => facts
                        .iter()
                        .rev()
                        .find(|fact| {
                            fact.ledger_sequence < fence.fence_ledger_sequence
                                && capability_lease_fact_matches(&fact.payload, &durable)
                        })
                        .ok_or_else(storage_fault)?,
                    None => {
                        let last = facts_by_id
                            .get(&record.last_fact_id)
                            .copied()
                            .ok_or_else(storage_fault)?;
                        if !capability_lease_fact_matches(&last.payload, &durable) {
                            return Err(storage_fault());
                        }
                        last
                    }
                };
                let lease_id = durable.reference.lease_id.clone();
                if leases
                    .insert(
                        lease_id,
                        durable.into_record(issuance.fact_id.clone(), issuance.ledger_sequence),
                    )
                    .is_some()
                {
                    return Err(storage_fault());
                }
            }
            AUTHORITY_MATERIAL_PENDING => {
                if !retirement_pending && record.lifecycle != AUTHORITY_MATERIAL_AWAITING {
                    if matches!(
                        record.lifecycle.as_str(),
                        AUTHORITY_MATERIAL_ADMITTED | AUTHORITY_MATERIAL_REJECTED
                    ) {
                        continue;
                    }
                    return Err(storage_fault());
                }
                let durable: DurablePendingIntentV2 =
                    serde_json::from_value(record.payload_json).map_err(|_| storage_fault())?;
                if durable.run_id != record.run_id
                    || durable.expected_control_epoch.get() != record.control_epoch
                    || durable.operation_id
                        != *record.operation_id.as_ref().ok_or_else(storage_fault)?
                    || durable.invocation_id
                        != *record.invocation_id.as_ref().ok_or_else(storage_fault)?
                    || durable.preview_id.as_str() != record.material_id
                {
                    return Err(storage_fault());
                }
                let source = facts_by_id
                    .get(&record.source_fact_id)
                    .copied()
                    .ok_or_else(storage_fault)?;
                let KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityAwaiting {
                    identity,
                    preview_id,
                    tool_id,
                    canonical_arguments_digest,
                    ..
                }) = &source.payload
                else {
                    return Err(storage_fault());
                };
                if identity.run_id != durable.run_id
                    || identity.control_epoch != durable.expected_control_epoch
                    || identity.operation_id != durable.operation_id
                    || identity.invocation_id != durable.invocation_id
                    || preview_id != &durable.preview_id
                    || tool_id != &durable.tool_id
                {
                    return Err(storage_fault());
                }
                let invocation = canonical_invocation(&durable.tool_id, &durable.raw_arguments)
                    .map_err(|_| storage_fault())?;
                let canonical_arguments = canonical_argument_value(&invocation)?;
                if canonical_arguments_digest_v2(&durable.tool_id, &canonical_arguments)
                    .map_err(|_| storage_fault())?
                    != *canonical_arguments_digest
                {
                    return Err(storage_fault());
                }
                let preview_id = durable.preview_id.clone();
                if pending
                    .insert(preview_id, durable.into_pending(record.source_fact_id))
                    .is_some()
                {
                    return Err(storage_fault());
                }
            }
            AUTHORITY_MATERIAL_TRUST => {
                if !retirement_pending && record.lifecycle != AUTHORITY_MATERIAL_ACTIVE {
                    if record.lifecycle == AUTHORITY_MATERIAL_REVOKED {
                        continue;
                    }
                    return Err(storage_fault());
                }
                if record.lease.is_some() || record.invocation_id.is_some() {
                    return Err(storage_fault());
                }
                let durable: DurableTrustLeaseV2 =
                    serde_json::from_value(record.payload_json).map_err(|_| storage_fault())?;
                if durable.run_id != record.run_id
                    || durable.control_epoch.get() != record.control_epoch
                    || durable.issuance_operation_id
                        != *record.operation_id.as_ref().ok_or_else(storage_fault)?
                    || durable.trust_policy_id.as_str() != record.material_id
                {
                    return Err(storage_fault());
                }
                let grant = match retirement_fence {
                    Some(fence) => facts
                        .iter()
                        .rev()
                        .find(|fact| {
                            fact.ledger_sequence < fence.fence_ledger_sequence
                                && trust_grant_fact_matches(&fact.payload, &durable)
                        })
                        .ok_or_else(storage_fault)?,
                    None => {
                        let last = facts_by_id
                            .get(&record.last_fact_id)
                            .copied()
                            .ok_or_else(storage_fault)?;
                        if !trust_grant_fact_matches(&last.payload, &durable) {
                            return Err(storage_fault());
                        }
                        last
                    }
                };
                let trust_policy_id = durable.trust_policy_id.clone();
                if trusts
                    .insert(trust_policy_id, durable.into_record(grant.fact_id.clone()))
                    .is_some()
                {
                    return Err(storage_fault());
                }
            }
            RUN_CAPABILITY_VERIFIER_MATERIAL_KIND => {
                if (!retirement_pending && record.lifecycle != RUN_CAPABILITY_VERIFIER_BOUND)
                    || record.operation_id.is_some()
                    || record.invocation_id.is_some()
                    || record.lease.is_some()
                {
                    return Err(storage_fault());
                }
                let durable: DurableRunCapabilityVerifierV2 =
                    serde_json::from_value(record.payload_json).map_err(|_| storage_fault())?;
                if durable.run_id != record.run_id
                    || durable.run_id.as_str() != record.material_id
                    || !valid_sha256_lower_hex(&durable.token_verifier_sha256)
                    || durable.transport_generation == 0
                {
                    return Err(storage_fault());
                }
                let source = facts_by_id
                    .get(&record.source_fact_id)
                    .copied()
                    .ok_or_else(storage_fault)?;
                let last = facts_by_id
                    .get(&record.last_fact_id)
                    .copied()
                    .ok_or_else(storage_fault)?;
                let source_matches = matches!(
                    &source.payload,
                    KernelFactPayloadV2::Control(ControlFactV2::RunOpened {
                        run_id,
                        control_epoch,
                        ..
                    }) if run_id == &durable.run_id && control_epoch.get() <= record.control_epoch
                );
                let last_matches = match &last.payload {
                    KernelFactPayloadV2::Control(ControlFactV2::RunOpened {
                        run_id,
                        control_epoch,
                        ..
                    }) => {
                        run_id == &durable.run_id
                            && control_epoch.get() == record.control_epoch
                            && durable.transport_generation == 1
                    }
                    KernelFactPayloadV2::Control(ControlFactV2::RunTransportRebound {
                        run_id,
                        control_epoch,
                        transport_generation,
                        ..
                    }) => {
                        run_id == &durable.run_id
                            && control_epoch.get() >= record.control_epoch
                            && *transport_generation == durable.transport_generation
                    }
                    KernelFactPayloadV2::Control(ControlFactV2::RunRetirementFenced {
                        run_id,
                        control_epoch,
                        ..
                    }) => {
                        retirement_pending
                            && run_id == &durable.run_id
                            && Some(control_epoch)
                                == retirement_fence.map(|fence| &fence.control_epoch)
                    }
                    _ => false,
                };
                if !source_matches || !last_matches {
                    return Err(storage_fault());
                }
                if retirement_pending {
                    continue;
                }
                if run_capability_verifiers
                    .insert(durable.run_id, durable.token_verifier_sha256)
                    .is_some()
                {
                    return Err(storage_fault());
                }
            }
            AUTHORITY_MATERIAL_INVOCATION => {
                if record.lifecycle != AUTHORITY_MATERIAL_TERMINAL
                    || record.invocation_id.as_ref().map(InvocationId::as_str)
                        != Some(record.material_id.as_str())
                {
                    return Err(storage_fault());
                }
                let invocation_id = record.invocation_id.as_ref().ok_or_else(storage_fault)?;
                let operation_id = record.operation_id.as_ref().ok_or_else(storage_fault)?;
                let source = facts_by_id
                    .get(&record.source_fact_id)
                    .copied()
                    .ok_or_else(storage_fault)?;
                let last = facts_by_id
                    .get(&record.last_fact_id)
                    .copied()
                    .ok_or_else(storage_fault)?;
                if source.payload.run_id() != &record.run_id
                    || source.payload.control_epoch().map(ControlEpoch::get)
                        != Some(record.control_epoch)
                    || source.payload.operation_id() != Some(operation_id)
                    || source.payload.invocation_id() != Some(invocation_id)
                    || !matches!(
                        &source.payload,
                        KernelFactPayloadV2::Invocation(
                            InvocationFactV2::ToolIntentAdmitted { .. }
                        )
                    )
                    || last.payload.run_id() != &record.run_id
                    || last.payload.control_epoch().map(ControlEpoch::get)
                        != Some(record.control_epoch)
                    || last.payload.operation_id() != Some(operation_id)
                    || last.payload.invocation_id() != Some(invocation_id)
                    || !matches!(
                        &last.payload,
                        KernelFactPayloadV2::Invocation(
                            InvocationFactV2::ToolFailedBeforeEffect { .. }
                                | InvocationFactV2::ToolCancelledBeforeEffect { .. }
                                | InvocationFactV2::ToolTimedOutBeforeEffect { .. }
                                | InvocationFactV2::ToolCompleted { .. }
                                | InvocationFactV2::ToolFailedAfterObservedEffect { .. }
                                | InvocationFactV2::ToolIndeterminate { .. }
                        )
                    )
                {
                    return Err(storage_fault());
                }
            }
            _ => return Err(storage_fault()),
        }
    }
    for preview in previews.values() {
        let descriptor = crate::kernel_tool_registry()
            .descriptor_v2(&preview.record.tool_id)
            .ok_or_else(storage_fault)?;
        if descriptor.authorization_shape
            != preview.record.authorization_binding.authorization_shape()
            || descriptor.contract_digest != preview.record.tool_contract_digest
        {
            return Err(storage_fault());
        }
    }
    for lease in leases.values() {
        let preview = previews.get(&lease.preview_id).ok_or_else(storage_fault)?;
        if lease.authorization_binding != preview.record.authorization_binding
            || lease.approved_targets != preview.approved_targets
            || lease.reference.scope_digest != preview.record.scope_digest
            || lease.tool_id != preview.record.tool_id
            || lease.context_ref != preview.record.context_ref
        {
            return Err(storage_fault());
        }
    }
    for trust in trusts.values() {
        let matching_preview = previews.values().any(|preview| {
            preview.record.run_id == trust.run_id
                && preview.record.control_epoch == trust.control_epoch
                && preview.record.plan_revision == trust.plan_revision
                && preview.record.plan_action_id == trust.plan_action_id
                && preview.record.operation_id == trust.issuance_operation_id
                && preview.record.tool_id == trust.tool_id
                && preview.record.scope_digest == trust.scope_digest
                && preview.record.authorization_binding == trust.authorization_binding
                && preview.approved_targets == trust.approved_targets
        });
        if !matching_preview {
            return Err(storage_fault());
        }
    }
    Ok(RecoveredAuthorityMaterialV2 {
        previews,
        leases,
        trusts,
        pending,
        run_capability_verifiers,
    })
}

fn recorded_at_unix_millis(recorded_at: &RecordedAtV2) -> Option<u128> {
    let value = recorded_at.as_str().as_bytes();
    let parse = |start: usize, end: usize| {
        std::str::from_utf8(&value[start..end])
            .ok()?
            .parse::<i64>()
            .ok()
    };
    let mut year = parse(0, 4)?;
    let month = parse(5, 7)?;
    let day = parse(8, 10)?;
    let hour = parse(11, 13)?;
    let minute = parse(14, 16)?;
    let second = parse(17, 19)?;
    let millis = parse(20, 23)?;
    year -= i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days_since_epoch = era * 146_097 + day_of_era - 719_468;
    if days_since_epoch < 0 {
        return None;
    }
    let seconds = days_since_epoch
        .checked_mul(86_400)?
        .checked_add(hour.checked_mul(3_600)?)?
        .checked_add(minute.checked_mul(60)?)?
        .checked_add(second)?;
    u128::try_from(seconds)
        .ok()?
        .checked_mul(1_000)?
        .checked_add(u128::try_from(millis).ok()?)
}

fn recorded_at_is_future(recorded_at: &RecordedAtV2) -> bool {
    let Some(expiry) = recorded_at_unix_millis(recorded_at) else {
        return false;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(u128::MAX);
    expiry > now
}

fn recorded_at_after(duration: std::time::Duration) -> AuthorityResult<RecordedAtV2> {
    let timestamp = std::time::SystemTime::now()
        .checked_add(duration)
        .ok_or_else(storage_fault)?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| storage_fault())?;
    let total_seconds = i64::try_from(timestamp.as_secs()).map_err(|_| storage_fault())?;
    let days = total_seconds.div_euclid(86_400);
    let seconds_of_day = total_seconds.rem_euclid(86_400);
    let shifted_days = days + 719_468;
    let era = if shifted_days >= 0 {
        shifted_days
    } else {
        shifted_days - 146_096
    }
    .div_euclid(146_097);
    let day_of_era = shifted_days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let hour = seconds_of_day / 3_600;
    let minute = seconds_of_day % 3_600 / 60;
    let second = seconds_of_day % 60;
    RecordedAtV2::new(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        timestamp.subsec_millis()
    ))
    .map_err(|_| storage_fault())
}

fn public_receipt(
    request_id: CommandRequestId,
    request_digest: CommandRequestDigestV2,
    command_kind: impl Into<String>,
    run_id: Option<RunId>,
    reply: &DurablePublicReplyV2,
    settlement_fact_id: Option<FactId>,
) -> AuthorityResult<PublicCommandReceiptV2> {
    let reply_json = serde_json::to_value(reply).map_err(|_| storage_fault())?;
    validate_cross_language_safe_json_value_v2("replyJson", &reply_json)
        .map_err(|_| storage_fault())?;
    Ok(PublicCommandReceiptV2 {
        command_request_id: request_id,
        command_request_digest: request_digest,
        command_kind: command_kind.into(),
        run_id,
        reply_json,
        settlement_fact_id,
    })
}

fn receipt_outcome(
    outcome: PutPublicCommandReceiptOutcomeV2,
) -> AuthorityResult<DurablePublicReplyV2> {
    match outcome {
        PutPublicCommandReceiptOutcomeV2::Inserted(receipt)
        | PutPublicCommandReceiptOutcomeV2::ExistingSame(receipt) => {
            serde_json::from_value(receipt.reply_json).map_err(|_| storage_fault())
        }
        PutPublicCommandReceiptOutcomeV2::DigestConflict {
            command_request_id,
            existing,
            submitted,
        } => Err(KernelErrorV2::DuplicateCommandDigestMismatch {
            command_request_id,
            existing,
            submitted,
        }),
    }
}

fn public_command_run_id(command: &KernelCommandV2) -> Option<RunId> {
    match command {
        KernelCommandV2::ToolContextGet(command) => Some(command.run_id.clone()),
        KernelCommandV2::CapabilityScopePreviewBatch(command) => Some(command.run_id.clone()),
        KernelCommandV2::ToolIntentSubmit(command) => Some(command.run_id.clone()),
        KernelCommandV2::KernelFactsQueryScoped(command) => Some(command.run_id.clone()),
        KernelCommandV2::ControlEpochAdvance(command) => Some(command.run_id.clone()),
        KernelCommandV2::InvocationCancel(command) => Some(command.run_id.clone()),
        KernelCommandV2::RunOpen(_) => None,
    }
}

fn classify_tool_intent_rejection(
    error: &KernelErrorV2,
) -> Option<(ToolIntentRejectionReasonV2, String)> {
    let classified = match error {
        KernelErrorV2::StaleControlEpoch { .. } => (
            ToolIntentRejectionReasonV2::StaleControlEpoch,
            "Refresh the current control epoch before re-planning.",
        ),
        KernelErrorV2::ToolContextStale { .. } => (
            ToolIntentRejectionReasonV2::StaleToolContext,
            "Refresh ToolContext before submitting another tool intent.",
        ),
        KernelErrorV2::ToolNotRegistered { .. } => (
            ToolIntentRejectionReasonV2::ToolNotRegistered,
            "Choose a tool present in the current Kernel ToolContext.",
        ),
        KernelErrorV2::ToolUnavailable { .. } => (
            ToolIntentRejectionReasonV2::ToolUnavailable,
            "Refresh ToolContext and choose a tool that is currently ready.",
        ),
        KernelErrorV2::InvalidRequest {
            reason: InvalidRequestReasonV2::DeadlineOutOfContract { .. },
        } => (
            ToolIntentRejectionReasonV2::InvalidArguments,
            "Use a deadline within the current tool contract.",
        ),
        KernelErrorV2::InvalidRequest {
            reason:
                InvalidRequestReasonV2::InvalidField {
                    field_path,
                    violation: InvalidFieldViolationV2::PathEscapesWorkspace,
                },
        } if field_path.starts_with("rawArguments") => (
            ToolIntentRejectionReasonV2::InvalidArguments,
            "Use a workspace-relative path that resolves inside the bound workspace.",
        ),
        KernelErrorV2::InvalidRequest {
            reason: InvalidRequestReasonV2::InvalidField { field_path, .. },
        } if field_path.starts_with("rawArguments") => (
            ToolIntentRejectionReasonV2::InvalidArguments,
            "Use arguments accepted by the current Kernel tool contract.",
        ),
        KernelErrorV2::InvalidRequest {
            reason: InvalidRequestReasonV2::InvalidField { field_path, .. },
        } if field_path == "authority" => (
            ToolIntentRejectionReasonV2::PlanActionRequired,
            "Persist and confirm a PlanAction before invoking this mutation tool.",
        ),
        _ => return None,
    };
    Some((classified.0, classified.1.to_owned()))
}

fn classify_scope_preview_rejection(
    error: &KernelErrorV2,
) -> Option<(CapabilityScopeRejectionReasonV2, String)> {
    let classified = match error {
        KernelErrorV2::InvalidRequest {
            reason: InvalidRequestReasonV2::DeadlineOutOfContract { .. },
        } => (
            CapabilityScopeRejectionReasonV2::InvalidArguments,
            "Use a deadline within the current tool contract.",
        ),
        KernelErrorV2::InvalidRequest {
            reason:
                InvalidRequestReasonV2::InvalidField {
                    field_path,
                    violation: InvalidFieldViolationV2::PathEscapesWorkspace,
                },
        } if field_path.starts_with("rawArguments") => (
            CapabilityScopeRejectionReasonV2::InvalidArguments,
            "Use workspace-relative tool arguments that resolve inside the bound workspace.",
        ),
        KernelErrorV2::InvalidRequest {
            reason: InvalidRequestReasonV2::InvalidField { field_path, .. },
        } if field_path.starts_with("rawArguments") => (
            CapabilityScopeRejectionReasonV2::InvalidArguments,
            "Use exact-invocation rawArguments accepted by the immutable Kernel ToolContext schema.",
        ),
        KernelErrorV2::InvalidRequest {
            reason: InvalidRequestReasonV2::InvalidField { field_path, .. },
        } if field_path.starts_with("scopeIntent.requestedResources") => (
            CapabilityScopeRejectionReasonV2::RequestedScopeInvalid,
            "Use resources whose kind, access, and repository area match this tool contract.",
        ),
        KernelErrorV2::InvalidRequest {
            reason: InvalidRequestReasonV2::InvalidRelation { .. },
        } => (
            CapabilityScopeRejectionReasonV2::RequestedScopeInvalid,
            "Use requested resources that are valid for this tool and workspace.",
        ),
        _ => return None,
    };
    Some((classified.0, classified.1.to_owned()))
}

fn user_decision_settlement_fact(reply: &UserDecisionReplyV2) -> Option<FactId> {
    match reply {
        UserDecisionReplyV2::CapabilityIssued { fact_id, .. }
        | UserDecisionReplyV2::CapabilityDenied { fact_id, .. }
        | UserDecisionReplyV2::ScopeExpansionRecorded { fact_id, .. }
        | UserDecisionReplyV2::ScopeExpansionDenied { fact_id, .. }
        | UserDecisionReplyV2::TrustGranted { fact_id, .. }
        | UserDecisionReplyV2::Revoked { fact_id, .. } => Some(fact_id.clone()),
        UserDecisionReplyV2::Stale { .. } | UserDecisionReplyV2::Error(_) => None,
    }
}

impl Default for SettingsCeilingV2 {
    fn default() -> Self {
        Self {
            workspace_read: true,
            workspace_write: true,
            web_read: false,
            auto_approve_plans: false,
        }
    }
}

#[derive(Clone)]
pub struct KernelSessionServiceV2 {
    inner: Arc<KernelSessionInner>,
}

/// Host transport result for RunOpen. The capability is deliberately kept
/// outside the serializable Kernel reply and may only be moved into a trusted
/// transport header or another private Host channel.
pub struct OpenedRunTransportV2 {
    response: KernelCommandResponseEnvelopeV2,
    run_capability: Option<RunCapabilityV2>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostRunResumeDispositionV2 {
    ReplayedActive,
    RotatedRecovered {
        rebind_fact_id: FactId,
        rebind_ledger_sequence: u64,
    },
}

/// Host-only recovered Run transport binding. The capability is deliberately
/// kept outside every serializable ABI reply.
pub struct HostResumedRunV2 {
    run_open_reply: RunOpenReplyV2,
    run_capability: RunCapabilityV2,
    transport_generation: u64,
    disposition: HostRunResumeDispositionV2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingCapabilityDecisionClassV2 {
    Capability,
    ScopeExpansion,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCapabilityDecisionV2 {
    pub run_id: RunId,
    pub expected_control_epoch: ControlEpoch,
    pub class: PendingCapabilityDecisionClassV2,
    pub binding: CapabilityDecisionBindingV2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRetirementReceiptV2 {
    pub run_id: RunId,
    pub control_epoch: ControlEpoch,
    pub reason_code: RunRetirementReasonCodeV2,
    pub reason: Option<String>,
    pub retirement_fact_id: FactId,
    pub retirement_ledger_sequence: u64,
    pub replayed: bool,
}

impl OpenedRunTransportV2 {
    pub fn into_parts(self) -> (KernelCommandResponseEnvelopeV2, Option<RunCapabilityV2>) {
        (self.response, self.run_capability)
    }
}

impl HostResumedRunV2 {
    pub fn run_open_reply(&self) -> &RunOpenReplyV2 {
        &self.run_open_reply
    }

    pub fn transport_generation(&self) -> u64 {
        self.transport_generation
    }

    pub fn disposition(&self) -> &HostRunResumeDispositionV2 {
        &self.disposition
    }

    pub fn into_parts(
        self,
    ) -> (
        RunOpenReplyV2,
        RunCapabilityV2,
        u64,
        HostRunResumeDispositionV2,
    ) {
        (
            self.run_open_reply,
            self.run_capability,
            self.transport_generation,
            self.disposition,
        )
    }
}

struct KernelSessionInner {
    authority: AuthorityService,
    inventory: ToolInventoryV2,
    state: Mutex<KernelSessionState>,
    command_gate: Mutex<()>,
    ids: PublicIdMint,
}

#[derive(Default)]
struct KernelSessionState {
    runs: HashMap<RunId, PublicRunRecord>,
    recovered_runs: HashMap<RunId, RecoveredRunRecord>,
    retirement_fences: HashMap<RunId, RunRetirementFenceRecord>,
    retired_runs: HashMap<RunId, RetiredRunRecord>,
    run_capability_verifiers: HashMap<RunId, String>,
    preview_runs: HashMap<CapabilityScopePreviewIdV2, RunId>,
    previews: HashMap<CapabilityScopePreviewIdV2, PreparedScopePreview>,
    leases: HashMap<CapabilityLeaseIdV2, CapabilityLeaseRecord>,
    trusts: HashMap<TrustPolicyIdV2, TrustLeaseRecord>,
    pending: HashMap<CapabilityScopePreviewIdV2, PendingIntent>,
    runtime_availability: HashMap<(RunId, ToolIdV2), ToolAvailabilityV2>,
    run_settings: HashMap<RunId, SettingsCeilingV2>,
}

#[derive(Clone)]
struct PublicRunRecord {
    capability: RunCapabilityV2,
    transport_generation: u64,
    workspace_binding_ref: WorkspaceBindingRefV2,
    workspace_binding_digest: WorkspaceBindingDigestV2,
    settings_ceiling_digest: SettingsCeilingDigestV2,
    control_epoch: ControlEpoch,
    current_input_id: InputId,
    context_version: ToolContextVersionV2,
    context_ref: ToolContextRefV2,
    control_fact_id: FactId,
}

#[derive(Clone)]
struct RecoveredRunRecord {
    workspace_binding_ref: WorkspaceBindingRefV2,
    workspace_binding_digest: WorkspaceBindingDigestV2,
    settings_ceiling_digest: SettingsCeilingDigestV2,
    control_epoch: ControlEpoch,
    context_version: ToolContextVersionV2,
    context_ref: ToolContextRefV2,
    current_input_id: InputId,
    control_fact_id: FactId,
}

#[derive(Clone)]
struct RunRetirementFenceRecord {
    control_epoch: ControlEpoch,
    fence_fact_id: FactId,
    fence_ledger_sequence: u64,
    reason_code: RunRetirementReasonCodeV2,
    reason: Option<String>,
}

#[derive(Clone)]
struct RetiredRunRecord {
    control_epoch: ControlEpoch,
    reason_code: RunRetirementReasonCodeV2,
    reason: Option<String>,
    retirement_fact_id: FactId,
    ledger_sequence: u64,
}

impl RetiredRunRecord {
    fn receipt(&self, run_id: RunId, replayed: bool) -> RunRetirementReceiptV2 {
        RunRetirementReceiptV2 {
            run_id,
            control_epoch: self.control_epoch,
            reason_code: self.reason_code,
            reason: self.reason.clone(),
            retirement_fact_id: self.retirement_fact_id.clone(),
            retirement_ledger_sequence: self.ledger_sequence,
            replayed,
        }
    }
}

fn require_same_retirement_reason(
    retired: &RetiredRunRecord,
    reason_code: RunRetirementReasonCodeV2,
    reason: Option<&str>,
) -> AuthorityResult<()> {
    if retired.reason_code != reason_code {
        return Err(invalid_field(
            "reasonCode",
            InvalidFieldViolationV2::InvalidRelation,
        ));
    }
    if retired.reason.as_deref() != reason {
        return Err(invalid_field(
            "reason",
            InvalidFieldViolationV2::InvalidRelation,
        ));
    }
    Ok(())
}

fn require_same_retirement_fence_reason(
    fence: &RunRetirementFenceRecord,
    reason_code: RunRetirementReasonCodeV2,
    reason: Option<&str>,
) -> AuthorityResult<()> {
    if fence.reason_code != reason_code {
        return Err(invalid_field(
            "reasonCode",
            InvalidFieldViolationV2::InvalidRelation,
        ));
    }
    if fence.reason.as_deref() != reason {
        return Err(invalid_field(
            "reason",
            InvalidFieldViolationV2::InvalidRelation,
        ));
    }
    Ok(())
}

fn require_same_retirement_fence(
    expected: &RunRetirementFenceRecord,
    actual: &RunRetirementFenceRecord,
) -> AuthorityResult<()> {
    if expected.control_epoch != actual.control_epoch
        || expected.fence_fact_id != actual.fence_fact_id
        || expected.fence_ledger_sequence != actual.fence_ledger_sequence
        || expected.reason_code != actual.reason_code
        || expected.reason != actual.reason
    {
        return Err(storage_fault());
    }
    Ok(())
}

fn retirement_pending(run_id: RunId, fence: &RunRetirementFenceRecord) -> KernelErrorV2 {
    KernelErrorV2::RunRetirementPending {
        run_id,
        control_epoch: fence.control_epoch,
        fence_fact_id: fence.fence_fact_id.clone(),
        fence_ledger_sequence: fence.fence_ledger_sequence,
    }
}

type ScopeTargetKey = AuthorizationTargetKey;

#[derive(Clone)]
struct PreparedScopePreview {
    record: CapabilityScopePreviewRecordV2,
    approved_targets: Vec<ScopeTargetKey>,
    authorization_digest: CapabilityAuthorizationDigestV2,
    preview_fact_id: FactId,
    automatic_decision_ref: Option<UserDecisionRefV2>,
    decision_class: PreparedScopePreviewDecisionClassV2,
}

struct UnpersistedScopePreview {
    record: CapabilityScopePreviewRecordV2,
    approved_targets: Vec<ScopeTargetKey>,
    authorization_digest: CapabilityAuthorizationDigestV2,
    automatic_decision_ref: Option<UserDecisionRefV2>,
    decision_class: PreparedScopePreviewDecisionClassV2,
    payload: AuthorizationFactV2,
    durable: DurablePreparedScopePreviewV2,
}

impl UnpersistedScopePreview {
    fn into_prepared(self, preview_fact_id: FactId) -> PreparedScopePreview {
        PreparedScopePreview {
            record: self.record,
            approved_targets: self.approved_targets,
            authorization_digest: self.authorization_digest,
            preview_fact_id,
            automatic_decision_ref: self.automatic_decision_ref,
            decision_class: self.decision_class,
        }
    }
}

impl PreparedScopePreview {
    fn durable(&self) -> DurablePreparedScopePreviewV2 {
        DurablePreparedScopePreviewV2 {
            record: self.record.clone(),
            approved_targets: self.approved_targets.clone(),
            authorization_digest: self.authorization_digest.clone(),
            automatic_decision_ref: self.automatic_decision_ref.clone(),
            decision_class: self.decision_class,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PreparedScopePreviewDecisionClassV2 {
    Capability,
    ScopeExpansion,
}

impl PreparedScopePreviewDecisionClassV2 {
    fn pending_class(self) -> PendingCapabilityDecisionClassV2 {
        match self {
            Self::Capability => PendingCapabilityDecisionClassV2::Capability,
            Self::ScopeExpansion => PendingCapabilityDecisionClassV2::ScopeExpansion,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurablePreparedScopePreviewV2 {
    record: CapabilityScopePreviewRecordV2,
    approved_targets: Vec<ScopeTargetKey>,
    authorization_digest: CapabilityAuthorizationDigestV2,
    automatic_decision_ref: Option<UserDecisionRefV2>,
    decision_class: PreparedScopePreviewDecisionClassV2,
}

impl DurablePreparedScopePreviewV2 {
    fn into_prepared(self, preview_fact_id: FactId) -> PreparedScopePreview {
        PreparedScopePreview {
            record: self.record,
            approved_targets: self.approved_targets,
            authorization_digest: self.authorization_digest,
            preview_fact_id,
            automatic_decision_ref: self.automatic_decision_ref,
            decision_class: self.decision_class,
        }
    }
}

fn scope_preview_material(
    durable: &DurablePreparedScopePreviewV2,
    lifecycle: &str,
) -> AuthorityResult<AuthorityMaterialDraftV2> {
    Ok(AuthorityMaterialDraftV2 {
        material_kind: AUTHORITY_MATERIAL_PREVIEW.to_owned(),
        material_id: durable.record.preview_id.to_string(),
        run_id: durable.record.run_id.clone(),
        control_epoch: durable.record.control_epoch.get(),
        lifecycle: lifecycle.to_owned(),
        operation_id: Some(durable.record.operation_id.clone()),
        invocation_id: None,
        lease: None,
        payload_json: serde_json::to_value(durable).map_err(|_| storage_fault())?,
    })
}

#[derive(Clone)]
struct CapabilityLeaseRecord {
    reference: CapabilityLeaseRefV2,
    run_id: RunId,
    control_epoch: ControlEpoch,
    plan_revision: PlanRevisionV2,
    plan_action_id: PlanActionIdV2,
    tool_id: ToolIdV2,
    context_ref: ToolContextRefV2,
    authorization_binding: CapabilityAuthorizationBindingV2,
    approved_targets: Vec<ScopeTargetKey>,
    decision_ref: Option<UserDecisionRefV2>,
    issuance_operation_id: OperationId,
    preview_id: CapabilityScopePreviewIdV2,
    issuance_fact_id: FactId,
    issuance_ledger_sequence: u64,
}

impl CapabilityLeaseRecord {
    fn durable(&self) -> DurableCapabilityLeaseV2 {
        DurableCapabilityLeaseV2 {
            reference: self.reference.clone(),
            run_id: self.run_id.clone(),
            control_epoch: self.control_epoch,
            plan_revision: self.plan_revision.clone(),
            plan_action_id: self.plan_action_id.clone(),
            tool_id: self.tool_id.clone(),
            context_ref: self.context_ref.clone(),
            authorization_binding: self.authorization_binding.clone(),
            approved_targets: self.approved_targets.clone(),
            decision_ref: self.decision_ref.clone(),
            issuance_operation_id: self.issuance_operation_id.clone(),
            preview_id: self.preview_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableCapabilityLeaseV2 {
    reference: CapabilityLeaseRefV2,
    run_id: RunId,
    control_epoch: ControlEpoch,
    plan_revision: PlanRevisionV2,
    plan_action_id: PlanActionIdV2,
    tool_id: ToolIdV2,
    context_ref: ToolContextRefV2,
    authorization_binding: CapabilityAuthorizationBindingV2,
    approved_targets: Vec<ScopeTargetKey>,
    decision_ref: Option<UserDecisionRefV2>,
    issuance_operation_id: OperationId,
    preview_id: CapabilityScopePreviewIdV2,
}

impl DurableCapabilityLeaseV2 {
    fn into_record(
        self,
        issuance_fact_id: FactId,
        issuance_ledger_sequence: u64,
    ) -> CapabilityLeaseRecord {
        CapabilityLeaseRecord {
            reference: self.reference,
            run_id: self.run_id,
            control_epoch: self.control_epoch,
            plan_revision: self.plan_revision,
            plan_action_id: self.plan_action_id,
            tool_id: self.tool_id,
            context_ref: self.context_ref,
            authorization_binding: self.authorization_binding,
            approved_targets: self.approved_targets,
            decision_ref: self.decision_ref,
            issuance_operation_id: self.issuance_operation_id,
            preview_id: self.preview_id,
            issuance_fact_id,
            issuance_ledger_sequence,
        }
    }
}

fn capability_lease_material(
    durable: &DurableCapabilityLeaseV2,
    lifecycle: &str,
) -> AuthorityResult<AuthorityMaterialDraftV2> {
    Ok(AuthorityMaterialDraftV2 {
        material_kind: AUTHORITY_MATERIAL_LEASE.to_owned(),
        material_id: durable.reference.lease_id.to_string(),
        run_id: durable.run_id.clone(),
        control_epoch: durable.control_epoch.get(),
        lifecycle: lifecycle.to_owned(),
        operation_id: Some(durable.issuance_operation_id.clone()),
        invocation_id: None,
        lease: Some(durable.reference.clone()),
        payload_json: serde_json::to_value(durable).map_err(|_| storage_fault())?,
    })
}

#[derive(Clone)]
struct TrustLeaseRecord {
    trust_policy_id: TrustPolicyIdV2,
    trust_lease_digest: TrustLeaseDigestV2,
    run_id: RunId,
    control_epoch: ControlEpoch,
    plan_revision: PlanRevisionV2,
    plan_action_id: PlanActionIdV2,
    issuance_operation_id: OperationId,
    tool_id: ToolIdV2,
    scope_digest: CapabilityScopeDigestV2,
    authorization_binding: CapabilityAuthorizationBindingV2,
    approved_targets: Vec<ScopeTargetKey>,
    workspace_binding_digest: WorkspaceBindingDigestV2,
    context_ref: ToolContextRefV2,
    expires_at: Option<RecordedAtV2>,
    decision_ref: UserDecisionRefV2,
    fact_id: FactId,
}

impl TrustLeaseRecord {
    fn durable(&self) -> DurableTrustLeaseV2 {
        DurableTrustLeaseV2 {
            trust_policy_id: self.trust_policy_id.clone(),
            trust_lease_digest: self.trust_lease_digest.clone(),
            run_id: self.run_id.clone(),
            control_epoch: self.control_epoch,
            plan_revision: self.plan_revision.clone(),
            plan_action_id: self.plan_action_id.clone(),
            issuance_operation_id: self.issuance_operation_id.clone(),
            tool_id: self.tool_id.clone(),
            scope_digest: self.scope_digest.clone(),
            authorization_binding: self.authorization_binding.clone(),
            approved_targets: self.approved_targets.clone(),
            workspace_binding_digest: self.workspace_binding_digest.clone(),
            context_ref: self.context_ref.clone(),
            expires_at: self.expires_at.clone(),
            decision_ref: self.decision_ref.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableTrustLeaseV2 {
    trust_policy_id: TrustPolicyIdV2,
    trust_lease_digest: TrustLeaseDigestV2,
    run_id: RunId,
    control_epoch: ControlEpoch,
    plan_revision: PlanRevisionV2,
    plan_action_id: PlanActionIdV2,
    issuance_operation_id: OperationId,
    tool_id: ToolIdV2,
    scope_digest: CapabilityScopeDigestV2,
    authorization_binding: CapabilityAuthorizationBindingV2,
    approved_targets: Vec<ScopeTargetKey>,
    workspace_binding_digest: WorkspaceBindingDigestV2,
    context_ref: ToolContextRefV2,
    expires_at: Option<RecordedAtV2>,
    decision_ref: UserDecisionRefV2,
}

impl DurableTrustLeaseV2 {
    fn into_record(self, fact_id: FactId) -> TrustLeaseRecord {
        TrustLeaseRecord {
            trust_policy_id: self.trust_policy_id,
            trust_lease_digest: self.trust_lease_digest,
            run_id: self.run_id,
            control_epoch: self.control_epoch,
            plan_revision: self.plan_revision,
            plan_action_id: self.plan_action_id,
            issuance_operation_id: self.issuance_operation_id,
            tool_id: self.tool_id,
            scope_digest: self.scope_digest,
            authorization_binding: self.authorization_binding,
            approved_targets: self.approved_targets,
            workspace_binding_digest: self.workspace_binding_digest,
            context_ref: self.context_ref,
            expires_at: self.expires_at,
            decision_ref: self.decision_ref,
            fact_id,
        }
    }
}

fn trust_lease_material(
    durable: &DurableTrustLeaseV2,
    lifecycle: &str,
) -> AuthorityResult<AuthorityMaterialDraftV2> {
    Ok(AuthorityMaterialDraftV2 {
        material_kind: AUTHORITY_MATERIAL_TRUST.to_owned(),
        material_id: durable.trust_policy_id.to_string(),
        run_id: durable.run_id.clone(),
        control_epoch: durable.control_epoch.get(),
        lifecycle: lifecycle.to_owned(),
        operation_id: Some(durable.issuance_operation_id.clone()),
        invocation_id: None,
        lease: None,
        payload_json: serde_json::to_value(durable).map_err(|_| storage_fault())?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingIntent {
    run_id: RunId,
    expected_control_epoch: ControlEpoch,
    operation_id: OperationId,
    idempotency_key: String,
    tool_id: ToolIdV2,
    raw_arguments: deepcode_kernel_abi::RawToolArgumentsV2,
    authority: ToolIntentAuthorityV2,
    deadline: DeadlineRequestV2,
    tool_context_ref: ToolContextRefV2,
    invocation_id: InvocationId,
    awaiting_fact_id: FactId,
    preview_id: CapabilityScopePreviewIdV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurablePendingIntentV2 {
    run_id: RunId,
    expected_control_epoch: ControlEpoch,
    operation_id: OperationId,
    idempotency_key: String,
    tool_id: ToolIdV2,
    raw_arguments: deepcode_kernel_abi::RawToolArgumentsV2,
    authority: ToolIntentAuthorityV2,
    deadline: DeadlineRequestV2,
    tool_context_ref: ToolContextRefV2,
    invocation_id: InvocationId,
    preview_id: CapabilityScopePreviewIdV2,
}

impl PendingIntent {
    fn durable(&self) -> DurablePendingIntentV2 {
        DurablePendingIntentV2 {
            run_id: self.run_id.clone(),
            expected_control_epoch: self.expected_control_epoch,
            operation_id: self.operation_id.clone(),
            idempotency_key: self.idempotency_key.clone(),
            tool_id: self.tool_id.clone(),
            raw_arguments: self.raw_arguments.clone(),
            authority: self.authority.clone(),
            deadline: self.deadline,
            tool_context_ref: self.tool_context_ref.clone(),
            invocation_id: self.invocation_id.clone(),
            preview_id: self.preview_id.clone(),
        }
    }
}

impl DurablePendingIntentV2 {
    fn from_command(
        command: &ToolIntentSubmitV2,
        invocation_id: InvocationId,
        preview_id: CapabilityScopePreviewIdV2,
    ) -> Self {
        Self {
            run_id: command.run_id.clone(),
            expected_control_epoch: command.expected_control_epoch,
            operation_id: command.operation_id.clone(),
            idempotency_key: command.idempotency_key.clone(),
            tool_id: command.tool_id.clone(),
            raw_arguments: command.raw_arguments.clone(),
            authority: command.authority.clone(),
            deadline: command.deadline,
            tool_context_ref: command.tool_context_ref.clone(),
            invocation_id,
            preview_id,
        }
    }

    fn into_pending(self, awaiting_fact_id: FactId) -> PendingIntent {
        PendingIntent {
            run_id: self.run_id,
            expected_control_epoch: self.expected_control_epoch,
            operation_id: self.operation_id,
            idempotency_key: self.idempotency_key,
            tool_id: self.tool_id,
            raw_arguments: self.raw_arguments,
            authority: self.authority,
            deadline: self.deadline,
            tool_context_ref: self.tool_context_ref,
            invocation_id: self.invocation_id,
            awaiting_fact_id,
            preview_id: self.preview_id,
        }
    }
}

fn pending_intent_material(
    pending: &DurablePendingIntentV2,
    lifecycle: &str,
    lease: Option<CapabilityLeaseRefV2>,
) -> AuthorityResult<AuthorityMaterialDraftV2> {
    Ok(AuthorityMaterialDraftV2 {
        material_kind: AUTHORITY_MATERIAL_PENDING.to_owned(),
        material_id: pending.preview_id.to_string(),
        run_id: pending.run_id.clone(),
        control_epoch: pending.expected_control_epoch.get(),
        lifecycle: lifecycle.to_owned(),
        operation_id: Some(pending.operation_id.clone()),
        invocation_id: Some(pending.invocation_id.clone()),
        lease,
        payload_json: serde_json::to_value(pending).map_err(|_| storage_fault())?,
    })
}

#[derive(Clone)]
struct PublicCommandContext {
    request_id: CommandRequestId,
    request_digest: CommandRequestDigestV2,
    command_kind: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum DurablePublicReplyV2 {
    Kernel { reply: KernelReplyV2 },
    RunOpen { reply: RunOpenReplyV2 },
    Facts { page: DurableFactPageV2 },
    UserDecision { reply: UserDecisionReplyV2 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableFactPageV2 {
    run_id: RunId,
    requested_after_ledger_sequence: u64,
    snapshot_high_water: u64,
    facts: Vec<KernelFactProjectionV2>,
    has_more: bool,
    next_after_ledger_sequence: u64,
}

struct PublicIdMint {
    nonce: String,
    next: std::sync::atomic::AtomicU64,
}

impl PublicIdMint {
    fn new() -> AuthorityResult<Self> {
        let mut entropy = [0u8; 32];
        getrandom::fill(&mut entropy).map_err(|_| storage_fault())?;
        Ok(Self {
            nonce: lower_hex(&entropy),
            next: std::sync::atomic::AtomicU64::new(1),
        })
    }

    fn raw(&self, kind: &str) -> String {
        let next = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("kv2-{kind}-{}-{next:x}", self.nonce)
    }

    fn run_id(&self) -> RunId {
        RunId::new(self.raw("run")).expect("Kernel-minted RunId is valid")
    }

    fn invocation_id(&self) -> InvocationId {
        InvocationId::new(self.raw("invocation")).expect("Kernel-minted InvocationId is valid")
    }

    fn preview_id(&self) -> CapabilityScopePreviewIdV2 {
        CapabilityScopePreviewIdV2::new(self.raw("preview"))
            .expect("Kernel-minted preview identity is valid")
    }

    fn lease_id(&self) -> CapabilityLeaseIdV2 {
        CapabilityLeaseIdV2::new(self.raw("lease")).expect("Kernel-minted lease identity is valid")
    }

    fn run_capability(&self) -> AuthorityResult<RunCapabilityV2> {
        let mut entropy = [0u8; 32];
        getrandom::fill(&mut entropy).map_err(|_| storage_fault())?;
        RunCapabilityV2::new(format!("run_{}", lower_hex(&entropy))).map_err(|_| storage_fault())
    }
}

impl KernelSessionServiceV2 {
    pub fn open(
        fact_store_path: impl AsRef<Path>,
        executor_config: KernelExecutorConfig,
        secret_provider: Arc<dyn SecretProvider>,
    ) -> AuthorityResult<Self> {
        let store = CanonicalFactStore::open(fact_store_path).map_err(map_store_open_error)?;
        Self::from_store(store, executor_config, secret_provider)
    }

    pub fn from_store(
        store: CanonicalFactStore,
        executor_config: KernelExecutorConfig,
        secret_provider: Arc<dyn SecretProvider>,
    ) -> AuthorityResult<Self> {
        let authority = AuthorityService::open(store, executor_config, secret_provider)?;
        let inventory = build_inventory()?;
        let facts = authority.snapshot_facts()?;
        let recovered_authority =
            recover_authority_material(&facts, authority.authority_material_snapshot()?)?;
        let recovered_runs = recover_public_runs(&facts)?;
        let retired_runs = recover_retired_runs(&facts)?;
        let retirement_fences = recover_retirement_fences(&facts, &retired_runs);
        let preview_runs = recover_scope_preview_runs(&facts)?;
        let mut runtime_availability = recover_runtime_availability(&facts);
        runtime_availability.retain(|(run_id, _), _| recovered_runs.contains_key(run_id));
        let state = KernelSessionState {
            recovered_runs,
            retirement_fences,
            retired_runs,
            preview_runs,
            previews: recovered_authority.previews,
            leases: recovered_authority.leases,
            trusts: recovered_authority.trusts,
            pending: recovered_authority.pending,
            run_capability_verifiers: recovered_authority.run_capability_verifiers,
            runtime_availability,
            ..KernelSessionState::default()
        };
        Ok(Self {
            inner: Arc::new(KernelSessionInner {
                authority,
                inventory,
                state: Mutex::new(state),
                command_gate: Mutex::new(()),
                ids: PublicIdMint::new()?,
            }),
        })
    }

    pub fn tool_inventory(&self) -> ToolInventoryV2 {
        self.inner.inventory.clone()
    }

    /// Atomically replaces the Host-owned executor configuration and secret
    /// bindings. The replacement is fully built before it becomes visible;
    /// in-flight execution retains the runtime snapshot it already acquired.
    pub fn replace_executor_runtime_host(
        &self,
        executor_config: KernelExecutorConfig,
        secret_provider: Arc<dyn SecretProvider>,
    ) -> AuthorityResult<()> {
        let _gate = self
            .inner
            .command_gate
            .lock()
            .map_err(|_| storage_fault())?;
        self.inner
            .authority
            .replace_executor_runtime_host(executor_config, secret_provider)
    }

    /// Host-only read handle for a facts wake broker. This handle contains no
    /// run capability and must not be exposed through the Session command API.
    pub fn fact_reader(&self) -> deepcode_kernel_ledger::v2::CanonicalFactReader {
        self.inner.authority.fact_reader()
    }

    /// Returns a per-run monotonic wake snapshot without exposing any facts or
    /// authority material.
    pub fn run_sequence_high_water(&self, run_id: &RunId) -> AuthorityResult<u64> {
        self.fact_reader()
            .run_sequence_high_waters()
            .map_err(|_| storage_fault())?
            .into_iter()
            .find(|high_water| &high_water.run_id == run_id)
            .map(|high_water| high_water.run_sequence_high_water)
            .ok_or_else(|| KernelErrorV2::RunNotFound {
                run_id: run_id.clone(),
            })
    }

    /// Resolves the exact durable preview that a trusted Host is displaying
    /// into a decision binding. The Host must use this result verbatim when it
    /// mints the short-lived decision capability; projections are not an
    /// authority source.
    pub fn resolve_pending_capability_decision_host(
        &self,
        scope_preview_id: CapabilityScopePreviewIdV2,
        decision_ref: UserDecisionRefV2,
    ) -> AuthorityResult<Result<PendingCapabilityDecisionV2, UserDecisionErrorV2>> {
        let _gate = self
            .inner
            .command_gate
            .lock()
            .map_err(|_| storage_fault())?;
        let (binding, decision_class) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            let Some(preview) = state.previews.get(&scope_preview_id) else {
                if state
                    .preview_runs
                    .get(&scope_preview_id)
                    .is_some_and(|run_id| {
                        state.retirement_fences.contains_key(run_id)
                            || state.retired_runs.contains_key(run_id)
                    })
                {
                    return Ok(Err(UserDecisionErrorV2::ScopePreviewStale));
                }
                return Ok(Err(UserDecisionErrorV2::ScopePreviewNotFound));
            };
            let run_id = preview.record.run_id.clone();
            let expected_control_epoch = preview.record.control_epoch;
            if state.retirement_fences.contains_key(&run_id)
                || state.retired_runs.contains_key(&run_id)
            {
                return Ok(Err(UserDecisionErrorV2::ScopePreviewStale));
            }
            let Some(run) = state.runs.get(&run_id) else {
                return Ok(Err(UserDecisionErrorV2::ScopePreviewNotFound));
            };
            if run.control_epoch != expected_control_epoch {
                return Ok(Err(UserDecisionErrorV2::ScopePreviewStale));
            }
            if preview.record.run_id != run_id
                || preview.record.control_epoch != expected_control_epoch
            {
                return Ok(Err(UserDecisionErrorV2::ScopePreviewStale));
            }
            if preview.record.disposition != CapabilityScopeDispositionV2::RequiresUserDecision {
                return Ok(Err(UserDecisionErrorV2::PlanBindingMismatch));
            }
            let binding = CapabilityDecisionBindingV2 {
                input_id: run.current_input_id.clone(),
                decision_ref,
                scope_preview_id,
                expected_authorization_digest: preview.authorization_digest.clone(),
                plan_revision: preview.record.plan_revision.clone(),
                plan_action_id: preview.record.plan_action_id.clone(),
                scope_digest: preview.record.scope_digest.clone(),
                tool_context_ref: preview.record.context_ref.clone(),
            };
            (binding, preview.decision_class)
        };
        let (run_id, expected_control_epoch) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            let preview = state
                .previews
                .get(&binding.scope_preview_id)
                .ok_or_else(storage_fault)?;
            (preview.record.run_id.clone(), preview.record.control_epoch)
        };
        match self.resolve_decision_preview(&run_id, expected_control_epoch, &binding)? {
            Ok(_) => Ok(Ok(PendingCapabilityDecisionV2 {
                run_id,
                expected_control_epoch,
                class: decision_class.pending_class(),
                binding,
            })),
            Err(error) => Ok(Err(error)),
        }
    }

    /// Resolves a trusted Host revoke request against the current Run state.
    /// The Host supplies only the public target identity and user decision
    /// reference; Kernel binds the decision to the current input and epoch.
    pub fn resolve_user_authority_revoke_host(
        &self,
        run_id: &RunId,
        decision_ref: UserDecisionRefV2,
        target: UserDecisionRevokeTargetV2,
        reason: String,
    ) -> AuthorityResult<Result<(ControlEpoch, UserDecisionV2), UserDecisionErrorV2>> {
        let _gate = self
            .inner
            .command_gate
            .lock()
            .map_err(|_| storage_fault())?;
        self.inner
            .authority
            .require_run_accepting_commands(run_id)?;
        let (control_epoch, input_id, target_exists) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            let run = state
                .runs
                .get(run_id)
                .ok_or_else(|| KernelErrorV2::RunNotFound {
                    run_id: run_id.clone(),
                })?;
            let target_exists = match &target {
                UserDecisionRevokeTargetV2::CapabilityLease { lease_id } => {
                    state.leases.get(lease_id).is_some_and(|lease| {
                        lease.run_id == *run_id && lease.control_epoch == run.control_epoch
                    })
                }
                UserDecisionRevokeTargetV2::TrustPolicy { trust_policy_id } => {
                    state.trusts.get(trust_policy_id).is_some_and(|trust| {
                        trust.run_id == *run_id && trust.control_epoch == run.control_epoch
                    })
                }
            };
            (
                run.control_epoch,
                run.current_input_id.clone(),
                target_exists,
            )
        };
        if !target_exists {
            return Ok(Err(match target {
                UserDecisionRevokeTargetV2::CapabilityLease { .. } => {
                    UserDecisionErrorV2::CapabilityLeaseNotFound
                }
                UserDecisionRevokeTargetV2::TrustPolicy { .. } => {
                    UserDecisionErrorV2::TrustPolicyNotFound
                }
            }));
        }
        let decision = UserDecisionV2::Revoke(UserDecisionRevokeV2 {
            input_id,
            decision_ref,
            target,
            reason,
        });
        decision
            .validate()
            .map_err(|_| invalid_field("decision", InvalidFieldViolationV2::OutOfRange))?;
        Ok(Ok((control_epoch, decision)))
    }

    pub fn shutdown(&self) -> AuthorityResult<()> {
        let _gate = self
            .inner
            .command_gate
            .lock()
            .map_err(|_| storage_fault())?;
        self.inner.authority.join_owned_execution_tasks()
    }

    /// Host-only terminal transition. This is intentionally absent from the
    /// Session command ABI: the typed fence, cancellation, authority-material
    /// invalidation, and final retirement fact are minted inside Kernel.
    pub fn retire_run_host(
        &self,
        run_id: RunId,
        reason_code: RunRetirementReasonCodeV2,
        reason: Option<String>,
    ) -> AuthorityResult<RunRetirementReceiptV2> {
        let gate = self
            .inner
            .command_gate
            .lock()
            .map_err(|_| storage_fault())?;

        let retired_in_memory = {
            self.inner
                .state
                .lock()
                .map_err(|_| storage_fault())?
                .retired_runs
                .get(&run_id)
                .cloned()
        };
        if let Some(retired) = retired_in_memory {
            self.install_retired_run_state(&run_id, retired.clone())?;
            require_same_retirement_reason(&retired, reason_code, reason.as_deref())?;
            return Ok(retired.receipt(run_id, true));
        }
        if let Some(retired) =
            recover_retired_runs(&self.inner.authority.snapshot_facts()?)?.remove(&run_id)
        {
            self.install_retired_run_state(&run_id, retired.clone())?;
            require_same_retirement_reason(&retired, reason_code, reason.as_deref())?;
            return Ok(retired.receipt(run_id, true));
        }

        let (known_epoch, known_causation, existing_fence) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            let recovered = state
                .runs
                .get(&run_id)
                .map(|run| (run.control_epoch, run.control_fact_id.clone()))
                .or_else(|| {
                    state
                        .recovered_runs
                        .get(&run_id)
                        .map(|run| (run.control_epoch, run.control_fact_id.clone()))
                })
                .ok_or_else(|| KernelErrorV2::RunNotFound {
                    run_id: run_id.clone(),
                })?;
            (
                recovered.0,
                recovered.1,
                state.retirement_fences.get(&run_id).cloned(),
            )
        };
        let existing_fence = match existing_fence {
            Some(fence) => Some(fence),
            None => self
                .inner
                .authority
                .run_retirement_fence_host(&run_id)?
                .map(|fence| RunRetirementFenceRecord {
                    control_epoch: fence.control_epoch,
                    fence_fact_id: fence.fence_fact_id,
                    fence_ledger_sequence: fence.fence_ledger_sequence,
                    reason_code: fence.reason_code,
                    reason: fence.reason,
                }),
        };
        KernelFactPayloadV2::Control(ControlFactV2::RunRetired {
            run_id: run_id.clone(),
            control_epoch: existing_fence
                .as_ref()
                .map(|fence| fence.control_epoch)
                .unwrap_or(known_epoch),
            reason_code,
            reason: reason.clone(),
            causation_fact_id: existing_fence
                .as_ref()
                .map(|fence| fence.fence_fact_id.clone())
                .unwrap_or(known_causation),
        })
        .validate()
        .map_err(|_| invalid_field("reason", InvalidFieldViolationV2::OutOfRange))?;

        let fence = if let Some(fence) = existing_fence {
            fence
        } else {
            let reply = self.inner.authority.fence_run_retirement_host(
                &run_id,
                reason_code,
                reason.clone(),
            )?;
            let fence = RunRetirementFenceRecord {
                control_epoch: reply.control_epoch,
                fence_fact_id: reply.fence_fact_id,
                fence_ledger_sequence: reply.fence_ledger_sequence,
                reason_code: reply.reason_code,
                reason: reply.reason,
            };
            let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
            state
                .retirement_fences
                .insert(run_id.clone(), fence.clone());
            if let Some(run) = state.runs.get_mut(&run_id) {
                run.control_epoch = fence.control_epoch;
                run.control_fact_id = fence.fence_fact_id.clone();
            }
            state.run_capability_verifiers.remove(&run_id);
            fence
        };
        require_same_retirement_fence_reason(&fence, reason_code, reason.as_deref())?;
        drop(gate);
        if !self
            .inner
            .authority
            .observe_run_execution_convergence_host(&run_id, RUN_RETIREMENT_CONVERGENCE_BUDGET)?
        {
            return Err(retirement_pending(run_id, &fence));
        }

        let _gate = self
            .inner
            .command_gate
            .lock()
            .map_err(|_| storage_fault())?;
        let retired_in_memory = {
            self.inner
                .state
                .lock()
                .map_err(|_| storage_fault())?
                .retired_runs
                .get(&run_id)
                .cloned()
        };
        if let Some(retired) = retired_in_memory {
            self.install_retired_run_state(&run_id, retired.clone())?;
            require_same_retirement_reason(&retired, reason_code, reason.as_deref())?;
            return Ok(retired.receipt(run_id, true));
        }
        if let Some(retired) =
            recover_retired_runs(&self.inner.authority.snapshot_facts()?)?.remove(&run_id)
        {
            self.install_retired_run_state(&run_id, retired.clone())?;
            require_same_retirement_reason(&retired, reason_code, reason.as_deref())?;
            return Ok(retired.receipt(run_id, true));
        }
        let current_fence = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            state.retirement_fences.get(&run_id).cloned()
        };
        let current_fence = match current_fence {
            Some(current) => current,
            None => self
                .inner
                .authority
                .run_retirement_fence_host(&run_id)?
                .map(|current| RunRetirementFenceRecord {
                    control_epoch: current.control_epoch,
                    fence_fact_id: current.fence_fact_id,
                    fence_ledger_sequence: current.fence_ledger_sequence,
                    reason_code: current.reason_code,
                    reason: current.reason,
                })
                .ok_or_else(storage_fault)?,
        };
        require_same_retirement_fence(&fence, &current_fence)?;
        require_same_retirement_fence_reason(&current_fence, reason_code, reason.as_deref())?;
        if !self
            .inner
            .authority
            .observe_run_execution_convergence_host(&run_id, Duration::ZERO)?
        {
            return Err(retirement_pending(run_id, &current_fence));
        }

        let (mut leases, mut trusts, mut previews, mut pending) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            (
                state
                    .leases
                    .values()
                    .filter(|lease| lease.run_id == run_id)
                    .cloned()
                    .collect::<Vec<_>>(),
                state
                    .trusts
                    .values()
                    .filter(|trust| trust.run_id == run_id)
                    .cloned()
                    .collect::<Vec<_>>(),
                state
                    .previews
                    .values()
                    .filter(|preview| preview.record.run_id == run_id)
                    .cloned()
                    .collect::<Vec<_>>(),
                state
                    .pending
                    .values()
                    .filter(|intent| intent.run_id == run_id)
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        };
        leases.sort_by(|left, right| {
            left.reference
                .lease_id
                .as_str()
                .cmp(right.reference.lease_id.as_str())
        });
        trusts.sort_by(|left, right| {
            left.trust_policy_id
                .as_str()
                .cmp(right.trust_policy_id.as_str())
        });
        previews.sort_by(|left, right| {
            left.record
                .preview_id
                .as_str()
                .cmp(right.record.preview_id.as_str())
        });
        pending.sort_by(|left, right| left.preview_id.as_str().cmp(right.preview_id.as_str()));

        let mut payloads = Vec::with_capacity(leases.len() + trusts.len() + 1);
        for lease in &leases {
            payloads.push(KernelFactPayloadV2::Authorization(
                AuthorizationFactV2::LeaseRevoked {
                    identity: CapabilityLeaseFactIdentityV2 {
                        run_id: run_id.clone(),
                        control_epoch: lease.control_epoch,
                        plan_revision: lease.plan_revision.clone(),
                        plan_action_id: lease.plan_action_id.clone(),
                        operation_id: lease.issuance_operation_id.clone(),
                        preview_id: lease.preview_id.clone(),
                        lease_id: lease.reference.lease_id.clone(),
                        lease_version: lease.reference.version,
                        causation_fact_id: lease.issuance_fact_id.clone(),
                        correlation_set: plan_action_correlations(&lease.plan_action_id)?,
                    },
                    scope_digest: lease.reference.scope_digest.clone(),
                    reason: CapabilityLeaseRevokeReasonV2::RunRetired,
                },
            ));
        }
        for trust in &trusts {
            payloads.push(KernelFactPayloadV2::Authorization(
                AuthorizationFactV2::TrustRevoked {
                    identity: AuthorizationIdentityV2 {
                        run_id: run_id.clone(),
                        control_epoch: trust.control_epoch,
                        plan_revision: trust.plan_revision.clone(),
                        plan_action_id: trust.plan_action_id.clone(),
                        operation_id: trust.issuance_operation_id.clone(),
                        causation_fact_id: trust.fact_id.clone(),
                        correlation_set: plan_action_correlations(&trust.plan_action_id)?,
                    },
                    trust_policy_id: trust.trust_policy_id.clone(),
                    trust_lease_digest: trust.trust_lease_digest.clone(),
                    tool_id: trust.tool_id.clone(),
                    scope_digest: trust.scope_digest.clone(),
                    workspace_binding_digest: trust.workspace_binding_digest.clone(),
                    context_ref: trust.context_ref.clone(),
                    expires_at: trust.expires_at.clone(),
                },
            ));
        }
        let retirement_index = payloads.len();
        payloads.push(KernelFactPayloadV2::Control(ControlFactV2::RunRetired {
            run_id: run_id.clone(),
            control_epoch: fence.control_epoch,
            reason_code,
            reason: reason.clone(),
            causation_fact_id: fence.fence_fact_id.clone(),
        }));

        let mut material_mutations =
            Vec::with_capacity(leases.len() + trusts.len() + previews.len() + pending.len() + 1);
        for (fact_index, lease) in leases.iter().enumerate() {
            material_mutations.push(AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_RETIREMENT_PENDING.to_owned(),
                expected_payload_digest: None,
                material: capability_lease_material(&lease.durable(), AUTHORITY_MATERIAL_REVOKED)?,
                fact_index,
            });
        }
        for (offset, trust) in trusts.iter().enumerate() {
            material_mutations.push(AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_RETIREMENT_PENDING.to_owned(),
                expected_payload_digest: None,
                material: trust_lease_material(&trust.durable(), AUTHORITY_MATERIAL_REVOKED)?,
                fact_index: leases.len() + offset,
            });
        }
        for preview in &previews {
            material_mutations.push(AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_RETIREMENT_PENDING.to_owned(),
                expected_payload_digest: None,
                material: scope_preview_material(&preview.durable(), AUTHORITY_MATERIAL_STALE)?,
                fact_index: retirement_index,
            });
        }
        for intent in &pending {
            let lease = match &intent.authority {
                ToolIntentAuthorityV2::PlanAction { lease, .. } => lease.clone(),
                ToolIntentAuthorityV2::ContextRead { .. } => None,
            };
            material_mutations.push(AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_RETIREMENT_PENDING.to_owned(),
                expected_payload_digest: None,
                material: pending_intent_material(
                    &intent.durable(),
                    AUTHORITY_MATERIAL_STALE,
                    lease,
                )?,
                fact_index: retirement_index,
            });
        }
        material_mutations.push(AuthorityMaterialMutationV2::TransitionRunEpoch {
            run_id: run_id.clone(),
            through_control_epoch: fence.control_epoch.get(),
            expected_lifecycles: vec![AUTHORITY_MATERIAL_RETIREMENT_PENDING.to_owned()],
            next_lifecycle: AUTHORITY_MATERIAL_STALE.to_owned(),
            fact_index: retirement_index,
        });

        let committed = self
            .inner
            .authority
            .append_payloads_with_authority_material(payloads, material_mutations)?
            .facts;
        let retirement_fact = committed.get(retirement_index).ok_or_else(storage_fault)?;
        let KernelFactPayloadV2::Control(ControlFactV2::RunRetired {
            run_id: committed_run_id,
            control_epoch,
            reason_code: committed_reason_code,
            reason: committed_reason,
            ..
        }) = &retirement_fact.payload
        else {
            return Err(storage_fault());
        };
        if committed_run_id != &run_id
            || *control_epoch != fence.control_epoch
            || *committed_reason_code != reason_code
            || committed_reason != &reason
        {
            return Err(storage_fault());
        }
        let retired = RetiredRunRecord {
            control_epoch: *control_epoch,
            reason_code: *committed_reason_code,
            reason: committed_reason.clone(),
            retirement_fact_id: retirement_fact.fact_id.clone(),
            ledger_sequence: retirement_fact.ledger_sequence,
        };
        self.install_retired_run_state(&run_id, retired.clone())?;
        Ok(retired.receipt(run_id, false))
    }

    /// Host-only runtime health transition. Compile-time Disabled tools can
    /// never be enabled, and runtime availability can only shrink from Ready.
    pub fn set_run_tool_availability_host(
        &self,
        run_id: RunId,
        tool_id: ToolIdV2,
        availability: ToolAvailabilityV2,
    ) -> AuthorityResult<ToolContextBundleV2> {
        let _gate = self
            .inner
            .command_gate
            .lock()
            .map_err(|_| storage_fault())?;
        self.set_run_tool_availability_host_locked(run_id, tool_id, availability)
    }

    fn set_run_tool_availability_host_locked(
        &self,
        run_id: RunId,
        tool_id: ToolIdV2,
        availability: ToolAvailabilityV2,
    ) -> AuthorityResult<ToolContextBundleV2> {
        self.inner
            .authority
            .require_run_accepting_commands(&run_id)?;
        if !matches!(
            availability,
            ToolAvailabilityV2::Revoked | ToolAvailabilityV2::Unavailable
        ) {
            return Err(invalid_field(
                "availability",
                InvalidFieldViolationV2::InvalidEnum,
            ));
        }
        let descriptor = self
            .inner
            .inventory
            .tools
            .iter()
            .find(|descriptor| descriptor.tool_id == tool_id)
            .cloned()
            .ok_or_else(|| invalid_field("toolId", InvalidFieldViolationV2::InvalidEnum))?;
        if descriptor.availability != ToolAvailabilityV2::Ready {
            return Err(invalid_field(
                "toolId",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let (run, current, settings, runtime_availability, leases, trusts, previews, pending) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            let run =
                state
                    .runs
                    .get(&run_id)
                    .cloned()
                    .ok_or_else(|| KernelErrorV2::RunNotFound {
                        run_id: run_id.clone(),
                    })?;
            let current = state
                .runtime_availability
                .get(&(run_id.clone(), tool_id.clone()))
                .copied()
                .unwrap_or(descriptor.availability);
            let settings = state
                .run_settings
                .get(&run_id)
                .cloned()
                .ok_or_else(storage_fault)?;
            let runtime_availability = state.runtime_availability.clone();
            let leases = state
                .leases
                .values()
                .filter(|lease| lease.run_id == run_id && lease.tool_id == tool_id)
                .cloned()
                .collect::<Vec<_>>();
            let trusts = state
                .trusts
                .values()
                .filter(|trust| trust.run_id == run_id && trust.tool_id == tool_id)
                .cloned()
                .collect::<Vec<_>>();
            let previews = state
                .previews
                .values()
                .filter(|preview| {
                    preview.record.run_id == run_id && preview.record.tool_id == tool_id
                })
                .cloned()
                .collect::<Vec<_>>();
            let pending = state
                .pending
                .values()
                .filter(|pending| pending.run_id == run_id && pending.tool_id == tool_id)
                .cloned()
                .collect::<Vec<_>>();
            (
                run,
                current,
                settings,
                runtime_availability,
                leases,
                trusts,
                previews,
                pending,
            )
        };
        if current == availability {
            return self.build_tool_context(&run_id, run.context_version);
        }
        if current != ToolAvailabilityV2::Ready {
            return Err(invalid_field(
                "availability",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let next_context_version = ToolContextVersionV2::new(
            run.context_version
                .get()
                .checked_add(1)
                .ok_or_else(storage_fault)?,
        )
        .map_err(|_| storage_fault())?;
        let reason = match availability {
            ToolAvailabilityV2::Revoked => ToolContextInvalidationReasonV2::ToolRevoked,
            ToolAvailabilityV2::Unavailable => ToolContextInvalidationReasonV2::ToolUnavailable,
            _ => unreachable!("validated runtime availability shrink"),
        };
        let settings_ceiling_digest = self.settings_ceiling_digest(&run_id)?;
        let mut next_runtime_availability = runtime_availability;
        next_runtime_availability.insert((run_id.clone(), tool_id.clone()), availability);
        let next_context = self.build_tool_context_from_inputs(
            &run_id,
            next_context_version,
            &settings,
            &next_runtime_availability,
        )?;

        // The durable invalidation is committed before any in-memory
        // availability or context version changes.
        let mut payloads = vec![KernelFactPayloadV2::Authorization(
            AuthorizationFactV2::ContextInvalidated {
                identity: ToolContextInvalidationIdentityV2 {
                    run_id: run_id.clone(),
                    control_epoch: run.control_epoch,
                    causation_fact_id: run.control_fact_id.clone(),
                },
                previous_context: run.context_ref.clone(),
                next_context_version,
                next_context_ref: next_context.context_ref(),
                settings_ceiling_digest,
                tool_id: Some(tool_id.clone()),
                availability: Some(availability),
                reason,
            },
        )];
        for lease in &leases {
            payloads.push(KernelFactPayloadV2::Authorization(
                AuthorizationFactV2::LeaseRevoked {
                    identity: CapabilityLeaseFactIdentityV2 {
                        run_id: run_id.clone(),
                        control_epoch: run.control_epoch,
                        plan_revision: lease.plan_revision.clone(),
                        plan_action_id: lease.plan_action_id.clone(),
                        operation_id: lease.issuance_operation_id.clone(),
                        preview_id: lease.preview_id.clone(),
                        lease_id: lease.reference.lease_id.clone(),
                        lease_version: lease.reference.version,
                        causation_fact_id: lease.issuance_fact_id.clone(),
                        correlation_set: plan_action_correlations(&lease.plan_action_id)?,
                    },
                    scope_digest: lease.reference.scope_digest.clone(),
                    reason: CapabilityLeaseRevokeReasonV2::ToolRevoked,
                },
            ));
        }
        for trust in &trusts {
            payloads.push(KernelFactPayloadV2::Authorization(
                AuthorizationFactV2::TrustRevoked {
                    identity: AuthorizationIdentityV2 {
                        run_id: run_id.clone(),
                        control_epoch: run.control_epoch,
                        plan_revision: trust.plan_revision.clone(),
                        plan_action_id: trust.plan_action_id.clone(),
                        operation_id: trust.issuance_operation_id.clone(),
                        causation_fact_id: trust.fact_id.clone(),
                        correlation_set: plan_action_correlations(&trust.plan_action_id)?,
                    },
                    trust_policy_id: trust.trust_policy_id.clone(),
                    trust_lease_digest: trust.trust_lease_digest.clone(),
                    tool_id: trust.tool_id.clone(),
                    scope_digest: trust.scope_digest.clone(),
                    workspace_binding_digest: trust.workspace_binding_digest.clone(),
                    context_ref: trust.context_ref.clone(),
                    expires_at: trust.expires_at.clone(),
                },
            ));
        }
        let mut material_mutations =
            Vec::with_capacity(leases.len() + trusts.len() + previews.len() + pending.len());
        for (offset, lease) in leases.iter().enumerate() {
            material_mutations.push(AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_ACTIVE.to_owned(),
                expected_payload_digest: None,
                material: capability_lease_material(&lease.durable(), AUTHORITY_MATERIAL_REVOKED)?,
                fact_index: 1 + offset,
            });
        }
        for (offset, trust) in trusts.iter().enumerate() {
            material_mutations.push(AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_ACTIVE.to_owned(),
                expected_payload_digest: None,
                material: trust_lease_material(&trust.durable(), AUTHORITY_MATERIAL_REVOKED)?,
                fact_index: 1 + leases.len() + offset,
            });
        }
        for preview in &previews {
            material_mutations.push(AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_ACTIVE.to_owned(),
                expected_payload_digest: None,
                material: scope_preview_material(&preview.durable(), AUTHORITY_MATERIAL_STALE)?,
                fact_index: 0,
            });
        }
        for pending in &pending {
            let lease = match &pending.authority {
                ToolIntentAuthorityV2::PlanAction { lease, .. } => lease.clone(),
                ToolIntentAuthorityV2::ContextRead { .. } => None,
            };
            material_mutations.push(AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_AWAITING.to_owned(),
                expected_payload_digest: None,
                material: pending_intent_material(
                    &pending.durable(),
                    AUTHORITY_MATERIAL_STALE,
                    lease,
                )?,
                fact_index: 0,
            });
        }
        let committed = self
            .inner
            .authority
            .append_payloads_with_authority_material(payloads, material_mutations)?
            .facts;
        let invalidation_fact_id = committed
            .first()
            .map(|fact| fact.fact_id.clone())
            .ok_or_else(storage_fault)?;
        {
            let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
            let active = state
                .runs
                .get_mut(&run_id)
                .ok_or_else(|| KernelErrorV2::RunNotFound {
                    run_id: run_id.clone(),
                })?;
            if active.control_epoch != run.control_epoch
                || active.context_version != run.context_version
            {
                return Err(storage_fault());
            }
            active.context_version = next_context_version;
            active.context_ref = next_context.context_ref();
            active.control_fact_id = invalidation_fact_id;
            state
                .runtime_availability
                .insert((run_id.clone(), tool_id.clone()), availability);
            state
                .leases
                .retain(|_, lease| lease.run_id != run_id || lease.tool_id != tool_id);
            state
                .trusts
                .retain(|_, trust| trust.run_id != run_id || trust.tool_id != tool_id);
            state.previews.retain(|_, preview| {
                preview.record.run_id != run_id || preview.record.tool_id != tool_id
            });
            state
                .pending
                .retain(|_, pending| pending.run_id != run_id || pending.tool_id != tool_id);
        }
        Ok(next_context)
    }

    fn reconcile_executor_unavailability_for_run_locked(
        &self,
        run_id: &RunId,
    ) -> AuthorityResult<()> {
        for tool_id in self.inner.authority.runtime_unavailable_tool_ids()? {
            let descriptor = self
                .inner
                .inventory
                .tools
                .iter()
                .find(|descriptor| descriptor.tool_id == tool_id)
                .ok_or_else(storage_fault)?;
            if descriptor.availability != ToolAvailabilityV2::Ready {
                return Err(storage_fault());
            }
            let current = self
                .inner
                .state
                .lock()
                .map_err(|_| storage_fault())?
                .runtime_availability
                .get(&(run_id.clone(), tool_id.clone()))
                .copied()
                .unwrap_or(descriptor.availability);
            if current == ToolAvailabilityV2::Ready {
                self.set_run_tool_availability_host_locked(
                    run_id.clone(),
                    tool_id,
                    ToolAvailabilityV2::Unavailable,
                )?;
            }
        }
        Ok(())
    }

    /// Returns the current per-run Settings ceiling to trusted in-process Host
    /// orchestration. This value is never included in Session command replies.
    pub fn run_settings_ceiling_host(&self, run_id: &RunId) -> AuthorityResult<SettingsCeilingV2> {
        let _gate = self
            .inner
            .command_gate
            .lock()
            .map_err(|_| storage_fault())?;
        self.inner
            .authority
            .require_run_accepting_commands(run_id)?;
        self.inner
            .state
            .lock()
            .map_err(|_| storage_fault())?
            .run_settings
            .get(run_id)
            .cloned()
            .ok_or_else(storage_fault)
    }

    fn update_run_settings_ceiling_host_locked(
        &self,
        run_id: RunId,
        next: SettingsCeilingV2,
    ) -> AuthorityResult<ToolContextBundleV2> {
        self.inner
            .authority
            .require_run_accepting_commands(&run_id)?;
        let next_settings_digest = settings_digest(&next)?;
        let (run, runtime_availability, leases, trusts, previews, pending) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            let run =
                state
                    .runs
                    .get(&run_id)
                    .cloned()
                    .ok_or_else(|| KernelErrorV2::RunNotFound {
                        run_id: run_id.clone(),
                    })?;
            if !state.run_settings.contains_key(&run_id) {
                return Err(storage_fault());
            }
            let leases = state
                .leases
                .values()
                .filter(|lease| lease.run_id == run_id)
                .cloned()
                .collect::<Vec<_>>();
            let trusts = state
                .trusts
                .values()
                .filter(|trust| trust.run_id == run_id)
                .cloned()
                .collect::<Vec<_>>();
            let previews = state
                .previews
                .values()
                .filter(|preview| preview.record.run_id == run_id)
                .cloned()
                .collect::<Vec<_>>();
            let pending = state
                .pending
                .values()
                .filter(|pending| pending.run_id == run_id)
                .cloned()
                .collect::<Vec<_>>();
            (
                run,
                state.runtime_availability.clone(),
                leases,
                trusts,
                previews,
                pending,
            )
        };
        let current_candidate = self.build_tool_context_from_inputs(
            &run_id,
            run.context_version,
            &next,
            &runtime_availability,
        )?;
        if run.settings_ceiling_digest == next_settings_digest
            && run.context_ref == current_candidate.context_ref()
        {
            return Ok(current_candidate);
        }
        let invalidation_reason = if run.settings_ceiling_digest != next_settings_digest {
            ToolContextInvalidationReasonV2::SettingsChanged
        } else {
            ToolContextInvalidationReasonV2::RegistryChanged
        };
        let lease_revoke_reason =
            if invalidation_reason == ToolContextInvalidationReasonV2::SettingsChanged {
                CapabilityLeaseRevokeReasonV2::SettingsChanged
            } else {
                CapabilityLeaseRevokeReasonV2::ToolContextChanged
            };
        let next_context_version = ToolContextVersionV2::new(
            run.context_version
                .get()
                .checked_add(1)
                .ok_or_else(storage_fault)?,
        )
        .map_err(|_| storage_fault())?;
        let next_context = self.build_tool_context_from_inputs(
            &run_id,
            next_context_version,
            &next,
            &runtime_availability,
        )?;
        let mut payloads = vec![KernelFactPayloadV2::Authorization(
            AuthorizationFactV2::ContextInvalidated {
                identity: ToolContextInvalidationIdentityV2 {
                    run_id: run_id.clone(),
                    control_epoch: run.control_epoch,
                    causation_fact_id: run.control_fact_id.clone(),
                },
                previous_context: run.context_ref.clone(),
                next_context_version,
                next_context_ref: next_context.context_ref(),
                settings_ceiling_digest: next_settings_digest.clone(),
                tool_id: None,
                availability: None,
                reason: invalidation_reason,
            },
        )];
        for lease in &leases {
            payloads.push(KernelFactPayloadV2::Authorization(
                AuthorizationFactV2::LeaseRevoked {
                    identity: CapabilityLeaseFactIdentityV2 {
                        run_id: run_id.clone(),
                        control_epoch: run.control_epoch,
                        plan_revision: lease.plan_revision.clone(),
                        plan_action_id: lease.plan_action_id.clone(),
                        operation_id: lease.issuance_operation_id.clone(),
                        preview_id: lease.preview_id.clone(),
                        lease_id: lease.reference.lease_id.clone(),
                        lease_version: lease.reference.version,
                        causation_fact_id: lease.issuance_fact_id.clone(),
                        correlation_set: plan_action_correlations(&lease.plan_action_id)?,
                    },
                    scope_digest: lease.reference.scope_digest.clone(),
                    reason: lease_revoke_reason,
                },
            ));
        }
        for trust in &trusts {
            payloads.push(KernelFactPayloadV2::Authorization(
                AuthorizationFactV2::TrustRevoked {
                    identity: AuthorizationIdentityV2 {
                        run_id: run_id.clone(),
                        control_epoch: run.control_epoch,
                        plan_revision: trust.plan_revision.clone(),
                        plan_action_id: trust.plan_action_id.clone(),
                        operation_id: trust.issuance_operation_id.clone(),
                        causation_fact_id: trust.fact_id.clone(),
                        correlation_set: plan_action_correlations(&trust.plan_action_id)?,
                    },
                    trust_policy_id: trust.trust_policy_id.clone(),
                    trust_lease_digest: trust.trust_lease_digest.clone(),
                    tool_id: trust.tool_id.clone(),
                    scope_digest: trust.scope_digest.clone(),
                    workspace_binding_digest: trust.workspace_binding_digest.clone(),
                    context_ref: trust.context_ref.clone(),
                    expires_at: trust.expires_at.clone(),
                },
            ));
        }

        // The complete invalidation/revocation batch is durable before the
        // effective Settings ceiling changes in memory.
        let mut material_mutations =
            Vec::with_capacity(leases.len() + trusts.len() + previews.len() + pending.len());
        for (offset, lease) in leases.iter().enumerate() {
            material_mutations.push(AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_ACTIVE.to_owned(),
                expected_payload_digest: None,
                material: capability_lease_material(&lease.durable(), AUTHORITY_MATERIAL_REVOKED)?,
                fact_index: 1 + offset,
            });
        }
        for (offset, trust) in trusts.iter().enumerate() {
            material_mutations.push(AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_ACTIVE.to_owned(),
                expected_payload_digest: None,
                material: trust_lease_material(&trust.durable(), AUTHORITY_MATERIAL_REVOKED)?,
                fact_index: 1 + leases.len() + offset,
            });
        }
        for preview in &previews {
            material_mutations.push(AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_ACTIVE.to_owned(),
                expected_payload_digest: None,
                material: scope_preview_material(&preview.durable(), AUTHORITY_MATERIAL_STALE)?,
                fact_index: 0,
            });
        }
        for pending in &pending {
            let lease = match &pending.authority {
                ToolIntentAuthorityV2::PlanAction { lease, .. } => lease.clone(),
                ToolIntentAuthorityV2::ContextRead { .. } => None,
            };
            material_mutations.push(AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_AWAITING.to_owned(),
                expected_payload_digest: None,
                material: pending_intent_material(
                    &pending.durable(),
                    AUTHORITY_MATERIAL_STALE,
                    lease,
                )?,
                fact_index: 0,
            });
        }
        let committed = self
            .inner
            .authority
            .append_payloads_with_authority_material(payloads, material_mutations)?
            .facts;
        let causation_fact_id = committed
            .first()
            .map(|fact| fact.fact_id.clone())
            .ok_or_else(storage_fault)?;
        {
            let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
            let active = state
                .runs
                .get_mut(&run_id)
                .ok_or_else(|| KernelErrorV2::RunNotFound {
                    run_id: run_id.clone(),
                })?;
            if active.control_epoch != run.control_epoch
                || active.context_version != run.context_version
            {
                return Err(storage_fault());
            }
            active.context_version = next_context_version;
            active.context_ref = next_context.context_ref();
            active.settings_ceiling_digest = next_settings_digest;
            active.control_fact_id = causation_fact_id;
            state.run_settings.insert(run_id.clone(), next);
            state.leases.retain(|_, lease| lease.run_id != run_id);
            state.trusts.retain(|_, trust| trust.run_id != run_id);
            state
                .previews
                .retain(|_, preview| preview.record.run_id != run_id);
            state.pending.retain(|_, pending| pending.run_id != run_id);
        }
        Ok(next_context)
    }

    pub fn resume_run_host(
        &self,
        run_id: RunId,
        workspace_binding_ref: WorkspaceBindingRefV2,
        workspace_root: &Path,
        settings: SettingsCeilingV2,
    ) -> AuthorityResult<HostResumedRunV2> {
        let _gate = self
            .inner
            .command_gate
            .lock()
            .map_err(|_| storage_fault())?;
        self.resume_run_host_locked(run_id, workspace_binding_ref, workspace_root, settings)
    }

    fn resume_run_host_locked(
        &self,
        run_id: RunId,
        workspace_binding_ref: WorkspaceBindingRefV2,
        workspace_root: &Path,
        settings: SettingsCeilingV2,
    ) -> AuthorityResult<HostResumedRunV2> {
        let (active, recovered) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            if state.retirement_fences.contains_key(&run_id)
                || state.retired_runs.contains_key(&run_id)
            {
                return Err(KernelErrorV2::RunNotFound {
                    run_id: run_id.clone(),
                });
            }
            (
                state.runs.get(&run_id).cloned(),
                state.recovered_runs.get(&run_id).cloned(),
            )
        };
        let expected_binding_ref = active
            .as_ref()
            .map(|run| &run.workspace_binding_ref)
            .or_else(|| recovered.as_ref().map(|run| &run.workspace_binding_ref))
            .ok_or_else(|| KernelErrorV2::RunNotFound {
                run_id: run_id.clone(),
            })?;
        if expected_binding_ref != &workspace_binding_ref {
            return Err(invalid_field(
                "workspaceBindingRef",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let binding = self
            .inner
            .authority
            .bind_run_workspace(&run_id, workspace_root)?;
        let expected_binding_digest = active
            .as_ref()
            .map(|run| &run.workspace_binding_digest)
            .or_else(|| recovered.as_ref().map(|run| &run.workspace_binding_digest))
            .ok_or_else(storage_fault)?;
        if &binding.digest != expected_binding_digest {
            return Err(invalid_field(
                "workspaceBindingRef",
                InvalidFieldViolationV2::OutOfRange,
            ));
        }

        if let Some(active) = active {
            let requested_settings_digest = settings_digest(&settings)?;
            if requested_settings_digest != active.settings_ceiling_digest {
                return Err(invalid_field(
                    "settings",
                    InvalidFieldViolationV2::InvalidRelation,
                ));
            }
            let runtime_availability = self
                .inner
                .state
                .lock()
                .map_err(|_| storage_fault())?
                .runtime_availability
                .clone();
            let tool_context = self.build_tool_context_from_inputs(
                &run_id,
                active.context_version,
                &settings,
                &runtime_availability,
            )?;
            if tool_context.context_ref() != active.context_ref {
                return Err(storage_fault());
            }
            return Ok(HostResumedRunV2 {
                run_open_reply: RunOpenReplyV2 {
                    run_id,
                    control_epoch: active.control_epoch,
                    workspace_binding_digest: binding.digest,
                    tool_context,
                },
                run_capability: active.capability,
                transport_generation: active.transport_generation,
                disposition: HostRunResumeDispositionV2::ReplayedActive,
            });
        }

        let recovered = recovered.ok_or_else(storage_fault)?;
        if settings_digest(&settings)? != recovered.settings_ceiling_digest {
            return Err(invalid_field(
                "settings",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let run_capability = self.inner.ids.run_capability()?;
        let rebound = self.inner.authority.rebind_run_capability_host(
            &run_id,
            recovered.control_epoch,
            &run_capability,
        )?;
        {
            let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
            if state.runs.contains_key(&run_id)
                || state.recovered_runs.get(&run_id).is_none_or(|current| {
                    current.control_epoch != recovered.control_epoch
                        || current.context_ref != recovered.context_ref
                })
            {
                return Err(storage_fault());
            }
            state.runs.insert(
                run_id.clone(),
                PublicRunRecord {
                    capability: run_capability.clone(),
                    transport_generation: rebound.transport_generation,
                    workspace_binding_ref,
                    workspace_binding_digest: binding.digest.clone(),
                    settings_ceiling_digest: recovered.settings_ceiling_digest,
                    control_epoch: recovered.control_epoch,
                    current_input_id: recovered.current_input_id,
                    context_version: recovered.context_version,
                    context_ref: recovered.context_ref,
                    control_fact_id: recovered.control_fact_id,
                },
            );
            state.run_capability_verifiers.insert(
                run_id.clone(),
                run_capability_verifier_digest(&run_id, &run_capability),
            );
            state.run_settings.insert(run_id.clone(), settings.clone());
            state.recovered_runs.remove(&run_id);
        }
        self.reconcile_executor_unavailability_for_run_locked(&run_id)?;
        let tool_context =
            self.update_run_settings_ceiling_host_locked(run_id.clone(), settings)?;
        let reply = RunOpenReplyV2 {
            run_id,
            control_epoch: recovered.control_epoch,
            workspace_binding_digest: binding.digest,
            tool_context,
        };
        Ok(HostResumedRunV2 {
            run_open_reply: reply,
            run_capability,
            transport_generation: rebound.transport_generation,
            disposition: HostRunResumeDispositionV2::RotatedRecovered {
                rebind_fact_id: rebound.fact_id,
                rebind_ledger_sequence: rebound.ledger_sequence,
            },
        })
    }

    pub fn open_run(
        &self,
        envelope: KernelCommandEnvelopeV2,
        workspace_root: &Path,
        settings: SettingsCeilingV2,
    ) -> OpenedRunTransportV2 {
        let _gate = match self.inner.command_gate.lock() {
            Ok(gate) => gate,
            Err(_) => {
                return OpenedRunTransportV2 {
                    response: response(envelope.request_id, Err(storage_fault())),
                    run_capability: None,
                };
            }
        };
        let request_id = envelope.request_id.clone();
        let result = envelope
            .validate()
            .map_err(|_| invalid_field("command", InvalidFieldViolationV2::OutOfRange))
            .and_then(|_| match envelope.command.clone() {
                KernelCommandV2::RunOpen(command) => {
                    self.open_run_command(&envelope, command, workspace_root, settings)
                }
                _ => Err(invalid_field(
                    "command.kind",
                    InvalidFieldViolationV2::InvalidEnum,
                )),
            });
        match result {
            Ok((reply, handling, run_capability)) => OpenedRunTransportV2 {
                response: response(request_id, Ok((reply, handling))),
                run_capability,
            },
            Err(error) => OpenedRunTransportV2 {
                response: response(request_id, Err(error)),
                run_capability: None,
            },
        }
    }

    pub fn handle_session_command(
        &self,
        envelope: KernelCommandEnvelopeV2,
        transport_run_capability: &RunCapabilityV2,
    ) -> KernelCommandResponseEnvelopeV2 {
        let _gate = match self.inner.command_gate.lock() {
            Ok(gate) => gate,
            Err(_) => {
                return response(envelope.request_id, Err(storage_fault()));
            }
        };
        let request_id = envelope.request_id.clone();
        let result = envelope
            .validate()
            .map_err(|_| invalid_field("command", InvalidFieldViolationV2::OutOfRange))
            .and_then(|_| self.replay_or_evaluate(&envelope, transport_run_capability));
        response(request_id, result)
    }

    pub fn apply_host_user_decision(
        &self,
        request_id: CommandRequestId,
        run_id: RunId,
        expected_control_epoch: ControlEpoch,
        decision: UserDecisionV2,
    ) -> AuthorityResult<(UserDecisionReplyV2, CommandHandlingV2)> {
        let _gate = self
            .inner
            .command_gate
            .lock()
            .map_err(|_| storage_fault())?;
        let request_digest =
            user_decision_request_digest_v2(&run_id, expected_control_epoch, &decision)
                .map_err(|_| storage_fault())?;
        if let Some(replayed) = self.lookup_replay(&request_id, &request_digest)? {
            return match replayed {
                DurablePublicReplyV2::UserDecision { reply } => {
                    Ok((reply, CommandHandlingV2::Replayed))
                }
                _ => Err(storage_fault()),
            };
        }
        let (retirement_epoch, run) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            (
                state
                    .retirement_fences
                    .get(&run_id)
                    .map(|fence| fence.control_epoch)
                    .or_else(|| {
                        state
                            .retired_runs
                            .get(&run_id)
                            .map(|retired| retired.control_epoch)
                    }),
                state.runs.get(&run_id).cloned(),
            )
        };
        if let Some(current) = retirement_epoch {
            return self.persist_user_decision_reply(
                request_id,
                request_digest,
                run_id,
                UserDecisionReplyV2::Stale {
                    submitted: expected_control_epoch,
                    current,
                },
            );
        }
        decision
            .validate()
            .map_err(|_| invalid_field("decision", InvalidFieldViolationV2::OutOfRange))?;
        let Some(run) = run else {
            return self.persist_user_decision_reply(
                request_id,
                request_digest,
                run_id,
                UserDecisionReplyV2::Error(UserDecisionErrorV2::ScopePreviewNotFound),
            );
        };
        if run.control_epoch != expected_control_epoch {
            return self.persist_user_decision_reply(
                request_id,
                request_digest,
                run_id,
                UserDecisionReplyV2::Stale {
                    submitted: expected_control_epoch,
                    current: run.control_epoch,
                },
            );
        }

        let public_command = PublicCommandContext {
            request_id: request_id.clone(),
            request_digest: request_digest.clone(),
            command_kind: "userDecision",
        };
        let (reply, receipt_persisted) = match decision {
            UserDecisionV2::CapabilityAllow(binding) => self.allow_capability_decision(
                &run_id,
                expected_control_epoch,
                binding,
                false,
                public_command.clone(),
            )?,
            UserDecisionV2::ScopeExpansionAllow(binding) => self.allow_capability_decision(
                &run_id,
                expected_control_epoch,
                binding,
                true,
                public_command.clone(),
            )?,
            UserDecisionV2::CapabilityDeny { binding, guidance } => self.deny_capability_decision(
                &run_id,
                expected_control_epoch,
                binding,
                guidance,
                false,
                public_command.clone(),
            )?,
            UserDecisionV2::ScopeExpansionDeny { binding, guidance } => self
                .deny_capability_decision(
                    &run_id,
                    expected_control_epoch,
                    binding,
                    guidance,
                    true,
                    public_command.clone(),
                )?,
            UserDecisionV2::TrustGrant(decision) => self.grant_trust(
                &run_id,
                expected_control_epoch,
                decision,
                public_command.clone(),
            )?,
            UserDecisionV2::Revoke(decision) => {
                if decision.input_id != run.current_input_id {
                    (
                        UserDecisionReplyV2::Error(UserDecisionErrorV2::PlanBindingMismatch),
                        false,
                    )
                } else {
                    self.revoke_user_authority(
                        &run_id,
                        expected_control_epoch,
                        decision.decision_ref,
                        decision.target,
                        public_command,
                    )?
                }
            }
        };
        if receipt_persisted {
            return Ok((reply, CommandHandlingV2::Evaluated));
        }
        self.persist_user_decision_reply(request_id, request_digest, run_id, reply)
    }
}

impl Drop for KernelSessionServiceV2 {
    fn drop(&mut self) {
        if Arc::strong_count(&self.inner) == 1 {
            let _ = self.inner.authority.join_owned_execution_tasks();
        }
    }
}

impl KernelSessionServiceV2 {
    fn open_run_command(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        command: RunOpenV2,
        workspace_root: &Path,
        settings: SettingsCeilingV2,
    ) -> AuthorityResult<(KernelReplyV2, CommandHandlingV2, Option<RunCapabilityV2>)> {
        let requested_binding = resolve_workspace_binding(workspace_root)?;
        let requested_settings_digest = settings_digest(&settings)?;
        let digest = run_open_host_request_digest(
            &envelope.command,
            &requested_binding.digest,
            &requested_settings_digest,
        )?;
        if let Some(replayed) = self.lookup_replay(&envelope.request_id, &digest)? {
            let DurablePublicReplyV2::RunOpen { reply: opened } = replayed else {
                return Err(storage_fault());
            };
            if opened.workspace_binding_digest != requested_binding.digest {
                return Err(storage_fault());
            }
            let run_id = opened.run_id.clone();
            let (retirement_tombstoned, active) = {
                let state = self.inner.state.lock().map_err(|_| storage_fault())?;
                (
                    state.retirement_fences.contains_key(&run_id)
                        || state.retired_runs.contains_key(&run_id),
                    state.runs.get(&run_id).cloned(),
                )
            };
            if retirement_tombstoned {
                return Ok((
                    KernelReplyV2::RunOpened(opened),
                    CommandHandlingV2::Replayed,
                    None,
                ));
            }
            let run_capability = match active {
                Some(active)
                    if active.workspace_binding_ref == command.workspace_binding_ref
                        && active.workspace_binding_digest == opened.workspace_binding_digest =>
                {
                    Some(active.capability)
                }
                Some(_) => return Err(storage_fault()),
                None => None,
            };
            return Ok((
                KernelReplyV2::RunOpened(opened),
                CommandHandlingV2::Replayed,
                run_capability,
            ));
        }

        let run_id = self.inner.ids.run_id();
        let run_capability = self.inner.ids.run_capability()?;
        let binding = self
            .inner
            .authority
            .bind_resolved_run_workspace(&run_id, requested_binding)?;
        let initial_context_version = ToolContextVersionV2::new(1).map_err(|_| storage_fault())?;
        let settings_ceiling_digest = requested_settings_digest;
        let mut runtime_availability = self
            .inner
            .state
            .lock()
            .map_err(|_| storage_fault())?
            .runtime_availability
            .clone();
        let initial_tool_context = self.build_tool_context_from_inputs(
            &run_id,
            initial_context_version,
            &settings,
            &runtime_availability,
        )?;
        let mut tool_context = initial_tool_context.clone();
        let mut initial_context_invalidations = Vec::new();
        let mut initially_unavailable_tool_ids = Vec::new();
        for tool_id in self.inner.authority.runtime_unavailable_tool_ids()? {
            let descriptor = self
                .inner
                .inventory
                .tools
                .iter()
                .find(|descriptor| descriptor.tool_id == tool_id)
                .ok_or_else(storage_fault)?;
            if descriptor.availability != ToolAvailabilityV2::Ready
                || runtime_availability
                    .get(&(run_id.clone(), tool_id.clone()))
                    .copied()
                    .unwrap_or(descriptor.availability)
                    != ToolAvailabilityV2::Ready
            {
                return Err(storage_fault());
            }
            let next_context_version = ToolContextVersionV2::new(
                tool_context
                    .context_version
                    .get()
                    .checked_add(1)
                    .ok_or_else(storage_fault)?,
            )
            .map_err(|_| storage_fault())?;
            runtime_availability.insert(
                (run_id.clone(), tool_id.clone()),
                ToolAvailabilityV2::Unavailable,
            );
            let next_context = self.build_tool_context_from_inputs(
                &run_id,
                next_context_version,
                &settings,
                &runtime_availability,
            )?;
            initial_context_invalidations.push(InitialToolContextInvalidationV2 {
                tool_id: tool_id.clone(),
                previous_context: tool_context.context_ref(),
                next_context: next_context.context_ref(),
            });
            initially_unavailable_tool_ids.push(tool_id);
            tool_context = next_context;
        }
        let context_version = tool_context.context_version;
        let initial_epoch = ControlEpoch::new(1).map_err(|_| storage_fault())?;
        let opened = RunOpenReplyV2 {
            run_id: run_id.clone(),
            control_epoch: initial_epoch,
            workspace_binding_digest: binding.digest.clone(),
            tool_context: tool_context.clone(),
        };
        let stored = DurablePublicReplyV2::RunOpen {
            reply: opened.clone(),
        };
        let receipt = public_receipt(
            envelope.request_id.clone(),
            digest.clone(),
            "runOpen",
            Some(run_id.clone()),
            &stored,
            None,
        )?;
        let (epoch, initial_context_fact_id) = self.inner.authority.open_run_with_public_receipt(
            ControlEpochAdvanceV2 {
                run_id: run_id.clone(),
                precondition: EpochPreconditionV2::NoCurrentEpoch {},
                input_id: command.input_id.clone(),
                opaque_input_ref: command.opaque_input_ref,
            },
            envelope.request_id.clone(),
            digest,
            command.workspace_binding_ref.clone(),
            settings_ceiling_digest.clone(),
            initial_tool_context.context_ref(),
            initial_context_invalidations,
            &run_capability,
            receipt,
        )?;
        let tool_context_ref = tool_context.context_ref();
        if epoch.accepted_control_epoch != opened.control_epoch {
            return Err(storage_fault());
        }
        let reply = KernelReplyV2::RunOpened(opened);
        {
            let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
            state.runs.insert(
                run_id.clone(),
                PublicRunRecord {
                    capability: run_capability.clone(),
                    transport_generation: initial_run_transport_generation(),
                    workspace_binding_ref: command.workspace_binding_ref,
                    workspace_binding_digest: binding.digest.clone(),
                    settings_ceiling_digest,
                    control_epoch: epoch.accepted_control_epoch,
                    current_input_id: command.input_id,
                    context_version,
                    context_ref: tool_context_ref,
                    control_fact_id: initial_context_fact_id,
                },
            );
            state.run_capability_verifiers.insert(
                run_id.clone(),
                run_capability_verifier_digest(&run_id, &run_capability),
            );
            for tool_id in initially_unavailable_tool_ids {
                state
                    .runtime_availability
                    .insert((run_id.clone(), tool_id), ToolAvailabilityV2::Unavailable);
            }
            state.run_settings.insert(run_id, settings);
        }
        Ok((reply, CommandHandlingV2::Evaluated, Some(run_capability)))
    }

    fn replay_or_evaluate(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        transport_run_capability: &RunCapabilityV2,
    ) -> AuthorityResult<(KernelReplyV2, CommandHandlingV2)> {
        let digest = command_request_digest_v2(&envelope.command).map_err(|_| storage_fault())?;
        let run_id = public_command_run_id(&envelope.command)
            .ok_or_else(|| invalid_field("command.kind", InvalidFieldViolationV2::InvalidEnum))?;
        self.verify_run_capability(&run_id, transport_run_capability)?;
        if let Some(replayed) = self.lookup_replay(&envelope.request_id, &digest)? {
            let reply = match replayed {
                DurablePublicReplyV2::Kernel { reply } => reply,
                DurablePublicReplyV2::Facts { page } => {
                    KernelReplyV2::KernelFactsProjected(self.materialize_facts_page(page)?)
                }
                DurablePublicReplyV2::RunOpen { .. }
                | DurablePublicReplyV2::UserDecision { .. } => return Err(storage_fault()),
            };
            return Ok((reply, CommandHandlingV2::Replayed));
        }
        self.inner
            .authority
            .require_run_accepting_commands(&run_id)?;
        let mut receipt_persisted = false;
        let reply = match envelope.command.clone() {
            KernelCommandV2::ToolContextGet(command) => {
                KernelReplyV2::ToolContext(self.tool_context_get(command)?)
            }
            KernelCommandV2::CapabilityScopePreviewBatch(command) => {
                let (reply, persisted) = self.scope_preview_batch(
                    command,
                    Some(PublicCommandContext {
                        request_id: envelope.request_id.clone(),
                        request_digest: digest.clone(),
                        command_kind: envelope.command.kind(),
                    }),
                )?;
                receipt_persisted = persisted;
                KernelReplyV2::CapabilityScopePreviewBatchResult(reply)
            }
            KernelCommandV2::ToolIntentSubmit(command) => {
                let reply = self.submit_tool_intent(
                    command,
                    Some(PublicCommandContext {
                        request_id: envelope.request_id.clone(),
                        request_digest: digest.clone(),
                        command_kind: envelope.command.kind(),
                    }),
                )?;
                receipt_persisted = self
                    .inner
                    .authority
                    .public_command_receipt(&envelope.request_id)?
                    .is_some();
                KernelReplyV2::ToolIntentSubmission(reply)
            }
            KernelCommandV2::KernelFactsQueryScoped(command) => {
                let page = self.query_projected_facts(
                    command,
                    envelope.request_id.clone(),
                    digest.clone(),
                )?;
                receipt_persisted = self
                    .inner
                    .authority
                    .public_command_receipt(&envelope.request_id)?
                    .is_some();
                KernelReplyV2::KernelFactsProjected(page)
            }
            KernelCommandV2::ControlEpochAdvance(command) => {
                let current_run = self.run_record(&command.run_id)?;
                let superseded_capability_count = u64::try_from(
                    self.inner
                        .state
                        .lock()
                        .map_err(|_| storage_fault())?
                        .leases
                        .values()
                        .filter(|lease| lease.run_id == command.run_id)
                        .count(),
                )
                .map_err(|_| storage_fault())?;
                validate_cross_language_safe_u64_v2(
                    "supersededCapabilityCount",
                    superseded_capability_count,
                )
                .map_err(|_| storage_fault())?;
                let public_request_id = envelope.request_id.clone();
                let public_digest = digest.clone();
                let public_run_id = command.run_id.clone();
                let command_kind = envelope.command.kind();
                let reply = self
                    .inner
                    .authority
                    .advance_epoch_with_public_receipt_and_authority_material(
                        envelope,
                        command.clone(),
                        superseded_capability_count,
                        vec![AuthorityMaterialMutationV2::TransitionRunEpoch {
                            run_id: command.run_id.clone(),
                            through_control_epoch: current_run.control_epoch.get(),
                            expected_lifecycles: vec![
                                AUTHORITY_MATERIAL_ACTIVE.to_owned(),
                                AUTHORITY_MATERIAL_AWAITING.to_owned(),
                            ],
                            next_lifecycle: AUTHORITY_MATERIAL_STALE.to_owned(),
                            fact_index: 1,
                        }],
                        move |reply| {
                            public_receipt(
                                public_request_id,
                                public_digest,
                                command_kind,
                                Some(public_run_id),
                                &DurablePublicReplyV2::Kernel {
                                    reply: reply.clone(),
                                },
                                None,
                            )
                        },
                    )?;
                receipt_persisted = self
                    .inner
                    .authority
                    .public_command_receipt(&envelope.request_id)?
                    .is_some();
                if let KernelReplyV2::ControlEpochAdvanced(advanced) = &reply {
                    let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
                    let run = state.runs.get_mut(&command.run_id).ok_or_else(|| {
                        KernelErrorV2::RunNotFound {
                            run_id: command.run_id.clone(),
                        }
                    })?;
                    run.control_epoch = advanced.accepted_control_epoch;
                    run.current_input_id = command.input_id;
                    run.control_fact_id = advanced.epoch_fact_id.clone();
                    state
                        .leases
                        .retain(|_, lease| lease.run_id != command.run_id);
                    state
                        .pending
                        .retain(|_, pending| pending.run_id != command.run_id);
                    state
                        .previews
                        .retain(|_, preview| preview.record.run_id != command.run_id);
                    state
                        .trusts
                        .retain(|_, trust| trust.run_id != command.run_id);
                }
                reply
            }
            KernelCommandV2::InvocationCancel(command) => {
                let public_request_id = envelope.request_id.clone();
                let public_digest = digest.clone();
                let public_run_id = command.run_id.clone();
                let command_kind = envelope.command.kind();
                let reply = self.inner.authority.cancel_invocation_with_public_receipt(
                    envelope,
                    command,
                    move |reply| {
                        public_receipt(
                            public_request_id,
                            public_digest,
                            command_kind,
                            Some(public_run_id),
                            &DurablePublicReplyV2::Kernel {
                                reply: reply.clone(),
                            },
                            None,
                        )
                    },
                )?;
                receipt_persisted = true;
                reply
            }
            KernelCommandV2::RunOpen(_) => {
                return Err(invalid_field(
                    "command.kind",
                    InvalidFieldViolationV2::InvalidRelation,
                ))
            }
        };
        if !receipt_persisted {
            if envelope.command.mutation_kind().is_some() {
                return Err(storage_fault());
            }
            let stored = DurablePublicReplyV2::Kernel {
                reply: reply.clone(),
            };
            let persisted = self.persist_reply(
                envelope.request_id.clone(),
                digest,
                envelope.command.kind(),
                public_command_run_id(&envelope.command),
                stored,
                None,
            )?;
            if !matches!(persisted, DurablePublicReplyV2::Kernel { .. }) {
                return Err(storage_fault());
            }
        }
        Ok((reply, CommandHandlingV2::Evaluated))
    }

    fn tool_context_get(
        &self,
        command: ToolContextGetV2,
    ) -> AuthorityResult<ToolContextGetReplyV2> {
        let run = self.run_record(&command.run_id)?;
        let context = self.build_tool_context(&command.run_id, run.context_version)?;
        match command.known_context {
            Some(known) if known == context.context_ref() => {
                Ok(ToolContextGetReplyV2::Current { context_ref: known })
            }
            _ => Ok(ToolContextGetReplyV2::Updated {
                tool_context: context,
            }),
        }
    }

    fn scope_preview_batch(
        &self,
        command: CapabilityScopePreviewBatchV2,
        public_command: Option<PublicCommandContext>,
    ) -> AuthorityResult<(CapabilityScopePreviewBatchReplyV2, bool)> {
        let run = self.run_record(&command.run_id)?;
        let context = self.build_tool_context(&command.run_id, run.context_version)?;
        let mut results = Vec::with_capacity(command.items.len());
        let mut drafts = Vec::new();
        for item in command.items {
            let reject = |reason, guidance: &str| CapabilityScopePreviewReplyV2::Rejected {
                plan_action_id: item.plan_action_id.clone(),
                operation_id: item.operation_id.clone(),
                tool_id: item.tool_id.clone(),
                reason,
                guidance: guidance.to_owned(),
            };
            if run.control_epoch != command.expected_control_epoch {
                results.push(reject(
                    CapabilityScopeRejectionReasonV2::StaleControlEpoch,
                    "Refresh the run epoch before previewing this PlanAction.",
                ));
                continue;
            }
            if command.tool_context_ref != context.context_ref() {
                results.push(reject(
                    CapabilityScopeRejectionReasonV2::StaleToolContext,
                    "Fetch the current ToolContext before previewing this scope.",
                ));
                continue;
            }
            let descriptor = match self.ready_descriptor(&command.run_id, &item.tool_id) {
                Ok(value) => value,
                Err(reason) => {
                    results.push(reject(
                        reason,
                        "The requested tool is not currently executable.",
                    ));
                    continue;
                }
            };
            if descriptor.authorization_shape != item.scope_intent.authorization_shape() {
                results.push(reject(
                    CapabilityScopeRejectionReasonV2::RequestedScopeInvalid,
                    "Use the authorization shape declared by the current Kernel ToolContext.",
                ));
                continue;
            }
            let prepared_authorization = match &item.scope_intent {
                ScopeIntentV2::ResourceScope {
                    requested_resources,
                } => self
                    .inner
                    .authority
                    .canonical_scope_for_requested_resources(
                        &command.run_id,
                        command.expected_control_epoch,
                        &item.tool_id,
                        descriptor.effect_scope,
                        requested_resources,
                        item.deadline,
                    )
                    .map(|(scope, targets, deadline)| {
                        (
                            CapabilityAuthorizationBindingV2::ResourceScope {},
                            scope,
                            targets,
                            deadline,
                        )
                    }),
                ScopeIntentV2::ExactInvocation { raw_arguments } => {
                    let invocation = canonical_invocation(&item.tool_id, raw_arguments);
                    invocation.and_then(|invocation| {
                        let (scope, deadline) = self.inner.authority.canonical_scope_for_tool(
                            &command.run_id,
                            &item.operation_id,
                            command.expected_control_epoch,
                            &item.idempotency_key,
                            &invocation,
                            item.deadline,
                            vec![CorrelationRefV2::PlanAction {
                                value: item.plan_action_id.to_string(),
                            }],
                        )?;
                        let targets = authorization_targets_for_invocation(&invocation, &scope)?;
                        let invocation_digest =
                            exact_invocation_digest_v2(&invocation).map_err(|_| storage_fault())?;
                        Ok((
                            CapabilityAuthorizationBindingV2::ExactInvocation { invocation_digest },
                            scope,
                            targets,
                            deadline,
                        ))
                    })
                }
            };
            let (authorization_binding, canonical_scope, targets, effective_deadline_ms) =
                match prepared_authorization {
                    Ok(value) => value,
                    Err(error) => {
                        let Some((reason, guidance)) = classify_scope_preview_rejection(&error)
                        else {
                            return Err(error);
                        };
                        results.push(reject(reason, &guidance));
                        continue;
                    }
                };
            let draft = match self.prepare_preview_draft(
                &command.run_id,
                command.expected_control_epoch,
                command.plan_revision.clone(),
                item.plan_action_id.clone(),
                item.operation_id.clone(),
                item.tool_id.clone(),
                authorization_binding,
                canonical_scope,
                targets,
                Vec::new(),
                PreparedScopePreviewDecisionClassV2::Capability,
                effective_deadline_ms,
                command.tool_context_ref.clone(),
                descriptor,
            ) {
                Ok(value) => value,
                Err(error) => {
                    let Some((reason, guidance)) = classify_scope_preview_rejection(&error) else {
                        return Err(error);
                    };
                    results.push(reject(reason, &guidance));
                    continue;
                }
            };
            results.push(CapabilityScopePreviewReplyV2::Previewed {
                preview: draft.record.clone(),
            });
            drafts.push(draft);
        }
        let reply = CapabilityScopePreviewBatchReplyV2 {
            run_id: command.run_id.clone(),
            accepted_control_epoch: run.control_epoch,
            plan_revision: command.plan_revision,
            results,
        };
        KernelReplyV2::CapabilityScopePreviewBatchResult(reply.clone())
            .validate()
            .map_err(|_| storage_fault())?;
        if drafts.is_empty() {
            return Ok((reply, false));
        }
        let payloads = drafts
            .iter()
            .map(|draft| KernelFactPayloadV2::Authorization(draft.payload.clone()))
            .collect::<Vec<_>>();
        let materials = drafts
            .iter()
            .enumerate()
            .map(|(fact_index, draft)| {
                Ok(AuthorityMaterialMutationV2::Put {
                    material: scope_preview_material(&draft.durable, AUTHORITY_MATERIAL_ACTIVE)?,
                    fact_index,
                })
            })
            .collect::<AuthorityResult<Vec<_>>>()?;
        let persisted = public_command.is_some();
        let facts = if let Some(public_command) = public_command {
            let durable_reply = DurablePublicReplyV2::Kernel {
                reply: KernelReplyV2::CapabilityScopePreviewBatchResult(reply.clone()),
            };
            let receipt = public_receipt(
                public_command.request_id,
                public_command.request_digest,
                public_command.command_kind,
                Some(command.run_id.clone()),
                &durable_reply,
                None,
            )?;
            self.inner
                .authority
                .append_payloads_with_public_receipt_and_authority_material_builder(
                    payloads,
                    drafts.len().checked_sub(1),
                    materials,
                    move |_, _| Ok(receipt),
                )?
                .facts
        } else {
            self.inner
                .authority
                .append_payloads_with_authority_material(payloads, materials)?
                .facts
        };
        if facts.len() != drafts.len() {
            return Err(storage_fault());
        }
        let prepared = drafts
            .into_iter()
            .zip(facts)
            .map(|(draft, fact)| draft.into_prepared(fact.fact_id))
            .collect::<Vec<_>>();
        {
            let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
            for preview in prepared {
                let preview_id = preview.record.preview_id.clone();
                let preview_run_id = preview.record.run_id.clone();
                if state
                    .preview_runs
                    .insert(preview_id.clone(), preview_run_id.clone())
                    .is_some_and(|existing| existing != preview_run_id)
                {
                    return Err(storage_fault());
                }
                state.previews.insert(preview_id, preview);
            }
        }
        Ok((reply, persisted))
    }

    fn resolve_decision_preview(
        &self,
        run_id: &RunId,
        control_epoch: ControlEpoch,
        binding: &CapabilityDecisionBindingV2,
    ) -> AuthorityResult<Result<PreparedScopePreview, UserDecisionErrorV2>> {
        let (run, preview) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            if state.retirement_fences.contains_key(run_id)
                || state.retired_runs.contains_key(run_id)
            {
                return Ok(Err(UserDecisionErrorV2::ScopePreviewStale));
            }
            let Some(run) = state.runs.get(run_id) else {
                return Ok(Err(UserDecisionErrorV2::ScopePreviewNotFound));
            };
            if run.control_epoch != control_epoch {
                return Ok(Err(UserDecisionErrorV2::ScopePreviewStale));
            }
            if run.current_input_id != binding.input_id {
                return Ok(Err(UserDecisionErrorV2::PlanBindingMismatch));
            }
            let Some(preview) = state.previews.get(&binding.scope_preview_id) else {
                return Ok(Err(UserDecisionErrorV2::ScopePreviewNotFound));
            };
            if preview.record.run_id != *run_id || preview.record.control_epoch != control_epoch {
                return Ok(Err(UserDecisionErrorV2::ScopePreviewStale));
            }
            if preview.authorization_digest != binding.expected_authorization_digest {
                return Ok(Err(UserDecisionErrorV2::AuthorizationDigestMismatch));
            }
            if preview.record.plan_revision != binding.plan_revision
                || preview.record.plan_action_id != binding.plan_action_id
                || preview.record.scope_digest != binding.scope_digest
            {
                return Ok(Err(UserDecisionErrorV2::PlanBindingMismatch));
            }
            (run.clone(), preview.clone())
        };
        let current_context = self
            .build_tool_context(run_id, run.context_version)?
            .context_ref();
        if preview.record.context_ref != binding.tool_context_ref
            || current_context != binding.tool_context_ref
        {
            return Ok(Err(UserDecisionErrorV2::ToolContextStale));
        }
        Ok(Ok(preview))
    }

    fn allow_capability_decision(
        &self,
        run_id: &RunId,
        control_epoch: ControlEpoch,
        binding: CapabilityDecisionBindingV2,
        expansion: bool,
        public_command: PublicCommandContext,
    ) -> AuthorityResult<(UserDecisionReplyV2, bool)> {
        let preview = match self.resolve_decision_preview(run_id, control_epoch, &binding)? {
            Ok(preview) => preview,
            Err(error) => return Ok((UserDecisionReplyV2::Error(error), false)),
        };
        let (pending, has_existing_lease) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            (
                state.pending.get(&binding.scope_preview_id).cloned(),
                state.leases.values().any(|lease| {
                    lease.run_id == *run_id
                        && lease.control_epoch == control_epoch
                        && lease.plan_revision == preview.record.plan_revision
                        && lease.plan_action_id == preview.record.plan_action_id
                        && lease.tool_id == preview.record.tool_id
                }),
            )
        };
        if expansion != has_existing_lease {
            return Ok((
                UserDecisionReplyV2::Error(if expansion {
                    UserDecisionErrorV2::CapabilityLeaseNotFound
                } else {
                    UserDecisionErrorV2::PlanBindingMismatch
                }),
                false,
            ));
        }
        let causation = pending
            .as_ref()
            .map(|pending| pending.awaiting_fact_id.clone())
            .unwrap_or_else(|| preview.preview_fact_id.clone());
        if let Some(pending) = pending {
            return self.allow_pending_and_continue(
                &preview,
                pending,
                binding.decision_ref,
                causation,
                expansion,
                public_command,
            );
        }
        let lease = self.issue_public_lease(
            &preview,
            Some(binding.decision_ref),
            causation,
            Some((public_command, expansion)),
        )?;
        Ok((
            if expansion {
                UserDecisionReplyV2::ScopeExpansionRecorded {
                    lease: lease.reference,
                    fact_id: lease.issuance_fact_id,
                    ledger_sequence: lease.issuance_ledger_sequence,
                }
            } else {
                UserDecisionReplyV2::CapabilityIssued {
                    lease: lease.reference,
                    fact_id: lease.issuance_fact_id,
                    ledger_sequence: lease.issuance_ledger_sequence,
                }
            },
            true,
        ))
    }

    fn allow_pending_and_continue(
        &self,
        preview: &PreparedScopePreview,
        pending: PendingIntent,
        decision_ref: UserDecisionRefV2,
        causation_fact_id: FactId,
        expansion: bool,
        public_command: PublicCommandContext,
    ) -> AuthorityResult<(UserDecisionReplyV2, bool)> {
        let previous = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            state
                .leases
                .values()
                .filter(|lease| {
                    lease.run_id == preview.record.run_id
                        && lease.control_epoch == preview.record.control_epoch
                        && lease.plan_revision == preview.record.plan_revision
                        && lease.plan_action_id == preview.record.plan_action_id
                        && lease.tool_id == preview.record.tool_id
                })
                .max_by_key(|lease| lease.reference.version.get())
                .cloned()
        };
        if expansion != previous.is_some() {
            return Err(invalid_field(
                "decision",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        if previous.as_ref().is_some_and(|lease| {
            !authorization_binding_can_expand(
                &lease.authorization_binding,
                &preview.record.authorization_binding,
            )
        }) {
            return Err(invalid_field(
                "authorizationBinding",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        if previous.as_ref().is_some_and(|lease| {
            !target_set_contains(&preview.approved_targets, &lease.approved_targets)
        }) {
            return Err(invalid_field(
                "authorizationBinding",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let (submitted_plan_revision, submitted_plan_action_id) = match &pending.authority {
            ToolIntentAuthorityV2::PlanAction {
                plan_revision,
                plan_action_id,
                ..
            } => (plan_revision, plan_action_id),
            ToolIntentAuthorityV2::ContextRead { .. } => {
                return Err(invalid_field(
                    "authority",
                    InvalidFieldViolationV2::InvalidRelation,
                ))
            }
        };
        if submitted_plan_revision != &preview.record.plan_revision
            || submitted_plan_action_id != &preview.record.plan_action_id
            || pending.run_id != preview.record.run_id
            || pending.expected_control_epoch != preview.record.control_epoch
            || pending.operation_id != preview.record.operation_id
            || pending.tool_id != preview.record.tool_id
            || pending.tool_context_ref != preview.record.context_ref
        {
            return Err(invalid_field(
                "authority",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let lease_id = previous
            .as_ref()
            .map(|lease| lease.reference.lease_id.clone())
            .unwrap_or_else(|| self.inner.ids.lease_id());
        let version = previous
            .as_ref()
            .map(|lease| {
                lease
                    .reference
                    .version
                    .get()
                    .checked_add(1)
                    .ok_or_else(storage_fault)
            })
            .transpose()?
            .unwrap_or(1);
        let version = CapabilityLeaseVersionV2::new(version).map_err(|_| storage_fault())?;
        let reference = CapabilityLeaseRefV2 {
            lease_id: lease_id.clone(),
            version,
            scope_digest: preview.record.scope_digest.clone(),
        };
        let lease_identity = CapabilityLeaseFactIdentityV2 {
            run_id: preview.record.run_id.clone(),
            control_epoch: preview.record.control_epoch,
            plan_revision: preview.record.plan_revision.clone(),
            plan_action_id: preview.record.plan_action_id.clone(),
            operation_id: preview.record.operation_id.clone(),
            preview_id: preview.record.preview_id.clone(),
            lease_id: lease_id.clone(),
            lease_version: version,
            causation_fact_id,
            correlation_set: plan_action_correlations(&preview.record.plan_action_id)?,
        };
        let authorization = match &previous {
            Some(previous) => AuthorizationFactV2::ExpansionAllowed {
                identity: lease_identity,
                previous_lease_id: previous.reference.lease_id.clone(),
                previous_scope_digest: previous.reference.scope_digest.clone(),
                expanded_scope_digest: preview.record.scope_digest.clone(),
                authorization_digest: preview.authorization_digest.clone(),
            },
            None => AuthorizationFactV2::CapabilityIssued {
                identity: lease_identity,
                tool_id: preview.record.tool_id.clone(),
                scope_digest: preview.record.scope_digest.clone(),
                authorization_digest: preview.authorization_digest.clone(),
                tool_contract_digest: preview.record.tool_contract_digest.clone(),
                context_ref: preview.record.context_ref.clone(),
            },
        };
        let durable_lease = DurableCapabilityLeaseV2 {
            reference: reference.clone(),
            run_id: preview.record.run_id.clone(),
            control_epoch: preview.record.control_epoch,
            plan_revision: preview.record.plan_revision.clone(),
            plan_action_id: preview.record.plan_action_id.clone(),
            tool_id: preview.record.tool_id.clone(),
            context_ref: preview.record.context_ref.clone(),
            authorization_binding: preview.record.authorization_binding.clone(),
            approved_targets: preview.approved_targets.clone(),
            decision_ref: Some(decision_ref),
            issuance_operation_id: preview.record.operation_id.clone(),
            preview_id: preview.record.preview_id.clone(),
        };
        let lease_material = capability_lease_material(&durable_lease, AUTHORITY_MATERIAL_ACTIVE)?;
        let lease_mutation = if previous.is_some() {
            AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_ACTIVE.to_owned(),
                expected_payload_digest: None,
                material: lease_material,
                fact_index: 0,
            }
        } else {
            AuthorityMaterialMutationV2::Put {
                material: lease_material,
                fact_index: 0,
            }
        };
        let pending_mutation = AuthorityMaterialMutationV2::Replace {
            expected_lifecycle: AUTHORITY_MATERIAL_AWAITING.to_owned(),
            expected_payload_digest: None,
            material: pending_intent_material(
                &pending.durable(),
                AUTHORITY_MATERIAL_ADMITTED,
                Some(reference.clone()),
            )?,
            fact_index: 1,
        };
        let descriptor = self
            .ready_descriptor(&pending.run_id, &pending.tool_id)
            .map_err(|_| invalid_field("toolId", InvalidFieldViolationV2::OutOfRange))?;
        if descriptor.authorization_shape
            != preview.record.authorization_binding.authorization_shape()
        {
            return Err(invalid_field(
                "authorizationBinding",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let invocation = canonical_invocation(&pending.tool_id, &pending.raw_arguments)?;
        let (actual_scope, _) = self.inner.authority.canonical_scope_for_tool(
            &pending.run_id,
            &pending.operation_id,
            pending.expected_control_epoch,
            &pending.idempotency_key,
            &invocation,
            pending.deadline,
            vec![CorrelationRefV2::PlanAction {
                value: preview.record.plan_action_id.to_string(),
            }],
        )?;
        let actual_targets = authorization_targets_for_invocation(&invocation, &actual_scope)?;
        if !authorization_binding_allows(
            &preview.record.authorization_binding,
            &preview.approved_targets,
            &invocation,
            &actual_targets,
        )? {
            return Err(invalid_field(
                "authorizationBinding",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let canonical_arguments = canonical_argument_value(&invocation)?;
        let canonical_arguments_digest =
            canonical_arguments_digest_v2(&pending.tool_id, &canonical_arguments)
                .map_err(|_| storage_fault())?;
        let tool_contract_digest =
            tool_contract_digest_v2(&descriptor).map_err(|_| storage_fault())?;
        if tool_contract_digest != preview.record.tool_contract_digest {
            return Err(invalid_field(
                "rawArguments",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let settings_digest = self.settings_ceiling_digest(&pending.run_id)?;
        let policy_evaluation_digest = invocation_policy_evaluation_digest_v2(
            &pending.run_id,
            pending.expected_control_epoch,
            &pending.tool_id,
            &pending.tool_context_ref,
            &settings_digest,
            Some(&reference),
        )
        .map_err(|_| storage_fault())?;
        let direct_request = DirectToolIntentRequest {
            run_id: pending.run_id.clone(),
            operation_id: pending.operation_id.clone(),
            control_epoch: pending.expected_control_epoch,
            idempotency_key: pending.idempotency_key.clone(),
            tool_id: pending.tool_id.clone(),
            canonical_arguments_digest,
            canonical_invocation: invocation,
            authority: InvocationAuthorityV2::PlanAction {
                plan_revision: preview.record.plan_revision.clone(),
                plan_action_id: preview.record.plan_action_id.clone(),
                lease: reference.clone(),
                policy_evaluation_digest,
            },
            tool_contract_digest,
            deadline: pending.deadline,
        };
        let decision_run_id = pending.run_id.clone();
        let reply_reference = reference.clone();
        let outcome = self
            .inner
            .authority
            .continue_direct_tool_intent_with_public_receipt(
                direct_request,
                pending.invocation_id.clone(),
                authorization,
                vec![lease_mutation, pending_mutation],
                move |fact_id, ledger_sequence, _| {
                    let reply = if expansion {
                        UserDecisionReplyV2::ScopeExpansionRecorded {
                            lease: reply_reference,
                            fact_id: fact_id.clone(),
                            ledger_sequence,
                        }
                    } else {
                        UserDecisionReplyV2::CapabilityIssued {
                            lease: reply_reference,
                            fact_id: fact_id.clone(),
                            ledger_sequence,
                        }
                    };
                    public_receipt(
                        public_command.request_id,
                        public_command.request_digest,
                        public_command.command_kind,
                        Some(decision_run_id),
                        &DurablePublicReplyV2::UserDecision { reply },
                        Some(fact_id.clone()),
                    )
                },
            )?;
        match &outcome.reply {
            ToolIntentSubmitReplyV2::Admitted {
                lease,
                invocation_id,
                ..
            } if lease.as_ref() == Some(&reference) && invocation_id == &pending.invocation_id => {}
            _ => return Err(storage_fault()),
        }
        let lease = durable_lease.into_record(
            outcome.authorization_fact_id.clone(),
            outcome.authorization_ledger_sequence,
        );
        {
            let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
            state.leases.insert(reference.lease_id.clone(), lease);
            state.pending.remove(&pending.preview_id);
        }
        Ok((
            if expansion {
                UserDecisionReplyV2::ScopeExpansionRecorded {
                    lease: reference,
                    fact_id: outcome.authorization_fact_id,
                    ledger_sequence: outcome.authorization_ledger_sequence,
                }
            } else {
                UserDecisionReplyV2::CapabilityIssued {
                    lease: reference,
                    fact_id: outcome.authorization_fact_id,
                    ledger_sequence: outcome.authorization_ledger_sequence,
                }
            },
            true,
        ))
    }

    fn deny_capability_decision(
        &self,
        run_id: &RunId,
        control_epoch: ControlEpoch,
        binding: CapabilityDecisionBindingV2,
        guidance: String,
        expansion: bool,
        public_command: PublicCommandContext,
    ) -> AuthorityResult<(UserDecisionReplyV2, bool)> {
        let preview = match self.resolve_decision_preview(run_id, control_epoch, &binding)? {
            Ok(preview) => preview,
            Err(error) => return Ok((UserDecisionReplyV2::Error(error), false)),
        };
        let pending = self
            .inner
            .state
            .lock()
            .map_err(|_| storage_fault())?
            .pending
            .get(&binding.scope_preview_id)
            .cloned();
        let causation = pending
            .as_ref()
            .map(|pending| pending.awaiting_fact_id.clone())
            .unwrap_or_else(|| preview.preview_fact_id.clone());
        let material_mutations = pending
            .as_ref()
            .map(|pending| {
                let lease = match &pending.authority {
                    ToolIntentAuthorityV2::PlanAction { lease, .. } => lease.clone(),
                    ToolIntentAuthorityV2::ContextRead { .. } => None,
                };
                Ok(AuthorityMaterialMutationV2::Replace {
                    expected_lifecycle: AUTHORITY_MATERIAL_AWAITING.to_owned(),
                    expected_payload_digest: None,
                    material: pending_intent_material(
                        &pending.durable(),
                        AUTHORITY_MATERIAL_REJECTED,
                        lease,
                    )?,
                    fact_index: 0,
                })
            })
            .transpose()?
            .into_iter()
            .collect();
        let denial = self.record_denial(
            &preview,
            causation,
            guidance,
            expansion,
            Some(public_command),
            material_mutations,
        )?;
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        state.pending.remove(&binding.scope_preview_id);
        Ok((
            if expansion {
                UserDecisionReplyV2::ScopeExpansionDenied {
                    fact_id: denial.0.fact_id,
                    ledger_sequence: denial.0.ledger_sequence,
                }
            } else {
                UserDecisionReplyV2::CapabilityDenied {
                    fact_id: denial.0.fact_id,
                    ledger_sequence: denial.0.ledger_sequence,
                }
            },
            denial.1,
        ))
    }

    fn grant_trust(
        &self,
        run_id: &RunId,
        control_epoch: ControlEpoch,
        decision: TrustGrantDecisionV2,
        public_command: PublicCommandContext,
    ) -> AuthorityResult<(UserDecisionReplyV2, bool)> {
        let preview =
            match self.resolve_decision_preview(run_id, control_epoch, &decision.binding)? {
                Ok(preview) => preview,
                Err(error) => return Ok((UserDecisionReplyV2::Error(error), false)),
            };
        if decision
            .expires_at
            .as_ref()
            .is_some_and(|expires_at| !recorded_at_is_future(expires_at))
        {
            return Ok((
                UserDecisionReplyV2::Error(UserDecisionErrorV2::PlanBindingMismatch),
                false,
            ));
        }
        let run = self
            .inner
            .state
            .lock()
            .map_err(|_| storage_fault())?
            .runs
            .get(run_id)
            .cloned()
            .ok_or_else(|| KernelErrorV2::RunNotFound {
                run_id: run_id.clone(),
            })?;
        let trust_lease_digest = trust_lease_digest_v2(&json!({
            "trustPolicyId": decision.trust_policy_id,
            "runId": run_id,
            "controlEpoch": control_epoch,
            "toolId": preview.record.tool_id,
            "authorizationBinding": preview.record.authorization_binding,
            "approvedTargets": preview.approved_targets,
            "workspaceBindingDigest": run.workspace_binding_digest,
            "toolContext": preview.record.context_ref,
            "expiresAt": decision.expires_at,
        }))
        .map_err(|_| storage_fault())?;
        let durable_trust = DurableTrustLeaseV2 {
            trust_policy_id: decision.trust_policy_id.clone(),
            trust_lease_digest: trust_lease_digest.clone(),
            run_id: run_id.clone(),
            control_epoch,
            plan_revision: preview.record.plan_revision.clone(),
            plan_action_id: preview.record.plan_action_id.clone(),
            issuance_operation_id: preview.record.operation_id.clone(),
            tool_id: preview.record.tool_id.clone(),
            scope_digest: preview.record.scope_digest.clone(),
            authorization_binding: preview.record.authorization_binding.clone(),
            approved_targets: preview.approved_targets.clone(),
            workspace_binding_digest: run.workspace_binding_digest.clone(),
            context_ref: preview.record.context_ref.clone(),
            expires_at: decision.expires_at.clone(),
            decision_ref: decision.binding.decision_ref.clone(),
        };
        let payload = AuthorizationFactV2::TrustGranted {
            identity: AuthorizationIdentityV2 {
                run_id: run_id.clone(),
                control_epoch,
                plan_revision: preview.record.plan_revision.clone(),
                plan_action_id: preview.record.plan_action_id.clone(),
                operation_id: preview.record.operation_id.clone(),
                causation_fact_id: preview.preview_fact_id.clone(),
                correlation_set: plan_action_correlations(&preview.record.plan_action_id)?,
            },
            trust_policy_id: decision.trust_policy_id.clone(),
            trust_lease_digest: trust_lease_digest.clone(),
            tool_id: preview.record.tool_id.clone(),
            scope_digest: preview.record.scope_digest.clone(),
            workspace_binding_digest: run.workspace_binding_digest.clone(),
            context_ref: preview.record.context_ref.clone(),
            expires_at: decision.expires_at.clone(),
        };
        let reply_policy_id = decision.trust_policy_id.clone();
        let reply_digest = trust_lease_digest.clone();
        let (fact, reply) = self.append_user_decision_fact_with_material(
            run_id.clone(),
            payload,
            public_command,
            vec![AuthorityMaterialMutationV2::Put {
                material: trust_lease_material(&durable_trust, AUTHORITY_MATERIAL_ACTIVE)?,
                fact_index: 0,
            }],
            move |fact_id, ledger_sequence| UserDecisionReplyV2::TrustGranted {
                trust_policy_id: reply_policy_id,
                trust_lease_digest: reply_digest,
                fact_id,
                ledger_sequence,
            },
        )?;
        let trust = durable_trust.into_record(fact.fact_id.clone());
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        if state
            .trusts
            .insert(decision.trust_policy_id.clone(), trust)
            .is_some()
        {
            return Err(storage_fault());
        }
        Ok((reply, true))
    }

    fn revoke_user_authority(
        &self,
        run_id: &RunId,
        control_epoch: ControlEpoch,
        _decision_ref: UserDecisionRefV2,
        target: UserDecisionRevokeTargetV2,
        public_command: PublicCommandContext,
    ) -> AuthorityResult<(UserDecisionReplyV2, bool)> {
        match target {
            UserDecisionRevokeTargetV2::CapabilityLease { lease_id } => {
                let lease = {
                    let state = self.inner.state.lock().map_err(|_| storage_fault())?;
                    state.leases.get(&lease_id).cloned()
                };
                let Some(lease) = lease.filter(|lease| {
                    lease.run_id == *run_id && lease.control_epoch == control_epoch
                }) else {
                    return Ok((
                        UserDecisionReplyV2::Error(UserDecisionErrorV2::CapabilityLeaseNotFound),
                        false,
                    ));
                };
                let durable_lease = lease.durable();
                let payload = AuthorizationFactV2::LeaseRevoked {
                    identity: CapabilityLeaseFactIdentityV2 {
                        run_id: run_id.clone(),
                        control_epoch,
                        plan_revision: lease.plan_revision.clone(),
                        plan_action_id: lease.plan_action_id.clone(),
                        operation_id: lease.issuance_operation_id.clone(),
                        preview_id: lease.preview_id.clone(),
                        lease_id: lease.reference.lease_id.clone(),
                        lease_version: lease.reference.version,
                        causation_fact_id: lease.issuance_fact_id.clone(),
                        correlation_set: plan_action_correlations(&lease.plan_action_id)?,
                    },
                    scope_digest: lease.reference.scope_digest.clone(),
                    reason: CapabilityLeaseRevokeReasonV2::UserRevoked,
                };
                let (_, reply) = self.append_user_decision_fact_with_material(
                    run_id.clone(),
                    payload,
                    public_command,
                    vec![AuthorityMaterialMutationV2::Replace {
                        expected_lifecycle: AUTHORITY_MATERIAL_ACTIVE.to_owned(),
                        expected_payload_digest: None,
                        material: capability_lease_material(
                            &durable_lease,
                            AUTHORITY_MATERIAL_REVOKED,
                        )?,
                        fact_index: 0,
                    }],
                    |fact_id, ledger_sequence| UserDecisionReplyV2::Revoked {
                        fact_id,
                        ledger_sequence,
                    },
                )?;
                self.inner
                    .state
                    .lock()
                    .map_err(|_| storage_fault())?
                    .leases
                    .remove(&lease_id);
                Ok((reply, true))
            }
            UserDecisionRevokeTargetV2::TrustPolicy { trust_policy_id } => {
                let trust = {
                    let state = self.inner.state.lock().map_err(|_| storage_fault())?;
                    state.trusts.get(&trust_policy_id).cloned()
                };
                let Some(trust) = trust.filter(|trust| {
                    trust.run_id == *run_id && trust.control_epoch == control_epoch
                }) else {
                    return Ok((
                        UserDecisionReplyV2::Error(UserDecisionErrorV2::TrustPolicyNotFound),
                        false,
                    ));
                };
                let durable_trust = trust.durable();
                let payload = AuthorizationFactV2::TrustRevoked {
                    identity: AuthorizationIdentityV2 {
                        run_id: run_id.clone(),
                        control_epoch,
                        plan_revision: trust.plan_revision.clone(),
                        plan_action_id: trust.plan_action_id.clone(),
                        operation_id: trust.issuance_operation_id.clone(),
                        causation_fact_id: trust.fact_id.clone(),
                        correlation_set: plan_action_correlations(&trust.plan_action_id)?,
                    },
                    trust_policy_id: trust.trust_policy_id.clone(),
                    trust_lease_digest: trust.trust_lease_digest,
                    tool_id: trust.tool_id,
                    scope_digest: trust.scope_digest,
                    workspace_binding_digest: trust.workspace_binding_digest,
                    context_ref: trust.context_ref,
                    expires_at: trust.expires_at,
                };
                let (_, reply) = self.append_user_decision_fact_with_material(
                    run_id.clone(),
                    payload,
                    public_command,
                    vec![AuthorityMaterialMutationV2::Replace {
                        expected_lifecycle: AUTHORITY_MATERIAL_ACTIVE.to_owned(),
                        expected_payload_digest: None,
                        material: trust_lease_material(&durable_trust, AUTHORITY_MATERIAL_REVOKED)?,
                        fact_index: 0,
                    }],
                    |fact_id, ledger_sequence| UserDecisionReplyV2::Revoked {
                        fact_id,
                        ledger_sequence,
                    },
                )?;
                self.inner
                    .state
                    .lock()
                    .map_err(|_| storage_fault())?
                    .trusts
                    .remove(&trust_policy_id);
                Ok((reply, true))
            }
        }
    }

    fn verify_run_capability(
        &self,
        run_id: &RunId,
        transport: &RunCapabilityV2,
    ) -> AuthorityResult<()> {
        let state = self.inner.state.lock().map_err(|_| storage_fault())?;
        if state.retirement_fences.contains_key(run_id) || state.retired_runs.contains_key(run_id) {
            return Err(KernelErrorV2::RunNotFound {
                run_id: run_id.clone(),
            });
        }
        let run = state
            .runs
            .get(run_id)
            .ok_or_else(|| KernelErrorV2::RunNotFound {
                run_id: run_id.clone(),
            })?;
        if !constant_time_token_eq(&run.capability, transport) {
            return Err(unauthorized_run());
        }
        Ok(())
    }

    fn install_retired_run_state(
        &self,
        run_id: &RunId,
        retired: RetiredRunRecord,
    ) -> AuthorityResult<()> {
        {
            let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
            state.runs.remove(run_id);
            state.recovered_runs.remove(run_id);
            state.retirement_fences.remove(run_id);
            state.run_settings.remove(run_id);
            state
                .runtime_availability
                .retain(|(candidate_run_id, _), _| candidate_run_id != run_id);
            state.leases.retain(|_, lease| &lease.run_id != run_id);
            state.trusts.retain(|_, trust| &trust.run_id != run_id);
            state
                .previews
                .retain(|_, preview| &preview.record.run_id != run_id);
            state.pending.retain(|_, intent| &intent.run_id != run_id);
            state.retired_runs.insert(run_id.clone(), retired);
        }
        self.inner.authority.unbind_run_workspace_host(run_id)
    }

    fn run_record(&self, run_id: &RunId) -> AuthorityResult<PublicRunRecord> {
        self.inner
            .state
            .lock()
            .map_err(|_| storage_fault())?
            .runs
            .get(run_id)
            .cloned()
            .ok_or_else(|| KernelErrorV2::RunNotFound {
                run_id: run_id.clone(),
            })
    }

    fn lookup_replay(
        &self,
        request_id: &CommandRequestId,
        submitted: &CommandRequestDigestV2,
    ) -> AuthorityResult<Option<DurablePublicReplyV2>> {
        let Some(existing) = self.inner.authority.public_command_receipt(request_id)? else {
            return Ok(None);
        };
        if &existing.command_request_digest != submitted {
            return Err(KernelErrorV2::DuplicateCommandDigestMismatch {
                command_request_id: request_id.clone(),
                existing: existing.command_request_digest,
                submitted: submitted.clone(),
            });
        }
        serde_json::from_value(existing.reply_json)
            .map(Some)
            .map_err(|_| storage_fault())
    }

    fn persist_reply(
        &self,
        request_id: CommandRequestId,
        digest: CommandRequestDigestV2,
        command_kind: &'static str,
        run_id: Option<RunId>,
        reply: DurablePublicReplyV2,
        settlement_fact_id: Option<FactId>,
    ) -> AuthorityResult<DurablePublicReplyV2> {
        let receipt = public_receipt(
            request_id,
            digest,
            command_kind,
            run_id,
            &reply,
            settlement_fact_id,
        )?;
        receipt_outcome(self.inner.authority.put_public_command_receipt(receipt)?)
    }

    fn persist_user_decision_reply(
        &self,
        request_id: CommandRequestId,
        request_digest: CommandRequestDigestV2,
        run_id: RunId,
        reply: UserDecisionReplyV2,
    ) -> AuthorityResult<(UserDecisionReplyV2, CommandHandlingV2)> {
        let stored = DurablePublicReplyV2::UserDecision {
            reply: reply.clone(),
        };
        let persisted = self.persist_reply(
            request_id,
            request_digest,
            "userDecision",
            Some(run_id),
            stored,
            user_decision_settlement_fact(&reply),
        )?;
        match persisted {
            DurablePublicReplyV2::UserDecision { .. } => Ok((reply, CommandHandlingV2::Evaluated)),
            _ => Err(storage_fault()),
        }
    }

    fn append_user_decision_fact_with_material<F>(
        &self,
        run_id: RunId,
        payload: AuthorizationFactV2,
        public_command: PublicCommandContext,
        material_mutations: Vec<AuthorityMaterialMutationV2>,
        make_reply: F,
    ) -> AuthorityResult<(KernelFactEnvelopeV2, UserDecisionReplyV2)>
    where
        F: FnOnce(FactId, u64) -> UserDecisionReplyV2,
    {
        let outcome = self
            .inner
            .authority
            .append_payloads_with_public_receipt_and_authority_material_builder(
                vec![KernelFactPayloadV2::Authorization(payload)],
                Some(0),
                material_mutations,
                move |fact_ids, ledger_sequences| {
                    let reply = make_reply(fact_ids[0].clone(), ledger_sequences[0]);
                    public_receipt(
                        public_command.request_id,
                        public_command.request_digest,
                        public_command.command_kind,
                        Some(run_id),
                        &DurablePublicReplyV2::UserDecision { reply },
                        None,
                    )
                },
            )?;
        let fact = outcome.facts.first().cloned().ok_or_else(storage_fault)?;
        let durable = receipt_outcome(outcome.receipt)?;
        match durable {
            DurablePublicReplyV2::UserDecision { reply } => Ok((fact, reply)),
            _ => Err(storage_fault()),
        }
    }

    fn materialize_facts_page(
        &self,
        template: DurableFactPageV2,
    ) -> AuthorityResult<KernelFactProjectionPageV2> {
        validate_cross_language_safe_u64_v2(
            "requestedAfterLedgerSequence",
            template.requested_after_ledger_sequence,
        )
        .map_err(|_| storage_fault())?;
        validate_cross_language_safe_u64_v2("snapshotHighWater", template.snapshot_high_water)
            .map_err(|_| storage_fault())?;
        validate_cross_language_safe_u64_v2(
            "nextAfterLedgerSequence",
            template.next_after_ledger_sequence,
        )
        .map_err(|_| storage_fault())?;
        for fact in &template.facts {
            fact.validate().map_err(|_| storage_fault())?;
        }
        let next_continuation = if template.has_more {
            let mut issued = None;
            for _ in 0..4 {
                let token =
                    deepcode_kernel_abi::FactQueryContinuationV2::new(self.inner.ids.raw("facts"))
                        .map_err(|_| storage_fault())?;
                let outcome = self.inner.authority.put_fact_query_continuation(
                    FactQueryContinuationDraftV2 {
                        token: token.clone(),
                        run_id: template.run_id.clone(),
                        snapshot_high_water: template.snapshot_high_water,
                        after_ledger_sequence: template.next_after_ledger_sequence,
                        expires_at: recorded_at_after(std::time::Duration::from_secs(15 * 60))?,
                    },
                )?;
                match outcome {
                    PutFactQueryContinuationOutcomeV2::Inserted(_)
                    | PutFactQueryContinuationOutcomeV2::ExistingSame(_) => {
                        issued = Some(token);
                        break;
                    }
                    PutFactQueryContinuationOutcomeV2::ExistingConsumed(_)
                    | PutFactQueryContinuationOutcomeV2::ExistingExpired(_)
                    | PutFactQueryContinuationOutcomeV2::TokenConflict => continue,
                    PutFactQueryContinuationOutcomeV2::CapacityExceeded { .. } => {
                        return Err(KernelErrorV2::FactStoreUnavailable {
                            fault_code: deepcode_kernel_abi::v2_command::StorageFaultCodeV2::Full,
                        })
                    }
                }
            }
            Some(issued.ok_or_else(storage_fault)?)
        } else {
            None
        };
        let page = KernelFactProjectionPageV2 {
            requested_after_ledger_sequence: template.requested_after_ledger_sequence,
            snapshot_high_water: template.snapshot_high_water,
            facts: template.facts,
            has_more: template.has_more,
            next_after_ledger_sequence: template.next_after_ledger_sequence,
            next_continuation,
        };
        page.validate().map_err(|_| storage_fault())?;
        Ok(page)
    }

    fn build_tool_context(
        &self,
        run_id: &RunId,
        context_version: ToolContextVersionV2,
    ) -> AuthorityResult<ToolContextBundleV2> {
        let (runtime_availability, settings) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            (
                state.runtime_availability.clone(),
                state
                    .run_settings
                    .get(run_id)
                    .cloned()
                    .ok_or_else(storage_fault)?,
            )
        };
        self.build_tool_context_from_inputs(
            run_id,
            context_version,
            &settings,
            &runtime_availability,
        )
    }

    fn build_tool_context_from_inputs(
        &self,
        run_id: &RunId,
        context_version: ToolContextVersionV2,
        settings: &SettingsCeilingV2,
        runtime_availability: &HashMap<(RunId, ToolIdV2), ToolAvailabilityV2>,
    ) -> AuthorityResult<ToolContextBundleV2> {
        let tools = self
            .inner
            .inventory
            .tools
            .iter()
            .filter(|descriptor| {
                runtime_availability
                    .get(&(run_id.clone(), descriptor.tool_id.clone()))
                    .copied()
                    .unwrap_or(descriptor.availability)
                    == ToolAvailabilityV2::Ready
                    && settings_allow(settings, descriptor.effect_scope)
            })
            .cloned()
            .collect::<Vec<_>>();
        let fixed_prompt = render_kernel_tool_prompt_v2(&tools).map_err(|_| storage_fault())?;
        let context_digest = tool_context_digest_v2(
            context_version,
            &self.inner.inventory.catalog_digest,
            &fixed_prompt,
            &tools,
        )
        .map_err(|_| storage_fault())?;
        let context = ToolContextBundleV2 {
            format_version: TOOL_CONTEXT_FORMAT_V2.to_owned(),
            context_version,
            catalog_digest: self.inner.inventory.catalog_digest.clone(),
            context_digest,
            fixed_prompt,
            tools,
        };
        context.validate().map_err(|_| storage_fault())?;
        Ok(context)
    }

    fn ready_descriptor(
        &self,
        run_id: &RunId,
        tool_id: &ToolIdV2,
    ) -> Result<ToolDescriptorV2, deepcode_kernel_abi::v2_command::CapabilityScopeRejectionReasonV2>
    {
        let descriptor = self
            .inner
            .inventory
            .tools
            .iter()
            .find(|descriptor| &descriptor.tool_id == tool_id)
            .cloned()
            .ok_or(
                deepcode_kernel_abi::v2_command::CapabilityScopeRejectionReasonV2::ToolNotRegistered,
            )?;
        let availability = self
            .inner
            .state
            .lock()
            .map_err(|_| {
                deepcode_kernel_abi::v2_command::CapabilityScopeRejectionReasonV2::ToolUnavailable
            })?
            .runtime_availability
            .get(&(run_id.clone(), tool_id.clone()))
            .copied()
            .unwrap_or(descriptor.availability);
        if availability != ToolAvailabilityV2::Ready {
            return Err(
                deepcode_kernel_abi::v2_command::CapabilityScopeRejectionReasonV2::ToolUnavailable,
            );
        }
        let settings_allowed = {
            let state = self.inner.state.lock().map_err(|_| {
                deepcode_kernel_abi::v2_command::CapabilityScopeRejectionReasonV2::ToolUnavailable
            })?;
            let settings = state.run_settings.get(run_id).ok_or(
                deepcode_kernel_abi::v2_command::CapabilityScopeRejectionReasonV2::ToolUnavailable,
            )?;
            settings_allow(settings, descriptor.effect_scope)
        };
        if !settings_allowed {
            return Err(
                deepcode_kernel_abi::v2_command::CapabilityScopeRejectionReasonV2::SettingsDenied,
            );
        }
        Ok(descriptor)
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare_preview_draft(
        &self,
        run_id: &RunId,
        control_epoch: ControlEpoch,
        plan_revision: PlanRevisionV2,
        plan_action_id: PlanActionIdV2,
        operation_id: OperationId,
        tool_id: ToolIdV2,
        authorization_binding: CapabilityAuthorizationBindingV2,
        canonical_resource_scope: ResourceScopeV2,
        approved_targets: Vec<ScopeTargetKey>,
        scope_delta: Vec<ScopeTargetKey>,
        decision_class: PreparedScopePreviewDecisionClassV2,
        effective_deadline_ms: u32,
        context_ref: ToolContextRefV2,
        descriptor: ToolDescriptorV2,
    ) -> AuthorityResult<UnpersistedScopePreview> {
        let run = self
            .inner
            .state
            .lock()
            .map_err(|_| storage_fault())?
            .runs
            .get(run_id)
            .cloned()
            .ok_or_else(|| KernelErrorV2::RunNotFound {
                run_id: run_id.clone(),
            })?;
        let scope_digest = capability_scope_digest_v2(&json!({
            "runId": run_id,
            "workspaceBindingDigest": run.workspace_binding_digest,
            "controlEpoch": control_epoch,
            "planRevision": plan_revision,
            "planActionId": plan_action_id,
            "toolId": tool_id,
            "authorizationBinding": authorization_binding,
            "targets": approved_targets,
            "canonicalResourceScope": canonical_resource_scope,
            "toolContractDigest": descriptor.contract_digest,
            "toolContext": context_ref,
            "effectClass": descriptor.effect_class,
            "effectScope": descriptor.effect_scope,
            "risk": descriptor.risk,
        }))
        .map_err(|_| storage_fault())?;
        let preview_id = self.inner.ids.preview_id();
        let authorization_digest = capability_authorization_digest_v2(&json!({
            "previewId": preview_id,
            "runId": run_id,
            "workspaceBindingDigest": run.workspace_binding_digest,
            "controlEpoch": control_epoch,
            "planRevision": plan_revision,
            "planActionId": plan_action_id,
            "operationId": operation_id,
            "toolId": tool_id,
            "authorizationBinding": authorization_binding,
            "scopeDigest": scope_digest,
            "decisionClass": decision_class,
            "toolContractDigest": descriptor.contract_digest,
            "toolContext": context_ref,
        }))
        .map_err(|_| storage_fault())?;
        let auto_approve_plans = self
            .inner
            .state
            .lock()
            .map_err(|_| storage_fault())?
            .run_settings
            .get(run_id)
            .map(|settings| settings.auto_approve_plans)
            .ok_or_else(storage_fault)?;
        let automatic_decision_ref =
            if auto_approve_plans && descriptor.effect_class != ToolEffectClassV2::Read {
                self.inner
                    .state
                    .lock()
                    .map_err(|_| storage_fault())?
                    .trusts
                    .values()
                    .find(|trust| {
                        trust.run_id == *run_id
                            && trust.control_epoch == control_epoch
                            && trust.plan_revision == plan_revision
                            && trust.plan_action_id == plan_action_id
                            && trust.tool_id == tool_id
                            && trust.workspace_binding_digest == run.workspace_binding_digest
                            && trust.context_ref == context_ref
                            && trust.authorization_binding == authorization_binding
                            && target_set_contains(&trust.approved_targets, &approved_targets)
                            && trust.expires_at.as_ref().is_none_or(recorded_at_is_future)
                    })
                    .map(|trust| trust.decision_ref.clone())
            } else {
                None
            };
        let disposition = if descriptor.effect_class == ToolEffectClassV2::Read
            || automatic_decision_ref.is_some()
        {
            CapabilityScopeDispositionV2::AutoIssuable
        } else {
            CapabilityScopeDispositionV2::RequiresUserDecision
        };
        let canonical_targets = approved_targets
            .iter()
            .map(scope_target_label)
            .collect::<Vec<_>>();
        let resource_presentation = approved_targets
            .iter()
            .map(scope_target_presentation)
            .collect::<Vec<_>>();
        let approval_view = CapabilityApprovalViewV2 {
            summary: format!(
                "{} {} within {} canonical target(s)",
                if descriptor.effect_class == ToolEffectClassV2::Read {
                    "Read using"
                } else {
                    "Mutate using"
                },
                tool_id,
                canonical_targets.len()
            ),
            canonical_targets,
            scope_delta: scope_delta.iter().map(scope_target_label).collect(),
            resource_presentation,
            risk: descriptor.risk,
            effect_class: descriptor.effect_class,
            effect_scope: descriptor.effect_scope,
            effective_deadline_ms,
            scope_digest: scope_digest.clone(),
        };
        let record = CapabilityScopePreviewRecordV2 {
            preview_id: preview_id.clone(),
            run_id: run_id.clone(),
            control_epoch,
            plan_revision: plan_revision.clone(),
            plan_action_id: plan_action_id.clone(),
            operation_id: operation_id.clone(),
            tool_id: tool_id.clone(),
            authorization_binding: authorization_binding.clone(),
            canonical_scope: canonical_resource_scope,
            scope_digest: scope_digest.clone(),
            authorization_digest: authorization_digest.clone(),
            tool_contract_digest: descriptor.contract_digest.clone(),
            context_ref: context_ref.clone(),
            effect_class: descriptor.effect_class,
            effect_scope: descriptor.effect_scope,
            risk: descriptor.risk,
            effective_deadline_ms,
            disposition,
            approval_view,
        };
        let payload = AuthorizationFactV2::ScopePreviewed {
            identity: AuthorizationIdentityV2 {
                run_id: run_id.clone(),
                control_epoch,
                plan_revision,
                plan_action_id,
                operation_id,
                causation_fact_id: run.control_fact_id,
                correlation_set: CorrelationSetV2::materialize(vec![
                    CorrelationRefV2::PlanAction {
                        value: record.plan_action_id.to_string(),
                    },
                ])
                .map_err(|_| storage_fault())?,
            },
            preview_id,
            tool_id,
            authorization_binding,
            scope_digest,
            tool_contract_digest: descriptor.contract_digest,
            context_ref,
            disposition,
        };
        let durable_preview = DurablePreparedScopePreviewV2 {
            record: record.clone(),
            approved_targets: approved_targets.clone(),
            authorization_digest: authorization_digest.clone(),
            automatic_decision_ref: automatic_decision_ref.clone(),
            decision_class,
        };
        Ok(UnpersistedScopePreview {
            record,
            approved_targets,
            authorization_digest,
            automatic_decision_ref,
            decision_class,
            payload,
            durable: durable_preview,
        })
    }

    fn persist_preview_draft(
        &self,
        draft: UnpersistedScopePreview,
    ) -> AuthorityResult<PreparedScopePreview> {
        let material = AuthorityMaterialMutationV2::Put {
            material: scope_preview_material(&draft.durable, AUTHORITY_MATERIAL_ACTIVE)?,
            fact_index: 0,
        };
        let fact = self
            .inner
            .authority
            .append_payloads_with_authority_material(
                vec![KernelFactPayloadV2::Authorization(draft.payload.clone())],
                vec![material],
            )?
            .facts
            .into_iter()
            .next()
            .ok_or_else(storage_fault)?;
        Ok(draft.into_prepared(fact.fact_id))
    }

    fn resolve_actual_authorization(
        &self,
        command: &ToolIntentSubmitV2,
        invocation: &KernelCanonicalInvocation,
        plan_action_id: &PlanActionIdV2,
    ) -> AuthorityResult<(ResourceScopeV2, Vec<ScopeTargetKey>, u32)> {
        let (scope, effective_deadline_ms) = self.inner.authority.canonical_scope_for_tool(
            &command.run_id,
            &command.operation_id,
            command.expected_control_epoch,
            &command.idempotency_key,
            invocation,
            command.deadline,
            vec![CorrelationRefV2::PlanAction {
                value: plan_action_id.to_string(),
            }],
        )?;
        let targets = authorization_targets_for_invocation(invocation, &scope)?;
        Ok((scope, targets, effective_deadline_ms))
    }

    fn canonical_scope_for_lease(
        &self,
        lease: &CapabilityLeaseRecord,
    ) -> AuthorityResult<ResourceScopeV2> {
        let state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let preview = state
            .previews
            .get(&lease.preview_id)
            .ok_or_else(storage_fault)?;
        if preview.record.run_id != lease.run_id
            || preview.record.control_epoch != lease.control_epoch
            || preview.record.plan_revision != lease.plan_revision
            || preview.record.plan_action_id != lease.plan_action_id
            || preview.record.tool_id != lease.tool_id
            || preview.record.context_ref != lease.context_ref
            || preview.record.authorization_binding != lease.authorization_binding
            || preview.approved_targets != lease.approved_targets
            || preview.record.scope_digest != lease.reference.scope_digest
        {
            return Err(storage_fault());
        }
        Ok(preview.record.canonical_scope.clone())
    }

    fn actual_scope_matches_other_plan_action(
        &self,
        command: &ToolIntentSubmitV2,
        plan_revision: &PlanRevisionV2,
        plan_action_id: &PlanActionIdV2,
        invocation: &KernelCanonicalInvocation,
        actual_targets: &[ScopeTargetKey],
    ) -> AuthorityResult<bool> {
        let state = self.inner.state.lock().map_err(|_| storage_fault())?;
        for preview in state.previews.values().filter(|preview| {
            preview.record.run_id == command.run_id
                && preview.record.control_epoch == command.expected_control_epoch
                && preview.record.plan_revision == *plan_revision
                && preview.record.plan_action_id != *plan_action_id
                && preview.record.tool_id == command.tool_id
                && preview.record.context_ref == command.tool_context_ref
        }) {
            if authorization_binding_allows(
                &preview.record.authorization_binding,
                &preview.approved_targets,
                invocation,
                actual_targets,
            )? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn reject_other_plan_action_scope(
        &self,
        command: ToolIntentSubmitV2,
        public_command: Option<PublicCommandContext>,
    ) -> AuthorityResult<ToolIntentSubmitReplyV2> {
        self.record_tool_intent_rejection(
            command,
            public_command,
            ToolIntentRejectionReasonV2::CapabilityScopeMismatch,
            "The actual target belongs to another PlanAction scope. Replan and submit the intent under the matching PlanAction before retrying."
                .to_owned(),
        )
    }

    fn reject_changed_exact_invocation(
        &self,
        command: ToolIntentSubmitV2,
        public_command: Option<PublicCommandContext>,
    ) -> AuthorityResult<ToolIntentSubmitReplyV2> {
        self.record_tool_intent_rejection(
            command,
            public_command,
            ToolIntentRejectionReasonV2::CapabilityScopeMismatch,
            "ExactInvocation arguments changed. Persist and preview a new PlanAction instead of expanding or replacing the existing capability lease."
                .to_owned(),
        )
    }

    fn submit_tool_intent(
        &self,
        command: ToolIntentSubmitV2,
        public_command: Option<PublicCommandContext>,
    ) -> AuthorityResult<ToolIntentSubmitReplyV2> {
        let rejected_command = command.clone();
        let rejected_public_command = public_command.clone();
        match self.submit_tool_intent_inner(command, public_command) {
            Ok(reply) => Ok(reply),
            Err(error) => {
                let Some((reason, guidance)) = classify_tool_intent_rejection(&error) else {
                    return Err(error);
                };
                self.record_tool_intent_rejection(
                    rejected_command,
                    rejected_public_command,
                    reason,
                    guidance,
                )
            }
        }
    }

    fn submit_tool_intent_inner(
        &self,
        command: ToolIntentSubmitV2,
        public_command: Option<PublicCommandContext>,
    ) -> AuthorityResult<ToolIntentSubmitReplyV2> {
        let run = self.run_record(&command.run_id)?;
        if run.control_epoch != command.expected_control_epoch {
            return Err(KernelErrorV2::StaleControlEpoch {
                run_id: command.run_id,
                submitted: command.expected_control_epoch,
                current: run.control_epoch,
            });
        }
        let context = self.build_tool_context(&command.run_id, run.context_version)?;
        if command.tool_context_ref != context.context_ref() {
            return Err(KernelErrorV2::ToolContextStale {
                submitted: command.tool_context_ref.clone(),
                current: context.context_ref(),
            });
        }
        let descriptor = self
            .inner
            .inventory
            .tools
            .iter()
            .find(|descriptor| descriptor.tool_id == command.tool_id)
            .cloned()
            .ok_or_else(|| KernelErrorV2::ToolNotRegistered {
                tool_id: command.tool_id.clone(),
            })?;
        let (availability, settings_allowed) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            let availability = state
                .runtime_availability
                .get(&(command.run_id.clone(), command.tool_id.clone()))
                .copied()
                .unwrap_or(descriptor.availability);
            let settings = state
                .run_settings
                .get(&command.run_id)
                .ok_or_else(storage_fault)?;
            (
                availability,
                settings_allow(settings, descriptor.effect_scope),
            )
        };
        if availability != ToolAvailabilityV2::Ready {
            return Err(KernelErrorV2::ToolUnavailable {
                tool_id: command.tool_id.clone(),
                availability,
            });
        }
        if !settings_allowed {
            return self.record_tool_intent_rejection(
                command,
                public_command,
                ToolIntentRejectionReasonV2::SettingsDenied,
                "Enable this tool scope in Settings before re-planning.".to_owned(),
            );
        }
        let invocation = canonical_invocation(&command.tool_id, &command.raw_arguments)?;
        match command.authority.clone() {
            ToolIntentAuthorityV2::ContextRead { .. } => {
                if descriptor.effect_class != ToolEffectClassV2::Read
                    || descriptor.effect_scope != ToolEffectScopeV2::WorkspaceRead
                {
                    return Err(invalid_field(
                        "authority",
                        InvalidFieldViolationV2::InvalidRelation,
                    ));
                }
                self.execute_context_read(command, invocation, &descriptor, public_command)
            }
            ToolIntentAuthorityV2::PlanAction {
                plan_revision,
                plan_action_id,
                lease,
            } => {
                let explicit_lease = if let Some(reference) = lease {
                    let existing = {
                        let state = self.inner.state.lock().map_err(|_| storage_fault())?;
                        state.leases.get(&reference.lease_id).cloned()
                    };
                    let Some(existing) = existing.filter(|record| {
                        record.reference == reference
                            && record.run_id == command.run_id
                            && record.control_epoch == command.expected_control_epoch
                            && record.plan_revision == plan_revision
                            && record.plan_action_id == plan_action_id
                            && record.tool_id == command.tool_id
                            && record.context_ref == command.tool_context_ref
                    }) else {
                        return self.record_tool_intent_rejection(
                            command,
                            public_command,
                            ToolIntentRejectionReasonV2::CapabilityLeaseStale,
                            "Refresh the approved capability lease before retrying.".to_owned(),
                        );
                    };
                    Some(existing)
                } else {
                    None
                };
                let (actual_scope, actual_targets, effective_deadline_ms) =
                    self.resolve_actual_authorization(&command, &invocation, &plan_action_id)?;
                if let Some(existing) = explicit_lease {
                    if descriptor.authorization_shape
                        != existing.authorization_binding.authorization_shape()
                    {
                        return self.record_tool_intent_rejection(
                            command,
                            public_command,
                            ToolIntentRejectionReasonV2::CapabilityLeaseStale,
                            "Refresh the capability lease for the current tool authorization shape."
                                .to_owned(),
                        );
                    }
                    if authorization_binding_allows(
                        &existing.authorization_binding,
                        &existing.approved_targets,
                        &invocation,
                        &actual_targets,
                    )? {
                        return self.execute_with_lease(
                            command,
                            self.inner.ids.invocation_id(),
                            &existing,
                            &descriptor,
                            public_command,
                        );
                    }
                    if exact_invocation_digest_changed(
                        &existing.authorization_binding,
                        &invocation,
                    )? {
                        return self.reject_changed_exact_invocation(command, public_command);
                    }
                    if self.actual_scope_matches_other_plan_action(
                        &command,
                        &plan_revision,
                        &plan_action_id,
                        &invocation,
                        &actual_targets,
                    )? {
                        return self.reject_other_plan_action_scope(command, public_command);
                    }
                    let previous_scope = self.canonical_scope_for_lease(&existing)?;
                    let (expanded_scope, expanded, delta) = expanded_authorization_scope(
                        &existing.authorization_binding,
                        &previous_scope,
                        &existing.approved_targets,
                        &actual_scope,
                        &actual_targets,
                    )?;
                    return self.await_capability(
                        command,
                        plan_revision,
                        plan_action_id,
                        descriptor,
                        invocation,
                        expanded_scope,
                        effective_deadline_ms,
                        expanded,
                        delta,
                        public_command,
                    );
                }
                let existing = {
                    let state = self.inner.state.lock().map_err(|_| storage_fault())?;
                    state
                        .leases
                        .values()
                        .filter(|record| {
                            record.run_id == command.run_id
                                && record.control_epoch == command.expected_control_epoch
                                && record.plan_revision == plan_revision
                                && record.plan_action_id == plan_action_id
                                && record.tool_id == command.tool_id
                                && record.context_ref == command.tool_context_ref
                        })
                        .max_by_key(|record| {
                            (
                                record.reference.version.get(),
                                record.issuance_ledger_sequence,
                            )
                        })
                        .cloned()
                };
                if let Some(existing) = existing {
                    if descriptor.authorization_shape
                        != existing.authorization_binding.authorization_shape()
                    {
                        return self.record_tool_intent_rejection(
                            command,
                            public_command,
                            ToolIntentRejectionReasonV2::CapabilityLeaseStale,
                            "Refresh the capability lease for the current tool authorization shape."
                                .to_owned(),
                        );
                    }
                    if authorization_binding_allows(
                        &existing.authorization_binding,
                        &existing.approved_targets,
                        &invocation,
                        &actual_targets,
                    )? {
                        return self.execute_with_lease(
                            command,
                            self.inner.ids.invocation_id(),
                            &existing,
                            &descriptor,
                            public_command,
                        );
                    }
                    if exact_invocation_digest_changed(
                        &existing.authorization_binding,
                        &invocation,
                    )? {
                        return self.reject_changed_exact_invocation(command, public_command);
                    }
                    if self.actual_scope_matches_other_plan_action(
                        &command,
                        &plan_revision,
                        &plan_action_id,
                        &invocation,
                        &actual_targets,
                    )? {
                        return self.reject_other_plan_action_scope(command, public_command);
                    }
                    let previous_scope = self.canonical_scope_for_lease(&existing)?;
                    let (expanded_scope, expanded, delta) = expanded_authorization_scope(
                        &existing.authorization_binding,
                        &previous_scope,
                        &existing.approved_targets,
                        &actual_scope,
                        &actual_targets,
                    )?;
                    return self.await_capability(
                        command,
                        plan_revision,
                        plan_action_id,
                        descriptor,
                        invocation,
                        expanded_scope,
                        effective_deadline_ms,
                        expanded,
                        delta,
                        public_command,
                    );
                }
                let prepared = {
                    let state = self.inner.state.lock().map_err(|_| storage_fault())?;
                    let mut matching = state.previews.values().filter(|preview| {
                        preview.record.run_id == command.run_id
                            && preview.record.control_epoch == command.expected_control_epoch
                            && preview.record.plan_revision == plan_revision
                            && preview.record.plan_action_id == plan_action_id
                            && preview.record.operation_id == command.operation_id
                            && preview.record.tool_id == command.tool_id
                            && preview.record.context_ref == command.tool_context_ref
                            && preview.decision_class
                                == PreparedScopePreviewDecisionClassV2::Capability
                    });
                    let preview = matching.next().cloned();
                    if matching.next().is_some() {
                        return Err(storage_fault());
                    }
                    preview
                };
                let Some(prepared) = prepared else {
                    if self.actual_scope_matches_other_plan_action(
                        &command,
                        &plan_revision,
                        &plan_action_id,
                        &invocation,
                        &actual_targets,
                    )? {
                        return self.reject_other_plan_action_scope(command, public_command);
                    }
                    return self.record_tool_intent_rejection(
                        command,
                        public_command,
                        ToolIntentRejectionReasonV2::PlanActionRequired,
                        "Preview this PlanAction through CapabilityScopePreviewBatch before submitting its tool intent."
                            .to_owned(),
                    );
                };
                if descriptor.authorization_shape
                    != prepared.record.authorization_binding.authorization_shape()
                {
                    return self.record_tool_intent_rejection(
                        command,
                        public_command,
                        ToolIntentRejectionReasonV2::CapabilityLeaseStale,
                        "Refresh the plan preview for the current tool authorization shape."
                            .to_owned(),
                    );
                }
                if !authorization_binding_allows(
                    &prepared.record.authorization_binding,
                    &prepared.approved_targets,
                    &invocation,
                    &actual_targets,
                )? {
                    if exact_invocation_digest_changed(
                        &prepared.record.authorization_binding,
                        &invocation,
                    )? {
                        return self.reject_changed_exact_invocation(command, public_command);
                    }
                    if self.actual_scope_matches_other_plan_action(
                        &command,
                        &plan_revision,
                        &plan_action_id,
                        &invocation,
                        &actual_targets,
                    )? {
                        return self.reject_other_plan_action_scope(command, public_command);
                    }
                    let (expanded_scope, expanded, delta) = expanded_authorization_scope(
                        &prepared.record.authorization_binding,
                        &prepared.record.canonical_scope,
                        &prepared.approved_targets,
                        &actual_scope,
                        &actual_targets,
                    )?;
                    return self.await_capability(
                        command,
                        plan_revision,
                        plan_action_id,
                        descriptor,
                        invocation,
                        expanded_scope,
                        effective_deadline_ms,
                        expanded,
                        delta,
                        public_command,
                    );
                }
                if prepared.record.disposition == CapabilityScopeDispositionV2::AutoIssuable {
                    let lease = self.issue_public_lease(
                        &prepared,
                        prepared.automatic_decision_ref.clone(),
                        prepared.preview_fact_id.clone(),
                        None,
                    )?;
                    self.execute_with_lease(
                        command,
                        self.inner.ids.invocation_id(),
                        &lease,
                        &descriptor,
                        public_command,
                    )
                } else {
                    let preview_id = prepared.record.preview_id.clone();
                    self.await_preview(command, preview_id, public_command)
                }
            }
        }
    }

    fn record_tool_intent_rejection(
        &self,
        command: ToolIntentSubmitV2,
        public_command: Option<PublicCommandContext>,
        reason: ToolIntentRejectionReasonV2,
        guidance: String,
    ) -> AuthorityResult<ToolIntentSubmitReplyV2> {
        let public_command = public_command.ok_or_else(storage_fault)?;
        let run_id = command.run_id.clone();
        self.inner.authority.reject_tool_intent_with_public_receipt(
            command.run_id,
            command.operation_id,
            command.expected_control_epoch,
            reason,
            guidance,
            move |reply| {
                public_receipt(
                    public_command.request_id,
                    public_command.request_digest,
                    public_command.command_kind,
                    Some(run_id),
                    &DurablePublicReplyV2::Kernel {
                        reply: KernelReplyV2::ToolIntentSubmission(reply.clone()),
                    },
                    None,
                )
            },
        )
    }

    fn await_capability(
        &self,
        command: ToolIntentSubmitV2,
        plan_revision: PlanRevisionV2,
        plan_action_id: PlanActionIdV2,
        descriptor: ToolDescriptorV2,
        invocation: KernelCanonicalInvocation,
        canonical_scope: ResourceScopeV2,
        effective_deadline_ms: u32,
        targets: Vec<ScopeTargetKey>,
        scope_delta: Vec<ScopeTargetKey>,
        public_command: Option<PublicCommandContext>,
    ) -> AuthorityResult<ToolIntentSubmitReplyV2> {
        let authorization_binding = match descriptor.authorization_shape {
            ToolAuthorizationShapeV2::ResourceScope => {
                CapabilityAuthorizationBindingV2::ResourceScope {}
            }
            ToolAuthorizationShapeV2::ExactInvocation => {
                CapabilityAuthorizationBindingV2::ExactInvocation {
                    invocation_digest: exact_invocation_digest_v2(&invocation)
                        .map_err(|_| storage_fault())?,
                }
            }
        };
        let draft = self.prepare_preview_draft(
            &command.run_id,
            command.expected_control_epoch,
            plan_revision,
            plan_action_id,
            command.operation_id.clone(),
            command.tool_id.clone(),
            authorization_binding,
            canonical_scope,
            targets,
            scope_delta,
            PreparedScopePreviewDecisionClassV2::ScopeExpansion,
            effective_deadline_ms,
            command.tool_context_ref.clone(),
            descriptor,
        )?;
        let prepared = self.persist_preview_draft(draft)?;
        let preview_id = prepared.record.preview_id.clone();
        self.inner
            .state
            .lock()
            .map_err(|_| storage_fault())?
            .previews
            .insert(preview_id.clone(), prepared);
        self.await_preview(command, preview_id, public_command)
    }

    fn await_preview(
        &self,
        command: ToolIntentSubmitV2,
        preview_id: CapabilityScopePreviewIdV2,
        public_command: Option<PublicCommandContext>,
    ) -> AuthorityResult<ToolIntentSubmitReplyV2> {
        let prepared = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            state
                .previews
                .get(&preview_id)
                .cloned()
                .ok_or_else(storage_fault)?
        };
        if prepared.record.run_id != command.run_id
            || prepared.record.operation_id != command.operation_id
            || prepared.record.control_epoch != command.expected_control_epoch
        {
            return Err(storage_fault());
        }
        let invocation_id = self.inner.ids.invocation_id();
        let durable_pending = DurablePendingIntentV2::from_command(
            &command,
            invocation_id.clone(),
            prepared.record.preview_id.clone(),
        );
        let pending_lease = match &durable_pending.authority {
            ToolIntentAuthorityV2::PlanAction { lease, .. } => lease.clone(),
            ToolIntentAuthorityV2::ContextRead { .. } => None,
        };
        let pending_material =
            pending_intent_material(&durable_pending, AUTHORITY_MATERIAL_AWAITING, pending_lease)?;
        let idempotency_key_hash =
            idempotency_key_hash_v2(&command.run_id, &command.idempotency_key)
                .map_err(|_| storage_fault())?;
        let invocation = canonical_invocation(&command.tool_id, &command.raw_arguments)?;
        let canonical_arguments = canonical_argument_value(&invocation)?;
        let canonical_arguments_digest =
            canonical_arguments_digest_v2(&command.tool_id, &canonical_arguments)
                .map_err(|_| storage_fault())?;
        let payload = AuthorizationFactV2::CapabilityAwaiting {
            identity: CapabilityAwaitingIdentityV2 {
                run_id: command.run_id.clone(),
                control_epoch: command.expected_control_epoch,
                plan_revision: prepared.record.plan_revision.clone(),
                plan_action_id: prepared.record.plan_action_id.clone(),
                operation_id: command.operation_id.clone(),
                invocation_id: invocation_id.clone(),
                idempotency_key_hash,
                causation_fact_id: prepared.preview_fact_id.clone(),
                correlation_set: plan_action_correlations(&prepared.record.plan_action_id)?,
            },
            preview_id: prepared.record.preview_id.clone(),
            tool_id: command.tool_id.clone(),
            canonical_arguments_digest,
            scope_digest: prepared.record.scope_digest.clone(),
            tool_contract_digest: prepared.record.tool_contract_digest.clone(),
            context_ref: prepared.record.context_ref.clone(),
        };
        let fact = if let Some(public_command) = public_command {
            let run_id = command.run_id.clone();
            let operation_id = command.operation_id.clone();
            let preview = prepared.record.clone();
            let public_invocation_id = invocation_id.clone();
            let accepted_control_epoch = command.expected_control_epoch;
            let command_request_id = public_command.request_id.clone();
            let command_request_digest = public_command.request_digest.clone();
            let outcome = self
                .inner
                .authority
                .append_built_payloads_with_public_receipt_and_authority_material(
                    2,
                    0,
                    vec![AuthorityMaterialMutationV2::Put {
                        material: pending_material,
                        fact_index: 1,
                    }],
                    move |fact_ids, ledger_sequences| {
                        let reply = ToolIntentSubmitReplyV2::AwaitingCapability {
                            run_id: run_id.clone(),
                            operation_id: operation_id.clone(),
                            accepted_control_epoch,
                            invocation_id: public_invocation_id.clone(),
                            preview: preview.clone(),
                            awaiting_fact_id: fact_ids[1].clone(),
                            awaiting_batch_high_water: ledger_sequences[1],
                        };
                        let command_recorded =
                            KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded {
                                identity: CommandReceiptIdentityV2 {
                                    run_id: run_id.clone(),
                                    epoch_context: CommandEpochContextV2::Exact {
                                        control_epoch: accepted_control_epoch,
                                    },
                                    command_request_identity: CommandRequestIdentityV2 {
                                        command_request_id: command_request_id.clone(),
                                        command_request_digest: command_request_digest.clone(),
                                    },
                                },
                                command_kind: MutationCommandKindV2::ToolIntentSubmit,
                                result: MutationCommandResultV2::ToolIntentSubmission {
                                    reply: reply.clone(),
                                },
                            });
                        let receipt = public_receipt(
                            public_command.request_id,
                            public_command.request_digest,
                            public_command.command_kind,
                            Some(run_id.clone()),
                            &DurablePublicReplyV2::Kernel {
                                reply: KernelReplyV2::ToolIntentSubmission(reply),
                            },
                            None,
                        )?;
                        Ok((
                            vec![
                                command_recorded,
                                KernelFactPayloadV2::Authorization(payload),
                            ],
                            receipt,
                        ))
                    },
                )?;
            match outcome.receipt {
                PutPublicCommandReceiptOutcomeV2::Inserted(_) => {
                    outcome.facts.into_iter().nth(1).ok_or_else(storage_fault)?
                }
                PutPublicCommandReceiptOutcomeV2::ExistingSame(_)
                | PutPublicCommandReceiptOutcomeV2::DigestConflict { .. } => {
                    return Err(storage_fault())
                }
            }
        } else {
            self.inner
                .authority
                .append_payloads_with_authority_material(
                    vec![KernelFactPayloadV2::Authorization(payload)],
                    vec![AuthorityMaterialMutationV2::Put {
                        material: pending_material,
                        fact_index: 0,
                    }],
                )?
                .facts
                .into_iter()
                .next()
                .ok_or_else(storage_fault)?
        };
        {
            let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
            state.pending.insert(
                prepared.record.preview_id.clone(),
                durable_pending.into_pending(fact.fact_id.clone()),
            );
        }
        Ok(ToolIntentSubmitReplyV2::AwaitingCapability {
            run_id: command.run_id,
            operation_id: command.operation_id,
            accepted_control_epoch: command.expected_control_epoch,
            invocation_id,
            preview: prepared.record,
            awaiting_fact_id: fact.fact_id,
            awaiting_batch_high_water: fact.ledger_sequence,
        })
    }

    fn execute_context_read(
        &self,
        command: ToolIntentSubmitV2,
        invocation: KernelCanonicalInvocation,
        descriptor: &ToolDescriptorV2,
        public_command: Option<PublicCommandContext>,
    ) -> AuthorityResult<ToolIntentSubmitReplyV2> {
        let settings_digest = self.settings_ceiling_digest(&command.run_id)?;
        let tool_context_ref = command.tool_context_ref.clone();
        let policy_evaluation_digest = invocation_policy_evaluation_digest_v2(
            &command.run_id,
            command.expected_control_epoch,
            &command.tool_id,
            &tool_context_ref,
            &settings_digest,
            None,
        )
        .map_err(|_| storage_fault())?;
        self.execute_direct_tool_intent(
            command,
            invocation,
            InvocationAuthorityV2::ContextRead {
                tool_context_ref,
                settings_digest,
                policy_evaluation_digest,
            },
            descriptor,
            None,
            public_command,
        )
    }

    fn settings_ceiling_digest(
        &self,
        run_id: &RunId,
    ) -> AuthorityResult<deepcode_kernel_abi::v2::SettingsCeilingDigestV2> {
        let settings = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            state
                .run_settings
                .get(run_id)
                .cloned()
                .ok_or_else(storage_fault)?
        };
        settings_digest(&settings)
    }

    fn execute_direct_tool_intent(
        &self,
        command: ToolIntentSubmitV2,
        invocation: KernelCanonicalInvocation,
        authority: InvocationAuthorityV2,
        descriptor: &ToolDescriptorV2,
        preferred_invocation_id: Option<InvocationId>,
        public_command: Option<PublicCommandContext>,
    ) -> AuthorityResult<ToolIntentSubmitReplyV2> {
        let public_command = public_command.ok_or_else(storage_fault)?;
        let canonical_arguments = canonical_argument_value(&invocation)?;
        let canonical_arguments_digest =
            canonical_arguments_digest_v2(&command.tool_id, &canonical_arguments)
                .map_err(|_| storage_fault())?;
        let tool_contract_digest =
            tool_contract_digest_v2(descriptor).map_err(|_| storage_fault())?;
        let run_id = command.run_id.clone();
        self.inner
            .authority
            .admit_direct_tool_intent_with_public_receipt(
                DirectToolIntentRequest {
                    run_id: command.run_id,
                    operation_id: command.operation_id,
                    control_epoch: command.expected_control_epoch,
                    idempotency_key: command.idempotency_key,
                    tool_id: command.tool_id,
                    canonical_arguments_digest,
                    canonical_invocation: invocation,
                    authority,
                    tool_contract_digest,
                    deadline: command.deadline,
                },
                preferred_invocation_id,
                Vec::new(),
                move |reply| {
                    let settlement_fact_id = match reply {
                        ToolIntentSubmitReplyV2::Admitted {
                            admission_fact_id, ..
                        } => Some(admission_fact_id.clone()),
                        ToolIntentSubmitReplyV2::AwaitingCapability {
                            awaiting_fact_id, ..
                        } => Some(awaiting_fact_id.clone()),
                        ToolIntentSubmitReplyV2::Rejected {
                            rejection_fact_id, ..
                        } => Some(rejection_fact_id.clone()),
                    };
                    public_receipt(
                        public_command.request_id,
                        public_command.request_digest,
                        public_command.command_kind,
                        Some(run_id),
                        &DurablePublicReplyV2::Kernel {
                            reply: KernelReplyV2::ToolIntentSubmission(reply.clone()),
                        },
                        settlement_fact_id,
                    )
                },
            )
    }

    fn execute_with_lease(
        &self,
        command: ToolIntentSubmitV2,
        invocation_id: InvocationId,
        lease: &CapabilityLeaseRecord,
        descriptor: &ToolDescriptorV2,
        public_command: Option<PublicCommandContext>,
    ) -> AuthorityResult<ToolIntentSubmitReplyV2> {
        let invocation = canonical_invocation(&command.tool_id, &command.raw_arguments)?;
        if descriptor.authorization_shape != lease.authorization_binding.authorization_shape() {
            return Err(invalid_field(
                "authority.lease",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let (_, actual_targets, _) =
            self.resolve_actual_authorization(&command, &invocation, &lease.plan_action_id)?;
        if !authorization_binding_allows(
            &lease.authorization_binding,
            &lease.approved_targets,
            &invocation,
            &actual_targets,
        )? {
            return Err(invalid_field(
                "authority.lease",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let settings_digest = self.settings_ceiling_digest(&command.run_id)?;
        let policy_evaluation_digest = invocation_policy_evaluation_digest_v2(
            &command.run_id,
            command.expected_control_epoch,
            &command.tool_id,
            &command.tool_context_ref,
            &settings_digest,
            Some(&lease.reference),
        )
        .map_err(|_| storage_fault())?;
        self.execute_direct_tool_intent(
            command,
            invocation,
            InvocationAuthorityV2::PlanAction {
                plan_revision: lease.plan_revision.clone(),
                plan_action_id: lease.plan_action_id.clone(),
                lease: lease.reference.clone(),
                policy_evaluation_digest,
            },
            descriptor,
            Some(invocation_id),
            public_command,
        )
    }

    fn issue_public_lease(
        &self,
        preview: &PreparedScopePreview,
        decision_ref: Option<UserDecisionRefV2>,
        causation_fact_id: FactId,
        public_decision: Option<(PublicCommandContext, bool)>,
    ) -> AuthorityResult<CapabilityLeaseRecord> {
        let (previous, lease_id, version) = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            let previous = state
                .leases
                .values()
                .filter(|lease| {
                    lease.run_id == preview.record.run_id
                        && lease.control_epoch == preview.record.control_epoch
                        && lease.plan_revision == preview.record.plan_revision
                        && lease.plan_action_id == preview.record.plan_action_id
                        && lease.tool_id == preview.record.tool_id
                })
                .max_by_key(|lease| lease.reference.version.get())
                .cloned();
            let version = previous
                .as_ref()
                .map(|lease| {
                    lease
                        .reference
                        .version
                        .get()
                        .checked_add(1)
                        .ok_or_else(storage_fault)
                })
                .transpose()?
                .unwrap_or(1);
            let lease_id = previous
                .as_ref()
                .map(|lease| lease.reference.lease_id.clone())
                .unwrap_or_else(|| self.inner.ids.lease_id());
            (
                previous,
                lease_id,
                CapabilityLeaseVersionV2::new(version).map_err(|_| storage_fault())?,
            )
        };
        let reference = CapabilityLeaseRefV2 {
            lease_id: lease_id.clone(),
            version,
            scope_digest: preview.record.scope_digest.clone(),
        };
        if previous.as_ref().is_some_and(|lease| {
            !authorization_binding_can_expand(
                &lease.authorization_binding,
                &preview.record.authorization_binding,
            )
        }) {
            return Err(invalid_field(
                "authorizationBinding",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        if previous.as_ref().is_some_and(|lease| {
            !target_set_contains(&preview.approved_targets, &lease.approved_targets)
        }) {
            return Err(invalid_field(
                "authorizationBinding",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let identity = CapabilityLeaseFactIdentityV2 {
            run_id: preview.record.run_id.clone(),
            control_epoch: preview.record.control_epoch,
            plan_revision: preview.record.plan_revision.clone(),
            plan_action_id: preview.record.plan_action_id.clone(),
            operation_id: preview.record.operation_id.clone(),
            preview_id: preview.record.preview_id.clone(),
            lease_id: lease_id.clone(),
            lease_version: version,
            causation_fact_id,
            correlation_set: plan_action_correlations(&preview.record.plan_action_id)?,
        };
        let payload = match &previous {
            Some(previous) => AuthorizationFactV2::ExpansionAllowed {
                identity,
                previous_lease_id: previous.reference.lease_id.clone(),
                previous_scope_digest: previous.reference.scope_digest.clone(),
                expanded_scope_digest: preview.record.scope_digest.clone(),
                authorization_digest: preview.authorization_digest.clone(),
            },
            None => AuthorizationFactV2::CapabilityIssued {
                identity,
                tool_id: preview.record.tool_id.clone(),
                scope_digest: preview.record.scope_digest.clone(),
                authorization_digest: preview.authorization_digest.clone(),
                tool_contract_digest: preview.record.tool_contract_digest.clone(),
                context_ref: preview.record.context_ref.clone(),
            },
        };
        let durable_lease = DurableCapabilityLeaseV2 {
            reference: reference.clone(),
            run_id: preview.record.run_id.clone(),
            control_epoch: preview.record.control_epoch,
            plan_revision: preview.record.plan_revision.clone(),
            plan_action_id: preview.record.plan_action_id.clone(),
            tool_id: preview.record.tool_id.clone(),
            context_ref: preview.record.context_ref.clone(),
            authorization_binding: preview.record.authorization_binding.clone(),
            approved_targets: preview.approved_targets.clone(),
            decision_ref: decision_ref.clone(),
            issuance_operation_id: preview.record.operation_id.clone(),
            preview_id: preview.record.preview_id.clone(),
        };
        let material = capability_lease_material(&durable_lease, AUTHORITY_MATERIAL_ACTIVE)?;
        let material_mutation = if previous.is_some() {
            AuthorityMaterialMutationV2::Replace {
                expected_lifecycle: AUTHORITY_MATERIAL_ACTIVE.to_owned(),
                expected_payload_digest: None,
                material,
                fact_index: 0,
            }
        } else {
            AuthorityMaterialMutationV2::Put {
                material,
                fact_index: 0,
            }
        };
        let fact = if let Some((public_command, expansion)) = public_decision {
            let run_id = preview.record.run_id.clone();
            let reply_reference = reference.clone();
            self.append_user_decision_fact_with_material(
                run_id,
                payload,
                public_command,
                vec![material_mutation],
                move |fact_id, ledger_sequence| {
                    if expansion {
                        UserDecisionReplyV2::ScopeExpansionRecorded {
                            lease: reply_reference,
                            fact_id,
                            ledger_sequence,
                        }
                    } else {
                        UserDecisionReplyV2::CapabilityIssued {
                            lease: reply_reference,
                            fact_id,
                            ledger_sequence,
                        }
                    }
                },
            )?
            .0
        } else {
            self.inner
                .authority
                .append_payloads_with_authority_material(
                    vec![KernelFactPayloadV2::Authorization(payload)],
                    vec![material_mutation],
                )?
                .facts
                .into_iter()
                .next()
                .ok_or_else(storage_fault)?
        };
        let lease = durable_lease.into_record(fact.fact_id.clone(), fact.ledger_sequence);
        {
            let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
            if let Some(previous) = previous {
                state.leases.remove(&previous.reference.lease_id);
            }
            state
                .leases
                .insert(reference.lease_id.clone(), lease.clone());
        }
        Ok(lease)
    }

    fn record_denial(
        &self,
        preview: &PreparedScopePreview,
        causation_fact_id: FactId,
        guidance: String,
        is_expansion: bool,
        public_command: Option<PublicCommandContext>,
        material_mutations: Vec<AuthorityMaterialMutationV2>,
    ) -> AuthorityResult<(KernelFactEnvelopeV2, bool)> {
        let identity = AuthorizationIdentityV2 {
            run_id: preview.record.run_id.clone(),
            control_epoch: preview.record.control_epoch,
            plan_revision: preview.record.plan_revision.clone(),
            plan_action_id: preview.record.plan_action_id.clone(),
            operation_id: preview.record.operation_id.clone(),
            causation_fact_id,
            correlation_set: plan_action_correlations(&preview.record.plan_action_id)?,
        };
        let payload = if is_expansion {
            AuthorizationFactV2::ExpansionDenied {
                identity,
                preview_id: preview.record.preview_id.clone(),
                requested_scope_digest: preview.record.scope_digest.clone(),
                authorization_digest: preview.authorization_digest.clone(),
                guidance,
            }
        } else {
            AuthorizationFactV2::CapabilityDenied {
                identity,
                preview_id: preview.record.preview_id.clone(),
                tool_id: preview.record.tool_id.clone(),
                scope_digest: preview.record.scope_digest.clone(),
                authorization_digest: preview.authorization_digest.clone(),
                guidance,
            }
        };
        if let Some(public_command) = public_command {
            let run_id = preview.record.run_id.clone();
            let (fact, _) = self.append_user_decision_fact_with_material(
                run_id,
                payload,
                public_command,
                material_mutations,
                move |fact_id, ledger_sequence| {
                    if is_expansion {
                        UserDecisionReplyV2::ScopeExpansionDenied {
                            fact_id,
                            ledger_sequence,
                        }
                    } else {
                        UserDecisionReplyV2::CapabilityDenied {
                            fact_id,
                            ledger_sequence,
                        }
                    }
                },
            )?;
            Ok((fact, true))
        } else {
            self.inner
                .authority
                .append_payloads_with_authority_material(
                    vec![KernelFactPayloadV2::Authorization(payload)],
                    material_mutations,
                )?
                .facts
                .into_iter()
                .next()
                .ok_or_else(storage_fault)
                .map(|fact| (fact, false))
        }
    }

    fn query_projected_facts(
        &self,
        command: KernelFactsQueryScopedV2,
        request_id: CommandRequestId,
        request_digest: CommandRequestDigestV2,
    ) -> AuthorityResult<KernelFactProjectionPageV2> {
        self.run_record(&command.run_id)?;
        let (snapshot_high_water, requested_after) =
            if let Some(token) = command.continuation.clone() {
                let expected = FactQueryContinuationExpectationV2 {
                    run_id: command.run_id.clone(),
                    after_ledger_sequence: command.after_ledger_sequence,
                };
                let consumed = self.inner.authority.consume_fact_query_continuation(
                    token,
                    expected,
                    FactQueryContinuationConsumerV2 {
                        command_request_id: request_id.clone(),
                        command_request_digest: request_digest.clone(),
                    },
                )?;
                let cursor = match consumed {
                    ConsumeFactQueryContinuationOutcomeV2::Consumed(cursor)
                    | ConsumeFactQueryContinuationOutcomeV2::ExistingSame(cursor) => cursor,
                    ConsumeFactQueryContinuationOutcomeV2::NotFound
                    | ConsumeFactQueryContinuationOutcomeV2::Expired { .. }
                    | ConsumeFactQueryContinuationOutcomeV2::ScopeMismatch
                    | ConsumeFactQueryContinuationOutcomeV2::AlreadyConsumed => {
                        return Err(invalid_field(
                            "continuation",
                            InvalidFieldViolationV2::InvalidRelation,
                        ))
                    }
                };
                (cursor.snapshot_high_water, cursor.after_ledger_sequence)
            } else {
                let high_water = self
                    .inner
                    .authority
                    .query_run_facts(&command.run_id, command.after_ledger_sequence, 1)?
                    .0;
                (high_water, command.after_ledger_sequence)
            };
        let (_, raw, _) = self.inner.authority.query_run_facts(
            &command.run_id,
            requested_after,
            command.limit.saturating_add(1),
        )?;
        let mut raw = raw
            .into_iter()
            .filter(|fact| fact.ledger_sequence <= snapshot_high_water)
            .collect::<Vec<_>>();
        let has_more = raw.len() > command.limit as usize;
        raw.truncate(command.limit as usize);
        let facts = raw
            .into_iter()
            .map(project_fact)
            .collect::<AuthorityResult<Vec<_>>>()?;
        let next_after = facts
            .last()
            .map(|fact| fact.ledger_sequence)
            .unwrap_or(requested_after);
        let template = DurableFactPageV2 {
            run_id: command.run_id.clone(),
            requested_after_ledger_sequence: requested_after,
            snapshot_high_water,
            facts,
            has_more,
            next_after_ledger_sequence: if has_more {
                next_after
            } else {
                snapshot_high_water
            },
        };
        let page = self.materialize_facts_page(template.clone())?;
        page.validate().map_err(|_| storage_fault())?;
        let stored = DurablePublicReplyV2::Facts { page: template };
        let persisted = self.persist_reply(
            request_id,
            request_digest,
            "kernelFactsQueryScoped",
            Some(command.run_id),
            stored,
            None,
        )?;
        if !matches!(persisted, DurablePublicReplyV2::Facts { .. }) {
            return Err(storage_fault());
        }
        Ok(page)
    }
}
