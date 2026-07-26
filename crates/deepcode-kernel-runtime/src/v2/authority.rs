use super::model::{
    require_non_empty, AuthorityError, AuthorityResult, CapabilityScope, ControlAdvance,
    EffectCompletion, GrantIssueRequest, GrantLifecycle, GrantReservationLifecycle, GrantSnapshot,
    InvocationAdmission, InvocationLifecycle, InvocationSnapshot, InvocationSubmitRequest,
    TerminalInvocationOutcome,
};
use deepcode_kernel_abi::v2::{
    AttemptId, CausalIdentityV2, ControlEpoch, ControlFactKindV2, ControlFactV2, EffectFactV2,
    EffectId, EffectOutcomeV2, FactId, GrantFactKindV2, GrantFactV2, GrantId, GrantReservationId,
    GrantUsePolicyV2, InputId, InvocationFactKindV2, InvocationFactV2, InvocationId,
    KernelErrorCodeV2, KernelFactDraftV2, KernelFactEnvelopeV2, KernelFactPayloadV2, OperationId,
    RunId,
};
use deepcode_kernel_ledger::v2::CanonicalFactStore;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static AUTHORITY_INSTANCE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
struct GrantReservation {
    reservation_id: GrantReservationId,
    invocation_id: InvocationId,
    operation_id: OperationId,
    control_epoch: ControlEpoch,
    lifecycle: GrantReservationLifecycle,
}

#[derive(Debug, Clone)]
struct GrantRecord {
    grant_id: GrantId,
    run_id: RunId,
    control_epoch: ControlEpoch,
    scope: CapabilityScope,
    request_digest: String,
    lifecycle: GrantLifecycle,
    observed_use_count: u64,
    reservations: HashMap<GrantReservationId, GrantReservation>,
}

#[derive(Debug, Clone)]
struct InvocationRecord {
    invocation_id: InvocationId,
    run_id: RunId,
    operation_id: OperationId,
    control_epoch: ControlEpoch,
    grant_id: GrantId,
    reservation_id: GrantReservationId,
    scope: CapabilityScope,
    request_digest: String,
    idempotency_key_hash: String,
    attempt_id: Option<AttemptId>,
    lifecycle: InvocationLifecycle,
    last_fact_id: FactId,
    effect_outcome: Option<EffectOutcomeV2>,
}

#[derive(Debug, Clone)]
struct OperationRecord {
    request_digest: String,
    admission: InvocationAdmission,
}

#[derive(Debug, Clone)]
struct GrantOperationRecord {
    request_digest: String,
    grant_id: GrantId,
}

#[derive(Debug, Clone)]
struct ReplaySubmission {
    fact_id: FactId,
    run_id: RunId,
    operation_id: OperationId,
    control_epoch: ControlEpoch,
    tool_id: String,
    request_digest: String,
    idempotency_key_hash: String,
}

#[derive(Debug, Clone)]
struct ReplayReservation {
    fact_id: FactId,
    run_id: RunId,
    operation_id: OperationId,
    control_epoch: ControlEpoch,
    grant_id: GrantId,
    reservation_id: GrantReservationId,
}

#[derive(Debug, Default)]
struct ReplayPending {
    submissions: HashMap<InvocationId, ReplaySubmission>,
    reservations: HashMap<InvocationId, ReplayReservation>,
}

#[derive(Debug, Clone)]
struct IdentityParts {
    run_id: RunId,
    control_epoch: ControlEpoch,
    operation_id: Option<OperationId>,
    grant_id: Option<GrantId>,
    reservation_id: Option<GrantReservationId>,
    invocation_id: Option<InvocationId>,
    attempt_id: Option<AttemptId>,
    causation_id: Option<FactId>,
    idempotency_key_hash: Option<String>,
}

/// Dark v2 authority coordinator.
///
/// This type is deliberately not connected to the production command ingress.
/// It owns only authority state and canonical fact writes; scheduling and
/// executor dispatch remain outside this SP2 core.
pub(crate) struct AuthorityRuntime {
    fact_store: CanonicalFactStore,
    current_epochs: HashMap<RunId, ControlEpoch>,
    grants: HashMap<GrantId, GrantRecord>,
    grant_operations: HashMap<(RunId, OperationId), GrantOperationRecord>,
    invocations: HashMap<InvocationId, InvocationRecord>,
    operations: HashMap<(RunId, OperationId), OperationRecord>,
    instance_nonce: String,
    next_id: u64,
    storage_faulted_after_effect: bool,
}

impl std::fmt::Debug for AuthorityRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthorityRuntime")
            .field("current_epochs", &self.current_epochs)
            .field("grants", &self.grants)
            .field("grant_operations", &self.grant_operations)
            .field("invocations", &self.invocations)
            .field("operations", &self.operations)
            .field(
                "storage_faulted_after_effect",
                &self.storage_faulted_after_effect,
            )
            .finish_non_exhaustive()
    }
}

impl AuthorityRuntime {
    /// Opens the authority coordinator from the canonical fact snapshot.
    ///
    /// Existing facts are always reduced before this method returns. An
    /// unclosed durable attempt is failed before effect, while an unclosed
    /// effect boundary is persisted as indeterminate. Recovery never exposes
    /// a silently empty executable authority state.
    pub(crate) fn open(fact_store: CanonicalFactStore) -> AuthorityResult<Self> {
        let snapshot =
            fact_store
                .snapshot()
                .map_err(|error| AuthorityError::FactStoreUnavailable {
                    operation: "restore_authority_state",
                    message: error.to_string(),
                })?;
        let instance_sequence = AUTHORITY_INSTANCE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let startup_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let mut runtime = Self {
            fact_store,
            current_epochs: HashMap::new(),
            grants: HashMap::new(),
            grant_operations: HashMap::new(),
            invocations: HashMap::new(),
            operations: HashMap::new(),
            instance_nonce: format!(
                "{startup_nanos:x}-{:x}-{:x}-{instance_sequence:x}",
                std::process::id(),
                snapshot.ledger_sequence_high_water
            ),
            next_id: 1,
            storage_faulted_after_effect: false,
        };
        runtime.replay(snapshot.facts)?;
        runtime.reconcile_unclosed_attempts()?;
        Ok(runtime)
    }

    pub(crate) fn fact_store(&self) -> &CanonicalFactStore {
        &self.fact_store
    }

    pub(crate) fn current_epoch(&self, run_id: &RunId) -> Option<ControlEpoch> {
        self.current_epochs.get(run_id).copied()
    }

    pub(crate) fn is_storage_faulted_after_effect(&self) -> bool {
        self.storage_faulted_after_effect
    }

    pub(crate) fn advance_control_epoch(
        &mut self,
        run_id: RunId,
        input_id: InputId,
        reason: Option<String>,
    ) -> AuthorityResult<ControlAdvance> {
        self.ensure_mutations_allowed()?;
        run_id
            .validate_as("runId")
            .map_err(|error| invalid_request("runId", error))?;
        input_id
            .validate_as("inputId")
            .map_err(|error| invalid_request("inputId", error))?;
        validate_optional_text("reason", reason.as_deref())?;

        let previous_epoch = self.current_epochs.get(&run_id).copied();
        let next_epoch_value = previous_epoch
            .map(ControlEpoch::get)
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| AuthorityError::InvalidRequest {
                field: "controlEpoch",
                reason: "overflow".to_string(),
            })?;
        let control_epoch = ControlEpoch::new(next_epoch_value)
            .map_err(|error| invalid_request("controlEpoch", error))?;

        let superseded = self
            .grants
            .values()
            .filter(|grant| {
                grant.run_id == run_id
                    && grant.lifecycle == GrantLifecycle::Issued
                    && grant.control_epoch != control_epoch
            })
            .cloned()
            .collect::<Vec<_>>();
        let unstarted_invocations = self
            .invocations
            .values()
            .filter(|invocation| {
                invocation.run_id == run_id
                    && matches!(
                        invocation.lifecycle,
                        InvocationLifecycle::Admitted | InvocationLifecycle::AttemptPrepared
                    )
            })
            .cloned()
            .collect::<Vec<_>>();

        let epoch_fact_id = self.next_fact_id();
        let mut drafts = vec![KernelFactDraftV2::new(
            epoch_fact_id.clone(),
            occurred_at(),
            causal_identity(IdentityParts {
                run_id: run_id.clone(),
                control_epoch,
                operation_id: None,
                grant_id: None,
                reservation_id: None,
                invocation_id: None,
                attempt_id: None,
                causation_id: None,
                idempotency_key_hash: None,
            }),
            KernelFactPayloadV2::Control(ControlFactV2 {
                kind: ControlFactKindV2::EpochAdvanced,
                input_id: Some(input_id),
                cancel_request_id: None,
                previous_epoch,
                target_invocation_id: None,
                reason: reason.clone(),
            }),
        )];

        let authority_fact_id = if previous_epoch.is_some() {
            let authority_fact_id = self.next_fact_id();
            drafts.push(KernelFactDraftV2::new(
                authority_fact_id.clone(),
                occurred_at(),
                causal_identity(IdentityParts {
                    run_id: run_id.clone(),
                    control_epoch,
                    operation_id: None,
                    grant_id: None,
                    reservation_id: None,
                    invocation_id: None,
                    attempt_id: None,
                    causation_id: Some(epoch_fact_id.clone()),
                    idempotency_key_hash: None,
                }),
                KernelFactPayloadV2::Control(ControlFactV2 {
                    kind: ControlFactKindV2::AuthoritySuperseded,
                    input_id: None,
                    cancel_request_id: None,
                    previous_epoch,
                    target_invocation_id: None,
                    reason,
                }),
            ));
            Some(authority_fact_id)
        } else {
            None
        };

