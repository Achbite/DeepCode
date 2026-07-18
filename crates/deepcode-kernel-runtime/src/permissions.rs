use super::*;
use crate::action_batch::explicit_attachment_root;

mod recovery;

impl DeepCodeKernelRuntime {
    pub(crate) fn permission_resolve(
        &mut self,
        _request_id: RequestId,
        permission_id: String,
        decision: deepcode_kernel_abi::PermissionDecisionKind,
    ) -> KernelResult<Vec<KernelEvent>> {
        self.ensure_permission_restored(&permission_id)?;
        let pending = self
            .state
            .pending_tools
            .get(&permission_id)
            .cloned()
            .ok_or_else(|| {
                KernelError::PendingPermissionUnavailable(format!(
                    "permission {permission_id} has no live pending tool arguments; the request may have expired or the Kernel process may have restarted"
                ))
            })?;
        let session_id = pending.session_id.clone();
        let run_id = pending.run_id.clone();
        let record = self.record_by_run(&run_id)?;
        if record.lifecycle_state == RuntimeLifecycleState::Terminating {
            return Err(KernelError::Structured {
                code: "run_cleanup_pending",
                stage: "permission.resolve",
                message: "permission cannot be expanded while Kernel cleanup is pending"
                    .to_string(),
                details: serde_json::json!({ "runId": run_id, "permissionId": permission_id }),
            });
        }
        let resolution_fact = deepcode_kernel_abi::PermissionResolutionFact {
            permission_id: permission_id.clone(),
            decision: decision.clone(),
            reason: None,
            work_unit_context: permission_work_unit_context(&pending),
        };
        let grants = if decision == deepcode_kernel_abi::PermissionDecisionKind::Accept {
            let mut targets = pending
                .group_items
                .iter()
                .flat_map(|item| item.read_set.iter().chain(item.write_set.iter()))
                .chain(pending.read_set.iter().chain(pending.write_set.iter()))
                .cloned()
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .map(Some)
                .collect::<Vec<_>>();
            if targets.is_empty() {
                targets.push(None);
            }
            let operation_ids = if pending.affected_operation_ids.is_empty() {
                pending.action_id.iter().cloned().collect::<Vec<_>>()
            } else {
                pending.affected_operation_ids.clone()
            };
            let contract_id = pending
                .contract_id
                .clone()
                .unwrap_or_else(|| format!("runtime-permission-{permission_id}"));
            let capability = self.capability_for_tool(&pending.tool_id)?.to_string();
            targets
                .into_iter()
                .enumerate()
                .map(|(index, resource_path)| TemporaryGrantEnvelope {
                    id: format!("{permission_id}-{index}"),
                    contract_id: contract_id.clone(),
                    operation_ids: operation_ids.clone(),
                    capability: capability.clone(),
                    resource_kind: deepcode_kernel_abi::PermissionResourceKind::RuntimePermission,
                    resource_path,
                    expires_after_sequence: None,
                    reason: Some("Kernel runtime permission accepted by user".to_string()),
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        let mut checkpoint = self
            .state
            .batch_checkpoints_by_run
            .get(&run_id)
            .cloned()
            .ok_or_else(|| KernelError::Structured {
                code: "batch_checkpoint_unavailable",
                stage: "permission.resolve",
                message: format!("permission {permission_id} has no recoverable batch checkpoint"),
                details: serde_json::json!({
                    "runId": run_id,
                    "permissionId": permission_id,
                }),
            })?;
        checkpoint
            .permission_decisions
            .insert(permission_id.clone(), decision.clone());
        checkpoint.scheduler_revision += 1;
        let resolved_sequence = self.record_permission_resolution_with_grants(
            &run_id,
            &session_id,
            &grants,
            &resolution_fact,
            crate::action_batch::batch_checkpoint_payload(&checkpoint),
        )?;
        self.state
            .batch_checkpoints_by_run
            .insert(run_id.clone(), checkpoint);
        self.state.pending_tools.remove(&permission_id);
        let resolved_event = KernelEvent::PermissionResolved {
            run_id: Some(RunId(run_id.clone())),
            session_id: Some(SessionId(session_id.clone())),
            permission_id: permission_id.clone(),
            decision: decision.clone(),
            reason: None,
            sequence: Some(resolved_sequence),
        };

        let mut events = vec![resolved_event];
        if !self.has_pending_permission_for_run(&run_id) {
            events.extend(self.resume_batch_checkpoint(&run_id)?);
        }
        Ok(events)
    }

    pub(crate) fn reject_pending_permissions_for_run(
        &mut self,
        run_id: &str,
        session_id: &str,
        reason: &str,
    ) -> KernelResult<Vec<KernelEvent>> {
        let pending = self
            .state
            .pending_tools
            .iter()
            .filter(|(_, pending)| pending.run_id == run_id)
            .map(|(permission_id, pending)| (permission_id.clone(), pending.clone()))
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return Ok(Vec::new());
        }
        let mut checkpoint = self
            .state
            .batch_checkpoints_by_run
            .get(run_id)
            .cloned()
            .ok_or_else(|| KernelError::Structured {
                code: "batch_checkpoint_unavailable",
                stage: "run.cancel",
                message: "pending permissions have no recoverable batch checkpoint".to_string(),
                details: serde_json::json!({ "runId": run_id }),
            })?;
        let first_sequence = self.ledger.next_sequence(run_id)?;
        let mut ledger_events = Vec::with_capacity(pending.len() + 1);
        let mut kernel_events = Vec::with_capacity(pending.len());
        for (index, (permission_id, pending_tool)) in pending.iter().enumerate() {
            let fact = deepcode_kernel_abi::PermissionResolutionFact {
                permission_id: permission_id.clone(),
                decision: deepcode_kernel_abi::PermissionDecisionKind::Reject,
                reason: Some(reason.to_string()),
                work_unit_context: permission_work_unit_context(pending_tool),
            };
            let sequence = first_sequence + index as u64;
            ledger_events.push(LedgerEvent {
                id: format!("evt-{run_id}-{sequence}"),
                run_id: Some(run_id.to_string()),
                session_id: Some(session_id.to_string()),
                kind: "permission.resolved".to_string(),
                sequence: Some(sequence),
                payload: serde_json::to_value(&fact).map_err(|error| {
                    KernelError::InvalidCommand(format!(
                        "encode cancelled permission resolution: {error}"
                    ))
                })?,
                created_at: None,
            });
            checkpoint.permission_decisions.insert(
                permission_id.clone(),
                deepcode_kernel_abi::PermissionDecisionKind::Reject,
            );
            kernel_events.push(KernelEvent::PermissionResolved {
                run_id: Some(RunId(run_id.to_string())),
                session_id: Some(SessionId(session_id.to_string())),
                permission_id: permission_id.clone(),
                decision: deepcode_kernel_abi::PermissionDecisionKind::Reject,
                reason: Some(reason.to_string()),
                sequence: Some(sequence),
            });
        }
        checkpoint.scheduler_revision = checkpoint
            .scheduler_revision
            .saturating_add(pending.len() as u64);
        let checkpoint_sequence = first_sequence + pending.len() as u64;
        ledger_events.push(LedgerEvent {
            id: format!("evt-{run_id}-{checkpoint_sequence}"),
            run_id: Some(run_id.to_string()),
            session_id: Some(session_id.to_string()),
            kind: "batch.runtime_checkpoint".to_string(),
            sequence: Some(checkpoint_sequence),
            payload: crate::action_batch::batch_checkpoint_payload(&checkpoint),
            created_at: None,
        });
        self.append_ledger_batch(ledger_events)?;
        self.state
            .batch_checkpoints_by_run
            .insert(run_id.to_string(), checkpoint);
        for (permission_id, _) in pending {
            self.state.pending_tools.remove(&permission_id);
        }
        Ok(kernel_events)
    }

    pub(crate) fn effective_permission_action_for_tool(
        &self,
        run_id: &str,
        tool_id: &str,
        arguments: &Value,
    ) -> KernelResult<PermissionAction> {
        let operation_kind = self
            .tool_registry
            .get(tool_id)
            .map(KernelToolRegistration::operation_kind)
            .ok_or_else(|| KernelError::InvalidCommand(format!("unknown Kernel tool {tool_id}")))?;
        let base =
            web_permission_mode_for_tool_args(&self.tool_runtime_config, operation_kind, arguments)
                .map(|mode| match mode {
                    ToolPermissionMode::Allow => PermissionAction::Allow,
                    ToolPermissionMode::Ask => PermissionAction::Ask,
                    ToolPermissionMode::Deny => PermissionAction::Deny,
                })
                .unwrap_or_else(|| self.permission_action_for_kernel_tool(tool_id));
        if base != PermissionAction::Ask {
            return Ok(base);
        }
        if self.temporary_grant_allows(run_id, tool_id, arguments)? {
            return Ok(PermissionAction::Allow);
        }
        Ok(base)
    }

    pub(crate) fn has_pending_permission_for_run(&self, run_id: &str) -> bool {
        self.state
            .pending_tools
            .values()
            .any(|pending| pending.run_id == run_id)
    }

    fn temporary_grant_allows(
        &self,
        run_id: &str,
        tool_id: &str,
        arguments: &Value,
    ) -> KernelResult<bool> {
        let grants = self.active_temporary_grants(run_id);
        let registration = self.tool_registry.get(tool_id).ok_or_else(|| {
            KernelError::InvalidCommand(format!("unregistered Kernel tool: {tool_id}"))
        })?;
        let capability = registration.capability();
        let operation_kind = registration.operation_kind();
        let next_sequence = self.ledger.next_sequence(run_id)?;
        for grant in &grants {
            if grant.capability != capability {
                continue;
            }
            if grant
                .expires_after_sequence
                .map(|expires| next_sequence > expires)
                .unwrap_or(false)
            {
                continue;
            }
            let matches_resource = match grant.resource_path.as_deref() {
                Some(path) => {
                    argument_resource_matches(operation_kind, arguments, path)
                        || self.grant_scope_contains_argument(run_id, tool_id, arguments, path)?
                }
                None => unscoped_grant_allows_arguments(&grant.resource_kind, arguments),
            };
            if matches_resource {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn grant_scope_contains_argument(
        &self,
        run_id: &str,
        tool_id: &str,
        arguments: &Value,
        grant_path: &str,
    ) -> KernelResult<bool> {
        let operation_kind = self
            .tool_registry
            .get(tool_id)
            .map(KernelToolRegistration::operation_kind)
            .ok_or_else(|| {
                KernelError::InvalidCommand(format!("unregistered Kernel tool: {tool_id}"))
            })?;
        if !matches!(
            operation_kind,
            ToolOperationKind::FsWrite
                | ToolOperationKind::FsEdit
                | ToolOperationKind::FsDelete
                | ToolOperationKind::FsRead
                | ToolOperationKind::FsList
                | ToolOperationKind::CodeGrep
                | ToolOperationKind::FsDiff
        ) {
            return Ok(false);
        }
        let Some(raw_argument_path) = arguments
            .get("path")
            .or_else(|| arguments.get("include"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Ok(false);
        };
        let grant_display = grant_path.trim().replace('\\', "/");
        let argument_display = raw_argument_path.replace('\\', "/");
        if !grant_display.is_empty()
            && (argument_display == grant_display
                || argument_display.starts_with(&format!("{grant_display}/")))
        {
            return Ok(true);
        }
        if let Some(path_normalization) = arguments.get("pathNormalization") {
            if let Some(original_path) = path_normalization
                .get("originalPath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let original_display = original_path.replace('\\', "/");
                if original_display == grant_display
                    || original_display.starts_with(&format!("{grant_display}/"))
                {
                    return Ok(true);
                }
            }
            if let Some(prefixes) = path_normalization
                .get("strippedPathPrefixes")
                .and_then(Value::as_array)
            {
                for prefix in prefixes.iter().filter_map(Value::as_str) {
                    let prefix = prefix.trim();
                    if prefix.is_empty() {
                        continue;
                    }
                    let candidate = PathBuf::from(prefix).join(raw_argument_path);
                    let candidate = candidate.canonicalize().unwrap_or(candidate);
                    let grant_candidate = grant_path.trim();
                    let grant_path_buf = PathBuf::from(grant_candidate);
                    let grant_path_buf = grant_path_buf.canonicalize().unwrap_or(grant_path_buf);
                    if candidate == grant_path_buf || candidate.starts_with(&grant_path_buf) {
                        return Ok(true);
                    }
                }
            }
        }
        let grant_path = PathBuf::from(grant_path);
        let grant_path = grant_path.canonicalize().unwrap_or(grant_path);
        let argument_path = PathBuf::from(raw_argument_path);
        if argument_path.is_absolute() {
            let argument_path = argument_path.canonicalize().unwrap_or(argument_path);
            return Ok(argument_path == grant_path || argument_path.starts_with(&grant_path));
        }
        let record = self.record_by_run(run_id)?;
        let mut roots = Vec::new();
        if let Some(open_path) = record.workspace_binding.open_path.as_ref() {
            roots.push(PathBuf::from(open_path));
        }
        for attachment in &record.attachments {
            if let Some(root) = explicit_attachment_root(attachment) {
                roots.push(root);
            }
        }
        Ok(roots.into_iter().any(|root| {
            let root = root.canonicalize().unwrap_or(root);
            let target = root.join(raw_argument_path);
            let target = target.canonicalize().unwrap_or(target);
            target == grant_path || target.starts_with(&grant_path)
        }))
    }
}

fn permission_work_unit_context(
    pending: &PendingKernelTool,
) -> deepcode_kernel_abi::PermissionWorkUnitContext {
    let group_items = pending
        .group_items
        .iter()
        .map(|item| deepcode_kernel_abi::PermissionWorkUnitContextItem {
            action_id: item.action_id.clone(),
            plan_id: item.plan_id.clone(),
            work_unit_id: item.work_unit_id.clone(),
            tool_id: item.tool_id.clone(),
            operation_kind: item.operation_kind,
            read_set: item.read_set.clone(),
            write_set: item.write_set.clone(),
        })
        .collect();
    deepcode_kernel_abi::PermissionWorkUnitContext {
        action_id: pending.action_id.clone(),
        plan_id: pending.plan_id.clone(),
        permission_bundle_id: pending.permission_bundle_id.clone(),
        contract_id: pending.contract_id.clone(),
        affected_operation_ids: pending.affected_operation_ids.clone(),
        work_unit_ids: pending.work_unit_ids.clone(),
        group_items,
        operation_kind: pending.operation_kind,
        read_set: pending.read_set.clone(),
        write_set: pending.write_set.clone(),
    }
}

pub(crate) fn permission_envelope_from_pending(
    runtime: &DeepCodeKernelRuntime,
    permission_id: &str,
    pending: &PendingKernelTool,
) -> KernelResult<deepcode_kernel_abi::PermissionRequestEnvelope> {
    let grouped_work_unit_ids = pending
        .group_items
        .iter()
        .filter_map(|item| item.work_unit_id.clone())
        .collect::<Vec<_>>();
    Ok(deepcode_kernel_abi::PermissionRequestEnvelope {
        id: permission_id.to_string(),
        request_kind: deepcode_kernel_abi::PermissionRequestKind::RuntimePermission,
        permission_bundle_id: pending.permission_bundle_id.clone(),
        contract_id: pending.contract_id.clone(),
        affected_operation_ids: pending.affected_operation_ids.clone(),
        work_unit_ids: if pending.work_unit_ids.is_empty() {
            if grouped_work_unit_ids.is_empty() {
                pending.work_unit_id.iter().cloned().collect::<Vec<_>>()
            } else {
                grouped_work_unit_ids
            }
        } else {
            pending.work_unit_ids.clone()
        },
        tool_id: Some(pending.tool_id.clone()),
        capability: runtime.capability_for_tool(&pending.tool_id)?.to_string(),
        risk_level: runtime.risk_for_tool(&pending.tool_id)?,
        summary: format!("Allow {} to access workspace resources?", pending.tool_id),
        args_preview: redact_tool_arguments(pending.operation_kind, &pending.arguments),
    })
}

fn argument_resource_matches(
    operation_kind: ToolOperationKind,
    arguments: &Value,
    path: &str,
) -> bool {
    if let Some(expected) = path.strip_prefix("network:") {
        return arguments
            .get("url")
            .or_else(|| arguments.get("query"))
            .and_then(Value::as_str)
            == Some(expected);
    }
    if let Some(expected) = path.strip_prefix("git:") {
        if matches!(expected, "workspace" | "index") {
            return matches!(
                operation_kind,
                ToolOperationKind::GitStatus
                    | ToolOperationKind::GitDiff
                    | ToolOperationKind::GitStage
                    | ToolOperationKind::GitUnstage
                    | ToolOperationKind::GitCommit
                    | ToolOperationKind::GitPush
            );
        }
        return arguments
            .get("paths")
            .and_then(Value::as_array)
            .map(|items| items.iter().any(|item| item.as_str() == Some(expected)))
            .unwrap_or(false)
            || arguments.get("path").and_then(Value::as_str) == Some(expected);
    }
    let direct = arguments
        .get("path")
        .or_else(|| arguments.get("url"))
        .and_then(Value::as_str)
        .map(|value| value == path)
        .unwrap_or(false);
    if direct {
        return true;
    }
    if matches!(
        operation_kind,
        ToolOperationKind::GitStage | ToolOperationKind::GitUnstage
    ) {
        return arguments
            .get("paths")
            .and_then(Value::as_array)
            .map(|items| items.iter().any(|item| item.as_str() == Some(path)))
            .unwrap_or(false);
    }
    false
}

fn unscoped_grant_allows_arguments(
    resource_kind: &deepcode_kernel_abi::PermissionResourceKind,
    arguments: &Value,
) -> bool {
    match resource_kind {
        deepcode_kernel_abi::PermissionResourceKind::WorkspacePath => {
            !argument_uses_external_absolute_file(arguments)
        }
        deepcode_kernel_abi::PermissionResourceKind::GitWorkspace
        | deepcode_kernel_abi::PermissionResourceKind::Process
        | deepcode_kernel_abi::PermissionResourceKind::NetworkTarget
        | deepcode_kernel_abi::PermissionResourceKind::BrowserState
        | deepcode_kernel_abi::PermissionResourceKind::ProviderProfile
        | deepcode_kernel_abi::PermissionResourceKind::RuntimePermission => true,
    }
}

fn argument_uses_external_absolute_file(arguments: &Value) -> bool {
    arguments
        .get("pathNormalization")
        .and_then(|value| value.get("rootSource"))
        .and_then(Value::as_str)
        == Some("absolutePath")
}
