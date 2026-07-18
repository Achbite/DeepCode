use super::*;
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq)]
pub struct KernelResourceAcquireBatchResult {
    pub resources: Vec<KernelResource>,
    pub acquired_resource_ids: Vec<String>,
    pub reused_resource_ids: Vec<String>,
}

#[derive(Debug, Default)]
struct KernelResourceManagerState {
    resources: BTreeMap<String, KernelResource>,
    resource_ids_by_idempotency_key: BTreeMap<String, String>,
}

/// Maintains the live projection for one resource owner domain.
///
/// Persistence callbacks run before state transitions become visible. The Ledger remains the
/// authority; this projection can be rebuilt from resource lifecycle facts after restart.
#[derive(Debug, Default)]
pub struct KernelResourceManager {
    state: Mutex<KernelResourceManagerState>,
}

impl KernelResourceManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn acquire_batch<F>(
        &self,
        candidates: Vec<KernelResource>,
        persist: F,
    ) -> KernelResult<KernelResourceAcquireBatchResult>
    where
        F: FnOnce(&[KernelResource]) -> KernelResult<()>,
    {
        let mut state = self.state.lock().expect("resource manager lock");
        let mut batch_resource_ids = BTreeSet::new();
        let mut batch_idempotency_keys = BTreeSet::new();
        let mut resolved = Vec::with_capacity(candidates.len());
        let mut new_resources = Vec::new();
        let mut reused_resource_ids = Vec::new();

        for mut candidate in candidates {
            if candidate.resource_id.trim().is_empty()
                || candidate.logical_key.trim().is_empty()
                || candidate.idempotency_key.trim().is_empty()
            {
                return Err(resource_conflict(
                    "resource_lease_conflict",
                    "resource acquisition requires non-empty resourceId, logicalKey, and idempotencyKey",
                    &candidate,
                ));
            }
            if !batch_resource_ids.insert(candidate.resource_id.clone())
                || !batch_idempotency_keys.insert(candidate.idempotency_key.clone())
            {
                return Err(resource_conflict(
                    "resource_lease_conflict",
                    "resource acquisition batch contains duplicate identity",
                    &candidate,
                ));
            }
            if let Some(existing_id) = state
                .resource_ids_by_idempotency_key
                .get(&candidate.idempotency_key)
            {
                let existing = state
                    .resources
                    .get(existing_id)
                    .expect("idempotency index references a resource");
                if existing.state != KernelResourceState::Active {
                    return Err(resource_conflict(
                        "resource_lease_terminal",
                        "resource idempotency key belongs to a non-active lease",
                        existing,
                    ));
                }
                if !same_acquisition(existing, &candidate) {
                    return Err(resource_conflict(
                        "resource_lease_conflict",
                        "active resource idempotency key has different lease metadata",
                        &candidate,
                    ));
                }
                reused_resource_ids.push(existing.resource_id.clone());
                resolved.push(existing.clone());
                continue;
            }
            if state.resources.contains_key(&candidate.resource_id) {
                return Err(resource_conflict(
                    "resource_lease_conflict",
                    "resource instance ID is already registered with another idempotency key",
                    &candidate,
                ));
            }
            if candidate.created_at.is_none() {
                candidate.created_at = Some(unix_timestamp_millis());
            }
            resolved.push(candidate.clone());
            new_resources.push(candidate);
        }

        persist(&new_resources)?;
        for resource in &new_resources {
            state.resource_ids_by_idempotency_key.insert(
                resource.idempotency_key.clone(),
                resource.resource_id.clone(),
            );
            state
                .resources
                .insert(resource.resource_id.clone(), resource.clone());
        }
        Ok(KernelResourceAcquireBatchResult {
            resources: resolved,
            acquired_resource_ids: new_resources
                .iter()
                .map(|resource| resource.resource_id.clone())
                .collect(),
            reused_resource_ids,
        })
    }

    pub fn get(&self, resource_id: &str) -> Option<KernelResource> {
        self.state
            .lock()
            .expect("resource manager lock")
            .resources
            .get(resource_id)
            .cloned()
    }

    pub fn list(&self) -> Vec<KernelResource> {
        self.state
            .lock()
            .expect("resource manager lock")
            .resources
            .values()
            .cloned()
            .collect()
    }

    pub fn active_by_owner(&self, owner: &KernelResourceOwner) -> Vec<KernelResource> {
        self.state
            .lock()
            .expect("resource manager lock")
            .resources
            .values()
            .filter(|resource| {
                resource.state == KernelResourceState::Active && resource.owner.matches(owner)
            })
            .cloned()
            .collect()
    }

    pub fn active_by_logical_key(&self, logical_key: &str) -> Vec<KernelResource> {
        self.state
            .lock()
            .expect("resource manager lock")
            .resources
            .values()
            .filter(|resource| {
                resource.state == KernelResourceState::Active && resource.logical_key == logical_key
            })
            .cloned()
            .collect()
    }

    pub fn transition<F>(
        &self,
        resource_id: &str,
        expected: &[KernelResourceState],
        next: KernelResourceState,
        error: Option<String>,
        persist: F,
    ) -> KernelResult<KernelResourceReleaseResult>
    where
        F: FnOnce(&KernelResource) -> KernelResult<()>,
    {
        let mut state = self.state.lock().expect("resource manager lock");
        let Some(resource) = state.resources.get_mut(resource_id) else {
            return Ok(KernelResourceReleaseResult {
                resource_id: resource_id.to_string(),
                released: false,
                error: Some("resource not found".to_string()),
            });
        };
        if resource.state == next {
            return Ok(KernelResourceReleaseResult {
                resource_id: resource_id.to_string(),
                released: next == KernelResourceState::Released,
                error,
            });
        }
        if !expected.contains(&resource.state) {
            return Err(resource_conflict(
                "resource_cleanup_state_conflict",
                "resource cannot transition from its current cleanup state",
                resource,
            ));
        }
        let mut changed = resource.clone();
        changed.state = next;
        if next == KernelResourceState::Released {
            changed.released_at = Some(unix_timestamp_millis());
        }
        persist(&changed)?;
        *resource = changed;
        Ok(KernelResourceReleaseResult {
            resource_id: resource_id.to_string(),
            released: next == KernelResourceState::Released,
            error,
        })
    }

    pub fn begin_cleanup<F>(
        &self,
        resource_id: &str,
        persist: F,
    ) -> KernelResult<KernelResourceReleaseResult>
    where
        F: FnOnce(&KernelResource) -> KernelResult<()>,
    {
        self.transition(
            resource_id,
            &[
                KernelResourceState::Active,
                KernelResourceState::CleanupFailed,
            ],
            KernelResourceState::CleanupPending,
            None,
            persist,
        )
    }

    pub fn complete_cleanup<F>(
        &self,
        resource_id: &str,
        persist: F,
    ) -> KernelResult<KernelResourceReleaseResult>
    where
        F: FnOnce(&KernelResource) -> KernelResult<()>,
    {
        self.transition(
            resource_id,
            &[KernelResourceState::CleanupPending],
            KernelResourceState::Released,
            None,
            persist,
        )
    }

    pub fn fail_cleanup<F>(
        &self,
        resource_id: &str,
        error: String,
        persist: F,
    ) -> KernelResult<KernelResourceReleaseResult>
    where
        F: FnOnce(&KernelResource) -> KernelResult<()>,
    {
        self.transition(
            resource_id,
            &[KernelResourceState::CleanupPending],
            KernelResourceState::CleanupFailed,
            Some(error),
            persist,
        )
    }

    pub fn release<F>(
        &self,
        resource_id: &str,
        persist: F,
    ) -> KernelResult<KernelResourceReleaseResult>
    where
        F: FnOnce(&KernelResource) -> KernelResult<()>,
    {
        let state = self.get(resource_id).map(|resource| resource.state);
        if state == Some(KernelResourceState::Released) {
            return Ok(KernelResourceReleaseResult {
                resource_id: resource_id.to_string(),
                released: true,
                error: None,
            });
        }
        self.transition(
            resource_id,
            &[
                KernelResourceState::Active,
                KernelResourceState::CleanupPending,
                KernelResourceState::CleanupFailed,
            ],
            KernelResourceState::Released,
            None,
            persist,
        )
    }

    pub fn release_by_owner<F>(
        &self,
        owner: &KernelResourceOwner,
        mut persist: F,
    ) -> KernelResult<Vec<KernelResourceReleaseResult>>
    where
        F: FnMut(&KernelResource) -> KernelResult<()>,
    {
        self.active_by_owner(owner)
            .into_iter()
            .map(|resource| self.release(&resource.resource_id, |value| persist(value)))
            .collect()
    }

    pub fn restore(&self, restored: KernelResource) -> KernelResult<()> {
        let mut state = self.state.lock().expect("resource manager lock");
        if let Some(existing_id) = state
            .resource_ids_by_idempotency_key
            .get(&restored.idempotency_key)
        {
            if existing_id != &restored.resource_id {
                return Err(resource_conflict(
                    "resource_lease_restore_conflict",
                    "restored idempotency key points at another resource",
                    &restored,
                ));
            }
        }
        if let Some(existing) = state.resources.get(&restored.resource_id) {
            if !same_acquisition(existing, &restored) {
                return Err(resource_conflict(
                    "resource_lease_restore_conflict",
                    "restored resource metadata does not match its acquisition",
                    &restored,
                ));
            }
        }
        state.resource_ids_by_idempotency_key.insert(
            restored.idempotency_key.clone(),
            restored.resource_id.clone(),
        );
        state
            .resources
            .insert(restored.resource_id.clone(), restored);
        Ok(())
    }

    pub fn restore_released(&self, resource: KernelResource) -> KernelResult<()> {
        if resource.state != KernelResourceState::Released || resource.released_at.is_none() {
            return Err(resource_conflict(
                "resource_lease_restore_invalid",
                "restored terminal resource must include released state and releasedAt",
                &resource,
            ));
        }
        self.restore(resource)
    }
}

