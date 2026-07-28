use super::authority::{
    caused_direct_attempt, command_receipt_draft, corrupt_store, direct_execution_result_drafts,
    direct_failed_before_effect_drafts, direct_pre_effect_stop_drafts,
    direct_tool_intent_admission_drafts, direct_tool_intent_continuation_drafts,
    epoch_advance_drafts, exact_epoch, explicit_cancellation_drafts, fact_draft, invalid_field,
    plan_control_cancellation, plan_epoch_advance, prepare_direct_effect,
    prepare_direct_tool_intent, recorded_error_to_error, require_current_run, resolve_execution,
    resolve_workspace_binding, storage_fault, EffectPreparation, EpochAdvancePlan, PrepareFailure,
    RunCommandCheck,
};
use super::model::{
    invocation_phase_is_terminal, AuthorityResult, AuthorityState, ExecutionResolution,
    InvocationPhase, RawExecution, ResolvedTarget, WorkspaceBinding,
};
use crate::executors::{
    builtin_executors, invoke_document_read_complete, invoke_web_fetch_complete,
    KernelExecutorConfig, KernelExecutorRegistry, KernelToolExecutionContext, KernelToolInvocation,
    SecretProvider,
};
use deepcode_kernel_abi::v2::{
    command_request_digest_v2, target_revalidation_set_digest_v2, AttemptId, AuthorizationFactV2,
    CancelRequestId, CancellationReasonCodeV2, CommandEpochContextV2, CommandRequestId,
    ControlEpoch, EffectEvidenceV2, EffectId, FactId, IndeterminateReasonV2, InvocationAuthorityV2,
    InvocationFactV2, InvocationId, KernelFactDraftV2, KernelFactEnvelopeV2, KernelFactPayloadV2,
    LastObservationV2, MutationCommandResultV2, OperationId, PreEffectFailureCodeV2, RecordedAtV2,
    ResourceAttemptIdentityV2, ResourceFactV2, ResourceId, RunId, V2ValidationError,
};
use deepcode_kernel_abi::v2_command::{
    ControlEpochAdvanceV2, ControlEpochAdvancedReplyV2, InvalidFieldViolationV2,
    InvocationCancelReplyV2, InvocationCancelTargetV2, InvocationCancelV2, KernelCommandEnvelopeV2,
    KernelCommandV2, KernelErrorV2, KernelReplyV2, RecordedCommandErrorV2, ToolIntentSubmitReplyV2,
};
use deepcode_kernel_abi::{
    CanonicalArgumentsDigestV2, ToolContextRefV2, ToolContractDigestV2, ToolIdV2,
    WorkspaceBindingRefV2,
};
use deepcode_kernel_ledger::v2::{
    AppendWithAuthorityMaterialOutcomeV2, AppendWithPublicReceiptAndAuthorityMaterialOutcomeV2,
    AuthorityFactWriterLease, AuthorityMaterialDraftV2, AuthorityMaterialMutationV2,
    AuthorityMaterialRecordV2, CanonicalFactReader, CanonicalFactStore,
    ConsumeFactQueryContinuationOutcomeV2, FactQueryContinuationConsumerV2,
    FactQueryContinuationDraftV2, FactQueryContinuationExpectationV2, OutboxPublisherLease,
    PublicCommandReceiptV2, PutFactQueryContinuationOutcomeV2, PutPublicCommandReceiptOutcomeV2,
};
use deepcode_kernel_tools::ToolInvocationInputV4;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DIRECT_INVOCATION_MATERIAL_KIND: &str = "toolInvocation";
const DIRECT_INVOCATION_ADMITTED: &str = "admitted";
const DIRECT_INVOCATION_TERMINAL: &str = "terminal";

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
    workspaces: Mutex<HashMap<RunId, WorkspaceBinding>>,
    executor_config: KernelExecutorConfig,
    executors: Arc<KernelExecutorRegistry>,
    execution_tasks: Mutex<HashMap<InvocationId, std::thread::JoinHandle<()>>>,
    ids: IdMint,
}

/// Sole coordinator for the sealed v2 admission and effect chain.
/// It exposes no caller-constructible effect permit.
#[derive(Clone)]
pub(crate) struct AuthorityService {
    inner: Arc<ServiceInner>,
}

pub(super) struct DirectToolIntentRequest {
    pub(super) run_id: RunId,
    pub(super) operation_id: deepcode_kernel_abi::v2::OperationId,
    pub(super) control_epoch: ControlEpoch,
    pub(super) idempotency_key: String,
    pub(super) tool_id: ToolIdV2,
    pub(super) canonical_arguments_digest: CanonicalArgumentsDigestV2,
    pub(super) canonical_invocation: ToolInvocationInputV4,
    pub(super) authority: InvocationAuthorityV2,
    pub(super) tool_contract_digest: ToolContractDigestV2,
    pub(super) deadline: deepcode_kernel_abi::v2_command::DeadlineRequestV2,
}

pub(super) struct DirectToolIntentContinuationOutcome {
    pub(super) reply: ToolIntentSubmitReplyV2,
    pub(super) authorization_fact_id: FactId,
    pub(super) authorization_ledger_sequence: u64,
}

struct DirectAuthorityAdmittedInvocation {
    identity: deepcode_kernel_abi::v2::ToolAttemptIdentityV2,
    invocation: ToolInvocationInputV4,
    targets: Vec<(ResourceId, ResolvedTarget)>,
    attempt_prepared_fact_id: FactId,
    admitted_at: Instant,
    effective_deadline: Duration,
    authority_material: AuthorityMaterialDraftV2,
}

struct PersistedEffectPermit;

struct DirectEffectReadyInvocation {
    admitted: DirectAuthorityAdmittedInvocation,
    preparation: EffectPreparation,
    execution_started_fact_id: FactId,
    _permit: PersistedEffectPermit,
}

fn direct_invocation_authority_material(
    request: &DirectToolIntentRequest,
    identity: &deepcode_kernel_abi::v2::ToolAttemptIdentityV2,
    prepared: &super::model::PreparedDirectToolIntent,
    lifecycle: &str,
) -> AuthorityMaterialDraftV2 {
    AuthorityMaterialDraftV2 {
        material_kind: DIRECT_INVOCATION_MATERIAL_KIND.to_owned(),
        material_id: identity.invocation_id.to_string(),
        run_id: identity.run_id.clone(),
        control_epoch: identity.control_epoch.get(),
        lifecycle: lifecycle.to_owned(),
        operation_id: Some(identity.operation_id.clone()),
        invocation_id: Some(identity.invocation_id.clone()),
        lease: identity.authority.capability_lease().cloned(),
        payload_json: serde_json::json!({
            "runId": identity.run_id,
            "controlEpoch": identity.control_epoch,
            "operationId": identity.operation_id,
            "invocationId": identity.invocation_id,
            "attemptId": identity.attempt_id,
            "idempotencyKeyHash": identity.idempotency_key_hash,
            "toolId": request.tool_id,
            "canonicalArgumentsDigest": request.canonical_arguments_digest,
            "toolContractDigest": request.tool_contract_digest,
            "workspaceBindingDigest": prepared.workspace_binding_digest,
            "authority": identity.authority,
        }),
    }
}

