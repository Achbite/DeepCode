use super::*;
use crate::action_batch::explicit_attachment_root;

mod recovery;

impl DeepCodeKernelRuntime {
    pub(crate) fn permission_resolve(
        &mut self,
        request_id: RequestId,
        permission_id: String,
        decision: deepcode_kernel_abi::PermissionDecisionKind,
    ) -> KernelResult<Vec<KernelEvent>> {
        self.ensure_permission_restored(&permission_id)?;
        let pending = self
            .state
            .pending_tools
            .remove(&permission_id)
            .ok_or_else(|| {
                KernelError::PendingPermissionUnavailable(format!(
                    "permission {permission_id} has no live pending tool arguments; the request may have expired or the Kernel process may have restarted"
                ))
            })?;
        let session_id = pending.session_id.clone();
        let run_id = pending.run_id.clone();
        self.record_by_run(&run_id)?;
        let resolved_sequence = self.ledger.next_sequence(&run_id)?;
        let resolved_event = KernelEvent::PermissionResolved {
            run_id: Some(RunId(run_id.clone())),
            session_id: Some(SessionId(session_id.clone())),
            permission_id: permission_id.clone(),
            decision: decision.clone(),
            reason: None,
            sequence: Some(resolved_sequence),
        };

        let group_item_context = pending
            .group_items
            .iter()
            .map(|item| {
                serde_json::json!({
                    "actionId": item.action_id.as_deref(),
                    "planId": item.plan_id.as_deref(),
                    "workUnitId": item.work_unit_id.as_deref(),
                    "toolName": &item.tool_name,
                    "operationKind": item.operation_kind.as_deref(),
                    "readSet": &item.read_set,
                    "writeSet": &item.write_set
                })
            })
            .collect::<Vec<_>>();
        let work_unit_context = serde_json::json!({
            "actionId": pending.action_id.as_deref(),
            "planId": pending.plan_id.as_deref(),
            "permissionBundleId": pending.permission_bundle_id.as_deref(),
            "contractId": pending.contract_id.as_deref(),
            "affectedOperationIds": &pending.affected_operation_ids,
            "workUnitIds": &pending.work_unit_ids,
            "groupItemCount": pending.group_items.len(),
            "groupItems": group_item_context,
            "operationKind": pending.operation_kind.as_deref(),
            "readSet": &pending.read_set,
            "writeSet": &pending.write_set
        });
        self.append_ledger(
            &run_id,
            &session_id,
            "permission.resolved",
            resolved_sequence,
            serde_json::json!({
                "summary": "Permission resolved by Kernel command.",
                "permissionId": &permission_id,
                "decision": &decision,
                "workUnitContext": work_unit_context
            }),
        )?;

        if decision == deepcode_kernel_abi::PermissionDecisionKind::Accept {
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
            let capability = capability_for_tool(&pending.tool_name)?.to_string();
            let grants = targets
                .into_iter()
                .enumerate()
                .map(|(index, resource_path)| TemporaryGrantEnvelope {
                    id: format!("{permission_id}-{index}"),
                    contract_id: contract_id.clone(),
                    operation_ids: operation_ids.clone(),
                    capability: capability.clone(),
                    resource_kind: "runtimePermission".to_string(),
                    resource_path,
                    expires_after_sequence: None,
                    reason: Some("Kernel runtime permission accepted by user".to_string()),
                })
                .collect::<Vec<_>>();
            self.register_temporary_grants(&run_id, &session_id, grants)?;
        }

        let mut events = vec![resolved_event];
        if decision == deepcode_kernel_abi::PermissionDecisionKind::Accept {
            if let Some(event) = self.transition_runtime_lifecycle(
                Some(request_id.clone()),
                &run_id,
                &session_id,
                RuntimeLifecycleState::Executing,
                "permissionAccepted",
            )? {
                events.push(event);
            }
        }
        let group_items = pending_group_items(&permission_id, &pending);
        if group_items.iter().any(|item| item.work_unit_id.is_some()) {
            match decision {
                deepcode_kernel_abi::PermissionDecisionKind::Reject => {
                    for item in &group_items {
                        let Some(work_unit_id) = item.work_unit_id.as_deref() else {
                            continue;
                        };
                        let item_request_id = item
                            .request_id
                            .as_ref()
                            .map(|value| RequestId(value.clone()))
                            .unwrap_or_else(|| request_id.clone());
                        events.push(self.work_unit_blocked_event(
                            &item_request_id,
                            &run_id,
                            &session_id,
                            work_unit_id,
                            "permission rejected by user",
                        )?);
                    }
                }
                deepcode_kernel_abi::PermissionDecisionKind::Accept => {
                    for item in &group_items {
                        let Some(work_unit_id) = item.work_unit_id.as_deref() else {
                            continue;
                        };
                        let item_request_id = item
                            .request_id
                            .as_ref()
                            .map(|value| RequestId(value.clone()))
                            .unwrap_or_else(|| request_id.clone());
                        if KernelToolRegistry::default()
                            .get(&item.tool_name)
                            .map(|descriptor| descriptor.execution_mode)
                            == Some(OperationExecutionMode::Blocked)
                        {
                            events.push(self.work_unit_blocked_event(
                                &item_request_id,
                                &run_id,
                                &session_id,
                                work_unit_id,
                                "permission accepted but the tool is blocked by Kernel policy",
                            )?);
                            continue;
                        }
                        let tool_event = self.execute_bound_tool(
                            &run_id,
                            &session_id,
                            item.tool_call_id.clone(),
                            item.tool_name.clone(),
                            item.arguments.clone(),
                        )?;
                        let tool_ok =
                            matches!(&tool_event, KernelEvent::ToolCompleted { ok: true, .. });
                        let tool_error = match &tool_event {
                            KernelEvent::ToolCompleted {
                                error: Some(error), ..
                            } => Some(error.clone()),
                            _ => None,
                        };
                        let tool_output = match &tool_event {
                            KernelEvent::ToolCompleted { output, .. } => output.clone(),
                            _ => None,
                        };
                        events.push(tool_event);
                        if tool_ok {
                            events.push(self.work_unit_completed_event(
                                &item_request_id,
                                &run_id,
                                &session_id,
                                work_unit_id,
                                tool_output,
                            )?);
                        } else {
                            let error = tool_error.unwrap_or_else(|| KernelErrorEnvelope {
                                code: "tool_execution_failed".to_string(),
                                message: format!(
                                    "{} did not produce a successful tool result",
                                    item.tool_name
                                ),
                                message_key: None,
                                args: None,
                            });
                            events.push(self.work_unit_failed_envelope_event(
                                &item_request_id,
                                &run_id,
                                &session_id,
                                work_unit_id,
                                error,
                            )?);
                        }
                    }
                }
            }
            if !self.has_pending_permission_for_run(&run_id) {
                self.append_batch_review_ready_events(
                    &mut events,
                    &request_id,
                    &run_id,
                    &session_id,
                    pending.contract_id.as_deref().unwrap_or_default(),
                )?;
            }
            return Ok(events);
        }

        if decision == deepcode_kernel_abi::PermissionDecisionKind::Accept {
            let completed = self.execute_bound_tool(
                &run_id,
                &session_id,
                permission_id,
                pending.tool_name,
                pending.arguments,
            )?;
            events.push(completed);
        }

        if let Some(event) = self.transition_runtime_lifecycle(
            Some(request_id),
            &run_id,
            &session_id,
            RuntimeLifecycleState::Ready,
            "permissionResolvedWithoutWorkUnit",
        )? {
            events.push(event);
        }
        Ok(events)
    }

