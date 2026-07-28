use super::model::{
    invocation_phase_is_terminal, AuthorityResult, AuthorityState, CommandReplay,
    DirectInvocationRecord, ExecutionResolution, GrantDecisionReplay, GrantLifecycle, GrantRecord,
    InvocationPhase, InvocationRecord, PreparedDirectToolIntent, PreparedGrantRequest, RawExecution,
    ReservationRecord, ResolvedTarget, ResourceRecord, RunLifecycle, RunRecord, StopOverlay,
    SubmissionBinding, VerifiedExecution, WorkspaceBinding,
};
use crate::executors::{plan_v2_text_edit, KernelExecutorConfig};
use crate::network_policy::review_http_target;
use deepcode_kernel_abi::tool_catalog_v4::{
    output_payload_measure_v4, AuthorityToolIdV4, DeadlineV4,
    DeleteTargetV4, DocumentPagesV4, EffectScopeV4, ExecutionAvailabilityV4, LineRangeV4,
    NetworkPublicTargetV4, OutputTruncationV4, PathEntrySizeV4, PathEntryV4,
    SearchMatchV4, SearchStrategyV4, TextMediaTypeV4, ToolContractV4, ToolInvocationInputV4,
    ToolOutputPayloadV4, ToolOutputV4, ToolRiskV4, WebSearchItemV4, WorkspaceObjectKindV4,
};
use deepcode_kernel_abi::v2::{
    authorization_request_digest_v2, collection_digest_v2, content_digest_v2,
    executor_evidence_digest_v2, grant_scope_digest_v2, idempotency_key_hash_v2,
    invocation_submission_digest_v2, network_response_digest_v2, network_target_digest_v2,
    query_digest_v2, resource_state_digest_v2, target_revalidation_digest_v2,
    target_revalidation_set_digest_v2, workspace_binding_digest_v2, AdmissionRejectionV2,
    AttemptIdentityV2, AuthorizationFactV2, AuthorizationIdentityV2,
    AuthorizationRequestDigestV2, AutonomyModeV2, CancelRequestId,
    CancellationIdentityV2, CancellationReasonCodeV2, CancellationSourceV2,
    CapabilityAwaitingIdentityV2, CapabilityLeaseFactIdentityV2,
    CanonicalPrivateTargetV2, CommandEpochContextV2, CommandReceiptIdentityV2,
    CommandRequestDigestV2, CommandRequestId, CommandRequestIdentityV2, ControlEpoch,
    ControlFactV2, CorrelationRefV2, CorrelationSetV2, DeletionBeforeObservationV2,
    DirectoryBeforeObservationV2,
    EffectEvidenceV2, EffectFactV2, EffectId, EffectIdentityV2, ExecutorEvidenceDigestV2, FactId,
    FileBeforeObservationV2, GrantDecisionBasisV2, GrantDecisionDigestV2, GrantDenialReasonV2,
    GrantDeniedIdentityV2, GrantFactV2, GrantId, GrantIssuedIdentityV2, GrantLifecycleIdentityV2,
    GrantSupersessionCauseV2, GrantUsePolicyV2, IdempotencyKeyHashV2, IndeterminateReasonV2,
    InputId, InvocationFactV2, InvocationId, InvocationRejectedIdentityV2,
    InvocationAuthorityV2,
    InvocationRequestDigestV2, InvocationSubmissionDigestV2, KernelFactDraftV2,
    KernelFactEnvelopeV2, KernelFactPayloadV2, LastObservationV2, MutationCommandResultV2,
    NetworkAddressV2, NetworkHostV2, NetworkOriginV2, NetworkQueryV2, NetworkRequestTargetV2,
    NetworkSchemeV2, NetworkTargetObservationDigestV2, ObservedTerminalIdentityV2, OperationId,
    OperationIdempotencyConflictV2, PairKnownSideV2, PlatformV2, PostObservedEffectFailureCodeV2,
    PreEffectFailureCodeV2, PresentFileObservationV2, ReservationIdentityV2,
    ReservationReleaseReasonV2, ResolutionObservationV2, ResolvedResourceV2, ResourceAccessV2,
    ResourceAttemptIdentityV2, ResourceFactV2, ResourceId, ResourceProjectionObservationV2,
    ResourceResolvedIdentityV2, ResourceScopeV2, ResourceStateV2, RunId, TargetResolutionFailureV2,
    TargetRevalidationDigestV2, TargetRevalidationObservationV2, TargetRevalidationSetDigestV2,
    ToolAttemptIdentityV2, ToolEffectIdentityV2, ToolObservedTerminalIdentityV2,
    TransitionIdentityV2, WorkspaceObjectKindV2, WorkspaceScopeTargetV2,
    MAX_FACT_PAGE_BYTES_V2,
};
use deepcode_kernel_abi::v2_command::{
    CanonicalGrantRequestV2, ControlCancellationReplyV2, ControlEpochAdvanceV2,
    ControlEpochAdvancedReplyV2, DeadlineRequestV2, EpochPreconditionV2, FactPageContinuationV2,
    GrantDecisionReplyV2, GrantRequestV2, GrantRevokeV2,
    GrantRevokedReplyV2, InvalidFieldViolationV2, InvalidRelationV2, InvalidRequestReasonV2,
    InvocationCancelReplyV2, InvocationCancelV2, InvocationStatusIdentityV2,
    InvocationStatusReplyV2, InvocationSubmissionReplyV2, KernelErrorV2, KernelFactFilterV2,
    KernelFactPageV2, KernelFactPredicateV2, KernelFactsQueryV2, KernelReplyV2,
    MutationCommandKindV2, RecordedCommandErrorV2, ResourceLifecycleV2, ResourceResolveReplyV2,
    ResourceResolveV2, RunTerminateV2, RunTerminatedReplyV2, StorageFaultCodeV2,
    ToolIntentSubmitReplyV2,
};
use deepcode_kernel_ledger::v2::FactQueryV2;
use deepcode_kernel_tools::{
    normalize_canonical_platform_path_v4, validate_canonical_invocation_v4,
    LocalAuthorityToolCatalogV4,
};
use deepcode_kernel_abi::ToolIdV2;
use deepcode_kernel_abi::{CanonicalArgumentsDigestV2, ToolContractDigestV2};
use std::collections::HashMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Component, Path, PathBuf};

pub(super) enum PrepareFailure {
    Kernel(KernelErrorV2),
    Target(TargetResolutionFailureV2),
}

pub(super) enum RunCommandCheck {
    Current(RunRecord),
    Recorded(KernelReplyV2),
}

pub(super) const fn exact_epoch(control_epoch: ControlEpoch) -> CommandEpochContextV2 {
    CommandEpochContextV2::Exact { control_epoch }
}

pub(super) fn caused_attempt(
    identity: &AttemptIdentityV2,
    causation_fact_id: FactId,
) -> AttemptIdentityV2 {
    AttemptIdentityV2 {
        causation_fact_id,
        ..identity.clone()
    }
}

pub(super) fn caused_direct_attempt(
    identity: &ToolAttemptIdentityV2,
    causation_fact_id: FactId,
) -> ToolAttemptIdentityV2 {
    ToolAttemptIdentityV2 {
        causation_fact_id,
        ..identity.clone()
    }
}

impl From<KernelErrorV2> for PrepareFailure {
    fn from(value: KernelErrorV2) -> Self {
        Self::Kernel(value)
    }
}

pub(super) fn storage_fault() -> KernelErrorV2 {
    KernelErrorV2::FactStoreUnavailable {
        fault_code: StorageFaultCodeV2::Unavailable,
    }
}

pub(super) fn corrupt_store() -> KernelErrorV2 {
    KernelErrorV2::FactStoreUnavailable {
        fault_code: StorageFaultCodeV2::Corrupt,
    }
}

pub(super) fn invalid_field(
    field_path: impl Into<String>,
    violation: InvalidFieldViolationV2,
) -> KernelErrorV2 {
    KernelErrorV2::InvalidRequest {
        reason: InvalidRequestReasonV2::InvalidField {
            field_path: field_path.into(),
            violation,
        },
    }
}

pub(super) fn fact_draft(fact_id: FactId, payload: KernelFactPayloadV2) -> KernelFactDraftV2 {
    KernelFactDraftV2 { fact_id, payload }
}

pub(super) enum EpochAdvancePlan {
    Ready {
        epoch_context: CommandEpochContextV2,
        previous_epoch: Option<ControlEpoch>,
        new_epoch: ControlEpoch,
    },
    Recorded {
        current_epoch: ControlEpoch,
        error: RecordedCommandErrorV2,
    },
}

pub(super) type PendingCancellation = (InvocationId, CancelRequestId, FactId);

pub(super) fn plan_control_cancellation(
    state: &AuthorityState,
    active_invocation_id: Option<InvocationId>,
    mint_ids: impl FnOnce() -> (CancelRequestId, FactId),
) -> AuthorityResult<(ControlCancellationReplyV2, Option<PendingCancellation>)> {
    let Some(invocation_id) = active_invocation_id else {
        return Ok((ControlCancellationReplyV2::None {}, None));
    };
    let stop_overlay = state
        .invocations
        .get(&invocation_id)
        .map(|invocation| &invocation.stop_overlay)
        .or_else(|| {
            state
                .direct_invocations
                .get(&invocation_id)
                .map(|invocation| &invocation.stop_overlay)
        })
        .ok_or_else(corrupt_store)?;
    if let Some((cancel_request_id, fact_id, _)) = stop_overlay.cancellation() {
        return Ok((
            ControlCancellationReplyV2::AlreadyRequested {
                cancel_request_id: cancel_request_id.clone(),
                invocation_id,
                cancellation_fact_id: fact_id.clone(),
            },
            None,
        ));
    }
    let (cancel_request_id, fact_id) = mint_ids();
    Ok((
        ControlCancellationReplyV2::Requested {
            cancel_request_id: cancel_request_id.clone(),
            invocation_id: invocation_id.clone(),
            cancellation_fact_id: fact_id.clone(),
        },
        Some((invocation_id, cancel_request_id, fact_id)),
    ))
}

pub(super) fn plan_epoch_advance(
    run_id: &RunId,
    run: Option<&RunRecord>,
    precondition: EpochPreconditionV2,
) -> AuthorityResult<EpochAdvancePlan> {
    let Some(run) = run else {
        return match precondition {
            EpochPreconditionV2::NoCurrentEpoch {} => Ok(EpochAdvancePlan::Ready {
                epoch_context: CommandEpochContextV2::NoCurrentEpoch {},
                previous_epoch: None,
                new_epoch: ControlEpoch::new(1).expect("one is a valid epoch"),
            }),
            EpochPreconditionV2::Exact { .. } => Err(KernelErrorV2::RunNotFound {
                run_id: run_id.clone(),
            }),
        };
    };
    let error = match precondition {
        EpochPreconditionV2::NoCurrentEpoch {} => {
            Some(RecordedCommandErrorV2::ControlEpochAlreadyExists {
                run_id: run_id.clone(),
                current: run.epoch,
            })
        }
        EpochPreconditionV2::Exact { control_epoch } if control_epoch != run.epoch => {
            Some(RecordedCommandErrorV2::StaleControlEpoch {
                run_id: run_id.clone(),
                submitted: control_epoch,
                current: run.epoch,
            })
        }
        EpochPreconditionV2::Exact { .. }
            if matches!(run.lifecycle, RunLifecycle::Terminated { .. }) =>
        {
            Some(RecordedCommandErrorV2::RunTerminated {
                run_id: run_id.clone(),
                control_epoch: run.epoch,
            })
        }
        EpochPreconditionV2::Exact { .. } => None,
    };
    if let Some(error) = error {
        return Ok(EpochAdvancePlan::Recorded {
            current_epoch: run.epoch,
            error,
        });
    }
    let Some(next) = run.epoch.get().checked_add(1) else {
        return Ok(EpochAdvancePlan::Recorded {
            current_epoch: run.epoch,
            error: RecordedCommandErrorV2::ControlEpochExhausted {
                run_id: run_id.clone(),
                current: run.epoch,
            },
        });
    };
    Ok(EpochAdvancePlan::Ready {
        epoch_context: exact_epoch(run.epoch),
        previous_epoch: Some(run.epoch),
        new_epoch: ControlEpoch::new(next).expect("checked non-zero epoch"),
    })
}

pub(super) fn resolve_workspace_binding(path: &Path) -> AuthorityResult<WorkspaceBinding> {
    let canonical_root = fs::canonicalize(path).map_err(|_| storage_fault())?;
    if !canonical_root.is_dir() {
        return Err(invalid_field(
            "workspaceRoot",
            InvalidFieldViolationV2::OutOfRange,
        ));
    }
    let platform = CURRENT_PLATFORM;
    let raw = canonical_root.to_str().ok_or_else(|| {
        invalid_field("workspaceRoot", InvalidFieldViolationV2::MalformedIdentity)
    })?;
    let canonical_root_utf8 = normalize_canonical_platform_path_v4(platform, raw)
        .map_err(|_| invalid_field("workspaceRoot", InvalidFieldViolationV2::MalformedIdentity))?;
    let digest =
        workspace_binding_digest_v2(platform, &canonical_root_utf8).map_err(|_| storage_fault())?;
    Ok(WorkspaceBinding {
        platform,
        canonical_root,
        canonical_root_utf8,
        digest,
    })
}

fn request_tool_id(request: &GrantRequestV2) -> AuthorityResult<AuthorityToolIdV4> {
    validate_canonical_invocation_v4(&request.canonical_invocation).map_err(|_| {
        invalid_field(
            "request.canonicalInvocation",
            InvalidFieldViolationV2::OutOfRange,
        )
    })?;
    Ok(request.canonical_invocation.tool_id())
}

fn request_identity_fields(
    request: &GrantRequestV2,
) -> AuthorityResult<(CorrelationSetV2, IdempotencyKeyHashV2)> {
    let correlations = CorrelationSetV2::materialize(request.correlation_refs.clone())
        .map_err(|_| invalid_field("request.correlationRefs", InvalidFieldViolationV2::Unsorted))?;
    let idempotency_key_hash = idempotency_key_hash_v2(&request.run_id, &request.idempotency_key)
        .map_err(|_| {
        invalid_field(
            "request.idempotencyKey",
            InvalidFieldViolationV2::OutOfRange,
        )
    })?;
    Ok((correlations, idempotency_key_hash))
}

pub(super) fn prepare_grant_request(
    request: &GrantRequestV2,
    catalog: &LocalAuthorityToolCatalogV4,
    workspace: &WorkspaceBinding,
    executor_config: &KernelExecutorConfig,
) -> Result<PreparedGrantRequest, PrepareFailure> {
    let tool_id = request_tool_id(request)?;
    let contract = catalog.contract(tool_id);
    if contract.execution_availability != ExecutionAvailabilityV4::Ready
        || catalog.ready_binding(tool_id).is_none()
    {
        return Err(PrepareFailure::Kernel(
            KernelErrorV2::ToolExecutionUnavailable {
                tool_id,
                availability: ExecutionAvailabilityV4::Blocked,
            },
        ));
    }
    let effective_deadline_ms = materialize_deadline(request.deadline, &contract.deadline)?;
    let (correlations, idempotency_key_hash) = request_identity_fields(request)?;
    let (resource_scope, resolved_targets) =
        resolve_invocation_targets(&request.canonical_invocation, workspace, executor_config)?;
    let grant_scope_digest = grant_scope_digest_v2(
        &request.run_id,
        request.control_epoch,
        tool_id,
        &contract.contract_digest,
        &request.canonical_invocation,
        &resource_scope,
        contract.effect_scope,
        contract.risk,
        &workspace.digest,
    )
    .map_err(|_| storage_fault())?;
    let authorization_digest = authorization_request_digest_v2(
        &request.run_id,
        &request.operation_id,
        request.control_epoch,
        &idempotency_key_hash,
        &contract.contract_digest,
        &request.canonical_invocation,
        &grant_scope_digest,
        effective_deadline_ms,
        &workspace.digest,
    )
    .map_err(|_| storage_fault())?;
    Ok(PreparedGrantRequest {
        canonical_invocation: request.canonical_invocation.clone(),
        resource_scope,
        resolved_targets,
        idempotency_key_hash,
        grant_scope_digest,
        authorization_digest,
        workspace_binding_digest: workspace.digest.clone(),
        effective_deadline_ms,
        correlations,
    })
}

pub(super) fn prepare_direct_tool_intent(
    run_id: &RunId,
    operation_id: &OperationId,
    control_epoch: ControlEpoch,
    idempotency_key: &str,
    canonical_invocation: &ToolInvocationInputV4,
    deadline: DeadlineRequestV2,
    correlation_refs: Vec<CorrelationRefV2>,
    catalog: &LocalAuthorityToolCatalogV4,
    workspace: &WorkspaceBinding,
    executor_config: &KernelExecutorConfig,
) -> Result<PreparedDirectToolIntent, PrepareFailure> {
    validate_canonical_invocation_v4(canonical_invocation).map_err(|_| {
        invalid_field(
            "canonicalInvocation",
            InvalidFieldViolationV2::OutOfRange,
        )
    })?;
    let tool_id = canonical_invocation.tool_id();
    let contract = catalog.contract(tool_id);
    if contract.execution_availability != ExecutionAvailabilityV4::Ready
        || catalog.ready_binding(tool_id).is_none()
    {
        return Err(PrepareFailure::Kernel(
            KernelErrorV2::ToolExecutionUnavailable {
                tool_id,
                availability: ExecutionAvailabilityV4::Blocked,
            },
        ));
    }
    let effective_deadline_ms = materialize_deadline(deadline, &contract.deadline)?;
    let correlations = CorrelationSetV2::materialize(correlation_refs)
        .map_err(|_| invalid_field("correlationRefs", InvalidFieldViolationV2::Unsorted))?;
    let idempotency_key_hash =
        idempotency_key_hash_v2(run_id, idempotency_key).map_err(|_| {
            invalid_field(
                "idempotencyKey",
                InvalidFieldViolationV2::OutOfRange,
            )
        })?;
    let (resource_scope, resolved_targets) =
        resolve_invocation_targets(canonical_invocation, workspace, executor_config)?;
    let _ = (operation_id, control_epoch);
    Ok(PreparedDirectToolIntent {
        canonical_invocation: canonical_invocation.clone(),
        resource_scope,
        resolved_targets,
        idempotency_key_hash,
        workspace_binding_digest: workspace.digest.clone(),
        effective_deadline_ms,
        correlations,
    })
}

pub(super) fn prepare_submission_digest(
    request: &GrantRequestV2,
    grant_id: &GrantId,
    catalog: &LocalAuthorityToolCatalogV4,
    workspace: &WorkspaceBinding,
) -> AuthorityResult<(AuthorityToolIdV4, InvocationSubmissionDigestV2)> {
    let tool_id = request_tool_id(request)?;
    let contract = catalog.contract(tool_id);
    let effective_deadline_ms = materialize_deadline(request.deadline, &contract.deadline)
        .map_err(|failure| match failure {
            PrepareFailure::Kernel(error) => error,
            PrepareFailure::Target(_) => corrupt_store(),
        })?;
    let (_, idempotency_key_hash) = request_identity_fields(request)?;
    let digest = invocation_submission_digest_v2(
        &request.run_id,
        &request.operation_id,
        request.control_epoch,
        &idempotency_key_hash,
        grant_id,
        &contract.contract_digest,
        &request.canonical_invocation,
        effective_deadline_ms,
        &workspace.digest,
    )
    .map_err(|_| corrupt_store())?;
    Ok((tool_id, digest))
}

pub(super) struct PreparedRevalidation {
    pub(super) resource_id: ResourceId,
    pub(super) target: ResolvedTarget,
    pub(super) observation: TargetRevalidationObservationV2,
    pub(super) digest: TargetRevalidationDigestV2,
}

pub(super) struct EffectPreparation {
    pub(super) executor_input: serde_json::Value,
    pub(super) revalidations: Vec<PreparedRevalidation>,
}

pub(super) fn prepare_effect(
    invocation: &ToolInvocationInputV4,
    admitted_targets: &[(ResourceId, ResolvedTarget)],
    identity: &AttemptIdentityV2,
    workspace: &WorkspaceBinding,
    executor_config: &KernelExecutorConfig,
) -> Result<EffectPreparation, PreEffectFailureCodeV2> {
    prepare_effect_inner(
        invocation,
        admitted_targets,
        &identity.run_id,
        &identity.operation_id,
        &identity.invocation_id,
        &identity.attempt_id,
        workspace,
        executor_config,
    )
}

pub(super) fn prepare_direct_effect(
    invocation: &ToolInvocationInputV4,
    admitted_targets: &[(ResourceId, ResolvedTarget)],
    identity: &ToolAttemptIdentityV2,
    workspace: &WorkspaceBinding,
    executor_config: &KernelExecutorConfig,
) -> Result<EffectPreparation, PreEffectFailureCodeV2> {
    prepare_effect_inner(
        invocation,
        admitted_targets,
        &identity.run_id,
        &identity.operation_id,
        &identity.invocation_id,
        &identity.attempt_id,
        workspace,
        executor_config,
    )
}

fn prepare_effect_inner(
    invocation: &ToolInvocationInputV4,
    admitted_targets: &[(ResourceId, ResolvedTarget)],
    run_id: &RunId,
    operation_id: &OperationId,
    invocation_id: &InvocationId,
    attempt_id: &deepcode_kernel_abi::v2::AttemptId,
    workspace: &WorkspaceBinding,
    executor_config: &KernelExecutorConfig,
) -> Result<EffectPreparation, PreEffectFailureCodeV2> {
    let (_, fresh_targets) = resolve_invocation_targets(invocation, workspace, executor_config)
        .map_err(|_| PreEffectFailureCodeV2::TargetRevalidationFailed)?;
    if fresh_targets.len() != admitted_targets.len()
        || fresh_targets
            .iter()
            .zip(admitted_targets)
            .any(|(fresh, (_, admitted))| {
                fresh.private_target != admitted.private_target
                    || fresh.public_resource != admitted.public_resource
            })
    {
        return Err(PreEffectFailureCodeV2::TargetRevalidationFailed);
    }
    let (executor_input, expected_edit) = executor_input(invocation, &fresh_targets)
        .map_err(|_| PreEffectFailureCodeV2::TargetRevalidationFailed)?;
    let mut revalidations = admitted_targets
        .iter()
        .zip(fresh_targets)
        .map(|((resource_id, _), target)| {
            let observation =
                revalidation_observation(invocation, &target, expected_edit.as_deref())?;
            let digest = target_revalidation_digest_v2(
                run_id,
                operation_id,
                invocation_id,
                attempt_id,
                invocation.tool_id(),
                resource_id,
                &workspace.digest,
                &target.private_target,
                &observation,
            )
            .map_err(|_| PreEffectFailureCodeV2::TargetRevalidationFailed)?;
            Ok(PreparedRevalidation {
                resource_id: resource_id.clone(),
                target,
                observation,
                digest,
            })
        })
        .collect::<Result<Vec<_>, PreEffectFailureCodeV2>>()?;
    revalidations.sort_by(|left, right| {
        left.resource_id
            .as_str()
            .as_bytes()
            .cmp(right.resource_id.as_str().as_bytes())
    });
    Ok(EffectPreparation {
        executor_input,
        revalidations,
    })
}

fn executor_input(
    invocation: &ToolInvocationInputV4,
    targets: &[ResolvedTarget],
) -> Result<(serde_json::Value, Option<Vec<u8>>), ()> {
    use ToolInvocationInputV4 as Input;
    let value = match invocation {
        Input::FsRead { path, range } => {
            let mut value = serde_json::json!({"path":path});
            if let LineRangeV4::Lines {
                start_line,
                end_line,
            } = range
            {
                value["startLine"] = (*start_line).into();
                value["endLine"] = (*end_line).into();
            }
            value
        }
        Input::FsList {
            path,
            depth,
            include_hidden,
        } => serde_json::json!({
            "path":path,"depth":depth,"includeHidden":include_hidden
        }),
        Input::FsGlob {
            root,
            pattern,
            max_results,
        } => serde_json::json!({
            "path":root,"pattern":pattern,"maxResults":max_results
        }),
        Input::FsDiff {
            path,
            proposed_content,
        } => serde_json::json!({"path":path,"proposedContent":proposed_content}),
        Input::CodeGrep {
            root,
            query,
            include,
            exclude,
            strategy,
            context_lines,
            max_results,
        } => serde_json::json!({
            "path":root,
            "query":query,
            "include":include,
            "exclude":exclude,
            "strategy":match strategy {
                SearchStrategyV4::Literal => "literal",
                SearchStrategyV4::Regex => "regex",
            },
            "contextLines":context_lines,
            "maxResults":max_results
        }),
        Input::FsCreate {
            path,
            content,
            executable,
        } => serde_json::json!({"path":path,"content":content,"executable":executable}),
        Input::FsWrite { path, content } => serde_json::json!({"path":path,"content":content}),
        Input::FsEdit {
            path,
            matcher,
            replacement,
        } => {
            let target = target_path(targets.first().ok_or(())?)?;
            let original = fs::read_to_string(target).map_err(|_| ())?;
            let (patch_spec, updated) =
                plan_v2_text_edit(&original, matcher, replacement).map_err(|_| ())?;
            return Ok((
                serde_json::json!({
                    "path":path,"replacement":replacement,"patchSpec":patch_spec
                }),
                Some(updated.into_bytes()),
            ));
        }
        Input::FsDelete(DeleteTargetV4::File { path }) => {
            serde_json::json!({"path":path,"targetKind":"file","recursive":false})
        }
        Input::FsDelete(DeleteTargetV4::DirectoryTree { path }) => {
            serde_json::json!({"path":path,"targetKind":"directory","recursive":true})
        }
        Input::FsEnsureDirectory { path } => serde_json::json!({"path":path}),
        Input::DocumentRead { path, pages } => {
            let mut value = serde_json::json!({"path":path});
            if let DocumentPagesV4::Range {
                start_page,
                end_page,
            } = pages
            {
                value["startPage"] = (*start_page).into();
                value["endPage"] = (*end_page).into();
            }
            value
        }
        Input::WebSearch { query, limit } => serde_json::json!({
            "query":query,
            "limit":limit,
            "kernelReviewedTarget":reviewed_target_value(
                &targets.first().ok_or(())?.private_target
            )?
        }),
        Input::WebFetch { url, max_bytes } => serde_json::json!({
            "url":url,
            "maxBytes":max_bytes,
            "kernelReviewedTarget":reviewed_target_value(
                &targets.first().ok_or(())?.private_target
            )?
        }),
        Input::FsRename { .. }
        | Input::GitStatus {}
        | Input::GitDiff { .. }
        | Input::GitStage { .. }
        | Input::GitUnstage { .. }
        | Input::GitCommit { .. } => return Err(()),
    };
    Ok((value, None))
}

