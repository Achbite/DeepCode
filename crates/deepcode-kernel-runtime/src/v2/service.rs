use super::authority::{
    bounded_fact_page, canonical_grant_request, caused_attempt, classify_submission_binding,
    command_receipt_draft, corrupt_store, epoch_advance_drafts, exact_epoch,
    execution_result_drafts, explicit_cancellation_drafts, fact_draft, fact_query,
    failed_before_effect_drafts, grant_decision_drafts, grant_decision_key,
    grant_revocation_drafts, invalid_field, invocation_admission_drafts,
    invocation_rejection_drafts, invocation_status_reply, plan_control_cancellation,
    plan_epoch_advance, policy_auto_issuable, pre_effect_stop_drafts, prepare_effect,
    prepare_grant_request, prepare_submission_digest, recorded_error_to_error, recovery_drafts,
    require_current_run, require_decision_source, require_input_in_epoch, resolve_execution,
    resolve_workspace_binding, resource_resolve_reply, run_termination_drafts, storage_fault,
    DecisionSource, EffectPreparation, EpochAdvancePlan, PrepareFailure, RunCommandCheck,
    SubmissionDisposition,
};
use super::model::{
    invocation_phase_is_terminal, AuthorityResult, AuthorityState, ExecutionResolution,
    GrantLifecycle, InvocationPhase, PreparedGrantRequest, RawExecution, ResolvedTarget,
    RunLifecycle, RunRecord, StopOverlay, WorkspaceBinding,
};
use crate::executors::{
    builtin_executors, invoke_document_read_complete, invoke_web_fetch_complete,
    KernelExecutorConfig, KernelExecutorRegistry, KernelToolExecutionContext, KernelToolInvocation,
    SecretProvider,
};
use deepcode_kernel_abi::tool_catalog_v4::{
    AuthorityToolIdV4, ExecutionAvailabilityV4, ToolInvocationInputV4,
};
use deepcode_kernel_abi::v2::{
    automatic_grant_decision_digest_v2, command_request_digest_v2, idempotency_key_hash_v2,
    invocation_request_digest_v2, policy_auto_issue_digest_v2, policy_configuration_digest_v2,
    policy_requires_user_decision_digest_v2, target_revalidation_set_digest_v2,
    user_allow_grant_decision_digest_v2, user_deny_grant_decision_digest_v2, AdmissionRejectionV2,
    AttemptId, AttemptIdentityV2, AutonomyModeV2, CancelRequestId, CancellationReasonCodeV2,
    CommandEpochContextV2, ControlEpoch, ControlFactV2, EffectFactV2, EffectId, EffectIdentityV2,
    FactId, GrantDecisionBasisV2, GrantFactV2, GrantId, GrantReservationId, GrantScopeMismatchV2,
    GrantUnusableLifecycleV2, InvocationFactV2, InvocationId, InvocationSubmissionDigestV2,
    KernelFactDraftV2, KernelFactPayloadV2, MutationCommandResultV2, ObservedTerminalIdentityV2,
    OperationId, PolicyConfigurationDigestV2, PreEffectFailureCodeV2, ResourceAttemptIdentityV2,
    ResourceFactV2, ResourceId, ResourceResolvedIdentityV2, RunId, V2ValidationError,
};
use deepcode_kernel_abi::v2_command::{
    CommandHandlingV2, CompatibilityReplyV2, ControlEpochAdvanceV2, ControlEpochAdvancedReplyV2,
    GrantDecisionReplyV2, GrantDecisionSubmissionV2, GrantDecisionSubmitV2, GrantPreviewReplyV2,
    GrantRequestV2, GrantRevokeOutcomeV2, GrantRevokeV2, GrantRevokedReplyV2,
    InvalidFieldViolationV2, InvocationCancelReplyV2, InvocationCancelTargetV2, InvocationCancelV2,
    InvocationSubmissionReplyV2, InvocationSubmitV2, KernelCommandEnvelopeV2,
    KernelCommandResponseEnvelopeV2, KernelCommandV2, KernelErrorV2, KernelFactsQueryV2,
    KernelReplyV2, MutationCommandKindV2, RecordedCommandErrorV2, ResourceResolveV2,
    RunTerminateV2, RunTerminatedReplyV2, RunTerminationOutcomeV2, StorageFaultCodeV2,
};
use deepcode_kernel_ledger::v2::{
    AuthorityFactWriterLease, CanonicalFactReader, CanonicalFactStore, OutboxPublisherLease,
};
use deepcode_kernel_tools::LocalAuthorityToolCatalogV4;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct IdMint {
    nonce: String,
    next: AtomicU64,
}

impl IdMint {
    fn new(high_water: u64) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        Self {
            nonce: format!("{nanos:x}-{:x}-{high_water:x}", std::process::id()),
            next: AtomicU64::new(1),
        }
    }

    fn value(&self, kind: &str) -> String {
        let next = self.next.fetch_add(1, Ordering::Relaxed);
        format!("kv2-{kind}-{}-{next:x}", self.nonce)
    }

    fn typed<T>(
        &self,
        kind: &str,
        constructor: impl FnOnce(String) -> Result<T, V2ValidationError>,
    ) -> T {
        constructor(self.value(kind)).expect("Kernel-minted identity is valid")
    }

    fn fact(&self) -> FactId {
        self.typed("fact", FactId::new)
    }

    fn cancellation(&self) -> (CancelRequestId, FactId) {
        (self.typed("cancel", CancelRequestId::new), self.fact())
    }
}

struct ServiceInner {
    state: Mutex<AuthorityState>,
    writer: Mutex<AuthorityFactWriterLease>,
    reader: CanonicalFactReader,
    _publisher: OutboxPublisherLease,
    catalog: LocalAuthorityToolCatalogV4,
    workspace: WorkspaceBinding,
    executor_config: KernelExecutorConfig,
    executors: Arc<KernelExecutorRegistry>,
    autonomy_mode: AutonomyModeV2,
    policy_configuration_digest: PolicyConfigurationDigestV2,
    ids: IdMint,
}

/// Sole coordinator for the sealed v2 admission and effect chain.
/// It exposes no caller-constructible effect permit.
#[derive(Clone)]
pub(crate) struct AuthorityService {
    inner: Arc<ServiceInner>,
}

struct PreAdmissionInvocation {
    request: InvocationSubmitV2,
    prepared: PreparedGrantRequest,
    submission_digest: InvocationSubmissionDigestV2,
}

struct AuthorityAdmittedInvocation {
    identity: AttemptIdentityV2,
    invocation: ToolInvocationInputV4,
    targets: Vec<(ResourceId, ResolvedTarget)>,
    attempt_prepared_fact_id: FactId,
    admitted_at: Instant,
    effective_deadline: Duration,
}

struct PersistedEffectPermit;

struct EffectReadyInvocation {
    admitted: AuthorityAdmittedInvocation,
    preparation: EffectPreparation,
    execution_started_fact_id: FactId,
    _permit: PersistedEffectPermit,
}