fn same_acquisition(left: &KernelResource, right: &KernelResource) -> bool {
    left.kind == right.kind
        && left.owner == right.owner
        && left.scope == right.scope
        && left.cleanup_policy == right.cleanup_policy
        && left.logical_key == right.logical_key
        && left.idempotency_key == right.idempotency_key
        && left.metadata == right.metadata
}

fn resource_conflict(code: &'static str, message: &str, resource: &KernelResource) -> KernelError {
    KernelError::Structured {
        code,
        stage: "resource.manage",
        message: message.to_string(),
        details: serde_json::json!({
            "resourceId": resource.resource_id,
            "logicalKey": resource.logical_key,
            "idempotencyKey": resource.idempotency_key,
            "state": resource.state,
        }),
    }
}

fn unix_timestamp_millis() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct RunResourceCleanupSummary {
    pub(crate) revoked_grant_count: usize,
    pub(crate) released_resource_count: usize,
    pub(crate) removed_temp_file_count: usize,
    pub(crate) failures: Vec<String>,
    pub(crate) events: Vec<KernelEvent>,
}

impl DeepCodeKernelRuntime {
    pub(crate) fn run_cleanup_retry(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
    ) -> KernelResult<Vec<KernelEvent>> {
        let checkpoint = self
            .state
            .cleanup_checkpoints_by_run
            .get(&run_id.0)
            .cloned()
            .filter(|_| {
                matches!(
                    self.state.cleanup_state_by_run.get(&run_id.0),
                    Some(
                        KernelCleanupState::Pending
                            | KernelCleanupState::Failed
                            | KernelCleanupState::Completed
                    )
                )
            })
            .ok_or_else(|| KernelError::Structured {
                code: "run_cleanup_not_pending",
                stage: "resource.cleanup",
                message: format!("run {} has no retryable cleanup checkpoint", run_id.0),
                details: serde_json::json!({ "runId": run_id.0 }),
            })?;
        let record = self.record_by_run(&run_id.0)?.clone();
        if record.lifecycle_state != RuntimeLifecycleState::Terminating {
            return Err(KernelError::Structured {
                code: "run_cleanup_state_invalid",
                stage: "resource.cleanup",
                message: "cleanup retry requires a terminating run".to_string(),
                details: serde_json::json!({
                    "runId": run_id.0,
                    "lifecycleState": record.lifecycle_state,
                }),
            });
        }
        let resources = checkpoint
            .resource_ids
            .iter()
            .filter_map(|resource_id| self.state.resource_manager.get(resource_id))
            .filter(|resource| resource.state != KernelResourceState::Released)
            .collect::<Vec<_>>();
        let cleanup = self.release_selected_resources(
            &run_id.0,
            &record.session_id,
            resources,
            &checkpoint.trigger,
            checkpoint.scope,
            checkpoint.intended_lifecycle,
            checkpoint.intended_run_status.clone(),
            checkpoint.review_decision.clone(),
        )?;
        let mut events = cleanup.events.clone();
        if !cleanup.failures.is_empty() {
            return Ok(events);
        }

        match checkpoint.scope {
            KernelCleanupScope::Batch => {
                if let Some(contract_id) = self
                    .state
                    .batch_checkpoints_by_run
                    .get(&run_id.0)
                    .map(|batch| batch.contract_id.clone())
                {
                    events.push(self.batch_review_ready_event(
                        &request_id,
                        &run_id.0,
                        &record.session_id,
                        &contract_id,
                        &cleanup,
                    )?);
                } else if !self
                    .ledger
                    .list_by_run(&run_id.0)?
                    .iter()
                    .any(|event| event.kind == "batch.review_ready")
                {
                    return Err(KernelError::Structured {
                        code: "batch_checkpoint_unavailable",
                        stage: "resource.cleanup",
                        message:
                            "batch cleanup completed without a checkpoint or persisted review-ready fact"
                                .to_string(),
                        details: serde_json::json!({ "runId": run_id.0 }),
                    });
                }
            }
            KernelCleanupScope::Plan | KernelCleanupScope::Run => {}
        }
        if let Some(event) = self.review_gate_cleanup_retry_event(
            request_id.clone(),
            &run_id.0,
            &record.session_id,
            &checkpoint,
            &cleanup,
        )? {
            events.push(event);
        }
        if let Some(event) = self.transition_runtime_lifecycle(
            Some(request_id),
            &run_id.0,
            &record.session_id,
            checkpoint.intended_lifecycle,
            "cleanupRetryCompleted",
        )? {
            events.push(event);
        }
        if checkpoint.scope == KernelCleanupScope::Run {
            let status = checkpoint
                .intended_run_status
                .ok_or_else(|| KernelError::Structured {
                    code: "run_recovery_schema_invalid",
                    stage: "resource.cleanup",
                    message: "run cleanup checkpoint is missing intendedRunStatus".to_string(),
                    details: serde_json::json!({ "runId": run_id.0 }),
                })?;
            let sequence = self.ledger.next_sequence(&run_id.0)?;
            self.append_ledger(
                &run_id.0,
                &record.session_id,
                "run.completed",
                sequence,
                serde_json::json!({
                    "summary": "Kernel cleanup retry completed the run.",
                    "status": status,
                    "cleanupAttempt": checkpoint.attempt + 1,
                }),
            )?;
            events.push(KernelEvent::RunCompleted {
                run_id: run_id.clone(),
                session_id: Some(SessionId(record.session_id)),
                status,
                summary: Some("Kernel cleanup retry completed the run.".to_string()),
                sequence: Some(sequence),
            });
        }
        self.state.cleanup_checkpoints_by_run.remove(&run_id.0);
        Ok(events)
    }