fn revalidation_observation(
    invocation: &ToolInvocationInputV4,
    target: &ResolvedTarget,
    expected_edit: Option<&[u8]>,
) -> Result<TargetRevalidationObservationV2, PreEffectFailureCodeV2> {
    use ToolInvocationInputV4 as Input;
    match invocation {
        Input::FsRead { .. } | Input::FsDiff { .. } | Input::DocumentRead { .. } => {
            Ok(TargetRevalidationObservationV2::FileRead {
                observed: present_file(target.state.as_ref())?,
            })
        }
        Input::FsList { .. } | Input::FsGlob { .. } | Input::CodeGrep { .. } => {
            let ResourceStateV2::Directory {
                collection_digest,
                item_count,
            } = target
                .state
                .as_ref()
                .ok_or(PreEffectFailureCodeV2::TargetRevalidationFailed)?
            else {
                return Err(PreEffectFailureCodeV2::TargetRevalidationFailed);
            };
            Ok(TargetRevalidationObservationV2::CollectionRead {
                listing_digest: collection_digest.clone(),
                item_count: *item_count,
            })
        }
        Input::FsCreate {
            content,
            executable,
            ..
        } => file_mutation_observation(target, content.as_bytes(), *executable),
        Input::FsWrite { content, .. } => file_mutation_observation(
            target,
            content.as_bytes(),
            state_executable(target.state.as_ref())?,
        ),
        Input::FsEdit { .. } => file_mutation_observation(
            target,
            expected_edit.ok_or(PreEffectFailureCodeV2::TargetRevalidationFailed)?,
            state_executable(target.state.as_ref())?,
        ),
        Input::FsDelete(_) => {
            let state = target
                .state
                .as_ref()
                .ok_or(PreEffectFailureCodeV2::TargetRevalidationFailed)?;
            let digest = target
                .state_digest
                .clone()
                .ok_or(PreEffectFailureCodeV2::TargetRevalidationFailed)?;
            let before = match state {
                ResourceStateV2::File { .. } => DeletionBeforeObservationV2::PresentFile {
                    state_digest: digest,
                },
                ResourceStateV2::Directory { .. } => {
                    DeletionBeforeObservationV2::PresentDirectory {
                        state_digest: digest,
                    }
                }
                ResourceStateV2::Absent {} => {
                    return Err(PreEffectFailureCodeV2::TargetRevalidationFailed)
                }
            };
            Ok(TargetRevalidationObservationV2::DeletionPrepared {
                before,
                expected_after: ResourceStateV2::Absent {},
            })
        }
        Input::FsEnsureDirectory { .. } => {
            let before = match target.state.as_ref() {
                Some(ResourceStateV2::Absent {}) => DirectoryBeforeObservationV2::Absent {},
                Some(ResourceStateV2::Directory { .. }) => {
                    DirectoryBeforeObservationV2::PresentDirectory {
                        state_digest: target
                            .state_digest
                            .clone()
                            .ok_or(PreEffectFailureCodeV2::TargetRevalidationFailed)?,
                    }
                }
                _ => return Err(PreEffectFailureCodeV2::TargetRevalidationFailed),
            };
            Ok(TargetRevalidationObservationV2::DirectoryPrepared {
                before,
                expected_after: WorkspaceObjectKindV2::Directory,
            })
        }
        Input::WebSearch { .. } => match &target.public_resource {
            ResolvedResourceV2::NetworkQuery {
                query_digest,
                target_observation_digest,
                ..
            } => Ok(TargetRevalidationObservationV2::WebQuery {
                query_digest: query_digest.clone(),
                reviewed_target_digest: target_observation_digest.clone(),
            }),
            _ => Err(PreEffectFailureCodeV2::TargetRevalidationFailed),
        },
        Input::WebFetch { .. } => match &target.public_resource {
            ResolvedResourceV2::NetworkEndpoint {
                target_observation_digest,
                ..
            } => Ok(TargetRevalidationObservationV2::WebTarget {
                reviewed_target_digest: target_observation_digest.clone(),
            }),
            _ => Err(PreEffectFailureCodeV2::TargetRevalidationFailed),
        },
        _ => Err(PreEffectFailureCodeV2::ExecutorUnavailable),
    }
}

fn file_mutation_observation(
    target: &ResolvedTarget,
    expected: &[u8],
    executable: bool,
) -> Result<TargetRevalidationObservationV2, PreEffectFailureCodeV2> {
    let before = match target.state.as_ref() {
        Some(ResourceStateV2::Absent {}) => FileBeforeObservationV2::Absent {},
        Some(ResourceStateV2::File {
            content_digest,
            byte_length,
            executable,
        }) => FileBeforeObservationV2::PresentFile {
            content_digest: content_digest.clone(),
            byte_length: *byte_length,
            executable: *executable,
        },
        _ => return Err(PreEffectFailureCodeV2::TargetRevalidationFailed),
    };
    Ok(TargetRevalidationObservationV2::FileMutationPrepared {
        before,
        expected_after: PresentFileObservationV2::PresentFile {
            content_digest: content_digest_v2(expected),
            byte_length: expected.len() as u64,
            executable,
        },
    })
}

fn present_file(
    state: Option<&ResourceStateV2>,
) -> Result<PresentFileObservationV2, PreEffectFailureCodeV2> {
    match state {
        Some(ResourceStateV2::File {
            content_digest,
            byte_length,
            executable,
        }) => Ok(PresentFileObservationV2::PresentFile {
            content_digest: content_digest.clone(),
            byte_length: *byte_length,
            executable: *executable,
        }),
        _ => Err(PreEffectFailureCodeV2::TargetRevalidationFailed),
    }
}

fn state_executable(state: Option<&ResourceStateV2>) -> Result<bool, PreEffectFailureCodeV2> {
    match state {
        Some(ResourceStateV2::File { executable, .. }) => Ok(*executable),
        _ => Err(PreEffectFailureCodeV2::TargetRevalidationFailed),
    }
}

fn target_path(target: &ResolvedTarget) -> Result<PathBuf, ()> {
    match &target.private_target {
        CanonicalPrivateTargetV2::Workspace {
            canonical_absolute_path_utf8,
            ..
        } => Ok(PathBuf::from(canonical_absolute_path_utf8)),
        CanonicalPrivateTargetV2::Network { .. } => Err(()),
    }
}

fn reviewed_target_value(target: &CanonicalPrivateTargetV2) -> Result<serde_json::Value, ()> {
    let CanonicalPrivateTargetV2::Network {
        request_target,
        reviewed_addresses,
    } = target
    else {
        return Err(());
    };
    let host = match &request_target.host {
        NetworkHostV2::DnsName { labels } => labels.join("."),
        NetworkHostV2::Ipv4 { octets } => Ipv4Addr::from(*octets).to_string(),
        NetworkHostV2::Ipv6 { octets } => Ipv6Addr::from(*octets).to_string(),
    };
    let addresses = reviewed_addresses
        .iter()
        .map(|address| match address {
            NetworkAddressV2::Ipv4 { octets } => {
                SocketAddr::new(IpAddr::V4(Ipv4Addr::from(*octets)), request_target.port)
            }
            NetworkAddressV2::Ipv6 { octets } => {
                SocketAddr::new(IpAddr::V6(Ipv6Addr::from(*octets)), request_target.port)
            }
        })
        .collect::<Vec<_>>();
    let selected_address = addresses.first().ok_or(())?;
    Ok(serde_json::json!({
        "host":host,
        "port":request_target.port,
        "selectedAddress":selected_address,
        "resolvedAddresses":addresses,
        "private":false
    }))
}

pub(super) fn resolve_execution(
    invocation: &ToolInvocationInputV4,
    preparation: &EffectPreparation,
    raw: Result<RawExecution, ()>,
    workspace: &WorkspaceBinding,
    maximum_output_bytes: u32,
) -> ExecutionResolution {
    use ToolInvocationInputV4 as Input;
    if matches!(
        invocation,
        Input::FsCreate { .. }
            | Input::FsWrite { .. }
            | Input::FsEdit { .. }
            | Input::FsDelete(_)
            | Input::FsEnsureDirectory { .. }
    ) {
        return resolve_mutation(invocation, preparation, raw.is_ok(), maximum_output_bytes);
    }
    let Ok(raw) = raw else {
        return indeterminate(LastObservationV2::None {});
    };
    let Some(revalidation) = preparation.revalidations.first() else {
        return indeterminate(LastObservationV2::None {});
    };
    let built = match invocation {
        Input::FsRead { .. } => utf8_output(
            invocation.tool_id(),
            TextMediaTypeV4::TextPlainUtf8,
            raw.output
                .get("content")
                .and_then(serde_json::Value::as_str),
            maximum_output_bytes,
        ),
        Input::FsDiff { .. } => utf8_output(
            invocation.tool_id(),
            TextMediaTypeV4::TextDiffUtf8,
            raw.output.get("diff").and_then(serde_json::Value::as_str),
            maximum_output_bytes,
        ),
        Input::DocumentRead { .. } => utf8_output(
            invocation.tool_id(),
            TextMediaTypeV4::TextDocumentUtf8,
            raw.complete_document_text.as_deref(),
            maximum_output_bytes,
        ),
        Input::FsList { .. } => path_entries_from_nodes(
            invocation.tool_id(),
            raw.output.get("nodes"),
            maximum_output_bytes,
        ),
        Input::FsGlob { .. } => path_entries_from_glob(
            invocation.tool_id(),
            raw.output.get("matches"),
            &workspace.canonical_root,
            maximum_output_bytes,
        ),
        Input::CodeGrep {
            query, strategy, ..
        } => search_matches_output(
            invocation.tool_id(),
            raw.output.get("matches"),
            query,
            *strategy,
            maximum_output_bytes,
        ),
        Input::WebSearch { .. } => web_search_output(
            invocation.tool_id(),
            raw.output.get("results"),
            maximum_output_bytes,
        ),
        Input::WebFetch { .. } => web_response_output(
            invocation.tool_id(),
            &raw,
            revalidation,
            maximum_output_bytes,
        ),
        _ => None,
    };
    let Some(output) = built else {
        return indeterminate(LastObservationV2::None {});
    };
    let evidence = match invocation {
        Input::FsRead { .. } | Input::FsDiff { .. } | Input::DocumentRead { .. } => {
            let complete_text = match invocation {
                Input::DocumentRead { .. } => raw.complete_document_text.as_deref(),
                Input::FsRead { .. } => raw
                    .output
                    .get("content")
                    .and_then(serde_json::Value::as_str),
                Input::FsDiff { .. } => raw.output.get("diff").and_then(serde_json::Value::as_str),
                _ => None,
            };
            let Some(complete_text) = complete_text else {
                return indeterminate(LastObservationV2::None {});
            };
            EffectEvidenceV2::ContentRead {
                content_digest: content_digest_v2(complete_text.as_bytes()),
                byte_length: complete_text.len() as u64,
            }
        }
        Input::FsList { .. } | Input::FsGlob { .. } => {
            let ToolOutputPayloadV4::PathEntries { entries } =
                complete_payload_for_output(invocation, &raw, workspace)
                    .unwrap_or_else(|| output.payload.clone())
            else {
                return indeterminate(LastObservationV2::None {});
            };
            EffectEvidenceV2::CollectionRead {
                result_digest: match collection_digest_v2(&entries) {
                    Ok(value) => value,
                    Err(_) => return indeterminate(LastObservationV2::None {}),
                },
                item_count: entries.len() as u64,
            }
        }
        Input::CodeGrep { .. } => EffectEvidenceV2::SearchMatchesReadBack {
            output_digest: output.full_digest.clone(),
            match_count: raw
                .output
                .get("matches")
                .and_then(serde_json::Value::as_array)
                .map(|items| items.len() as u64)
                .unwrap_or(0),
        },
        Input::WebSearch { .. } => {
            let TargetRevalidationObservationV2::WebQuery {
                query_digest,
                reviewed_target_digest,
            } = &revalidation.observation
            else {
                return indeterminate(LastObservationV2::None {});
            };
            EffectEvidenceV2::WebSearchReadBack {
                query_digest: query_digest.clone(),
                reviewed_target_digest: reviewed_target_digest.clone(),
                output_digest: output.full_digest.clone(),
                result_count: raw
                    .output
                    .get("results")
                    .and_then(serde_json::Value::as_array)
                    .map(|items| items.len() as u64)
                    .unwrap_or(0),
            }
        }
        Input::WebFetch { .. } => {
            let TargetRevalidationObservationV2::WebTarget {
                reviewed_target_digest,
            } = &revalidation.observation
            else {
                return indeterminate(LastObservationV2::None {});
            };
            let body = raw
                .output
                .get("content")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let status_code = raw.http_status_code.unwrap_or_default();
            let content_type = raw.http_content_type.as_deref().unwrap_or_default();
            let response_digest = match network_response_digest_v2(&serde_json::json!({
                "reviewedTargetDigest":reviewed_target_digest,
                "statusCode":status_code,
                "contentType":content_type,
                "bodyContentDigest":content_digest_v2(body.as_bytes())
            })) {
                Ok(value) => value,
                Err(_) => return indeterminate(LastObservationV2::None {}),
            };
            EffectEvidenceV2::WebReadBack {
                reviewed_target_digest: reviewed_target_digest.clone(),
                response_digest,
                status_code,
            }
        }
        _ => return indeterminate(LastObservationV2::None {}),
    };
    ExecutionResolution::Completed(VerifiedExecution { output, evidence })
}

pub(super) fn pre_effect_stop_drafts(
    identity: &AttemptIdentityV2,
    observed_fact_id: FactId,
    terminal_fact_id: FactId,
    release_fact_id: FactId,
    cancellation: Option<(&CancelRequestId, &FactId)>,
) -> Vec<KernelFactDraftV2> {
    let (observed, terminal, release_reason) = match cancellation {
        Some((cancel_request_id, cancellation_fact_id)) => (
            InvocationFactV2::CancellationObserved {
                identity: caused_attempt(identity, cancellation_fact_id.clone()),
                cancel_request_id: cancel_request_id.clone(),
            },
            InvocationFactV2::CancelledBeforeEffect {
                identity: caused_attempt(identity, observed_fact_id.clone()),
                cancel_request_id: cancel_request_id.clone(),
            },
            ReservationReleaseReasonV2::CancelledBeforeEffect,
        ),
        None => (
            InvocationFactV2::DeadlineObserved {
                identity: caused_attempt(identity, identity.causation_fact_id.clone()),
            },
            InvocationFactV2::TimedOutBeforeEffect {
                identity: caused_attempt(identity, observed_fact_id.clone()),
            },
            ReservationReleaseReasonV2::TimedOutBeforeEffect,
        ),
    };
    vec![
        fact_draft(observed_fact_id, KernelFactPayloadV2::Invocation(observed)),
        fact_draft(
            terminal_fact_id.clone(),
            KernelFactPayloadV2::Invocation(terminal),
        ),
        fact_draft(
            release_fact_id,
            KernelFactPayloadV2::Grant(GrantFactV2::ReservationReleased {
                identity: reservation_identity(identity, terminal_fact_id),
                reason_code: release_reason,
            }),
        ),
    ]
}

pub(super) fn failed_before_effect_drafts(
    identity: &AttemptIdentityV2,
    attempt_prepared_fact_id: &FactId,
    terminal_fact_id: FactId,
    release_fact_id: FactId,
    error_code: PreEffectFailureCodeV2,
) -> Vec<KernelFactDraftV2> {
    vec![
        fact_draft(
            terminal_fact_id.clone(),
            KernelFactPayloadV2::Invocation(InvocationFactV2::FailedBeforeEffect {
                identity: caused_attempt(identity, attempt_prepared_fact_id.clone()),
                error_code,
            }),
        ),
        fact_draft(
            release_fact_id,
            KernelFactPayloadV2::Grant(GrantFactV2::ReservationReleased {
                identity: reservation_identity(identity, terminal_fact_id),
                reason_code: ReservationReleaseReasonV2::FailedBeforeEffect,
            }),
        ),
    ]
}

pub(super) fn execution_result_drafts(
    identity: &AttemptIdentityV2,
    execution_started_fact_id: &FactId,
    effect_id: EffectId,
    effect_fact_id: FactId,
    terminal_fact_id: FactId,
    mut resource_ids: Vec<ResourceId>,
    resolution: ExecutionResolution,
    cancel_request_id: Option<&CancelRequestId>,
    deadline_observed: bool,
) -> AuthorityResult<Vec<KernelFactDraftV2>> {
    resource_ids.sort_by(|left, right| left.as_str().as_bytes().cmp(right.as_str().as_bytes()));
    resource_ids.dedup();
    let effect_identity = EffectIdentityV2 {
        run_id: identity.run_id.clone(),
        control_epoch: identity.control_epoch,
        operation_id: identity.operation_id.clone(),
        grant_id: identity.grant_id.clone(),
        reservation_id: identity.reservation_id.clone(),
        invocation_id: identity.invocation_id.clone(),
        attempt_id: identity.attempt_id.clone(),
        effect_id: effect_id.clone(),
        idempotency_key_hash: identity.idempotency_key_hash.clone(),
        causation_fact_id: execution_started_fact_id.clone(),
    };
    let terminal_identity = ObservedTerminalIdentityV2 {
        run_id: identity.run_id.clone(),
        control_epoch: identity.control_epoch,
        operation_id: identity.operation_id.clone(),
        grant_id: identity.grant_id.clone(),
        reservation_id: identity.reservation_id.clone(),
        invocation_id: identity.invocation_id.clone(),
        attempt_id: identity.attempt_id.clone(),
        effect_id,
        idempotency_key_hash: identity.idempotency_key_hash.clone(),
        causation_fact_id: effect_fact_id.clone(),
        correlation_set: identity.correlation_set.clone(),
    };
    let (effect, terminal) = match resolution {
        ExecutionResolution::Completed(verified) => {
            let evidence_digest =
                executor_evidence_digest_v2(&verified.evidence).map_err(|_| corrupt_store())?;
            (
                observed_effect(
                    effect_identity,
                    resource_ids,
                    verified.evidence,
                    evidence_digest,
                    cancel_request_id,
                    deadline_observed,
                ),
                InvocationFactV2::Completed {
                    identity: terminal_identity,
                    output: verified.output,
                },
            )
        }
        ExecutionResolution::FailedAfterObservedEffect {
            evidence,
            error_code,
        } => {
            let evidence_digest =
                executor_evidence_digest_v2(&evidence).map_err(|_| corrupt_store())?;
            (
                observed_effect(
                    effect_identity,
                    resource_ids,
                    evidence,
                    evidence_digest,
                    cancel_request_id,
                    deadline_observed,
                ),
                InvocationFactV2::FailedAfterObservedEffect {
                    identity: terminal_identity,
                    error_code,
                },
            )
        }
        ExecutionResolution::Indeterminate {
            evidence,
            reason_code,
        } => {
            let evidence_digest =
                executor_evidence_digest_v2(&evidence).map_err(|_| corrupt_store())?;
            (
                EffectFactV2::Indeterminate {
                    identity: effect_identity,
                    possible_affected_resource_ids: resource_ids,
                    reason_code,
                    evidence,
                    evidence_digest,
                },
                InvocationFactV2::Indeterminate {
                    identity: terminal_identity,
                    reason_code,
                },
            )
        }
    };
    Ok(vec![
        fact_draft(effect_fact_id, KernelFactPayloadV2::Effect(effect)),
        fact_draft(terminal_fact_id, KernelFactPayloadV2::Invocation(terminal)),
    ])
}

pub(super) fn direct_pre_effect_stop_drafts(
    identity: &ToolAttemptIdentityV2,
    observed_fact_id: FactId,
    terminal_fact_id: FactId,
    cancellation: Option<(&CancelRequestId, &FactId)>,
) -> Vec<KernelFactDraftV2> {
    let (observed, terminal) = match cancellation {
        Some((cancel_request_id, cancellation_fact_id)) => (
            InvocationFactV2::ToolCancellationObserved {
                identity: caused_direct_attempt(identity, cancellation_fact_id.clone()),
                cancel_request_id: cancel_request_id.clone(),
            },
            InvocationFactV2::ToolCancelledBeforeEffect {
                identity: caused_direct_attempt(identity, observed_fact_id.clone()),
                cancel_request_id: cancel_request_id.clone(),
            },
        ),
        None => (
            InvocationFactV2::ToolDeadlineObserved {
                identity: caused_direct_attempt(identity, identity.causation_fact_id.clone()),
            },
            InvocationFactV2::ToolTimedOutBeforeEffect {
                identity: caused_direct_attempt(identity, observed_fact_id.clone()),
            },
        ),
    };
    vec![
        fact_draft(observed_fact_id, KernelFactPayloadV2::Invocation(observed)),
        fact_draft(terminal_fact_id, KernelFactPayloadV2::Invocation(terminal)),
    ]
}

pub(super) fn direct_failed_before_effect_drafts(
    identity: &ToolAttemptIdentityV2,
    attempt_prepared_fact_id: &FactId,
    terminal_fact_id: FactId,
    error_code: PreEffectFailureCodeV2,
) -> Vec<KernelFactDraftV2> {
    vec![fact_draft(
        terminal_fact_id,
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolFailedBeforeEffect {
            identity: caused_direct_attempt(identity, attempt_prepared_fact_id.clone()),
            error_code,
        }),
    )]
}

#[allow(clippy::too_many_arguments)]
pub(super) fn direct_execution_result_drafts(
    identity: &ToolAttemptIdentityV2,
    execution_started_fact_id: &FactId,
    effect_id: EffectId,
    effect_fact_id: FactId,
    terminal_fact_id: FactId,
    mut resource_ids: Vec<ResourceId>,
    resolution: ExecutionResolution,
    cancel_request_id: Option<&CancelRequestId>,
    deadline_observed: bool,
) -> AuthorityResult<Vec<KernelFactDraftV2>> {
    resource_ids.sort_by(|left, right| left.as_str().as_bytes().cmp(right.as_str().as_bytes()));
    resource_ids.dedup();
    let effect_identity = ToolEffectIdentityV2 {
        run_id: identity.run_id.clone(),
        control_epoch: identity.control_epoch,
        operation_id: identity.operation_id.clone(),
        authority: identity.authority.clone(),
        invocation_id: identity.invocation_id.clone(),
        attempt_id: identity.attempt_id.clone(),
        effect_id: effect_id.clone(),
        idempotency_key_hash: identity.idempotency_key_hash.clone(),
        causation_fact_id: execution_started_fact_id.clone(),
    };
    let terminal_identity = ToolObservedTerminalIdentityV2 {
        run_id: identity.run_id.clone(),
        control_epoch: identity.control_epoch,
        operation_id: identity.operation_id.clone(),
        authority: identity.authority.clone(),
        invocation_id: identity.invocation_id.clone(),
        attempt_id: identity.attempt_id.clone(),
        effect_id,
        idempotency_key_hash: identity.idempotency_key_hash.clone(),
        causation_fact_id: effect_fact_id.clone(),
        correlation_set: identity.correlation_set.clone(),
    };
    let (effect, terminal) = match resolution {
        ExecutionResolution::Completed(verified) => {
            let evidence_digest =
                executor_evidence_digest_v2(&verified.evidence).map_err(|_| corrupt_store())?;
            (
                direct_observed_effect(
                    effect_identity,
                    resource_ids,
                    verified.evidence,
                    evidence_digest,
                    cancel_request_id,
                    deadline_observed,
                ),
                InvocationFactV2::ToolCompleted {
                    identity: terminal_identity,
                    output: verified.output,
                },
            )
        }
        ExecutionResolution::FailedAfterObservedEffect {
            evidence,
            error_code,
        } => {
            let evidence_digest =
                executor_evidence_digest_v2(&evidence).map_err(|_| corrupt_store())?;
            (
                direct_observed_effect(
                    effect_identity,
                    resource_ids,
                    evidence,
                    evidence_digest,
                    cancel_request_id,
                    deadline_observed,
                ),
                InvocationFactV2::ToolFailedAfterObservedEffect {
                    identity: terminal_identity,
                    error_code,
                },
            )
        }
        ExecutionResolution::Indeterminate {
            evidence,
            reason_code,
        } => {
            let evidence_digest =
                executor_evidence_digest_v2(&evidence).map_err(|_| corrupt_store())?;
            (
                EffectFactV2::ToolIndeterminate {
                    identity: effect_identity,
                    possible_affected_resource_ids: resource_ids,
                    reason_code,
                    evidence,
                    evidence_digest,
                },
                InvocationFactV2::ToolIndeterminate {
                    identity: terminal_identity,
                    reason_code,
                },
            )
        }
    };
    Ok(vec![
        fact_draft(effect_fact_id, KernelFactPayloadV2::Effect(effect)),
        fact_draft(terminal_fact_id, KernelFactPayloadV2::Invocation(terminal)),
    ])
}

fn reservation_identity(
    identity: &AttemptIdentityV2,
    causation_fact_id: FactId,
) -> ReservationIdentityV2 {
    ReservationIdentityV2 {
        run_id: identity.run_id.clone(),
        control_epoch: identity.control_epoch,
        operation_id: identity.operation_id.clone(),
        grant_id: identity.grant_id.clone(),
        reservation_id: identity.reservation_id.clone(),
        invocation_id: identity.invocation_id.clone(),
        idempotency_key_hash: identity.idempotency_key_hash.clone(),
        causation_fact_id,
        correlation_set: identity.correlation_set.clone(),
    }
}

fn observed_effect(
    identity: EffectIdentityV2,
    affected_resource_ids: Vec<ResourceId>,
    evidence: EffectEvidenceV2,
    evidence_digest: ExecutorEvidenceDigestV2,
    cancel_request_id: Option<&CancelRequestId>,
    deadline_observed: bool,
) -> EffectFactV2 {
    match (cancel_request_id, deadline_observed) {
        (Some(cancel_request_id), true) => EffectFactV2::ObservedAfterCancelAndDeadline {
            identity,
            cancel_request_id: cancel_request_id.clone(),
            affected_resource_ids,
            evidence,
            evidence_digest,
        },
        (Some(cancel_request_id), false) => EffectFactV2::ObservedAfterCancel {
            identity,
            cancel_request_id: cancel_request_id.clone(),
            affected_resource_ids,
            evidence,
            evidence_digest,
        },
        (None, true) => EffectFactV2::ObservedAfterDeadline {
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
        },
        (None, false) => EffectFactV2::Observed {
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
        },
    }
}