impl AuthorityService {
    pub(super) fn open(
        store: CanonicalFactStore,
        workspace_root: &Path,
        executor_config: KernelExecutorConfig,
        secret_provider: Arc<dyn SecretProvider>,
        autonomy_mode: AutonomyModeV2,
    ) -> AuthorityResult<Self> {
        let mut recovery = store.claim_recovery_admin().map_err(|_| storage_fault())?;
        recovery
            .rebuild_materialized_state()
            .map_err(|_| storage_fault())?;
        let reader = store.reader();
        let snapshot = reader.snapshot().map_err(|_| storage_fault())?;
        let state = AuthorityState::restore(snapshot.facts)?;
        let writer = store
            .claim_authority_writer()
            .map_err(|_| storage_fault())?;
        let publisher = store
            .claim_outbox_publisher()
            .map_err(|_| storage_fault())?;
        let catalog =
            LocalAuthorityToolCatalogV4::from_builtin_registry().map_err(|_| corrupt_store())?;
        let workspace = resolve_workspace_binding(workspace_root)?;
        let executors = Arc::new(KernelExecutorRegistry::from_executors(builtin_executors(
            crate::kernel_tool_registry(),
            executor_config.clone(),
            secret_provider,
        )));
        let policy_configuration_digest =
            policy_configuration_digest_v2(autonomy_mode, catalog.catalog_digest())
                .map_err(|_| corrupt_store())?;
        let service = Self {
            inner: Arc::new(ServiceInner {
                state: Mutex::new(state),
                writer: Mutex::new(writer),
                reader,
                _publisher: publisher,
                catalog,
                workspace,
                executor_config,
                executors,
                autonomy_mode,
                policy_configuration_digest,
                ids: IdMint::new(snapshot.ledger_sequence_high_water),
            }),
        };
        service.reconcile_open_attempts()?;
        Ok(service)
    }

    pub(super) fn handle_policy_command(
        &self,
        envelope: KernelCommandEnvelopeV2,
    ) -> KernelCommandResponseEnvelopeV2 {
        self.handle(envelope, DecisionSource::BuiltInPolicy)
    }

    pub(super) fn handle_trusted_user_command(
        &self,
        envelope: KernelCommandEnvelopeV2,
    ) -> KernelCommandResponseEnvelopeV2 {
        self.handle(envelope, DecisionSource::TrustedUserDecision)
    }

    pub(super) fn handle_untrusted_command(
        &self,
        envelope: KernelCommandEnvelopeV2,
    ) -> KernelCommandResponseEnvelopeV2 {
        self.handle(envelope, DecisionSource::None)
    }

    fn handle(
        &self,
        envelope: KernelCommandEnvelopeV2,
        source: DecisionSource,
    ) -> KernelCommandResponseEnvelopeV2 {
        let request_id = envelope.request_id.clone();
        let reply = envelope
            .validate()
            .map_err(|_| invalid_field("command", InvalidFieldViolationV2::OutOfRange))
            .and_then(|_| self.dispatch(&envelope, source));
        let (reply, handling) = match reply {
            Ok(value) => value,
            Err(error) => (KernelReplyV2::Error(error), CommandHandlingV2::Evaluated),
        };
        KernelCommandResponseEnvelopeV2::Correlated {
            server_abi_version: deepcode_kernel_abi::KERNEL_ABI_V2_VERSION.to_owned(),
            request_id,
            handling,
            reply,
        }
    }

    fn dispatch(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        source: DecisionSource,
    ) -> AuthorityResult<(KernelReplyV2, CommandHandlingV2)> {
        if let KernelCommandV2::GrantDecisionSubmit(command) = &envelope.command {
            require_decision_source(&command.decision, source)?;
        }
        if envelope.command.mutation_kind().is_some() {
            let digest =
                command_request_digest_v2(&envelope.command).map_err(|_| corrupt_store())?;
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            if let Some(existing) = state.commands.get(&envelope.request_id) {
                if existing.digest != digest {
                    return Err(KernelErrorV2::DuplicateCommandDigestMismatch {
                        command_request_id: envelope.request_id.clone(),
                        existing: existing.digest.clone(),
                        submitted: digest,
                    });
                }
                return Ok((existing.reply.clone(), CommandHandlingV2::Replayed));
            }
            if state.storage_faulted {
                return Err(KernelErrorV2::FactStoreUnavailable {
                    fault_code: StorageFaultCodeV2::WriterFaulted,
                });
            }
        }
        let reply = match &envelope.command {
            KernelCommandV2::CompatibilityGet {} => KernelReplyV2::Compatibility(
                CompatibilityReplyV2::new(self.inner.catalog.catalog_digest().clone()),
            ),
            KernelCommandV2::ToolCatalogGet {} => {
                KernelReplyV2::ToolCatalog(self.inner.catalog.wire_catalog().clone())
            }
            KernelCommandV2::ControlEpochAdvance(command) => {
                self.advance_epoch(envelope, command.clone())?
            }
            KernelCommandV2::GrantPreview(request) => self.preview_grant(request)?,
            KernelCommandV2::GrantDecisionSubmit(command) => {
                self.decide_grant(envelope, command.clone())?
            }
            KernelCommandV2::GrantRevoke(command) => {
                self.revoke_grant(envelope, command.clone())?
            }
            KernelCommandV2::InvocationSubmit(command) => {
                self.submit_invocation(envelope, command.clone())?
            }
            KernelCommandV2::InvocationCancel(command) => {
                self.cancel_invocation(envelope, command.clone())?
            }
            KernelCommandV2::InvocationStatusGet(command) => {
                self.invocation_status(&command.run_id, &command.invocation_id)?
            }
            KernelCommandV2::KernelFactsQuery(command) => self.query_facts(command)?,
            KernelCommandV2::ResourceResolve(command) => self.resolve_resource(command)?,
            KernelCommandV2::RunTerminate(command) => {
                self.terminate_run(envelope, command.clone())?
            }
        };
        Ok((reply, CommandHandlingV2::Evaluated))
    }

    fn advance_epoch(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        command: ControlEpochAdvanceV2,
    ) -> AuthorityResult<KernelReplyV2> {
        let command_digest =
            command_request_digest_v2(&envelope.command).map_err(|_| corrupt_store())?;
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let existing_run = state.runs.get(&command.run_id).cloned();
        let (epoch_context, previous_epoch, new_epoch) =
            match plan_epoch_advance(&command.run_id, existing_run.as_ref(), command.precondition)?
            {
                EpochAdvancePlan::Ready {
                    epoch_context,
                    previous_epoch,
                    new_epoch,
                } => (epoch_context, previous_epoch, new_epoch),
                EpochAdvancePlan::Recorded {
                    current_epoch,
                    error,
                } => {
                    return self.record_semantic_error(
                        &mut state,
                        envelope,
                        command.run_id.clone(),
                        exact_epoch(current_epoch),
                        error,
                    );
                }
            };

        let command_fact_id = self.inner.ids.fact();
        let epoch_fact_id = self.inner.ids.fact();
        let superseded = state
            .grants
            .values()
            .filter(|grant| {
                grant.run_id == command.run_id && matches!(grant.lifecycle, GrantLifecycle::Issued)
            })
            .cloned()
            .map(|grant| (grant, self.inner.ids.fact()))
            .collect::<Vec<_>>();
        let active_invocation = state
            .runs
            .get(&command.run_id)
            .and_then(|run| run.active_invocation_id.clone());
        let (cancellation, cancellation_fact) =
            plan_control_cancellation(&state, active_invocation, || self.inner.ids.cancellation())?;
        let batch_len = 2 + superseded.len() + usize::from(cancellation_fact.is_some());
        let high_water = self.predicted_high_water(batch_len)?;
        let reply = ControlEpochAdvancedReplyV2 {
            run_id: command.run_id.clone(),
            accepted_control_epoch: new_epoch,
            epoch_fact_id: epoch_fact_id.clone(),
            superseded_grant_count: superseded.len() as u64,
            cancellation: cancellation.clone(),
            command_batch_high_water: high_water,
        };
        let drafts = epoch_advance_drafts(
            envelope.request_id.clone(),
            command_digest,
            command,
            epoch_context,
            previous_epoch,
            new_epoch,
            command_fact_id,
            epoch_fact_id,
            superseded,
            cancellation_fact,
            reply.clone(),
        );
        self.commit_locked(&mut state, drafts)?;
        Ok(KernelReplyV2::ControlEpochAdvanced(reply))
    }