    pub(crate) fn restore_run_resources_from_ledger(&mut self, run_id: &str) -> KernelResult<()> {
        let events = self.ledger.list_by_run(run_id)?;
        let mut resources = BTreeMap::<String, KernelResource>::new();
        let mut cleanup_state = None;
        let mut cleanup_checkpoint = None;
        for event in events {
            match event.kind.as_str() {
                "resource.acquired_batch" => {
                    for value in event
                        .payload
                        .get("resources")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        let resource: KernelResource = serde_json::from_value(value.clone())
                            .map_err(|error| KernelError::Structured {
                                code: "resource_lease_restore_invalid",
                                stage: "resource.restore",
                                message: format!(
                                    "decode acquired resource for run {run_id}: {error}"
                                ),
                                details: serde_json::json!({ "runId": run_id }),
                            })?;
                        if resource.run_id.as_deref() != Some(run_id) {
                            return Err(KernelError::Structured {
                                code: "resource_lease_restore_invalid",
                                stage: "resource.restore",
                                message: "acquired resource owner does not match the restored run"
                                    .to_string(),
                                details: serde_json::json!({
                                    "runId": run_id,
                                    "resourceId": resource.resource_id,
                                    "resourceRunId": resource.run_id,
                                }),
                            });
                        }
                        if let Some(existing) = resources.get(&resource.resource_id) {
                            if existing != &resource {
                                return Err(KernelError::Structured {
                                    code: "resource_lease_restore_conflict",
                                    stage: "resource.restore",
                                    message:
                                        "ledger contains conflicting resource acquisition facts"
                                            .to_string(),
                                    details: serde_json::json!({
                                        "runId": run_id,
                                        "resourceId": resource.resource_id,
                                    }),
                                });
                            }
                        } else {
                            resources.insert(resource.resource_id.clone(), resource);
                        }
                    }
                }
                "resource.released" => {
                    let resource: KernelResource = serde_json::from_value(
                        event
                            .payload
                            .get("resource")
                            .cloned()
                            .unwrap_or(Value::Null),
                    )
                    .map_err(|error| KernelError::Structured {
                        code: "resource_lease_restore_invalid",
                        stage: "resource.restore",
                        message: format!("decode released resource for run {run_id}: {error}"),
                        details: serde_json::json!({ "runId": run_id }),
                    })?;
                    if resource.run_id.as_deref() != Some(run_id) {
                        return Err(KernelError::Structured {
                            code: "resource_lease_restore_invalid",
                            stage: "resource.restore",
                            message: "released resource owner does not match the restored run"
                                .to_string(),
                            details: serde_json::json!({
                                "runId": run_id,
                                "resourceId": resource.resource_id,
                                "resourceRunId": resource.run_id,
                            }),
                        });
                    }
                    resources.insert(resource.resource_id.clone(), resource);
                }
                "resource.cleanup_state_changed" => {
                    let fact_value = event
                        .payload
                        .get("fact")
                        .cloned()
                        .unwrap_or_else(|| event.payload.clone());
                    let fact: KernelResourceCleanupStateFact = serde_json::from_value(fact_value)
                        .map_err(|error| {
                        KernelError::Structured {
                            code: "run_recovery_schema_invalid",
                            stage: "resource.restore",
                            message: format!("decode cleanup state for run {run_id}: {error}"),
                            details: serde_json::json!({ "runId": run_id }),
                        }
                    })?;
                    cleanup_state = Some(fact.state);
                    if let Some(resource_id) = fact.resource_id {
                        let resource = resources.get_mut(&resource_id).ok_or_else(|| {
                            KernelError::Structured {
                                code: "run_recovery_schema_invalid",
                                stage: "resource.restore",
                                message: "cleanup state references an unknown resource".to_string(),
                                details: serde_json::json!({
                                    "runId": run_id,
                                    "resourceId": resource_id,
                                }),
                            }
                        })?;
                        resource.state =
                            fact.resource_state.ok_or_else(|| KernelError::Structured {
                                code: "run_recovery_schema_invalid",
                                stage: "resource.restore",
                                message: "resource cleanup fact is missing resourceState"
                                    .to_string(),
                                details: serde_json::json!({
                                    "runId": run_id,
                                    "resourceId": resource_id,
                                }),
                            })?;
                    }
                    if let Some(value) = event.payload.get("checkpoint") {
                        cleanup_checkpoint = Some(
                            serde_json::from_value::<KernelCleanupCheckpoint>(value.clone())
                                .map_err(|error| KernelError::Structured {
                                    code: "run_recovery_schema_invalid",
                                    stage: "resource.restore",
                                    message: format!(
                                        "decode cleanup checkpoint for run {run_id}: {error}"
                                    ),
                                    details: serde_json::json!({ "runId": run_id }),
                                })?,
                        );
                    }
                }
                _ => {}
            }
        }