fn direct_observed_effect(
    identity: ToolEffectIdentityV2,
    affected_resource_ids: Vec<ResourceId>,
    evidence: EffectEvidenceV2,
    evidence_digest: ExecutorEvidenceDigestV2,
    cancel_request_id: Option<&CancelRequestId>,
    deadline_observed: bool,
) -> EffectFactV2 {
    match (cancel_request_id, deadline_observed) {
        (Some(cancel_request_id), true) => EffectFactV2::ToolObservedAfterCancelAndDeadline {
            identity,
            cancel_request_id: cancel_request_id.clone(),
            affected_resource_ids,
            evidence,
            evidence_digest,
        },
        (Some(cancel_request_id), false) => EffectFactV2::ToolObservedAfterCancel {
            identity,
            cancel_request_id: cancel_request_id.clone(),
            affected_resource_ids,
            evidence,
            evidence_digest,
        },
        (None, true) => EffectFactV2::ToolObservedAfterDeadline {
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
        },
        (None, false) => EffectFactV2::ToolObserved {
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
        },
    }
}

fn resolve_mutation(
    invocation: &ToolInvocationInputV4,
    preparation: &EffectPreparation,
    executor_ok: bool,
    maximum_output_bytes: u32,
) -> ExecutionResolution {
    let Some(revalidation) = preparation.revalidations.first() else {
        return indeterminate(LastObservationV2::None {});
    };
    let Ok(path) = target_path(&revalidation.target) else {
        return indeterminate(LastObservationV2::None {});
    };
    let Ok(after) = resource_state_for_path(&path) else {
        return indeterminate(LastObservationV2::None {});
    };
    let Ok(after_digest) = resource_state_digest_v2(&after) else {
        return indeterminate(LastObservationV2::None {});
    };
    let before_digest =
        revalidation.target.state_digest.clone().unwrap_or_else(|| {
            resource_state_digest_v2(&ResourceStateV2::Absent {}).expect("absent")
        });
    let (expected, evidence) = match (&revalidation.observation, invocation) {
        (
            TargetRevalidationObservationV2::FileMutationPrepared { expected_after, .. },
            ToolInvocationInputV4::FsCreate { .. }
            | ToolInvocationInputV4::FsWrite { .. }
            | ToolInvocationInputV4::FsEdit { .. },
        ) => {
            let expected_state = match expected_after {
                PresentFileObservationV2::PresentFile {
                    content_digest,
                    byte_length,
                    executable,
                } => ResourceStateV2::File {
                    content_digest: content_digest.clone(),
                    byte_length: *byte_length,
                    executable: *executable,
                },
            };
            (
                after == expected_state,
                EffectEvidenceV2::MutationReadBack {
                    before_digest,
                    after_digest: after_digest.clone(),
                    target_kind: WorkspaceObjectKindV2::File,
                },
            )
        }
        (
            TargetRevalidationObservationV2::DirectoryPrepared { .. },
            ToolInvocationInputV4::FsEnsureDirectory { .. },
        ) => (
            matches!(after, ResourceStateV2::Directory { .. }),
            EffectEvidenceV2::MutationReadBack {
                before_digest,
                after_digest: after_digest.clone(),
                target_kind: WorkspaceObjectKindV2::Directory,
            },
        ),
        (
            TargetRevalidationObservationV2::DeletionPrepared { before, .. },
            ToolInvocationInputV4::FsDelete(_),
        ) => {
            let previous_digest = match before {
                DeletionBeforeObservationV2::PresentFile { state_digest }
                | DeletionBeforeObservationV2::PresentDirectory { state_digest } => {
                    state_digest.clone()
                }
            };
            (
                matches!(after, ResourceStateV2::Absent {}),
                EffectEvidenceV2::DeletionReadBack { previous_digest },
            )
        }
        _ => {
            return indeterminate(LastObservationV2::ResourceState {
                digest: after_digest,
            })
        }
    };
    if executor_ok && expected {
        let output = bounded_output(
            invocation.tool_id(),
            ToolOutputPayloadV4::NoPrimaryContent {},
            maximum_output_bytes,
        )
        .expect("no-primary-content output is bounded");
        ExecutionResolution::Completed(VerifiedExecution { output, evidence })
    } else if expected {
        ExecutionResolution::FailedAfterObservedEffect {
            evidence,
            error_code: PostObservedEffectFailureCodeV2::BackendReportedFailure,
        }
    } else if executor_ok {
        ExecutionResolution::FailedAfterObservedEffect {
            evidence,
            error_code: PostObservedEffectFailureCodeV2::VerificationFailed,
        }
    } else {
        indeterminate(LastObservationV2::ResourceState {
            digest: after_digest,
        })
    }
}

fn indeterminate(last_observation: LastObservationV2) -> ExecutionResolution {
    ExecutionResolution::Indeterminate {
        evidence: EffectEvidenceV2::IndeterminateReadBack { last_observation },
        reason_code: IndeterminateReasonV2::VerificationAmbiguous,
    }
}

fn utf8_output(
    tool_id: AuthorityToolIdV4,
    media_type: TextMediaTypeV4,
    text: Option<&str>,
    budget: u32,
) -> Option<ToolOutputV4> {
    bounded_output(
        tool_id,
        ToolOutputPayloadV4::Utf8Text {
            media_type,
            text: text?.to_owned(),
        },
        budget,
    )
}

fn path_entries_from_nodes(
    tool_id: AuthorityToolIdV4,
    nodes: Option<&serde_json::Value>,
    budget: u32,
) -> Option<ToolOutputV4> {
    fn visit(value: &serde_json::Value, output: &mut Vec<PathEntryV4>) -> Option<()> {
        for node in value.as_array()? {
            let kind = match node.get("type")?.as_str()? {
                "file" => WorkspaceObjectKindV4::File,
                "directory" => WorkspaceObjectKindV4::Directory,
                _ => return None,
            };
            output.push(PathEntryV4 {
                relative_path: node.get("path")?.as_str()?.to_owned(),
                kind,
                size: node
                    .get("sizeBytes")
                    .and_then(serde_json::Value::as_u64)
                    .map(|value| PathEntrySizeV4::Bytes { value })
                    .unwrap_or(PathEntrySizeV4::Unavailable {}),
            });
            if let Some(children) = node.get("children") {
                visit(children, output)?;
            }
        }
        Some(())
    }
    let mut entries = Vec::new();
    visit(nodes?, &mut entries)?;
    entries.sort_by(|left, right| {
        left.relative_path
            .as_bytes()
            .cmp(right.relative_path.as_bytes())
    });
    bounded_output(
        tool_id,
        ToolOutputPayloadV4::PathEntries { entries },
        budget,
    )
}

fn path_entries_from_glob(
    tool_id: AuthorityToolIdV4,
    matches: Option<&serde_json::Value>,
    workspace: &Path,
    budget: u32,
) -> Option<ToolOutputV4> {
    let mut entries = matches?
        .as_array()?
        .iter()
        .map(|value| {
            let relative_path = value.as_str()?.to_owned();
            let metadata = fs::metadata(workspace.join(&relative_path)).ok()?;
            Some(PathEntryV4 {
                relative_path,
                kind: if metadata.is_dir() {
                    WorkspaceObjectKindV4::Directory
                } else if metadata.is_file() {
                    WorkspaceObjectKindV4::File
                } else {
                    return None;
                },
                size: PathEntrySizeV4::Bytes {
                    value: metadata.len(),
                },
            })
        })
        .collect::<Option<Vec<_>>>()?;
    entries.sort_by(|left, right| {
        left.relative_path
            .as_bytes()
            .cmp(right.relative_path.as_bytes())
    });
    bounded_output(
        tool_id,
        ToolOutputPayloadV4::PathEntries { entries },
        budget,
    )
}

fn search_matches_output(
    tool_id: AuthorityToolIdV4,
    raw: Option<&serde_json::Value>,
    query: &str,
    strategy: SearchStrategyV4,
    budget: u32,
) -> Option<ToolOutputV4> {
    let regex = matches!(strategy, SearchStrategyV4::Regex)
        .then(|| regex::Regex::new(query).ok())
        .flatten();
    let matches = raw?
        .as_array()?
        .iter()
        .map(|value| {
            let preview = value.get("preview")?.as_str()?.to_owned();
            let start = match strategy {
                SearchStrategyV4::Literal => preview.find(query),
                SearchStrategyV4::Regex => {
                    regex.as_ref()?.find(&preview).map(|value| value.start())
                }
            }?;
            Some(SearchMatchV4 {
                relative_path: value.get("path")?.as_str()?.to_owned(),
                line: u32::try_from(value.get("line")?.as_u64()?).ok()?,
                column: u32::try_from(preview[..start].chars().count() + 1).ok()?,
                preview,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    bounded_output(
        tool_id,
        ToolOutputPayloadV4::SearchMatches { matches },
        budget,
    )
}

fn web_search_output(
    tool_id: AuthorityToolIdV4,
    raw: Option<&serde_json::Value>,
    budget: u32,
) -> Option<ToolOutputV4> {
    let items = raw?
        .as_array()?
        .iter()
        .map(|value| {
            Some(WebSearchItemV4 {
                title: value.get("title")?.as_str()?.to_owned(),
                url: value.get("url")?.as_str()?.to_owned(),
                snippet: value
                    .get("snippet")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    bounded_output(
        tool_id,
        ToolOutputPayloadV4::WebSearchResults { items },
        budget,
    )
}

fn web_response_output(
    tool_id: AuthorityToolIdV4,
    raw: &RawExecution,
    revalidation: &PreparedRevalidation,
    budget: u32,
) -> Option<ToolOutputV4> {
    let ResolvedResourceV2::NetworkEndpoint {
        origin,
        target_observation_digest,
    } = &revalidation.target.public_resource
    else {
        return None;
    };
    bounded_output(
        tool_id,
        ToolOutputPayloadV4::WebResponse {
            status_code: raw.http_status_code?,
            final_target: NetworkPublicTargetV4 {
                origin: origin.clone(),
                target_observation_digest: target_observation_digest.clone(),
            },
            content_type: raw.http_content_type.clone()?,
            body: raw.output.get("content")?.as_str()?.to_owned(),
        },
        budget,
    )
}

fn complete_payload_for_output(
    invocation: &ToolInvocationInputV4,
    raw: &RawExecution,
    workspace: &WorkspaceBinding,
) -> Option<ToolOutputPayloadV4> {
    match invocation {
        ToolInvocationInputV4::FsList { .. } => {
            let output =
                path_entries_from_nodes(invocation.tool_id(), raw.output.get("nodes"), u32::MAX)?;
            Some(output.payload)
        }
        ToolInvocationInputV4::FsGlob { .. } => {
            let output = path_entries_from_glob(
                invocation.tool_id(),
                raw.output.get("matches"),
                &workspace.canonical_root,
                u32::MAX,
            )?;
            Some(output.payload)
        }
        _ => None,
    }
}

fn bounded_output(
    tool_id: AuthorityToolIdV4,
    complete: ToolOutputPayloadV4,
    maximum_bytes: u32,
) -> Option<ToolOutputV4> {
    let complete_output = output_payload_measure_v4(tool_id, complete).ok()?;
    let maximum = maximum_bytes as usize;
    if complete_output.total_bytes <= maximum as u64 {
        return Some(complete_output);
    }
    let retained = truncate_payload_to_budget(&complete_output.payload, maximum)?;
    let retained_bytes = serde_json::to_vec(&retained).ok()?.len() as u64;
    Some(ToolOutputV4 {
        full_digest: complete_output.full_digest,
        total_bytes: complete_output.total_bytes,
        truncation: OutputTruncationV4::Truncated { retained_bytes },
        payload: retained,
    })
}

fn truncate_payload_to_budget(
    complete: &ToolOutputPayloadV4,
    maximum: usize,
) -> Option<ToolOutputPayloadV4> {
    match complete {
        ToolOutputPayloadV4::Utf8Text { media_type, text } => {
            truncate_text(text, maximum, |text| ToolOutputPayloadV4::Utf8Text {
                media_type: *media_type,
                text,
            })
        }
        ToolOutputPayloadV4::WebResponse {
            status_code,
            content_type,
            body,
            final_target,
        } => truncate_text(body, maximum, |body| ToolOutputPayloadV4::WebResponse {
            status_code: *status_code,
            content_type: content_type.clone(),
            body,
            final_target: final_target.clone(),
        }),
        ToolOutputPayloadV4::PathEntries { entries } => {
            truncate_items(entries, maximum, |entries| {
                ToolOutputPayloadV4::PathEntries { entries }
            })
        }
        ToolOutputPayloadV4::SearchMatches { matches } => {
            truncate_items(matches, maximum, |matches| {
                ToolOutputPayloadV4::SearchMatches { matches }
            })
        }
        ToolOutputPayloadV4::WebSearchResults { items } => {
            truncate_items(items, maximum, |items| {
                ToolOutputPayloadV4::WebSearchResults { items }
            })
        }
        ToolOutputPayloadV4::NoPrimaryContent {} => None,
    }
}

fn truncate_text(
    text: &str,
    maximum: usize,
    build: impl Fn(String) -> ToolOutputPayloadV4,
) -> Option<ToolOutputPayloadV4> {
    let boundaries = text
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(text.len()))
        .collect::<Vec<_>>();
    let retained = largest_prefix(boundaries.len() - 1, |count| {
        serialized_fits(&build(text[..boundaries[count]].to_owned()), maximum)
    })?;
    Some(build(text[..boundaries[retained]].to_owned()))
}

fn truncate_items<T: Clone>(
    items: &[T],
    maximum: usize,
    build: impl Fn(Vec<T>) -> ToolOutputPayloadV4,
) -> Option<ToolOutputPayloadV4> {
    let retained = largest_prefix(items.len(), |count| {
        serialized_fits(&build(items[..count].to_vec()), maximum)
    })?;
    Some(build(items[..retained].to_vec()))
}

fn largest_prefix(upper: usize, mut fits: impl FnMut(usize) -> Option<bool>) -> Option<usize> {
    if !fits(0)? {
        return None;
    }
    let (mut low, mut high) = (0, upper.saturating_add(1));
    while low + 1 < high {
        let middle = low + (high - low) / 2;
        if fits(middle)? {
            low = middle;
        } else {
            high = middle;
        }
    }
    Some(low)
}

fn serialized_fits(payload: &ToolOutputPayloadV4, maximum: usize) -> Option<bool> {
    Some(serde_json::to_vec(payload).ok()?.len() <= maximum)
}

fn materialize_deadline(
    request: DeadlineRequestV2,
    contract: &DeadlineV4,
) -> Result<u32, PrepareFailure> {
    match request {
        DeadlineRequestV2::ContractDefault {} => Ok(contract.default_ms),
        DeadlineRequestV2::ExactMilliseconds { value }
            if value > 0 && value <= contract.maximum_ms =>
        {
            Ok(value)
        }
        DeadlineRequestV2::ExactMilliseconds { value } => {
            Err(PrepareFailure::Kernel(KernelErrorV2::InvalidRequest {
                reason: InvalidRequestReasonV2::DeadlineOutOfContract {
                    requested_ms: value,
                    maximum_ms: contract.maximum_ms,
                },
            }))
        }
    }
}

fn resolve_invocation_targets(
    invocation: &ToolInvocationInputV4,
    workspace: &WorkspaceBinding,
    executor_config: &KernelExecutorConfig,
) -> Result<(ResourceScopeV2, Vec<ResolvedTarget>), PrepareFailure> {
    use ToolInvocationInputV4 as Input;
    let workspace_spec = match invocation {
        Input::FsRead { path, .. }
        | Input::FsDiff { path, .. }
        | Input::DocumentRead { path, .. } => Some(WorkspaceTargetSpec::new(
            path,
            ExpectedTarget::MustFile,
            ResourceAccessV2::Read,
        )),
        Input::FsList { path, .. } => Some(WorkspaceTargetSpec::new(
            path,
            ExpectedTarget::MustDirectory,
            ResourceAccessV2::Read,
        )),
        Input::FsGlob { root, .. } | Input::CodeGrep { root, .. } => Some(
            WorkspaceTargetSpec::new(root, ExpectedTarget::MustDirectory, ResourceAccessV2::Read),
        ),
        Input::FsCreate { path, .. } => Some(WorkspaceTargetSpec::new(
            path,
            ExpectedTarget::MustAbsent(WorkspaceObjectKindV2::File),
            ResourceAccessV2::Write,
        )),
        Input::FsWrite { path, .. } | Input::FsEdit { path, .. } => Some(WorkspaceTargetSpec::new(
            path,
            ExpectedTarget::MustFile,
            ResourceAccessV2::Write,
        )),
        Input::FsDelete(DeleteTargetV4::File { path }) => Some(WorkspaceTargetSpec::new(
            path,
            ExpectedTarget::MustFile,
            ResourceAccessV2::Write,
        )),
        Input::FsDelete(DeleteTargetV4::DirectoryTree { path }) => Some(WorkspaceTargetSpec::new(
            path,
            ExpectedTarget::MustDirectory,
            ResourceAccessV2::Write,
        )),
        Input::FsEnsureDirectory { path } => Some(WorkspaceTargetSpec::new(
            path,
            ExpectedTarget::DirectoryOrAbsent,
            ResourceAccessV2::Write,
        )),
        Input::FsRename { .. }
        | Input::GitStatus {}
        | Input::GitDiff { .. }
        | Input::GitStage { .. }
        | Input::GitUnstage { .. }
        | Input::GitCommit { .. } => {
            return Err(PrepareFailure::Kernel(
                KernelErrorV2::ToolExecutionUnavailable {
                    tool_id: invocation.tool_id(),
                    availability: ExecutionAvailabilityV4::Blocked,
                },
            ));
        }
        Input::WebSearch { .. } | Input::WebFetch { .. } => None,
    };

    if let Some(spec) = workspace_spec {
        let access = spec.2;
        let resolved = resolve_workspace_target(workspace, spec)?;
        let target = WorkspaceScopeTargetV2 {
            relative_path: resolved
                .relative_path
                .clone()
                .expect("workspace target path"),
            object_kind: resolved.object_kind.expect("workspace target kind"),
            access,
            target_observation_digest: resolved
                .state_digest
                .clone()
                .expect("workspace target state"),
        };
        return Ok((
            ResourceScopeV2::Workspace {
                targets: vec![target],
            },
            vec![resolved],
        ));
    }

    match invocation {
        Input::WebSearch { query, limit } => {
            let url = crate::executors::web::web_search_target_url(
                executor_config,
                query,
                u64::from(*limit),
            )
            .map_err(|_| PrepareFailure::Target(TargetResolutionFailureV2::ResolverUnavailable))?;
            let network = resolve_network_target(&url)?;
            let query_digest = query_digest_v2(&serde_json::json!({
                "kind":"webSearch",
                "query":query
            }))
            .map_err(|_| storage_fault())?;
            let public_resource = ResolvedResourceV2::NetworkQuery {
                query_digest: query_digest.clone(),
                service_origin: network.origin.clone(),
                target_observation_digest: network.target_digest.clone(),
            };
            Ok((
                ResourceScopeV2::NetworkQuery {
                    query_digest,
                    service_origin: network.origin,
                    target_observation_digest: network.target_digest,
                },
                vec![ResolvedTarget {
                    relative_path: None,
                    object_kind: None,
                    state: None,
                    state_digest: None,
                    public_resource,
                    private_target: network.private_target,
                }],
            ))
        }
        Input::WebFetch { url, .. } => {
            let network = resolve_network_target(url)?;
            let public_resource = ResolvedResourceV2::NetworkEndpoint {
                origin: network.origin.clone(),
                target_observation_digest: network.target_digest.clone(),
            };
            Ok((
                ResourceScopeV2::NetworkUrl {
                    origin: network.origin,
                    target_observation_digest: network.target_digest,
                },
                vec![ResolvedTarget {
                    relative_path: None,
                    object_kind: None,
                    state: None,
                    state_digest: None,
                    public_resource,
                    private_target: network.private_target,
                }],
            ))
        }
        _ => Err(PrepareFailure::Target(
            TargetResolutionFailureV2::ResolverUnavailable,
        )),
    }
}

enum ExpectedTarget {
    MustFile,
    MustDirectory,
    MustAbsent(WorkspaceObjectKindV2),
    DirectoryOrAbsent,
}

struct WorkspaceTargetSpec(String, ExpectedTarget, ResourceAccessV2);

impl WorkspaceTargetSpec {
    fn new(path: &str, expected: ExpectedTarget, access: ResourceAccessV2) -> Self {
        Self(path.to_owned(), expected, access)
    }
}

fn resolve_workspace_target(
    workspace: &WorkspaceBinding,
    spec: WorkspaceTargetSpec,
) -> Result<ResolvedTarget, PrepareFailure> {
    let WorkspaceTargetSpec(path, expected, _) = spec;
    let canonical_target = resolve_private_workspace_path(&workspace.canonical_root, &path)?;
    let state = resource_state_for_path(&canonical_target)?;
    let object_kind = match (&expected, &state) {
        (ExpectedTarget::MustFile, ResourceStateV2::File { .. }) => WorkspaceObjectKindV2::File,
        (ExpectedTarget::MustDirectory, ResourceStateV2::Directory { .. }) => {
            WorkspaceObjectKindV2::Directory
        }
        (ExpectedTarget::MustAbsent(kind), ResourceStateV2::Absent {}) => *kind,
        (ExpectedTarget::DirectoryOrAbsent, ResourceStateV2::Absent {})
        | (ExpectedTarget::DirectoryOrAbsent, ResourceStateV2::Directory { .. }) => {
            WorkspaceObjectKindV2::Directory
        }
        (ExpectedTarget::MustAbsent(_), _) => {
            return Err(PrepareFailure::Target(
                TargetResolutionFailureV2::AlreadyExists,
            ));
        }
        (_, ResourceStateV2::Absent {}) => {
            return Err(PrepareFailure::Target(TargetResolutionFailureV2::NotFound));
        }
        _ => {
            return Err(PrepareFailure::Target(
                TargetResolutionFailureV2::WrongObjectKind,
            ));
        }
    };
    let state_digest = resource_state_digest_v2(&state).map_err(|_| storage_fault())?;
    let raw = canonical_target
        .to_str()
        .ok_or_else(|| PrepareFailure::Target(TargetResolutionFailureV2::ResolverUnavailable))?;
    let canonical_absolute_path_utf8 =
        normalize_canonical_platform_path_v4(workspace.platform, raw)
            .map_err(|_| PrepareFailure::Target(TargetResolutionFailureV2::ResolverUnavailable))?;
    let canonical_relative_path = canonical_target
        .strip_prefix(&workspace.canonical_root)
        .ok()
        .and_then(Path::to_str)
        .map(|value| value.replace('\\', "/"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".".to_owned());
    Ok(ResolvedTarget {
        relative_path: Some(canonical_relative_path.clone()),
        object_kind: Some(object_kind),
        state: Some(state),
        state_digest: Some(state_digest.clone()),
        public_resource: ResolvedResourceV2::Workspace {
            object_kind,
            relative_path: canonical_relative_path,
            resolution_state_digest: state_digest,
        },
        private_target: CanonicalPrivateTargetV2::Workspace {
            platform: workspace.platform,
            canonical_absolute_path_utf8,
        },
    })
}

fn resolve_private_workspace_path(
    canonical_root: &Path,
    relative: &str,
) -> Result<PathBuf, PrepareFailure> {
    let mut candidate = canonical_root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(value) => candidate.push(value),
            Component::CurDir if relative == "." => {}
            _ => {
                return Err(PrepareFailure::Target(
                    TargetResolutionFailureV2::SymlinkPolicyViolation,
                ));
            }
        }
    }
    let mut existing = candidate.as_path();
    let mut suffix = Vec::new();
    while !existing.exists() {
        let name = existing.file_name().ok_or_else(|| {
            PrepareFailure::Target(TargetResolutionFailureV2::ResolverUnavailable)
        })?;
        suffix.push(name.to_os_string());
        existing = existing.parent().ok_or_else(|| {
            PrepareFailure::Target(TargetResolutionFailureV2::ResolverUnavailable)
        })?;
    }
    let mut resolved = fs::canonicalize(existing)
        .map_err(|_| PrepareFailure::Target(TargetResolutionFailureV2::ResolverUnavailable))?;
    if !resolved.starts_with(canonical_root) {
        return Err(PrepareFailure::Target(
            TargetResolutionFailureV2::SymlinkPolicyViolation,
        ));
    }
    for part in suffix.iter().rev() {
        resolved.push(part);
    }
    if candidate.exists() {
        resolved = fs::canonicalize(&candidate)
            .map_err(|_| PrepareFailure::Target(TargetResolutionFailureV2::ResolverUnavailable))?;
        if !resolved.starts_with(canonical_root) {
            return Err(PrepareFailure::Target(
                TargetResolutionFailureV2::SymlinkPolicyViolation,
            ));
        }
    }
    Ok(resolved)
}

pub(super) fn canonicalize_requested_workspace_path(
    workspace: &WorkspaceBinding,
    relative: &str,
) -> Result<String, PrepareFailure> {
    let target = resolve_private_workspace_path(&workspace.canonical_root, relative)?;
    target
        .strip_prefix(&workspace.canonical_root)
        .ok()
        .and_then(Path::to_str)
        .map(|value| value.replace('\\', "/"))
        .map(|value| {
            if value.is_empty() {
                ".".to_owned()
            } else {
                value
            }
        })
        .ok_or(PrepareFailure::Target(
            TargetResolutionFailureV2::ResolverUnavailable,
        ))
}

fn resource_state_for_path(path: &Path) -> Result<ResourceStateV2, PrepareFailure> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ResourceStateV2::Absent {});
        }
        Err(_) => {
            return Err(PrepareFailure::Target(
                TargetResolutionFailureV2::ResolverUnavailable,
            ));
        }
    };
    if metadata.is_file() {
        let bytes = fs::read(path)
            .map_err(|_| PrepareFailure::Target(TargetResolutionFailureV2::ResolverUnavailable))?;
        return Ok(ResourceStateV2::File {
            content_digest: content_digest_v2(&bytes),
            byte_length: bytes.len() as u64,
            executable: executable(&metadata),
        });
    }
    if metadata.is_dir() {
        let entries = collect_path_entries(path)?;
        let collection_digest = collection_digest_v2(&entries).map_err(|_| storage_fault())?;
        return Ok(ResourceStateV2::Directory {
            collection_digest,
            item_count: entries.len() as u64,
        });
    }
    Err(PrepareFailure::Target(
        TargetResolutionFailureV2::WrongObjectKind,
    ))
}

fn collect_path_entries(root: &Path) -> Result<Vec<PathEntryV4>, PrepareFailure> {
    fn visit(
        root: &Path,
        current: &Path,
        entries: &mut Vec<PathEntryV4>,
    ) -> Result<(), PrepareFailure> {
        let mut children = fs::read_dir(current)
            .map_err(|_| PrepareFailure::Target(TargetResolutionFailureV2::ResolverUnavailable))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| PrepareFailure::Target(TargetResolutionFailureV2::ResolverUnavailable))?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let path = child.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| {
                PrepareFailure::Target(TargetResolutionFailureV2::ResolverUnavailable)
            })?;
            if metadata.file_type().is_symlink() {
                return Err(PrepareFailure::Target(
                    TargetResolutionFailureV2::SymlinkPolicyViolation,
                ));
            }
            let relative = path
                .strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .ok_or_else(|| {
                    PrepareFailure::Target(TargetResolutionFailureV2::ResolverUnavailable)
                })?
                .replace('\\', "/");
            let (kind, size) = if metadata.is_dir() {
                (
                    WorkspaceObjectKindV4::Directory,
                    PathEntrySizeV4::Unavailable {},
                )
            } else if metadata.is_file() {
                (
                    WorkspaceObjectKindV4::File,
                    PathEntrySizeV4::Bytes {
                        value: metadata.len(),
                    },
                )
            } else {
                continue;
            };
            entries.push(PathEntryV4 {
                relative_path: relative,
                kind,
                size,
            });
            if metadata.is_dir() {
                visit(root, &path, entries)?;
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    visit(root, root, &mut entries)?;
    entries.sort_by(|left, right| {
        left.relative_path
            .as_bytes()
            .cmp(right.relative_path.as_bytes())
    });
    Ok(entries)
}

#[cfg(unix)]
fn executable(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_metadata: &fs::Metadata) -> bool {
    false
}

struct ResolvedNetwork {
    origin: NetworkOriginV2,
    target_digest: NetworkTargetObservationDigestV2,
    private_target: CanonicalPrivateTargetV2,
}

pub(super) fn canonicalize_network_scope_url(
    url: &str,
) -> Result<(String, NetworkTargetObservationDigestV2), PrepareFailure> {
    let parsed = crate::network_policy::validate_http_url_shape(url)
        .map_err(|_| PrepareFailure::Target(TargetResolutionFailureV2::NetworkTargetRejected))?;
    let canonical_url = parsed.to_string();
    let resolved = resolve_network_target(&canonical_url)?;
    Ok((canonical_url, resolved.target_digest))
}

fn resolve_network_target(url: &str) -> Result<ResolvedNetwork, PrepareFailure> {
    let parsed = crate::network_policy::validate_http_url_shape(url)
        .map_err(|_| PrepareFailure::Target(TargetResolutionFailureV2::NetworkTargetRejected))?;
    if parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !parsed
            .host_str()
            .is_some_and(|host| host.is_ascii() && !host.ends_with('.'))
    {
        return Err(PrepareFailure::Target(
            TargetResolutionFailureV2::NetworkTargetRejected,
        ));
    }
    let reviewed = review_http_target(url)
        .map_err(|_| PrepareFailure::Target(TargetResolutionFailureV2::NetworkTargetRejected))?;
    if reviewed
        .resolved_addresses
        .iter()
        .any(|address| denied_network_address(address.ip()))
    {
        return Err(PrepareFailure::Target(
            TargetResolutionFailureV2::NetworkTargetRejected,
        ));
    }
    let request_target = materialize_request_target(&parsed)?;
    let mut reviewed_addresses = reviewed
        .resolved_addresses
        .iter()
        .map(|address| network_address(address.ip()))
        .collect::<Vec<_>>();
    reviewed_addresses.sort();
    reviewed_addresses.dedup();
    if reviewed_addresses.is_empty() {
        return Err(PrepareFailure::Target(
            TargetResolutionFailureV2::ResolverUnavailable,
        ));
    }
    let target_digest = network_target_digest_v2(&serde_json::json!({
        "networkPolicyContract":"deepcode.kernel.network-policy.v2",
        "requestTarget":request_target,
        "reviewedAddresses":reviewed_addresses
    }))
    .map_err(|_| storage_fault())?;
    let origin = NetworkOriginV2 {
        scheme: request_target.scheme,
        host: request_target.host.clone(),
        port: request_target.port,
    };
    Ok(ResolvedNetwork {
        origin,
        target_digest,
        private_target: CanonicalPrivateTargetV2::Network {
            request_target,
            reviewed_addresses,
        },
    })
}

fn materialize_request_target(
    parsed: &reqwest::Url,
) -> Result<NetworkRequestTargetV2, PrepareFailure> {
    let scheme = match parsed.scheme() {
        "http" => NetworkSchemeV2::Http,
        "https" => NetworkSchemeV2::Https,
        _ => {
            return Err(PrepareFailure::Target(
                TargetResolutionFailureV2::NetworkTargetRejected,
            ));
        }
    };
    let host_text = parsed
        .host_str()
        .ok_or(PrepareFailure::Target(
            TargetResolutionFailureV2::NetworkTargetRejected,
        ))?
        .to_ascii_lowercase();
    let host = if let Ok(address) = host_text.parse::<Ipv4Addr>() {
        NetworkHostV2::Ipv4 {
            octets: address.octets(),
        }
    } else if let Ok(address) = host_text.parse::<Ipv6Addr>() {
        NetworkHostV2::Ipv6 {
            octets: address.octets(),
        }
    } else {
        let labels = host_text.split('.').map(str::to_owned).collect::<Vec<_>>();
        if labels.is_empty()
            || host_text.len() > 253
            || labels.iter().any(|label| {
                label.is_empty()
                    || label.len() > 63
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    })
            })
        {
            return Err(PrepareFailure::Target(
                TargetResolutionFailureV2::NetworkTargetRejected,
            ));
        }
        NetworkHostV2::DnsName { labels }
    };
    Ok(NetworkRequestTargetV2 {
        scheme,
        host,
        port: parsed
            .port_or_known_default()
            .ok_or(PrepareFailure::Target(
                TargetResolutionFailureV2::NetworkTargetRejected,
            ))?,
        path_utf8: if parsed.path().is_empty() {
            "/".to_owned()
        } else {
            parsed.path().to_owned()
        },
        query: match parsed.query() {
            Some(query) => NetworkQueryV2::Exact {
                utf8: query.to_owned(),
            },
            None => NetworkQueryV2::None {},
        },
    })
}