    fn preview_grant(&self, request: &GrantRequestV2) -> AuthorityResult<KernelReplyV2> {
        {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            require_current_run(&state, &request.run_id, request.control_epoch)?;
        }
        let prepared = match prepare_grant_request(
            request,
            &self.inner.catalog,
            &self.inner.workspace,
            &self.inner.executor_config,
        ) {
            Ok(prepared) => prepared,
            Err(PrepareFailure::Kernel(KernelErrorV2::ToolExecutionUnavailable {
                tool_id,
                availability,
            })) => {
                return Ok(KernelReplyV2::GrantPreviewed(
                    GrantPreviewReplyV2::Blocked {
                        tool_id,
                        availability,
                    },
                ));
            }
            Err(PrepareFailure::Kernel(error)) => return Err(error),
            Err(PrepareFailure::Target(_)) => {
                return Err(invalid_field(
                    "request.canonicalInvocation",
                    InvalidFieldViolationV2::OutOfRange,
                ));
            }
        };
        let contract = self
            .inner
            .catalog
            .contract(prepared.canonical_invocation.tool_id());
        let canonical = canonical_grant_request(request, &prepared, contract);
        let preview = if policy_auto_issuable(
            self.inner.autonomy_mode,
            contract.tool_id,
            contract.risk,
            contract.effect_scope,
        ) {
            GrantPreviewReplyV2::AutoIssuable { request: canonical }
        } else {
            GrantPreviewReplyV2::RequiresUserDecision { request: canonical }
        };
        Ok(KernelReplyV2::GrantPreviewed(preview))
    }

    fn check_run_command(
        &self,
        state: &mut AuthorityState,
        envelope: &KernelCommandEnvelopeV2,
        run_id: &RunId,
        expected_epoch: ControlEpoch,
        require_active: bool,
    ) -> AuthorityResult<RunCommandCheck> {
        let run = state
            .runs
            .get(run_id)
            .cloned()
            .ok_or_else(|| KernelErrorV2::RunNotFound {
                run_id: run_id.clone(),
            })?;
        let error = if run.epoch != expected_epoch {
            Some(RecordedCommandErrorV2::StaleControlEpoch {
                run_id: run_id.clone(),
                submitted: expected_epoch,
                current: run.epoch,
            })
        } else if require_active && matches!(run.lifecycle, RunLifecycle::Terminated { .. }) {
            Some(RecordedCommandErrorV2::RunTerminated {
                run_id: run_id.clone(),
                control_epoch: run.epoch,
            })
        } else {
            None
        };
        match error {
            Some(error) => self
                .record_semantic_error(
                    state,
                    envelope,
                    run_id.clone(),
                    exact_epoch(run.epoch),
                    error,
                )
                .map(RunCommandCheck::Recorded),
            None => Ok(RunCommandCheck::Current(run)),
        }
    }

    fn decide_grant(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        command: GrantDecisionSubmitV2,
    ) -> AuthorityResult<KernelReplyV2> {
        {
            let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
            if let RunCommandCheck::Recorded(reply) = self.check_run_command(
                &mut state,
                envelope,
                &command.request.run_id,
                command.request.control_epoch,
                true,
            )? {
                return Ok(reply);
            }
        }
        let prepared = match prepare_grant_request(
            &command.request,
            &self.inner.catalog,
            &self.inner.workspace,
            &self.inner.executor_config,
        ) {
            Ok(prepared) => prepared,
            Err(PrepareFailure::Kernel(KernelErrorV2::ToolExecutionUnavailable {
                tool_id,
                availability,
            })) => {
                let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
                if let RunCommandCheck::Recorded(reply) = self.check_run_command(
                    &mut state,
                    envelope,
                    &command.request.run_id,
                    command.request.control_epoch,
                    true,
                )? {
                    return Ok(reply);
                }
                return self.record_semantic_error(
                    &mut state,
                    envelope,
                    command.request.run_id.clone(),
                    exact_epoch(command.request.control_epoch),
                    RecordedCommandErrorV2::ToolExecutionUnavailable {
                        tool_id,
                        availability,
                    },
                );
            }
            Err(PrepareFailure::Kernel(error)) => return Err(error),
            Err(PrepareFailure::Target(_)) => {
                return Err(invalid_field(
                    "request.canonicalInvocation",
                    InvalidFieldViolationV2::OutOfRange,
                ))
            }
        };
        if prepared.authorization_digest != command.expected_authorization_digest {
            let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
            if let RunCommandCheck::Recorded(reply) = self.check_run_command(
                &mut state,
                envelope,
                &command.request.run_id,
                command.request.control_epoch,
                true,
            )? {
                return Ok(reply);
            }
            return self.record_semantic_error(
                &mut state,
                envelope,
                command.request.run_id.clone(),
                exact_epoch(command.request.control_epoch),
                RecordedCommandErrorV2::AuthorizationDigestMismatch {
                    expected: command.expected_authorization_digest,
                    actual: prepared.authorization_digest,
                },
            );
        }
        let contract = self
            .inner
            .catalog
            .contract(prepared.canonical_invocation.tool_id());
        let (decision_digest, basis, allow, requires_user) = match command.decision {
            GrantDecisionSubmissionV2::ApplyKernelPolicy {} => {
                let auto = policy_auto_issuable(
                    self.inner.autonomy_mode,
                    contract.tool_id,
                    contract.risk,
                    contract.effect_scope,
                );
                let evaluation = if auto {
                    policy_auto_issue_digest_v2(
                        &prepared.authorization_digest,
                        &prepared.grant_scope_digest,
                        &self.inner.policy_configuration_digest,
                    )
                } else {
                    policy_requires_user_decision_digest_v2(
                        &prepared.authorization_digest,
                        &prepared.grant_scope_digest,
                        &self.inner.policy_configuration_digest,
                    )
                }
                .map_err(|_| corrupt_store())?;
                let digest =
                    automatic_grant_decision_digest_v2(&prepared.authorization_digest, &evaluation)
                        .map_err(|_| corrupt_store())?;
                (
                    digest,
                    GrantDecisionBasisV2::AutomaticPolicy {
                        autonomy_mode: self.inner.autonomy_mode,
                        policy_evaluation_digest: evaluation,
                    },
                    auto,
                    !auto,
                )
            }
            ref decision @ (GrantDecisionSubmissionV2::UserAllow {
                ref input_id,
                ref decision_ref,
            }
            | GrantDecisionSubmissionV2::UserDeny {
                ref input_id,
                ref decision_ref,
                ..
            }) => {
                let state = self.inner.state.lock().map_err(|_| storage_fault())?;
                require_input_in_epoch(
                    &state,
                    &command.request.run_id,
                    command.request.control_epoch,
                    input_id,
                )?;
                let allow = matches!(decision, GrantDecisionSubmissionV2::UserAllow { .. });
                let digest = if allow {
                    user_allow_grant_decision_digest_v2(
                        &prepared.authorization_digest,
                        input_id,
                        decision_ref,
                    )
                } else {
                    user_deny_grant_decision_digest_v2(
                        &prepared.authorization_digest,
                        input_id,
                        decision_ref,
                    )
                }
                .map_err(|_| corrupt_store())?;
                (
                    digest,
                    GrantDecisionBasisV2::UserDecision {
                        input_id: input_id.clone(),
                        decision_ref: decision_ref.clone(),
                    },
                    allow,
                    false,
                )
            }
        };
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        if let RunCommandCheck::Recorded(reply) = self.check_run_command(
            &mut state,
            envelope,
            &command.request.run_id,
            command.request.control_epoch,
            true,
        )? {
            return Ok(reply);
        }
        if requires_user {
            let reply = GrantDecisionReplyV2::RequiresUserDecision {
                authorization_request_digest: prepared.authorization_digest,
            };
            self.commit_receipt_locked(
                &mut state,
                envelope,
                command.request.run_id.clone(),
                exact_epoch(command.request.control_epoch),
                MutationCommandResultV2::GrantDecision {
                    reply: reply.clone(),
                },
            )?;
            return Ok(KernelReplyV2::GrantDecisionRecorded(reply));
        }

        let decision_key = grant_decision_key(
            &command.request.run_id,
            &command.request.operation_id,
            command.request.control_epoch,
            &prepared.authorization_digest,
            &basis,
        )?;
        if let Some(existing) = state.grant_decisions.get(&decision_key).cloned() {
            if existing.digest != decision_digest {
                return self.record_semantic_error(
                    &mut state,
                    envelope,
                    command.request.run_id.clone(),
                    exact_epoch(command.request.control_epoch),
                    RecordedCommandErrorV2::DuplicateGrantDecisionDigestMismatch {
                        authorization_request_digest: prepared.authorization_digest,
                        existing: existing.digest,
                        submitted: decision_digest,
                    },
                );
            }
            self.commit_receipt_locked(
                &mut state,
                envelope,
                command.request.run_id.clone(),
                exact_epoch(command.request.control_epoch),
                MutationCommandResultV2::GrantDecision {
                    reply: existing.reply.clone(),
                },
            )?;
            return Ok(KernelReplyV2::GrantDecisionRecorded(existing.reply));
        }
        let command_fact_id = self.inner.ids.fact();
        let business_fact_id = self.inner.ids.fact();
        let high_water = self.predicted_high_water(2)?;
        let reply = if allow {
            GrantDecisionReplyV2::Issued {
                grant_id: self.inner.ids.typed("grant", GrantId::new),
                fact_id: business_fact_id.clone(),
                ledger_sequence: high_water,
            }
        } else {
            GrantDecisionReplyV2::Denied {
                fact_id: business_fact_id.clone(),
                ledger_sequence: high_water,
            }
        };
        let command_digest =
            command_request_digest_v2(&envelope.command).map_err(|_| corrupt_store())?;
        self.commit_locked(
            &mut state,
            grant_decision_drafts(
                command_fact_id,
                business_fact_id,
                envelope.request_id.clone(),
                command_digest,
                command.request,
                prepared,
                contract,
                decision_digest,
                basis,
                reply.clone(),
            ),
        )?;
        Ok(KernelReplyV2::GrantDecisionRecorded(reply))
    }

