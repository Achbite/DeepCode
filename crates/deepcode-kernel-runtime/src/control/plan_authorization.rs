use super::plan_authorization_support::*;
use super::*;
use crate::action_batch::{workspace_relative_read_path, workspace_relative_write_path};
use deepcode_kernel_abi::{
    KernelPlanAuthorizationOperation, KernelPlanGateIntervention, KernelPlanPermissionBundle,
    TASK_INTENT_SCHEMA_VERSION,
};
use std::collections::{BTreeMap, BTreeSet};

impl DeepCodeKernelRuntime {
    pub(crate) fn authorize_execution_contract_from_plan(
        &mut self,
        run_id: &str,
        session_id: &str,
        proposal: &ProposalEnvelope,
        report: &mut ProposalReviewReportV3,
    ) -> KernelResult<()> {
        let Some(authorization_contract_id) = proposal
            .payload
            .get("authorizationContractId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
        else {
            report.status = "denied".to_string();
            report.execution_contract.status = "denied".to_string();
            report.execution_contract.permission_bundles.clear();
            report.execution_contract.interventions.clear();
            report.execution_contract.cleanup_policy = "none".to_string();
            report.execution_contract.expires_after = "immediate".to_string();
            report.diagnostics.push(
                "actionBundle requires an accepted Kernel plan authorization contract".to_string(),
            );
            report.execution_contract.contract_hash =
                execution_contract_hash(&report.execution_contract);
            return Ok(());
        };
        let Some(contract) = self
            .state
            .plan_authorization_contracts_by_run
            .get(run_id)
            .and_then(|contracts| contracts.get(&authorization_contract_id))
            .cloned()
        else {
            report.status = "denied".to_string();
            report.execution_contract.status = "denied".to_string();
            report.diagnostics.push(format!(
                "plan authorization contract {authorization_contract_id} is unavailable"
            ));
            return Ok(());
        };
        let lease_active = self.plan_grant_lease_active(run_id, &authorization_contract_id);
        if contract.status != PlanAuthorizationStatus::Accepted || !lease_active {
            report.status = "denied".to_string();
            report.execution_contract.status = "denied".to_string();
            report.diagnostics.push(format!(
                "plan authorization contract {authorization_contract_id} is not accepted or its lease is inactive"
            ));
            return Ok(());
        }
        report.execution_contract.authorization_contract_id =
            Some(authorization_contract_id.clone());
        let expanded = report
            .execution_contract
            .operations
            .iter()
            .filter(|operation| !authorized_operation_matches(&contract, operation))
            .map(|operation| operation.id.clone())
            .collect::<Vec<_>>();
        if !expanded.is_empty() {
            report.diagnostics.push(format!(
                "execution_scope_expansion: operation(s) {} are outside accepted plan authorization contract {}",
                expanded.join(", "),
                authorization_contract_id
            ));
            report.execution_contract.contract_hash =
                execution_contract_hash(&report.execution_contract);
            return Ok(());
        }

        report.status = "authorizedByPlan".to_string();
        report.required_permissions.clear();
        report.execution_contract.status = "authorizedByPlan".to_string();
        for intervention in &mut report.execution_contract.interventions {
            intervention.status = "satisfiedByPlanAuthorization".to_string();
        }
        report.execution_contract.contract_hash =
            execution_contract_hash(&report.execution_contract);
        let grants = exact_grants_from_execution_contract(
            &report.execution_contract,
            &authorization_contract_id,
        );
        self.register_temporary_grants(run_id, session_id, grants)?;
        Ok(())
    }

    pub(crate) fn plan_authorization_submit(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        intent: TaskIntentEnvelope,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?.clone();
        let session_id_text = plan_authorization_session_id(&record, session_id)?;
        let review = self.compile_plan_authorization(&record, &intent)?;
        let contract = review.authorization_contract.clone();
        self.state
            .plan_authorization_contracts_by_run
            .entry(run_id.0.clone())
            .or_default()
            .insert(contract.id.clone(), contract.clone());
        let sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &session_id_text,
            "plan_authorization.reviewed",
            sequence,
            serde_json::json!({
                "summary": "Kernel compiled task intent into a plan authorization contract.",
                "planId": intent.plan_id,
                "status": review.status,
                "review": &review,
            }),
        )?;
        Ok(vec![KernelEvent::PlanAuthorizationReviewed {
            request_id: Some(request_id),
            run_id,
            session_id: Some(SessionId(session_id_text)),
            plan_id: intent.plan_id,
            review,
            sequence: Some(sequence),
        }])
    }