        let mut closed_invocations = Vec::with_capacity(unstarted_invocations.len());
        for invocation in &unstarted_invocations {
            let grant = self
                .grants
                .get(&invocation.grant_id)
                .cloned()
                .ok_or_else(|| recovery_error("active invocation references unknown grant"))?;
            let released = self.grant_draft(
                &grant,
                GrantFactKindV2::ReservationReleased,
                Some(invocation.operation_id.clone()),
                Some(invocation.invocation_id.clone()),
                Some(invocation.reservation_id.clone()),
                Some(invocation.last_fact_id.clone()),
                Some("control_epoch_superseded".to_string()),
            );
            let released_fact_id = released.fact_id.clone();
            drafts.push(released);
            let terminal_kind = if invocation.attempt_id.is_some() {
                InvocationFactKindV2::Failed
            } else {
                InvocationFactKindV2::FailedBeforeAttempt
            };
            let terminal = self.invocation_record_draft(
                invocation,
                terminal_kind,
                invocation.attempt_id.clone(),
                Some("ControlEpochSuperseded".to_string()),
                Some(false),
                Some(released_fact_id),
            );
            let terminal_fact_id = terminal.fact_id.clone();
            drafts.push(terminal);
            closed_invocations.push((invocation.invocation_id.clone(), terminal_fact_id));
        }

        for grant in &superseded {
            drafts.push(self.grant_draft(
                grant,
                GrantFactKindV2::Superseded,
                None,
                None,
                None,
                authority_fact_id.clone(),
                Some("control_epoch_advanced".to_string()),
            ));
        }

        self.persist("advance_control_epoch", drafts, false)?;
        self.current_epochs.insert(run_id, control_epoch);
        for grant in &superseded {
            if let Some(record) = self.grants.get_mut(&grant.grant_id) {
                record.lifecycle = GrantLifecycle::Superseded;
            }
        }
        for (invocation_id, terminal_fact_id) in closed_invocations {
            if let Some(invocation) = self.invocations.get_mut(&invocation_id) {
                invocation.lifecycle = InvocationLifecycle::Failed;
                invocation.last_fact_id = terminal_fact_id;
                if let Some(grant) = self.grants.get_mut(&invocation.grant_id) {
                    if let Some(reservation) =
                        grant.reservations.get_mut(&invocation.reservation_id)
                    {
                        reservation.lifecycle = GrantReservationLifecycle::Released;
                    }
                }
            }
        }