    fn revoke_grant(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        command: GrantRevokeV2,
    ) -> AuthorityResult<KernelReplyV2> {
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let run = match self.check_run_command(
            &mut state,
            envelope,
            &command.run_id,
            command.expected_control_epoch,
            true,
        )? {
            RunCommandCheck::Current(run) => run,
            RunCommandCheck::Recorded(reply) => return Ok(reply),
        };
        let Some(grant) = state
            .grants
            .get(&command.grant_id)
            .filter(|grant| grant.run_id == command.run_id)
            .cloned()
        else {
            return self.record_semantic_error(
                &mut state,
                envelope,
                command.run_id.clone(),
                exact_epoch(run.epoch),
                RecordedCommandErrorV2::GrantNotFound {
                    run_id: command.run_id,
                },
            );
        };
        let outcome = match grant.lifecycle.clone() {
            GrantLifecycle::Issued => {
                let command_digest =
                    command_request_digest_v2(&envelope.command).map_err(|_| corrupt_store())?;
                let command_fact_id = self.inner.ids.fact();
                let fact_id = self.inner.ids.fact();
                let ledger_sequence = self.predicted_high_water(2)?;
                let reply = GrantRevokedReplyV2 {
                    grant_id: grant.grant_id.clone(),
                    outcome: GrantRevokeOutcomeV2::Revoked {
                        revocation_fact_id: fact_id.clone(),
                        ledger_sequence,
                    },
                };
                let drafts = grant_revocation_drafts(
                    envelope.request_id.clone(),
                    command_digest,
                    command,
                    run.epoch,
                    command_fact_id,
                    fact_id,
                    grant,
                    reply.clone(),
                );
                self.commit_locked(&mut state, drafts)?;
                return Ok(KernelReplyV2::GrantRevoked(reply));
            }
            GrantLifecycle::Revoked {
                fact_id,
                ledger_sequence,
            } => GrantRevokeOutcomeV2::AlreadyRevoked {
                revocation_fact_id: fact_id,
                ledger_sequence,
            },
            GrantLifecycle::Superseded {
                fact_id,
                ledger_sequence,
                cause,
            } => GrantRevokeOutcomeV2::AlreadySuperseded {
                supersession_fact_id: fact_id,
                ledger_sequence,
                cause,
            },
        };
        let reply = GrantRevokedReplyV2 {
            grant_id: command.grant_id,
            outcome,
        };
        self.commit_receipt_locked(
            &mut state,
            envelope,
            command.run_id,
            exact_epoch(run.epoch),
            MutationCommandResultV2::GrantRevoke {
                reply: reply.clone(),
            },
        )?;
        Ok(KernelReplyV2::GrantRevoked(reply))
    }

    fn submit_invocation(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        command: InvocationSubmitV2,
    ) -> AuthorityResult<KernelReplyV2> {
        let run = {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            state.runs.get(&command.request.run_id).cloned()
        }
        .ok_or_else(|| KernelErrorV2::RunNotFound {
            run_id: command.request.run_id.clone(),
        })?;
        let (tool_id, submission_digest) = prepare_submission_digest(
            &command.request,
            &command.grant_id,
            &self.inner.catalog,
            &self.inner.workspace,
        )?;
        if run.epoch != command.request.control_epoch {
            return self.record_submission_rejection(
                envelope,
                &command,
                run.epoch,
                tool_id,
                submission_digest,
                AdmissionRejectionV2::StaleControlEpoch {
                    submitted: command.request.control_epoch,
                    current: run.epoch,
                },
            );
        }
        if matches!(run.lifecycle, RunLifecycle::Terminated { .. }) {
            return self.record_submission_rejection(
                envelope,
                &command,
                run.epoch,
                tool_id,
                submission_digest,
                AdmissionRejectionV2::RunTerminated {},
            );
        }
        let contract = self.inner.catalog.contract(tool_id);
        if contract.execution_availability != ExecutionAvailabilityV4::Ready
            || self.inner.catalog.ready_binding(tool_id).is_none()
        {
            return self.record_submission_rejection(
                envelope,
                &command,
                run.epoch,
                tool_id,
                submission_digest,
                AdmissionRejectionV2::ToolExecutionUnavailable {
                    tool_id,
                    availability: ExecutionAvailabilityV4::Blocked,
                },
            );
        }
        let prepared = match prepare_grant_request(
            &command.request,
            &self.inner.catalog,
            &self.inner.workspace,
            &self.inner.executor_config,
        ) {
            Ok(prepared) => prepared,
            Err(PrepareFailure::Kernel(error)) => return Err(error),
            Err(PrepareFailure::Target(reason_code)) => {
                return self.record_submission_rejection(
                    envelope,
                    &command,
                    run.epoch,
                    tool_id,
                    submission_digest,
                    AdmissionRejectionV2::TargetResolutionFailed { reason_code },
                );
            }
        };
        let pre_admission = PreAdmissionInvocation {
            request: command,
            prepared,
            submission_digest,
        };
        let (reply, admitted) = self.admit_invocation(envelope, pre_admission)?;
        if let Some(admitted) = admitted {
            let service = self.clone();
            let thread_name = format!("deepcode-v2-{}", admitted.identity.invocation_id);
            let pending = Arc::new(Mutex::new(Some(admitted)));
            let task_pending = Arc::clone(&pending);
            if std::thread::Builder::new()
                .name(thread_name)
                .spawn(move || {
                    if let Ok(mut pending) = task_pending.lock() {
                        if let Some(admitted) = pending.take() {
                            service.execute_admitted(admitted);
                        }
                    }
                })
                .is_err()
            {
                let admitted = pending
                    .lock()
                    .map_err(|_| storage_fault())?
                    .take()
                    .ok_or_else(corrupt_store)?;
                self.fail_before_effect(admitted, PreEffectFailureCodeV2::ExecutorUnavailable)?;
            }
        }
        Ok(KernelReplyV2::InvocationSubmission(reply))
    }