fn network_address(address: IpAddr) -> NetworkAddressV2 {
    match address {
        IpAddr::V4(address) => NetworkAddressV2::Ipv4 {
            octets: address.octets(),
        },
        IpAddr::V6(address) => NetworkAddressV2::Ipv6 {
            octets: address.octets(),
        },
    }
}

fn denied_network_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let value = u32::from_be_bytes(address.octets());
            [
                (0x0000_0000, 8),
                (0x0a00_0000, 8),
                (0x6440_0000, 10),
                (0x7f00_0000, 8),
                (0xa9fe_0000, 16),
                (0xac10_0000, 12),
                (0xc000_0000, 24),
                (0xc000_0200, 24),
                (0xc058_6300, 24),
                (0xc0a8_0000, 16),
                (0xc612_0000, 15),
                (0xc633_6400, 24),
                (0xcb00_7100, 24),
                (0xe000_0000, 4),
                (0xf000_0000, 4),
            ]
            .into_iter()
            .any(|(network, prefix)| in_prefix_u32(value, network, prefix))
        }
        IpAddr::V6(address) => {
            let value = u128::from_be_bytes(address.octets());
            [
                (0u128, 128),
                (1u128, 128),
                (0x0000_0000_0000_0000_0000_ffff_0000_0000, 96),
                (0x0064_ff9b_0000_0000_0000_0000_0000_0000, 96),
                (0x0064_ff9b_0001_0000_0000_0000_0000_0000, 48),
                (0x0100_0000_0000_0000_0000_0000_0000_0000, 64),
                (0x2001_0000_0000_0000_0000_0000_0000_0000, 23),
                (0x2001_0db8_0000_0000_0000_0000_0000_0000, 32),
                (0x2002_0000_0000_0000_0000_0000_0000_0000, 16),
                (0x3ffe_0000_0000_0000_0000_0000_0000_0000, 16),
                (0xfc00_0000_0000_0000_0000_0000_0000_0000, 7),
                (0xfe80_0000_0000_0000_0000_0000_0000_0000, 10),
                (0xfec0_0000_0000_0000_0000_0000_0000_0000, 10),
                (0xff00_0000_0000_0000_0000_0000_0000_0000, 8),
            ]
            .into_iter()
            .any(|(network, prefix)| in_prefix_u128(value, network, prefix))
        }
    }
}

fn in_prefix_u32(value: u32, network: u32, prefix: u32) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    value & mask == network & mask
}

fn in_prefix_u128(value: u128, network: u128, prefix: u32) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    };
    value & mask == network & mask
}

pub(super) fn policy_auto_issuable(
    mode: AutonomyModeV2,
    tool_id: AuthorityToolIdV4,
    risk: ToolRiskV4,
    effect_scope: EffectScopeV4,
) -> bool {
    let low = risk == ToolRiskV4::Low;
    let trusted = low
        || (risk == ToolRiskV4::Medium
            && matches!(
                effect_scope,
                EffectScopeV4::WorkspaceRead | EffectScopeV4::WorkspaceWrite
            ));
    match mode {
        AutonomyModeV2::Strict => low,
        AutonomyModeV2::TrustedWorkspace => trusted,
        AutonomyModeV2::Maximum => {
            trusted
                || matches!(
                    tool_id,
                    AuthorityToolIdV4::FsRename
                        | AuthorityToolIdV4::GitStage
                        | AuthorityToolIdV4::GitUnstage
                )
        }
    }
}

pub(super) enum SubmissionDisposition {
    Fresh,
    Retry,
    Replay(InvocationSubmissionReplyV2),
    Reject(AdmissionRejectionV2),
}

pub(super) fn classify_submission_binding(
    state: &AuthorityState,
    run_id: &RunId,
    operation_id: &OperationId,
    idempotency_key_hash: &IdempotencyKeyHashV2,
    submitted: &InvocationSubmissionDigestV2,
) -> AuthorityResult<SubmissionDisposition> {
    let operation = state
        .operation_bindings
        .get(&(run_id.clone(), operation_id.clone()));
    let idempotency = state
        .idempotency_bindings
        .get(&(run_id.clone(), idempotency_key_hash.clone()));
    match (operation, idempotency) {
        (None, None) => Ok(SubmissionDisposition::Fresh),
        (Some(operation), Some(idempotency)) => {
            if operation != idempotency {
                return Err(corrupt_store());
            }
            if operation.digest == *submitted {
                if operation.retryable_rejection {
                    Ok(SubmissionDisposition::Retry)
                } else {
                    Ok(SubmissionDisposition::Replay(operation.reply.clone()))
                }
            } else {
                Ok(SubmissionDisposition::Reject(
                    AdmissionRejectionV2::DuplicateOperationDigestMismatch {
                        conflict: OperationIdempotencyConflictV2::Both {
                            operation_existing: operation.digest.clone(),
                            idempotency_existing: idempotency.digest.clone(),
                        },
                        submitted: submitted.clone(),
                    },
                ))
            }
        }
        (Some(operation), None) if operation.digest == *submitted => Ok(
            SubmissionDisposition::Reject(AdmissionRejectionV2::OperationIdempotencyPairMismatch {
                known: PairKnownSideV2::Operation,
            }),
        ),
        (None, Some(idempotency)) if idempotency.digest == *submitted => Ok(
            SubmissionDisposition::Reject(AdmissionRejectionV2::OperationIdempotencyPairMismatch {
                known: PairKnownSideV2::Idempotency,
            }),
        ),
        (Some(operation), None) => Ok(SubmissionDisposition::Reject(
            AdmissionRejectionV2::DuplicateOperationDigestMismatch {
                conflict: OperationIdempotencyConflictV2::Operation {
                    existing: operation.digest.clone(),
                },
                submitted: submitted.clone(),
            },
        )),
        (None, Some(idempotency)) => Ok(SubmissionDisposition::Reject(
            AdmissionRejectionV2::DuplicateOperationDigestMismatch {
                conflict: OperationIdempotencyConflictV2::Idempotency {
                    existing: idempotency.digest.clone(),
                },
                submitted: submitted.clone(),
            },
        )),
    }
}

pub(super) fn grant_decision_key(
    run_id: &RunId,
    operation_id: &OperationId,
    control_epoch: ControlEpoch,
    authorization_digest: &AuthorizationRequestDigestV2,
    basis: &GrantDecisionBasisV2,
) -> AuthorityResult<String> {
    serde_json::to_string(&(
        run_id,
        operation_id,
        control_epoch,
        authorization_digest,
        basis,
    ))
    .map_err(|_| corrupt_store())
}

pub(super) fn canonical_grant_request(
    request: &GrantRequestV2,
    prepared: &PreparedGrantRequest,
    contract: &ToolContractV4,
) -> CanonicalGrantRequestV2 {
    CanonicalGrantRequestV2 {
        run_id: request.run_id.clone(),
        operation_id: request.operation_id.clone(),
        control_epoch: request.control_epoch,
        idempotency_key_hash: prepared.idempotency_key_hash.clone(),
        canonical_invocation: prepared.canonical_invocation.clone(),
        local_tool_contract_digest: contract.contract_digest.clone(),
        resource_scope: prepared.resource_scope.clone(),
        effect_scope: contract.effect_scope,
        risk: contract.risk,
        effective_deadline_ms: prepared.effective_deadline_ms,
        workspace_binding_digest: prepared.workspace_binding_digest.clone(),
        authorization_request_digest: prepared.authorization_digest.clone(),
        correlation_refs: prepared.correlations.refs.clone(),
    }
}

pub(super) fn command_receipt_draft(
    fact_id: FactId,
    run_id: RunId,
    epoch_context: CommandEpochContextV2,
    request_id: CommandRequestId,
    request_digest: CommandRequestDigestV2,
    command_kind: MutationCommandKindV2,
    result: MutationCommandResultV2,
) -> KernelFactDraftV2 {
    fact_draft(
        fact_id,
        KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded {
            identity: CommandReceiptIdentityV2 {
                run_id,
                epoch_context,
                command_request_identity: CommandRequestIdentityV2 {
                    command_request_id: request_id,
                    command_request_digest: request_digest,
                },
            },
            command_kind,
            result,
        }),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn grant_decision_drafts(
    command_fact_id: FactId,
    business_fact_id: FactId,
    request_id: CommandRequestId,
    request_digest: CommandRequestDigestV2,
    request: GrantRequestV2,
    prepared: PreparedGrantRequest,
    contract: &ToolContractV4,
    decision_digest: GrantDecisionDigestV2,
    basis: GrantDecisionBasisV2,
    reply: GrantDecisionReplyV2,
) -> Vec<KernelFactDraftV2> {
    let business = match &reply {
        GrantDecisionReplyV2::Issued { grant_id, .. } => {
            KernelFactPayloadV2::Grant(GrantFactV2::Issued {
                identity: GrantIssuedIdentityV2 {
                    run_id: request.run_id.clone(),
                    grant_epoch: request.control_epoch,
                    issuance_operation_id: request.operation_id.clone(),
                    grant_id: grant_id.clone(),
                    causation_fact_id: command_fact_id.clone(),
                    correlation_set: prepared.correlations.clone(),
                },
                tool_id: contract.tool_id,
                issuance_authorization_digest: prepared.authorization_digest,
                grant_decision_digest: decision_digest,
                grant_scope_digest: prepared.grant_scope_digest,
                resource_scope: prepared.resource_scope,
                effect_scope: contract.effect_scope,
                risk: contract.risk,
                use_policy: GrantUsePolicyV2::UnboundedWithinEpoch,
                decision_basis: basis,
            })
        }
        GrantDecisionReplyV2::Denied { .. } => KernelFactPayloadV2::Grant(GrantFactV2::Denied {
            identity: GrantDeniedIdentityV2 {
                run_id: request.run_id.clone(),
                control_epoch: request.control_epoch,
                operation_id: request.operation_id,
                causation_fact_id: command_fact_id.clone(),
                correlation_set: prepared.correlations,
            },
            tool_id: contract.tool_id,
            authorization_request_digest: prepared.authorization_digest,
            grant_decision_digest: decision_digest,
            reason_code: GrantDenialReasonV2::UserDenied,
            decision_basis: basis,
        }),
        GrantDecisionReplyV2::RequiresUserDecision { .. } => {
            unreachable!("requires-user decisions have no business fact")
        }
    };
    vec![
        command_receipt_draft(
            command_fact_id,
            request.run_id,
            exact_epoch(request.control_epoch),
            request_id,
            request_digest,
            MutationCommandKindV2::GrantDecisionSubmit,
            MutationCommandResultV2::GrantDecision { reply },
        ),
        fact_draft(business_fact_id, business),
    ]
}

#[allow(clippy::too_many_arguments)]
pub(super) fn invocation_rejection_drafts(
    command_fact_id: FactId,
    rejection_fact_id: FactId,
    request_id: CommandRequestId,
    request_digest: CommandRequestDigestV2,
    request: &GrantRequestV2,
    current_epoch: ControlEpoch,
    tool_id: AuthorityToolIdV4,
    submission_digest: InvocationSubmissionDigestV2,
    rejection: AdmissionRejectionV2,
    reply: InvocationSubmissionReplyV2,
) -> AuthorityResult<Vec<KernelFactDraftV2>> {
    Ok(vec![
        command_receipt_draft(
            command_fact_id.clone(),
            request.run_id.clone(),
            exact_epoch(current_epoch),
            request_id,
            request_digest,
            MutationCommandKindV2::InvocationSubmit,
            MutationCommandResultV2::InvocationSubmission { reply },
        ),
        fact_draft(
            rejection_fact_id,
            KernelFactPayloadV2::Invocation(InvocationFactV2::Rejected {
                identity: InvocationRejectedIdentityV2 {
                    run_id: request.run_id.clone(),
                    current_control_epoch: current_epoch,
                    operation_id: request.operation_id.clone(),
                    idempotency_key_hash: idempotency_key_hash_v2(
                        &request.run_id,
                        &request.idempotency_key,
                    )
                    .map_err(|_| corrupt_store())?,
                    causation_fact_id: command_fact_id,
                    correlation_set: CorrelationSetV2::materialize(
                        request.correlation_refs.clone(),
                    )
                    .map_err(|_| corrupt_store())?,
                },
                tool_id,
                submission_digest,
                rejection,
            }),
        ),
    ])
}

#[allow(clippy::too_many_arguments)]
pub(super) fn invocation_admission_drafts(
    command_fact_id: FactId,
    admitted_fact_id: FactId,
    reserved_fact_id: FactId,
    attempt_fact_id: FactId,
    resource_fact_ids: Vec<FactId>,
    request_id: CommandRequestId,
    request_digest: CommandRequestDigestV2,
    prepared: &PreparedGrantRequest,
    grant: &GrantRecord,
    contract: &ToolContractV4,
    submission_digest: InvocationSubmissionDigestV2,
    invocation_digest: InvocationRequestDigestV2,
    identity: &AttemptIdentityV2,
    targets: &[(ResourceId, ResolvedTarget)],
    reply: InvocationSubmissionReplyV2,
) -> Vec<KernelFactDraftV2> {
    let mut drafts = vec![
        command_receipt_draft(
            command_fact_id.clone(),
            identity.run_id.clone(),
            exact_epoch(identity.control_epoch),
            request_id,
            request_digest,
            MutationCommandKindV2::InvocationSubmit,
            MutationCommandResultV2::InvocationSubmission { reply },
        ),
        fact_draft(
            admitted_fact_id.clone(),
            KernelFactPayloadV2::Invocation(InvocationFactV2::Admitted {
                identity: caused_attempt(identity, command_fact_id),
                tool_id: contract.tool_id,
                submission_digest,
                invocation_digest,
                grant_scope_digest: grant.grant_scope_digest.clone(),
                grant_issuance_authorization_digest: grant.issuance_authorization_digest.clone(),
                tool_contract_digest: contract.contract_digest.clone(),
                workspace_binding_digest: prepared.workspace_binding_digest.clone(),
                effective_deadline_ms: prepared.effective_deadline_ms,
            }),
        ),
        fact_draft(
            reserved_fact_id.clone(),
            KernelFactPayloadV2::Grant(GrantFactV2::Reserved {
                identity: reservation_identity(identity, admitted_fact_id),
            }),
        ),
        fact_draft(
            attempt_fact_id.clone(),
            KernelFactPayloadV2::Invocation(InvocationFactV2::AttemptPrepared {
                identity: caused_attempt(identity, reserved_fact_id),
            }),
        ),
    ];
    drafts.extend(resource_fact_ids.into_iter().zip(targets).map(
        |(fact_id, (resource_id, target))| {
            fact_draft(
                fact_id,
                KernelFactPayloadV2::Resource(ResourceFactV2::ResolvedForInvocation {
                    identity: ResourceResolvedIdentityV2 {
                        run_id: identity.run_id.clone(),
                        control_epoch: identity.control_epoch,
                        operation_id: identity.operation_id.clone(),
                        invocation_id: identity.invocation_id.clone(),
                        resource_id: resource_id.clone(),
                        idempotency_key_hash: identity.idempotency_key_hash.clone(),
                        causation_fact_id: attempt_fact_id.clone(),
                        correlation_set: identity.correlation_set.clone(),
                    },
                    resource: target.public_resource.clone(),
                }),
            )
        },
    ));
    drafts
}

#[allow(clippy::too_many_arguments)]
pub(super) fn direct_tool_intent_admission_drafts(
    command_fact_id: FactId,
    admitted_fact_id: FactId,
    attempt_fact_id: FactId,
    resource_fact_ids: Vec<FactId>,
    request_id: CommandRequestId,
    request_digest: CommandRequestDigestV2,
    prepared: &PreparedDirectToolIntent,
    tool_id: ToolIdV2,
    canonical_arguments_digest: CanonicalArgumentsDigestV2,
    tool_contract_digest: ToolContractDigestV2,
    identity: &ToolAttemptIdentityV2,
    targets: &[(ResourceId, ResolvedTarget)],
    reply: ToolIntentSubmitReplyV2,
) -> Vec<KernelFactDraftV2> {
    let mut drafts = vec![
        command_receipt_draft(
            command_fact_id.clone(),
            identity.run_id.clone(),
            exact_epoch(identity.control_epoch),
            request_id,
            request_digest,
            MutationCommandKindV2::ToolIntentSubmit,
            MutationCommandResultV2::ToolIntentSubmission { reply },
        ),
        fact_draft(
            admitted_fact_id.clone(),
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolIntentAdmitted {
                identity: caused_direct_attempt(identity, command_fact_id),
                tool_id,
                canonical_arguments_digest,
                tool_contract_digest,
                resource_scope: prepared.resource_scope.clone(),
                workspace_binding_digest: prepared.workspace_binding_digest.clone(),
                effective_deadline_ms: prepared.effective_deadline_ms,
            }),
        ),
        fact_draft(
            attempt_fact_id.clone(),
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolAttemptPrepared {
                identity: caused_direct_attempt(identity, admitted_fact_id),
            }),
        ),
    ];
    drafts.extend(resource_fact_ids.into_iter().zip(targets).map(
        |(fact_id, (resource_id, target))| {
            fact_draft(
                fact_id,
                KernelFactPayloadV2::Resource(ResourceFactV2::ResolvedForInvocation {
                    identity: ResourceResolvedIdentityV2 {
                        run_id: identity.run_id.clone(),
                        control_epoch: identity.control_epoch,
                        operation_id: identity.operation_id.clone(),
                        invocation_id: identity.invocation_id.clone(),
                        resource_id: resource_id.clone(),
                        idempotency_key_hash: identity.idempotency_key_hash.clone(),
                        causation_fact_id: attempt_fact_id.clone(),
                        correlation_set: identity.correlation_set.clone(),
                    },
                    resource: target.public_resource.clone(),
                }),
            )
        },
    ));
    drafts
}

#[allow(clippy::too_many_arguments)]
pub(super) fn direct_tool_intent_continuation_drafts(
    authorization_fact_id: FactId,
    authorization: AuthorizationFactV2,
    admitted_fact_id: FactId,
    attempt_fact_id: FactId,
    resource_fact_ids: Vec<FactId>,
    prepared: &PreparedDirectToolIntent,
    tool_id: ToolIdV2,
    canonical_arguments_digest: CanonicalArgumentsDigestV2,
    tool_contract_digest: ToolContractDigestV2,
    identity: &ToolAttemptIdentityV2,
    targets: &[(ResourceId, ResolvedTarget)],
) -> Vec<KernelFactDraftV2> {
    let mut drafts = vec![
        fact_draft(
            authorization_fact_id.clone(),
            KernelFactPayloadV2::Authorization(authorization),
        ),
        fact_draft(
            admitted_fact_id.clone(),
            KernelFactPayloadV2::Invocation(
                InvocationFactV2::ToolIntentAdmitted {
                    identity: caused_direct_attempt(
                        identity,
                        authorization_fact_id,
                    ),
                    tool_id,
                    canonical_arguments_digest,
                    tool_contract_digest,
                    resource_scope: prepared.resource_scope.clone(),
                    workspace_binding_digest: prepared
                        .workspace_binding_digest
                        .clone(),
                    effective_deadline_ms: prepared.effective_deadline_ms,
                },
            ),
        ),
        fact_draft(
            attempt_fact_id.clone(),
            KernelFactPayloadV2::Invocation(
                InvocationFactV2::ToolAttemptPrepared {
                    identity: caused_direct_attempt(
                        identity,
                        admitted_fact_id,
                    ),
                },
            ),
        ),
    ];
    drafts.extend(resource_fact_ids.into_iter().zip(targets).map(
        |(fact_id, (resource_id, target))| {
            fact_draft(
                fact_id,
                KernelFactPayloadV2::Resource(
                    ResourceFactV2::ResolvedForInvocation {
                        identity: ResourceResolvedIdentityV2 {
                            run_id: identity.run_id.clone(),
                            control_epoch: identity.control_epoch,
                            operation_id: identity.operation_id.clone(),
                            invocation_id: identity.invocation_id.clone(),
                            resource_id: resource_id.clone(),
                            idempotency_key_hash: identity
                                .idempotency_key_hash
                                .clone(),
                            causation_fact_id: attempt_fact_id.clone(),
                            correlation_set: identity.correlation_set.clone(),
                        },
                        resource: target.public_resource.clone(),
                    },
                ),
            )
        },
    ));
    drafts
}