        Ok(ControlAdvance {
            previous_epoch,
            control_epoch,
            superseded_grant_ids: superseded.into_iter().map(|grant| grant.grant_id).collect(),
        })
    }

    pub(crate) fn issue_grant(
        &mut self,
        request: GrantIssueRequest,
    ) -> AuthorityResult<GrantSnapshot> {
        self.ensure_mutations_allowed()?;
        request
            .run_id
            .validate_as("runId")
            .map_err(|error| invalid_request("runId", error))?;
        request
            .operation_id
            .validate_as("operationId")
            .map_err(|error| invalid_request("operationId", error))?;
        request
            .control_epoch
            .validate()
            .map_err(|error| invalid_request("controlEpoch", error))?;
        self.validate_current_epoch(&request.run_id, request.control_epoch)?;
        validate_scope(&request.scope)?;
        require_non_empty("requestDigest", &request.request_digest)?;
        validate_optional_text("reason", request.reason.as_deref())?;

        let operation_key = (request.run_id.clone(), request.operation_id.clone());
        if let Some(existing) = self.grant_operations.get(&operation_key) {
            if existing.request_digest != request.request_digest {
                return Err(AuthorityError::DuplicateOperationDigestMismatch {
                    run_id: request.run_id,
                    operation_id: request.operation_id,
                });
            }
            return self
                .grant_snapshot(&existing.grant_id)
                .ok_or_else(|| recovery_error("grant operation index references unknown grant"));
        }
        if self
            .operations
            .get(&operation_key)
            .is_some_and(|existing| existing.request_digest != request.request_digest)
        {
            return Err(AuthorityError::DuplicateOperationDigestMismatch {
                run_id: request.run_id,
                operation_id: request.operation_id,
            });
        }

        let grant_id = GrantId::new(self.next_kernel_id("grant"));
        let grant = GrantRecord {
            grant_id: grant_id.clone(),
            run_id: request.run_id,
            control_epoch: request.control_epoch,
            scope: request.scope,
            request_digest: request.request_digest,
            lifecycle: GrantLifecycle::Issued,
            observed_use_count: 0,
            reservations: HashMap::new(),
        };
        let draft = self.grant_draft(
            &grant,
            GrantFactKindV2::Issued,
            Some(request.operation_id),
            None,
            None,
            None,
            request.reason,
        );
        self.persist("issue_grant", vec![draft], false)?;
        self.grants.insert(grant_id.clone(), grant.clone());
        self.grant_operations.insert(
            operation_key,
            GrantOperationRecord {
                request_digest: grant.request_digest.clone(),
                grant_id,
            },
        );
        Ok(grant_snapshot(&grant))
    }

    pub(crate) fn revoke_grant(
        &mut self,
        run_id: &RunId,
        grant_id: &GrantId,
        reason: Option<String>,
    ) -> AuthorityResult<GrantSnapshot> {
        self.ensure_mutations_allowed()?;
        run_id
            .validate_as("runId")
            .map_err(|error| invalid_request("runId", error))?;
        grant_id
            .validate_as("grantId")
            .map_err(|error| invalid_request("grantId", error))?;
        validate_optional_text("reason", reason.as_deref())?;
        let grant =
            self.grants
                .get(grant_id)
                .cloned()
                .ok_or_else(|| AuthorityError::GrantRequired {
                    grant_id: grant_id.clone(),
                })?;
        if &grant.run_id != run_id {
            return Err(AuthorityError::GrantScopeMismatch {
                grant_id: grant_id.clone(),
            });
        }
        if grant.lifecycle != GrantLifecycle::Issued {
            return Ok(grant_snapshot(&grant));
        }

        let unstarted_invocations = self
            .invocations
            .values()
            .filter(|invocation| {
                invocation.grant_id == grant.grant_id
                    && matches!(
                        invocation.lifecycle,
                        InvocationLifecycle::Admitted | InvocationLifecycle::AttemptPrepared
                    )
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut drafts = Vec::with_capacity(unstarted_invocations.len() * 2 + 1);
        let mut closed_invocations = Vec::with_capacity(unstarted_invocations.len());
        for invocation in &unstarted_invocations {
            let released = self.grant_draft(
                &grant,
                GrantFactKindV2::ReservationReleased,
                Some(invocation.operation_id.clone()),
                Some(invocation.invocation_id.clone()),
                Some(invocation.reservation_id.clone()),
                Some(invocation.last_fact_id.clone()),
                Some("grant_revoked".to_string()),
            );
            let released_fact_id = released.fact_id.clone();
            drafts.push(released);
            let terminal_kind = if invocation.attempt_id.is_some() {
                InvocationFactKindV2::Failed
            } else {
                InvocationFactKindV2::FailedBeforeAttempt
            };
            let terminal = self.invocation_record_draft(
                invocation,
                terminal_kind,
                invocation.attempt_id.clone(),
                Some("GrantRevoked".to_string()),
                Some(false),
                Some(released_fact_id),
            );
            let terminal_fact_id = terminal.fact_id.clone();
            drafts.push(terminal);
            closed_invocations.push((invocation.invocation_id.clone(), terminal_fact_id));
        }
        let revoked = self.grant_draft(
            &grant,
            GrantFactKindV2::Revoked,
            None,
            None,
            None,
            None,
            reason,
        );
        drafts.push(revoked);
        self.persist("revoke_grant", drafts, false)?;
        let record = self
            .grants
            .get_mut(grant_id)
            .expect("grant existence checked before persistence");
        record.lifecycle = GrantLifecycle::Revoked;
        for (invocation_id, terminal_fact_id) in closed_invocations {
            if let Some(invocation) = self.invocations.get_mut(&invocation_id) {
                invocation.lifecycle = InvocationLifecycle::Failed;
                invocation.last_fact_id = terminal_fact_id;
                if let Some(reservation) = record.reservations.get_mut(&invocation.reservation_id) {
                    reservation.lifecycle = GrantReservationLifecycle::Released;
                }
            }
        }
        Ok(grant_snapshot(record))
    }

    pub(crate) fn submit_invocation(
        &mut self,
        request: InvocationSubmitRequest,
    ) -> AuthorityResult<InvocationAdmission> {
        self.ensure_mutations_allowed()?;
        request
            .run_id
            .validate_as("runId")
            .map_err(|error| invalid_request("runId", error))?;
        request
            .operation_id
            .validate_as("operationId")
            .map_err(|error| invalid_request("operationId", error))?;
        request
            .grant_id
            .validate_as("grantId")
            .map_err(|error| invalid_request("grantId", error))?;
        request
            .control_epoch
            .validate()
            .map_err(|error| invalid_request("controlEpoch", error))?;
        validate_scope(&request.scope)?;
        require_non_empty("requestDigest", &request.request_digest)?;
        require_non_empty("idempotencyKeyHash", &request.idempotency_key_hash)?;

        self.validate_current_epoch(&request.run_id, request.control_epoch)?;
        let operation_key = (request.run_id.clone(), request.operation_id.clone());
        if let Some(existing) = self.operations.get(&operation_key) {
            if existing.request_digest != request.request_digest {
                return Err(AuthorityError::DuplicateOperationDigestMismatch {
                    run_id: request.run_id,
                    operation_id: request.operation_id,
                });
            }
            let mut admission = existing.admission.clone();
            admission.replayed = true;
            return Ok(admission);
        }
        if self
            .grant_operations
            .get(&operation_key)
            .is_some_and(|existing| existing.request_digest != request.request_digest)
        {
            return Err(AuthorityError::DuplicateOperationDigestMismatch {
                run_id: request.run_id,
                operation_id: request.operation_id,
            });
        }

        let invocation_id = InvocationId::new(self.next_kernel_id("invocation"));
        let submitted_fact_id = self.next_fact_id();
        let submitted = self.invocation_draft(
            &request,
            invocation_id.clone(),
            None,
            None,
            InvocationFactKindV2::Submitted,
            None,
            None,
            None,
            None,
            submitted_fact_id.clone(),
        );

        let grant = match self.grants.get(&request.grant_id).cloned() {
            Some(grant)
                if grant.run_id == request.run_id
                    && grant.control_epoch == request.control_epoch
                    && grant.lifecycle == GrantLifecycle::Issued =>
            {
                grant
            }
            _ => {
                return self.reject_invocation(
                    &request,
                    invocation_id,
                    submitted,
                    submitted_fact_id,
                    KernelErrorCodeV2::GrantRequired,
                    false,
                );
            }
        };
        if grant.scope != request.scope {
            return self.reject_invocation(
                &request,
                invocation_id,
                submitted,
                submitted_fact_id,
                KernelErrorCodeV2::GrantScopeMismatch,
                false,
            );
        }

        let reservation_id = GrantReservationId::new(self.next_kernel_id("reservation"));
        let reserved = self.grant_draft(
            &grant,
            GrantFactKindV2::Reserved,
            Some(request.operation_id.clone()),
            Some(invocation_id.clone()),
            Some(reservation_id.clone()),
            Some(submitted_fact_id),
            None,
        );
        let reserved_fact_id = reserved.fact_id.clone();
        let admitted_fact_id = self.next_fact_id();
        let admitted = self.invocation_draft(
            &request,
            invocation_id.clone(),
            Some(grant.grant_id.clone()),
            Some(reservation_id.clone()),
            InvocationFactKindV2::Admitted,
            None,
            None,
            None,
            Some(reserved_fact_id),
            admitted_fact_id.clone(),
        );
        self.persist(
            "submit_invocation",
            vec![submitted, reserved, admitted],
            false,
        )?;

        let reservation = GrantReservation {
            reservation_id: reservation_id.clone(),
            invocation_id: invocation_id.clone(),
            operation_id: request.operation_id.clone(),
            control_epoch: request.control_epoch,
            lifecycle: GrantReservationLifecycle::Reserved,
        };
        self.grants
            .get_mut(&grant.grant_id)
            .expect("grant existence checked before persistence")
            .reservations
            .insert(reservation_id.clone(), reservation);

        let record = InvocationRecord {
            invocation_id: invocation_id.clone(),
            run_id: request.run_id.clone(),
            operation_id: request.operation_id.clone(),
            control_epoch: request.control_epoch,
            grant_id: grant.grant_id,
            reservation_id,
            scope: request.scope,
            request_digest: request.request_digest.clone(),
            idempotency_key_hash: request.idempotency_key_hash,
            attempt_id: None,
            lifecycle: InvocationLifecycle::Admitted,
            last_fact_id: admitted_fact_id,
            effect_outcome: None,
        };
        self.invocations.insert(invocation_id.clone(), record);
        let admission = InvocationAdmission {
            invocation_id,
            admitted: true,
            rejection_code: None,
            retryable: false,
            replayed: false,
        };
        self.operations.insert(
            operation_key,
            OperationRecord {
                request_digest: request.request_digest,
                admission: admission.clone(),
            },
        );
        Ok(admission)
    }

    pub(crate) fn prepare_attempt(
        &mut self,
        invocation_id: &InvocationId,
    ) -> AuthorityResult<AttemptId> {
        self.ensure_mutations_allowed()?;
        let invocation = self.invocation(invocation_id)?.clone();
        require_state(&invocation, InvocationLifecycle::Admitted, "admitted")?;
        self.validate_current_epoch(&invocation.run_id, invocation.control_epoch)?;
        let grant =
            self.grants
                .get(&invocation.grant_id)
                .ok_or_else(|| AuthorityError::GrantRequired {
                    grant_id: invocation.grant_id.clone(),
                })?;
        if grant.lifecycle != GrantLifecycle::Issued {
            return Err(AuthorityError::GrantRequired {
                grant_id: invocation.grant_id,
            });
        }
        let reservation = grant
            .reservations
            .get(&invocation.reservation_id)
            .ok_or_else(|| AuthorityError::GrantRequired {
                grant_id: invocation.grant_id.clone(),
            })?;
        if grant.run_id != invocation.run_id
            || grant.control_epoch != invocation.control_epoch
            || grant.scope != invocation.scope
            || reservation.lifecycle != GrantReservationLifecycle::Reserved
            || reservation.invocation_id != invocation.invocation_id
            || reservation.operation_id != invocation.operation_id
        {
            return Err(AuthorityError::GrantScopeMismatch {
                grant_id: invocation.grant_id,
            });
        }
        let attempt_id = AttemptId::new(self.next_kernel_id("attempt"));
        let draft = self.invocation_record_draft(
            &invocation,
            InvocationFactKindV2::AttemptPrepared,
            Some(attempt_id.clone()),
            None,
            None,
            Some(invocation.last_fact_id.clone()),
        );
        let prepared_fact_id = draft.fact_id.clone();
        self.persist("prepare_attempt", vec![draft], false)?;
        let record = self
            .invocations
            .get_mut(invocation_id)
            .expect("invocation existence checked before persistence");
        record.attempt_id = Some(attempt_id.clone());
        record.lifecycle = InvocationLifecycle::AttemptPrepared;
        record.last_fact_id = prepared_fact_id;
        Ok(attempt_id)
    }

    /// Commits the durable effect boundary. The caller must not invoke the
    /// executor until this method succeeds.
    pub(crate) fn begin_effect(&mut self, invocation_id: &InvocationId) -> AuthorityResult<()> {
        self.ensure_mutations_allowed()?;
        let invocation = self.invocation(invocation_id)?.clone();
        require_state(
            &invocation,
            InvocationLifecycle::AttemptPrepared,
            "attemptPrepared",
        )?;
        self.validate_current_epoch(&invocation.run_id, invocation.control_epoch)?;
        let attempt_id = invocation
            .attempt_id
            .clone()
            .expect("attempt-prepared invocation owns an attempt id");
        let grant = self
            .grants
            .get(&invocation.grant_id)
            .cloned()
            .ok_or_else(|| AuthorityError::GrantRequired {
                grant_id: invocation.grant_id.clone(),
            })?;
        if grant.lifecycle != GrantLifecycle::Issued {
            return Err(AuthorityError::GrantRequired {
                grant_id: grant.grant_id,
            });
        }
        if grant.run_id != invocation.run_id
            || grant.control_epoch != invocation.control_epoch
            || grant.scope != invocation.scope
        {
            return Err(AuthorityError::GrantScopeMismatch {
                grant_id: grant.grant_id,
            });
        }
        let reservation = grant
            .reservations
            .get(&invocation.reservation_id)
            .ok_or_else(|| AuthorityError::GrantRequired {
                grant_id: grant.grant_id.clone(),
            })?;
        if reservation.lifecycle != GrantReservationLifecycle::Reserved
            || reservation.invocation_id != invocation.invocation_id
            || reservation.operation_id != invocation.operation_id
            || reservation.control_epoch != invocation.control_epoch
        {
            return Err(AuthorityError::GrantScopeMismatch {
                grant_id: grant.grant_id,
            });
        }

        let consumed_fact_id = self.next_fact_id();
        let consumed = self.grant_draft_with_use_count(
            &grant,
            GrantFactKindV2::Consumed,
            Some(invocation.operation_id.clone()),
            Some(invocation.invocation_id.clone()),
            Some(invocation.reservation_id.clone()),
            Some(attempt_id.clone()),
            Some(invocation.last_fact_id.clone()),
            None,
            grant.observed_use_count.checked_add(1).ok_or_else(|| {
                AuthorityError::InvalidRequest {
                    field: "observedUseCount",
                    reason: "overflow".to_string(),
                }
            })?,
            consumed_fact_id.clone(),
        );
        let started = self.invocation_record_draft(
            &invocation,
            InvocationFactKindV2::ExecutionStarted,
            Some(attempt_id),
            None,
            None,
            Some(consumed_fact_id),
        );
        let started_fact_id = started.fact_id.clone();
        self.persist("begin_effect", vec![consumed, started], false)?;

        let grant = self
            .grants
            .get_mut(&invocation.grant_id)
            .expect("grant existence checked before persistence");
        grant.observed_use_count += 1;
        grant
            .reservations
            .get_mut(&invocation.reservation_id)
            .expect("reservation existence checked before persistence")
            .lifecycle = GrantReservationLifecycle::Consumed;
        let invocation = self
            .invocations
            .get_mut(invocation_id)
            .expect("invocation existence checked before persistence");
        invocation.lifecycle = InvocationLifecycle::EffectStarted;
        invocation.last_fact_id = started_fact_id;
        Ok(())
    }

    pub(crate) fn finalize_pre_effect_failure(
        &mut self,
        invocation_id: &InvocationId,
        error_code: impl Into<String>,
    ) -> AuthorityResult<()> {
        self.ensure_mutations_allowed()?;
        let invocation = self.invocation(invocation_id)?.clone();
        if !matches!(
            invocation.lifecycle,
            InvocationLifecycle::Admitted | InvocationLifecycle::AttemptPrepared
        ) {
            return Err(AuthorityError::InvalidInvocationState {
                invocation_id: invocation.invocation_id,
                expected: "admitted or attemptPrepared",
                actual: invocation.lifecycle,
            });
        }
        let error_code = error_code.into();
        require_non_empty("errorCode", &error_code)?;
        let grant = self
            .grants
            .get(&invocation.grant_id)
            .cloned()
            .ok_or_else(|| AuthorityError::GrantRequired {
                grant_id: invocation.grant_id.clone(),
            })?;

        let released = self.grant_draft(
            &grant,
            GrantFactKindV2::ReservationReleased,
            Some(invocation.operation_id.clone()),
            Some(invocation.invocation_id.clone()),
            Some(invocation.reservation_id.clone()),
            Some(invocation.last_fact_id.clone()),
            Some(error_code.clone()),
        );
        let release_fact_id = released.fact_id.clone();
        let terminal_kind = if invocation.attempt_id.is_some() {
            InvocationFactKindV2::Failed
        } else {
            InvocationFactKindV2::FailedBeforeAttempt
        };
        let terminal = self.invocation_record_draft(
            &invocation,
            terminal_kind,
            invocation.attempt_id.clone(),
            Some(error_code),
            Some(false),
            Some(release_fact_id),
        );
        let terminal_fact_id = terminal.fact_id.clone();
        self.persist(
            "finalize_pre_effect_failure",
            vec![released, terminal],
            false,
        )?;

        if let Some(grant) = self.grants.get_mut(&invocation.grant_id) {
            if let Some(reservation) = grant.reservations.get_mut(&invocation.reservation_id) {
                reservation.lifecycle = GrantReservationLifecycle::Released;
            }
        }
        let record = self
            .invocations
            .get_mut(invocation_id)
            .expect("invocation existence checked before persistence");
        record.lifecycle = InvocationLifecycle::Failed;
        record.last_fact_id = terminal_fact_id;
        Ok(())
    }

    pub(crate) fn finalize_effect(
        &mut self,
        invocation_id: &InvocationId,
        completion: EffectCompletion,
    ) -> AuthorityResult<()> {
        self.ensure_mutations_allowed()?;
        let invocation = self.invocation(invocation_id)?.clone();
        require_state(
            &invocation,
            InvocationLifecycle::EffectStarted,
            "effectStarted",
        )?;
        if let Some(error_code) = completion.error_code.as_deref() {
            require_non_empty("errorCode", error_code)?;
        }
        let attempt_id = invocation
            .attempt_id
            .clone()
            .expect("effect-started invocation owns an attempt id");
        let effect_fact_id = self.next_fact_id();
        let effect = KernelFactDraftV2::new(
            effect_fact_id.clone(),
            occurred_at(),
            causal_identity(IdentityParts {
                run_id: invocation.run_id.clone(),
                control_epoch: invocation.control_epoch,
                operation_id: Some(invocation.operation_id.clone()),
                grant_id: Some(invocation.grant_id.clone()),
                reservation_id: Some(invocation.reservation_id.clone()),
                invocation_id: Some(invocation.invocation_id.clone()),
                attempt_id: Some(attempt_id.clone()),
                causation_id: Some(invocation.last_fact_id.clone()),
                idempotency_key_hash: Some(invocation.idempotency_key_hash.clone()),
            }),
            KernelFactPayloadV2::Effect(EffectFactV2 {
                effect_id: EffectId::new(self.next_kernel_id("effect")),
                invocation_id: invocation.invocation_id.clone(),
                attempt_id: attempt_id.clone(),
                outcome: EffectOutcomeV2::Observed,
                affected_resources: completion.affected_resource_ids,
                receipt: Some(completion.receipt),
            }),
        );
        let (fact_kind, lifecycle, error_code) = match completion.terminal_outcome {
            TerminalInvocationOutcome::Completed => (
                InvocationFactKindV2::Completed,
                InvocationLifecycle::Completed,
                None,
            ),
            TerminalInvocationOutcome::Failed => (
                InvocationFactKindV2::Failed,
                InvocationLifecycle::Failed,
                Some(
                    completion
                        .error_code
                        .unwrap_or_else(|| "ExecutorFailedAfterEffect".to_string()),
                ),
            ),
        };
        let terminal = self.invocation_record_draft(
            &invocation,
            fact_kind,
            Some(attempt_id),
            error_code,
            Some(false),
            Some(effect_fact_id),
        );
        let terminal_fact_id = terminal.fact_id.clone();
        self.persist("finalize_effect", vec![effect, terminal], true)?;
        let record = self
            .invocations
            .get_mut(invocation_id)
            .expect("invocation existence checked before persistence");
        record.lifecycle = lifecycle;
        record.last_fact_id = terminal_fact_id;
        record.effect_outcome = Some(EffectOutcomeV2::Observed);
        Ok(())
    }

    pub(crate) fn finalize_indeterminate(
        &mut self,
        invocation_id: &InvocationId,
        receipt: serde_json::Value,
    ) -> AuthorityResult<()> {
        self.ensure_mutations_allowed()?;
        let invocation = self.invocation(invocation_id)?.clone();
        require_state(
            &invocation,
            InvocationLifecycle::EffectStarted,
            "effectStarted",
        )?;
        let attempt_id = invocation
            .attempt_id
            .clone()
            .expect("effect-started invocation owns an attempt id");
        let effect_fact_id = self.next_fact_id();
        let effect = KernelFactDraftV2::new(
            effect_fact_id.clone(),
            occurred_at(),
            causal_identity(IdentityParts {
                run_id: invocation.run_id.clone(),
                control_epoch: invocation.control_epoch,
                operation_id: Some(invocation.operation_id.clone()),
                grant_id: Some(invocation.grant_id.clone()),
                reservation_id: Some(invocation.reservation_id.clone()),
                invocation_id: Some(invocation.invocation_id.clone()),
                attempt_id: Some(attempt_id.clone()),
                causation_id: Some(invocation.last_fact_id.clone()),
                idempotency_key_hash: Some(invocation.idempotency_key_hash.clone()),
            }),
            KernelFactPayloadV2::Effect(EffectFactV2 {
                effect_id: EffectId::new(self.next_kernel_id("effect")),
                invocation_id: invocation.invocation_id.clone(),
                attempt_id: attempt_id.clone(),
                outcome: EffectOutcomeV2::Indeterminate,
                affected_resources: Vec::new(),
                receipt: Some(receipt),
            }),
        );
        let terminal = self.invocation_record_draft(
            &invocation,
            InvocationFactKindV2::Indeterminate,
            Some(attempt_id),
            Some("EffectIndeterminate".to_string()),
            Some(false),
            Some(effect_fact_id),
        );
        let terminal_fact_id = terminal.fact_id.clone();
        self.persist("finalize_indeterminate", vec![effect, terminal], true)?;
        let record = self
            .invocations
            .get_mut(invocation_id)
            .expect("invocation existence checked before persistence");
        record.lifecycle = InvocationLifecycle::Indeterminate;
        record.last_fact_id = terminal_fact_id;
        record.effect_outcome = Some(EffectOutcomeV2::Indeterminate);
        Ok(())
    }

    pub(crate) fn grant_snapshot(&self, grant_id: &GrantId) -> Option<GrantSnapshot> {
        self.grants.get(grant_id).map(grant_snapshot)
    }

    pub(crate) fn invocation_snapshot(
        &self,
        invocation_id: &InvocationId,
    ) -> Option<InvocationSnapshot> {
        self.invocations.get(invocation_id).map(invocation_snapshot)
    }

    fn replay(&mut self, facts: Vec<KernelFactEnvelopeV2>) -> AuthorityResult<()> {
        let mut seen_fact_ids = HashSet::with_capacity(facts.len());
        let mut pending = ReplayPending::default();
        for fact in facts {
            if matches!(
                &fact.payload,
                KernelFactPayloadV2::Grant(_)
                    | KernelFactPayloadV2::Invocation(_)
                    | KernelFactPayloadV2::Effect(_)
            ) {
                if let Some(causation_id) = fact.identity.causation_id.as_ref() {
                    if !seen_fact_ids.contains(causation_id) {
                        return Err(recovery_error(format!(
                            "runtime authority fact {} references non-prior cause {}",
                            fact.fact_id, causation_id
                        )));
                    }
                }
            }
            match &fact.payload {
                KernelFactPayloadV2::Control(control) => {
                    if control.kind == ControlFactKindV2::EpochAdvanced {
                        let current = self.current_epochs.get(&fact.identity.run_id).copied();
                        match current {
                            None => {
                                if control.previous_epoch.is_some()
                                    || fact.identity.control_epoch.get() != 1
                                {
                                    return Err(recovery_error(format!(
                                        "run {} must start at control epoch 1 without a previous epoch",
                                        fact.identity.run_id
                                    )));
                                }
                            }
                            Some(current) => {
                                let expected = current.get().checked_add(1).ok_or_else(|| {
                                    recovery_error(format!(
                                        "run {} control epoch overflowed during replay",
                                        fact.identity.run_id
                                    ))
                                })?;
                                if control.previous_epoch != Some(current)
                                    || fact.identity.control_epoch.get() != expected
                                {
                                    return Err(recovery_error(format!(
                                        "run {} control epoch {:?} does not exactly follow {:?}",
                                        fact.identity.run_id, fact.identity.control_epoch, current
                                    )));
                                }
                            }
                        }
                        self.current_epochs
                            .insert(fact.identity.run_id.clone(), fact.identity.control_epoch);
                    }
                }
                KernelFactPayloadV2::Grant(grant) => {
                    self.replay_grant(&fact, grant, &mut pending)?;
                }
                KernelFactPayloadV2::Invocation(invocation) => {
                    self.replay_invocation(&fact, invocation, &mut pending)?;
                }
                KernelFactPayloadV2::Effect(effect) => {
                    self.replay_effect(&fact, effect)?;
                }
                KernelFactPayloadV2::Resource(_) | KernelFactPayloadV2::Cleanup(_) => {}
            }
            if !seen_fact_ids.insert(fact.fact_id.clone()) {
                return Err(recovery_error(format!(
                    "canonical snapshot repeats fact id {}",
                    fact.fact_id
                )));
            }
        }

        if !pending.submissions.is_empty() || !pending.reservations.is_empty() {
            return Err(recovery_error(
                "canonical snapshot ends with an incomplete invocation admission chain",
            ));
        }
        for grant in self.grants.values() {
            let current_epoch = self.current_epochs.get(&grant.run_id).copied();
            if current_epoch.is_none() {
                return Err(recovery_error(format!(
                    "grant {} has no preceding control epoch",
                    grant.grant_id
                )));
            }
        }
        Ok(())
    }

    fn replay_grant(
        &mut self,
        envelope: &KernelFactEnvelopeV2,
        fact: &GrantFactV2,
        pending: &mut ReplayPending,
    ) -> AuthorityResult<()> {
        if fact.kind == GrantFactKindV2::Requested {
            return Ok(());
        }
        let scope = CapabilityScope::new(
            fact.tool_id.clone(),
            fact.resource_scope.clone(),
            fact.effect_scope.clone(),
        )?;
        if !self.grants.contains_key(&fact.grant_id) {
            if fact.kind != GrantFactKindV2::Issued || fact.observed_use_count != 0 {
                return Err(recovery_error(format!(
                    "grant {} must begin with an issued fact at observedUseCount 0",
                    fact.grant_id
                )));
            }
            let operation_id = envelope
                .identity
                .operation_id
                .clone()
                .ok_or_else(|| recovery_error("issued grant has no operation id"))?;
            let operation_key = (envelope.identity.run_id.clone(), operation_id.clone());
            match self.grant_operations.get(&operation_key) {
                Some(existing)
                    if existing.request_digest == fact.request_digest
                        && existing.grant_id == fact.grant_id => {}
                Some(_) => {
                    return Err(recovery_error(format!(
                        "grant operation {operation_id} has conflicting issuance facts"
                    )));
                }
                None => {
                    self.grant_operations.insert(
                        operation_key.clone(),
                        GrantOperationRecord {
                            request_digest: fact.request_digest.clone(),
                            grant_id: fact.grant_id.clone(),
                        },
                    );
                }
            }
            if self
                .operations
                .get(&operation_key)
                .is_some_and(|existing| existing.request_digest != fact.request_digest)
            {
                return Err(recovery_error(format!(
                    "operation {operation_id} has different grant and invocation digests"
                )));
            }
            self.grants.insert(
                fact.grant_id.clone(),
                GrantRecord {
                    grant_id: fact.grant_id.clone(),
                    run_id: envelope.identity.run_id.clone(),
                    control_epoch: envelope.identity.control_epoch,
                    scope,
                    request_digest: fact.request_digest.clone(),
                    lifecycle: GrantLifecycle::Issued,
                    observed_use_count: 0,
                    reservations: HashMap::new(),
                },
            );
            return Ok(());
        }

        let grant = self
            .grants
            .get_mut(&fact.grant_id)
            .expect("grant existence checked above");
        if grant.run_id != envelope.identity.run_id
            || grant.control_epoch != envelope.identity.control_epoch
            || grant.scope != scope
            || grant.request_digest != fact.request_digest
        {
            return Err(recovery_error(format!(
                "grant {} changed its run, epoch, or exact scope",
                fact.grant_id
            )));
        }
        if grant.lifecycle != GrantLifecycle::Issued {
            return Err(recovery_error(format!(
                "terminal grant {} received later {:?} fact",
                fact.grant_id, fact.kind
            )));
        }

        let mut advance_invocation_cursor = None;
        match fact.kind {
            GrantFactKindV2::Issued => {
                return Err(recovery_error(format!(
                    "grant {} was issued more than once",
                    fact.grant_id
                )));
            }
            GrantFactKindV2::Revoked | GrantFactKindV2::Expired | GrantFactKindV2::Superseded => {
                if fact.observed_use_count != grant.observed_use_count {
                    return Err(recovery_error(format!(
                        "terminal grant {} changed observedUseCount from {} to {}",
                        fact.grant_id, grant.observed_use_count, fact.observed_use_count
                    )));
                }
                grant.lifecycle = match fact.kind {
                    GrantFactKindV2::Revoked => GrantLifecycle::Revoked,
                    GrantFactKindV2::Expired => GrantLifecycle::Expired,
                    GrantFactKindV2::Superseded => GrantLifecycle::Superseded,
                    _ => unreachable!("terminal grant kinds matched above"),
                };
            }
            GrantFactKindV2::Reserved
            | GrantFactKindV2::Consumed
            | GrantFactKindV2::ReservationReleased => {
                let reservation_id =
                    envelope
                        .identity
                        .grant_reservation_id
                        .clone()
                        .ok_or_else(|| {
                            recovery_error("grant reservation fact has no reservation id")
                        })?;
                let invocation_id =
                    envelope.identity.invocation_id.clone().ok_or_else(|| {
                        recovery_error("grant reservation fact has no invocation id")
                    })?;
                let operation_id =
                    envelope.identity.operation_id.clone().ok_or_else(|| {
                        recovery_error("grant reservation fact has no operation id")
                    })?;
                match fact.kind {
                    GrantFactKindV2::Reserved => {
                        let submission =
                            pending.submissions.get(&invocation_id).ok_or_else(|| {
                                recovery_error(format!(
                                    "reservation {reservation_id} has no exact submitted invocation"
                                ))
                            })?;
                        if submission.run_id != envelope.identity.run_id
                            || submission.operation_id != operation_id
                            || submission.control_epoch != envelope.identity.control_epoch
                            || submission.tool_id != fact.tool_id
                            || envelope.identity.causation_id.as_ref() != Some(&submission.fact_id)
                        {
                            return Err(recovery_error(format!(
                                "reservation {reservation_id} does not exactly follow invocation submission {invocation_id}"
                            )));
                        }
                        if fact.observed_use_count != grant.observed_use_count {
                            return Err(recovery_error(format!(
                                "reservation {reservation_id} changed observedUseCount"
                            )));
                        }
                        if grant.reservations.contains_key(&reservation_id) {
                            return Err(recovery_error(format!(
                                "reservation {reservation_id} was reserved more than once"
                            )));
                        }
                        if pending.reservations.contains_key(&invocation_id) {
                            return Err(recovery_error(format!(
                                "invocation {invocation_id} owns more than one pending reservation"
                            )));
                        }
                        pending.reservations.insert(
                            invocation_id.clone(),
                            ReplayReservation {
                                fact_id: envelope.fact_id.clone(),
                                run_id: envelope.identity.run_id.clone(),
                                operation_id: operation_id.clone(),
                                control_epoch: envelope.identity.control_epoch,
                                grant_id: fact.grant_id.clone(),
                                reservation_id: reservation_id.clone(),
                            },
                        );
                        grant.reservations.insert(
                            reservation_id.clone(),
                            GrantReservation {
                                reservation_id,
                                invocation_id,
                                operation_id,
                                control_epoch: envelope.identity.control_epoch,
                                lifecycle: GrantReservationLifecycle::Reserved,
                            },
                        );
                    }
                    GrantFactKindV2::Consumed | GrantFactKindV2::ReservationReleased => {
                        let reservation =
                            grant.reservations.get_mut(&reservation_id).ok_or_else(|| {
                                recovery_error(format!(
                                    "reservation {reservation_id} terminal fact precedes reservation"
                                ))
                            })?;
                        if reservation.invocation_id != invocation_id
                            || reservation.operation_id != operation_id
                            || reservation.control_epoch != envelope.identity.control_epoch
                        {
                            return Err(recovery_error(format!(
                                "reservation {reservation_id} changed its causal binding"
                            )));
                        }
                        if reservation.lifecycle != GrantReservationLifecycle::Reserved {
                            return Err(recovery_error(format!(
                                "reservation {reservation_id} cannot transition from {:?} via {:?}",
                                reservation.lifecycle, fact.kind
                            )));
                        }
                        match fact.kind {
                            GrantFactKindV2::Consumed => {
                                let expected =
                                    grant.observed_use_count.checked_add(1).ok_or_else(|| {
                                        recovery_error(format!(
                                            "grant {} observedUseCount overflowed",
                                            fact.grant_id
                                        ))
                                    })?;
                                if fact.observed_use_count != expected {
                                    return Err(recovery_error(format!(
                                        "grant {} consumed count {} does not exactly follow {}",
                                        fact.grant_id,
                                        fact.observed_use_count,
                                        grant.observed_use_count
                                    )));
                                }
                                reservation.lifecycle = GrantReservationLifecycle::Consumed;
                                advance_invocation_cursor = Some((
                                    invocation_id,
                                    operation_id,
                                    reservation_id,
                                    GrantFactKindV2::Consumed,
                                ));
                            }
                            GrantFactKindV2::ReservationReleased => {
                                if fact.observed_use_count != grant.observed_use_count {
                                    return Err(recovery_error(format!(
                                        "reservation {reservation_id} release changed observedUseCount"
                                    )));
                                }
                                reservation.lifecycle = GrantReservationLifecycle::Released;
                                advance_invocation_cursor = Some((
                                    invocation_id,
                                    operation_id,
                                    reservation_id,
                                    GrantFactKindV2::ReservationReleased,
                                ));
                            }
                            _ => unreachable!("reservation terminal kinds matched above"),
                        }
                    }
                    _ => unreachable!("reservation fact kinds matched above"),
                }
            }
            GrantFactKindV2::Requested => {}
        }
        grant.observed_use_count = fact.observed_use_count;
        if let Some((invocation_id, operation_id, reservation_id, kind)) = advance_invocation_cursor
        {
            let invocation = self.invocations.get_mut(&invocation_id).ok_or_else(|| {
                recovery_error(format!(
                    "grant {kind:?} fact references unknown invocation {invocation_id}"
                ))
            })?;
            let legal_state = match kind {
                GrantFactKindV2::Consumed => {
                    invocation.lifecycle == InvocationLifecycle::AttemptPrepared
                        && invocation.attempt_id == envelope.identity.attempt_id
                }
                GrantFactKindV2::ReservationReleased => {
                    matches!(
                        invocation.lifecycle,
                        InvocationLifecycle::Admitted | InvocationLifecycle::AttemptPrepared
                    ) && envelope
                        .identity
                        .attempt_id
                        .as_ref()
                        .is_none_or(|attempt_id| invocation.attempt_id.as_ref() == Some(attempt_id))
                }
                _ => false,
            };
            if !legal_state
                || invocation.run_id != envelope.identity.run_id
                || invocation.operation_id != operation_id
                || invocation.control_epoch != envelope.identity.control_epoch
                || invocation.grant_id != fact.grant_id
                || invocation.reservation_id != reservation_id
                || envelope.identity.causation_id.as_ref() != Some(&invocation.last_fact_id)
            {
                return Err(recovery_error(format!(
                    "grant {kind:?} fact illegally follows invocation {invocation_id}"
                )));
            }
            invocation.last_fact_id = envelope.fact_id.clone();
        }
        Ok(())
    }

    fn replay_invocation(
        &mut self,
        envelope: &KernelFactEnvelopeV2,
        fact: &InvocationFactV2,
        pending: &mut ReplayPending,
    ) -> AuthorityResult<()> {
        let operation_id = envelope
            .identity
            .operation_id
            .clone()
            .ok_or_else(|| recovery_error("invocation fact has no operation id"))?;
        match fact.kind {
            InvocationFactKindV2::Submitted => {
                if self.invocations.contains_key(&fact.invocation_id)
                    || pending.submissions.contains_key(&fact.invocation_id)
                    || pending.reservations.contains_key(&fact.invocation_id)
                {
                    return Err(recovery_error(format!(
                        "invocation {} was submitted more than once",
                        fact.invocation_id
                    )));
                }
                if envelope.identity.invocation_id.as_ref() != Some(&fact.invocation_id)
                    || envelope.identity.capability_grant_id.is_some()
                    || envelope.identity.grant_reservation_id.is_some()
                    || envelope.identity.attempt_id.is_some()
                    || envelope.identity.causation_id.is_some()
                    || envelope.identity.idempotency_key_hash.as_deref()
                        != Some(&fact.idempotency_key_hash)
                    || fact.attempt_id.is_some()
                {
                    return Err(recovery_error(format!(
                        "submitted invocation {} has invalid causal identity",
                        fact.invocation_id
                    )));
                }
                pending.submissions.insert(
                    fact.invocation_id.clone(),
                    ReplaySubmission {
                        fact_id: envelope.fact_id.clone(),
                        run_id: envelope.identity.run_id.clone(),
                        operation_id,
                        control_epoch: envelope.identity.control_epoch,
                        tool_id: fact.tool_id.clone(),
                        request_digest: fact.request_digest.clone(),
                        idempotency_key_hash: fact.idempotency_key_hash.clone(),
                    },
                );
                return Ok(());
            }
            InvocationFactKindV2::Rejected
                if !self.invocations.contains_key(&fact.invocation_id) =>
            {
                let submission =
                    pending
                        .submissions
                        .remove(&fact.invocation_id)
                        .ok_or_else(|| {
                            recovery_error(format!(
                                "rejected invocation {} has no exact submission",
                                fact.invocation_id
                            ))
                        })?;
                if pending.reservations.contains_key(&fact.invocation_id)
                    || submission.run_id != envelope.identity.run_id
                    || submission.operation_id != operation_id
                    || submission.control_epoch != envelope.identity.control_epoch
                    || submission.tool_id != fact.tool_id
                    || submission.request_digest != fact.request_digest
                    || submission.idempotency_key_hash != fact.idempotency_key_hash
                    || envelope.identity.invocation_id.as_ref() != Some(&fact.invocation_id)
                    || envelope.identity.capability_grant_id.is_some()
                    || envelope.identity.grant_reservation_id.is_some()
                    || envelope.identity.attempt_id.is_some()
                    || envelope.identity.idempotency_key_hash.as_deref()
                        != Some(&fact.idempotency_key_hash)
                    || envelope.identity.causation_id.as_ref() != Some(&submission.fact_id)
                {
                    return Err(recovery_error(format!(
                        "rejected invocation {} does not exactly follow its submission",
                        fact.invocation_id
                    )));
                }
                let operation_key = (envelope.identity.run_id.clone(), operation_id.clone());
                if self
                    .grant_operations
                    .get(&operation_key)
                    .is_some_and(|existing| existing.request_digest != fact.request_digest)
                {
                    return Err(recovery_error(format!(
                        "operation {operation_id} has different grant and invocation digests"
                    )));
                }
                if fact.retryable != Some(true) {
                    let rejection_code = fact
                        .error_code
                        .as_deref()
                        .and_then(parse_error_code)
                        .unwrap_or(KernelErrorCodeV2::InvalidRequest);
                    let admission = InvocationAdmission {
                        invocation_id: fact.invocation_id.clone(),
                        admitted: false,
                        rejection_code: Some(rejection_code),
                        retryable: false,
                        replayed: false,
                    };
                    match self.operations.get(&operation_key) {
                        Some(existing)
                            if existing.request_digest == fact.request_digest
                                && existing.admission == admission => {}
                        Some(_) => {
                            return Err(recovery_error(format!(
                                "rejected operation {operation_id} has conflicting facts"
                            )));
                        }
                        None => {
                            self.operations.insert(
                                operation_key,
                                OperationRecord {
                                    request_digest: fact.request_digest.clone(),
                                    admission,
                                },
                            );
                        }
                    }
                }
                return Ok(());
            }
            InvocationFactKindV2::Admitted => {
                if self.invocations.contains_key(&fact.invocation_id) {
                    return Err(recovery_error(format!(
                        "invocation {} was admitted more than once",
                        fact.invocation_id
                    )));
                }
                let grant_id = envelope
                    .identity
                    .capability_grant_id
                    .clone()
                    .ok_or_else(|| recovery_error("admitted invocation has no grant id"))?;
                let reservation_id = envelope
                    .identity
                    .grant_reservation_id
                    .clone()
                    .ok_or_else(|| recovery_error("admitted invocation has no reservation id"))?;
                let submission =
                    pending
                        .submissions
                        .remove(&fact.invocation_id)
                        .ok_or_else(|| {
                            recovery_error(format!(
                                "admitted invocation {} has no exact submission",
                                fact.invocation_id
                            ))
                        })?;
                let pending_reservation = pending
                    .reservations
                    .remove(&fact.invocation_id)
                    .ok_or_else(|| {
                        recovery_error(format!(
                            "admitted invocation {} has no exact reservation",
                            fact.invocation_id
                        ))
                    })?;
                if submission.run_id != envelope.identity.run_id
                    || submission.operation_id != operation_id
                    || submission.control_epoch != envelope.identity.control_epoch
                    || submission.tool_id != fact.tool_id
                    || submission.request_digest != fact.request_digest
                    || submission.idempotency_key_hash != fact.idempotency_key_hash
                    || pending_reservation.run_id != envelope.identity.run_id
                    || pending_reservation.operation_id != operation_id
                    || pending_reservation.control_epoch != envelope.identity.control_epoch
                    || pending_reservation.grant_id != grant_id
                    || pending_reservation.reservation_id != reservation_id
                    || envelope.identity.invocation_id.as_ref() != Some(&fact.invocation_id)
                    || envelope.identity.attempt_id.is_some()
                    || envelope.identity.idempotency_key_hash.as_deref()
                        != Some(&fact.idempotency_key_hash)
                    || envelope.identity.causation_id.as_ref() != Some(&pending_reservation.fact_id)
                {
                    return Err(recovery_error(format!(
                        "admitted invocation {} does not exactly follow its reservation",
                        fact.invocation_id
                    )));
                }
                let grant = self.grants.get(&grant_id).ok_or_else(|| {
                    recovery_error("admitted invocation references unknown grant")
                })?;
                let reservation = grant.reservations.get(&reservation_id).ok_or_else(|| {
                    recovery_error("admitted invocation references unknown reservation")
                })?;
                if reservation.invocation_id != fact.invocation_id
                    || reservation.operation_id != operation_id
                    || reservation.control_epoch != envelope.identity.control_epoch
                    || grant.run_id != envelope.identity.run_id
                    || grant.control_epoch != envelope.identity.control_epoch
                    || grant.lifecycle != GrantLifecycle::Issued
                    || fact.tool_id != grant.scope.tool_id
                    || self.current_epochs.get(&envelope.identity.run_id).copied()
                        != Some(envelope.identity.control_epoch)
                {
                    return Err(recovery_error(format!(
                        "invocation {} does not own reservation {}",
                        fact.invocation_id, reservation_id
                    )));
                }
                let admission = InvocationAdmission {
                    invocation_id: fact.invocation_id.clone(),
                    admitted: true,
                    rejection_code: None,
                    retryable: false,
                    replayed: false,
                };
                let operation_key = (envelope.identity.run_id.clone(), operation_id.clone());
                if self
                    .grant_operations
                    .get(&operation_key)
                    .is_some_and(|existing| existing.request_digest != fact.request_digest)
                {
                    return Err(recovery_error(format!(
                        "operation {operation_id} has different grant and invocation digests"
                    )));
                }
                if let Some(existing) = self.operations.get(&operation_key) {
                    if existing.request_digest != fact.request_digest
                        || existing.admission.invocation_id != fact.invocation_id
                    {
                        return Err(recovery_error(format!(
                            "operation {operation_id} has conflicting invocation facts"
                        )));
                    }
                } else {
                    self.operations.insert(
                        operation_key,
                        OperationRecord {
                            request_digest: fact.request_digest.clone(),
                            admission,
                        },
                    );
                }
                self.invocations.insert(
                    fact.invocation_id.clone(),
                    InvocationRecord {
                        invocation_id: fact.invocation_id.clone(),
                        run_id: envelope.identity.run_id.clone(),
                        operation_id,
                        control_epoch: envelope.identity.control_epoch,
                        grant_id,
                        reservation_id,
                        scope: grant.scope.clone(),
                        request_digest: fact.request_digest.clone(),
                        idempotency_key_hash: fact.idempotency_key_hash.clone(),
                        attempt_id: None,
                        lifecycle: InvocationLifecycle::Admitted,
                        last_fact_id: envelope.fact_id.clone(),
                        effect_outcome: None,
                    },
                );
                return Ok(());
            }
            _ => {}
        }

        let invocation = self
            .invocations
            .get_mut(&fact.invocation_id)
            .ok_or_else(|| {
                recovery_error(format!(
                    "invocation fact {:?} precedes admission for {}",
                    fact.kind, fact.invocation_id
                ))
            })?;
        if invocation.run_id != envelope.identity.run_id
            || invocation.operation_id != operation_id
            || invocation.control_epoch != envelope.identity.control_epoch
            || envelope.identity.capability_grant_id.as_ref() != Some(&invocation.grant_id)
            || envelope.identity.grant_reservation_id.as_ref() != Some(&invocation.reservation_id)
            || invocation.request_digest != fact.request_digest
            || invocation.idempotency_key_hash != fact.idempotency_key_hash
            || invocation.scope.tool_id != fact.tool_id
            || envelope.identity.causation_id.as_ref() != Some(&invocation.last_fact_id)
        {
            return Err(recovery_error(format!(
                "invocation {} changed its causal identity or digest",
                fact.invocation_id
            )));
        }
        match fact.kind {
            InvocationFactKindV2::AttemptPrepared => {
                if invocation.lifecycle != InvocationLifecycle::Admitted
                    || invocation.attempt_id.is_some()
                    || fact.attempt_id.is_none()
                {
                    return Err(illegal_replay_transition(invocation, fact.kind));
                }
                invocation.attempt_id = fact.attempt_id.clone();
                invocation.lifecycle = InvocationLifecycle::AttemptPrepared;
            }
            InvocationFactKindV2::ExecutionStarted => {
                if invocation.lifecycle != InvocationLifecycle::AttemptPrepared
                    || invocation.attempt_id != fact.attempt_id
                {
                    return Err(illegal_replay_transition(invocation, fact.kind));
                }
                invocation.lifecycle = InvocationLifecycle::EffectStarted;
            }
            InvocationFactKindV2::Completed => {
                if invocation.lifecycle != InvocationLifecycle::EffectStarted
                    || invocation.attempt_id != fact.attempt_id
                    || !matches!(
                        invocation.effect_outcome,
                        Some(EffectOutcomeV2::Observed | EffectOutcomeV2::ObservedAfterCancel)
                    )
                {
                    return Err(illegal_replay_transition(invocation, fact.kind));
                }
                invocation.lifecycle = InvocationLifecycle::Completed;
            }
            InvocationFactKindV2::FailedBeforeAttempt => {
                if invocation.lifecycle != InvocationLifecycle::Admitted
                    || invocation.attempt_id.is_some()
                    || fact.attempt_id.is_some()
                    || invocation.effect_outcome.is_some()
                {
                    return Err(illegal_replay_transition(invocation, fact.kind));
                }
                invocation.lifecycle = InvocationLifecycle::Failed;
            }
            InvocationFactKindV2::Failed => {
                let legal_pre_effect = invocation.lifecycle == InvocationLifecycle::AttemptPrepared
                    && invocation.effect_outcome.is_none();
                let legal_post_effect = invocation.lifecycle == InvocationLifecycle::EffectStarted
                    && matches!(
                        invocation.effect_outcome,
                        Some(EffectOutcomeV2::Observed | EffectOutcomeV2::ObservedAfterCancel)
                    );
                if (!legal_pre_effect && !legal_post_effect)
                    || invocation.attempt_id != fact.attempt_id
                {
                    return Err(illegal_replay_transition(invocation, fact.kind));
                }
                invocation.lifecycle = InvocationLifecycle::Failed;
            }
            InvocationFactKindV2::Indeterminate => {
                if invocation.lifecycle != InvocationLifecycle::EffectStarted
                    || invocation.attempt_id != fact.attempt_id
                    || invocation.effect_outcome != Some(EffectOutcomeV2::Indeterminate)
                {
                    return Err(illegal_replay_transition(invocation, fact.kind));
                }
                invocation.lifecycle = InvocationLifecycle::Indeterminate;
            }
            InvocationFactKindV2::Rejected => {
                return Err(recovery_error(format!(
                    "rejected fact cannot attach to admitted invocation {}",
                    fact.invocation_id
                )));
            }
            InvocationFactKindV2::CancellationObserved => {
                return Err(recovery_error(format!(
                    "SP2 cannot restore cancellation state for invocation {}",
                    fact.invocation_id
                )));
            }
            InvocationFactKindV2::Submitted | InvocationFactKindV2::Admitted => {
                unreachable!("handled above")
            }
        }
        invocation.last_fact_id = envelope.fact_id.clone();
        Ok(())
    }

    fn replay_effect(
        &mut self,
        envelope: &KernelFactEnvelopeV2,
        fact: &EffectFactV2,
    ) -> AuthorityResult<()> {
        let invocation = self
            .invocations
            .get_mut(&fact.invocation_id)
            .ok_or_else(|| {
                recovery_error(format!(
                    "effect fact precedes admission for invocation {}",
                    fact.invocation_id
                ))
            })?;
        if invocation.lifecycle != InvocationLifecycle::EffectStarted
            || invocation.effect_outcome.is_some()
            || invocation.run_id != envelope.identity.run_id
            || envelope.identity.operation_id.as_ref() != Some(&invocation.operation_id)
            || invocation.control_epoch != envelope.identity.control_epoch
            || envelope.identity.capability_grant_id.as_ref() != Some(&invocation.grant_id)
            || envelope.identity.grant_reservation_id.as_ref() != Some(&invocation.reservation_id)
            || envelope.identity.invocation_id.as_ref() != Some(&invocation.invocation_id)
            || invocation.attempt_id.as_ref() != Some(&fact.attempt_id)
            || envelope.identity.attempt_id.as_ref() != Some(&fact.attempt_id)
            || envelope.identity.idempotency_key_hash.as_deref()
                != Some(&invocation.idempotency_key_hash)
            || envelope.identity.causation_id.as_ref() != Some(&invocation.last_fact_id)
        {
            return Err(recovery_error(format!(
                "effect fact changed identity or illegally followed invocation {}",
                fact.invocation_id
            )));
        }
        if fact.outcome == EffectOutcomeV2::None {
            return Err(recovery_error(format!(
                "effect fact for invocation {} cannot record a none outcome",
                fact.invocation_id
            )));
        }
        invocation.effect_outcome = Some(fact.outcome);
        invocation.last_fact_id = envelope.fact_id.clone();
        Ok(())
    }

    fn reconcile_unclosed_attempts(&mut self) -> AuthorityResult<()> {
        let admitted = self
            .invocations
            .values()
            .filter(|invocation| invocation.lifecycle == InvocationLifecycle::Admitted)
            .map(|invocation| invocation.invocation_id.clone())
            .collect::<Vec<_>>();
        for invocation_id in admitted {
            self.finalize_pre_effect_failure(&invocation_id, "RecoveryBeforeAttempt")?;
        }

        let prepared = self
            .invocations
            .values()
            .filter(|invocation| invocation.lifecycle == InvocationLifecycle::AttemptPrepared)
            .map(|invocation| invocation.invocation_id.clone())
            .collect::<Vec<_>>();
        for invocation_id in prepared {
            self.finalize_pre_effect_failure(&invocation_id, "RecoveryBeforeEffect")?;
        }

        let crossed_effect_boundary = self
            .invocations
            .values()
            .filter(|invocation| invocation.lifecycle == InvocationLifecycle::EffectStarted)
            .map(|invocation| (invocation.invocation_id.clone(), invocation.effect_outcome))
            .collect::<Vec<_>>();
        for (invocation_id, effect_outcome) in crossed_effect_boundary {
            if effect_outcome.is_some() {
                return Err(recovery_error(format!(
                    "invocation {invocation_id} has an effect fact without an atomic terminal fact"
                )));
            }
            self.finalize_indeterminate(
                &invocation_id,
                serde_json::json!({
                    "reason": "recovery_unclosed_effect_boundary",
                    "automaticRetryAllowed": false,
                }),
            )?;
        }
        Ok(())
    }

    fn reject_invocation(
        &mut self,
        request: &InvocationSubmitRequest,
        invocation_id: InvocationId,
        submitted: KernelFactDraftV2,
        submitted_fact_id: FactId,
        code: KernelErrorCodeV2,
        retryable: bool,
    ) -> AuthorityResult<InvocationAdmission> {
        let rejected_fact_id = self.next_fact_id();
        let rejected = self.invocation_draft(
            request,
            invocation_id.clone(),
            None,
            None,
            InvocationFactKindV2::Rejected,
            None,
            Some(error_code_name(code).to_string()),
            Some(retryable),
            Some(submitted_fact_id),
            rejected_fact_id,
        );
        self.persist("reject_invocation", vec![submitted, rejected], false)?;
        let admission = InvocationAdmission {
            invocation_id,
            admitted: false,
            rejection_code: Some(code),
            retryable,
            replayed: false,
        };
        if !retryable {
            self.operations.insert(
                (request.run_id.clone(), request.operation_id.clone()),
                OperationRecord {
                    request_digest: request.request_digest.clone(),
                    admission: admission.clone(),
                },
            );
        }
        Ok(admission)
    }

    #[allow(clippy::too_many_arguments)]
    fn invocation_draft(
        &self,
        request: &InvocationSubmitRequest,
        invocation_id: InvocationId,
        grant_id: Option<GrantId>,
        reservation_id: Option<GrantReservationId>,
        kind: InvocationFactKindV2,
        attempt_id: Option<AttemptId>,
        error_code: Option<String>,
        retryable: Option<bool>,
        causation_id: Option<FactId>,
        fact_id: FactId,
    ) -> KernelFactDraftV2 {
        KernelFactDraftV2::new(
            fact_id,
            occurred_at(),
            causal_identity(IdentityParts {
                run_id: request.run_id.clone(),
                control_epoch: request.control_epoch,
                operation_id: Some(request.operation_id.clone()),
                grant_id,
                reservation_id,
                invocation_id: Some(invocation_id.clone()),
                attempt_id: attempt_id.clone(),
                causation_id,
                idempotency_key_hash: Some(request.idempotency_key_hash.clone()),
            }),
            KernelFactPayloadV2::Invocation(InvocationFactV2 {
                kind,
                invocation_id,
                tool_id: request.scope.tool_id.clone(),
                request_digest: request.request_digest.clone(),
                idempotency_key_hash: request.idempotency_key_hash.clone(),
                attempt_id,
                error_code,
                retryable,
            }),
        )
    }

    fn invocation_record_draft(
        &mut self,
        invocation: &InvocationRecord,
        kind: InvocationFactKindV2,
        attempt_id: Option<AttemptId>,
        error_code: Option<String>,
        retryable: Option<bool>,
        causation_id: Option<FactId>,
    ) -> KernelFactDraftV2 {
        let request = InvocationSubmitRequest {
            run_id: invocation.run_id.clone(),
            operation_id: invocation.operation_id.clone(),
            control_epoch: invocation.control_epoch,
            grant_id: invocation.grant_id.clone(),
            scope: invocation.scope.clone(),
            request_digest: invocation.request_digest.clone(),
            idempotency_key_hash: invocation.idempotency_key_hash.clone(),
        };
        let fact_id = self.next_fact_id();
        self.invocation_draft(
            &request,
            invocation.invocation_id.clone(),
            if matches!(kind, InvocationFactKindV2::Rejected) {
                None
            } else {
                Some(invocation.grant_id.clone())
            },
            if matches!(kind, InvocationFactKindV2::Rejected) {
                None
            } else {
                Some(invocation.reservation_id.clone())
            },
            kind,
            attempt_id,
            error_code,
            retryable,
            causation_id,
            fact_id,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn grant_draft(
        &mut self,
        grant: &GrantRecord,
        kind: GrantFactKindV2,
        operation_id: Option<OperationId>,
        invocation_id: Option<InvocationId>,
        reservation_id: Option<GrantReservationId>,
        causation_id: Option<FactId>,
        reason: Option<String>,
    ) -> KernelFactDraftV2 {
        let fact_id = self.next_fact_id();
        self.grant_draft_with_use_count(
            grant,
            kind,
            operation_id,
            invocation_id,
            reservation_id,
            None,
            causation_id,
            reason,
            grant.observed_use_count,
            fact_id,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn grant_draft_with_use_count(
        &self,
        grant: &GrantRecord,
        kind: GrantFactKindV2,
        operation_id: Option<OperationId>,
        invocation_id: Option<InvocationId>,
        reservation_id: Option<GrantReservationId>,
        attempt_id: Option<AttemptId>,
        causation_id: Option<FactId>,
        reason: Option<String>,
        observed_use_count: u64,
        fact_id: FactId,
    ) -> KernelFactDraftV2 {
        KernelFactDraftV2::new(
            fact_id,
            occurred_at(),
            causal_identity(IdentityParts {
                run_id: grant.run_id.clone(),
                control_epoch: grant.control_epoch,
                operation_id,
                grant_id: Some(grant.grant_id.clone()),
                reservation_id,
                invocation_id,
                attempt_id,
                causation_id,
                idempotency_key_hash: None,
            }),
            KernelFactPayloadV2::Grant(GrantFactV2 {
                kind,
                grant_id: grant.grant_id.clone(),
                tool_id: grant.scope.tool_id.clone(),
                resource_scope: grant.scope.resource_scope.clone(),
                effect_scope: grant.scope.effect_scope.clone(),
                request_digest: grant.request_digest.clone(),
                use_policy: GrantUsePolicyV2::UnboundedWithinEpoch,
                observed_use_count,
                reason,
            }),
        )
    }

    fn validate_current_epoch(&self, run_id: &RunId, actual: ControlEpoch) -> AuthorityResult<()> {
        let expected = self.current_epochs.get(run_id).copied();
        if expected != Some(actual) {
            return Err(AuthorityError::StaleControlEpoch { expected, actual });
        }
        Ok(())
    }

    fn invocation(&self, invocation_id: &InvocationId) -> AuthorityResult<&InvocationRecord> {
        self.invocations
            .get(invocation_id)
            .ok_or_else(|| AuthorityError::InvocationNotFound {
                invocation_id: invocation_id.clone(),
            })
    }

    fn ensure_mutations_allowed(&self) -> AuthorityResult<()> {
        if self.storage_faulted_after_effect {
            return Err(AuthorityError::FactStoreUnavailable {
                operation: "mutation_guard",
                message:
                    "a post-effect fact write failed; reopen and reconcile before new mutations"
                        .to_string(),
            });
        }
        Ok(())
    }

    fn persist(
        &mut self,
        operation: &'static str,
        drafts: Vec<KernelFactDraftV2>,
        post_effect: bool,
    ) -> AuthorityResult<()> {
        match self.fact_store.append_batch(drafts) {
            Ok(_) => Ok(()),
            Err(error) => {
                if post_effect {
                    self.storage_faulted_after_effect = true;
                }
                Err(AuthorityError::FactStoreUnavailable {
                    operation,
                    message: error.to_string(),
                })
            }
        }
    }

    fn next_kernel_id(&mut self, kind: &str) -> String {
        let sequence = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        format!("{kind}-{}-{sequence}", self.instance_nonce)
    }

    fn next_fact_id(&mut self) -> FactId {
        FactId::new(self.next_kernel_id("fact"))
    }
}

fn causal_identity(parts: IdentityParts) -> CausalIdentityV2 {
    CausalIdentityV2 {
        run_id: parts.run_id,
        control_epoch: parts.control_epoch,
        operation_id: parts.operation_id,
        capability_grant_id: parts.grant_id,
        grant_reservation_id: parts.reservation_id,
        invocation_id: parts.invocation_id,
        attempt_id: parts.attempt_id,
        causation_id: parts.causation_id,
        correlation_refs: Vec::new(),
        idempotency_key_hash: parts.idempotency_key_hash,
    }
}

fn validate_scope(scope: &CapabilityScope) -> AuthorityResult<()> {
    require_non_empty("toolId", &scope.tool_id)?;
    if scope.resource_scope.is_empty() {
        return Err(AuthorityError::InvalidRequest {
            field: "resourceScope",
            reason: "must contain at least one exact value".to_string(),
        });
    }
    if scope.effect_scope.is_empty() {
        return Err(AuthorityError::InvalidRequest {
            field: "effectScope",
            reason: "must contain at least one exact value".to_string(),
        });
    }
    for value in &scope.resource_scope {
        require_non_empty("resourceScope", value)?;
    }
    for value in &scope.effect_scope {
        require_non_empty("effectScope", value)?;
    }
    let canonical = CapabilityScope::new(
        scope.tool_id.clone(),
        scope.resource_scope.clone(),
        scope.effect_scope.clone(),
    )?;
    if &canonical != scope {
        return Err(AuthorityError::InvalidRequest {
            field: "scope",
            reason: "must be canonical, duplicate-free, and deterministically ordered".to_string(),
        });
    }
    Ok(())
}

fn validate_optional_text(field: &'static str, value: Option<&str>) -> AuthorityResult<()> {
    if let Some(value) = value {
        require_non_empty(field, value)?;
    }
    Ok(())
}

fn require_state(
    invocation: &InvocationRecord,
    expected: InvocationLifecycle,
    expected_name: &'static str,
) -> AuthorityResult<()> {
    if invocation.lifecycle != expected {
        return Err(AuthorityError::InvalidInvocationState {
            invocation_id: invocation.invocation_id.clone(),
            expected: expected_name,
            actual: invocation.lifecycle,
        });
    }
    Ok(())
}

fn illegal_replay_transition(
    invocation: &InvocationRecord,
    next: InvocationFactKindV2,
) -> AuthorityError {
    recovery_error(format!(
        "invocation {} cannot transition from {:?} via {:?}",
        invocation.invocation_id, invocation.lifecycle, next
    ))
}

fn grant_snapshot(grant: &GrantRecord) -> GrantSnapshot {
    let mut reservations = grant
        .reservations
        .values()
        .map(|reservation| (reservation.reservation_id.clone(), reservation.lifecycle))
        .collect::<Vec<_>>();
    reservations.sort_by(|left, right| left.0.cmp(&right.0));
    GrantSnapshot {
        grant_id: grant.grant_id.clone(),
        run_id: grant.run_id.clone(),
        control_epoch: grant.control_epoch,
        scope: grant.scope.clone(),
        request_digest: grant.request_digest.clone(),
        lifecycle: grant.lifecycle,
        observed_use_count: grant.observed_use_count,
        reservations,
    }
}

fn invocation_snapshot(invocation: &InvocationRecord) -> InvocationSnapshot {
    InvocationSnapshot {
        invocation_id: invocation.invocation_id.clone(),
        run_id: invocation.run_id.clone(),
        operation_id: invocation.operation_id.clone(),
        control_epoch: invocation.control_epoch,
        grant_id: invocation.grant_id.clone(),
        reservation_id: invocation.reservation_id.clone(),
        attempt_id: invocation.attempt_id.clone(),
        lifecycle: invocation.lifecycle,
    }
}

fn error_code_name(code: KernelErrorCodeV2) -> &'static str {
    match code {
        KernelErrorCodeV2::UnsupportedAbiVersion => "UnsupportedAbiVersion",
        KernelErrorCodeV2::InvalidRequest => "InvalidRequest",
        KernelErrorCodeV2::RunBusy => "RunBusy",
        KernelErrorCodeV2::CapacityExceeded => "CapacityExceeded",
        KernelErrorCodeV2::StaleControlEpoch => "StaleControlEpoch",
        KernelErrorCodeV2::GrantRequired => "GrantRequired",
        KernelErrorCodeV2::GrantScopeMismatch => "GrantScopeMismatch",
        KernelErrorCodeV2::DuplicateOperationDigestMismatch => "DuplicateOperationDigestMismatch",
        KernelErrorCodeV2::InvocationNotOwnedByRun => "InvocationNotOwnedByRun",
        KernelErrorCodeV2::FactStoreUnavailable => "FactStoreUnavailable",
    }
}

fn parse_error_code(value: &str) -> Option<KernelErrorCodeV2> {
    match value {
        "UnsupportedAbiVersion" => Some(KernelErrorCodeV2::UnsupportedAbiVersion),
        "InvalidRequest" => Some(KernelErrorCodeV2::InvalidRequest),
        "RunBusy" => Some(KernelErrorCodeV2::RunBusy),
        "CapacityExceeded" => Some(KernelErrorCodeV2::CapacityExceeded),
        "StaleControlEpoch" => Some(KernelErrorCodeV2::StaleControlEpoch),
        "GrantRequired" => Some(KernelErrorCodeV2::GrantRequired),
        "GrantScopeMismatch" => Some(KernelErrorCodeV2::GrantScopeMismatch),
        "DuplicateOperationDigestMismatch" => {
            Some(KernelErrorCodeV2::DuplicateOperationDigestMismatch)
        }
        "InvocationNotOwnedByRun" => Some(KernelErrorCodeV2::InvocationNotOwnedByRun),
        "FactStoreUnavailable" => Some(KernelErrorCodeV2::FactStoreUnavailable),
        _ => None,
    }
}

fn invalid_request(field: &'static str, error: impl std::fmt::Display) -> AuthorityError {
    AuthorityError::InvalidRequest {
        field,
        reason: error.to_string(),
    }
}

fn recovery_error(message: impl Into<String>) -> AuthorityError {
    AuthorityError::FactStoreUnavailable {
        operation: "restore_authority_state",
        message: message.into(),
    }
}

fn occurred_at() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}