    fn cancel_invocation(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        command: InvocationCancelV2,
    ) -> AuthorityResult<KernelReplyV2> {
        if command.reason_code != CancellationReasonCodeV2::UserRequested {
            return Err(invalid_field(
                "command.reasonCode",
                InvalidFieldViolationV2::InvalidEnum,
            ));
        }
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let run = match self.check_run_command(
            &mut state,
            envelope,
            &command.run_id,
            command.expected_control_epoch,
            true,
        )? {
            RunCommandCheck::Current(run) => run,
            RunCommandCheck::Recorded(reply) => return Ok(reply),
        };
        let target_id = match command.target.clone() {
            InvocationCancelTargetV2::CurrentForRun {} => run.active_invocation_id.clone(),
            InvocationCancelTargetV2::Exact { invocation_id } => {
                let Some(invocation) = state.invocations.get(&invocation_id) else {
                    return self.record_semantic_error(
                        &mut state,
                        envelope,
                        command.run_id.clone(),
                        exact_epoch(run.epoch),
                        RecordedCommandErrorV2::InvocationNotFound {
                            run_id: command.run_id,
                            invocation_id,
                        },
                    );
                };
                if invocation.run_id != command.run_id {
                    return self.record_semantic_error(
                        &mut state,
                        envelope,
                        command.run_id.clone(),
                        exact_epoch(run.epoch),
                        RecordedCommandErrorV2::InvocationNotOwnedByRun {
                            run_id: command.run_id,
                            invocation_id,
                        },
                    );
                }
                Some(invocation_id)
            }
        };
        let reply = match target_id {
            None => InvocationCancelReplyV2::NoActiveInvocation {
                run_id: command.run_id.clone(),
                control_epoch: run.epoch,
            },
            Some(invocation_id) => {
                let invocation = state
                    .invocations
                    .get(&invocation_id)
                    .cloned()
                    .ok_or_else(corrupt_store)?;
                if invocation_phase_is_terminal(invocation.phase) {
                    InvocationCancelReplyV2::AlreadyTerminal {
                        invocation_id,
                        terminal_fact_id: invocation.last_fact_id,
                        terminal_phase: invocation.phase,
                    }
                } else if run.active_invocation_id.as_ref() != Some(&invocation_id) {
                    return Err(corrupt_store());
                } else if let Some((cancel_request_id, fact_id, ledger_sequence)) =
                    invocation.stop_overlay.cancellation()
                {
                    InvocationCancelReplyV2::AlreadyRequested {
                        cancel_request_id: cancel_request_id.clone(),
                        invocation_id,
                        fact_id: fact_id.clone(),
                        ledger_sequence,
                    }
                } else {
                    let command_digest = command_request_digest_v2(&envelope.command)
                        .map_err(|_| corrupt_store())?;
                    let command_fact_id = self.inner.ids.fact();
                    let cancel_request_id = CancelRequestId::new(self.inner.ids.value("cancel"))
                        .expect("Kernel-minted CancelRequestId is valid");
                    let cancellation_fact_id = self.inner.ids.fact();
                    let ledger_sequence = self.predicted_high_water(2)?;
                    let reply = InvocationCancelReplyV2::Requested {
                        cancel_request_id: cancel_request_id.clone(),
                        invocation_id: invocation_id.clone(),
                        fact_id: cancellation_fact_id.clone(),
                        ledger_sequence,
                    };
                    let drafts = explicit_cancellation_drafts(
                        envelope.request_id.clone(),
                        command_digest,
                        command,
                        run.epoch,
                        invocation_id,
                        cancel_request_id,
                        command_fact_id,
                        cancellation_fact_id,
                        reply.clone(),
                    );
                    self.commit_locked(&mut state, drafts)?;
                    return Ok(KernelReplyV2::InvocationCancelResult(reply));
                }
            }
        };
        self.commit_receipt_locked(
            &mut state,
            envelope,
            command.run_id,
            exact_epoch(run.epoch),
            MutationCommandResultV2::InvocationCancel {
                reply: reply.clone(),
            },
        )?;
        Ok(KernelReplyV2::InvocationCancelResult(reply))
    }

