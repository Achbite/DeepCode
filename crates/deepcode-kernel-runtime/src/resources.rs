use super::*;
use std::collections::BTreeMap;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct RunResourceCleanupSummary {
    pub(crate) revoked_grant_count: usize,
    pub(crate) released_resource_count: usize,
    pub(crate) removed_temp_file_count: usize,
    pub(crate) failures: Vec<String>,
}

impl DeepCodeKernelRuntime {
    pub(crate) fn restore_run_resources_from_ledger(&self, run_id: &str) -> KernelResult<()> {
        if self
            .state
            .resource_manager
            .list()
            .iter()
            .any(|resource| resource.run_id.as_deref() == Some(run_id))
        {
            return Ok(());
        }

        let events = self.ledger.list_by_run(run_id)?;
        let mut resources = BTreeMap::<String, KernelResource>::new();
        let mut released = BTreeMap::<String, KernelResource>::new();
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
                "resource.released"
                    if event.payload.get("released").and_then(Value::as_bool) == Some(true) =>
                {
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
                    if released
                        .insert(resource.resource_id.clone(), resource)
                        .is_some()
                    {
                        return Err(KernelError::Structured {
                            code: "resource_lease_restore_conflict",
                            stage: "resource.restore",
                            message: "ledger contains duplicate terminal resource facts"
                                .to_string(),
                            details: serde_json::json!({ "runId": run_id }),
                        });
                    }
                }
                _ => {}
            }
        }

        if resources.is_empty() {
            return Ok(());
        }
        self.state
            .resource_manager
            .acquire_batch(resources.into_values().collect(), |_| Ok(()))?;
        for resource in released.into_values() {
            self.state.resource_manager.restore_released(resource)?;
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
                serde_json::json!({
                    "leaseId": lease.id,
                    "authorizationContractId": lease.authorization_contract_id,
                    "planId": lease.plan_id,
                    "planHash": lease.plan_hash,
                    "contractHash": lease.contract_hash,
                    "workspaceBindingHash": lease.workspace_binding_hash,
                    "catalogVersion": lease.catalog_version,
                    "permissionBundleIds": lease.permission_bundle_ids,
                    "operationIds": lease.operation_ids,
                    "leaseKind": "planAuthorization",
                    "lease": &lease,
                    "managedBy": "kernel.resourceManager",
                }),
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
        let owner =
            KernelResourceOwner::agent_run(Some(session_id.to_string()), run_id.to_string());
        let resources = grants
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
                    serde_json::json!({
                        "leaseKind": if grant.resource_kind == "runtimePermission" {
                            "runtimePermission"
                        } else {
                            "planExecution"
                        },
                        "grant": grant,
                        "managedBy": "kernel.resourceManager"
                    }),
                )
            })
            .collect::<Vec<_>>();
        let count = grants.len();
        self.acquire_resource_batch(
            run_id,
            session_id,
            "Kernel registered temporary permission grant leases.",
            resources,
        )?;
        Ok(count)
    }

    pub(crate) fn acquire_resource_batch(
        &self,
        run_id: &str,
        session_id: &str,
        summary: &str,
        resources: Vec<KernelResource>,
    ) -> KernelResult<deepcode_kernel_ledger::KernelResourceAcquireBatchResult> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.state
            .resource_manager
            .acquire_batch(resources, |acquired| {
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
                resource.metadata.get("leaseKind").and_then(Value::as_str)
                    == Some("planAuthorization")
                    && resource
                        .metadata
                        .get("lease")
                        .and_then(|lease| lease.get("authorizationContractId"))
                        .and_then(Value::as_str)
                        == Some(authorization_contract_id)
            })
    }

    pub(crate) fn active_temporary_grants(&self, run_id: &str) -> Vec<TemporaryGrantEnvelope> {
        let owner = KernelResourceOwner::agent_run(None::<String>, run_id.to_string());
        self.state
            .resource_manager
            .active_by_owner(&owner)
            .into_iter()
            .filter(|resource| resource.kind == KernelResourceKind::PermissionGrant)
            .filter(|resource| {
                matches!(
                    resource.metadata.get("leaseKind").and_then(Value::as_str),
                    Some("planExecution" | "runtimePermission")
                )
            })
            .filter_map(|resource| {
                resource
                    .metadata
                    .get("grant")
                    .cloned()
                    .and_then(|value| serde_json::from_value(value).ok())
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
        )
    }

    pub(crate) fn release_run_resources(
        &mut self,
        run_id: &str,
        session_id: &str,
        reason: &str,
    ) -> KernelResult<RunResourceCleanupSummary> {
        self.release_resources_by_policy(
            run_id,
            session_id,
            &[
                KernelResourceCleanupPolicy::OnBatchReviewReady,
                KernelResourceCleanupPolicy::OnRunEnd,
            ],
            reason,
        )
    }

    fn release_resources_by_policy(
        &mut self,
        run_id: &str,
        session_id: &str,
        policies: &[KernelResourceCleanupPolicy],
        reason: &str,
    ) -> KernelResult<RunResourceCleanupSummary> {
        let mut summary = RunResourceCleanupSummary::default();
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

        for resource in resources {
            if resource.kind == KernelResourceKind::PermissionGrant {
                summary.revoked_grant_count += 1;
            }
            if resource.kind == KernelResourceKind::TempArtifact {
                match remove_registered_temp_file(&resource) {
                    Ok(removed) => {
                        summary.removed_temp_file_count += usize::from(removed);
                    }
                    Err(error) => {
                        summary
                            .failures
                            .push(format!("{}: {error}", resource.resource_id));
                        let sequence = self.ledger.next_sequence(run_id)?;
                        self.append_ledger(
                            run_id,
                            session_id,
                            "resource.cleanup_failed",
                            sequence,
                            serde_json::json!({
                                "summary": "Kernel failed to clean a registered temporary resource.",
                                "resourceId": resource.resource_id,
                                "kind": resource.kind,
                                "reason": reason,
                                "error": error.to_string()
                            }),
                        )?;
                        continue;
                    }
                }
            }

            let sequence = self.ledger.next_sequence(run_id)?;
            let release = self.state.resource_manager.release(
                &resource.resource_id,
                |released_resource| {
                    self.append_ledger(
                        run_id,
                        session_id,
                        "resource.released",
                        sequence,
                        serde_json::json!({
                            "summary": "Kernel released a registered run resource.",
                            "resourceId": released_resource.resource_id,
                            "resource": released_resource,
                            "kind": released_resource.kind,
                            "cleanupPolicy": released_resource.cleanup_policy,
                            "reason": reason,
                            "released": true,
                            "error": null
                        }),
                    )
                },
            )?;
            if release.released {
                summary.released_resource_count += 1;
            } else if let Some(error) = release.error.as_ref() {
                summary
                    .failures
                    .push(format!("{}: {error}", resource.resource_id));
            }
        }

        Ok(summary)
    }
}

fn remove_registered_temp_file(resource: &KernelResource) -> KernelResult<bool> {
    if resource.metadata.get("temporary").and_then(Value::as_bool) != Some(true) {
        return Err(KernelError::PermissionDenied(format!(
            "resource {} is not marked as a managed temporary file",
            resource.resource_id
        )));
    }
    let path = resource
        .metadata
        .get("absolutePath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| {
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