#[allow(clippy::too_many_arguments)]
pub(super) fn epoch_advance_drafts(
    request_id: CommandRequestId,
    request_digest: CommandRequestDigestV2,
    command: ControlEpochAdvanceV2,
    epoch_context: CommandEpochContextV2,
    previous_epoch: Option<ControlEpoch>,
    new_epoch: ControlEpoch,
    command_fact_id: FactId,
    epoch_fact_id: FactId,
    superseded: Vec<(GrantRecord, FactId)>,
    cancellation: Option<(InvocationId, CancelRequestId, FactId)>,
    reply: ControlEpochAdvancedReplyV2,
) -> Vec<KernelFactDraftV2> {
    let mut drafts = vec![
        command_receipt_draft(
            command_fact_id.clone(),
            command.run_id.clone(),
            epoch_context,
            request_id,
            request_digest,
            MutationCommandKindV2::ControlEpochAdvance,
            MutationCommandResultV2::EpochAdvance { reply },
        ),
        fact_draft(
            epoch_fact_id.clone(),
            KernelFactPayloadV2::Control(ControlFactV2::EpochAdvanced {
                identity: TransitionIdentityV2 {
                    run_id: command.run_id.clone(),
                    control_epoch: new_epoch,
                    causation_fact_id: command_fact_id,
                },
                input_id: command.input_id,
                previous_epoch,
                opaque_input_ref: command.opaque_input_ref,
            }),
        ),
    ];
    drafts.extend(superseded.into_iter().map(|(grant, fact_id)| {
        fact_draft(
            fact_id,
            KernelFactPayloadV2::Grant(GrantFactV2::Superseded {
                identity: grant_lifecycle_identity(grant, epoch_fact_id.clone()),
                cause: GrantSupersessionCauseV2::EpochAdvance { new_epoch },
            }),
        )
    }));
    if let Some((invocation_id, cancel_request_id, fact_id)) = cancellation {
        drafts.push(fact_draft(
            fact_id,
            KernelFactPayloadV2::Control(ControlFactV2::CancellationRequested {
                identity: CancellationIdentityV2 {
                    run_id: command.run_id,
                    control_epoch: new_epoch,
                    invocation_id,
                    cancel_request_id,
                    causation_fact_id: epoch_fact_id,
                },
                source: CancellationSourceV2::EpochAdvance,
                reason_code: CancellationReasonCodeV2::EpochSuperseded,
                reason: None,
            }),
        ));
    }
    drafts
}

pub(super) fn grant_revocation_drafts(
    request_id: CommandRequestId,
    request_digest: CommandRequestDigestV2,
    command: GrantRevokeV2,
    current_epoch: ControlEpoch,
    command_fact_id: FactId,
    revocation_fact_id: FactId,
    grant: GrantRecord,
    reply: GrantRevokedReplyV2,
) -> Vec<KernelFactDraftV2> {
    vec![
        command_receipt_draft(
            command_fact_id.clone(),
            command.run_id,
            exact_epoch(current_epoch),
            request_id,
            request_digest,
            MutationCommandKindV2::GrantRevoke,
            MutationCommandResultV2::GrantRevoke { reply },
        ),
        fact_draft(
            revocation_fact_id,
            KernelFactPayloadV2::Grant(GrantFactV2::Revoked {
                identity: grant_lifecycle_identity(grant, command_fact_id),
                reason_code: command.reason_code,
                reason: command.reason,
            }),
        ),
    ]
}