    fn admit_invocation(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        pre: PreAdmissionInvocation,
    ) -> AuthorityResult<(
        InvocationSubmissionReplyV2,
        Option<AuthorityAdmittedInvocation>,
    )> {
        let request = &pre.request.request;
        let tool_id = pre.prepared.canonical_invocation.tool_id();
        let contract = self.inner.catalog.contract(tool_id);
        let submission_digest = pre.submission_digest.clone();
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let reject = |state: &mut AuthorityState, rejection| {
            self.record_invocation_rejection_locked(
                state,
                envelope,
                request,
                request.control_epoch,
                tool_id,
                submission_digest.clone(),
                rejection,
            )
            .map(|reply| (reply, None))
        };
        match classify_submission_binding(
            &state,
            &request.run_id,
            &request.operation_id,
            &pre.prepared.idempotency_key_hash,
            &submission_digest,
        )? {
            SubmissionDisposition::Replay(reply) => {
                self.commit_receipt_locked(
                    &mut state,
                    envelope,
                    request.run_id.clone(),
                    exact_epoch(request.control_epoch),
                    MutationCommandResultV2::InvocationSubmission {
                        reply: reply.clone(),
                    },
                )?;
                return Ok((reply, None));
            }
            SubmissionDisposition::Reject(rejection) => {
                return reject(&mut state, rejection);
            }
            SubmissionDisposition::Fresh | SubmissionDisposition::Retry => {}
        }
        let run = state
            .runs
            .get(&request.run_id)
            .cloned()
            .ok_or_else(corrupt_store)?;
        if run.epoch != request.control_epoch {
            return reject(
                &mut state,
                AdmissionRejectionV2::StaleControlEpoch {
                    submitted: request.control_epoch,
                    current: run.epoch,
                },
            );
        }
        if matches!(run.lifecycle, RunLifecycle::Terminated { .. }) {
            return reject(&mut state, AdmissionRejectionV2::RunTerminated {});
        }
        let grant = match state.grants.get(&pre.request.grant_id).cloned() {
            Some(grant)
                if grant.run_id == request.run_id && grant.grant_epoch == request.control_epoch =>
            {
                grant
            }
            _ => {
                return reject(&mut state, AdmissionRejectionV2::GrantNotFound {});
            }
        };
        let unusable = match grant.lifecycle {
            GrantLifecycle::Issued => None,
            GrantLifecycle::Revoked { .. } => Some(GrantUnusableLifecycleV2::Revoked),
            GrantLifecycle::Superseded { .. } => Some(GrantUnusableLifecycleV2::Superseded),
        };
        if let Some(lifecycle) = unusable {
            return reject(
                &mut state,
                AdmissionRejectionV2::GrantUnusable { lifecycle },
            );
        }
        let mismatch = if grant.tool_id != tool_id {
            Some(GrantScopeMismatchV2::Tool)
        } else if grant.resource_scope != pre.prepared.resource_scope {
            Some(GrantScopeMismatchV2::Resource)
        } else if grant.effect_scope != contract.effect_scope {
            Some(GrantScopeMismatchV2::Effect)
        } else if grant.risk != contract.risk {
            Some(GrantScopeMismatchV2::Risk)
        } else if grant.grant_scope_digest != pre.prepared.grant_scope_digest {
            Some(GrantScopeMismatchV2::Resource)
        } else {
            None
        };
        if let Some(mismatch) = mismatch {
            return reject(
                &mut state,
                AdmissionRejectionV2::GrantScopeMismatch { mismatch },
            );
        }
        if let Some(active_invocation_id) = state
            .runs
            .get(&request.run_id)
            .and_then(|run| run.active_invocation_id.clone())
        {
            return reject(
                &mut state,
                AdmissionRejectionV2::RunBusy {
                    active_invocation_id,
                    retry_after_ms: 100,
                },
            );
        }
        let active_runs = state
            .runs
            .values()
            .filter(|run| run.active_invocation_id.is_some())
            .count();
        if active_runs >= 4 {
            return reject(
                &mut state,
                AdmissionRejectionV2::CapacityExceeded {
                    maximum_active_runs: 4,
                    retry_after_ms: 100,
                },
            );
        }
        let invocation_digest = invocation_request_digest_v2(
            &request.run_id,
            &request.operation_id,
            request.control_epoch,
            &pre.prepared.idempotency_key_hash,
            &grant.grant_id,
            &grant.grant_scope_digest,
            &grant.issuance_authorization_digest,
            &contract.contract_digest,
            &pre.prepared.canonical_invocation,
            pre.prepared.effective_deadline_ms,
            &self.inner.workspace.digest,
        )
        .map_err(|_| corrupt_store())?;
        let command_fact_id = self.inner.ids.fact();
        let admitted_fact_id = self.inner.ids.fact();
        let reserved_fact_id = self.inner.ids.fact();
        let attempt_fact_id = self.inner.ids.fact();
        let invocation_id = self.inner.ids.typed("invocation", InvocationId::new);
        let attempt_id = self.inner.ids.typed("attempt", AttemptId::new);
        let reservation_id = self.inner.ids.typed("reservation", GrantReservationId::new);
        let targets = pre
            .prepared
            .resolved_targets
            .iter()
            .cloned()
            .map(|target| (self.inner.ids.typed("resource", ResourceId::new), target))
            .collect::<Vec<_>>();
        let resource_fact_ids = targets
            .iter()
            .map(|_| self.inner.ids.fact())
            .collect::<Vec<_>>();
        let batch_len = 4 + targets.len();
        let high_water = self.predicted_high_water(batch_len)?;
        let reply = InvocationSubmissionReplyV2::Admitted {
            run_id: request.run_id.clone(),
            operation_id: request.operation_id.clone(),
            accepted_control_epoch: request.control_epoch,
            grant_id: grant.grant_id.clone(),
            reservation_id: reservation_id.clone(),
            invocation_id: invocation_id.clone(),
            attempt_id: attempt_id.clone(),
            effective_deadline_ms: pre.prepared.effective_deadline_ms,
            admission_fact_id: admitted_fact_id.clone(),
            admission_batch_high_water: high_water,
        };
        let identity = AttemptIdentityV2 {
            run_id: request.run_id.clone(),
            control_epoch: request.control_epoch,
            operation_id: request.operation_id.clone(),
            grant_id: grant.grant_id.clone(),
            reservation_id,
            invocation_id,
            attempt_id,
            idempotency_key_hash: pre.prepared.idempotency_key_hash.clone(),
            causation_fact_id: admitted_fact_id.clone(),
            correlation_set: pre.prepared.correlations.clone(),
        };
        let command_digest =
            command_request_digest_v2(&envelope.command).map_err(|_| corrupt_store())?;
        self.commit_locked(
            &mut state,
            invocation_admission_drafts(
                command_fact_id,
                admitted_fact_id,
                reserved_fact_id,
                attempt_fact_id.clone(),
                resource_fact_ids,
                envelope.request_id.clone(),
                command_digest,
                &pre.prepared,
                &grant,
                contract,
                submission_digest,
                invocation_digest,
                &identity,
                &targets,
                reply.clone(),
            ),
        )?;
        Ok((
            reply,
            Some(AuthorityAdmittedInvocation {
                identity,
                invocation: pre.prepared.canonical_invocation,
                targets,
                attempt_prepared_fact_id: attempt_fact_id,
                admitted_at: Instant::now(),
                effective_deadline: Duration::from_millis(u64::from(
                    pre.prepared.effective_deadline_ms,
                )),
            }),
        ))
    }