        for resource in resources.into_values() {
            self.state.resource_manager.restore(resource)?;
        }
        if let Some(state) = cleanup_state {
            self.state
                .cleanup_state_by_run
                .insert(run_id.to_string(), state);
            if state != KernelCleanupState::Idle {
                let checkpoint = cleanup_checkpoint.ok_or_else(|| KernelError::Structured {
                    code: "run_recovery_schema_invalid",
                    stage: "resource.restore",
                    message: "pending cleanup state has no cleanup checkpoint".to_string(),
                    details: serde_json::json!({ "runId": run_id }),
                })?;
                if checkpoint.run_id != run_id {
                    return Err(KernelError::Structured {
                        code: "run_recovery_schema_invalid",
                        stage: "resource.restore",
                        message: "cleanup checkpoint runId does not match restored run".to_string(),
                        details: serde_json::json!({
                            "runId": run_id,
                            "checkpointRunId": checkpoint.run_id,
                        }),
                    });
                }
                self.state
                    .cleanup_checkpoints_by_run
                    .insert(run_id.to_string(), checkpoint);
            }
        }
        Ok(())
    }

    pub(crate) fn restore_plan_authorization_from_ledger(
        &mut self,
        run_id: &str,
    ) -> KernelResult<()> {
        if self
            .state
            .plan_authorization_contracts_by_run
            .contains_key(run_id)
        {
            return Ok(());
        }
        let events = self.ledger.list_by_run(run_id)?;
        let mut contracts = BTreeMap::<String, KernelPlanAuthorizationContract>::new();
        for event in &events {
            if event.kind != "plan_authorization.reviewed" {
                continue;
            }
            let review: PlanAuthorizationReview =
                serde_json::from_value(event.payload.get("review").cloned().unwrap_or(Value::Null))
                    .map_err(|error| KernelError::Structured {
                        code: "plan_authorization_restore_invalid",
                        stage: "resource.restore",
                        message: format!("decode plan authorization review: {error}"),
                        details: serde_json::json!({ "runId": run_id }),
                    })?;
            contracts.insert(
                review.authorization_contract.id.clone(),
                review.authorization_contract,
            );
        }
        for event in events {
            if event.kind != "plan_authorization.decision_recorded" {
                continue;
            }
            let Some(contract_id) = event
                .payload
                .get("authorizationContractId")
                .and_then(Value::as_str)
            else {
                continue;
            };
            let Some(contract) = contracts.get_mut(contract_id) else {
                return Err(KernelError::Structured {
                    code: "plan_authorization_restore_invalid",
                    stage: "resource.restore",
                    message: "plan decision has no matching reviewed contract".to_string(),
                    details: serde_json::json!({
                        "runId": run_id,
                        "authorizationContractId": contract_id,
                    }),
                });
            };
            contract.status = match event.payload.get("decision").and_then(Value::as_str) {
                Some("accept") => PlanAuthorizationStatus::Accepted,
                Some("reject") => PlanAuthorizationStatus::Rejected,
                _ => {
                    return Err(KernelError::Structured {
                        code: "plan_authorization_restore_invalid",
                        stage: "resource.restore",
                        message: "plan authorization decision is invalid".to_string(),
                        details: serde_json::json!({
                            "runId": run_id,
                            "authorizationContractId": contract_id,
                        }),
                    });
                }
            };
        }
        if !contracts.is_empty() {
            self.state
                .plan_authorization_contracts_by_run
                .insert(run_id.to_string(), contracts);
        }
        Ok(())
    }

    pub(crate) fn register_plan_grant_lease(
        &mut self,
        run_id: &str,
        session_id: &str,
        contract: &KernelPlanAuthorizationContract,
    ) -> KernelResult<PlanGrantLease> {
        let lease = PlanGrantLease {
            id: resource_instance_id(
                "plan-grant",
                &[
                    run_id,
                    contract.id.as_str(),
                    contract.contract_hash.as_str(),
                ],
            ),
            authorization_contract_id: contract.id.clone(),
            run_id: RunId(run_id.to_string()),
            session_id: SessionId(session_id.to_string()),
            plan_id: contract.plan_id.clone(),
            plan_hash: contract.plan_hash.clone(),
            contract_hash: contract.contract_hash.clone(),
            workspace_binding_hash: contract.workspace_binding_hash.clone(),
            catalog_version: contract.catalog_version.clone(),
            permission_bundle_ids: contract
                .permission_bundles
                .iter()
                .map(|bundle| bundle.id.clone())
                .collect(),
            operation_ids: contract
                .operations
                .iter()
                .map(|operation| operation.id.clone())
                .collect(),
            active: true,
        };
        let owner =
            KernelResourceOwner::agent_run(Some(session_id.to_string()), run_id.to_string());
        let logical_key = format!("plan-authorization:{run_id}:{}", contract.id);
        let idempotency_key = format!(
            "plan-authorization:{run_id}:{}:{}",
            contract.id, contract.contract_hash
        );
        self.acquire_resource_batch(
            run_id,
            session_id,
            "Kernel registered a plan authorization grant lease.",
            vec![KernelResource::active(
                KernelResourceIdentity::new(lease.id.clone(), logical_key, idempotency_key),
                KernelResourceKind::PermissionGrant,
                owner,
                KernelResourceScope::Run,
                KernelResourceCleanupPolicy::OnRunEnd,
                KernelResourceMetadata::PlanAuthorizationGrant {
                    lease: lease.clone(),
                },
            )],
        )?;
        Ok(lease)
    }

    pub(crate) fn register_temporary_grants(
        &mut self,
        run_id: &str,
        session_id: &str,
        grants: Vec<TemporaryGrantEnvelope>,
    ) -> KernelResult<usize> {
        let resources = temporary_grant_resources(run_id, session_id, &grants);
        let count = grants.len();
        self.acquire_resource_batch(
            run_id,
            session_id,
            "Kernel registered temporary permission grant leases.",
            resources,
        )?;
        Ok(count)
    }

    pub(crate) fn record_permission_resolution_with_grants(
        &self,
        run_id: &str,
        session_id: &str,
        grants: &[TemporaryGrantEnvelope],
        resolution_fact: &PermissionResolutionFact,
        batch_checkpoint_payload: Value,
    ) -> KernelResult<u64> {
        let resources = temporary_grant_resources(run_id, session_id, grants);
        let first_sequence = self.ledger.next_sequence(run_id)?;
        let resolution_sequence = Cell::new(first_sequence);
        let resolution_payload = serde_json::to_value(resolution_fact).map_err(|error| {
            KernelError::InvalidCommand(format!("encode permission resolution fact: {error}"))
        })?;
        self.state
            .resource_manager
            .acquire_batch(resources, |acquired| {
                let mut events = Vec::with_capacity(3);
                if !acquired.is_empty() {
                    events.push(LedgerEvent {
                        id: format!("evt-{run_id}-{first_sequence}"),
                        run_id: Some(run_id.to_string()),
                        session_id: Some(session_id.to_string()),
                        kind: "resource.acquired_batch".to_string(),
                        sequence: Some(first_sequence),
                        payload: serde_json::json!({
                            "summary": "Kernel registered runtime permission grant leases.",
                            "resources": acquired,
                        }),
                        created_at: None,
                    });
                    resolution_sequence.set(first_sequence + 1);
                }
                let sequence = resolution_sequence.get();
                events.push(LedgerEvent {
                    id: format!("evt-{run_id}-{sequence}"),
                    run_id: Some(run_id.to_string()),
                    session_id: Some(session_id.to_string()),
                    kind: "permission.resolved".to_string(),
                    sequence: Some(sequence),
                    payload: resolution_payload,
                    created_at: None,
                });
                let checkpoint_sequence = sequence + 1;
                events.push(LedgerEvent {
                    id: format!("evt-{run_id}-{checkpoint_sequence}"),
                    run_id: Some(run_id.to_string()),
                    session_id: Some(session_id.to_string()),
                    kind: "batch.runtime_checkpoint".to_string(),
                    sequence: Some(checkpoint_sequence),
                    payload: batch_checkpoint_payload,
                    created_at: None,
                });
                self.append_ledger_batch(events)
            })?;
        Ok(resolution_sequence.get())
    }

    pub(crate) fn acquire_resource_batch(
        &self,
        run_id: &str,
        session_id: &str,
        summary: &str,
        resources: Vec<KernelResource>,
    ) -> KernelResult<KernelResourceAcquireBatchResult> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.state
            .resource_manager
            .acquire_batch(resources, |acquired| {
                if acquired.is_empty() {
                    return Ok(());
                }
                self.append_ledger(
                    run_id,
                    session_id,
                    "resource.acquired_batch",
                    sequence,
                    serde_json::json!({
                        "summary": summary,
                        "resources": acquired,
                    }),
                )
            })
    }

    pub(crate) fn plan_grant_lease_active(
        &self,
        run_id: &str,
        authorization_contract_id: &str,
    ) -> bool {
        let owner = KernelResourceOwner::agent_run(None::<String>, run_id.to_string());
        self.state
            .resource_manager
            .active_by_owner(&owner)
            .into_iter()
            .filter(|resource| resource.kind == KernelResourceKind::PermissionGrant)
            .any(|resource| {
                matches!(
                    resource.metadata,
                    KernelResourceMetadata::PlanAuthorizationGrant { lease }
                        if lease.authorization_contract_id == authorization_contract_id
                )
            })
    }

    pub(crate) fn active_temporary_grants(&self, run_id: &str) -> Vec<TemporaryGrantEnvelope> {
        let owner = KernelResourceOwner::agent_run(None::<String>, run_id.to_string());
        self.state
            .resource_manager
            .active_by_owner(&owner)
            .into_iter()
            .filter(|resource| resource.kind == KernelResourceKind::PermissionGrant)
            .filter_map(|resource| match resource.metadata {
                KernelResourceMetadata::TemporaryPermissionGrant { grant, .. } => Some(grant),
                _ => None,
            })
            .collect()
    }

    pub(crate) fn release_batch_resources(
        &mut self,
        run_id: &str,
        session_id: &str,
        reason: &str,
    ) -> KernelResult<RunResourceCleanupSummary> {
        self.release_resources_by_policy(
            run_id,
            session_id,
            &[KernelResourceCleanupPolicy::OnBatchReviewReady],
            reason,
            KernelCleanupScope::Batch,
            RuntimeLifecycleState::ReviewReady,
            None,
            None,
        )
    }

    pub(crate) fn release_run_resources_with_intent(
        &mut self,
        run_id: &str,
        session_id: &str,
        reason: &str,
        intended_run_status: Option<RunStatus>,
        review_decision: Option<ReviewGateDecision>,
    ) -> KernelResult<RunResourceCleanupSummary> {
        self.release_resources_by_policy(
            run_id,
            session_id,
            &[
                KernelResourceCleanupPolicy::OnBatchReviewReady,
                KernelResourceCleanupPolicy::OnRunEnd,
            ],
            reason,
            KernelCleanupScope::Run,
            RuntimeLifecycleState::Terminal,
            intended_run_status,
            review_decision,
        )
    }

    pub(crate) fn release_plan_authorization_resources_with_intent(
        &mut self,
        run_id: &str,
        session_id: &str,
        reason: &str,
        review_decision: Option<ReviewGateDecision>,
    ) -> KernelResult<RunResourceCleanupSummary> {
        self.state
            .plan_authorization_contracts_by_run
            .remove(run_id);
        let owner =
            KernelResourceOwner::agent_run(Some(session_id.to_string()), run_id.to_string());
        let resources = self
            .state
            .resource_manager
            .active_by_owner(&owner)
            .into_iter()
            .filter(|resource| {
                matches!(
                    &resource.metadata,
                    KernelResourceMetadata::PlanAuthorizationGrant { .. }
                )
            })
            .collect();
        self.release_selected_resources(
            run_id,
            session_id,
            resources,
            reason,
            KernelCleanupScope::Plan,
            RuntimeLifecycleState::Ready,
            None,
            review_decision,
        )
    }

    fn release_resources_by_policy(
        &mut self,
        run_id: &str,
        session_id: &str,
        policies: &[KernelResourceCleanupPolicy],
        reason: &str,
        scope: KernelCleanupScope,
        intended_lifecycle: RuntimeLifecycleState,
        intended_run_status: Option<RunStatus>,
        review_decision: Option<ReviewGateDecision>,
    ) -> KernelResult<RunResourceCleanupSummary> {
        if policies.contains(&KernelResourceCleanupPolicy::OnRunEnd) {
            self.state
                .plan_authorization_contracts_by_run
                .remove(run_id);
        }

        let owner =
            KernelResourceOwner::agent_run(Some(session_id.to_string()), run_id.to_string());
        let resources = self
            .state
            .resource_manager
            .active_by_owner(&owner)
            .into_iter()
            .filter(|resource| policies.contains(&resource.cleanup_policy))
            .collect::<Vec<_>>();

        self.release_selected_resources(
            run_id,
            session_id,
            resources,
            reason,
            scope,
            intended_lifecycle,
            intended_run_status,
            review_decision,
        )
    }

    fn release_selected_resources(
        &mut self,
        run_id: &str,
        session_id: &str,
        resources: Vec<KernelResource>,
        reason: &str,
        scope: KernelCleanupScope,
        intended_lifecycle: RuntimeLifecycleState,
        intended_run_status: Option<RunStatus>,
        review_decision: Option<ReviewGateDecision>,
    ) -> KernelResult<RunResourceCleanupSummary> {
        let mut summary = RunResourceCleanupSummary::default();
        let previous_attempt = self
            .state
            .cleanup_checkpoints_by_run
            .get(run_id)
            .map(|checkpoint| checkpoint.attempt)
            .unwrap_or(0);
        let checkpoint = KernelCleanupCheckpoint {
            run_id: run_id.to_string(),
            scope,
            trigger: reason.to_string(),
            resource_ids: resources
                .iter()
                .map(|resource| resource.resource_id.clone())
                .collect(),
            intended_lifecycle,
            intended_run_status,
            review_decision,
            attempt: previous_attempt + 1,
        };
        let pending_event = self.record_cleanup_state(
            run_id,
            session_id,
            &checkpoint,
            KernelCleanupState::Pending,
            None,
            None,
        )?;
        self.state
            .cleanup_state_by_run
            .insert(run_id.to_string(), KernelCleanupState::Pending);
        self.state
            .cleanup_checkpoints_by_run
            .insert(run_id.to_string(), checkpoint.clone());
        summary.events.push(pending_event);

        for resource in resources {
            if resource.kind == KernelResourceKind::PermissionGrant {
                summary.revoked_grant_count += 1;
            }
            let pending_fact = KernelResourceCleanupStateFact {
                run_id: run_id.to_string(),
                scope,
                state: KernelCleanupState::Pending,
                resource_id: Some(resource.resource_id.clone()),
                resource_state: Some(KernelResourceState::CleanupPending),
                attempt: checkpoint.attempt,
                error: None,
            };
            let pending_sequence = self.ledger.next_sequence(run_id)?;
            self.state
                .resource_manager
                .begin_cleanup(&resource.resource_id, |_| {
                    self.append_ledger(
                        run_id,
                        session_id,
                        "resource.cleanup_state_changed",
                        pending_sequence,
                        serde_json::to_value(&pending_fact).map_err(|error| {
                            KernelError::InvalidCommand(format!(
                                "encode resource cleanup fact: {error}"
                            ))
                        })?,
                    )
                })?;
            summary
                .events
                .push(KernelEvent::ResourceCleanupStateChanged {
                    request_id: None,
                    run_id: RunId(run_id.to_string()),
                    session_id: Some(SessionId(session_id.to_string())),
                    fact: pending_fact,
                    sequence: Some(pending_sequence),
                });

            let physical_cleanup = if resource.kind == KernelResourceKind::TempArtifact {
                match remove_registered_temp_file(&resource) {
                    Ok(removed) => {
                        summary.removed_temp_file_count += usize::from(removed);
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            } else {
                Ok(())
            };

            match physical_cleanup {
                Ok(()) => {
                    let released_fact = KernelResourceCleanupStateFact {
                        run_id: run_id.to_string(),
                        scope,
                        state: KernelCleanupState::Pending,
                        resource_id: Some(resource.resource_id.clone()),
                        resource_state: Some(KernelResourceState::Released),
                        attempt: checkpoint.attempt,
                        error: None,
                    };
                    let sequence = self.ledger.next_sequence(run_id)?;
                    let release = self.state.resource_manager.complete_cleanup(
                        &resource.resource_id,
                        |released_resource| {
                            self.append_ledger_batch(vec![
                                LedgerEvent {
                                    id: format!("evt-{run_id}-{sequence}"),
                                    run_id: Some(run_id.to_string()),
                                    session_id: Some(session_id.to_string()),
                                    kind: "resource.cleanup_state_changed".to_string(),
                                    sequence: Some(sequence),
                                    payload: serde_json::to_value(&released_fact).map_err(
                                        |error| {
                                            KernelError::InvalidCommand(format!(
                                                "encode resource cleanup fact: {error}"
                                            ))
                                        },
                                    )?,
                                    created_at: None,
                                },
                                LedgerEvent {
                                    id: format!("evt-{run_id}-{}", sequence + 1),
                                    run_id: Some(run_id.to_string()),
                                    session_id: Some(session_id.to_string()),
                                    kind: "resource.released".to_string(),
                                    sequence: Some(sequence + 1),
                                    payload: serde_json::json!({
                                        "summary": "Kernel released a registered run resource.",
                                        "resourceId": released_resource.resource_id,
                                        "resource": released_resource,
                                        "kind": released_resource.kind,
                                        "cleanupPolicy": released_resource.cleanup_policy,
                                        "reason": reason,
                                        "released": true,
                                        "error": null
                                    }),
                                    created_at: None,
                                },
                            ])
                        },
                    )?;
                    if release.released {
                        summary.released_resource_count += 1;
                    }
                    summary
                        .events
                        .push(KernelEvent::ResourceCleanupStateChanged {
                            request_id: None,
                            run_id: RunId(run_id.to_string()),
                            session_id: Some(SessionId(session_id.to_string())),
                            fact: released_fact,
                            sequence: Some(sequence),
                        });
                }
                Err(error) => {
                    let error_text = error.to_string();
                    summary
                        .failures
                        .push(format!("{}: {error_text}", resource.resource_id));
                    let failed_fact = KernelResourceCleanupStateFact {
                        run_id: run_id.to_string(),
                        scope,
                        state: KernelCleanupState::Failed,
                        resource_id: Some(resource.resource_id.clone()),
                        resource_state: Some(KernelResourceState::CleanupFailed),
                        attempt: checkpoint.attempt,
                        error: Some(error_text.clone()),
                    };
                    let sequence = self.ledger.next_sequence(run_id)?;
                    self.state.resource_manager.fail_cleanup(
                        &resource.resource_id,
                        error_text.clone(),
                        |_| {
                            self.append_ledger_batch(vec![
                                LedgerEvent {
                                    id: format!("evt-{run_id}-{sequence}"),
                                    run_id: Some(run_id.to_string()),
                                    session_id: Some(session_id.to_string()),
                                    kind: "resource.cleanup_state_changed".to_string(),
                                    sequence: Some(sequence),
                                    payload: serde_json::to_value(&failed_fact).map_err(
                                        |error| {
                                            KernelError::InvalidCommand(format!(
                                                "encode resource cleanup fact: {error}"
                                            ))
                                        },
                                    )?,
                                    created_at: None,
                                },
                                LedgerEvent {
                                    id: format!("evt-{run_id}-{}", sequence + 1),
                                    run_id: Some(run_id.to_string()),
                                    session_id: Some(session_id.to_string()),
                                    kind: "resource.cleanup_failed".to_string(),
                                    sequence: Some(sequence + 1),
                                    payload: serde_json::json!({
                                        "summary": "Kernel failed to clean a registered resource.",
                                        "resourceId": resource.resource_id,
                                        "kind": resource.kind,
                                        "reason": reason,
                                        "error": error_text
                                    }),
                                    created_at: None,
                                },
                            ])
                        },
                    )?;
                    summary
                        .events
                        .push(KernelEvent::ResourceCleanupStateChanged {
                            request_id: None,
                            run_id: RunId(run_id.to_string()),
                            session_id: Some(SessionId(session_id.to_string())),
                            fact: failed_fact,
                            sequence: Some(sequence),
                        });
                }
            }
        }

        let final_state = if summary.failures.is_empty() {
            KernelCleanupState::Completed
        } else {
            KernelCleanupState::Failed
        };
        let final_event = self.record_cleanup_state(
            run_id,
            session_id,
            &checkpoint,
            final_state,
            None,
            (!summary.failures.is_empty()).then(|| summary.failures.join("; ")),
        )?;
        self.state
            .cleanup_state_by_run
            .insert(run_id.to_string(), final_state);
        summary.events.push(final_event);
        Ok(summary)
    }

    fn record_cleanup_state(
        &self,
        run_id: &str,
        session_id: &str,
        checkpoint: &KernelCleanupCheckpoint,
        state: KernelCleanupState,
        resource_id: Option<String>,
        error: Option<String>,
    ) -> KernelResult<KernelEvent> {
        let fact = KernelResourceCleanupStateFact {
            run_id: run_id.to_string(),
            scope: checkpoint.scope,
            state,
            resource_id,
            resource_state: None,
            attempt: checkpoint.attempt,
            error,
        };
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "resource.cleanup_state_changed",
            sequence,
            serde_json::json!({
                "fact": &fact,
                "checkpoint": checkpoint,
            }),
        )?;
        Ok(KernelEvent::ResourceCleanupStateChanged {
            request_id: None,
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            fact,
            sequence: Some(sequence),
        })
    }
}