pub(super) fn explicit_cancellation_drafts(
    request_id: CommandRequestId,
    request_digest: CommandRequestDigestV2,
    command: InvocationCancelV2,
    current_epoch: ControlEpoch,
    invocation_id: InvocationId,
    cancel_request_id: CancelRequestId,
    command_fact_id: FactId,
    cancellation_fact_id: FactId,
    reply: InvocationCancelReplyV2,
) -> Vec<KernelFactDraftV2> {
    vec![
        command_receipt_draft(
            command_fact_id.clone(),
            command.run_id.clone(),
            exact_epoch(current_epoch),
            request_id,
            request_digest,
            MutationCommandKindV2::InvocationCancel,
            MutationCommandResultV2::InvocationCancel { reply },
        ),
        fact_draft(
            cancellation_fact_id,
            KernelFactPayloadV2::Control(ControlFactV2::CancellationRequested {
                identity: CancellationIdentityV2 {
                    run_id: command.run_id,
                    control_epoch: current_epoch,
                    invocation_id,
                    cancel_request_id,
                    causation_fact_id: command_fact_id,
                },
                source: CancellationSourceV2::ExplicitCommand,
                reason_code: command.reason_code,
                reason: command.reason,
            }),
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run_termination_drafts(
    request_id: CommandRequestId,
    request_digest: CommandRequestDigestV2,
    command: RunTerminateV2,
    current_epoch: ControlEpoch,
    command_fact_id: FactId,
    termination_fact_id: FactId,
    superseded: Vec<(GrantRecord, FactId)>,
    cancellation: Option<(InvocationId, CancelRequestId, FactId)>,
    reply: RunTerminatedReplyV2,
) -> Vec<KernelFactDraftV2> {
    let mut drafts = vec![
        command_receipt_draft(
            command_fact_id.clone(),
            command.run_id.clone(),
            exact_epoch(current_epoch),
            request_id,
            request_digest,
            MutationCommandKindV2::RunTerminate,
            MutationCommandResultV2::RunTerminate { reply },
        ),
        fact_draft(
            termination_fact_id.clone(),
            KernelFactPayloadV2::Control(ControlFactV2::RunTerminated {
                identity: TransitionIdentityV2 {
                    run_id: command.run_id.clone(),
                    control_epoch: current_epoch,
                    causation_fact_id: command_fact_id,
                },
                reason_code: command.reason_code,
                reason: command.reason,
            }),
        ),
    ];
    drafts.extend(
        superseded
            .into_iter()
            .map(|(grant, fact_id)| KernelFactDraftV2 {
                fact_id,
                payload: KernelFactPayloadV2::Grant(GrantFactV2::Superseded {
                    identity: grant_lifecycle_identity(grant, termination_fact_id.clone()),
                    cause: GrantSupersessionCauseV2::RunTermination {
                        terminated_at_epoch: current_epoch,
                    },
                }),
            }),
    );
    if let Some((invocation_id, cancel_request_id, fact_id)) = cancellation {
        drafts.push(fact_draft(
            fact_id,
            KernelFactPayloadV2::Control(ControlFactV2::CancellationRequested {
                identity: CancellationIdentityV2 {
                    run_id: command.run_id,
                    control_epoch: current_epoch,
                    invocation_id,
                    cancel_request_id,
                    causation_fact_id: termination_fact_id,
                },
                source: CancellationSourceV2::RunTermination,
                reason_code: CancellationReasonCodeV2::RunTerminated,
                reason: None,
            }),
        ));
    }
    drafts
}

fn grant_lifecycle_identity(
    grant: GrantRecord,
    causation_fact_id: FactId,
) -> GrantLifecycleIdentityV2 {
    GrantLifecycleIdentityV2 {
        run_id: grant.run_id,
        grant_epoch: grant.grant_epoch,
        issuance_operation_id: grant.issuance_operation_id,
        grant_id: grant.grant_id,
        causation_fact_id,
    }
}

fn apply_fact_predicate(filter: &mut FactQueryV2, predicate: &KernelFactPredicateV2) {
    use KernelFactPredicateV2 as Predicate;
    match predicate {
        Predicate::Run { run_id } => filter.run_id = Some(run_id.to_string()),
        Predicate::Operation {
            run_id,
            operation_id,
        } => {
            filter.run_id = Some(run_id.to_string());
            filter.operation_id = Some(operation_id.to_string());
        }
        Predicate::Invocation {
            run_id,
            invocation_id,
        } => {
            filter.run_id = Some(run_id.to_string());
            filter.invocation_id = Some(invocation_id.to_string());
        }
        Predicate::Attempt { run_id, attempt_id } => {
            filter.run_id = Some(run_id.to_string());
            filter.attempt_id = Some(attempt_id.to_string());
        }
        Predicate::Grant { run_id, grant_id } => {
            filter.run_id = Some(run_id.to_string());
            filter.grant_id = Some(grant_id.to_string());
        }
        Predicate::Reservation {
            run_id,
            reservation_id,
        } => {
            filter.run_id = Some(run_id.to_string());
            filter.grant_reservation_id = Some(reservation_id.to_string());
        }
        Predicate::Resource {
            run_id,
            resource_id,
        } => {
            filter.run_id = Some(run_id.to_string());
            filter.resource_id = Some(resource_id.to_string());
        }
        Predicate::Command { command_request_id } => {
            filter.command_request_id = Some(command_request_id.to_string())
        }
        Predicate::Fact { fact_id } => filter.fact_id = Some(fact_id.to_string()),
        Predicate::Causation { causation_fact_id } => {
            filter.causation_id = Some(causation_fact_id.to_string())
        }
        Predicate::Idempotency {
            run_id,
            idempotency_key_hash,
        } => {
            filter.run_id = Some(run_id.to_string());
            filter.idempotency_key_hash = Some(idempotency_key_hash.as_str().to_owned());
        }
        Predicate::Correlation(correlation) => {
            let (kind, value) = correlation.sort_key();
            filter.correlation_ref = Some((kind.to_owned(), value.to_owned()));
        }
    }
}

pub(super) fn fact_query(command: &KernelFactsQueryV2) -> FactQueryV2 {
    let mut filter = FactQueryV2 {
        after_ledger_sequence: Some(command.page.after_ledger_sequence),
        limit: Some(command.page.limit.saturating_add(1)),
        ..Default::default()
    };
    if let KernelFactFilterV2::MatchAll { predicates } = &command.filter {
        for predicate in predicates {
            apply_fact_predicate(&mut filter, predicate);
        }
    }
    filter
}

pub(super) fn bounded_fact_page(
    requested_after: u64,
    high_water: u64,
    mut facts: Vec<KernelFactEnvelopeV2>,
    requested_limit: usize,
) -> AuthorityResult<KernelFactPageV2> {
    let mut has_more = facts.len() > requested_limit;
    facts.truncate(requested_limit);
    loop {
        let final_sequence = facts
            .last()
            .map(|fact| fact.ledger_sequence)
            .unwrap_or(requested_after);
        let continuation = if has_more {
            FactPageContinuationV2::More {
                after_ledger_sequence: final_sequence,
            }
        } else {
            FactPageContinuationV2::CaughtUp {
                at_ledger_sequence: high_water,
            }
        };
        let page = KernelFactPageV2 {
            requested_after_ledger_sequence: requested_after,
            ledger_sequence_high_water: high_water,
            facts,
            continuation,
        };
        if serde_json::to_vec(&page)
            .map_err(|_| corrupt_store())?
            .len()
            <= MAX_FACT_PAGE_BYTES_V2
        {
            page.validate().map_err(|_| corrupt_store())?;
            return Ok(page);
        }
        facts = page.facts;
        if facts.pop().is_none() {
            return Err(corrupt_store());
        }
        has_more = true;
    }
}

fn resource_projection_reply(
    resource: &ResourceRecord,
    as_of_ledger_sequence: u64,
) -> ResourceResolveReplyV2 {
    let observation = match &resource.revalidation {
        Some((fact_id, digest, observation)) => ResourceProjectionObservationV2::Revalidated {
            source_fact_id: fact_id.clone(),
            target_revalidation_digest: digest.clone(),
            observation: observation.clone(),
        },
        None => ResourceProjectionObservationV2::Resolution {
            source_fact_id: resource.resolution_fact_id.clone(),
            observation: match &resource.resolved {
                ResolvedResourceV2::Workspace {
                    resolution_state_digest,
                    ..
                } => ResolutionObservationV2::WorkspaceState {
                    digest: resolution_state_digest.clone(),
                },
                ResolvedResourceV2::NetworkQuery {
                    query_digest,
                    target_observation_digest,
                    ..
                } => ResolutionObservationV2::NetworkQuery {
                    query_digest: query_digest.clone(),
                    target_digest: target_observation_digest.clone(),
                },
                ResolvedResourceV2::NetworkEndpoint {
                    target_observation_digest,
                    ..
                } => ResolutionObservationV2::NetworkTarget {
                    digest: target_observation_digest.clone(),
                },
            },
        },
    };
    let lifecycle = ResourceLifecycleV2::Resolved {};
    match &resource.resolved {
        ResolvedResourceV2::Workspace {
            object_kind,
            relative_path,
            ..
        } => ResourceResolveReplyV2::Workspace {
            resource_id: resource.resource_id.clone(),
            invocation_id: resource.invocation_id.clone(),
            relative_path: relative_path.clone(),
            object_kind: *object_kind,
            observation,
            lifecycle,
            last_fact_id: resource.last_fact_id.clone(),
            as_of_ledger_sequence,
        },
        ResolvedResourceV2::NetworkQuery {
            query_digest,
            service_origin,
            ..
        } => ResourceResolveReplyV2::NetworkQuery {
            resource_id: resource.resource_id.clone(),
            invocation_id: resource.invocation_id.clone(),
            query_digest: query_digest.clone(),
            service_origin: service_origin.clone(),
            observation,
            lifecycle,
            last_fact_id: resource.last_fact_id.clone(),
            as_of_ledger_sequence,
        },
        ResolvedResourceV2::NetworkEndpoint { origin, .. } => {
            ResourceResolveReplyV2::NetworkEndpoint {
                resource_id: resource.resource_id.clone(),
                invocation_id: resource.invocation_id.clone(),
                origin: origin.clone(),
                observation,
                lifecycle,
                last_fact_id: resource.last_fact_id.clone(),
                as_of_ledger_sequence,
            }
        }
    }
}

pub(super) fn resource_resolve_reply(
    state: &AuthorityState,
    command: &ResourceResolveV2,
    as_of_ledger_sequence: u64,
) -> AuthorityResult<ResourceResolveReplyV2> {
    let resource = state
        .resources
        .get(&command.resource_id)
        .filter(|resource| resource.run_id == command.run_id)
        .ok_or_else(|| KernelErrorV2::ResourceNotFound {
            run_id: command.run_id.clone(),
            resource_id: command.resource_id.clone(),
        })?;
    Ok(resource_projection_reply(resource, as_of_ledger_sequence))
}

pub(super) fn invocation_status_reply(
    state: &AuthorityState,
    run_id: &RunId,
    invocation_id: &InvocationId,
    ledger_sequence_high_water: u64,
) -> AuthorityResult<InvocationStatusReplyV2> {
    let invocation =
        state
            .invocations
            .get(invocation_id)
            .ok_or_else(|| KernelErrorV2::InvocationNotFound {
                run_id: run_id.clone(),
                invocation_id: invocation_id.clone(),
            })?;
    if &invocation.run_id != run_id {
        return Err(KernelErrorV2::InvocationNotOwnedByRun {
            run_id: run_id.clone(),
            invocation_id: invocation_id.clone(),
        });
    }
    Ok(InvocationStatusReplyV2 {
        identity: InvocationStatusIdentityV2 {
            run_id: invocation.run_id.clone(),
            operation_id: invocation.operation_id.clone(),
            control_epoch: invocation.control_epoch,
            invocation_id: invocation.invocation_id.clone(),
            attempt_id: invocation.attempt_id.clone(),
        },
        phase: invocation.phase,
        stop_overlay: invocation.stop_overlay.wire(),
        latest_fact_id: invocation.last_fact_id.clone(),
        ledger_sequence_high_water,
    })
}

pub(super) fn require_current_run(
    state: &AuthorityState,
    run_id: &RunId,
    submitted: ControlEpoch,
) -> AuthorityResult<()> {
    let run = state
        .runs
        .get(run_id)
        .ok_or_else(|| KernelErrorV2::RunNotFound {
            run_id: run_id.clone(),
        })?;
    if run.epoch != submitted {
        return Err(KernelErrorV2::StaleControlEpoch {
            run_id: run_id.clone(),
            submitted,
            current: run.epoch,
        });
    }
    if matches!(run.lifecycle, RunLifecycle::Terminated { .. }) {
        return Err(KernelErrorV2::RunTerminated {
            run_id: run_id.clone(),
            control_epoch: run.epoch,
        });
    }
    Ok(())
}

pub(super) fn require_input_in_epoch(
    state: &AuthorityState,
    run_id: &RunId,
    epoch: ControlEpoch,
    input_id: &InputId,
) -> AuthorityResult<()> {
    if state
        .runs
        .get(run_id)
        .and_then(|run| run.admitted_inputs.get(input_id))
        != Some(&epoch)
    {
        return Err(KernelErrorV2::InvalidRequest {
            reason: InvalidRequestReasonV2::InvalidRelation {
                relation: InvalidRelationV2::DecisionInputNotInEpoch,
            },
        });
    }
    Ok(())
}

pub(super) fn recovery_drafts(
    state: &AuthorityState,
    mut fact_id: impl FnMut() -> FactId,
    mut effect_id: impl FnMut() -> EffectId,
) -> AuthorityResult<Vec<KernelFactDraftV2>> {
    let open = state
        .invocations
        .values()
        .filter(|invocation| !invocation_phase_is_terminal(invocation.phase))
        .cloned()
        .collect::<Vec<_>>();
    let mut drafts = Vec::new();
    for invocation in open {
        let identity = AttemptIdentityV2 {
            run_id: invocation.run_id.clone(),
            control_epoch: invocation.control_epoch,
            operation_id: invocation.operation_id.clone(),
            grant_id: invocation.grant_id.clone(),
            reservation_id: invocation.reservation_id.clone(),
            invocation_id: invocation.invocation_id.clone(),
            attempt_id: invocation.attempt_id.clone(),
            idempotency_key_hash: invocation.idempotency_key_hash.clone(),
            causation_fact_id: invocation.admission_fact_id.clone(),
            correlation_set: invocation.correlations.clone(),
        };
        match invocation.phase {
            InvocationPhase::AttemptPrepared => {
                let attempt_fact_id = invocation
                    .attempt_prepared_fact_id
                    .as_ref()
                    .ok_or_else(corrupt_store)?;
                if let Some((cancel_request_id, cancellation_fact_id, _)) =
                    invocation.stop_overlay.cancellation()
                {
                    drafts.extend(pre_effect_stop_drafts(
                        &identity,
                        fact_id(),
                        fact_id(),
                        fact_id(),
                        Some((cancel_request_id, cancellation_fact_id)),
                    ));
                } else if invocation.stop_overlay.deadline_observed() {
                    drafts.extend(pre_effect_stop_drafts(
                        &identity,
                        fact_id(),
                        fact_id(),
                        fact_id(),
                        None,
                    ));
                } else {
                    drafts.extend(failed_before_effect_drafts(
                        &identity,
                        attempt_fact_id,
                        fact_id(),
                        fact_id(),
                        PreEffectFailureCodeV2::TargetRevalidationFailed,
                    ));
                }
            }
            InvocationPhase::Executing => {
                let execution_started_fact_id = invocation
                    .execution_started_fact_id
                    .as_ref()
                    .ok_or_else(corrupt_store)?;
                let possible_resources = state
                    .resources
                    .values()
                    .filter(|resource| {
                        resource.invocation_id == invocation.invocation_id
                            && resource.revalidation.is_some()
                    })
                    .map(|resource| resource.resource_id.clone())
                    .collect();
                drafts.extend(execution_result_drafts(
                    &identity,
                    execution_started_fact_id,
                    effect_id(),
                    fact_id(),
                    fact_id(),
                    possible_resources,
                    ExecutionResolution::Indeterminate {
                        evidence: EffectEvidenceV2::IndeterminateReadBack {
                            last_observation: LastObservationV2::None {},
                        },
                        reason_code: IndeterminateReasonV2::RecoveryEvidenceInsufficient,
                    },
                    invocation
                        .stop_overlay
                        .cancellation()
                        .map(|(request_id, _, _)| request_id),
                    invocation.stop_overlay.deadline_observed(),
                )?);
            }
            _ => return Err(corrupt_store()),
        }
    }
    Ok(drafts)
}

impl AuthorityState {
    pub(super) fn restore(facts: Vec<KernelFactEnvelopeV2>) -> AuthorityResult<Self> {
        let mut state = Self::default();
        for envelope in facts {
            state.apply_fact(envelope)?;
        }
        Ok(state)
    }

    pub(super) fn apply_committed(
        &mut self,
        facts: Vec<KernelFactEnvelopeV2>,
    ) -> AuthorityResult<()> {
        let mut next = self.clone();
        for fact in facts {
            next.apply_fact(fact)?;
        }
        *self = next;
        Ok(())
    }

    fn apply_fact(&mut self, envelope: KernelFactEnvelopeV2) -> AuthorityResult<()> {
        if self.facts_by_id.contains_key(&envelope.fact_id) {
            return Err(corrupt_store());
        }
        validate_causation(self, &envelope)?;
        match &envelope.payload {
            KernelFactPayloadV2::Control(fact) => self.reduce_control(&envelope, fact)?,
            KernelFactPayloadV2::Authorization(_) => {}
            KernelFactPayloadV2::Grant(fact) => self.reduce_grant(&envelope, fact)?,
            KernelFactPayloadV2::Invocation(fact) => self.reduce_invocation(&envelope, fact)?,
            KernelFactPayloadV2::Effect(fact) => self.reduce_effect(&envelope, fact)?,
            KernelFactPayloadV2::Resource(fact) => self.reduce_resource(&envelope, fact)?,
            KernelFactPayloadV2::Cleanup(_) => return Err(corrupt_store()),
        }
        self.facts_by_id.insert(envelope.fact_id.clone(), envelope);
        Ok(())
    }

    fn reduce_control(
        &mut self,
        envelope: &KernelFactEnvelopeV2,
        fact: &ControlFactV2,
    ) -> AuthorityResult<()> {
        match fact {
            ControlFactV2::RunOpened {
                run_id,
                control_epoch,
                ..
            } => {
                let run = self.runs.get(run_id).ok_or_else(corrupt_store)?;
                if run.epoch != *control_epoch
                    || self.facts_by_id.values().any(|existing| {
                        matches!(
                            &existing.payload,
                            KernelFactPayloadV2::Control(ControlFactV2::RunOpened {
                                run_id: existing_run_id,
                                ..
                            }) if existing_run_id == run_id
                        )
                    })
                {
                    return Err(corrupt_store());
                }
            }
            ControlFactV2::CommandRecorded {
                identity, result, ..
            } => {
                let reply = reply_from_recorded_result(result.clone());
                if self
                    .commands
                    .insert(
                        identity.command_request_identity.command_request_id.clone(),
                        CommandReplay {
                            digest: identity
                                .command_request_identity
                                .command_request_digest
                                .clone(),
                            reply,
                        },
                    )
                    .is_some()
                {
                    return Err(corrupt_store());
                }
            }
            ControlFactV2::EpochAdvanced {
                identity,
                input_id,
                previous_epoch,
                ..
            } => match self.runs.get_mut(&identity.run_id) {
                None if previous_epoch.is_none() && identity.control_epoch.get() == 1 => {
                    let mut admitted_inputs = HashMap::new();
                    admitted_inputs.insert(input_id.clone(), identity.control_epoch);
                    self.runs.insert(
                        identity.run_id.clone(),
                        RunRecord {
                            epoch: identity.control_epoch,
                            lifecycle: RunLifecycle::Active,
                            active_invocation_id: None,
                            admitted_inputs,
                        },
                    );
                }
                Some(run)
                    if matches!(run.lifecycle, RunLifecycle::Active)
                        && *previous_epoch == Some(run.epoch)
                        && identity.control_epoch.get() == run.epoch.get() + 1 =>
                {
                    run.epoch = identity.control_epoch;
                    run.admitted_inputs
                        .insert(input_id.clone(), identity.control_epoch);
                }
                _ => return Err(corrupt_store()),
            },
            ControlFactV2::CancellationRequested {
                identity, source, ..
            } => {
                let legacy = self.invocations.get(&identity.invocation_id);
                let direct = self.direct_invocations.get(&identity.invocation_id);
                let (invocation_run_id, invocation_epoch) = match (legacy, direct) {
                    (Some(invocation), None) => {
                        (&invocation.run_id, invocation.control_epoch)
                    }
                    (None, Some(invocation)) => {
                        (&invocation.run_id, invocation.control_epoch)
                    }
                    _ => return Err(corrupt_store()),
                };
                let epoch_matches = match source {
                    CancellationSourceV2::EpochAdvance => {
                        identity.control_epoch > invocation_epoch
                    }
                    CancellationSourceV2::ExplicitCommand
                    | CancellationSourceV2::RunTermination => {
                        identity.control_epoch == invocation_epoch
                    }
                };
                if &identity.run_id != invocation_run_id
                    || !epoch_matches
                    || self
                        .invocations
                        .values()
                        .any(|candidate| {
                            candidate
                                .stop_overlay
                                .cancellation()
                                .is_some_and(|(request_id, _, _)| {
                                    request_id == &identity.cancel_request_id
                                })
                        })
                    || self
                        .direct_invocations
                        .values()
                        .any(|candidate| {
                            candidate
                                .stop_overlay
                                .cancellation()
                                .is_some_and(|(request_id, _, _)| {
                                    request_id == &identity.cancel_request_id
                                })
                        })
                    || self
                        .runs
                        .get(&identity.run_id)
                        .and_then(|run| run.active_invocation_id.as_ref())
                        != Some(&identity.invocation_id)
                {
                    return Err(corrupt_store());
                }
                let overlay = if let Some(invocation) =
                    self.invocations.get_mut(&identity.invocation_id)
                {
                    &mut invocation.stop_overlay
                } else {
                    &mut self
                        .direct_invocations
                        .get_mut(&identity.invocation_id)
                        .ok_or_else(corrupt_store)?
                        .stop_overlay
                };
                if overlay.cancellation().is_some() {
                    return Err(corrupt_store());
                }
                *overlay = StopOverlay::CancellationRequested {
                    cancel_request_id: identity.cancel_request_id.clone(),
                    fact_id: envelope.fact_id.clone(),
                    ledger_sequence: envelope.ledger_sequence,
                };
            }
            ControlFactV2::RunTerminated { identity, .. } => {
                let run = self
                    .runs
                    .get_mut(&identity.run_id)
                    .ok_or_else(corrupt_store)?;
                if run.epoch != identity.control_epoch
                    || !matches!(run.lifecycle, RunLifecycle::Active)
                {
                    return Err(corrupt_store());
                }
                run.lifecycle = RunLifecycle::Terminated {
                    fact_id: envelope.fact_id.clone(),
                    ledger_sequence: envelope.ledger_sequence,
                };
            }
        }
        Ok(())
    }

    fn reduce_grant(
        &mut self,
        envelope: &KernelFactEnvelopeV2,
        fact: &GrantFactV2,
    ) -> AuthorityResult<()> {
        match fact {
            GrantFactV2::Issued {
                identity,
                tool_id,
                issuance_authorization_digest,
                grant_decision_digest,
                grant_scope_digest,
                resource_scope,
                effect_scope,
                risk,
                use_policy,
                decision_basis,
            } => {
                let run = self.runs.get(&identity.run_id).ok_or_else(corrupt_store)?;
                let decision_input_valid = match decision_basis {
                    GrantDecisionBasisV2::AutomaticPolicy { .. } => true,
                    GrantDecisionBasisV2::UserDecision { input_id, .. } => {
                        run.admitted_inputs.get(input_id) == Some(&identity.grant_epoch)
                    }
                };
                if run.epoch != identity.grant_epoch
                    || !matches!(run.lifecycle, RunLifecycle::Active)
                    || !decision_input_valid
                    || *use_policy != GrantUsePolicyV2::UnboundedWithinEpoch
                    || self.grants.contains_key(&identity.grant_id)
                {
                    return Err(corrupt_store());
                }
                let replay_key = grant_decision_key(
                    &identity.run_id,
                    &identity.issuance_operation_id,
                    identity.grant_epoch,
                    issuance_authorization_digest,
                    decision_basis,
                )?;
                let replay = GrantDecisionReplay {
                    digest: grant_decision_digest.clone(),
                    reply: GrantDecisionReplyV2::Issued {
                        grant_id: identity.grant_id.clone(),
                        fact_id: envelope.fact_id.clone(),
                        ledger_sequence: envelope.ledger_sequence,
                    },
                };
                if self.grant_decisions.insert(replay_key, replay).is_some() {
                    return Err(corrupt_store());
                }
                self.grants.insert(
                    identity.grant_id.clone(),
                    GrantRecord {
                        run_id: identity.run_id.clone(),
                        grant_epoch: identity.grant_epoch,
                        issuance_operation_id: identity.issuance_operation_id.clone(),
                        grant_id: identity.grant_id.clone(),
                        tool_id: *tool_id,
                        issuance_authorization_digest: issuance_authorization_digest.clone(),
                        grant_scope_digest: grant_scope_digest.clone(),
                        resource_scope: resource_scope.clone(),
                        effect_scope: *effect_scope,
                        risk: *risk,
                        lifecycle: GrantLifecycle::Issued,
                        use_count: 0,
                    },
                );
            }
            GrantFactV2::Denied {
                identity,
                authorization_request_digest,
                grant_decision_digest,
                decision_basis,
                ..
            } => {
                let run = self.runs.get(&identity.run_id).ok_or_else(corrupt_store)?;
                let valid_user_decision = match decision_basis {
                    GrantDecisionBasisV2::UserDecision { input_id, .. } => {
                        run.admitted_inputs.get(input_id) == Some(&identity.control_epoch)
                    }
                    GrantDecisionBasisV2::AutomaticPolicy { .. } => false,
                };
                if run.epoch != identity.control_epoch
                    || !matches!(run.lifecycle, RunLifecycle::Active)
                    || !valid_user_decision
                {
                    return Err(corrupt_store());
                }
                let replay_key = grant_decision_key(
                    &identity.run_id,
                    &identity.operation_id,
                    identity.control_epoch,
                    authorization_request_digest,
                    decision_basis,
                )?;
                let replay = GrantDecisionReplay {
                    digest: grant_decision_digest.clone(),
                    reply: GrantDecisionReplyV2::Denied {
                        fact_id: envelope.fact_id.clone(),
                        ledger_sequence: envelope.ledger_sequence,
                    },
                };
                if self.grant_decisions.insert(replay_key, replay).is_some() {
                    return Err(corrupt_store());
                }
            }
            GrantFactV2::Reserved { identity } => {
                let invocation = self
                    .invocations
                    .get(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if !reservation_identity_matches_invocation(identity, invocation)
                    || self.reservations.contains_key(&identity.reservation_id)
                {
                    return Err(corrupt_store());
                }
                self.reservations.insert(
                    identity.reservation_id.clone(),
                    ReservationRecord {
                        consumed: false,
                        released: false,
                    },
                );
            }
            GrantFactV2::Consumed {
                identity,
                use_count,
                target_revalidation_set_digest,
            } => {
                let invocation = self
                    .invocations
                    .get(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if !attempt_identity_matches_invocation(identity, invocation)
                    || invocation.phase != InvocationPhase::AttemptPrepared
                    || expected_revalidation_set_digest(self, invocation)?
                        != *target_revalidation_set_digest
                {
                    return Err(corrupt_store());
                }
                let reservation = self
                    .reservations
                    .get_mut(&identity.reservation_id)
                    .ok_or_else(corrupt_store)?;
                let grant = self
                    .grants
                    .get_mut(&identity.grant_id)
                    .ok_or_else(corrupt_store)?;
                if reservation.consumed || reservation.released || *use_count != grant.use_count + 1
                {
                    return Err(corrupt_store());
                }
                reservation.consumed = true;
                grant.use_count = *use_count;
            }
            GrantFactV2::ReservationReleased {
                identity,
                reason_code,
            } => {
                let invocation = self
                    .invocations
                    .get(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                let reason_matches = matches!(
                    (reason_code, &invocation.phase),
                    (
                        ReservationReleaseReasonV2::FailedBeforeEffect,
                        InvocationPhase::FailedBeforeEffect
                    ) | (
                        ReservationReleaseReasonV2::CancelledBeforeEffect,
                        InvocationPhase::CancelledBeforeEffect
                    ) | (
                        ReservationReleaseReasonV2::TimedOutBeforeEffect,
                        InvocationPhase::TimedOutBeforeEffect
                    )
                );
                if !reservation_identity_matches_invocation(identity, invocation) || !reason_matches
                {
                    return Err(corrupt_store());
                }
                let reservation = self
                    .reservations
                    .get_mut(&identity.reservation_id)
                    .ok_or_else(corrupt_store)?;
                if reservation.consumed || reservation.released {
                    return Err(corrupt_store());
                }
                reservation.released = true;
            }
            GrantFactV2::Revoked { identity, .. } => {
                let grant = self
                    .grants
                    .get_mut(&identity.grant_id)
                    .ok_or_else(corrupt_store)?;
                if !grant_lifecycle_identity_matches(identity, grant)
                    || !matches!(grant.lifecycle, GrantLifecycle::Issued)
                {
                    return Err(corrupt_store());
                }
                grant.lifecycle = GrantLifecycle::Revoked {
                    fact_id: envelope.fact_id.clone(),
                    ledger_sequence: envelope.ledger_sequence,
                };
            }
            GrantFactV2::Superseded {
                identity, cause, ..
            } => {
                let grant = self
                    .grants
                    .get_mut(&identity.grant_id)
                    .ok_or_else(corrupt_store)?;
                if !grant_lifecycle_identity_matches(identity, grant)
                    || !matches!(grant.lifecycle, GrantLifecycle::Issued)
                {
                    return Err(corrupt_store());
                }
                grant.lifecycle = GrantLifecycle::Superseded {
                    fact_id: envelope.fact_id.clone(),
                    ledger_sequence: envelope.ledger_sequence,
                    cause: cause.clone(),
                };
            }
        }
        Ok(())
    }

    fn reduce_invocation(
        &mut self,
        envelope: &KernelFactEnvelopeV2,
        fact: &InvocationFactV2,
    ) -> AuthorityResult<()> {
        match fact {
            InvocationFactV2::ToolIntentAdmitted {
                identity,
                tool_id,
                resource_scope,
                workspace_binding_digest,
                effective_deadline_ms,
                ..
            } => {
                let run = self.runs.get(&identity.run_id).ok_or_else(corrupt_store)?;
                let legacy_tool_id = legacy_tool_id(tool_id).ok_or_else(corrupt_store)?;
                if run.epoch != identity.control_epoch
                    || !matches!(run.lifecycle, RunLifecycle::Active)
                    || run.active_invocation_id.is_some()
                    || *effective_deadline_ms == 0
                    || self.invocations.contains_key(&identity.invocation_id)
                    || self.direct_invocations.contains_key(&identity.invocation_id)
                    || self
                        .direct_invocations
                        .values()
                        .any(|candidate| candidate.attempt_id == identity.attempt_id)
                {
                    return Err(corrupt_store());
                }
                if let InvocationAuthorityV2::PlanAction {
                    plan_action_id,
                    lease,
                    ..
                } = &identity.authority
                {
                    if !identity.correlation_set.refs.iter().any(|reference| {
                        matches!(
                            reference,
                            deepcode_kernel_abi::v2::CorrelationRefV2::PlanAction { value }
                                if value == plan_action_id.as_str()
                        )
                    }) || lease.scope_digest.as_str().is_empty()
                    {
                        return Err(corrupt_store());
                    }
                }
                self.direct_invocations.insert(
                    identity.invocation_id.clone(),
                    DirectInvocationRecord {
                        run_id: identity.run_id.clone(),
                        operation_id: identity.operation_id.clone(),
                        control_epoch: identity.control_epoch,
                        authority: identity.authority.clone(),
                        invocation_id: identity.invocation_id.clone(),
                        attempt_id: identity.attempt_id.clone(),
                        idempotency_key_hash: identity.idempotency_key_hash.clone(),
                        tool_id: tool_id.clone(),
                        legacy_tool_id,
                        resource_scope: resource_scope.clone(),
                        workspace_binding_digest: workspace_binding_digest.clone(),
                        correlations: identity.correlation_set.clone(),
                        phase: InvocationPhase::AttemptPrepared,
                        stop_overlay: StopOverlay::None,
                        admission_fact_id: envelope.fact_id.clone(),
                        attempt_prepared_fact_id: None,
                        execution_started_fact_id: None,
                        cancellation_observed_fact_id: None,
                        deadline_observed_fact_id: None,
                        last_fact_id: envelope.fact_id.clone(),
                    },
                );
                self.runs
                    .get_mut(&identity.run_id)
                    .ok_or_else(corrupt_store)?
                    .active_invocation_id = Some(identity.invocation_id.clone());
            }
            InvocationFactV2::ToolAttemptPrepared { identity } => {
                let invocation = self
                    .direct_invocations
                    .get_mut(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if !direct_attempt_identity_matches(identity, invocation)
                    || invocation.phase != InvocationPhase::AttemptPrepared
                    || invocation.attempt_prepared_fact_id.is_some()
                {
                    return Err(corrupt_store());
                }
                invocation.attempt_prepared_fact_id = Some(envelope.fact_id.clone());
                invocation.last_fact_id = envelope.fact_id.clone();
            }
            InvocationFactV2::ToolExecutionStarted {
                identity,
                target_revalidation_set_digest,
            } => {
                let expected = {
                    let invocation = self
                        .direct_invocations
                        .get(&identity.invocation_id)
                        .ok_or_else(corrupt_store)?;
                    expected_direct_revalidation_set_digest(self, invocation)?
                };
                let invocation = self
                    .direct_invocations
                    .get_mut(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if !direct_attempt_identity_matches(identity, invocation)
                    || invocation.phase != InvocationPhase::AttemptPrepared
                    || expected != *target_revalidation_set_digest
                {
                    return Err(corrupt_store());
                }
                invocation.phase = InvocationPhase::Executing;
                invocation.execution_started_fact_id = Some(envelope.fact_id.clone());
                invocation.last_fact_id = envelope.fact_id.clone();
            }
            InvocationFactV2::ToolCancellationObserved {
                identity,
                cancel_request_id,
            } => {
                let invocation = self
                    .direct_invocations
                    .get_mut(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if !direct_attempt_identity_matches(identity, invocation)
                    || invocation_phase_is_terminal(invocation.phase)
                    || invocation.cancellation_observed_fact_id.is_some()
                    || invocation
                        .stop_overlay
                        .cancellation()
                        .map(|(request_id, _, _)| request_id)
                        != Some(cancel_request_id)
                {
                    return Err(corrupt_store());
                }
                invocation.cancellation_observed_fact_id = Some(envelope.fact_id.clone());
                invocation.last_fact_id = envelope.fact_id.clone();
            }
            InvocationFactV2::ToolDeadlineObserved { identity } => {
                let invocation = self
                    .direct_invocations
                    .get_mut(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if !direct_attempt_identity_matches(identity, invocation)
                    || invocation_phase_is_terminal(invocation.phase)
                    || invocation.deadline_observed_fact_id.is_some()
                {
                    return Err(corrupt_store());
                }
                invocation.stop_overlay = match invocation.stop_overlay.clone() {
                    StopOverlay::None => StopOverlay::DeadlineObserved {
                        fact_id: envelope.fact_id.clone(),
                    },
                    StopOverlay::CancellationRequested {
                        cancel_request_id,
                        fact_id,
                        ledger_sequence,
                    } => StopOverlay::CancellationAndDeadline {
                        cancel_request_id,
                        cancellation_fact_id: fact_id,
                        cancellation_ledger_sequence: ledger_sequence,
                        deadline_fact_id: envelope.fact_id.clone(),
                    },
                    _ => return Err(corrupt_store()),
                };
                invocation.deadline_observed_fact_id = Some(envelope.fact_id.clone());
                invocation.last_fact_id = envelope.fact_id.clone();
            }
            InvocationFactV2::ToolFailedBeforeEffect { identity, .. } => {
                self.set_direct_attempt_terminal(
                    identity,
                    InvocationPhase::FailedBeforeEffect,
                    envelope.fact_id.clone(),
                )?
            }
            InvocationFactV2::ToolCancelledBeforeEffect {
                identity,
                cancel_request_id,
            } => {
                let invocation = self
                    .direct_invocations
                    .get(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if invocation
                    .stop_overlay
                    .cancellation()
                    .map(|(request_id, _, _)| request_id)
                    != Some(cancel_request_id)
                {
                    return Err(corrupt_store());
                }
                self.set_direct_attempt_terminal(
                    identity,
                    InvocationPhase::CancelledBeforeEffect,
                    envelope.fact_id.clone(),
                )?
            }
            InvocationFactV2::ToolTimedOutBeforeEffect { identity } => {
                self.set_direct_attempt_terminal(
                    identity,
                    InvocationPhase::TimedOutBeforeEffect,
                    envelope.fact_id.clone(),
                )?
            }
            InvocationFactV2::ToolCompleted { identity, output } => {
                validate_direct_completed_output(self, identity, output)?;
                self.set_direct_observed_terminal(
                    identity,
                    InvocationPhase::Completed,
                    envelope.fact_id.clone(),
                )?
            }
            InvocationFactV2::ToolFailedAfterObservedEffect { identity, .. } => {
                self.set_direct_observed_terminal(
                    identity,
                    InvocationPhase::FailedAfterObservedEffect,
                    envelope.fact_id.clone(),
                )?
            }
            InvocationFactV2::ToolIndeterminate {
                identity,
                reason_code,
            } => {
                validate_direct_indeterminate_pair(self, identity, reason_code)?;
                self.set_direct_observed_terminal(
                    identity,
                    InvocationPhase::Indeterminate,
                    envelope.fact_id.clone(),
                )?
            }
            InvocationFactV2::Admitted {
                identity,
                tool_id,
                submission_digest,
                invocation_digest: _,
                grant_scope_digest,
                grant_issuance_authorization_digest,
                tool_contract_digest: _,
                workspace_binding_digest,
                effective_deadline_ms,
            } => {
                let run = self.runs.get(&identity.run_id).ok_or_else(corrupt_store)?;
                let grant = self
                    .grants
                    .get(&identity.grant_id)
                    .ok_or_else(corrupt_store)?;
                if run.epoch != identity.control_epoch
                    || !matches!(run.lifecycle, RunLifecycle::Active)
                    || run.active_invocation_id.is_some()
                    || grant.run_id != identity.run_id
                    || grant.grant_epoch != identity.control_epoch
                    || !matches!(grant.lifecycle, GrantLifecycle::Issued)
                    || grant.tool_id != *tool_id
                    || grant.grant_scope_digest != *grant_scope_digest
                    || grant.issuance_authorization_digest != *grant_issuance_authorization_digest
                    || *effective_deadline_ms == 0
                    || self.invocations.contains_key(&identity.invocation_id)
                    || self.invocations.values().any(|candidate| {
                        candidate.attempt_id == identity.attempt_id
                            || candidate.reservation_id == identity.reservation_id
                    })
                {
                    return Err(corrupt_store());
                }
                let reply = submission_reply_from_cause(self, &identity.causation_fact_id)?;
                self.apply_submission_binding(
                    &identity.run_id,
                    &identity.operation_id,
                    &identity.idempotency_key_hash,
                    submission_digest,
                    reply,
                    false,
                )?;
                self.invocations.insert(
                    identity.invocation_id.clone(),
                    InvocationRecord {
                        run_id: identity.run_id.clone(),
                        operation_id: identity.operation_id.clone(),
                        control_epoch: identity.control_epoch,
                        grant_id: identity.grant_id.clone(),
                        reservation_id: identity.reservation_id.clone(),
                        invocation_id: identity.invocation_id.clone(),
                        attempt_id: identity.attempt_id.clone(),
                        idempotency_key_hash: identity.idempotency_key_hash.clone(),
                        tool_id: *tool_id,
                        workspace_binding_digest: workspace_binding_digest.clone(),
                        correlations: identity.correlation_set.clone(),
                        phase: InvocationPhase::AttemptPrepared,
                        stop_overlay: StopOverlay::None,
                        admission_fact_id: envelope.fact_id.clone(),
                        attempt_prepared_fact_id: None,
                        execution_started_fact_id: None,
                        cancellation_observed_fact_id: None,
                        deadline_observed_fact_id: None,
                        last_fact_id: envelope.fact_id.clone(),
                    },
                );
                let run = self
                    .runs
                    .get_mut(&identity.run_id)
                    .ok_or_else(corrupt_store)?;
                run.active_invocation_id = Some(identity.invocation_id.clone());
            }
            InvocationFactV2::Rejected {
                identity,
                tool_id,
                submission_digest,
                rejection,
            } => {
                let run = self.runs.get(&identity.run_id).ok_or_else(corrupt_store)?;
                let rejection_valid = match rejection {
                    AdmissionRejectionV2::ToolExecutionUnavailable {
                        tool_id: rejected_tool,
                        availability,
                    } => {
                        rejected_tool == tool_id
                            && *availability == ExecutionAvailabilityV4::Blocked
                    }
                    AdmissionRejectionV2::StaleControlEpoch { current, .. } => {
                        *current == identity.current_control_epoch
                    }
                    AdmissionRejectionV2::RunBusy {
                        active_invocation_id,
                        retry_after_ms,
                    } => {
                        *retry_after_ms == 100
                            && run.active_invocation_id.as_ref() == Some(active_invocation_id)
                    }
                    AdmissionRejectionV2::CapacityExceeded {
                        maximum_active_runs,
                        retry_after_ms,
                    } => *maximum_active_runs == 4 && *retry_after_ms == 100,
                    AdmissionRejectionV2::RunTerminated {} => {
                        matches!(run.lifecycle, RunLifecycle::Terminated { .. })
                    }
                    _ => true,
                };
                if run.epoch != identity.current_control_epoch || !rejection_valid {
                    return Err(corrupt_store());
                }
                if !matches!(
                    rejection,
                    AdmissionRejectionV2::DuplicateOperationDigestMismatch { .. }
                        | AdmissionRejectionV2::OperationIdempotencyPairMismatch { .. }
                ) {
                    let reply = submission_reply_from_cause(self, &identity.causation_fact_id)?;
                    self.apply_submission_binding(
                        &identity.run_id,
                        &identity.operation_id,
                        &identity.idempotency_key_hash,
                        submission_digest,
                        reply,
                        matches!(
                            rejection,
                            AdmissionRejectionV2::RunBusy { .. }
                                | AdmissionRejectionV2::CapacityExceeded { .. }
                        ),
                    )?;
                }
            }
            InvocationFactV2::AttemptPrepared { identity } => {
                let invocation = self
                    .invocations
                    .get_mut(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if !attempt_identity_matches_invocation(identity, invocation)
                    || invocation.phase != InvocationPhase::AttemptPrepared
                    || invocation.attempt_prepared_fact_id.is_some()
                {
                    return Err(corrupt_store());
                }
                invocation.attempt_prepared_fact_id = Some(envelope.fact_id.clone());
                invocation.last_fact_id = envelope.fact_id.clone();
            }
            InvocationFactV2::ExecutionStarted {
                identity,
                target_revalidation_set_digest,
            } => {
                let expected_digest = {
                    let invocation = self
                        .invocations
                        .get(&identity.invocation_id)
                        .ok_or_else(corrupt_store)?;
                    expected_revalidation_set_digest(self, invocation)?
                };
                let invocation = self
                    .invocations
                    .get_mut(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if !attempt_identity_matches_invocation(identity, invocation)
                    || invocation.phase != InvocationPhase::AttemptPrepared
                    || expected_digest != *target_revalidation_set_digest
                {
                    return Err(corrupt_store());
                }
                invocation.phase = InvocationPhase::Executing;
                invocation.execution_started_fact_id = Some(envelope.fact_id.clone());
                invocation.last_fact_id = envelope.fact_id.clone();
            }
            InvocationFactV2::CancellationObserved {
                identity,
                cancel_request_id,
            } => {
                let invocation = self
                    .invocations
                    .get_mut(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if !attempt_identity_matches_invocation(identity, invocation)
                    || invocation_phase_is_terminal(invocation.phase)
                    || invocation.cancellation_observed_fact_id.is_some()
                    || invocation
                        .stop_overlay
                        .cancellation()
                        .map(|(request_id, _, _)| request_id)
                        != Some(cancel_request_id)
                {
                    return Err(corrupt_store());
                }
                invocation.cancellation_observed_fact_id = Some(envelope.fact_id.clone());
                invocation.last_fact_id = envelope.fact_id.clone();
            }
            InvocationFactV2::DeadlineObserved { identity } => {
                let invocation = self
                    .invocations
                    .get_mut(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if !attempt_identity_matches_invocation(identity, invocation)
                    || invocation_phase_is_terminal(invocation.phase)
                    || invocation.deadline_observed_fact_id.is_some()
                {
                    return Err(corrupt_store());
                }
                invocation.stop_overlay = match invocation.stop_overlay.clone() {
                    StopOverlay::None => StopOverlay::DeadlineObserved {
                        fact_id: envelope.fact_id.clone(),
                    },
                    StopOverlay::CancellationRequested {
                        cancel_request_id,
                        fact_id,
                        ledger_sequence,
                    } => StopOverlay::CancellationAndDeadline {
                        cancel_request_id,
                        cancellation_fact_id: fact_id,
                        cancellation_ledger_sequence: ledger_sequence,
                        deadline_fact_id: envelope.fact_id.clone(),
                    },
                    _ => return Err(corrupt_store()),
                };
                invocation.deadline_observed_fact_id = Some(envelope.fact_id.clone());
                invocation.last_fact_id = envelope.fact_id.clone();
            }
            InvocationFactV2::FailedBeforeEffect { identity, .. } => self.set_attempt_terminal(
                identity,
                InvocationPhase::FailedBeforeEffect,
                envelope.fact_id.clone(),
            )?,
            InvocationFactV2::CancelledBeforeEffect {
                identity,
                cancel_request_id,
            } => {
                let invocation = self
                    .invocations
                    .get(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if invocation
                    .stop_overlay
                    .cancellation()
                    .map(|(request_id, _, _)| request_id)
                    != Some(cancel_request_id)
                {
                    return Err(corrupt_store());
                }
                self.set_attempt_terminal(
                    identity,
                    InvocationPhase::CancelledBeforeEffect,
                    envelope.fact_id.clone(),
                )?
            }
            InvocationFactV2::TimedOutBeforeEffect { identity } => self.set_attempt_terminal(
                identity,
                InvocationPhase::TimedOutBeforeEffect,
                envelope.fact_id.clone(),
            )?,
            InvocationFactV2::Completed { identity, output } => {
                validate_completed_output(self, identity, output)?;
                self.set_observed_terminal(
                    identity,
                    InvocationPhase::Completed,
                    envelope.fact_id.clone(),
                )?
            }
            InvocationFactV2::FailedAfterObservedEffect { identity, .. } => self
                .set_observed_terminal(
                    identity,
                    InvocationPhase::FailedAfterObservedEffect,
                    envelope.fact_id.clone(),
                )?,
            InvocationFactV2::Indeterminate {
                identity,
                reason_code,
            } => {
                validate_indeterminate_pair(self, identity, reason_code)?;
                self.set_observed_terminal(
                    identity,
                    InvocationPhase::Indeterminate,
                    envelope.fact_id.clone(),
                )?
            }
        }
        Ok(())
    }

    fn apply_submission_binding(
        &mut self,
        run_id: &RunId,
        operation_id: &OperationId,
        idempotency_key_hash: &IdempotencyKeyHashV2,
        digest: &InvocationSubmissionDigestV2,
        reply: InvocationSubmissionReplyV2,
        retryable_rejection: bool,
    ) -> AuthorityResult<()> {
        let operation_key = (run_id.clone(), operation_id.clone());
        let idempotency_key = (run_id.clone(), idempotency_key_hash.clone());
        let previous_operation = self.operation_bindings.get(&operation_key);
        let previous_idempotency = self.idempotency_bindings.get(&idempotency_key);
        match (previous_operation, previous_idempotency) {
            (None, None) => {}
            (Some(operation), Some(idempotency))
                if operation == idempotency
                    && operation.digest == *digest
                    && operation.retryable_rejection => {}
            _ => return Err(corrupt_store()),
        }
        let binding = SubmissionBinding {
            digest: digest.clone(),
            reply,
            retryable_rejection,
        };
        self.operation_bindings
            .insert(operation_key, binding.clone());
        self.idempotency_bindings.insert(idempotency_key, binding);
        Ok(())
    }

    fn set_attempt_terminal(
        &mut self,
        identity: &AttemptIdentityV2,
        phase: InvocationPhase,
        fact_id: FactId,
    ) -> AuthorityResult<()> {
        let invocation = self
            .invocations
            .get_mut(&identity.invocation_id)
            .ok_or_else(corrupt_store)?;
        if !attempt_identity_matches_invocation(identity, invocation)
            || invocation.phase != InvocationPhase::AttemptPrepared
        {
            return Err(corrupt_store());
        }
        invocation.phase = phase;
        invocation.last_fact_id = fact_id;
        let run = self
            .runs
            .get_mut(&identity.run_id)
            .ok_or_else(corrupt_store)?;
        if run.active_invocation_id.as_ref() != Some(&identity.invocation_id) {
            return Err(corrupt_store());
        }
        run.active_invocation_id = None;
        Ok(())
    }

    fn set_observed_terminal(
        &mut self,
        identity: &ObservedTerminalIdentityV2,
        phase: InvocationPhase,
        fact_id: FactId,
    ) -> AuthorityResult<()> {
        let invocation = self
            .invocations
            .get_mut(&identity.invocation_id)
            .ok_or_else(corrupt_store)?;
        if !observed_identity_matches_invocation(identity, invocation)
            || invocation.phase != InvocationPhase::Executing
            || self.invocation_effects.get(&identity.invocation_id)
                != Some(&(
                    identity.effect_id.clone(),
                    identity.causation_fact_id.clone(),
                ))
        {
            return Err(corrupt_store());
        }
        invocation.phase = phase;
        invocation.last_fact_id = fact_id;
        let run = self
            .runs
            .get_mut(&identity.run_id)
            .ok_or_else(corrupt_store)?;
        if run.active_invocation_id.as_ref() != Some(&identity.invocation_id) {
            return Err(corrupt_store());
        }
        run.active_invocation_id = None;
        Ok(())
    }

    fn set_direct_attempt_terminal(
        &mut self,
        identity: &ToolAttemptIdentityV2,
        phase: InvocationPhase,
        fact_id: FactId,
    ) -> AuthorityResult<()> {
        let invocation = self
            .direct_invocations
            .get_mut(&identity.invocation_id)
            .ok_or_else(corrupt_store)?;
        if !direct_attempt_identity_matches(identity, invocation)
            || invocation.phase != InvocationPhase::AttemptPrepared
        {
            return Err(corrupt_store());
        }
        invocation.phase = phase;
        invocation.last_fact_id = fact_id;
        let run = self
            .runs
            .get_mut(&identity.run_id)
            .ok_or_else(corrupt_store)?;
        if run.active_invocation_id.as_ref() != Some(&identity.invocation_id) {
            return Err(corrupt_store());
        }
        run.active_invocation_id = None;
        Ok(())
    }

    fn set_direct_observed_terminal(
        &mut self,
        identity: &ToolObservedTerminalIdentityV2,
        phase: InvocationPhase,
        fact_id: FactId,
    ) -> AuthorityResult<()> {
        let invocation = self
            .direct_invocations
            .get_mut(&identity.invocation_id)
            .ok_or_else(corrupt_store)?;
        if !direct_observed_identity_matches(identity, invocation)
            || invocation.phase != InvocationPhase::Executing
            || self.invocation_effects.get(&identity.invocation_id)
                != Some(&(
                    identity.effect_id.clone(),
                    identity.causation_fact_id.clone(),
                ))
        {
            return Err(corrupt_store());
        }
        invocation.phase = phase;
        invocation.last_fact_id = fact_id;
        let run = self
            .runs
            .get_mut(&identity.run_id)
            .ok_or_else(corrupt_store)?;
        if run.active_invocation_id.as_ref() != Some(&identity.invocation_id) {
            return Err(corrupt_store());
        }
        run.active_invocation_id = None;
        Ok(())
    }

    fn reduce_effect(
        &mut self,
        envelope: &KernelFactEnvelopeV2,
        fact: &EffectFactV2,
    ) -> AuthorityResult<()> {
        if let Some(identity) = direct_effect_identity(fact) {
            validate_direct_effect(self, fact)?;
            if self
                .invocation_effects
                .values()
                .any(|(effect_id, _)| effect_id == &identity.effect_id)
                || self
                    .invocation_effects
                    .contains_key(&identity.invocation_id)
            {
                return Err(corrupt_store());
            }
            self.invocation_effects.insert(
                identity.invocation_id.clone(),
                (identity.effect_id.clone(), envelope.fact_id.clone()),
            );
            return Ok(());
        }
        validate_effect(self, fact)?;
        let identity = effect_identity(fact);
        if self
            .invocation_effects
            .values()
            .any(|(effect_id, _)| effect_id == &identity.effect_id)
            || self
                .invocation_effects
                .contains_key(&identity.invocation_id)
        {
            return Err(corrupt_store());
        }
        self.invocation_effects.insert(
            identity.invocation_id.clone(),
            (identity.effect_id.clone(), envelope.fact_id.clone()),
        );
        Ok(())
    }

    fn reduce_resource(
        &mut self,
        envelope: &KernelFactEnvelopeV2,
        fact: &ResourceFactV2,
    ) -> AuthorityResult<()> {
        match fact {
            ResourceFactV2::ResolvedForInvocation { identity, resource } => {
                let (identity_matches, scope) =
                    if let Some(invocation) = self.invocations.get(&identity.invocation_id) {
                        let grant = self
                            .grants
                            .get(&invocation.grant_id)
                            .ok_or_else(corrupt_store)?;
                        (
                            resolved_identity_matches_invocation(identity, invocation),
                            &grant.resource_scope,
                        )
                    } else if let Some(invocation) =
                        self.direct_invocations.get(&identity.invocation_id)
                    {
                        (
                            direct_resolved_identity_matches_invocation(identity, invocation),
                            &invocation.resource_scope,
                        )
                    } else {
                        return Err(corrupt_store());
                    };
                if !identity_matches
                    || !resource_matches_scope(resource, scope)
                    || self.resources.contains_key(&identity.resource_id)
                    || self.resources.values().any(|existing| {
                        existing.invocation_id == identity.invocation_id
                            && existing.resolved == *resource
                    })
                {
                    return Err(corrupt_store());
                }
                self.resources.insert(
                    identity.resource_id.clone(),
                    ResourceRecord {
                        run_id: identity.run_id.clone(),
                        invocation_id: identity.invocation_id.clone(),
                        resource_id: identity.resource_id.clone(),
                        resolved: resource.clone(),
                        resolution_fact_id: envelope.fact_id.clone(),
                        revalidation: None,
                        last_fact_id: envelope.fact_id.clone(),
                    },
                );
            }
            ResourceFactV2::RevalidatedBeforeEffect {
                identity,
                observation,
                target_revalidation_digest,
            } => {
                let resource = self
                    .resources
                    .get_mut(&identity.resource_id)
                    .ok_or_else(corrupt_store)?;
                let identity_matches =
                    if let Some(invocation) = self.invocations.get(&identity.invocation_id) {
                        resource_attempt_identity_matches_invocation(
                            identity,
                            invocation,
                            resource,
                        )
                    } else if let Some(invocation) =
                        self.direct_invocations.get(&identity.invocation_id)
                    {
                        direct_resource_attempt_identity_matches_invocation(
                            identity,
                            invocation,
                            resource,
                        )
                    } else {
                        return Err(corrupt_store());
                    };
                if !identity_matches
                    || resource.revalidation.is_some()
                {
                    return Err(corrupt_store());
                }
                resource.revalidation = Some((
                    envelope.fact_id.clone(),
                    target_revalidation_digest.clone(),
                    observation.clone(),
                ));
                resource.last_fact_id = envelope.fact_id.clone();
            }
            ResourceFactV2::Acquired { .. } | ResourceFactV2::Released { .. } => {
                return Err(corrupt_store());
            }
        }
        Ok(())
    }
}

fn attempt_identity_matches_invocation(
    identity: &AttemptIdentityV2,
    invocation: &InvocationRecord,
) -> bool {
    identity.run_id == invocation.run_id
        && identity.control_epoch == invocation.control_epoch
        && identity.operation_id == invocation.operation_id
        && identity.grant_id == invocation.grant_id
        && identity.reservation_id == invocation.reservation_id
        && identity.invocation_id == invocation.invocation_id
        && identity.attempt_id == invocation.attempt_id
        && identity.idempotency_key_hash == invocation.idempotency_key_hash
        && identity.correlation_set == invocation.correlations
}

fn direct_attempt_identity_matches(
    identity: &ToolAttemptIdentityV2,
    invocation: &DirectInvocationRecord,
) -> bool {
    identity.run_id == invocation.run_id
        && identity.control_epoch == invocation.control_epoch
        && identity.operation_id == invocation.operation_id
        && identity.authority == invocation.authority
        && identity.invocation_id == invocation.invocation_id
        && identity.attempt_id == invocation.attempt_id
        && identity.idempotency_key_hash == invocation.idempotency_key_hash
        && identity.correlation_set == invocation.correlations
}

fn reservation_identity_matches_invocation(
    identity: &ReservationIdentityV2,
    invocation: &InvocationRecord,
) -> bool {
    identity.run_id == invocation.run_id
        && identity.control_epoch == invocation.control_epoch
        && identity.operation_id == invocation.operation_id
        && identity.grant_id == invocation.grant_id
        && identity.reservation_id == invocation.reservation_id
        && identity.invocation_id == invocation.invocation_id
        && identity.idempotency_key_hash == invocation.idempotency_key_hash
        && identity.correlation_set == invocation.correlations
}

fn observed_identity_matches_invocation(
    identity: &ObservedTerminalIdentityV2,
    invocation: &InvocationRecord,
) -> bool {
    identity.run_id == invocation.run_id
        && identity.control_epoch == invocation.control_epoch
        && identity.operation_id == invocation.operation_id
        && identity.grant_id == invocation.grant_id
        && identity.reservation_id == invocation.reservation_id
        && identity.invocation_id == invocation.invocation_id
        && identity.attempt_id == invocation.attempt_id
        && identity.idempotency_key_hash == invocation.idempotency_key_hash
        && identity.correlation_set == invocation.correlations
}

fn direct_observed_identity_matches(
    identity: &ToolObservedTerminalIdentityV2,
    invocation: &DirectInvocationRecord,
) -> bool {
    identity.run_id == invocation.run_id
        && identity.control_epoch == invocation.control_epoch
        && identity.operation_id == invocation.operation_id
        && identity.authority == invocation.authority
        && identity.invocation_id == invocation.invocation_id
        && identity.attempt_id == invocation.attempt_id
        && identity.idempotency_key_hash == invocation.idempotency_key_hash
        && identity.correlation_set == invocation.correlations
}

fn effect_identity_matches_invocation(
    identity: &EffectIdentityV2,
    invocation: &InvocationRecord,
) -> bool {
    identity.run_id == invocation.run_id
        && identity.control_epoch == invocation.control_epoch
        && identity.operation_id == invocation.operation_id
        && identity.grant_id == invocation.grant_id
        && identity.reservation_id == invocation.reservation_id
        && identity.invocation_id == invocation.invocation_id
        && identity.attempt_id == invocation.attempt_id
        && identity.idempotency_key_hash == invocation.idempotency_key_hash
}

fn direct_effect_identity_matches_invocation(
    identity: &ToolEffectIdentityV2,
    invocation: &DirectInvocationRecord,
) -> bool {
    identity.run_id == invocation.run_id
        && identity.control_epoch == invocation.control_epoch
        && identity.operation_id == invocation.operation_id
        && identity.authority == invocation.authority
        && identity.invocation_id == invocation.invocation_id
        && identity.attempt_id == invocation.attempt_id
        && identity.idempotency_key_hash == invocation.idempotency_key_hash
}

fn grant_lifecycle_identity_matches(
    identity: &GrantLifecycleIdentityV2,
    grant: &GrantRecord,
) -> bool {
    identity.run_id == grant.run_id
        && identity.grant_epoch == grant.grant_epoch
        && identity.issuance_operation_id == grant.issuance_operation_id
        && identity.grant_id == grant.grant_id
}

fn resolved_identity_matches_invocation(
    identity: &ResourceResolvedIdentityV2,
    invocation: &InvocationRecord,
) -> bool {
    identity.run_id == invocation.run_id
        && identity.control_epoch == invocation.control_epoch
        && identity.operation_id == invocation.operation_id
        && identity.invocation_id == invocation.invocation_id
        && identity.idempotency_key_hash == invocation.idempotency_key_hash
        && identity.correlation_set == invocation.correlations
}

fn direct_resolved_identity_matches_invocation(
    identity: &ResourceResolvedIdentityV2,
    invocation: &DirectInvocationRecord,
) -> bool {
    identity.run_id == invocation.run_id
        && identity.control_epoch == invocation.control_epoch
        && identity.operation_id == invocation.operation_id
        && identity.invocation_id == invocation.invocation_id
        && identity.idempotency_key_hash == invocation.idempotency_key_hash
        && identity.correlation_set == invocation.correlations
}

fn resource_attempt_identity_matches_invocation(
    identity: &ResourceAttemptIdentityV2,
    invocation: &InvocationRecord,
    resource: &ResourceRecord,
) -> bool {
    identity.run_id == invocation.run_id
        && identity.control_epoch == invocation.control_epoch
        && identity.operation_id == invocation.operation_id
        && identity.invocation_id == invocation.invocation_id
        && identity.attempt_id == invocation.attempt_id
        && identity.resource_id == resource.resource_id
        && resource.run_id == invocation.run_id
        && resource.invocation_id == invocation.invocation_id
        && identity.idempotency_key_hash == invocation.idempotency_key_hash
        && identity.correlation_set == invocation.correlations
}

fn direct_resource_attempt_identity_matches_invocation(
    identity: &ResourceAttemptIdentityV2,
    invocation: &DirectInvocationRecord,
    resource: &ResourceRecord,
) -> bool {
    identity.run_id == invocation.run_id
        && identity.control_epoch == invocation.control_epoch
        && identity.operation_id == invocation.operation_id
        && identity.invocation_id == invocation.invocation_id
        && identity.attempt_id == invocation.attempt_id
        && identity.resource_id == resource.resource_id
        && resource.run_id == invocation.run_id
        && resource.invocation_id == invocation.invocation_id
        && identity.idempotency_key_hash == invocation.idempotency_key_hash
        && identity.correlation_set == invocation.correlations
}

fn resource_matches_scope(resource: &ResolvedResourceV2, scope: &ResourceScopeV2) -> bool {
    match (resource, scope) {
        (
            ResolvedResourceV2::Workspace {
                object_kind,
                relative_path,
                resolution_state_digest,
            },
            ResourceScopeV2::Workspace { targets },
        ) => targets.iter().any(|target| {
            target.object_kind == *object_kind
                && target.relative_path == *relative_path
                && target.target_observation_digest == *resolution_state_digest
        }),
        (
            ResolvedResourceV2::NetworkQuery {
                query_digest,
                service_origin,
                target_observation_digest,
            },
            ResourceScopeV2::NetworkQuery {
                query_digest: expected_query,
                service_origin: expected_origin,
                target_observation_digest: expected_target,
            },
        ) => {
            query_digest == expected_query
                && service_origin == expected_origin
                && target_observation_digest == expected_target
        }
        (
            ResolvedResourceV2::NetworkEndpoint {
                origin,
                target_observation_digest,
            },
            ResourceScopeV2::NetworkUrl {
                origin: expected_origin,
                target_observation_digest: expected_target,
            },
        ) => origin == expected_origin && target_observation_digest == expected_target,
        _ => false,
    }
}

fn legacy_tool_id(tool_id: &ToolIdV2) -> Option<AuthorityToolIdV4> {
    AuthorityToolIdV4::ALL
        .into_iter()
        .find(|candidate| candidate.as_str() == tool_id.as_str())
}

fn expected_resource_count(scope: &ResourceScopeV2) -> AuthorityResult<usize> {
    match scope {
        ResourceScopeV2::Workspace { targets } => Ok(targets.len()),
        ResourceScopeV2::NetworkQuery { .. } | ResourceScopeV2::NetworkUrl { .. } => Ok(1),
        ResourceScopeV2::Repository { .. } => Err(corrupt_store()),
    }
}

fn expected_revalidation_set_digest(
    state: &AuthorityState,
    invocation: &InvocationRecord,
) -> AuthorityResult<TargetRevalidationSetDigestV2> {
    let grant = state
        .grants
        .get(&invocation.grant_id)
        .ok_or_else(corrupt_store)?;
    let mut resources = state
        .resources
        .values()
        .filter(|resource| resource.invocation_id == invocation.invocation_id)
        .collect::<Vec<_>>();
    if resources.len() != expected_resource_count(&grant.resource_scope)?
        || resources
            .iter()
            .any(|resource| resource.revalidation.is_none())
    {
        return Err(corrupt_store());
    }
    resources.sort_by(|left, right| {
        left.resource_id
            .as_str()
            .as_bytes()
            .cmp(right.resource_id.as_str().as_bytes())
    });
    let entries = resources
        .iter()
        .map(|resource| {
            let (fact_id, digest, _) = resource
                .revalidation
                .as_ref()
                .expect("checked revalidation");
            (&resource.resource_id, fact_id, digest)
        })
        .collect::<Vec<_>>();
    target_revalidation_set_digest_v2(
        &invocation.run_id,
        &invocation.operation_id,
        &invocation.invocation_id,
        &invocation.attempt_id,
        &entries,
    )
    .map_err(|_| corrupt_store())
}

fn expected_direct_revalidation_set_digest(
    state: &AuthorityState,
    invocation: &DirectInvocationRecord,
) -> AuthorityResult<TargetRevalidationSetDigestV2> {
    let mut resources = state
        .resources
        .values()
        .filter(|resource| resource.invocation_id == invocation.invocation_id)
        .collect::<Vec<_>>();
    if resources.len() != expected_resource_count(&invocation.resource_scope)?
        || resources
            .iter()
            .any(|resource| resource.revalidation.is_none())
    {
        return Err(corrupt_store());
    }
    resources.sort_by(|left, right| {
        left.resource_id
            .as_str()
            .as_bytes()
            .cmp(right.resource_id.as_str().as_bytes())
    });
    let entries = resources
        .iter()
        .map(|resource| {
            let (fact_id, digest, _) = resource
                .revalidation
                .as_ref()
                .expect("checked revalidation");
            (&resource.resource_id, fact_id, digest)
        })
        .collect::<Vec<_>>();
    target_revalidation_set_digest_v2(
        &invocation.run_id,
        &invocation.operation_id,
        &invocation.invocation_id,
        &invocation.attempt_id,
        &entries,
    )
    .map_err(|_| corrupt_store())
}

enum EffectModeRef<'a> {
    Observed,
    AfterCancel(&'a CancelRequestId),
    AfterDeadline,
    AfterCancelAndDeadline(&'a CancelRequestId),
    Indeterminate,
}

fn validate_effect(state: &AuthorityState, fact: &EffectFactV2) -> AuthorityResult<()> {
    let (identity, resources, evidence, evidence_digest, mode) = match fact {
        EffectFactV2::Observed {
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
        } => (
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
            EffectModeRef::Observed,
        ),
        EffectFactV2::ObservedAfterCancel {
            identity,
            cancel_request_id,
            affected_resource_ids,
            evidence,
            evidence_digest,
        } => (
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
            EffectModeRef::AfterCancel(cancel_request_id),
        ),
        EffectFactV2::ObservedAfterDeadline {
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
        } => (
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
            EffectModeRef::AfterDeadline,
        ),
        EffectFactV2::ObservedAfterCancelAndDeadline {
            identity,
            cancel_request_id,
            affected_resource_ids,
            evidence,
            evidence_digest,
        } => (
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
            EffectModeRef::AfterCancelAndDeadline(cancel_request_id),
        ),
        EffectFactV2::Indeterminate {
            identity,
            possible_affected_resource_ids,
            evidence,
            evidence_digest,
            ..
        } => (
            identity,
            possible_affected_resource_ids,
            evidence,
            evidence_digest,
            EffectModeRef::Indeterminate,
        ),
        EffectFactV2::ToolObserved { .. }
        | EffectFactV2::ToolObservedAfterCancel { .. }
        | EffectFactV2::ToolObservedAfterDeadline { .. }
        | EffectFactV2::ToolObservedAfterCancelAndDeadline { .. }
        | EffectFactV2::ToolIndeterminate { .. } => return Err(corrupt_store()),
    };
    let invocation = state
        .invocations
        .get(&identity.invocation_id)
        .ok_or_else(corrupt_store)?;
    let mut expected_resources = state
        .resources
        .values()
        .filter(|resource| resource.invocation_id == identity.invocation_id)
        .map(|resource| resource.resource_id.clone())
        .collect::<Vec<_>>();
    expected_resources
        .sort_by(|left, right| left.as_str().as_bytes().cmp(right.as_str().as_bytes()));
    let observed_cancel = invocation
        .stop_overlay
        .cancellation()
        .map(|(request_id, _, _)| request_id);
    let stop_matches = match mode {
        EffectModeRef::Observed => {
            invocation.cancellation_observed_fact_id.is_none()
                && invocation.deadline_observed_fact_id.is_none()
        }
        EffectModeRef::AfterCancel(cancel_request_id) => {
            invocation.cancellation_observed_fact_id.is_some()
                && invocation.deadline_observed_fact_id.is_none()
                && observed_cancel == Some(cancel_request_id)
        }
        EffectModeRef::AfterDeadline => {
            invocation.cancellation_observed_fact_id.is_none()
                && invocation.deadline_observed_fact_id.is_some()
        }
        EffectModeRef::AfterCancelAndDeadline(cancel_request_id) => {
            invocation.cancellation_observed_fact_id.is_some()
                && invocation.deadline_observed_fact_id.is_some()
                && observed_cancel == Some(cancel_request_id)
        }
        EffectModeRef::Indeterminate => true,
    };
    let evidence_matches = match mode {
        EffectModeRef::Indeterminate => indeterminate_evidence_legal(invocation.tool_id, evidence),
        _ => observed_evidence_legal(invocation.tool_id, evidence),
    };
    if invocation.phase != InvocationPhase::Executing
        || !effect_identity_matches_invocation(identity, invocation)
        || resources != &expected_resources
        || !stop_matches
        || !evidence_matches
        || executor_evidence_digest_v2(evidence).map_err(|_| corrupt_store())? != *evidence_digest
    {
        return Err(corrupt_store());
    }
    expected_revalidation_set_digest(state, invocation)?;
    Ok(())
}

fn validate_direct_effect(state: &AuthorityState, fact: &EffectFactV2) -> AuthorityResult<()> {
    let (identity, resources, evidence, evidence_digest, mode) = match fact {
        EffectFactV2::ToolObserved {
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
        } => (
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
            EffectModeRef::Observed,
        ),
        EffectFactV2::ToolObservedAfterCancel {
            identity,
            cancel_request_id,
            affected_resource_ids,
            evidence,
            evidence_digest,
        } => (
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
            EffectModeRef::AfterCancel(cancel_request_id),
        ),
        EffectFactV2::ToolObservedAfterDeadline {
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
        } => (
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
            EffectModeRef::AfterDeadline,
        ),
        EffectFactV2::ToolObservedAfterCancelAndDeadline {
            identity,
            cancel_request_id,
            affected_resource_ids,
            evidence,
            evidence_digest,
        } => (
            identity,
            affected_resource_ids,
            evidence,
            evidence_digest,
            EffectModeRef::AfterCancelAndDeadline(cancel_request_id),
        ),
        EffectFactV2::ToolIndeterminate {
            identity,
            possible_affected_resource_ids,
            evidence,
            evidence_digest,
            ..
        } => (
            identity,
            possible_affected_resource_ids,
            evidence,
            evidence_digest,
            EffectModeRef::Indeterminate,
        ),
        _ => return Err(corrupt_store()),
    };
    let invocation = state
        .direct_invocations
        .get(&identity.invocation_id)
        .ok_or_else(corrupt_store)?;
    let mut expected_resources = state
        .resources
        .values()
        .filter(|resource| resource.invocation_id == identity.invocation_id)
        .map(|resource| resource.resource_id.clone())
        .collect::<Vec<_>>();
    expected_resources
        .sort_by(|left, right| left.as_str().as_bytes().cmp(right.as_str().as_bytes()));
    let observed_cancel = invocation
        .stop_overlay
        .cancellation()
        .map(|(request_id, _, _)| request_id);
    let stop_matches = match mode {
        EffectModeRef::Observed => {
            invocation.cancellation_observed_fact_id.is_none()
                && invocation.deadline_observed_fact_id.is_none()
        }
        EffectModeRef::AfterCancel(cancel_request_id) => {
            invocation.cancellation_observed_fact_id.is_some()
                && invocation.deadline_observed_fact_id.is_none()
                && observed_cancel == Some(cancel_request_id)
        }
        EffectModeRef::AfterDeadline => {
            invocation.cancellation_observed_fact_id.is_none()
                && invocation.deadline_observed_fact_id.is_some()
        }
        EffectModeRef::AfterCancelAndDeadline(cancel_request_id) => {
            invocation.cancellation_observed_fact_id.is_some()
                && invocation.deadline_observed_fact_id.is_some()
                && observed_cancel == Some(cancel_request_id)
        }
        EffectModeRef::Indeterminate => true,
    };
    let evidence_matches = match mode {
        EffectModeRef::Indeterminate => {
            indeterminate_evidence_legal(invocation.legacy_tool_id, evidence)
        }
        _ => observed_evidence_legal(invocation.legacy_tool_id, evidence),
    };
    if invocation.phase != InvocationPhase::Executing
        || !direct_effect_identity_matches_invocation(identity, invocation)
        || resources != &expected_resources
        || !stop_matches
        || !evidence_matches
        || executor_evidence_digest_v2(evidence).map_err(|_| corrupt_store())? != *evidence_digest
    {
        return Err(corrupt_store());
    }
    expected_direct_revalidation_set_digest(state, invocation)?;
    Ok(())
}

fn observed_evidence_legal(tool_id: AuthorityToolIdV4, evidence: &EffectEvidenceV2) -> bool {
    use AuthorityToolIdV4 as Tool;
    match (tool_id, evidence) {
        (
            Tool::FsRead | Tool::FsDiff | Tool::DocumentRead,
            EffectEvidenceV2::ContentRead { .. },
        )
        | (Tool::FsList | Tool::FsGlob, EffectEvidenceV2::CollectionRead { .. })
        | (Tool::CodeGrep, EffectEvidenceV2::SearchMatchesReadBack { .. })
        | (
            Tool::FsCreate | Tool::FsWrite | Tool::FsEdit,
            EffectEvidenceV2::MutationReadBack {
                target_kind: WorkspaceObjectKindV2::File,
                ..
            },
        )
        | (
            Tool::FsEnsureDirectory,
            EffectEvidenceV2::MutationReadBack {
                target_kind: WorkspaceObjectKindV2::Directory,
                ..
            },
        )
        | (Tool::FsDelete, EffectEvidenceV2::DeletionReadBack { .. })
        | (Tool::WebSearch, EffectEvidenceV2::WebSearchReadBack { .. })
        | (Tool::WebFetch, EffectEvidenceV2::WebReadBack { .. }) => true,
        _ => false,
    }
}

fn indeterminate_evidence_legal(tool_id: AuthorityToolIdV4, evidence: &EffectEvidenceV2) -> bool {
    let EffectEvidenceV2::IndeterminateReadBack { last_observation } = evidence else {
        return false;
    };
    use AuthorityToolIdV4 as Tool;
    match (tool_id, last_observation) {
        (_, LastObservationV2::None {}) => true,
        (Tool::FsRead | Tool::FsDiff | Tool::DocumentRead, LastObservationV2::Content { .. })
        | (Tool::FsList | Tool::FsGlob, LastObservationV2::Collection { .. })
        | (Tool::CodeGrep, LastObservationV2::ToolOutput { .. })
        | (
            Tool::FsCreate
            | Tool::FsWrite
            | Tool::FsEdit
            | Tool::FsDelete
            | Tool::FsEnsureDirectory,
            LastObservationV2::ResourceState { .. },
        )
        | (
            Tool::WebSearch,
            LastObservationV2::NetworkTarget { .. } | LastObservationV2::ToolOutput { .. },
        )
        | (
            Tool::WebFetch,
            LastObservationV2::NetworkTarget { .. } | LastObservationV2::NetworkResponse { .. },
        ) => true,
        _ => false,
    }
}

fn effect_identity(fact: &EffectFactV2) -> &EffectIdentityV2 {
    match fact {
        EffectFactV2::Observed { identity, .. }
        | EffectFactV2::ObservedAfterCancel { identity, .. }
        | EffectFactV2::ObservedAfterDeadline { identity, .. }
        | EffectFactV2::ObservedAfterCancelAndDeadline { identity, .. }
        | EffectFactV2::Indeterminate { identity, .. } => identity,
        EffectFactV2::ToolObserved { .. }
        | EffectFactV2::ToolObservedAfterCancel { .. }
        | EffectFactV2::ToolObservedAfterDeadline { .. }
        | EffectFactV2::ToolObservedAfterCancelAndDeadline { .. }
        | EffectFactV2::ToolIndeterminate { .. } => {
            unreachable!("direct effects are handled before legacy identity projection")
        }
    }
}

fn direct_effect_identity(fact: &EffectFactV2) -> Option<&ToolEffectIdentityV2> {
    match fact {
        EffectFactV2::ToolObserved { identity, .. }
        | EffectFactV2::ToolObservedAfterCancel { identity, .. }
        | EffectFactV2::ToolObservedAfterDeadline { identity, .. }
        | EffectFactV2::ToolObservedAfterCancelAndDeadline { identity, .. }
        | EffectFactV2::ToolIndeterminate { identity, .. } => Some(identity),
        _ => None,
    }
}

fn validate_completed_output(
    state: &AuthorityState,
    identity: &ObservedTerminalIdentityV2,
    output: &ToolOutputV4,
) -> AuthorityResult<()> {
    let evidence = match state
        .facts_by_id
        .get(&identity.causation_fact_id)
        .map(|fact| &fact.payload)
    {
        Some(KernelFactPayloadV2::Effect(
            EffectFactV2::Observed { evidence, .. }
            | EffectFactV2::ObservedAfterCancel { evidence, .. }
            | EffectFactV2::ObservedAfterDeadline { evidence, .. }
            | EffectFactV2::ObservedAfterCancelAndDeadline { evidence, .. },
        )) => evidence,
        _ => return Err(corrupt_store()),
    };
    if matches!(
        evidence,
        EffectEvidenceV2::SearchMatchesReadBack { output_digest, .. }
            | EffectEvidenceV2::WebSearchReadBack { output_digest, .. }
            if output_digest != &output.full_digest
    ) {
        return Err(corrupt_store());
    }
    Ok(())
}

fn validate_indeterminate_pair(
    state: &AuthorityState,
    identity: &ObservedTerminalIdentityV2,
    reason_code: &IndeterminateReasonV2,
) -> AuthorityResult<()> {
    match state
        .facts_by_id
        .get(&identity.causation_fact_id)
        .map(|fact| &fact.payload)
    {
        Some(KernelFactPayloadV2::Effect(EffectFactV2::Indeterminate {
            reason_code: effect_reason,
            ..
        })) if effect_reason == reason_code => Ok(()),
        _ => Err(corrupt_store()),
    }
}

fn validate_direct_completed_output(
    state: &AuthorityState,
    identity: &ToolObservedTerminalIdentityV2,
    output: &ToolOutputV4,
) -> AuthorityResult<()> {
    let evidence = match state
        .facts_by_id
        .get(&identity.causation_fact_id)
        .map(|fact| &fact.payload)
    {
        Some(KernelFactPayloadV2::Effect(
            EffectFactV2::ToolObserved { evidence, .. }
            | EffectFactV2::ToolObservedAfterCancel { evidence, .. }
            | EffectFactV2::ToolObservedAfterDeadline { evidence, .. }
            | EffectFactV2::ToolObservedAfterCancelAndDeadline { evidence, .. },
        )) => evidence,
        _ => return Err(corrupt_store()),
    };
    if matches!(
        evidence,
        EffectEvidenceV2::SearchMatchesReadBack { output_digest, .. }
            | EffectEvidenceV2::WebSearchReadBack { output_digest, .. }
            if output_digest != &output.full_digest
    ) {
        return Err(corrupt_store());
    }
    Ok(())
}

fn validate_direct_indeterminate_pair(
    state: &AuthorityState,
    identity: &ToolObservedTerminalIdentityV2,
    reason_code: &IndeterminateReasonV2,
) -> AuthorityResult<()> {
    match state
        .facts_by_id
        .get(&identity.causation_fact_id)
        .map(|fact| &fact.payload)
    {
        Some(KernelFactPayloadV2::Effect(EffectFactV2::ToolIndeterminate {
            reason_code: effect_reason,
            ..
        })) if effect_reason == reason_code => Ok(()),
        _ => Err(corrupt_store()),
    }
}

fn submission_reply_from_cause(
    state: &AuthorityState,
    causation_fact_id: &FactId,
) -> AuthorityResult<InvocationSubmissionReplyV2> {
    match state
        .facts_by_id
        .get(causation_fact_id)
        .map(|fact| &fact.payload)
    {
        Some(KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded {
            command_kind: MutationCommandKindV2::InvocationSubmit,
            result: MutationCommandResultV2::InvocationSubmission { reply },
            ..
        })) => Ok(reply.clone()),
        _ => Err(corrupt_store()),
    }
}

fn reply_from_recorded_result(result: MutationCommandResultV2) -> KernelReplyV2 {
    match result {
        MutationCommandResultV2::ToolIntentSubmission { reply } => {
            KernelReplyV2::ToolIntentSubmission(reply)
        }
        MutationCommandResultV2::EpochAdvance { reply } => {
            KernelReplyV2::ControlEpochAdvanced(reply)
        }
        MutationCommandResultV2::GrantDecision { reply } => {
            KernelReplyV2::GrantDecisionRecorded(reply)
        }
        MutationCommandResultV2::GrantRevoke { reply } => KernelReplyV2::GrantRevoked(reply),
        MutationCommandResultV2::InvocationSubmission { reply } => {
            KernelReplyV2::InvocationSubmission(reply)
        }
        MutationCommandResultV2::InvocationCancel { reply } => {
            KernelReplyV2::InvocationCancelResult(reply)
        }
        MutationCommandResultV2::RunTerminate { reply } => KernelReplyV2::RunTerminated(reply),
        MutationCommandResultV2::RecordedSemanticError { error } => {
            KernelReplyV2::Error(recorded_error_to_error(error))
        }
    }
}

pub(super) fn recorded_error_to_error(error: RecordedCommandErrorV2) -> KernelErrorV2 {
    use RecordedCommandErrorV2 as Recorded;
    match error {
        Recorded::ControlEpochAlreadyExists { run_id, current } => {
            KernelErrorV2::ControlEpochAlreadyExists { run_id, current }
        }
        Recorded::ControlEpochExhausted { run_id, current } => {
            KernelErrorV2::ControlEpochExhausted { run_id, current }
        }
        Recorded::StaleControlEpoch {
            run_id,
            submitted,
            current,
        } => KernelErrorV2::StaleControlEpoch {
            run_id,
            submitted,
            current,
        },
        Recorded::RunTerminated {
            run_id,
            control_epoch,
        } => KernelErrorV2::RunTerminated {
            run_id,
            control_epoch,
        },
        Recorded::ToolExecutionUnavailable {
            tool_id,
            availability,
        } => KernelErrorV2::ToolExecutionUnavailable {
            tool_id,
            availability,
        },
        Recorded::GrantNotFound { run_id } => KernelErrorV2::GrantNotFound { run_id },
        Recorded::AuthorizationDigestMismatch { expected, actual } => {
            KernelErrorV2::AuthorizationDigestMismatch { expected, actual }
        }
        Recorded::DuplicateGrantDecisionDigestMismatch {
            authorization_request_digest,
            existing,
            submitted,
        } => KernelErrorV2::DuplicateGrantDecisionDigestMismatch {
            authorization_request_digest,
            existing,
            submitted,
        },
        Recorded::InvocationNotFound {
            run_id,
            invocation_id,
        } => KernelErrorV2::InvocationNotFound {
            run_id,
            invocation_id,
        },
        Recorded::InvocationNotOwnedByRun {
            run_id,
            invocation_id,
        } => KernelErrorV2::InvocationNotOwnedByRun {
            run_id,
            invocation_id,
        },
    }
}

fn validate_causation(
    state: &AuthorityState,
    envelope: &KernelFactEnvelopeV2,
) -> AuthorityResult<()> {
    let Some(causation_id) = envelope.payload.causation_fact_id() else {
        if matches!(
            envelope.payload,
            KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded { .. })
        ) {
            return Ok(());
        }
        return Err(corrupt_store());
    };
    let predecessor = state
        .facts_by_id
        .get(causation_id)
        .ok_or_else(corrupt_store)?;
    if predecessor.ledger_sequence >= envelope.ledger_sequence
        || predecessor.payload.run_id() != envelope.payload.run_id()
        || !edge_kind_matches(&predecessor.payload, &envelope.payload)
    {
        return Err(corrupt_store());
    }
    Ok(())
}

fn same_authorization_subject(
    left: &AuthorizationIdentityV2,
    right: &AuthorizationIdentityV2,
) -> bool {
    left.run_id == right.run_id
        && left.control_epoch == right.control_epoch
        && left.plan_revision == right.plan_revision
        && left.plan_action_id == right.plan_action_id
        && left.operation_id == right.operation_id
}

fn lease_matches_authorization_subject(
    lease: &CapabilityLeaseFactIdentityV2,
    authorization: &AuthorizationIdentityV2,
) -> bool {
    lease.run_id == authorization.run_id
        && lease.control_epoch == authorization.control_epoch
        && lease.plan_revision == authorization.plan_revision
        && lease.plan_action_id == authorization.plan_action_id
        && lease.operation_id == authorization.operation_id
}

fn lease_matches_awaiting_subject(
    lease: &CapabilityLeaseFactIdentityV2,
    awaiting: &CapabilityAwaitingIdentityV2,
) -> bool {
    lease.run_id == awaiting.run_id
        && lease.control_epoch == awaiting.control_epoch
        && lease.plan_revision == awaiting.plan_revision
        && lease.plan_action_id == awaiting.plan_action_id
        && lease.operation_id == awaiting.operation_id
}

fn authorization_matches_awaiting_subject(
    authorization: &AuthorizationIdentityV2,
    awaiting: &CapabilityAwaitingIdentityV2,
) -> bool {
    authorization.run_id == awaiting.run_id
        && authorization.control_epoch == awaiting.control_epoch
        && authorization.plan_revision == awaiting.plan_revision
        && authorization.plan_action_id == awaiting.plan_action_id
        && authorization.operation_id == awaiting.operation_id
}

fn authorization_resolution_edge_matches(
    predecessor: &AuthorizationFactV2,
    current: &AuthorizationFactV2,
) -> bool {
    match (predecessor, current) {
        (
            AuthorizationFactV2::ScopePreviewed {
                identity: source,
                preview_id,
                tool_id,
                scope_digest,
                tool_contract_digest,
                context_ref,
                ..
            },
            AuthorizationFactV2::CapabilityIssued {
                identity,
                tool_id: issued_tool_id,
                scope_digest: issued_scope_digest,
                tool_contract_digest: issued_tool_contract_digest,
                context_ref: issued_context_ref,
                ..
            },
        ) => {
            lease_matches_authorization_subject(identity, source)
                && identity.preview_id == *preview_id
                && issued_tool_id == tool_id
                && issued_scope_digest == scope_digest
                && issued_tool_contract_digest == tool_contract_digest
                && issued_context_ref == context_ref
        }
        (
            AuthorizationFactV2::CapabilityAwaiting {
                identity: source,
                preview_id,
                tool_id,
                scope_digest,
                tool_contract_digest,
                context_ref,
                ..
            },
            AuthorizationFactV2::CapabilityIssued {
                identity,
                tool_id: issued_tool_id,
                scope_digest: issued_scope_digest,
                tool_contract_digest: issued_tool_contract_digest,
                context_ref: issued_context_ref,
                ..
            },
        ) => {
            lease_matches_awaiting_subject(identity, source)
                && identity.preview_id == *preview_id
                && issued_tool_id == tool_id
                && issued_scope_digest == scope_digest
                && issued_tool_contract_digest == tool_contract_digest
                && issued_context_ref == context_ref
        }
        (
            AuthorizationFactV2::ScopePreviewed {
                identity: source,
                preview_id,
                tool_id,
                scope_digest,
                ..
            },
            AuthorizationFactV2::CapabilityDenied {
                identity,
                preview_id: denied_preview_id,
                tool_id: denied_tool_id,
                scope_digest: denied_scope_digest,
                ..
            },
        ) => {
            same_authorization_subject(identity, source)
                && denied_preview_id == preview_id
                && denied_tool_id == tool_id
                && denied_scope_digest == scope_digest
        }
        (
            AuthorizationFactV2::CapabilityAwaiting {
                identity: source,
                preview_id,
                tool_id,
                scope_digest,
                ..
            },
            AuthorizationFactV2::CapabilityDenied {
                identity,
                preview_id: denied_preview_id,
                tool_id: denied_tool_id,
                scope_digest: denied_scope_digest,
                ..
            },
        ) => {
            authorization_matches_awaiting_subject(identity, source)
                && denied_preview_id == preview_id
                && denied_tool_id == tool_id
                && denied_scope_digest == scope_digest
        }
        (
            AuthorizationFactV2::ScopePreviewed {
                identity: source,
                preview_id,
                scope_digest,
                ..
            },
            AuthorizationFactV2::ExpansionAllowed {
                identity,
                expanded_scope_digest,
                ..
            },
        ) => {
            lease_matches_authorization_subject(identity, source)
                && identity.preview_id == *preview_id
                && expanded_scope_digest == scope_digest
        }
        (
            AuthorizationFactV2::CapabilityAwaiting {
                identity: source,
                preview_id,
                scope_digest,
                ..
            },
            AuthorizationFactV2::ExpansionAllowed {
                identity,
                expanded_scope_digest,
                ..
            },
        ) => {
            lease_matches_awaiting_subject(identity, source)
                && identity.preview_id == *preview_id
                && expanded_scope_digest == scope_digest
        }
        (
            AuthorizationFactV2::ScopePreviewed {
                identity: source,
                preview_id,
                scope_digest,
                ..
            },
            AuthorizationFactV2::ExpansionDenied {
                identity,
                preview_id: denied_preview_id,
                requested_scope_digest,
                ..
            },
        ) => {
            same_authorization_subject(identity, source)
                && denied_preview_id == preview_id
                && requested_scope_digest == scope_digest
        }
        (
            AuthorizationFactV2::CapabilityAwaiting {
                identity: source,
                preview_id,
                scope_digest,
                ..
            },
            AuthorizationFactV2::ExpansionDenied {
                identity,
                preview_id: denied_preview_id,
                requested_scope_digest,
                ..
            },
        ) => {
            authorization_matches_awaiting_subject(identity, source)
                && denied_preview_id == preview_id
                && requested_scope_digest == scope_digest
        }
        _ => false,
    }
}

fn edge_kind_matches(predecessor: &KernelFactPayloadV2, current: &KernelFactPayloadV2) -> bool {
    match current {
        KernelFactPayloadV2::Control(ControlFactV2::RunOpened {
            control_epoch,
            ..
        }) => matches!(
            predecessor,
            KernelFactPayloadV2::Control(ControlFactV2::EpochAdvanced {
                identity,
                ..
            }) if identity.control_epoch == *control_epoch
        ),
        KernelFactPayloadV2::Authorization(
            deepcode_kernel_abi::v2::AuthorizationFactV2::ScopePreviewed { .. },
        ) => matches!(
            predecessor,
            KernelFactPayloadV2::Control(ControlFactV2::EpochAdvanced { .. })
                | KernelFactPayloadV2::Authorization(
                    deepcode_kernel_abi::v2::AuthorizationFactV2::ContextInvalidated { .. }
                )
        ),
        KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityAwaiting {
            identity,
            preview_id,
            tool_id,
            canonical_arguments_digest,
            scope_digest,
            tool_contract_digest,
            context_ref,
        }) => match predecessor {
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::ScopePreviewed {
                identity: source,
                preview_id: source_preview_id,
                tool_id: source_tool_id,
                canonical_arguments_digest: source_arguments_digest,
                scope_digest: source_scope_digest,
                tool_contract_digest: source_tool_contract_digest,
                context_ref: source_context_ref,
                ..
            }) => {
                authorization_matches_awaiting_subject(source, identity)
                    && preview_id == source_preview_id
                    && tool_id == source_tool_id
                    && canonical_arguments_digest == source_arguments_digest
                    && scope_digest == source_scope_digest
                    && tool_contract_digest == source_tool_contract_digest
                    && context_ref == source_context_ref
            }
            _ => false,
        },
        KernelFactPayloadV2::Authorization(current)
            if matches!(
                current,
                AuthorizationFactV2::CapabilityIssued { .. }
                    | AuthorizationFactV2::CapabilityDenied { .. }
                    | AuthorizationFactV2::ExpansionAllowed { .. }
                    | AuthorizationFactV2::ExpansionDenied { .. }
            ) =>
        {
            match predecessor {
                KernelFactPayloadV2::Authorization(predecessor) => {
                    authorization_resolution_edge_matches(predecessor, current)
                }
                _ => false,
            }
        }
        KernelFactPayloadV2::Authorization(
            deepcode_kernel_abi::v2::AuthorizationFactV2::TrustGranted { .. },
        ) => matches!(
            predecessor,
            KernelFactPayloadV2::Authorization(
                deepcode_kernel_abi::v2::AuthorizationFactV2::ScopePreviewed { .. }
            )
        ),
        KernelFactPayloadV2::Authorization(
            deepcode_kernel_abi::v2::AuthorizationFactV2::TrustRevoked { .. },
        ) => matches!(
            predecessor,
            KernelFactPayloadV2::Authorization(
                deepcode_kernel_abi::v2::AuthorizationFactV2::TrustGranted { .. }
            )
        ),
        KernelFactPayloadV2::Authorization(
            deepcode_kernel_abi::v2::AuthorizationFactV2::LeaseRevoked { .. }
                | deepcode_kernel_abi::v2::AuthorizationFactV2::LeaseSuperseded { .. },
        ) => matches!(
            predecessor,
            KernelFactPayloadV2::Authorization(
                deepcode_kernel_abi::v2::AuthorizationFactV2::CapabilityIssued { .. }
                    | deepcode_kernel_abi::v2::AuthorizationFactV2::ExpansionAllowed { .. }
            )
        ),
        KernelFactPayloadV2::Authorization(
            deepcode_kernel_abi::v2::AuthorizationFactV2::ContextInvalidated { .. },
        ) => matches!(
            predecessor,
            KernelFactPayloadV2::Control(ControlFactV2::EpochAdvanced { .. })
                | KernelFactPayloadV2::Authorization(_)
        ),
        KernelFactPayloadV2::Authorization(_) => false,
        KernelFactPayloadV2::Control(ControlFactV2::EpochAdvanced { .. }) => {
            command_edge(predecessor, MutationCommandKindV2::ControlEpochAdvance)
        }
        KernelFactPayloadV2::Control(ControlFactV2::RunTerminated { .. }) => {
            command_edge(predecessor, MutationCommandKindV2::RunTerminate)
        }
        KernelFactPayloadV2::Control(ControlFactV2::CancellationRequested { source, .. }) => {
            match source {
                CancellationSourceV2::ExplicitCommand => {
                    command_edge(predecessor, MutationCommandKindV2::InvocationCancel)
                }
                CancellationSourceV2::EpochAdvance => matches!(
                    predecessor,
                    KernelFactPayloadV2::Control(ControlFactV2::EpochAdvanced { .. })
                ),
                CancellationSourceV2::RunTermination => matches!(
                    predecessor,
                    KernelFactPayloadV2::Control(ControlFactV2::RunTerminated { .. })
                ),
            }
        }
        KernelFactPayloadV2::Grant(GrantFactV2::Issued { .. })
        | KernelFactPayloadV2::Grant(GrantFactV2::Denied { .. }) => {
            command_edge(predecessor, MutationCommandKindV2::GrantDecisionSubmit)
        }
        KernelFactPayloadV2::Grant(GrantFactV2::Revoked { .. }) => {
            command_edge(predecessor, MutationCommandKindV2::GrantRevoke)
        }
        KernelFactPayloadV2::Grant(GrantFactV2::Superseded { .. }) => matches!(
            predecessor,
            KernelFactPayloadV2::Control(
                ControlFactV2::EpochAdvanced { .. } | ControlFactV2::RunTerminated { .. }
            )
        ),
        KernelFactPayloadV2::Invocation(
            InvocationFactV2::Admitted { .. } | InvocationFactV2::Rejected { .. },
        ) => command_edge(predecessor, MutationCommandKindV2::InvocationSubmit),
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolIntentAdmitted { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded { .. })
                    | KernelFactPayloadV2::Authorization(
                        AuthorizationFactV2::CapabilityIssued { .. }
                            | AuthorizationFactV2::ExpansionAllowed { .. }
                    )
            )
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolAttemptPrepared { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Invocation(
                    InvocationFactV2::ToolIntentAdmitted { .. }
                )
            )
        }
        KernelFactPayloadV2::Grant(GrantFactV2::Reserved { .. }) => matches!(
            predecessor,
            KernelFactPayloadV2::Invocation(InvocationFactV2::Admitted { .. })
        ),
        KernelFactPayloadV2::Invocation(InvocationFactV2::AttemptPrepared { .. }) => matches!(
            predecessor,
            KernelFactPayloadV2::Grant(GrantFactV2::Reserved { .. })
        ),
        KernelFactPayloadV2::Resource(ResourceFactV2::ResolvedForInvocation { .. }) => matches!(
            predecessor,
            KernelFactPayloadV2::Invocation(
                InvocationFactV2::AttemptPrepared { .. }
                    | InvocationFactV2::ToolAttemptPrepared { .. }
            )
        ),
        KernelFactPayloadV2::Resource(ResourceFactV2::RevalidatedBeforeEffect { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Resource(ResourceFactV2::ResolvedForInvocation { .. })
            )
        }
        KernelFactPayloadV2::Grant(GrantFactV2::Consumed { .. })
        | KernelFactPayloadV2::Invocation(InvocationFactV2::FailedBeforeEffect { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Invocation(InvocationFactV2::AttemptPrepared { .. })
            )
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ExecutionStarted { .. }) => matches!(
            predecessor,
            KernelFactPayloadV2::Grant(GrantFactV2::Consumed { .. })
        ),
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolExecutionStarted { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Invocation(
                    InvocationFactV2::ToolAttemptPrepared { .. }
                ) | KernelFactPayloadV2::Resource(
                    ResourceFactV2::RevalidatedBeforeEffect { .. }
                )
            )
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::CancellationObserved { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Control(ControlFactV2::CancellationRequested { .. })
            )
        }
        KernelFactPayloadV2::Invocation(
            InvocationFactV2::ToolCancellationObserved { .. },
        ) => matches!(
            predecessor,
            KernelFactPayloadV2::Control(ControlFactV2::CancellationRequested { .. })
        ),
        KernelFactPayloadV2::Invocation(InvocationFactV2::DeadlineObserved { .. }) => matches!(
            predecessor,
            KernelFactPayloadV2::Invocation(InvocationFactV2::Admitted { .. })
        ),
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolDeadlineObserved { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Invocation(
                    InvocationFactV2::ToolIntentAdmitted { .. }
                )
            )
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::CancelledBeforeEffect { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Invocation(InvocationFactV2::CancellationObserved { .. })
            )
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::TimedOutBeforeEffect { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Invocation(InvocationFactV2::DeadlineObserved { .. })
            )
        }
        KernelFactPayloadV2::Invocation(
            InvocationFactV2::ToolCancelledBeforeEffect { .. },
        ) => matches!(
            predecessor,
            KernelFactPayloadV2::Invocation(
                InvocationFactV2::ToolCancellationObserved { .. }
            )
        ),
        KernelFactPayloadV2::Invocation(
            InvocationFactV2::ToolTimedOutBeforeEffect { .. },
        ) => matches!(
            predecessor,
            KernelFactPayloadV2::Invocation(
                InvocationFactV2::ToolDeadlineObserved { .. }
            )
        ),
        KernelFactPayloadV2::Invocation(
            InvocationFactV2::ToolFailedBeforeEffect { .. },
        ) => matches!(
            predecessor,
            KernelFactPayloadV2::Invocation(
                InvocationFactV2::ToolAttemptPrepared { .. }
            )
        ),
        KernelFactPayloadV2::Effect(_) => matches!(
            predecessor,
            KernelFactPayloadV2::Invocation(
                InvocationFactV2::ExecutionStarted { .. }
                    | InvocationFactV2::ToolExecutionStarted { .. }
            )
        ),
        KernelFactPayloadV2::Invocation(
            InvocationFactV2::Completed { .. }
            | InvocationFactV2::FailedAfterObservedEffect { .. }
            | InvocationFactV2::Indeterminate { .. },
        ) => matches!(predecessor, KernelFactPayloadV2::Effect(_)),
        KernelFactPayloadV2::Invocation(
            InvocationFactV2::ToolCompleted { .. }
            | InvocationFactV2::ToolFailedAfterObservedEffect { .. }
            | InvocationFactV2::ToolIndeterminate { .. },
        ) => matches!(predecessor, KernelFactPayloadV2::Effect(_)),
        KernelFactPayloadV2::Grant(GrantFactV2::ReservationReleased { .. }) => matches!(
            predecessor,
            KernelFactPayloadV2::Invocation(
                InvocationFactV2::FailedBeforeEffect { .. }
                    | InvocationFactV2::CancelledBeforeEffect { .. }
                    | InvocationFactV2::TimedOutBeforeEffect { .. }
            )
        ),
        KernelFactPayloadV2::Resource(
            ResourceFactV2::Acquired { .. } | ResourceFactV2::Released { .. },
        )
        | KernelFactPayloadV2::Cleanup(_)
        | KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded { .. }) => false,
    }
}

fn command_edge(predecessor: &KernelFactPayloadV2, expected: MutationCommandKindV2) -> bool {
    matches!(
        predecessor,
        KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded {
            command_kind,
            ..
        }) if *command_kind == expected
    )
}

#[cfg(target_os = "macos")]
const CURRENT_PLATFORM: PlatformV2 = PlatformV2::Macos;
#[cfg(target_os = "linux")]
const CURRENT_PLATFORM: PlatformV2 = PlatformV2::Linux;
#[cfg(target_os = "windows")]
const CURRENT_PLATFORM: PlatformV2 = PlatformV2::Windows;
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
compile_error!("Kernel v2 authority supports macOS, Linux, and Windows");