fn terminal_direct_invocation_material(
    admitted: &DirectAuthorityAdmittedInvocation,
    fact_index: usize,
) -> AuthorityMaterialMutationV2 {
    let mut material = admitted.authority_material.clone();
    material.lifecycle = DIRECT_INVOCATION_TERMINAL.to_owned();
    AuthorityMaterialMutationV2::Replace {
        expected_lifecycle: DIRECT_INVOCATION_ADMITTED.to_owned(),
        expected_payload_digest: None,
        material,
        fact_index,
    }
}

fn recovered_terminal_direct_invocation_material(
    record: &AuthorityMaterialRecordV2,
    fact_index: usize,
) -> AuthorityResult<AuthorityMaterialMutationV2> {
    if record.material_kind != DIRECT_INVOCATION_MATERIAL_KIND
        || record.lifecycle != DIRECT_INVOCATION_ADMITTED
        || record.invocation_id.as_ref().map(InvocationId::as_str)
            != Some(record.material_id.as_str())
    {
        return Err(corrupt_store());
    }
    Ok(AuthorityMaterialMutationV2::Replace {
        expected_lifecycle: DIRECT_INVOCATION_ADMITTED.to_owned(),
        expected_payload_digest: Some(record.payload_digest.clone()),
        material: AuthorityMaterialDraftV2 {
            material_kind: record.material_kind.clone(),
            material_id: record.material_id.clone(),
            run_id: record.run_id.clone(),
            control_epoch: record.control_epoch,
            lifecycle: DIRECT_INVOCATION_TERMINAL.to_owned(),
            operation_id: record.operation_id.clone(),
            invocation_id: record.invocation_id.clone(),
            lease: record.lease.clone(),
            payload_json: record.payload_json.clone(),
        },
        fact_index,
    })
}

impl AuthorityService {
    pub(super) fn open(
        store: CanonicalFactStore,
        executor_config: KernelExecutorConfig,
        secret_provider: Arc<dyn SecretProvider>,
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
        let executors = Arc::new(KernelExecutorRegistry::from_executors(builtin_executors(
            crate::kernel_tool_registry(),
            executor_config.clone(),
            secret_provider,
        )));
        let service = Self {
            inner: Arc::new(ServiceInner {
                state: Mutex::new(state),
                writer: Mutex::new(writer),
                reader,
                _publisher: publisher,
                workspaces: Mutex::new(HashMap::new()),
                executor_config,
                executors,
                execution_tasks: Mutex::new(HashMap::new()),
                ids: IdMint::new(snapshot.ledger_sequence_high_water),
            }),
        };
        service.reconcile_open_attempts()?;
        Ok(service)
    }

    pub(super) fn bind_run_workspace(
        &self,
        run_id: &RunId,
        workspace_root: &Path,
    ) -> AuthorityResult<WorkspaceBinding> {
        let binding = resolve_workspace_binding(workspace_root)?;
        {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            if state.direct_invocations.values().any(|invocation| {
                invocation.run_id == *run_id
                    && invocation.workspace_binding_digest != binding.digest
            }) {
                return Err(invalid_field(
                    "workspaceRoot",
                    InvalidFieldViolationV2::OutOfRange,
                ));
            }
        }
        let mut workspaces = self.inner.workspaces.lock().map_err(|_| storage_fault())?;
        if let Some(existing) = workspaces.get(run_id) {
            if existing.digest != binding.digest {
                return Err(invalid_field(
                    "workspaceRoot",
                    InvalidFieldViolationV2::OutOfRange,
                ));
            }
            return Ok(existing.clone());
        }
        workspaces.insert(run_id.clone(), binding.clone());
        Ok(binding)
    }

    pub(super) fn workspace_for_run(&self, run_id: &RunId) -> AuthorityResult<WorkspaceBinding> {
        self.inner
            .workspaces
            .lock()
            .map_err(|_| storage_fault())?
            .get(run_id)
            .cloned()
            .ok_or_else(|| invalid_field("runId", InvalidFieldViolationV2::InvalidRelation))
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn canonical_scope_for_tool(
        &self,
        run_id: &RunId,
        operation_id: &OperationId,
        control_epoch: ControlEpoch,
        idempotency_key: &str,
        canonical_invocation: &deepcode_kernel_tools::ToolInvocationInputV4,
        deadline: deepcode_kernel_abi::v2_command::DeadlineRequestV2,
        correlation_refs: Vec<deepcode_kernel_abi::v2::CorrelationRefV2>,
    ) -> AuthorityResult<(deepcode_kernel_abi::v2::ResourceScopeV2, u32)> {
        {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            require_current_run(&state, run_id, control_epoch)?;
        }
        let workspace = self.workspace_for_run(run_id)?;
        let prepared = prepare_direct_tool_intent(
            run_id,
            operation_id,
            control_epoch,
            idempotency_key,
            canonical_invocation,
            deadline,
            correlation_refs,
            crate::kernel_tool_registry(),
            &workspace,
            &self.inner.executor_config,
        )
        .map_err(|failure| match failure {
            PrepareFailure::Kernel(error) => error,
            PrepareFailure::Target(reason) => {
                let _ = reason;
                invalid_field("rawArguments", InvalidFieldViolationV2::OutOfRange)
            }
        })?;
        Ok((prepared.resource_scope, prepared.effective_deadline_ms))
    }

    pub(super) fn open_run_with_public_receipt(
        &self,
        command: ControlEpochAdvanceV2,
        public_request_id: CommandRequestId,
        public_request_digest: deepcode_kernel_abi::v2::CommandRequestDigestV2,
        workspace_binding_ref: WorkspaceBindingRefV2,
        settings_ceiling_digest: deepcode_kernel_abi::v2::SettingsCeilingDigestV2,
        tool_context_ref: ToolContextRefV2,
        mut receipt: PublicCommandReceiptV2,
    ) -> AuthorityResult<ControlEpochAdvancedReplyV2> {
        let workspace = self.workspace_for_run(&command.run_id)?;
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
                EpochAdvancePlan::Recorded { .. } => return Err(corrupt_store()),
            };
        if previous_epoch.is_some() {
            return Err(corrupt_store());
        }

        let internal_request_id = self.inner.ids.typed("command", CommandRequestId::new);
        let internal_command = KernelCommandV2::ControlEpochAdvance(command.clone());
        let internal_digest =
            command_request_digest_v2(&internal_command).map_err(|_| corrupt_store())?;
        let command_fact_id = self.inner.ids.fact();
        let epoch_fact_id = self.inner.ids.fact();
        let run_opened_fact_id = self.inner.ids.fact();
        let high_water = self.predicted_high_water(3)?;
        let reply = ControlEpochAdvancedReplyV2 {
            run_id: command.run_id.clone(),
            accepted_control_epoch: new_epoch,
            epoch_fact_id: epoch_fact_id.clone(),
            superseded_capability_count: 0,
            cancellation: deepcode_kernel_abi::v2_command::ControlCancellationReplyV2::None {},
            command_batch_high_water: high_water,
        };
        let mut drafts = epoch_advance_drafts(
            internal_request_id,
            internal_digest,
            command.clone(),
            epoch_context,
            previous_epoch,
            new_epoch,
            command_fact_id,
            epoch_fact_id.clone(),
            None,
            reply.clone(),
        );
        drafts.push(KernelFactDraftV2 {
            fact_id: run_opened_fact_id.clone(),
            payload: KernelFactPayloadV2::Control(
                deepcode_kernel_abi::v2::ControlFactV2::RunOpened {
                    run_id: command.run_id,
                    control_epoch: new_epoch,
                    public_request_id,
                    public_request_digest,
                    causation_fact_id: epoch_fact_id,
                    workspace_binding_ref,
                    workspace_binding_digest: workspace.digest,
                    settings_ceiling_digest,
                    tool_context_ref,
                },
            ),
        });
        receipt.settlement_fact_id = Some(run_opened_fact_id);
        self.prevalidate_drafts(&state, &drafts)?;
        let outcome = self
            .inner
            .writer
            .lock()
            .map_err(|_| storage_fault())?
            .append_with_public_command_receipt(drafts, receipt)
            .map_err(|_| storage_fault())?;
        match outcome.receipt {
            PutPublicCommandReceiptOutcomeV2::Inserted(_) => {
                state.apply_committed(outcome.facts)?;
                Ok(reply)
            }
            PutPublicCommandReceiptOutcomeV2::ExistingSame(_)
            | PutPublicCommandReceiptOutcomeV2::DigestConflict { .. } => Err(corrupt_store()),
        }
    }