fn temporary_grant_resources(
    run_id: &str,
    session_id: &str,
    grants: &[TemporaryGrantEnvelope],
) -> Vec<KernelResource> {
    let owner = KernelResourceOwner::agent_run(Some(session_id.to_string()), run_id.to_string());
    grants
        .iter()
        .map(|grant| {
            let resource_id = permission_grant_resource_id(run_id, grant);
            let resource_path = grant.resource_path.as_deref().unwrap_or("*");
            KernelResource::active(
                KernelResourceIdentity::new(
                    resource_id,
                    format!("permission:{run_id}:{}:{}", grant.capability, resource_path),
                    format!("permission:{run_id}:{}", grant.id),
                ),
                KernelResourceKind::PermissionGrant,
                owner.clone(),
                KernelResourceScope::Run,
                KernelResourceCleanupPolicy::OnBatchReviewReady,
                KernelResourceMetadata::TemporaryPermissionGrant {
                    grant_kind: if grant.resource_kind == PermissionResourceKind::RuntimePermission
                    {
                        TemporaryPermissionGrantKind::RuntimePermission
                    } else {
                        TemporaryPermissionGrantKind::PlanExecution
                    },
                    grant: grant.clone(),
                },
            )
        })
        .collect()
}

pub(crate) fn remove_registered_temp_file(resource: &KernelResource) -> KernelResult<bool> {
    let KernelResourceMetadata::TempArtifact { absolute_path, .. } = &resource.metadata else {
        return Err(KernelError::PermissionDenied(format!(
            "resource {} is not a managed temporary artifact",
            resource.resource_id
        )));
    };
    let path = absolute_path.as_deref().map(PathBuf::from).ok_or_else(|| {
        KernelError::InvalidCommand(format!(
            "temporary resource {} has no absolutePath",
            resource.resource_id
        ))
    })?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
            fs::remove_file(&path).map_err(|error| {
                KernelError::Other(format!("remove temporary file {}: {error}", path.display()))
            })?;
            Ok(true)
        }
        Ok(_) => Err(KernelError::PermissionDenied(format!(
            "refusing to remove non-file temporary resource {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(KernelError::Other(format!(
            "inspect temporary file {}: {error}",
            path.display()
        ))),
    }
}

