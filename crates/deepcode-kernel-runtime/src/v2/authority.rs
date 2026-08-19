use super::model::{
    invocation_phase_is_terminal, AuthorityResult, AuthorityRunRetirementFence, AuthorityState,
    AuthorizationTargetKey, DirectInvocationRecord, ExecutionResolution, InvocationPhase,
    PreparedDirectToolIntent, RawExecution, ResolvedTarget, ResourceRecord, RunRecord, StopOverlay,
    VerifiedExecution, WorkspaceBinding,
};
use crate::executors::{plan_v2_text_edit, KernelExecutorConfig};
use crate::network_policy::review_http_target;
use deepcode_kernel_abi::v2::{
    collection_digest_v2, content_digest_v2, executor_evidence_digest_v2, idempotency_key_hash_v2,
    network_response_digest_v2, network_target_digest_v2, query_digest_v2,
    resource_state_digest_v2, target_revalidation_digest_v2, target_revalidation_set_digest_v2,
    workspace_binding_digest_v2, AuthorizationFactV2, AuthorizationIdentityV2, CancelRequestId,
    CancellationIdentityV2, CancellationReasonCodeV2, CancellationSourceV2,
    CanonicalPrivateTargetV2, CapabilityAwaitingIdentityV2, CapabilityLeaseFactIdentityV2,
    CommandEpochContextV2, CommandReceiptIdentityV2, CommandRequestDigestV2, CommandRequestId,
    CommandRequestIdentityV2, ControlEpoch, ControlFactV2, CorrelationRefV2, CorrelationSetV2,
    DeletionBeforeObservationV2, DirectoryBeforeObservationV2, EffectEvidenceV2, EffectFactV2,
    EffectId, ExecutorEvidenceDigestV2, FactId, FileBeforeObservationV2, IndeterminateReasonV2,
    InvocationAuthorityV2, InvocationFactV2, InvocationId, KernelFactDraftV2, KernelFactEnvelopeV2,
    KernelFactPayloadV2, LastObservationV2, MutationCommandResultV2, NetworkAddressV2,
    NetworkHostV2, NetworkOriginV2, NetworkQueryV2, NetworkRequestTargetV2, NetworkSchemeV2,
    NetworkTargetObservationDigestV2, OperationId, PlatformV2, PostObservedEffectFailureCodeV2,
    PreEffectFailureCodeV2, PresentFileObservationV2, RepositoryAreaV2, ResolvedResourceV2,
    ResourceAccessV2, ResourceAttemptIdentityV2, ResourceFactV2, ResourceId,
    ResourceResolvedIdentityV2, ResourceScopeV2, ResourceStateV2, RunId,
    TargetRevalidationDigestV2, TargetRevalidationObservationV2, TargetRevalidationSetDigestV2,
    ToolAttemptIdentityV2, ToolEffectIdentityV2, ToolObservedTerminalIdentityV2,
    TransitionIdentityV2, WorkspaceObjectKindV2, WorkspaceScopeTargetV2,
};
use deepcode_kernel_abi::v2_command::{
    CapabilityScopePreviewOriginV3, ControlCancellationReplyV2, ControlEpochAdvanceV2,
    ControlEpochAdvancedReplyV2, DeadlineRequestV2, EpochPreconditionV2, InvalidFieldViolationV2,
    InvalidRequestReasonV2, InvocationCancelReplyV2, InvocationCancelV2, KernelErrorV2,
    MutationCommandKindV2, RecordedCommandErrorV2, StorageFaultCodeV2, ToolIntentSubmitReplyV2,
};
use deepcode_kernel_abi::{CanonicalArgumentsDigestV2, KernelError, ToolContractDigestV2};
use deepcode_kernel_abi::{RequestedResourceV2, ToolEffectScopeV2, ToolIdV2};
use deepcode_kernel_tools::kernel_internal::{
    measure_kernel_output_payload, normalize_canonical_platform_path,
    validate_canonical_invocation, KernelCanonicalInvocation, KernelDeleteTarget,
    KernelDocumentPages, KernelLineRange, KernelNetworkPublicTarget, KernelOutputTruncation,
    KernelPathEntry, KernelPathEntrySize, KernelSearchMatch, KernelSearchStrategy,
    KernelTextMediaType, KernelToolKind, KernelToolOutput, KernelToolOutputPayload,
    KernelWebSearchItem, KernelWorkspaceObjectKind,
};
use deepcode_kernel_tools::KernelToolRegistry;
use std::collections::HashMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Component, Path, PathBuf};

pub(super) enum PrepareFailure {
    Kernel(KernelErrorV2),
    Target(TargetResolutionFailure),
}

#[derive(Debug, Clone, Copy)]
pub(super) enum TargetResolutionFailure {
    AlreadyExists,
    NetworkTargetRejected,
    NotFound,
    ResolverUnavailable,
    SymlinkPolicyViolation,
    WrongObjectKind,
}

pub(super) const fn exact_epoch(control_epoch: ControlEpoch) -> CommandEpochContextV2 {
    CommandEpochContextV2::Exact { control_epoch }
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

pub(super) fn prepare_failure_error(
    field_path: impl Into<String>,
    failure: PrepareFailure,
) -> KernelErrorV2 {
    match failure {
        PrepareFailure::Kernel(error) => error,
        PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable) => storage_fault(),
        PrepareFailure::Target(TargetResolutionFailure::SymlinkPolicyViolation) => {
            invalid_field(field_path, InvalidFieldViolationV2::PathEscapesWorkspace)
        }
        PrepareFailure::Target(
            TargetResolutionFailure::AlreadyExists
            | TargetResolutionFailure::NetworkTargetRejected
            | TargetResolutionFailure::NotFound
            | TargetResolutionFailure::WrongObjectKind,
        ) => invalid_field(field_path, InvalidFieldViolationV2::OutOfRange),
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
        .direct_invocations
        .get(&invocation_id)
        .map(|invocation| &invocation.stop_overlay)
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
    if run.retirement_fence.is_some() || run.retired.is_some() {
        return Err(KernelErrorV2::RunNotFound {
            run_id: run_id.clone(),
        });
    }
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
    let Ok(new_epoch) = ControlEpoch::new(next) else {
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
        new_epoch,
    })
}