    pub(crate) fn effective_permission_action_for_tool(
        &self,
        run_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> KernelResult<PermissionAction> {
        let base =
            web_permission_mode_for_tool_args(&self.tool_runtime_config, tool_name, arguments)
                .map(|mode| match mode {
                    ToolPermissionMode::Allow => PermissionAction::Allow,
                    ToolPermissionMode::Ask => PermissionAction::Ask,
                    ToolPermissionMode::Deny => PermissionAction::Deny,
                })
                .unwrap_or_else(|| permission_action_for_kernel_tool(tool_name));
        if base != PermissionAction::Ask {
            return Ok(base);
        }
        if self.temporary_grant_allows(run_id, tool_name, arguments)? {
            return Ok(PermissionAction::Allow);
        }
        Ok(base)
    }

    fn has_pending_permission_for_run(&self, run_id: &str) -> bool {
        self.state
            .pending_tools
            .values()
            .any(|pending| pending.run_id == run_id)
    }

    fn temporary_grant_allows(
        &self,
        run_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> KernelResult<bool> {
        let grants = self.active_temporary_grants(run_id);
        let capability = capability_for_tool(tool_name)?;
        let next_sequence = self.ledger.next_sequence(run_id).unwrap_or(u64::MAX);
        Ok(grants.iter().any(|grant| {
            if grant.capability != capability {
                return false;
            }
            if grant
                .expires_after_sequence
                .map(|expires| next_sequence > expires)
                .unwrap_or(false)
            {
                return false;
            }
            if matches!(
                grant.resource_kind.as_str(),
                "workspaceModule" | "workspaceDependency"
            ) {
                if !matches!(capability, "fs.write" | "fs.edit") {
                    return false;
                }
                return grant
                    .resource_path
                    .as_deref()
                    .map(|path| {
                        self.grant_scope_contains_argument(run_id, tool_name, arguments, path)
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
            }
            grant
                .resource_path
                .as_deref()
                .map(|path| {
                    argument_resource_matches(tool_name, arguments, path)
                        || self
                            .grant_scope_contains_argument(run_id, tool_name, arguments, path)
                            .unwrap_or(false)
                })
                .unwrap_or_else(|| unscoped_grant_allows_arguments(&grant.resource_kind, arguments))
        }))
    }

    fn grant_scope_contains_argument(
        &self,
        run_id: &str,
        tool_name: &str,
        arguments: &Value,
        grant_path: &str,
    ) -> KernelResult<bool> {
        if !matches!(
            tool_name,
            "fs.write" | "fs.edit" | "fs.delete" | "fs.read" | "fs.list" | "code.grep" | "fs.diff"
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

pub(crate) fn permission_envelope_from_pending(
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
        tool_id: Some(pending.tool_name.clone()),
        capability: capability_for_tool(&pending.tool_name)?.to_string(),
        risk_level: risk_for_tool(&pending.tool_name)?.to_string(),
        summary: format!("Allow {} to access workspace resources?", pending.tool_name),
        args_preview: redact_tool_arguments(&pending.tool_name, &pending.arguments),
    })
}

fn pending_group_items(
    permission_id: &str,
    pending: &PendingKernelTool,
) -> Vec<PendingKernelToolItem> {
    if !pending.group_items.is_empty() {
        return pending.group_items.clone();
    }
    vec![PendingKernelToolItem {
        tool_call_id: permission_id.to_string(),
        tool_name: pending.tool_name.clone(),
        arguments: pending.arguments.clone(),
        request_id: pending.request_id.clone(),
        work_unit_id: pending.work_unit_id.clone(),
        action_id: pending.action_id.clone(),
        plan_id: pending.plan_id.clone(),
        operation_kind: pending.operation_kind.clone(),
        read_set: pending.read_set.clone(),
        write_set: pending.write_set.clone(),
    }]
}

fn argument_resource_matches(tool_name: &str, arguments: &Value, path: &str) -> bool {
    if let Some(expected) = path.strip_prefix("network:") {
        return arguments
            .get("url")
            .or_else(|| arguments.get("query"))
            .and_then(Value::as_str)
            == Some(expected);
    }
    if let Some(expected) = path.strip_prefix("git:") {
        if matches!(expected, "workspace" | "index") {
            return tool_name.starts_with("git.");
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
    if matches!(tool_name, "git.stage" | "git.unstage") {
        return arguments
            .get("paths")
            .and_then(Value::as_array)
            .map(|items| items.iter().any(|item| item.as_str() == Some(path)))
            .unwrap_or(false);
    }
    false
}

fn unscoped_grant_allows_arguments(resource_kind: &str, arguments: &Value) -> bool {
    match resource_kind {
        "workspace" | "workspaceFile" => !argument_uses_external_absolute_file(arguments),
        "workspaceModule" | "workspaceDependency" | "workspaceDirectory" => false,
        "externalFile" | "externalDirectory" => false,
        _ => true,
    }
}

fn argument_uses_external_absolute_file(arguments: &Value) -> bool {
    arguments
        .get("pathNormalization")
        .and_then(|value| value.get("rootSource"))
        .and_then(Value::as_str)
        == Some("absolutePath")
}