fn permission_grant_resource_id(run_id: &str, grant: &TemporaryGrantEnvelope) -> String {
    resource_instance_id(
        "permission-grant",
        &[
            run_id,
            grant.id.as_str(),
            grant.contract_id.as_str(),
            grant.resource_path.as_deref().unwrap_or("*"),
        ],
    )
}

pub(crate) fn resource_instance_id(kind: &str, parts: &[&str]) -> String {
    let payload = parts.join("\u{1f}");
    let digest = deepcode_kernel_tools::hash_bytes(payload.as_bytes());
    let segment = digest
        .trim_start_matches("sha256:")
        .chars()
        .take(24)
        .collect::<String>();
    format!("{kind}-{segment}")
}

#[cfg(test)]
mod resource_manager_tests {
    use super::*;

    fn temp_resource(
        resource_id: &str,
        idempotency_key: &str,
        owner: KernelResourceOwner,
    ) -> KernelResource {
        KernelResource::active(
            KernelResourceIdentity::new(
                resource_id,
                format!("temp:{resource_id}"),
                idempotency_key,
            ),
            KernelResourceKind::TempArtifact,
            owner,
            KernelResourceScope::Run,
            KernelResourceCleanupPolicy::OnRunEnd,
            KernelResourceMetadata::TempArtifact {
                path: format!("{resource_id}.tmp"),
                absolute_path: None,
                source_tool: "fs.create".to_string(),
                tool_call_id: format!("call-{resource_id}"),
            },
        )
    }