pub(super) fn resolve_workspace_binding(path: &Path) -> AuthorityResult<WorkspaceBinding> {
    let canonical_root = fs::canonicalize(path)
        .map_err(|_| invalid_field("workspaceRoot", InvalidFieldViolationV2::OutOfRange))?;
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
    let canonical_root_utf8 = normalize_canonical_platform_path(platform, raw)
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

pub(super) fn prepare_direct_tool_intent(
    run_id: &RunId,
    operation_id: &OperationId,
    control_epoch: ControlEpoch,
    idempotency_key: &str,
    canonical_invocation: &KernelCanonicalInvocation,
    deadline: DeadlineRequestV2,
    correlation_refs: Vec<CorrelationRefV2>,
    registry: &KernelToolRegistry,
    workspace: &WorkspaceBinding,
    executor_config: &KernelExecutorConfig,
) -> Result<PreparedDirectToolIntent, PrepareFailure> {
    validate_canonical_invocation(canonical_invocation)
        .map_err(|_| invalid_field("canonicalInvocation", InvalidFieldViolationV2::OutOfRange))?;
    let tool_id = canonical_invocation.tool_id();
    let tool_id_v2 = ToolIdV2::parse(tool_id.as_str()).map_err(|_| {
        PrepareFailure::Kernel(invalid_field("toolId", InvalidFieldViolationV2::OutOfRange))
    })?;
    let Some(admission) = registry.kernel_internal_admission_metadata(&tool_id_v2) else {
        return Err(PrepareFailure::Kernel(invalid_field(
            "toolId",
            InvalidFieldViolationV2::OutOfRange,
        )));
    };
    let effective_deadline_ms = materialize_deadline(
        deadline,
        admission.default_deadline_ms,
        admission.maximum_deadline_ms,
    )?;
    let correlations = CorrelationSetV2::materialize(correlation_refs)
        .map_err(|_| invalid_field("correlationRefs", InvalidFieldViolationV2::Unsorted))?;
    let idempotency_key_hash = idempotency_key_hash_v2(run_id, idempotency_key)
        .map_err(|_| invalid_field("idempotencyKey", InvalidFieldViolationV2::OutOfRange))?;
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

pub(super) fn prepare_direct_effect(
    invocation: &KernelCanonicalInvocation,
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
    invocation: &KernelCanonicalInvocation,
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
            let tool_id = ToolIdV2::parse(invocation.tool_id().as_str())
                .map_err(|_| PreEffectFailureCodeV2::TargetRevalidationFailed)?;
            let digest = target_revalidation_digest_v2(
                run_id,
                operation_id,
                invocation_id,
                attempt_id,
                &tool_id,
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
    invocation: &KernelCanonicalInvocation,
    targets: &[ResolvedTarget],
) -> Result<(serde_json::Value, Option<Vec<u8>>), ()> {
    use KernelCanonicalInvocation as Input;
    let value = match invocation {
        Input::FsRead { path, range } => {
            let mut value = serde_json::json!({"path":path});
            if let KernelLineRange::Lines {
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
                KernelSearchStrategy::Literal => "literal",
                KernelSearchStrategy::Regex => "regex",
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
        Input::FsDelete(KernelDeleteTarget::File { path }) => {
            serde_json::json!({"path":path,"targetKind":"file","recursive":false})
        }
        Input::FsDelete(KernelDeleteTarget::DirectoryTree { path }) => {
            serde_json::json!({"path":path,"targetKind":"directory","recursive":true})
        }
        Input::FsEnsureDirectory { path } => serde_json::json!({"path":path}),
        Input::DocumentRead { path, pages } => {
            let mut value = serde_json::json!({"path":path});
            if let KernelDocumentPages::Range {
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
    invocation: &KernelCanonicalInvocation,
    target: &ResolvedTarget,
    expected_edit: Option<&[u8]>,
) -> Result<TargetRevalidationObservationV2, PreEffectFailureCodeV2> {
    use KernelCanonicalInvocation as Input;
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
    invocation: &KernelCanonicalInvocation,
    preparation: &EffectPreparation,
    raw: Result<RawExecution, ()>,
    workspace: &WorkspaceBinding,
    maximum_output_bytes: u32,
) -> ExecutionResolution {
    use KernelCanonicalInvocation as Input;
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
            KernelTextMediaType::TextPlainUtf8,
            raw.output
                .get("content")
                .and_then(serde_json::Value::as_str),
            maximum_output_bytes,
        ),
        Input::FsDiff { .. } => utf8_output(
            invocation.tool_id(),
            KernelTextMediaType::TextDiffUtf8,
            raw.output.get("diff").and_then(serde_json::Value::as_str),
            maximum_output_bytes,
        ),
        Input::DocumentRead { .. } => utf8_output(
            invocation.tool_id(),
            KernelTextMediaType::TextDocumentUtf8,
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
            let KernelToolOutputPayload::PathEntries { entries } =
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
    let Ok(output) = serde_json::to_value(output) else {
        return indeterminate(LastObservationV2::None {});
    };
    ExecutionResolution::Completed(VerifiedExecution { output, evidence })
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
    invocation: &KernelCanonicalInvocation,
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
            KernelCanonicalInvocation::FsCreate { .. }
            | KernelCanonicalInvocation::FsWrite { .. }
            | KernelCanonicalInvocation::FsEdit { .. },
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
            KernelCanonicalInvocation::FsEnsureDirectory { .. },
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
            KernelCanonicalInvocation::FsDelete(_),
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
            KernelToolOutputPayload::NoPrimaryContent {},
            maximum_output_bytes,
        )
        .expect("no-primary-content output is bounded");
        let output =
            serde_json::to_value(output).expect("KernelToolOutput serializes to a JSON value");
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
    tool_id: KernelToolKind,
    media_type: KernelTextMediaType,
    text: Option<&str>,
    budget: u32,
) -> Option<KernelToolOutput> {
    bounded_output(
        tool_id,
        KernelToolOutputPayload::Utf8Text {
            media_type,
            text: text?.to_owned(),
        },
        budget,
    )
}

fn path_entries_from_nodes(
    tool_id: KernelToolKind,
    nodes: Option<&serde_json::Value>,
    budget: u32,
) -> Option<KernelToolOutput> {
    fn visit(value: &serde_json::Value, output: &mut Vec<KernelPathEntry>) -> Option<()> {
        for node in value.as_array()? {
            let kind = match node.get("type")?.as_str()? {
                "file" => KernelWorkspaceObjectKind::File,
                "directory" => KernelWorkspaceObjectKind::Directory,
                _ => return None,
            };
            output.push(KernelPathEntry {
                relative_path: node.get("path")?.as_str()?.to_owned(),
                kind,
                size: node
                    .get("sizeBytes")
                    .and_then(serde_json::Value::as_u64)
                    .map(|value| KernelPathEntrySize::Bytes { value })
                    .unwrap_or(KernelPathEntrySize::Unavailable {}),
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
        KernelToolOutputPayload::PathEntries { entries },
        budget,
    )
}

fn path_entries_from_glob(
    tool_id: KernelToolKind,
    matches: Option<&serde_json::Value>,
    workspace: &Path,
    budget: u32,
) -> Option<KernelToolOutput> {
    let mut entries = matches?
        .as_array()?
        .iter()
        .map(|value| {
            let relative_path = value.as_str()?.to_owned();
            let metadata = fs::metadata(workspace.join(&relative_path)).ok()?;
            Some(KernelPathEntry {
                relative_path,
                kind: if metadata.is_dir() {
                    KernelWorkspaceObjectKind::Directory
                } else if metadata.is_file() {
                    KernelWorkspaceObjectKind::File
                } else {
                    return None;
                },
                size: KernelPathEntrySize::Bytes {
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
        KernelToolOutputPayload::PathEntries { entries },
        budget,
    )
}

fn search_matches_output(
    tool_id: KernelToolKind,
    raw: Option<&serde_json::Value>,
    query: &str,
    strategy: KernelSearchStrategy,
    budget: u32,
) -> Option<KernelToolOutput> {
    let regex = matches!(strategy, KernelSearchStrategy::Regex)
        .then(|| regex::Regex::new(query).ok())
        .flatten();
    let matches = raw?
        .as_array()?
        .iter()
        .map(|value| {
            let preview = value.get("preview")?.as_str()?.to_owned();
            let start = match strategy {
                KernelSearchStrategy::Literal => preview.find(query),
                KernelSearchStrategy::Regex => {
                    regex.as_ref()?.find(&preview).map(|value| value.start())
                }
            }?;
            Some(KernelSearchMatch {
                relative_path: value.get("path")?.as_str()?.to_owned(),
                line: u32::try_from(value.get("line")?.as_u64()?).ok()?,
                column: u32::try_from(preview[..start].chars().count() + 1).ok()?,
                preview,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    bounded_output(
        tool_id,
        KernelToolOutputPayload::SearchMatches { matches },
        budget,
    )
}

fn web_search_output(
    tool_id: KernelToolKind,
    raw: Option<&serde_json::Value>,
    budget: u32,
) -> Option<KernelToolOutput> {
    let items = raw?
        .as_array()?
        .iter()
        .map(|value| {
            Some(KernelWebSearchItem {
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
        KernelToolOutputPayload::WebSearchResults { items },
        budget,
    )
}

fn web_response_output(
    tool_id: KernelToolKind,
    raw: &RawExecution,
    revalidation: &PreparedRevalidation,
    budget: u32,
) -> Option<KernelToolOutput> {
    let ResolvedResourceV2::NetworkEndpoint {
        origin,
        target_observation_digest,
    } = &revalidation.target.public_resource
    else {
        return None;
    };
    bounded_output(
        tool_id,
        KernelToolOutputPayload::WebResponse {
            status_code: raw.http_status_code?,
            final_target: KernelNetworkPublicTarget {
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
    invocation: &KernelCanonicalInvocation,
    raw: &RawExecution,
    workspace: &WorkspaceBinding,
) -> Option<KernelToolOutputPayload> {
    match invocation {
        KernelCanonicalInvocation::FsList { .. } => {
            let output =
                path_entries_from_nodes(invocation.tool_id(), raw.output.get("nodes"), u32::MAX)?;
            Some(output.payload)
        }
        KernelCanonicalInvocation::FsGlob { .. } => {
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
    tool_id: KernelToolKind,
    complete: KernelToolOutputPayload,
    maximum_bytes: u32,
) -> Option<KernelToolOutput> {
    let complete_output = measure_kernel_output_payload(tool_id, complete).ok()?;
    let maximum = maximum_bytes as usize;
    if complete_output.total_bytes <= maximum as u64 {
        return Some(complete_output);
    }
    let retained = truncate_payload_to_budget(&complete_output.payload, maximum)?;
    let retained_bytes = serde_json::to_vec(&retained).ok()?.len() as u64;
    Some(KernelToolOutput {
        full_digest: complete_output.full_digest,
        total_bytes: complete_output.total_bytes,
        truncation: KernelOutputTruncation::Truncated { retained_bytes },
        payload: retained,
    })
}

fn truncate_payload_to_budget(
    complete: &KernelToolOutputPayload,
    maximum: usize,
) -> Option<KernelToolOutputPayload> {
    match complete {
        KernelToolOutputPayload::Utf8Text { media_type, text } => {
            truncate_text(text, maximum, |text| KernelToolOutputPayload::Utf8Text {
                media_type: *media_type,
                text,
            })
        }
        KernelToolOutputPayload::WebResponse {
            status_code,
            content_type,
            body,
            final_target,
        } => truncate_text(body, maximum, |body| KernelToolOutputPayload::WebResponse {
            status_code: *status_code,
            content_type: content_type.clone(),
            body,
            final_target: final_target.clone(),
        }),
        KernelToolOutputPayload::PathEntries { entries } => {
            truncate_items(entries, maximum, |entries| {
                KernelToolOutputPayload::PathEntries { entries }
            })
        }
        KernelToolOutputPayload::SearchMatches { matches } => {
            truncate_items(matches, maximum, |matches| {
                KernelToolOutputPayload::SearchMatches { matches }
            })
        }
        KernelToolOutputPayload::WebSearchResults { items } => {
            truncate_items(items, maximum, |items| {
                KernelToolOutputPayload::WebSearchResults { items }
            })
        }
        KernelToolOutputPayload::NoPrimaryContent {} => None,
    }
}

fn truncate_text(
    text: &str,
    maximum: usize,
    build: impl Fn(String) -> KernelToolOutputPayload,
) -> Option<KernelToolOutputPayload> {
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
    build: impl Fn(Vec<T>) -> KernelToolOutputPayload,
) -> Option<KernelToolOutputPayload> {
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

fn serialized_fits(payload: &KernelToolOutputPayload, maximum: usize) -> Option<bool> {
    Some(serde_json::to_vec(payload).ok()?.len() <= maximum)
}

pub(super) fn materialize_deadline(
    request: DeadlineRequestV2,
    default_ms: u32,
    maximum_ms: u32,
) -> Result<u32, PrepareFailure> {
    match request {
        DeadlineRequestV2::ContractDefault {} => Ok(default_ms),
        DeadlineRequestV2::ExactMilliseconds { value } if value > 0 && value <= maximum_ms => {
            Ok(value)
        }
        DeadlineRequestV2::ExactMilliseconds { value } => {
            Err(PrepareFailure::Kernel(KernelErrorV2::InvalidRequest {
                reason: InvalidRequestReasonV2::DeadlineOutOfContract {
                    requested_ms: value,
                    maximum_ms,
                },
            }))
        }
    }
}

fn resolve_invocation_targets(
    invocation: &KernelCanonicalInvocation,
    workspace: &WorkspaceBinding,
    executor_config: &KernelExecutorConfig,
) -> Result<(ResourceScopeV2, Vec<ResolvedTarget>), PrepareFailure> {
    use KernelCanonicalInvocation as Input;
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
        Input::FsDelete(KernelDeleteTarget::File { path }) => Some(WorkspaceTargetSpec::new(
            path,
            ExpectedTarget::MustFile,
            ResourceAccessV2::Write,
        )),
        Input::FsDelete(KernelDeleteTarget::DirectoryTree { path }) => Some(
            WorkspaceTargetSpec::new(path, ExpectedTarget::MustDirectory, ResourceAccessV2::Write),
        ),
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
            return Err(PrepareFailure::Kernel(invalid_field(
                "toolId",
                InvalidFieldViolationV2::OutOfRange,
            )));
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
            .map_err(|_| PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable))?;
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
            TargetResolutionFailure::ResolverUnavailable,
        )),
    }
}

pub(super) fn canonicalize_requested_resource_scope(
    tool_kind: KernelToolKind,
    effect_scope: ToolEffectScopeV2,
    requested_resources: &[RequestedResourceV2],
    workspace: &WorkspaceBinding,
    executor_config: &KernelExecutorConfig,
) -> Result<(ResourceScopeV2, Vec<AuthorizationTargetKey>), PrepareFailure> {
    let invalid_scope = || {
        PrepareFailure::Kernel(invalid_field(
            "scopeIntent.requestedResources",
            InvalidFieldViolationV2::InvalidRelation,
        ))
    };
    match effect_scope {
        ToolEffectScopeV2::WorkspaceRead | ToolEffectScopeV2::WorkspaceWrite => {
            let expected_access = if effect_scope == ToolEffectScopeV2::WorkspaceRead {
                ResourceAccessV2::Read
            } else {
                ResourceAccessV2::Write
            };
            let expected_target = match (effect_scope, tool_kind) {
                (
                    ToolEffectScopeV2::WorkspaceRead,
                    KernelToolKind::DocumentRead | KernelToolKind::FsDiff | KernelToolKind::FsRead,
                ) => ExpectedTarget::MustFile,
                (
                    ToolEffectScopeV2::WorkspaceRead,
                    KernelToolKind::CodeGrep | KernelToolKind::FsGlob | KernelToolKind::FsList,
                ) => ExpectedTarget::MustDirectory,
                (ToolEffectScopeV2::WorkspaceWrite, KernelToolKind::FsCreate) => {
                    ExpectedTarget::MustAbsent(WorkspaceObjectKindV2::File)
                }
                (
                    ToolEffectScopeV2::WorkspaceWrite,
                    KernelToolKind::FsEdit | KernelToolKind::FsWrite,
                ) => ExpectedTarget::MustFile,
                (ToolEffectScopeV2::WorkspaceWrite, KernelToolKind::FsEnsureDirectory) => {
                    ExpectedTarget::DirectoryOrAbsent
                }
                (ToolEffectScopeV2::WorkspaceWrite, KernelToolKind::FsDelete) => {
                    ExpectedTarget::ExistingFileOrDirectory
                }
                _ => return Err(invalid_scope()),
            };
            let mut canonical_targets = Vec::with_capacity(requested_resources.len());
            let mut authorization_targets = Vec::with_capacity(requested_resources.len());
            for requested in requested_resources {
                let RequestedResourceV2::WorkspacePath { path, access } = requested else {
                    return Err(invalid_scope());
                };
                if *access != expected_access {
                    return Err(invalid_scope());
                }
                let resolved = resolve_workspace_target(
                    workspace,
                    WorkspaceTargetSpec::new(path, expected_target.clone(), *access),
                )?;
                let relative_path = resolved
                    .relative_path
                    .clone()
                    .ok_or_else(|| invalid_scope())?;
                let object_kind = resolved.object_kind.ok_or_else(|| invalid_scope())?;
                let target_observation_digest = resolved
                    .state_digest
                    .clone()
                    .ok_or_else(|| invalid_scope())?;
                canonical_targets.push(WorkspaceScopeTargetV2 {
                    relative_path: relative_path.clone(),
                    object_kind,
                    access: *access,
                    target_observation_digest,
                });
                authorization_targets.push(AuthorizationTargetKey::Workspace {
                    path: relative_path,
                    access: *access,
                    object_kind,
                });
            }
            canonical_targets.sort_by(|left, right| {
                left.relative_path
                    .as_bytes()
                    .cmp(right.relative_path.as_bytes())
            });
            canonical_targets.dedup_by(|left, right| {
                left.relative_path == right.relative_path && left.access == right.access
            });
            authorization_targets.sort_by(|left, right| {
                authorization_target_label(left).cmp(&authorization_target_label(right))
            });
            authorization_targets.dedup();
            Ok((
                ResourceScopeV2::Workspace {
                    targets: canonical_targets,
                },
                authorization_targets,
            ))
        }
        ToolEffectScopeV2::RepositoryRead
        | ToolEffectScopeV2::RepositoryIndexWrite
        | ToolEffectScopeV2::RepositoryHistoryWrite => {
            let expected_area = match (effect_scope, tool_kind) {
                (
                    ToolEffectScopeV2::RepositoryRead,
                    KernelToolKind::GitStatus | KernelToolKind::GitDiff,
                ) => RepositoryAreaV2::State,
                (
                    ToolEffectScopeV2::RepositoryIndexWrite,
                    KernelToolKind::GitStage | KernelToolKind::GitUnstage,
                ) => RepositoryAreaV2::Index,
                (ToolEffectScopeV2::RepositoryHistoryWrite, KernelToolKind::GitCommit) => {
                    RepositoryAreaV2::History
                }
                _ => return Err(invalid_scope()),
            };
            let [RequestedResourceV2::Repository { area }] = requested_resources else {
                return Err(invalid_scope());
            };
            if *area != expected_area {
                return Err(invalid_scope());
            }
            Ok((
                ResourceScopeV2::Repository { area: *area },
                vec![AuthorizationTargetKey::Repository { area: *area }],
            ))
        }
        ToolEffectScopeV2::NetworkRead => match tool_kind {
            KernelToolKind::WebFetch => {
                let [RequestedResourceV2::NetworkUrl { url }] = requested_resources else {
                    return Err(invalid_scope());
                };
                let parsed = crate::network_policy::validate_http_url_shape(url).map_err(|_| {
                    PrepareFailure::Target(TargetResolutionFailure::NetworkTargetRejected)
                })?;
                let canonical_url = parsed.to_string();
                let resolved = resolve_network_target(&canonical_url)?;
                Ok((
                    ResourceScopeV2::NetworkUrl {
                        origin: resolved.origin,
                        target_observation_digest: resolved.target_digest.clone(),
                    },
                    vec![AuthorizationTargetKey::NetworkUrl { url: canonical_url }],
                ))
            }
            KernelToolKind::WebSearch => {
                let [RequestedResourceV2::NetworkQuery { query }] = requested_resources else {
                    return Err(invalid_scope());
                };
                let query = query.trim();
                if query.is_empty() || query.chars().any(char::is_control) {
                    return Err(invalid_scope());
                }
                let url = crate::executors::web::web_search_target_url(executor_config, query, 1)
                    .map_err(|_| {
                    PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable)
                })?;
                let resolved = resolve_network_target(&url)?;
                let query_digest = query_digest_v2(&serde_json::json!({
                    "kind":"webSearch",
                    "query":query
                }))
                .map_err(|_| storage_fault())?;
                Ok((
                    ResourceScopeV2::NetworkQuery {
                        query_digest,
                        service_origin: resolved.origin.clone(),
                        target_observation_digest: resolved.target_digest.clone(),
                    },
                    vec![AuthorizationTargetKey::NetworkQuery {
                        query: query.to_owned(),
                        service_origin: resolved.origin,
                    }],
                ))
            }
            _ => Err(invalid_scope()),
        },
    }
}

fn authorization_target_label(target: &AuthorizationTargetKey) -> String {
    match target {
        AuthorizationTargetKey::Workspace {
            path,
            access,
            object_kind,
        } => {
            format!("workspace:{access:?}:{object_kind:?}:{path}")
        }
        AuthorizationTargetKey::Repository { area } => format!("repository:{area:?}"),
        AuthorizationTargetKey::NetworkUrl { url } => format!("network-url:{url}"),
        AuthorizationTargetKey::NetworkQuery {
            query,
            service_origin,
        } => format!("network-query:{query}:{service_origin:?}"),
    }
}

#[derive(Clone)]
enum ExpectedTarget {
    MustFile,
    MustDirectory,
    MustAbsent(WorkspaceObjectKindV2),
    DirectoryOrAbsent,
    ExistingFileOrDirectory,
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
        (ExpectedTarget::ExistingFileOrDirectory, ResourceStateV2::File { .. }) => {
            WorkspaceObjectKindV2::File
        }
        (ExpectedTarget::ExistingFileOrDirectory, ResourceStateV2::Directory { .. }) => {
            WorkspaceObjectKindV2::Directory
        }
        (ExpectedTarget::MustAbsent(kind), ResourceStateV2::Absent {}) => *kind,
        (ExpectedTarget::DirectoryOrAbsent, ResourceStateV2::Absent {})
        | (ExpectedTarget::DirectoryOrAbsent, ResourceStateV2::Directory { .. }) => {
            WorkspaceObjectKindV2::Directory
        }
        (ExpectedTarget::MustAbsent(_), _) => {
            return Err(PrepareFailure::Target(
                TargetResolutionFailure::AlreadyExists,
            ));
        }
        (_, ResourceStateV2::Absent {}) => {
            return Err(PrepareFailure::Target(TargetResolutionFailure::NotFound));
        }
        _ => {
            return Err(PrepareFailure::Target(
                TargetResolutionFailure::WrongObjectKind,
            ));
        }
    };
    let state_digest = resource_state_digest_v2(&state).map_err(|_| storage_fault())?;
    let raw = canonical_target
        .to_str()
        .ok_or_else(|| PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable))?;
    let canonical_absolute_path_utf8 =
        normalize_canonical_platform_path(workspace.platform, raw)
            .map_err(|_| PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable))?;
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
                    TargetResolutionFailure::SymlinkPolicyViolation,
                ));
            }
        }
    }
    let mut existing = candidate.as_path();
    let mut suffix = Vec::new();
    while !existing.exists() {
        let name = existing
            .file_name()
            .ok_or_else(|| PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable))?;
        suffix.push(name.to_os_string());
        existing = existing
            .parent()
            .ok_or_else(|| PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable))?;
    }
    let mut resolved = fs::canonicalize(existing)
        .map_err(|_| PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable))?;
    if !resolved.starts_with(canonical_root) {
        return Err(PrepareFailure::Target(
            TargetResolutionFailure::SymlinkPolicyViolation,
        ));
    }
    for part in suffix.iter().rev() {
        resolved.push(part);
    }
    if candidate.exists() {
        resolved = fs::canonicalize(&candidate)
            .map_err(|_| PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable))?;
        if !resolved.starts_with(canonical_root) {
            return Err(PrepareFailure::Target(
                TargetResolutionFailure::SymlinkPolicyViolation,
            ));
        }
    }
    Ok(resolved)
}

fn resource_state_for_path(path: &Path) -> Result<ResourceStateV2, PrepareFailure> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ResourceStateV2::Absent {});
        }
        Err(_) => {
            return Err(PrepareFailure::Target(
                TargetResolutionFailure::ResolverUnavailable,
            ));
        }
    };
    if metadata.is_file() {
        let bytes = fs::read(path)
            .map_err(|_| PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable))?;
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
        TargetResolutionFailure::WrongObjectKind,
    ))
}

fn collect_path_entries(root: &Path) -> Result<Vec<KernelPathEntry>, PrepareFailure> {
    fn visit(
        root: &Path,
        current: &Path,
        entries: &mut Vec<KernelPathEntry>,
    ) -> Result<(), PrepareFailure> {
        let mut children = fs::read_dir(current)
            .map_err(|_| PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable))?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let path = child.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| {
                PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable)
            })?;
            if metadata.file_type().is_symlink() {
                return Err(PrepareFailure::Target(
                    TargetResolutionFailure::SymlinkPolicyViolation,
                ));
            }
            let relative = path
                .strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .ok_or_else(|| {
                    PrepareFailure::Target(TargetResolutionFailure::ResolverUnavailable)
                })?
                .replace('\\', "/");
            let (kind, size) = if metadata.is_dir() {
                (
                    KernelWorkspaceObjectKind::Directory,
                    KernelPathEntrySize::Unavailable {},
                )
            } else if metadata.is_file() {
                (
                    KernelWorkspaceObjectKind::File,
                    KernelPathEntrySize::Bytes {
                        value: metadata.len(),
                    },
                )
            } else {
                continue;
            };
            entries.push(KernelPathEntry {
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
        .map_err(|_| PrepareFailure::Target(TargetResolutionFailure::NetworkTargetRejected))?;
    let canonical_url = parsed.to_string();
    let resolved = resolve_network_target(&canonical_url)?;
    Ok((canonical_url, resolved.target_digest))
}

fn resolve_network_target(url: &str) -> Result<ResolvedNetwork, PrepareFailure> {
    let parsed = crate::network_policy::validate_http_url_shape(url)
        .map_err(|_| PrepareFailure::Target(TargetResolutionFailure::NetworkTargetRejected))?;
    if parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !parsed
            .host_str()
            .is_some_and(|host| host.is_ascii() && !host.ends_with('.'))
    {
        return Err(PrepareFailure::Target(
            TargetResolutionFailure::NetworkTargetRejected,
        ));
    }
    let reviewed = review_http_target(url).map_err(|error| {
        PrepareFailure::Target(match error {
            KernelError::InvalidCommand(_) | KernelError::PermissionDenied(_) => {
                TargetResolutionFailure::NetworkTargetRejected
            }
            _ => TargetResolutionFailure::ResolverUnavailable,
        })
    })?;
    if reviewed
        .resolved_addresses
        .iter()
        .any(|address| denied_network_address(address.ip()))
    {
        return Err(PrepareFailure::Target(
            TargetResolutionFailure::NetworkTargetRejected,
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
            TargetResolutionFailure::ResolverUnavailable,
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
                TargetResolutionFailure::NetworkTargetRejected,
            ));
        }
    };
    let host_text = parsed
        .host_str()
        .ok_or(PrepareFailure::Target(
            TargetResolutionFailure::NetworkTargetRejected,
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
                TargetResolutionFailure::NetworkTargetRejected,
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
                TargetResolutionFailure::NetworkTargetRejected,
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
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolIntentAdmitted {
                identity: caused_direct_attempt(identity, authorization_fact_id),
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
pub(super) fn epoch_advance_drafts(
    request_id: CommandRequestId,
    request_digest: CommandRequestDigestV2,
    command: ControlEpochAdvanceV2,
    epoch_context: CommandEpochContextV2,
    previous_epoch: Option<ControlEpoch>,
    new_epoch: ControlEpoch,
    command_fact_id: FactId,
    epoch_fact_id: FactId,
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
    if run.retirement_fence.is_some() || run.retired.is_some() {
        return Err(KernelErrorV2::RunNotFound {
            run_id: run_id.clone(),
        });
    }
    if run.epoch != submitted {
        return Err(KernelErrorV2::StaleControlEpoch {
            run_id: run_id.clone(),
            submitted,
            current: run.epoch,
        });
    }
    Ok(())
}

impl AuthorityState {
    pub(super) fn restore(facts: Vec<KernelFactEnvelopeV2>) -> AuthorityResult<Self> {
        let mut state = Self::default();
        for fact in facts {
            state.apply_fact(fact)?;
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
            KernelFactPayloadV2::Authorization(_) | KernelFactPayloadV2::Cleanup(_) => {}
            KernelFactPayloadV2::Invocation(fact) => self.reduce_invocation(&envelope, fact)?,
            KernelFactPayloadV2::Effect(fact) => self.reduce_effect(&envelope, fact)?,
            KernelFactPayloadV2::Resource(fact) => self.reduce_resource(&envelope, fact)?,
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
            ControlFactV2::RunTransportRebound {
                run_id,
                control_epoch,
                ..
            } => {
                let run = self.runs.get(run_id).ok_or_else(corrupt_store)?;
                if run.epoch != *control_epoch
                    || run.retirement_fence.is_some()
                    || run.retired.is_some()
                {
                    return Err(corrupt_store());
                }
            }
            ControlFactV2::CommandRecorded { .. } => {}
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
                            active_invocation_id: None,
                            admitted_inputs,
                            retirement_fence: None,
                            retired: None,
                        },
                    );
                }
                Some(run)
                    if run.retirement_fence.is_none()
                        && run.retired.is_none()
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
                let invocation = self
                    .direct_invocations
                    .get_mut(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                let epoch_matches = match source {
                    CancellationSourceV2::EpochAdvance => {
                        identity.control_epoch > invocation.control_epoch
                    }
                    CancellationSourceV2::ExplicitCommand => {
                        identity.control_epoch == invocation.control_epoch
                    }
                };
                if identity.run_id != invocation.run_id
                    || !epoch_matches
                    || invocation.stop_overlay.cancellation().is_some()
                    || self
                        .runs
                        .get(&identity.run_id)
                        .and_then(|run| run.active_invocation_id.as_ref())
                        != Some(&identity.invocation_id)
                {
                    return Err(corrupt_store());
                }
                invocation.stop_overlay = StopOverlay::CancellationRequested {
                    cancel_request_id: identity.cancel_request_id.clone(),
                    fact_id: envelope.fact_id.clone(),
                    ledger_sequence: envelope.ledger_sequence,
                };
            }
            ControlFactV2::RunRetirementFenced {
                run_id,
                control_epoch,
                reason_code,
                reason,
                ..
            } => {
                let run = self.runs.get_mut(run_id).ok_or_else(corrupt_store)?;
                if run.epoch != *control_epoch
                    || run.retirement_fence.is_some()
                    || run.retired.is_some()
                {
                    return Err(corrupt_store());
                }
                run.retirement_fence = Some(AuthorityRunRetirementFence {
                    fact_id: envelope.fact_id.clone(),
                    ledger_sequence: envelope.ledger_sequence,
                    reason_code: *reason_code,
                    reason: reason.clone(),
                });
            }
            ControlFactV2::RunRetired {
                run_id,
                control_epoch,
                reason_code,
                reason,
                causation_fact_id,
            } => {
                let has_nonterminal_invocation =
                    self.direct_invocations.values().any(|invocation| {
                        invocation.run_id == *run_id
                            && !invocation_phase_is_terminal(invocation.phase)
                    });
                let run = self.runs.get_mut(run_id).ok_or_else(corrupt_store)?;
                let fence = run.retirement_fence.as_ref().ok_or_else(corrupt_store)?;
                if run.epoch != *control_epoch
                    || run.retired.is_some()
                    || run.active_invocation_id.is_some()
                    || has_nonterminal_invocation
                    || fence.fact_id != *causation_fact_id
                    || fence.reason_code != *reason_code
                    || fence.reason != *reason
                {
                    return Err(corrupt_store());
                }
                run.retired = Some(*reason_code);
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
                let private_tool_kind = private_tool_kind(tool_id).ok_or_else(corrupt_store)?;
                if run.epoch != identity.control_epoch
                    || run.retirement_fence.is_some()
                    || run.retired.is_some()
                    || run.active_invocation_id.is_some()
                    || *effective_deadline_ms == 0
                    || self
                        .direct_invocations
                        .contains_key(&identity.invocation_id)
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
                            CorrelationRefV2::PlanAction { value }
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
                        private_tool_kind,
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
            InvocationFactV2::ToolFailedBeforeEffect { identity, .. } => self
                .set_direct_attempt_terminal(
                    identity,
                    InvocationPhase::FailedBeforeEffect,
                    envelope.fact_id.clone(),
                )?,
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
            InvocationFactV2::ToolTimedOutBeforeEffect { identity } => self
                .set_direct_attempt_terminal(
                    identity,
                    InvocationPhase::TimedOutBeforeEffect,
                    envelope.fact_id.clone(),
                )?,
            InvocationFactV2::ToolCompleted { identity, output } => {
                validate_direct_completed_output(self, identity, output)?;
                self.set_direct_observed_terminal(
                    identity,
                    InvocationPhase::Completed,
                    envelope.fact_id.clone(),
                )?
            }
            InvocationFactV2::ToolFailedAfterObservedEffect { identity, .. } => self
                .set_direct_observed_terminal(
                    identity,
                    InvocationPhase::FailedAfterObservedEffect,
                    envelope.fact_id.clone(),
                )?,
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
        }
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
        validate_direct_effect(self, fact)?;
        let identity = direct_effect_identity(fact);
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
                let invocation = self
                    .direct_invocations
                    .get(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if !direct_resolved_identity_matches_invocation(identity, invocation)
                    || !resource_matches_scope(resource, &invocation.resource_scope)
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
                let invocation = self
                    .direct_invocations
                    .get(&identity.invocation_id)
                    .ok_or_else(corrupt_store)?;
                if !direct_resource_attempt_identity_matches_invocation(
                    identity, invocation, resource,
                ) || resource.revalidation.is_some()
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
        }
        Ok(())
    }
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

fn private_tool_kind(tool_id: &ToolIdV2) -> Option<KernelToolKind> {
    crate::kernel_tool_registry().kernel_internal_tool_kind(tool_id)
}

fn expected_resource_count(scope: &ResourceScopeV2) -> AuthorityResult<usize> {
    match scope {
        ResourceScopeV2::Workspace { targets } => Ok(targets.len()),
        ResourceScopeV2::NetworkQuery { .. } | ResourceScopeV2::NetworkUrl { .. } => Ok(1),
        ResourceScopeV2::Repository { .. } => Err(corrupt_store()),
    }
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
            indeterminate_evidence_legal(invocation.private_tool_kind, evidence)
        }
        _ => observed_evidence_legal(invocation.private_tool_kind, evidence),
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

fn observed_evidence_legal(tool_id: KernelToolKind, evidence: &EffectEvidenceV2) -> bool {
    use KernelToolKind as Tool;
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

fn indeterminate_evidence_legal(tool_id: KernelToolKind, evidence: &EffectEvidenceV2) -> bool {
    let EffectEvidenceV2::IndeterminateReadBack { last_observation } = evidence else {
        return false;
    };
    use KernelToolKind as Tool;
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

fn direct_effect_identity(fact: &EffectFactV2) -> &ToolEffectIdentityV2 {
    match fact {
        EffectFactV2::ToolObserved { identity, .. }
        | EffectFactV2::ToolObservedAfterCancel { identity, .. }
        | EffectFactV2::ToolObservedAfterDeadline { identity, .. }
        | EffectFactV2::ToolObservedAfterCancelAndDeadline { identity, .. }
        | EffectFactV2::ToolIndeterminate { identity, .. } => identity,
    }
}

fn validate_direct_completed_output(
    state: &AuthorityState,
    identity: &ToolObservedTerminalIdentityV2,
    output: &serde_json::Value,
) -> AuthorityResult<()> {
    let output =
        serde_json::from_value::<KernelToolOutput>(output.clone()).map_err(|_| corrupt_store())?;
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

pub(super) fn recorded_error_to_error(error: RecordedCommandErrorV2) -> KernelErrorV2 {
    match error {
        RecordedCommandErrorV2::ControlEpochAlreadyExists { run_id, current } => {
            KernelErrorV2::ControlEpochAlreadyExists { run_id, current }
        }
        RecordedCommandErrorV2::ControlEpochExhausted { run_id, current } => {
            KernelErrorV2::ControlEpochExhausted { run_id, current }
        }
        RecordedCommandErrorV2::StaleControlEpoch {
            run_id,
            submitted,
            current,
        } => KernelErrorV2::StaleControlEpoch {
            run_id,
            submitted,
            current,
        },
        RecordedCommandErrorV2::InvocationNotFound {
            run_id,
            invocation_id,
        } => KernelErrorV2::InvocationNotFound {
            run_id,
            invocation_id,
        },
        RecordedCommandErrorV2::InvocationNotOwnedByRun {
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
        return if matches!(
            envelope.payload,
            KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded { .. })
        ) {
            Ok(())
        } else {
            Err(corrupt_store())
        };
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
                origin:
                    CapabilityScopePreviewOriginV3::InterventionCandidate {
                        interaction_id: source_interaction_id,
                        interaction_revision: source_interaction_revision,
                        candidate_set_digest: source_candidate_set_digest,
                        option_id: source_option_id,
                    },
                ..
            },
            AuthorizationFactV2::InterventionCandidateSuperseded {
                identity,
                preview_id: superseded_preview_id,
                interaction_id,
                interaction_revision,
                candidate_set_digest,
                selected_option_id,
            },
        ) => {
            same_authorization_subject(identity, source)
                && superseded_preview_id == preview_id
                && interaction_id == source_interaction_id
                && interaction_revision == source_interaction_revision
                && candidate_set_digest == source_candidate_set_digest
                && selected_option_id != source_option_id
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
        KernelFactPayloadV2::Control(ControlFactV2::RunOpened { control_epoch, .. }) => matches!(
            predecessor,
            KernelFactPayloadV2::Control(ControlFactV2::EpochAdvanced {
                identity,
                ..
            }) if identity.control_epoch == *control_epoch
        ),
        KernelFactPayloadV2::Control(ControlFactV2::RunTransportRebound {
            control_epoch,
            transport_generation,
            ..
        }) => match predecessor {
            KernelFactPayloadV2::Control(ControlFactV2::RunOpened { .. }) => {
                *transport_generation == 2
            }
            KernelFactPayloadV2::Control(ControlFactV2::RunTransportRebound {
                control_epoch: previous_epoch,
                transport_generation: previous_generation,
                ..
            }) => {
                previous_epoch <= control_epoch
                    && previous_generation
                        .checked_add(1)
                        .is_some_and(|next| next == *transport_generation)
            }
            _ => false,
        },
        KernelFactPayloadV2::Control(ControlFactV2::EpochAdvanced { .. }) => {
            command_edge(predecessor, MutationCommandKindV2::ControlEpochAdvance)
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
            }
        }
        KernelFactPayloadV2::Control(ControlFactV2::RunRetired { control_epoch, .. }) => matches!(
            predecessor,
            KernelFactPayloadV2::Control(ControlFactV2::RunRetirementFenced {
                control_epoch: fenced_epoch,
                ..
            }) if fenced_epoch == control_epoch
        ),
        KernelFactPayloadV2::Control(ControlFactV2::RunRetirementFenced {
            control_epoch, ..
        }) => {
            predecessor.control_epoch() == Some(*control_epoch)
                && matches!(
                    predecessor,
                    KernelFactPayloadV2::Control(
                        ControlFactV2::EpochAdvanced { .. }
                            | ControlFactV2::CancellationRequested { .. }
                    )
                )
        }
        KernelFactPayloadV2::Authorization(AuthorizationFactV2::ScopePreviewed { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Control(ControlFactV2::EpochAdvanced { .. })
                    | KernelFactPayloadV2::Authorization(
                        AuthorizationFactV2::ContextInvalidated { .. }
                    )
            )
        }
        KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityAwaiting {
            identity,
            preview_id,
            tool_id,
            scope_digest,
            tool_contract_digest,
            context_ref,
            ..
        }) => matches!(
            predecessor,
            KernelFactPayloadV2::Authorization(AuthorizationFactV2::ScopePreviewed {
                identity: source,
                preview_id: source_preview_id,
                tool_id: source_tool_id,
                scope_digest: source_scope_digest,
                tool_contract_digest: source_tool_contract_digest,
                context_ref: source_context_ref,
                ..
            }) if authorization_matches_awaiting_subject(source, identity)
                && preview_id == source_preview_id
                && tool_id == source_tool_id
                && scope_digest == source_scope_digest
                && tool_contract_digest == source_tool_contract_digest
                && context_ref == source_context_ref
        ),
        KernelFactPayloadV2::Authorization(current)
            if matches!(
                current,
                AuthorizationFactV2::CapabilityIssued { .. }
                    | AuthorizationFactV2::CapabilityDenied { .. }
                    | AuthorizationFactV2::InterventionCandidateSuperseded { .. }
                    | AuthorizationFactV2::ExpansionAllowed { .. }
                    | AuthorizationFactV2::ExpansionDenied { .. }
            ) =>
        {
            matches!(
                predecessor,
                KernelFactPayloadV2::Authorization(previous)
                    if authorization_resolution_edge_matches(previous, current)
            )
        }
        KernelFactPayloadV2::Authorization(AuthorizationFactV2::TrustGranted { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Authorization(AuthorizationFactV2::ScopePreviewed { .. })
            )
        }
        KernelFactPayloadV2::Authorization(AuthorizationFactV2::TrustRevoked { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Authorization(AuthorizationFactV2::TrustGranted { .. })
            )
        }
        KernelFactPayloadV2::Authorization(
            AuthorizationFactV2::LeaseRevoked { .. } | AuthorizationFactV2::LeaseSuperseded { .. },
        ) => matches!(
            predecessor,
            KernelFactPayloadV2::Authorization(
                AuthorizationFactV2::CapabilityIssued { .. }
                    | AuthorizationFactV2::ExpansionAllowed { .. }
            )
        ),
        KernelFactPayloadV2::Authorization(AuthorizationFactV2::ContextInvalidated { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Control(
                    ControlFactV2::EpochAdvanced { .. } | ControlFactV2::RunOpened { .. }
                ) | KernelFactPayloadV2::Authorization(_)
            )
        }
        KernelFactPayloadV2::Authorization(_) => false,
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
                KernelFactPayloadV2::Invocation(InvocationFactV2::ToolIntentAdmitted { .. })
            )
        }
        KernelFactPayloadV2::Resource(ResourceFactV2::ResolvedForInvocation { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Invocation(InvocationFactV2::ToolAttemptPrepared { .. })
            )
        }
        KernelFactPayloadV2::Resource(ResourceFactV2::RevalidatedBeforeEffect { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Resource(ResourceFactV2::ResolvedForInvocation { .. })
            )
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolExecutionStarted { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Invocation(InvocationFactV2::ToolAttemptPrepared { .. })
                    | KernelFactPayloadV2::Resource(ResourceFactV2::RevalidatedBeforeEffect { .. })
            )
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCancellationObserved { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Control(ControlFactV2::CancellationRequested { .. })
            )
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolDeadlineObserved { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Invocation(InvocationFactV2::ToolIntentAdmitted { .. })
            )
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCancelledBeforeEffect { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCancellationObserved { .. })
            )
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolTimedOutBeforeEffect { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Invocation(InvocationFactV2::ToolDeadlineObserved { .. })
            )
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolFailedBeforeEffect { .. }) => {
            matches!(
                predecessor,
                KernelFactPayloadV2::Invocation(InvocationFactV2::ToolAttemptPrepared { .. })
            )
        }
        KernelFactPayloadV2::Effect(_) => matches!(
            predecessor,
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolExecutionStarted { .. })
        ),
        KernelFactPayloadV2::Invocation(
            InvocationFactV2::ToolCompleted { .. }
            | InvocationFactV2::ToolFailedAfterObservedEffect { .. }
            | InvocationFactV2::ToolIndeterminate { .. },
        ) => matches!(predecessor, KernelFactPayloadV2::Effect(_)),
        KernelFactPayloadV2::Cleanup(_) => true,
        KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded { .. }) => false,
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