    pub(crate) fn plan_authorization_decision_submit(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        decision: PlanAuthorizationDecisionSubmit,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?.clone();
        let session_id_text = plan_authorization_session_id(&record, session_id)?;
        let contract = self
            .state
            .plan_authorization_contracts_by_run
            .get_mut(&run_id.0)
            .and_then(|contracts| contracts.get_mut(&decision.authorization_contract_id))
            .ok_or_else(|| {
                KernelError::InvalidCommand(format!(
                    "plan authorization contract not found for run: {}",
                    decision.authorization_contract_id
                ))
            })?;
        if contract.plan_id != decision.plan_id
            || contract.plan_hash != decision.plan_hash
            || contract.contract_hash != decision.contract_hash
        {
            return Err(KernelError::InvalidCommand(
                "plan authorization decision does not match planHash and contractHash".to_string(),
            ));
        }
        if contract.status != PlanAuthorizationStatus::Confirmable {
            return Err(KernelError::InvalidCommand(format!(
                "plan authorization contract {} is not confirmable: {:?}",
                contract.id, contract.status
            )));
        }

        let decision_name = match decision.decision {
            PlanAuthorizationDecisionKind::Accept => "accept",
            PlanAuthorizationDecisionKind::Reject => "reject",
        };
        contract.status = if decision.decision == PlanAuthorizationDecisionKind::Accept {
            PlanAuthorizationStatus::Accepted
        } else {
            PlanAuthorizationStatus::Rejected
        };
        let contract_snapshot = contract.clone();
        let lease = if decision.decision == PlanAuthorizationDecisionKind::Accept {
            Some(self.register_plan_grant_lease(&run_id.0, &session_id_text, &contract_snapshot)?)
        } else {
            None
        };
        let sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &session_id_text,
            "plan_authorization.decision_recorded",
            sequence,
            serde_json::json!({
                "summary": "Kernel plan authorization decision recorded.",
                "decisionId": decision.decision_id,
                "authorizationContractId": decision.authorization_contract_id,
                "planId": decision.plan_id,
                "planHash": decision.plan_hash,
                "contractHash": decision.contract_hash,
                "decision": decision_name,
                "leaseId": lease.as_ref().map(|value| value.id.as_str()),
            }),
        )?;
        Ok(vec![KernelEvent::PlanAuthorizationDecisionRecorded {
            request_id: Some(request_id),
            run_id,
            session_id: Some(SessionId(session_id_text)),
            authorization_contract_id: decision.authorization_contract_id,
            decision: decision_name.to_string(),
            lease_id: lease.map(|value| value.id),
            sequence: Some(sequence),
        }])
    }

    fn compile_plan_authorization(
        &self,
        record: &RuntimeRunRecord,
        intent: &TaskIntentEnvelope,
    ) -> KernelResult<PlanAuthorizationReview> {
        let snapshot = KernelToolRegistry::default().snapshot();
        if intent.schema_version != TASK_INTENT_SCHEMA_VERSION {
            return Err(KernelError::InvalidCommand(format!(
                "TaskIntentEnvelope schemaVersion must be {TASK_INTENT_SCHEMA_VERSION}"
            )));
        }
        if intent.run_id.0 != record.run_id {
            return Err(KernelError::InvalidCommand(
                "TaskIntentEnvelope runId must match the current run".to_string(),
            ));
        }
        if intent
            .session_id
            .as_ref()
            .is_some_and(|session_id| session_id.0 != record.session_id)
        {
            return Err(KernelError::PermissionDenied(
                "TaskIntentEnvelope sessionId does not match the current run".to_string(),
            ));
        }
        if intent.catalog_version != snapshot.catalog_version
            || intent.catalog_hash != snapshot.catalog_hash
        {
            return Err(KernelError::InvalidCommand(
                "TaskIntentEnvelope ToolCatalog version/hash does not match Kernel".to_string(),
            ));
        }
        if let Some(submitted_hash) = intent.workspace_binding_hash.as_deref() {
            let accepted_hashes = workspace_binding_hashes(&record.workspace_binding);
            if !accepted_hashes.is_empty() && !accepted_hashes.contains(submitted_hash) {
                return Err(KernelError::PermissionDenied(
                    "TaskIntentEnvelope workspace binding does not match the run-bound workspace"
                        .to_string(),
                ));
            }
        }
        if intent.plan_id.trim().is_empty() || intent.plan_hash.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "TaskIntentEnvelope requires planId and planHash".to_string(),
            ));
        }

        let registry = KernelToolRegistry::default();
        let tool_tasks = intent
            .tasks
            .iter()
            .map(|task| PlanTaskIntent {
                task_id: task.task_id.clone(),
                tool_id: task.tool_id.clone(),
                targets: task.targets.clone(),
                depends_on: task.depends_on.clone(),
                args: task.args.clone(),
            })
            .collect::<Vec<_>>();
        let draft = derive_plan_authorization(&registry, &tool_tasks);
        self.finalize_plan_authorization(record, intent, draft)
    }

    fn finalize_plan_authorization(
        &self,
        record: &RuntimeRunRecord,
        intent: &TaskIntentEnvelope,
        draft: PlanAuthorizationDraft,
    ) -> KernelResult<PlanAuthorizationReview> {
        let registry = KernelToolRegistry::default();
        let mut diagnostics = draft
            .diagnostics
            .iter()
            .map(|item| item.message.clone())
            .collect::<Vec<_>>();
        let mut hard_deny = draft.diagnostics.iter().any(|item| item.hard_deny);
        let mut operations = Vec::new();
        let planned_target_kinds = self.planned_target_kinds(record, &draft.operations);
        for operation in draft.operations {
            match self.normalize_plan_operation(record, &registry, operation, &planned_target_kinds)
            {
                Ok(operation) => operations.push(operation),
                Err(error) => diagnostics.push(error.to_string()),
            }
        }
        diagnostics.extend(plan_authorization_dependency_diagnostics(&operations));
        if intent.tasks.is_empty() {
            diagnostics.push("TaskIntentEnvelope requires at least one task".to_string());
        }
        for bundle in &draft.permission_bundles {
            if bundle.permission_mode == ToolPermissionMode::Deny {
                hard_deny = true;
                diagnostics.push(format!(
                    "permission bundle {} is denied by Kernel ToolContract",
                    bundle.id
                ));
            }
        }
        let operation_ids = operations
            .iter()
            .map(|operation| operation.id.clone())
            .collect::<BTreeSet<_>>();
        let permission_bundles = draft
            .permission_bundles
            .into_iter()
            .filter_map(|bundle| {
                let operation_ids = bundle
                    .operation_ids
                    .into_iter()
                    .filter(|id| operation_ids.contains(id))
                    .collect::<Vec<_>>();
                if operation_ids.is_empty() {
                    return None;
                }
                let normalized_targets = operations
                    .iter()
                    .filter(|operation| operation_ids.contains(&operation.id))
                    .flat_map(|operation| operation.targets.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>();
                Some(KernelPlanPermissionBundle {
                    id: bundle.id,
                    capability: bundle.capability,
                    permission_mode: bundle.permission_mode.as_str().to_string(),
                    risk: bundle.risk.as_str().to_string(),
                    resource_kind: bundle.resource_kind,
                    operation_ids,
                    tool_ids: bundle.tool_ids,
                    targets: normalized_targets,
                    expires_after: bundle.expires_after,
                })
            })
            .collect::<Vec<_>>();
        let interventions = permission_bundles
            .iter()
            .filter(|bundle| bundle.permission_mode != "allow")
            .map(|bundle| KernelPlanGateIntervention {
                id: format!("plan-gate-{}", bundle.id),
                intervention_kind: if bundle.permission_mode == "deny" {
                    "policy".to_string()
                } else {
                    "permission".to_string()
                },
                status: "pending".to_string(),
                permission_bundle_id: Some(bundle.id.clone()),
                affected_operation_ids: bundle.operation_ids.clone(),
                summary: format!(
                    "Kernel plan gate requires {} for {} operation(s).",
                    bundle.permission_mode,
                    bundle.operation_ids.len()
                ),
            })
            .collect::<Vec<_>>();
        let status = if hard_deny {
            PlanAuthorizationStatus::Denied
        } else if diagnostics.is_empty() {
            PlanAuthorizationStatus::Confirmable
        } else {
            PlanAuthorizationStatus::NeedsRevision
        };
        let operation_set_hash = deepcode_kernel_tools::hash_bytes(
            serde_json::to_string(&operations)
                .unwrap_or_default()
                .as_bytes(),
        );
        let contract_id = format!(
            "plan-authorization-{}",
            compact_hash(&format!("{}:{}", intent.plan_id, intent.plan_hash))
        );
        let workspace_binding_hash =
            preferred_workspace_binding_hash(&record.workspace_binding).map(str::to_string);
        let contract_hash_payload = serde_json::json!({
            "id": contract_id,
            "planId": intent.plan_id,
            "planHash": intent.plan_hash,
            "workspaceBindingHash": workspace_binding_hash,
            "catalogVersion": intent.catalog_version,
            "catalogHash": intent.catalog_hash,
            "operationSetHash": operation_set_hash,
            "permissionBundles": permission_bundles,
        });
        let contract_hash = deepcode_kernel_tools::hash_bytes(
            serde_json::to_string(&contract_hash_payload)
                .unwrap_or_default()
                .as_bytes(),
        );
        let contract = KernelPlanAuthorizationContract {
            id: contract_id,
            plan_id: intent.plan_id.clone(),
            plan_hash: intent.plan_hash.clone(),
            status,
            workspace_binding_hash,
            catalog_version: intent.catalog_version.clone(),
            catalog_hash: intent.catalog_hash.clone(),
            operation_set_hash,
            contract_hash,
            operations,
            permission_bundles,
            interventions,
            cleanup_policy: "kernelPlanGrantLease".to_string(),
            expires_after: "reviewGateReplanCancelOrRunTerminal".to_string(),
        };
        Ok(PlanAuthorizationReview {
            plan_id: intent.plan_id.clone(),
            status,
            diagnostics,
            authorization_contract: contract,
        })
    }

    fn normalize_plan_operation(
        &self,
        record: &RuntimeRunRecord,
        registry: &KernelToolRegistry,
        operation: PlanAuthorizationOperationDraft,
        planned_target_kinds: &BTreeMap<String, String>,
    ) -> KernelResult<KernelPlanAuthorizationOperation> {
        let template = registry.template(&operation.tool_id).ok_or_else(|| {
            KernelError::InvalidCommand(format!("toolId {} is not registered", operation.tool_id))
        })?;
        match template.resource.plan_target_mode {
            PlanTargetMode::PerTarget if operation.targets.len() != 1 => {
                return Err(KernelError::InvalidCommand(format!(
                    "{} plan authorization operation {} requires exactly one target",
                    operation.tool_id, operation.id
                )));
            }
            PlanTargetMode::SourceDestination if operation.targets.len() != 2 => {
                return Err(KernelError::InvalidCommand(format!(
                    "{} plan authorization operation {} requires source and destination targets",
                    operation.tool_id, operation.id
                )));
            }
            PlanTargetMode::PerTarget
            | PlanTargetMode::SourceDestination
            | PlanTargetMode::Aggregate => {}
        }
        let mut normalized_targets = Vec::new();
        let mut target_kind = None;
        let mut recursive = None;
        if matches!(
            template.family,
            ToolFamily::Workspace | ToolFamily::Document
        ) {
            for (target_index, target) in operation.targets.iter().enumerate() {
                let normalized = if template.resource.read_only {
                    workspace_relative_read_path(self, record, target)?
                } else {
                    workspace_relative_write_path(self, record, target)?
                };
                let path = normalized.relative_path;
                let absolute = normalized
                    .workspace_root
                    .as_ref()
                    .map(|root| root.join(&path));
                let metadata = absolute
                    .as_ref()
                    .and_then(|path| fs::symlink_metadata(path).ok());
                if operation.tool_id == "fs.rename" {
                    validate_rename_plan_target(
                        &path,
                        target_index,
                        metadata.as_ref(),
                        &template.usage_constraints,
                    )?;
                } else {
                    validate_plan_target(
                        &operation.tool_id,
                        &path,
                        metadata.as_ref(),
                        &template.usage_constraints,
                        template.resource.read_only,
                        planned_target_kinds.contains_key(&normalized_scope(&path)),
                    )?;
                }
                if operation.tool_id == "fs.delete" {
                    let kind = metadata
                        .as_ref()
                        .map(|value| if value.is_dir() { "directory" } else { "file" })
                        .or_else(|| {
                            planned_target_kinds
                                .get(&normalized_scope(&path))
                                .map(String::as_str)
                        })
                        .ok_or_else(|| {
                            KernelError::InvalidCommand(format!(
                                "fs.delete target does not exist: {path}"
                            ))
                        })?;
                    target_kind = Some(kind.to_string());
                    recursive = Some(kind == "directory");
                }
                normalized_targets.push(path);
            }
        } else {
            normalized_targets = operation.targets.clone();
        }
        let mut args_template = operation.args_template;
        if let Some(object) = args_template.as_object_mut() {
            if let Some(path) = normalized_targets.first() {
                object.insert("path".to_string(), Value::String(path.clone()));
            }
            if operation.tool_id == "fs.rename" {
                if let Some(destination) = normalized_targets.get(1) {
                    object.insert(
                        "destinationPath".to_string(),
                        Value::String(destination.clone()),
                    );
                }
            }
            if let Some(kind) = target_kind.as_ref() {
                object.insert("targetKind".to_string(), Value::String(kind.clone()));
            }
            if let Some(recursive) = recursive {
                object.insert("recursive".to_string(), Value::Bool(recursive));
            }
        }
        let read_set =
            replace_operation_targets(&operation.read_set, &operation.targets, &normalized_targets);
        let write_set = replace_operation_targets(
            &operation.write_set,
            &operation.targets,
            &normalized_targets,
        );
        let conflict_keys = read_set
            .iter()
            .chain(write_set.iter())
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        Ok(KernelPlanAuthorizationOperation {
            id: operation.id,
            source_task_id: operation.source_task_id,
            tool_id: operation.tool_id,
            operation_kind: template.operation_kind.unwrap_or("unknown").to_string(),
            content_mode: template.usage_constraints.content_mode.to_string(),
            targets: normalized_targets,
            depends_on: operation.depends_on,
            fixed_args: operation.fixed_args,
            args_template,
            target_kind,
            recursive,
            read_set,
            write_set,
            conflict_keys,
            execution_mode: execution_mode_name(operation.execution_mode).to_string(),
            internal: operation.internal,
            parent_operation_id: operation.parent_operation_id,
        })
    }

    fn planned_target_kinds(
        &self,
        record: &RuntimeRunRecord,
        operations: &[PlanAuthorizationOperationDraft],
    ) -> BTreeMap<String, String> {
        let mut kinds = BTreeMap::new();
        for operation in operations {
            let kind = match operation.tool_id.as_str() {
                "fs.create" => Some("file"),
                "fs.ensure_directory" => Some("directory"),
                _ => None,
            };
            let Some(kind) = kind else {
                continue;
            };
            for target in &operation.targets {
                if let Ok(normalized) = workspace_relative_write_path(self, record, target) {
                    kinds.insert(
                        normalized_scope(&normalized.relative_path),
                        kind.to_string(),
                    );
                }
            }
        }

        for _ in 0..operations.len() {
            let mut changed = false;
            for operation in operations
                .iter()
                .filter(|operation| operation.tool_id == "fs.rename")
            {
                let (Some(source), Some(destination)) =
                    (operation.targets.first(), operation.targets.get(1))
                else {
                    continue;
                };
                let (Ok(source), Ok(destination)) = (
                    workspace_relative_write_path(self, record, source),
                    workspace_relative_write_path(self, record, destination),
                ) else {
                    continue;
                };
                let source_scope = normalized_scope(&source.relative_path);
                let source_kind = source
                    .workspace_root
                    .as_ref()
                    .and_then(|root| fs::symlink_metadata(root.join(&source.relative_path)).ok())
                    .map(|metadata| {
                        if metadata.is_dir() {
                            "directory".to_string()
                        } else {
                            "file".to_string()
                        }
                    })
                    .or_else(|| kinds.get(&source_scope).cloned());
                let Some(source_kind) = source_kind else {
                    continue;
                };
                let destination_scope = normalized_scope(&destination.relative_path);
                if kinds.get(&destination_scope) != Some(&source_kind) {
                    kinds.insert(destination_scope, source_kind);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        kinds
    }
}