    #[test]
    fn resource_managers_keep_agent_and_host_owner_domains_independent() {
        let agent = KernelResourceManager::new();
        let host = KernelResourceManager::new();
        let resource_id = "shared-instance-label";
        agent
            .acquire_batch(
                vec![temp_resource(
                    resource_id,
                    "agent-key",
                    KernelResourceOwner::agent_run(Some("session-a"), "run-a"),
                )],
                |_| Ok(()),
            )
            .unwrap();
        host.acquire_batch(
            vec![temp_resource(
                resource_id,
                "host-key",
                KernelResourceOwner::user_session("session-host"),
            )],
            |_| Ok(()),
        )
        .unwrap();

        agent.release(resource_id, |_| Ok(())).unwrap();

        assert_eq!(
            agent.get(resource_id).unwrap().state,
            KernelResourceState::Released
        );
        assert_eq!(
            host.get(resource_id).unwrap().state,
            KernelResourceState::Active
        );
    }

    #[test]
    fn active_idempotency_reuses_exact_lease_and_rejects_conflict_or_terminal_reuse() {
        let manager = KernelResourceManager::new();
        let owner = KernelResourceOwner::agent_run(Some("session-a"), "run-a");
        let resource = temp_resource("lease-a", "lease-key", owner.clone());
        manager
            .acquire_batch(vec![resource.clone()], |_| Ok(()))
            .unwrap();
        let reused = manager
            .acquire_batch(vec![resource.clone()], |_| Ok(()))
            .unwrap();
        assert_eq!(reused.reused_resource_ids, vec!["lease-a"]);

        let conflict = temp_resource("lease-b", "lease-key", owner);
        let error = manager
            .acquire_batch(vec![conflict], |_| Ok(()))
            .unwrap_err();
        assert_eq!(
            KernelErrorEnvelope::from(&error).code,
            "resource_lease_conflict"
        );

        manager.release("lease-a", |_| Ok(())).unwrap();
        let error = manager
            .acquire_batch(vec![resource], |_| Ok(()))
            .unwrap_err();
        assert_eq!(
            KernelErrorEnvelope::from(&error).code,
            "resource_lease_terminal"
        );
    }