    pub(super) fn query_run_facts(
        &self,
        run_id: &RunId,
        after_ledger_sequence: u64,
        limit: u32,
    ) -> AuthorityResult<(
        u64,
        Vec<deepcode_kernel_abi::v2::KernelFactEnvelopeV2>,
        bool,
    )> {
        {
            let state = self.inner.state.lock().map_err(|_| storage_fault())?;
            if !state.runs.contains_key(run_id) {
                return Err(KernelErrorV2::RunNotFound {
                    run_id: run_id.clone(),
                });
            }
        }
        let high_water = self.high_water()?;
        let mut facts = self
            .inner
            .reader
            .query(&deepcode_kernel_ledger::v2::FactQueryV2 {
                run_id: Some(run_id.to_string()),
                after_ledger_sequence: Some(after_ledger_sequence),
                limit: Some(limit.saturating_add(1)),
                ..Default::default()
            })
            .map_err(|_| storage_fault())?;
        let has_more = facts.len() > limit as usize;
        facts.truncate(limit as usize);
        Ok((high_water, facts, has_more))
    }

    pub(super) fn snapshot_facts(
        &self,
    ) -> AuthorityResult<Vec<deepcode_kernel_abi::v2::KernelFactEnvelopeV2>> {
        self.inner
            .reader
            .snapshot()
            .map(|snapshot| snapshot.facts)
            .map_err(|_| storage_fault())
    }

    pub(super) fn public_command_receipt(
        &self,
        request_id: &deepcode_kernel_abi::v2::CommandRequestId,
    ) -> AuthorityResult<Option<PublicCommandReceiptV2>> {
        self.inner
            .reader
            .get_public_command_receipt(request_id)
            .map_err(|_| storage_fault())
    }

    pub(super) fn authority_material_snapshot(
        &self,
    ) -> AuthorityResult<Vec<AuthorityMaterialRecordV2>> {
        self.inner
            .reader
            .authority_material_snapshot()
            .map_err(|_| storage_fault())
    }

    pub(super) fn fact_reader(&self) -> CanonicalFactReader {
        self.inner.reader.clone()
    }

    pub(super) fn put_public_command_receipt(
        &self,
        receipt: PublicCommandReceiptV2,
    ) -> AuthorityResult<PutPublicCommandReceiptOutcomeV2> {
        self.inner
            .writer
            .lock()
            .map_err(|_| storage_fault())?
            .put_public_command_receipt_if_absent(receipt)
            .map_err(|_| storage_fault())
    }

    pub(super) fn put_fact_query_continuation(
        &self,
        continuation: FactQueryContinuationDraftV2,
    ) -> AuthorityResult<PutFactQueryContinuationOutcomeV2> {
        self.inner
            .writer
            .lock()
            .map_err(|_| storage_fault())?
            .put_fact_query_continuation_if_absent(continuation)
            .map_err(|_| storage_fault())
    }

    pub(super) fn consume_fact_query_continuation(
        &self,
        token: deepcode_kernel_abi::FactQueryContinuationV2,
        expected: FactQueryContinuationExpectationV2,
        consumer: FactQueryContinuationConsumerV2,
    ) -> AuthorityResult<ConsumeFactQueryContinuationOutcomeV2> {
        self.inner
            .writer
            .lock()
            .map_err(|_| storage_fault())?
            .consume_fact_query_continuation(token, expected, consumer)
            .map_err(|_| storage_fault())
    }

    pub(super) fn append_payloads_with_authority_material(
        &self,
        payloads: Vec<KernelFactPayloadV2>,
        mutations: Vec<AuthorityMaterialMutationV2>,
    ) -> AuthorityResult<AppendWithAuthorityMaterialOutcomeV2> {
        if payloads.is_empty() {
            return Err(storage_fault());
        }
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let drafts = payloads
            .into_iter()
            .map(|payload| KernelFactDraftV2 {
                fact_id: self.inner.ids.fact(),
                payload,
            })
            .collect::<Vec<_>>();
        self.prevalidate_drafts(&state, &drafts)?;
        let outcome = self
            .inner
            .writer
            .lock()
            .map_err(|_| storage_fault())?
            .append_with_authority_material(drafts, mutations)
            .map_err(|_| storage_fault())?;
        if let Err(error) = state.apply_committed(outcome.facts.clone()) {
            state.storage_faulted = true;
            return Err(error);
        }
        Ok(outcome)
    }

    pub(super) fn append_payloads_with_public_receipt_and_authority_material_builder<F>(
        &self,
        payloads: Vec<KernelFactPayloadV2>,
        settlement_index: Option<usize>,
        mutations: Vec<AuthorityMaterialMutationV2>,
        build_receipt: F,
    ) -> AuthorityResult<AppendWithPublicReceiptAndAuthorityMaterialOutcomeV2>
    where
        F: FnOnce(&[FactId], &[u64]) -> AuthorityResult<PublicCommandReceiptV2>,
    {
        if payloads.is_empty() || settlement_index.is_some_and(|index| index >= payloads.len()) {
            return Err(storage_fault());
        }
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let first_ledger_sequence = self
            .high_water()?
            .checked_add(1)
            .ok_or_else(storage_fault)?;
        let drafts = payloads
            .into_iter()
            .map(|payload| KernelFactDraftV2 {
                fact_id: self.inner.ids.fact(),
                payload,
            })
            .collect::<Vec<_>>();
        self.prevalidate_drafts(&state, &drafts)?;
        let fact_ids = drafts
            .iter()
            .map(|draft| draft.fact_id.clone())
            .collect::<Vec<_>>();
        let ledger_sequences = (0..drafts.len())
            .map(|offset| {
                first_ledger_sequence
                    .checked_add(offset as u64)
                    .ok_or_else(storage_fault)
            })
            .collect::<AuthorityResult<Vec<_>>>()?;
        let mut receipt = build_receipt(&fact_ids, &ledger_sequences)?;
        receipt.settlement_fact_id = settlement_index.map(|index| fact_ids[index].clone());
        let outcome = self
            .inner
            .writer
            .lock()
            .map_err(|_| storage_fault())?
            .append_with_public_receipt_and_authority_material(drafts, receipt, mutations)
            .map_err(|_| storage_fault())?;
        if !outcome.facts.is_empty() {
            if let Err(error) = state.apply_committed(outcome.facts.clone()) {
                state.storage_faulted = true;
                return Err(error);
            }
        }
        Ok(outcome)
    }

