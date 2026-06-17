use super::*;
use crate::action_batch::explicit_attachment_root;

impl DeepCodeKernelRuntime {
    pub(crate) fn pending_permission_for_run(
        &self,
        run_id: &str,
    ) -> KernelResult<Option<deepcode_kernel_abi::PermissionRequestEnvelope>> {
        if let Some((permission_id, pending)) = self
            .state
            .pending_tools
            .iter()
            .find(|(_, pending)| pending.run_id == run_id)
        {
            return Ok(Some(permission_envelope_from_pending(
                permission_id,
                pending,
            )));
        }
        let events = self.ledger.list_by_run(run_id)?;
        let resolved = events
            .iter()
            .filter(|event| event.kind == "permission.resolved")
            .filter_map(|event| event.payload.get("permissionId").and_then(Value::as_str))
            .collect::<std::collections::BTreeSet<_>>();
        let pending = events
            .iter()
            .rev()
            .find(|event| {
                event.kind == "permission.requested"
                    && event
                        .payload
                        .get("permissionId")
                        .and_then(Value::as_str)
                        .map(|id| !resolved.contains(id))
                        .unwrap_or(false)
            })
            .and_then(|event| {
                let permission_id = event.payload.get("permissionId")?.as_str()?;
                Some(deepcode_kernel_abi::PermissionRequestEnvelope {
                    id: permission_id.to_string(),
                    capability: event
                        .payload
                        .get("capability")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| {
                            event
                                .payload
                                .get("toolName")
                                .and_then(Value::as_str)
                                .map(capability_for_tool)
                                .unwrap_or("workspace.write")
                        })
                        .to_string(),
                    risk_level: event
                        .payload
                        .get("riskLevel")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| {
                            event
                                .payload
                                .get("toolName")
                                .and_then(Value::as_str)
                                .map(risk_for_tool)
                                .unwrap_or("high")
                        })
                        .to_string(),
                    summary: event
                        .payload
                        .get("summary")
                        .and_then(Value::as_str)
                        .unwrap_or("Permission requested by Kernel.")
                        .to_string(),
                    args_preview: event
                        .payload
                        .get("argsPreview")
                        .cloned()
                        .unwrap_or(Value::Null),
                })
            });
        Ok(pending)
    }

    pub(crate) fn ensure_permission_restored(&mut self, permission_id: &str) -> KernelResult<()> {
        if self.state.pending_tools.contains_key(permission_id) {
            return Ok(());
        }
        let events = self.ledger.list_all()?;
        let already_resolved = events.iter().any(|event| {
            event.kind == "permission.resolved"
                && event.payload.get("permissionId").and_then(Value::as_str) == Some(permission_id)
        });
        if already_resolved {
            return Ok(());
        }
        let Some(requested) = events.iter().rev().find(|event| {
            event.kind == "permission.requested"
                && event.payload.get("permissionId").and_then(Value::as_str) == Some(permission_id)
        }) else {
            return Ok(());
        };
        let Some(run_id) = requested.run_id.clone() else {
            return Ok(());
        };
        let Some(session_id) = requested.session_id.clone() else {
            return Ok(());
        };
        self.ensure_session_restored(&session_id)?;
        if let Some((restored_id, pending)) = self.pending_tool_from_ledger(&run_id)? {
            if restored_id == permission_id {
                self.state.pending_tools.insert(restored_id, pending);
            }
        }
        Ok(())
    }

    pub(crate) fn pending_tool_from_ledger(
        &self,
        run_id: &str,
    ) -> KernelResult<Option<(String, PendingKernelTool)>> {
        let events = self.ledger.list_by_run(run_id)?;
        let resolved = events
            .iter()
            .filter(|event| event.kind == "permission.resolved")
            .filter_map(|event| event.payload.get("permissionId").and_then(Value::as_str))
            .collect::<std::collections::BTreeSet<_>>();
        let pending = events
            .iter()
            .rev()
            .find(|event| {
                event.kind == "permission.requested"
                    && event
                        .payload
                        .get("permissionId")
                        .and_then(Value::as_str)
                        .map(|id| !resolved.contains(id))
                        .unwrap_or(false)
            })
            .and_then(|event| {
                let permission_id = event.payload.get("permissionId")?.as_str()?.to_string();
                let session_id = event.session_id.clone()?;
                let tool_name = event.payload.get("toolName")?.as_str()?.to_string();
                let arguments = event
                    .payload
                    .get("arguments")
                    .cloned()
                    .or_else(|| event.payload.get("args").cloned())?;
                Some((
                    permission_id,
                    PendingKernelTool {
                        run_id: run_id.to_string(),
                        session_id,
                        tool_name,
                        arguments,
                        request_id: event
                            .payload
                            .get("requestId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        work_unit_id: event
                            .payload
                            .get("workUnitId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        action_id: event
                            .payload
                            .get("actionId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        plan_id: event
                            .payload
                            .get("planId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        operation_kind: event
                            .payload
                            .get("operationKind")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        read_set: event
                            .payload
                            .get("readSet")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect(),
                        write_set: event
                            .payload
                            .get("writeSet")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect(),
                    },
                ))
            });
        Ok(pending)
    }

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
        let phase = self
            .state
            .records_by_session
            .get(&session_id)
            .map(|record| record.phase.as_str().to_string())
            .ok_or_else(|| KernelError::InvalidCommand("missing run record".to_string()))?;
        let resolved_sequence = self.ledger.next_sequence(&run_id)?;
        let resolved_event = KernelEvent::PermissionResolved {
            run_id: Some(RunId(run_id.clone())),
            session_id: Some(SessionId(session_id.clone())),
            permission_id: permission_id.clone(),
            decision: decision.clone(),
            reason: None,
            sequence: Some(resolved_sequence),
        };

        {
            let record = self
                .state
                .records_by_session
                .get_mut(&session_id)
                .ok_or_else(|| KernelError::InvalidCommand("missing run record".to_string()))?;
            let resolved_phase = record.phase.as_str().to_string();
            record
                .decision_state
                .apply_event(&resolved_event, &resolved_phase);
        }

        let work_unit_context = serde_json::json!({
            "actionId": pending.action_id.as_deref(),
            "planId": pending.plan_id.as_deref(),
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

        let mut events = vec![resolved_event];
        let work_unit_request_id = pending
            .request_id
            .as_ref()
            .map(|value| RequestId(value.clone()))
            .unwrap_or_else(|| request_id.clone());

        if let Some(work_unit_id) = pending.work_unit_id.clone() {
            match decision {
                deepcode_kernel_abi::PermissionDecisionKind::Reject => {
                    events.push(self.work_unit_blocked_event(
                        &work_unit_request_id,
                        &run_id,
                        &session_id,
                        &work_unit_id,
                        "permission rejected by user",
                    )?);
                }
                deepcode_kernel_abi::PermissionDecisionKind::Accept => {
                    let tool_event = self.execute_bound_tool(
                        &run_id,
                        &session_id,
                        permission_id.clone(),
                        pending.tool_name.clone(),
                        pending.arguments.clone(),
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
                            &work_unit_request_id,
                            &run_id,
                            &session_id,
                            &work_unit_id,
                            tool_output,
                        )?);
                    } else {
                        let error = tool_error.unwrap_or_else(|| KernelErrorEnvelope {
                            code: "tool_execution_failed".to_string(),
                            message: format!(
                                "{} did not produce a successful tool result",
                                pending.tool_name
                            ),
                            message_key: None,
                            args: None,
                        });
                        events.push(self.work_unit_failed_envelope_event(
                            &work_unit_request_id,
                            &run_id,
                            &session_id,
                            &work_unit_id,
                            error,
                        )?);
                    }
                }
            }
            if !self.has_pending_permission_for_run(&run_id) {
                events.push(self.enter_phase_event(&run_id, &session_id, WorkflowPhase::Review)?);
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

        let workflow_decision = {
            let record = self
                .state
                .records_by_session
                .get(&session_id)
                .ok_or_else(|| KernelError::InvalidCommand("missing run record".to_string()))?;
            record.decision_state.decide(&phase)
        };
        let workflow_sequence = self.ledger.next_sequence(&run_id)?;
        self.append_ledger(
            &run_id,
            &session_id,
            "workflow.decision_made",
            workflow_sequence,
            serde_json::json!({
                "summary": workflow_decision.summary,
                "observedKind": "permission.resolved",
                "observedSequence": resolved_sequence,
                "decision": workflow_decision
            }),
        )?;

        events.push(KernelEvent::WorkflowDecisionMade {
            request_id: Some(request_id),
            run_id: RunId(run_id),
            session_id: Some(SessionId(session_id)),
            decision: workflow_decision.clone(),
            sequence: Some(workflow_sequence),
        });
        Ok(events)
    }

    pub(crate) fn permission_grant_temporary(
        &mut self,
        _request_id: RequestId,
        run_id: RunId,
        grant: deepcode_kernel_abi::TemporaryGrantEnvelope,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?;
        let record_run_id = record.run_id.clone();
        let session_id = record.session_id.clone();
        self.state
            .temporary_grants_by_run
            .entry(run_id.0.clone())
            .or_default()
            .push(grant.clone());
        let sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &session_id,
            "temporaryGrant.created",
            sequence,
            serde_json::json!({
                "summary": "Temporary permission grant recorded.",
                "grant": grant
            }),
        )?;
        let autonomy_sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &session_id,
            "autonomy.transitioned",
            autonomy_sequence,
            serde_json::json!({
                "summary": "Temporary grant changed the effective capability set for this run.",
                "fromLevel": autonomy_level_name(&self.policy_profile.autonomy_level),
                "toLevel": autonomy_level_name(&self.policy_profile.autonomy_level),
                "capabilitySet": [&grant.capability]
            }),
        )?;
        Ok(vec![
            KernelEvent::MessageAppended {
                run_id: Some(run_id),
                session_id: Some(SessionId(session_id.clone())),
                turn_id: None,
                role: deepcode_kernel_abi::MessageRole::System,
                channel: Some("policy".to_string()),
                content: None,
                message_key: Some("permission.temporaryGrant.created".to_string()),
                args: None,
                sequence: Some(sequence),
            },
            KernelEvent::AutonomyTransitioned {
                run_id: Some(RunId(record_run_id)),
                session_id: Some(SessionId(session_id)),
                from_level: Some(
                    autonomy_level_name(&self.policy_profile.autonomy_level).to_string(),
                ),
                to_level: autonomy_level_name(&self.policy_profile.autonomy_level).to_string(),
                capability_set: vec![grant.capability],
                reason: Some("temporary grant recorded".to_string()),
                sequence: Some(autonomy_sequence),
            },
        ])
    }

    pub(crate) fn effective_permission_action_for_tool(
        &self,
        run_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> KernelResult<PermissionAction> {
        let base = permission_action_for_kernel_tool(tool_name);
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
        let Some(grants) = self.state.temporary_grants_by_run.get(run_id) else {
            return Ok(false);
        };
        let capability = capability_for_tool(tool_name);
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
            grant
                .resource_path
                .as_deref()
                .map(|path| {
                    argument_resource_matches(tool_name, arguments, path)
                        || self
                            .grant_scope_contains_argument(run_id, tool_name, arguments, path)
                            .unwrap_or(false)
                })
                .unwrap_or(true)
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
            "fs.write"
                | "fs.patch"
                | "fs.delete"
                | "fs.read"
                | "fs.list"
                | "code.search"
                | "fs.diff"
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
        let grant_path = PathBuf::from(grant_path);
        let grant_path = grant_path.canonicalize().unwrap_or(grant_path);
        let argument_path = PathBuf::from(raw_argument_path);
        if argument_path.is_absolute() {
            let argument_path = argument_path.canonicalize().unwrap_or(argument_path);
            return Ok(argument_path == grant_path || argument_path.starts_with(&grant_path));
        }
        let record = self.record_by_run(run_id)?;
        let mut roots = Vec::new();
        if let Some(root) = self
            .state
            .current_workspace
            .as_ref()
            .map(|workspace| workspace.root.clone())
        {
            roots.push(root);
        }
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
) -> deepcode_kernel_abi::PermissionRequestEnvelope {
    deepcode_kernel_abi::PermissionRequestEnvelope {
        id: permission_id.to_string(),
        capability: capability_for_tool(&pending.tool_name).to_string(),
        risk_level: risk_for_tool(&pending.tool_name).to_string(),
        summary: format!("Allow {} to access workspace resources?", pending.tool_name),
        args_preview: redact_tool_arguments(&pending.tool_name, &pending.arguments),
    }
}

fn argument_resource_matches(tool_name: &str, arguments: &Value, path: &str) -> bool {
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