    fn execute_admitted(&self, admitted: AuthorityAdmittedInvocation) {
        let preparation = match prepare_effect(
            &admitted.invocation,
            &admitted.targets,
            &admitted.identity,
            &self.inner.workspace,
            &self.inner.executor_config,
        ) {
            Ok(value) => value,
            Err(code) => {
                let _ = self.fail_before_effect(admitted, code);
                return;
            }
        };
        let ready = match self.persist_effect_boundary(admitted, preparation) {
            Ok(Some(value)) => value,
            Ok(None) | Err(_) => return,
        };
        let invocation = KernelToolInvocation {
            id: ready.admitted.identity.invocation_id.to_string(),
            tool_id: ready.admitted.invocation.tool_id().as_str().to_owned(),
            input: ready.preparation.executor_input.clone(),
        };
        let context = KernelToolExecutionContext {
            workspace_root: Some(self.inner.workspace.canonical_root_utf8.clone()),
        };
        let raw = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match &ready.admitted.invocation {
                ToolInvocationInputV4::DocumentRead { .. } => {
                    invoke_document_read_complete(invocation, context).map(|value| RawExecution {
                        output: value.execution.output,
                        complete_document_text: Some(value.complete_text),
                        http_status_code: None,
                        http_content_type: None,
                    })
                }
                ToolInvocationInputV4::WebFetch { .. } => invoke_web_fetch_complete(invocation)
                    .map(|value| RawExecution {
                        output: value.execution.output,
                        complete_document_text: None,
                        http_status_code: Some(value.status_code),
                        http_content_type: Some(value.content_type),
                    }),
                _ => {
                    let tool_id = invocation.tool_id.clone();
                    self.inner
                        .executors
                        .invoke(&tool_id, invocation, context)
                        .map(|value| RawExecution {
                            output: value.output,
                            complete_document_text: None,
                            http_status_code: None,
                            http_content_type: None,
                        })
                }
            }
        }))
        .map_err(|_| ())
        .and_then(|value| value.map_err(|_| ()));
        let budget = self
            .inner
            .catalog
            .contract(ready.admitted.invocation.tool_id())
            .output_budget
            .maximum_canonical_bytes;
        let resolution = resolve_execution(
            &ready.admitted.invocation,
            &ready.preparation,
            raw,
            &self.inner.workspace,
            budget,
        );
        let _ = self.finalize_execution(ready, resolution);
    }

    fn persist_effect_boundary(
        &self,
        admitted: AuthorityAdmittedInvocation,
        preparation: EffectPreparation,
    ) -> AuthorityResult<Option<EffectReadyInvocation>> {
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let record = state
            .invocations
            .get(&admitted.identity.invocation_id)
            .cloned()
            .ok_or_else(corrupt_store)?;
        if let Some((cancel_id, cancel_fact_id, _)) = record.stop_overlay.cancellation() {
            let observed_id = self.inner.ids.fact();
            let terminal_id = self.inner.ids.fact();
            self.commit_locked(
                &mut state,
                pre_effect_stop_drafts(
                    &admitted.identity,
                    observed_id,
                    terminal_id,
                    self.inner.ids.fact(),
                    Some((cancel_id, cancel_fact_id)),
                ),
            )?;
            return Ok(None);
        }
        if admitted.admitted_at.elapsed() >= admitted.effective_deadline {
            let observed_id = self.inner.ids.fact();
            let terminal_id = self.inner.ids.fact();
            self.commit_locked(
                &mut state,
                pre_effect_stop_drafts(
                    &admitted.identity,
                    observed_id,
                    terminal_id,
                    self.inner.ids.fact(),
                    None,
                ),
            )?;
            return Ok(None);
        }
        let mut facts = Vec::with_capacity(preparation.revalidations.len() + 2);
        let mut set = Vec::with_capacity(preparation.revalidations.len());
        for item in &preparation.revalidations {
            let resolution_fact_id = state
                .resources
                .get(&item.resource_id)
                .filter(|record| record.invocation_id == admitted.identity.invocation_id)
                .map(|record| record.resolution_fact_id.clone())
                .ok_or_else(corrupt_store)?;
            let fact_id = self.inner.ids.fact();
            set.push((
                item.resource_id.clone(),
                fact_id.clone(),
                item.digest.clone(),
            ));
            facts.push(fact_draft(
                fact_id,
                KernelFactPayloadV2::Resource(ResourceFactV2::RevalidatedBeforeEffect {
                    identity: ResourceAttemptIdentityV2 {
                        run_id: admitted.identity.run_id.clone(),
                        control_epoch: admitted.identity.control_epoch,
                        operation_id: admitted.identity.operation_id.clone(),
                        invocation_id: admitted.identity.invocation_id.clone(),
                        attempt_id: admitted.identity.attempt_id.clone(),
                        resource_id: item.resource_id.clone(),
                        idempotency_key_hash: admitted.identity.idempotency_key_hash.clone(),
                        causation_fact_id: resolution_fact_id,
                        correlation_set: admitted.identity.correlation_set.clone(),
                    },
                    observation: item.observation.clone(),
                    target_revalidation_digest: item.digest.clone(),
                }),
            ));
        }
        let set_refs = set
            .iter()
            .map(|(resource, fact, digest)| (resource, fact, digest))
            .collect::<Vec<_>>();
        let set_digest = target_revalidation_set_digest_v2(
            &admitted.identity.run_id,
            &admitted.identity.operation_id,
            &admitted.identity.invocation_id,
            &admitted.identity.attempt_id,
            &set_refs,
        )
        .map_err(|_| corrupt_store())?;
        let consumed_id = self.inner.ids.fact();
        let started_id = self.inner.ids.fact();
        let use_count = state
            .grants
            .get(&admitted.identity.grant_id)
            .map(|grant| grant.use_count + 1)
            .ok_or_else(corrupt_store)?;
        facts.push(fact_draft(
            consumed_id.clone(),
            KernelFactPayloadV2::Grant(GrantFactV2::Consumed {
                identity: caused_attempt(
                    &admitted.identity,
                    admitted.attempt_prepared_fact_id.clone(),
                ),
                use_count,
                target_revalidation_set_digest: set_digest.clone(),
            }),
        ));
        facts.push(fact_draft(
            started_id.clone(),
            KernelFactPayloadV2::Invocation(InvocationFactV2::ExecutionStarted {
                identity: caused_attempt(&admitted.identity, consumed_id),
                target_revalidation_set_digest: set_digest,
            }),
        ));
        self.commit_locked(&mut state, facts)?;
        Ok(Some(EffectReadyInvocation {
            admitted,
            preparation,
            execution_started_fact_id: started_id,
            _permit: PersistedEffectPermit,
        }))
    }

    fn finalize_execution(
        &self,
        ready: EffectReadyInvocation,
        resolution: ExecutionResolution,
    ) -> AuthorityResult<()> {
        let deadline_elapsed =
            ready.admitted.admitted_at.elapsed() >= ready.admitted.effective_deadline;
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let record = state
            .invocations
            .get(&ready.admitted.identity.invocation_id)
            .cloned()
            .ok_or_else(corrupt_store)?;
        if record.phase != InvocationPhase::Executing {
            return Err(corrupt_store());
        }
        let cancellation = record
            .stop_overlay
            .cancellation()
            .map(|(request_id, fact_id, _)| (request_id.clone(), fact_id.clone()));
        let mut drafts = Vec::with_capacity(4);
        if let Some((request_id, cancellation_fact_id)) = &cancellation {
            if record.cancellation_observed_fact_id.is_none() {
                drafts.push(fact_draft(
                    self.inner.ids.fact(),
                    KernelFactPayloadV2::Invocation(InvocationFactV2::CancellationObserved {
                        identity: caused_attempt(
                            &ready.admitted.identity,
                            cancellation_fact_id.clone(),
                        ),
                        cancel_request_id: request_id.clone(),
                    }),
                ));
            }
        }
        let deadline_observed = record.deadline_observed_fact_id.is_some() || deadline_elapsed;
        if deadline_elapsed && record.deadline_observed_fact_id.is_none() {
            drafts.push(fact_draft(
                self.inner.ids.fact(),
                KernelFactPayloadV2::Invocation(InvocationFactV2::DeadlineObserved {
                    identity: caused_attempt(
                        &ready.admitted.identity,
                        ready.admitted.identity.causation_fact_id.clone(),
                    ),
                }),
            ));
        }
        drafts.extend(execution_result_drafts(
            &ready.admitted.identity,
            &ready.execution_started_fact_id,
            self.inner.ids.typed("effect", EffectId::new),
            self.inner.ids.fact(),
            self.inner.ids.fact(),
            ready
                .preparation
                .revalidations
                .iter()
                .map(|item| item.resource_id.clone())
                .collect(),
            resolution,
            cancellation.as_ref().map(|(request_id, _)| request_id),
            deadline_observed,
        )?);
        if let Err(error) = self.commit_locked(&mut state, drafts) {
            state.storage_faulted = true;
            return Err(error);
        }
        Ok(())
    }

    fn fail_before_effect(
        &self,
        admitted: AuthorityAdmittedInvocation,
        error_code: PreEffectFailureCodeV2,
    ) -> AuthorityResult<()> {
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let terminal_id = self.inner.ids.fact();
        self.commit_locked(
            &mut state,
            failed_before_effect_drafts(
                &admitted.identity,
                &admitted.attempt_prepared_fact_id,
                terminal_id,
                self.inner.ids.fact(),
                error_code,
            ),
        )
    }

    fn record_submission_rejection(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        command: &InvocationSubmitV2,
        current_epoch: ControlEpoch,
        tool_id: AuthorityToolIdV4,
        submission_digest: InvocationSubmissionDigestV2,
        rejection: AdmissionRejectionV2,
    ) -> AuthorityResult<KernelReplyV2> {
        let idempotency_key_hash =
            idempotency_key_hash_v2(&command.request.run_id, &command.request.idempotency_key)
                .map_err(|_| corrupt_store())?;
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let rejection = match classify_submission_binding(
            &state,
            &command.request.run_id,
            &command.request.operation_id,
            &idempotency_key_hash,
            &submission_digest,
        )? {
            SubmissionDisposition::Replay(reply) => {
                self.commit_receipt_locked(
                    &mut state,
                    envelope,
                    command.request.run_id.clone(),
                    exact_epoch(current_epoch),
                    MutationCommandResultV2::InvocationSubmission {
                        reply: reply.clone(),
                    },
                )?;
                return Ok(KernelReplyV2::InvocationSubmission(reply));
            }
            SubmissionDisposition::Reject(rejection) => rejection,
            SubmissionDisposition::Fresh | SubmissionDisposition::Retry => rejection,
        };
        self.record_invocation_rejection_locked(
            &mut state,
            envelope,
            &command.request,
            current_epoch,
            tool_id,
            submission_digest,
            rejection,
        )
        .map(KernelReplyV2::InvocationSubmission)
    }

    fn record_invocation_rejection_locked(
        &self,
        state: &mut AuthorityState,
        envelope: &KernelCommandEnvelopeV2,
        request: &GrantRequestV2,
        current_epoch: ControlEpoch,
        tool_id: AuthorityToolIdV4,
        submission_digest: InvocationSubmissionDigestV2,
        rejection: AdmissionRejectionV2,
    ) -> AuthorityResult<InvocationSubmissionReplyV2> {
        let command_fact_id = self.inner.ids.fact();
        let rejection_fact_id = self.inner.ids.fact();
        let high_water = self.predicted_high_water(2)?;
        let reply = InvocationSubmissionReplyV2::Rejected {
            run_id: request.run_id.clone(),
            operation_id: request.operation_id.clone(),
            current_control_epoch: current_epoch,
            rejection: rejection.clone(),
            rejection_fact_id: rejection_fact_id.clone(),
            rejection_batch_high_water: high_water,
        };
        let command_digest =
            command_request_digest_v2(&envelope.command).map_err(|_| corrupt_store())?;
        self.commit_locked(
            state,
            invocation_rejection_drafts(
                command_fact_id,
                rejection_fact_id,
                envelope.request_id.clone(),
                command_digest,
                request,
                current_epoch,
                tool_id,
                submission_digest,
                rejection,
                reply.clone(),
            )?,
        )?;
        Ok(reply)
    }

    fn commit_receipt_locked(
        &self,
        state: &mut AuthorityState,
        envelope: &KernelCommandEnvelopeV2,
        run_id: RunId,
        epoch_context: CommandEpochContextV2,
        result: MutationCommandResultV2,
    ) -> AuthorityResult<()> {
        let command_digest =
            command_request_digest_v2(&envelope.command).map_err(|_| corrupt_store())?;
        self.commit_locked(
            state,
            vec![command_receipt_draft(
                self.inner.ids.fact(),
                run_id,
                epoch_context,
                envelope.request_id.clone(),
                command_digest,
                envelope.command.mutation_kind().ok_or_else(corrupt_store)?,
                result,
            )],
        )
    }

    fn record_semantic_error(
        &self,
        state: &mut AuthorityState,
        envelope: &KernelCommandEnvelopeV2,
        run_id: RunId,
        epoch_context: CommandEpochContextV2,
        error: RecordedCommandErrorV2,
    ) -> AuthorityResult<KernelReplyV2> {
        let reply = KernelReplyV2::Error(recorded_error_to_error(error.clone()));
        self.commit_receipt_locked(
            state,
            envelope,
            run_id,
            epoch_context,
            MutationCommandResultV2::RecordedSemanticError { error },
        )?;
        Ok(reply)
    }

    fn terminate_run(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        command: RunTerminateV2,
    ) -> AuthorityResult<KernelReplyV2> {
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let run = match self.check_run_command(
            &mut state,
            envelope,
            &command.run_id,
            command.expected_control_epoch,
            false,
        )? {
            RunCommandCheck::Current(run) => run,
            RunCommandCheck::Recorded(reply) => return Ok(reply),
        };
        if let RunLifecycle::Terminated {
            fact_id,
            ledger_sequence,
        } = &run.lifecycle
        {
            let (cancellation, pending) =
                plan_control_cancellation(&state, run.active_invocation_id.clone(), || {
                    self.inner.ids.cancellation()
                })?;
            if pending.is_some() {
                return Err(corrupt_store());
            }
            let reply = RunTerminatedReplyV2 {
                run_id: command.run_id.clone(),
                outcome: RunTerminationOutcomeV2::AlreadyTerminated {
                    termination_fact_id: fact_id.clone(),
                    ledger_sequence: *ledger_sequence,
                },
                cancellation,
                superseded_grant_count: 0,
                command_batch_high_water: self.predicted_high_water(1)?,
            };
            self.commit_receipt_locked(
                &mut state,
                envelope,
                command.run_id,
                exact_epoch(run.epoch),
                MutationCommandResultV2::RunTerminate {
                    reply: reply.clone(),
                },
            )?;
            return Ok(KernelReplyV2::RunTerminated(reply));
        }
        let command_digest =
            command_request_digest_v2(&envelope.command).map_err(|_| corrupt_store())?;
        let command_fact_id = self.inner.ids.fact();
        let termination_fact_id = self.inner.ids.fact();
        let issued_grants = state
            .grants
            .values()
            .filter(|grant| {
                grant.run_id == command.run_id && matches!(grant.lifecycle, GrantLifecycle::Issued)
            })
            .cloned()
            .collect::<Vec<_>>();
        let superseded_grant_count = issued_grants.len();
        let (cancellation, cancellation_fact) =
            plan_control_cancellation(&state, run.active_invocation_id.clone(), || {
                self.inner.ids.cancellation()
            })?;
        let batch_len = 2 + superseded_grant_count + usize::from(cancellation_fact.is_some());
        let current_high_water = self.high_water()?;
        let termination_sequence = current_high_water
            .checked_add(2)
            .ok_or_else(storage_fault)?;
        let batch_high_water = current_high_water
            .checked_add(batch_len as u64)
            .ok_or_else(storage_fault)?;
        let reply = RunTerminatedReplyV2 {
            run_id: command.run_id.clone(),
            outcome: RunTerminationOutcomeV2::Terminated {
                termination_fact_id: termination_fact_id.clone(),
                ledger_sequence: termination_sequence,
            },
            cancellation: cancellation.clone(),
            superseded_grant_count: superseded_grant_count as u64,
            command_batch_high_water: batch_high_water,
        };
        let superseded = issued_grants
            .into_iter()
            .map(|grant| (grant, self.inner.ids.fact()))
            .collect();
        let drafts = run_termination_drafts(
            envelope.request_id.clone(),
            command_digest,
            command,
            run.epoch,
            command_fact_id,
            termination_fact_id,
            superseded,
            cancellation_fact,
            reply.clone(),
        );
        self.commit_locked(&mut state, drafts)?;
        Ok(KernelReplyV2::RunTerminated(reply))
    }

    fn predicted_high_water(&self, batch_len: usize) -> AuthorityResult<u64> {
        self.high_water()?
            .checked_add(batch_len as u64)
            .ok_or_else(storage_fault)
    }

    fn high_water(&self) -> AuthorityResult<u64> {
        self.inner
            .reader
            .ledger_sequence_high_water()
            .map_err(|_| storage_fault())
    }

    fn commit_locked(
        &self,
        state: &mut AuthorityState,
        drafts: Vec<KernelFactDraftV2>,
    ) -> AuthorityResult<()> {
        let writer = self.inner.writer.lock().map_err(|_| storage_fault())?;
        let committed = writer.append_batch(drafts).map_err(|_| storage_fault())?;
        if let Err(error) = state.apply_committed(committed) {
            state.storage_faulted = true;
            return Err(error);
        }
        Ok(())
    }

    fn invocation_status(
        &self,
        run_id: &RunId,
        invocation_id: &InvocationId,
    ) -> AuthorityResult<KernelReplyV2> {
        let state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let high_water = self.high_water()?;
        Ok(KernelReplyV2::InvocationStatus(invocation_status_reply(
            &state,
            run_id,
            invocation_id,
            high_water,
        )?))
    }

    fn resolve_resource(&self, command: &ResourceResolveV2) -> AuthorityResult<KernelReplyV2> {
        let state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let high_water = self.high_water()?;
        Ok(KernelReplyV2::ResourceResolved(resource_resolve_reply(
            &state, command, high_water,
        )?))
    }

    fn query_facts(&self, command: &KernelFactsQueryV2) -> AuthorityResult<KernelReplyV2> {
        let filter = fact_query(command);
        let _state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let high_water = self.high_water()?;
        let facts = self
            .inner
            .reader
            .query(&filter)
            .map_err(|_| storage_fault())?;
        bounded_fact_page(
            command.page.after_ledger_sequence,
            high_water,
            facts,
            command.page.limit as usize,
        )
        .map(KernelReplyV2::KernelFacts)
    }

    fn reconcile_open_attempts(&self) -> AuthorityResult<()> {
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let drafts = recovery_drafts(
            &state,
            &self.inner.workspace.digest,
            || self.inner.ids.fact(),
            || self.inner.ids.typed("effect", EffectId::new),
        )?;
        if !drafts.is_empty() {
            self.commit_locked(&mut state, drafts)?;
        }
        Ok(())
    }
}