    pub(super) fn advance_epoch_with_public_receipt_and_authority_material<F>(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        command: ControlEpochAdvanceV2,
        material_mutations: Vec<AuthorityMaterialMutationV2>,
        build_receipt: F,
    ) -> AuthorityResult<KernelReplyV2>
    where
        F: FnOnce(&KernelReplyV2) -> AuthorityResult<PublicCommandReceiptV2> + 'static,
    {
        self.advance_epoch_inner(
            envelope,
            command,
            Some(Box::new(build_receipt)),
            material_mutations,
        )
    }

    fn advance_epoch_inner(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        command: ControlEpochAdvanceV2,
        public_receipt: Option<
            Box<dyn FnOnce(&KernelReplyV2) -> AuthorityResult<PublicCommandReceiptV2>>,
        >,
        material_mutations: Vec<AuthorityMaterialMutationV2>,
    ) -> AuthorityResult<KernelReplyV2> {
        self.workspace_for_run(&command.run_id)?;
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
        let active_invocation = state
            .runs
            .get(&command.run_id)
            .and_then(|run| run.active_invocation_id.clone());
        let (cancellation, cancellation_fact) =
            plan_control_cancellation(&state, active_invocation, || self.inner.ids.cancellation())?;
        let batch_len = 2 + usize::from(cancellation_fact.is_some());
        let high_water = self.predicted_high_water(batch_len)?;
        let reply = ControlEpochAdvancedReplyV2 {
            run_id: command.run_id.clone(),
            accepted_control_epoch: new_epoch,
            epoch_fact_id: epoch_fact_id.clone(),
            superseded_capability_count: 0,
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
            epoch_fact_id.clone(),
            cancellation_fact,
            reply.clone(),
        );
        let kernel_reply = KernelReplyV2::ControlEpochAdvanced(reply);
        if let Some(build_receipt) = public_receipt {
            let receipt = build_receipt(&kernel_reply)?;
            self.commit_locked_with_public_receipt_and_authority_material(
                &mut state,
                drafts,
                receipt,
                Some(epoch_fact_id),
                material_mutations,
            )?;
        } else if material_mutations.is_empty() {
            self.commit_locked(&mut state, drafts)?;
        } else {
            self.prevalidate_drafts(&state, &drafts)?;
            let outcome = self
                .inner
                .writer
                .lock()
                .map_err(|_| storage_fault())?
                .append_with_authority_material(drafts, material_mutations)
                .map_err(|_| storage_fault())?;
            if let Err(error) = state.apply_committed(outcome.facts) {
                state.storage_faulted = true;
                return Err(error);
            }
        }
        Ok(kernel_reply)
    }