    #[test]
    fn acquisition_and_cleanup_transitions_install_state_only_after_persistence() {
        let manager = KernelResourceManager::new();
        let resource = temp_resource(
            "atomic-resource",
            "atomic-key",
            KernelResourceOwner::agent_run(Some("session-a"), "run-a"),
        );
        manager
            .acquire_batch(vec![resource.clone()], |_| {
                Err(KernelError::Other("ledger unavailable".to_string()))
            })
            .unwrap_err();
        assert!(manager.get("atomic-resource").is_none());

        manager.acquire_batch(vec![resource], |_| Ok(())).unwrap();
        manager
            .begin_cleanup("atomic-resource", |_| {
                Err(KernelError::Other("ledger unavailable".to_string()))
            })
            .unwrap_err();
        assert_eq!(
            manager.get("atomic-resource").unwrap().state,
            KernelResourceState::Active
        );

        manager
            .begin_cleanup("atomic-resource", |_| Ok(()))
            .unwrap();
        manager
            .fail_cleanup("atomic-resource", "cleanup failure".to_string(), |_| Ok(()))
            .unwrap();
        assert_eq!(
            manager.get("atomic-resource").unwrap().state,
            KernelResourceState::CleanupFailed
        );
        manager
            .begin_cleanup("atomic-resource", |_| Ok(()))
            .unwrap();
        manager
            .complete_cleanup("atomic-resource", |_| Ok(()))
            .unwrap();
        assert_eq!(
            manager.get("atomic-resource").unwrap().state,
            KernelResourceState::Released
        );
    }

    #[test]
    fn conflicting_acquisition_batch_registers_nothing_from_that_batch() {
        let manager = KernelResourceManager::new();
        let owner = KernelResourceOwner::agent_run(Some("session-a"), "run-a");
        manager
            .acquire_batch(
                vec![temp_resource("existing", "existing-key", owner.clone())],
                |_| Ok(()),
            )
            .unwrap();
        let persisted = Cell::new(false);
        let error = manager
            .acquire_batch(
                vec![
                    temp_resource("new", "new-key", owner.clone()),
                    temp_resource("conflict", "existing-key", owner),
                ],
                |_| {
                    persisted.set(true);
                    Ok(())
                },
            )
            .unwrap_err();
        assert_eq!(
            KernelErrorEnvelope::from(&error).code,
            "resource_lease_conflict"
        );
        assert!(!persisted.get());
        assert!(manager.get("new").is_none());
        assert_eq!(manager.list().len(), 1);
    }
}