    fn check_run_command(
        &self,
        state: &mut AuthorityState,
        envelope: &KernelCommandEnvelopeV2,
        run_id: &RunId,
        expected_epoch: ControlEpoch,
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

    pub(super) fn admit_direct_tool_intent_with_public_receipt<F>(
        &self,
        request: DirectToolIntentRequest,
        preferred_invocation_id: Option<InvocationId>,
        mut material_mutations: Vec<AuthorityMaterialMutationV2>,
        build_receipt: F,
    ) -> AuthorityResult<ToolIntentSubmitReplyV2>
    where
        F: FnOnce(&ToolIntentSubmitReplyV2) -> AuthorityResult<PublicCommandReceiptV2>,
    {
        self.reap_finished_execution_tasks()?;
        if request.canonical_invocation.tool_id().as_str() != request.tool_id.as_str() {
            return Err(invalid_field(
                "toolId",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let descriptor = crate::kernel_tool_registry()
            .get_v2(&request.tool_id)
            .ok_or_else(|| invalid_field("toolId", InvalidFieldViolationV2::InvalidEnum))?;
        let expected_contract_digest =
            deepcode_kernel_abi::tool_contract_digest_v2(&descriptor.descriptor_v2)
                .map_err(|_| corrupt_store())?;
        if descriptor.descriptor_v2.availability != deepcode_kernel_abi::ToolAvailabilityV2::Ready
            || descriptor.executor_binding.is_none()
            || expected_contract_digest != request.tool_contract_digest
        {
            return Err(invalid_field("toolId", InvalidFieldViolationV2::OutOfRange));
        }
        let workspace = self.workspace_for_run(&request.run_id)?;
        let correlation_refs = match &request.authority {
            InvocationAuthorityV2::ContextRead { .. } => Vec::new(),
            InvocationAuthorityV2::PlanAction { plan_action_id, .. } => {
                vec![deepcode_kernel_abi::v2::CorrelationRefV2::PlanAction {
                    value: plan_action_id.to_string(),
                }]
            }
        };
        let prepared = prepare_direct_tool_intent(
            &request.run_id,
            &request.operation_id,
            request.control_epoch,
            &request.idempotency_key,
            &request.canonical_invocation,
            request.deadline,
            correlation_refs,
            crate::kernel_tool_registry(),
            &workspace,
            &self.inner.executor_config,
        )
        .map_err(|failure| match failure {
            PrepareFailure::Kernel(error) => error,
            PrepareFailure::Target(reason) => {
                let _ = reason;
                invalid_field("rawArguments", InvalidFieldViolationV2::OutOfRange)
            }
        })?;
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let run =
            state
                .runs
                .get(&request.run_id)
                .cloned()
                .ok_or_else(|| KernelErrorV2::RunNotFound {
                    run_id: request.run_id.clone(),
                })?;
        if run.epoch != request.control_epoch {
            return Err(KernelErrorV2::StaleControlEpoch {
                run_id: request.run_id,
                submitted: request.control_epoch,
                current: run.epoch,
            });
        }
        if let Some(active_invocation_id) = run.active_invocation_id {
            let _ = active_invocation_id;
            return Err(invalid_field(
                "runId",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        if state
            .runs
            .values()
            .filter(|run| run.active_invocation_id.is_some())
            .count()
            >= 4
        {
            return Err(invalid_field("runId", InvalidFieldViolationV2::OutOfRange));
        }
        if state.direct_invocations.values().any(|existing| {
            existing.run_id == request.run_id
                && (existing.operation_id == request.operation_id
                    || existing.idempotency_key_hash == prepared.idempotency_key_hash)
        }) {
            return Err(invalid_field(
                "operationId",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let command_fact_id = self.inner.ids.fact();
        let admitted_fact_id = self.inner.ids.fact();
        let attempt_fact_id = self.inner.ids.fact();
        let invocation_id = preferred_invocation_id
            .unwrap_or_else(|| self.inner.ids.typed("invocation", InvocationId::new));
        let attempt_id = self.inner.ids.typed("attempt", AttemptId::new);
        let targets = prepared
            .resolved_targets
            .iter()
            .cloned()
            .map(|target| (self.inner.ids.typed("resource", ResourceId::new), target))
            .collect::<Vec<_>>();
        let resource_fact_ids = targets
            .iter()
            .map(|_| self.inner.ids.fact())
            .collect::<Vec<_>>();
        let high_water = self.predicted_high_water(3 + targets.len())?;
        let lease = request.authority.capability_lease().cloned();
        let reply = ToolIntentSubmitReplyV2::Admitted {
            run_id: request.run_id.clone(),
            operation_id: request.operation_id.clone(),
            accepted_control_epoch: request.control_epoch,
            lease,
            invocation_id: invocation_id.clone(),
            attempt_id: attempt_id.clone(),
            effective_deadline_ms: prepared.effective_deadline_ms,
            admission_fact_id: admitted_fact_id.clone(),
            admission_batch_high_water: high_water,
        };
        let identity = deepcode_kernel_abi::v2::ToolAttemptIdentityV2 {
            run_id: request.run_id.clone(),
            control_epoch: request.control_epoch,
            operation_id: request.operation_id.clone(),
            authority: request.authority.clone(),
            invocation_id: invocation_id.clone(),
            attempt_id,
            idempotency_key_hash: prepared.idempotency_key_hash.clone(),
            causation_fact_id: admitted_fact_id.clone(),
            correlation_set: prepared.correlations.clone(),
        };
        let authority_material = direct_invocation_authority_material(
            &request,
            &identity,
            &prepared,
            DIRECT_INVOCATION_ADMITTED,
        );
        material_mutations.push(AuthorityMaterialMutationV2::Put {
            material: authority_material.clone(),
            fact_index: 1,
        });
        let receipt = build_receipt(&reply)?;
        let request_id = receipt.command_request_id.clone();
        let request_digest = receipt.command_request_digest.clone();
        let drafts = direct_tool_intent_admission_drafts(
            command_fact_id,
            admitted_fact_id.clone(),
            attempt_fact_id.clone(),
            resource_fact_ids,
            request_id,
            request_digest,
            &prepared,
            request.tool_id,
            request.canonical_arguments_digest,
            request.tool_contract_digest,
            &identity,
            &targets,
            reply.clone(),
        );
        self.commit_locked_with_public_receipt_and_authority_material(
            &mut state,
            drafts,
            receipt,
            Some(admitted_fact_id),
            material_mutations,
        )?;
        drop(state);
        self.spawn_direct_execution(DirectAuthorityAdmittedInvocation {
            identity,
            invocation: prepared.canonical_invocation,
            targets,
            attempt_prepared_fact_id: attempt_fact_id,
            admitted_at: Instant::now(),
            effective_deadline: Duration::from_millis(u64::from(prepared.effective_deadline_ms)),
            authority_material,
        })?;
        Ok(reply)
    }

    pub(super) fn continue_direct_tool_intent_with_public_receipt<F>(
        &self,
        request: DirectToolIntentRequest,
        invocation_id: InvocationId,
        authorization: AuthorizationFactV2,
        mut material_mutations: Vec<AuthorityMaterialMutationV2>,
        build_receipt: F,
    ) -> AuthorityResult<DirectToolIntentContinuationOutcome>
    where
        F: FnOnce(
            &FactId,
            u64,
            &ToolIntentSubmitReplyV2,
        ) -> AuthorityResult<PublicCommandReceiptV2>,
    {
        self.reap_finished_execution_tasks()?;
        if request.canonical_invocation.tool_id().as_str() != request.tool_id.as_str() {
            return Err(invalid_field(
                "toolId",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let descriptor = crate::kernel_tool_registry()
            .get_v2(&request.tool_id)
            .ok_or_else(|| invalid_field("toolId", InvalidFieldViolationV2::InvalidEnum))?;
        let expected_contract_digest =
            deepcode_kernel_abi::tool_contract_digest_v2(&descriptor.descriptor_v2)
                .map_err(|_| corrupt_store())?;
        if descriptor.descriptor_v2.availability != deepcode_kernel_abi::ToolAvailabilityV2::Ready
            || descriptor.executor_binding.is_none()
            || expected_contract_digest != request.tool_contract_digest
        {
            return Err(invalid_field("toolId", InvalidFieldViolationV2::OutOfRange));
        }
        let workspace = self.workspace_for_run(&request.run_id)?;
        let correlation_refs = match &request.authority {
            InvocationAuthorityV2::ContextRead { .. } => Vec::new(),
            InvocationAuthorityV2::PlanAction { plan_action_id, .. } => {
                vec![deepcode_kernel_abi::v2::CorrelationRefV2::PlanAction {
                    value: plan_action_id.to_string(),
                }]
            }
        };
        let prepared = prepare_direct_tool_intent(
            &request.run_id,
            &request.operation_id,
            request.control_epoch,
            &request.idempotency_key,
            &request.canonical_invocation,
            request.deadline,
            correlation_refs,
            crate::kernel_tool_registry(),
            &workspace,
            &self.inner.executor_config,
        )
        .map_err(|failure| match failure {
            PrepareFailure::Kernel(error) => error,
            PrepareFailure::Target(reason) => {
                let _ = reason;
                invalid_field("rawArguments", InvalidFieldViolationV2::OutOfRange)
            }
        })?;
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let run =
            state
                .runs
                .get(&request.run_id)
                .cloned()
                .ok_or_else(|| KernelErrorV2::RunNotFound {
                    run_id: request.run_id.clone(),
                })?;
        if run.epoch != request.control_epoch {
            return Err(KernelErrorV2::StaleControlEpoch {
                run_id: request.run_id,
                submitted: request.control_epoch,
                current: run.epoch,
            });
        }
        if run.active_invocation_id.is_some() {
            return Err(invalid_field(
                "runId",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        if state
            .runs
            .values()
            .filter(|run| run.active_invocation_id.is_some())
            .count()
            >= 4
        {
            return Err(invalid_field("runId", InvalidFieldViolationV2::OutOfRange));
        }
        if state.direct_invocations.values().any(|existing| {
            existing.run_id == request.run_id
                && (existing.operation_id == request.operation_id
                    || existing.idempotency_key_hash == prepared.idempotency_key_hash)
        }) {
            return Err(invalid_field(
                "operationId",
                InvalidFieldViolationV2::InvalidRelation,
            ));
        }
        let authorization_fact_id = self.inner.ids.fact();
        let admitted_fact_id = self.inner.ids.fact();
        let attempt_fact_id = self.inner.ids.fact();
        let attempt_id = self.inner.ids.typed("attempt", AttemptId::new);
        let targets = prepared
            .resolved_targets
            .iter()
            .cloned()
            .map(|target| (self.inner.ids.typed("resource", ResourceId::new), target))
            .collect::<Vec<_>>();
        let resource_fact_ids = targets
            .iter()
            .map(|_| self.inner.ids.fact())
            .collect::<Vec<_>>();
        let batch_len = 3 + targets.len();
        let high_water = self.predicted_high_water(batch_len)?;
        let authorization_ledger_sequence = high_water
            .checked_sub(batch_len as u64)
            .and_then(|value| value.checked_add(1))
            .ok_or_else(storage_fault)?;
        let lease = request.authority.capability_lease().cloned();
        let reply = ToolIntentSubmitReplyV2::Admitted {
            run_id: request.run_id.clone(),
            operation_id: request.operation_id.clone(),
            accepted_control_epoch: request.control_epoch,
            lease,
            invocation_id: invocation_id.clone(),
            attempt_id: attempt_id.clone(),
            effective_deadline_ms: prepared.effective_deadline_ms,
            admission_fact_id: admitted_fact_id.clone(),
            admission_batch_high_water: high_water,
        };
        let identity = deepcode_kernel_abi::v2::ToolAttemptIdentityV2 {
            run_id: request.run_id.clone(),
            control_epoch: request.control_epoch,
            operation_id: request.operation_id.clone(),
            authority: request.authority.clone(),
            invocation_id: invocation_id.clone(),
            attempt_id,
            idempotency_key_hash: prepared.idempotency_key_hash.clone(),
            causation_fact_id: admitted_fact_id.clone(),
            correlation_set: prepared.correlations.clone(),
        };
        let authority_material = direct_invocation_authority_material(
            &request,
            &identity,
            &prepared,
            DIRECT_INVOCATION_ADMITTED,
        );
        material_mutations.push(AuthorityMaterialMutationV2::Put {
            material: authority_material.clone(),
            fact_index: 1,
        });
        let receipt = build_receipt(
            &authorization_fact_id,
            authorization_ledger_sequence,
            &reply,
        )?;
        let drafts = direct_tool_intent_continuation_drafts(
            authorization_fact_id.clone(),
            authorization,
            admitted_fact_id.clone(),
            attempt_fact_id.clone(),
            resource_fact_ids,
            &prepared,
            request.tool_id,
            request.canonical_arguments_digest,
            request.tool_contract_digest,
            &identity,
            &targets,
        );
        self.commit_locked_with_public_receipt_and_authority_material(
            &mut state,
            drafts,
            receipt,
            Some(authorization_fact_id.clone()),
            material_mutations,
        )?;
        drop(state);
        self.spawn_direct_execution(DirectAuthorityAdmittedInvocation {
            identity,
            invocation: prepared.canonical_invocation,
            targets,
            attempt_prepared_fact_id: attempt_fact_id,
            admitted_at: Instant::now(),
            effective_deadline: Duration::from_millis(u64::from(prepared.effective_deadline_ms)),
            authority_material,
        })?;
        Ok(DirectToolIntentContinuationOutcome {
            reply,
            authorization_fact_id,
            authorization_ledger_sequence,
        })
    }

    fn spawn_direct_execution(
        &self,
        admitted: DirectAuthorityAdmittedInvocation,
    ) -> AuthorityResult<()> {
        let service = self.clone();
        let invocation_id = admitted.identity.invocation_id.clone();
        let thread_name = format!("deepcode-v2-{invocation_id}");
        let pending = Arc::new(Mutex::new(Some(admitted)));
        let task_pending = Arc::clone(&pending);
        match std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                if let Ok(mut pending) = task_pending.lock() {
                    if let Some(admitted) = pending.take() {
                        service.execute_direct_admitted(admitted);
                    }
                }
            }) {
            Ok(handle) => {
                let replaced = self
                    .inner
                    .execution_tasks
                    .lock()
                    .map_err(|_| storage_fault())?
                    .insert(invocation_id, handle);
                if replaced.is_some() {
                    return Err(corrupt_store());
                }
            }
            Err(_) => {
                let admitted = pending
                    .lock()
                    .map_err(|_| storage_fault())?
                    .take()
                    .ok_or_else(corrupt_store)?;
                self.fail_direct_before_effect(
                    admitted,
                    PreEffectFailureCodeV2::ExecutorUnavailable,
                )?;
            }
        }
        Ok(())
    }

    fn execute_direct_admitted(&self, admitted: DirectAuthorityAdmittedInvocation) {
        let workspace = match self.workspace_for_run(&admitted.identity.run_id) {
            Ok(workspace) => workspace,
            Err(_) => {
                let _ = self.fail_direct_before_effect(
                    admitted,
                    PreEffectFailureCodeV2::ExecutorUnavailable,
                );
                return;
            }
        };
        let preparation = match prepare_direct_effect(
            &admitted.invocation,
            &admitted.targets,
            &admitted.identity,
            &workspace,
            &self.inner.executor_config,
        ) {
            Ok(value) => value,
            Err(code) => {
                let _ = self.fail_direct_before_effect(admitted, code);
                return;
            }
        };
        let ready = match self.persist_direct_effect_boundary(admitted, preparation) {
            Ok(Some(value)) => value,
            Ok(None) | Err(_) => return,
        };
        let invocation = KernelToolInvocation {
            id: ready.admitted.identity.invocation_id.to_string(),
            tool_id: ready.admitted.invocation.tool_id().as_str().to_owned(),
            input: ready.preparation.executor_input.clone(),
        };
        let context = KernelToolExecutionContext {
            workspace_root: Some(workspace.canonical_root_utf8.clone()),
        };
        let registration = match crate::kernel_tool_registry().get(&invocation.tool_id) {
            Some(registration) => registration,
            None => return,
        };
        let raw = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match registration.admission_v2.execution_adapter {
                deepcode_kernel_tools::KernelExecutionAdapterV2::DocumentRead => {
                    invoke_document_read_complete(invocation, context).map(|value| RawExecution {
                        output: value.execution.output,
                        complete_document_text: Some(value.complete_text),
                        http_status_code: None,
                        http_content_type: None,
                    })
                }
                deepcode_kernel_tools::KernelExecutionAdapterV2::WebFetch => {
                    invoke_web_fetch_complete(invocation).map(|value| RawExecution {
                        output: value.execution.output,
                        complete_document_text: None,
                        http_status_code: Some(value.status_code),
                        http_content_type: Some(value.content_type),
                    })
                }
                deepcode_kernel_tools::KernelExecutionAdapterV2::Standard => {
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
        let resolution = resolve_execution(
            &ready.admitted.invocation,
            &ready.preparation,
            raw,
            &workspace,
            registration.admission_v2.maximum_output_bytes,
        );
        let _ = self.finalize_direct_execution(ready, resolution);
    }

    fn persist_direct_effect_boundary(
        &self,
        admitted: DirectAuthorityAdmittedInvocation,
        preparation: EffectPreparation,
    ) -> AuthorityResult<Option<DirectEffectReadyInvocation>> {
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let record = state
            .direct_invocations
            .get(&admitted.identity.invocation_id)
            .cloned()
            .ok_or_else(corrupt_store)?;
        if let Some((cancel_id, cancel_fact_id, _)) = record.stop_overlay.cancellation() {
            let drafts = direct_pre_effect_stop_drafts(
                &admitted.identity,
                self.inner.ids.fact(),
                self.inner.ids.fact(),
                Some((cancel_id, cancel_fact_id)),
            );
            let terminal_index = drafts.len().checked_sub(1).ok_or_else(corrupt_store)?;
            self.commit_locked_with_authority_material(
                &mut state,
                drafts,
                vec![terminal_direct_invocation_material(
                    &admitted,
                    terminal_index,
                )],
            )?;
            return Ok(None);
        }
        if admitted.admitted_at.elapsed() >= admitted.effective_deadline {
            let drafts = direct_pre_effect_stop_drafts(
                &admitted.identity,
                self.inner.ids.fact(),
                self.inner.ids.fact(),
                None,
            );
            let terminal_index = drafts.len().checked_sub(1).ok_or_else(corrupt_store)?;
            self.commit_locked_with_authority_material(
                &mut state,
                drafts,
                vec![terminal_direct_invocation_material(
                    &admitted,
                    terminal_index,
                )],
            )?;
            return Ok(None);
        }
        let mut facts = Vec::with_capacity(preparation.revalidations.len() + 1);
        let mut set = Vec::with_capacity(preparation.revalidations.len());
        for item in &preparation.revalidations {
            let resolution_fact_id = state
                .resources
                .get(&item.resource_id)
                .filter(|resource| resource.invocation_id == admitted.identity.invocation_id)
                .map(|resource| resource.resolution_fact_id.clone())
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
        let started_id = self.inner.ids.fact();
        let causation = set
            .last()
            .map(|(_, fact_id, _)| fact_id.clone())
            .unwrap_or_else(|| admitted.attempt_prepared_fact_id.clone());
        facts.push(fact_draft(
            started_id.clone(),
            KernelFactPayloadV2::Invocation(InvocationFactV2::ToolExecutionStarted {
                identity: caused_direct_attempt(&admitted.identity, causation),
                target_revalidation_set_digest: set_digest,
            }),
        ));
        self.commit_locked(&mut state, facts)?;
        Ok(Some(DirectEffectReadyInvocation {
            admitted,
            preparation,
            execution_started_fact_id: started_id,
            _permit: PersistedEffectPermit,
        }))
    }

    fn finalize_direct_execution(
        &self,
        ready: DirectEffectReadyInvocation,
        resolution: ExecutionResolution,
    ) -> AuthorityResult<()> {
        let deadline_elapsed =
            ready.admitted.admitted_at.elapsed() >= ready.admitted.effective_deadline;
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let record = state
            .direct_invocations
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
                    KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCancellationObserved {
                        identity: caused_direct_attempt(
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
                KernelFactPayloadV2::Invocation(InvocationFactV2::ToolDeadlineObserved {
                    identity: caused_direct_attempt(
                        &ready.admitted.identity,
                        ready.admitted.identity.causation_fact_id.clone(),
                    ),
                }),
            ));
        }
        drafts.extend(direct_execution_result_drafts(
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
        let terminal_index = drafts.len().checked_sub(1).ok_or_else(corrupt_store)?;
        if let Err(error) = self.commit_locked_with_authority_material(
            &mut state,
            drafts,
            vec![terminal_direct_invocation_material(
                &ready.admitted,
                terminal_index,
            )],
        ) {
            state.storage_faulted = true;
            return Err(error);
        }
        Ok(())
    }

    fn fail_direct_before_effect(
        &self,
        admitted: DirectAuthorityAdmittedInvocation,
        error_code: PreEffectFailureCodeV2,
    ) -> AuthorityResult<()> {
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let drafts = direct_failed_before_effect_drafts(
            &admitted.identity,
            &admitted.attempt_prepared_fact_id,
            self.inner.ids.fact(),
            error_code,
        );
        let terminal_index = drafts.len().checked_sub(1).ok_or_else(corrupt_store)?;
        self.commit_locked_with_authority_material(
            &mut state,
            drafts,
            vec![terminal_direct_invocation_material(
                &admitted,
                terminal_index,
            )],
        )
    }

    fn reap_finished_execution_tasks(&self) -> AuthorityResult<()> {
        let finished = {
            let mut tasks = self
                .inner
                .execution_tasks
                .lock()
                .map_err(|_| storage_fault())?;
            let invocation_ids = tasks
                .iter()
                .filter_map(|(invocation_id, handle)| {
                    handle.is_finished().then_some(invocation_id.clone())
                })
                .collect::<Vec<_>>();
            invocation_ids
                .into_iter()
                .filter_map(|invocation_id| tasks.remove(&invocation_id))
                .collect::<Vec<_>>()
        };
        for handle in finished {
            if handle.join().is_err() {
                return Err(corrupt_store());
            }
        }
        Ok(())
    }

    pub(super) fn join_owned_execution_tasks(&self) -> AuthorityResult<()> {
        let tasks = {
            let mut tasks = self
                .inner
                .execution_tasks
                .lock()
                .map_err(|_| storage_fault())?;
            tasks.drain().map(|(_, handle)| handle).collect::<Vec<_>>()
        };
        for handle in tasks {
            if handle.join().is_err() {
                return Err(corrupt_store());
            }
        }
        Ok(())
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
        )? {
            RunCommandCheck::Current(run) => run,
            RunCommandCheck::Recorded(reply) => return Ok(reply),
        };
        let target_id = match command.target.clone() {
            InvocationCancelTargetV2::CurrentForRun {} => run.active_invocation_id.clone(),
            InvocationCancelTargetV2::Exact { invocation_id } => {
                let invocation_run_id = state
                    .direct_invocations
                    .get(&invocation_id)
                    .map(|invocation| &invocation.run_id);
                let Some(invocation_run_id) = invocation_run_id else {
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
                if invocation_run_id != &command.run_id {
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
                let (phase, last_fact_id, stop_overlay) =
                    if let Some(invocation) = state.direct_invocations.get(&invocation_id) {
                        (
                            invocation.phase,
                            invocation.last_fact_id.clone(),
                            invocation.stop_overlay.clone(),
                        )
                    } else {
                        return Err(corrupt_store());
                    };
                if invocation_phase_is_terminal(phase) {
                    InvocationCancelReplyV2::AlreadyTerminal {
                        invocation_id,
                        terminal_fact_id: last_fact_id,
                        terminal_phase: phase,
                    }
                } else if run.active_invocation_id.as_ref() != Some(&invocation_id) {
                    return Err(corrupt_store());
                } else if let Some((cancel_request_id, fact_id, ledger_sequence)) =
                    stop_overlay.cancellation()
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

    pub(super) fn cancel_invocation_command(
        &self,
        envelope: &KernelCommandEnvelopeV2,
        command: InvocationCancelV2,
    ) -> AuthorityResult<InvocationCancelReplyV2> {
        match self.cancel_invocation(envelope, command)? {
            KernelReplyV2::InvocationCancelResult(reply) => Ok(reply),
            _ => Err(corrupt_store()),
        }
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

    fn prevalidate_drafts(
        &self,
        state: &AuthorityState,
        drafts: &[KernelFactDraftV2],
    ) -> AuthorityResult<()> {
        if drafts.is_empty() {
            return Err(corrupt_store());
        }
        let durable_high_water = self.high_water()?;
        let state_high_water = state
            .facts_by_id
            .values()
            .map(|fact| fact.ledger_sequence)
            .max()
            .unwrap_or(0);
        if durable_high_water != state_high_water {
            return Err(corrupt_store());
        }
        let mut next_ledger_sequence = durable_high_water;
        let mut run_high_waters = HashMap::<RunId, u64>::new();
        for fact in state.facts_by_id.values() {
            run_high_waters
                .entry(fact.payload.run_id().clone())
                .and_modify(|high_water| {
                    *high_water = (*high_water).max(fact.run_sequence);
                })
                .or_insert(fact.run_sequence);
        }
        let recorded_at =
            RecordedAtV2::new("1970-01-01T00:00:00.000Z").map_err(|_| corrupt_store())?;
        let mut envelopes = Vec::with_capacity(drafts.len());
        for draft in drafts {
            next_ledger_sequence = next_ledger_sequence
                .checked_add(1)
                .ok_or_else(corrupt_store)?;
            let run_id = draft.payload.run_id().clone();
            let run_sequence = run_high_waters
                .get(&run_id)
                .copied()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(corrupt_store)?;
            run_high_waters.insert(run_id, run_sequence);
            let envelope = KernelFactEnvelopeV2 {
                abi_version: deepcode_kernel_abi::KERNEL_ABI_V2_VERSION.to_owned(),
                fact_id: draft.fact_id.clone(),
                ledger_sequence: next_ledger_sequence,
                run_sequence,
                recorded_at: recorded_at.clone(),
                payload: draft.payload.clone(),
            };
            envelope.validate().map_err(|_| corrupt_store())?;
            envelopes.push(envelope);
        }
        let mut projected = state.clone();
        projected.apply_committed(envelopes)
    }

    fn commit_locked(
        &self,
        state: &mut AuthorityState,
        drafts: Vec<KernelFactDraftV2>,
    ) -> AuthorityResult<()> {
        self.prevalidate_drafts(state, &drafts)?;
        let writer = self.inner.writer.lock().map_err(|_| storage_fault())?;
        let committed = writer.append_batch(drafts).map_err(|_| storage_fault())?;
        if let Err(error) = state.apply_committed(committed) {
            state.storage_faulted = true;
            return Err(error);
        }
        Ok(())
    }

    fn commit_locked_with_authority_material(
        &self,
        state: &mut AuthorityState,
        drafts: Vec<KernelFactDraftV2>,
        mutations: Vec<AuthorityMaterialMutationV2>,
    ) -> AuthorityResult<()> {
        self.prevalidate_drafts(state, &drafts)?;
        let outcome = self
            .inner
            .writer
            .lock()
            .map_err(|_| storage_fault())?
            .append_with_authority_material(drafts, mutations)
            .map_err(|_| storage_fault())?;
        if let Err(error) = state.apply_committed(outcome.facts) {
            state.storage_faulted = true;
            return Err(error);
        }
        Ok(())
    }

    fn commit_locked_with_public_receipt_and_authority_material(
        &self,
        state: &mut AuthorityState,
        drafts: Vec<KernelFactDraftV2>,
        mut receipt: PublicCommandReceiptV2,
        settlement_fact_id: Option<FactId>,
        mutations: Vec<AuthorityMaterialMutationV2>,
    ) -> AuthorityResult<()> {
        receipt.settlement_fact_id = settlement_fact_id;
        self.prevalidate_drafts(state, &drafts)?;
        let outcome = self
            .inner
            .writer
            .lock()
            .map_err(|_| storage_fault())?
            .append_with_public_receipt_and_authority_material(drafts, receipt, mutations)
            .map_err(|_| storage_fault())?;
        match outcome.receipt {
            PutPublicCommandReceiptOutcomeV2::Inserted(_) => {}
            PutPublicCommandReceiptOutcomeV2::ExistingSame(_)
            | PutPublicCommandReceiptOutcomeV2::DigestConflict { .. } => {
                return Err(corrupt_store())
            }
        }
        if let Err(error) = state.apply_committed(outcome.facts) {
            state.storage_faulted = true;
            return Err(error);
        }
        Ok(())
    }

    fn reconcile_open_attempts(&self) -> AuthorityResult<()> {
        let material = self
            .inner
            .reader
            .authority_material_snapshot()
            .map_err(|_| storage_fault())?;
        let material_by_invocation = material
            .into_iter()
            .filter(|record| record.material_kind == DIRECT_INVOCATION_MATERIAL_KIND)
            .map(|record| (record.material_id.clone(), record))
            .collect::<HashMap<_, _>>();
        let mut state = self.inner.state.lock().map_err(|_| storage_fault())?;
        let open = state
            .direct_invocations
            .values()
            .filter(|invocation| !invocation_phase_is_terminal(invocation.phase))
            .cloned()
            .collect::<Vec<_>>();
        for invocation in open {
            let identity = deepcode_kernel_abi::v2::ToolAttemptIdentityV2 {
                run_id: invocation.run_id.clone(),
                control_epoch: invocation.control_epoch,
                operation_id: invocation.operation_id.clone(),
                authority: invocation.authority.clone(),
                invocation_id: invocation.invocation_id.clone(),
                attempt_id: invocation.attempt_id.clone(),
                idempotency_key_hash: invocation.idempotency_key_hash.clone(),
                causation_fact_id: invocation.admission_fact_id.clone(),
                correlation_set: invocation.correlations.clone(),
            };
            let drafts = match invocation.phase {
                InvocationPhase::AttemptPrepared => {
                    let attempt_fact_id = invocation
                        .attempt_prepared_fact_id
                        .as_ref()
                        .ok_or_else(corrupt_store)?;
                    if let Some((cancel_request_id, cancellation_fact_id, _)) =
                        invocation.stop_overlay.cancellation()
                    {
                        direct_pre_effect_stop_drafts(
                            &identity,
                            self.inner.ids.fact(),
                            self.inner.ids.fact(),
                            Some((cancel_request_id, cancellation_fact_id)),
                        )
                    } else if invocation.stop_overlay.deadline_observed() {
                        direct_pre_effect_stop_drafts(
                            &identity,
                            self.inner.ids.fact(),
                            self.inner.ids.fact(),
                            None,
                        )
                    } else {
                        direct_failed_before_effect_drafts(
                            &identity,
                            attempt_fact_id,
                            self.inner.ids.fact(),
                            PreEffectFailureCodeV2::TargetRevalidationFailed,
                        )
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
                    direct_execution_result_drafts(
                        &identity,
                        execution_started_fact_id,
                        self.inner.ids.typed("effect", EffectId::new),
                        self.inner.ids.fact(),
                        self.inner.ids.fact(),
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
                    )?
                }
                _ => return Err(corrupt_store()),
            };
            let terminal_index = drafts.len().checked_sub(1).ok_or_else(corrupt_store)?;
            let material_record = material_by_invocation
                .get(invocation.invocation_id.as_str())
                .ok_or_else(corrupt_store)?;
            self.commit_locked_with_authority_material(
                &mut state,
                drafts,
                vec![recovered_terminal_direct_invocation_material(
                    material_record,
                    terminal_index,
                )?],
            )?;
        }
        Ok(())
    }
}
