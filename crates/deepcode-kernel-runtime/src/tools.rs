use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn execute_bound_tool(
        &mut self,
        run_id: &str,
        session_id: &str,
        tool_call_id: String,
        tool_name: String,
        arguments: Value,
    ) -> KernelResult<KernelEvent> {
        if let Some(denial) = deny_kernel_shell_command(&tool_name, &arguments) {
            return self.command_denied_tool_completed_event(
                run_id,
                session_id,
                tool_call_id,
                tool_name,
                arguments,
                denial,
            );
        }
        let result = self
            .execute_kernel_tool(run_id, &tool_name, &arguments)
            .and_then(|mut output| {
                self.attach_workspace_tool_diagnostics(&tool_name, &arguments, &mut output)?;
                attach_agent_generated_artifact_metadata(
                    run_id,
                    session_id,
                    &tool_call_id,
                    &tool_name,
                    &arguments,
                    &mut output,
                );
                self.record_kernel_resource_effects(
                    run_id, session_id, &tool_name, &arguments, &output,
                )?;
                Ok(output)
            });
        let sequence = self.ledger.next_sequence(run_id)?;
        let event = KernelEvent::ToolCompleted {
            run_id: Some(RunId(run_id.to_string())),
            session_id: Some(SessionId(session_id.to_string())),
            turn_id: None,
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            ok: result.is_ok(),
            output: result.as_ref().ok().cloned(),
            error: result.as_ref().err().map(Into::into),
            sequence: Some(sequence),
        };
        {
            let record = self.record_by_run_mut(run_id)?;
            let phase = record.phase.as_str().to_string();
            record.decision_state.apply_event(&event, &phase);
        }
        self.append_ledger(
            run_id,
            session_id,
            "tool.completed",
            sequence,
            serde_json::json!({
                "summary": format!("Tool completed: {tool_name}"),
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "ok": result.is_ok(),
                "output": result.as_ref().ok(),
                "error": result.as_ref().err().map(KernelErrorEnvelope::from)
            }),
        )?;
        if let Ok(output) = result.as_ref() {
            self.record_change_operation_for_tool(
                run_id,
                session_id,
                &tool_call_id,
                &tool_name,
                &arguments,
            )?;
            self.record_validation_for_tool(run_id, session_id, &tool_call_id, &tool_name, output)?;
        }
        Ok(event)
    }

    fn command_denied_tool_completed_event(
        &mut self,
        run_id: &str,
        session_id: &str,
        tool_call_id: String,
        tool_name: String,
        arguments: Value,
        denial: KernelCommandDeny,
    ) -> KernelResult<KernelEvent> {
        let deny_sequence = self.ledger.next_sequence(run_id)?;
        let command = arguments
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let denied_resource_id = format!("denied-command-{run_id}-{deny_sequence}");
        self.state.resource_registry.deny(KernelResource::denied(
            denied_resource_id.clone(),
            KernelResourceKind::ProcessHandle,
            KernelResourceOwner::agent_workflow(Some(session_id.to_string()), run_id.to_string()),
            KernelResourceScope::Workflow,
            KernelResourceCleanupPolicy::OnWorkflowEnd,
            serde_json::json!({
                "toolName": &tool_name,
                "reason": &denial.reason,
                "category": denial.category,
                "commandPreview": limit_preview(command, 160),
                "commandBytes": command.len(),
                "commandHash": deepcode_kernel_skills::hash::hash_bytes(command.as_bytes())
            }),
        ))?;
        self.append_ledger(
            run_id,
            session_id,
            "resource.denied",
            deny_sequence,
            serde_json::json!({
                "summary": format!("Kernel denied resource request: {}", denial.reason),
                "resourceId": denied_resource_id,
                "kind": "processHandle",
                "owner": "agentWorkflow",
                "scope": "workflow",
                "reason": &denial.reason,
                "category": denial.category,
                "event": "resource.denied"
            }),
        )?;
        let command_sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "command.denied",
            command_sequence,
            serde_json::json!({
                "summary": format!("Kernel command gate denied {tool_name}: {}", denial.reason),
                "toolCallId": &tool_call_id,
                "toolName": &tool_name,
                "reason": &denial.reason,
                "category": denial.category,
                "argsPreview": redact_tool_arguments(&tool_name, &arguments),
                "event": "command.denied"
            }),
        )?;

        let error = KernelError::PermissionDenied(format!(
            "command denied by Kernel command gate: {}",
            denial.reason
        ));
        let sequence = self.ledger.next_sequence(run_id)?;
        let event = KernelEvent::ToolCompleted {
            run_id: Some(RunId(run_id.to_string())),
            session_id: Some(SessionId(session_id.to_string())),
            turn_id: None,
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            ok: false,
            output: None,
            error: Some(KernelErrorEnvelope::from(&error)),
            sequence: Some(sequence),
        };
        {
            let record = self.record_by_run_mut(run_id)?;
            let phase = record.phase.as_str().to_string();
            record.decision_state.apply_event(&event, &phase);
        }
        self.append_ledger(
            run_id,
            session_id,
            "tool.completed",
            sequence,
            serde_json::json!({
                "summary": format!("Tool completed: {tool_name}"),
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "ok": false,
                "error": KernelErrorEnvelope::from(&error)
            }),
        )?;
        Ok(event)
    }

    fn record_kernel_resource_effects(
        &mut self,
        run_id: &str,
        session_id: &str,
        tool_name: &str,
        arguments: &Value,
        output: &Value,
    ) -> KernelResult<()> {
        let Some(path) = arguments.get("path").and_then(Value::as_str) else {
            return Ok(());
        };
        if !is_temp_file_path(path) {
            return Ok(());
        }

        if tool_name == "fs.write" {
            let absolute_path = output
                .get("absolutePath")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    self.resolve_workspace_path(path)
                        .ok()
                        .map(|path| path.to_string_lossy().to_string())
                });
            let resource_id = workflow_temp_resource_id(run_id, path);
            self.state
                .resource_registry
                .register(KernelResource::active(
                    resource_id.clone(),
                    KernelResourceKind::TempArtifact,
                    KernelResourceOwner::agent_workflow(
                        Some(session_id.to_string()),
                        run_id.to_string(),
                    ),
                    KernelResourceScope::Workflow,
                    KernelResourceCleanupPolicy::OnWorkflowEnd,
                    serde_json::json!({
                        "path": path,
                        "absolutePath": absolute_path,
                        "sourceTool": tool_name,
                        "managedBy": "kernel.resourceRegistry"
                    }),
                ))?;
            let sequence = self.ledger.next_sequence(run_id)?;
            self.append_ledger(
                run_id,
                session_id,
                "resource.registered",
                sequence,
                serde_json::json!({
                    "summary": format!("Kernel registered workflow temp resource: {path}"),
                    "resourceId": resource_id,
                    "kind": "tempArtifact",
                    "owner": "agentWorkflow",
                    "scope": "workflow",
                    "path": path
                }),
            )?;
        } else if tool_name == "fs.delete" {
            let resource_id = workflow_temp_resource_id(run_id, path);
            let release = self.state.resource_registry.release(&resource_id);
            let sequence = self.ledger.next_sequence(run_id)?;
            self.append_ledger(
                run_id,
                session_id,
                "resource.released",
                sequence,
                serde_json::json!({
                    "summary": format!("Kernel released workflow temp resource: {path}"),
                    "resourceId": resource_id,
                    "released": release.released,
                    "error": release.error
                }),
            )?;
        }
        Ok(())
    }

    pub(crate) fn execute_kernel_tool(
        &self,
        run_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> KernelResult<Value> {
        let workspace_root = self.tool_workspace_root(run_id, tool_name, arguments)?;
        let result = self.tool_executors.invoke(
            SkillInvocation {
                id: format!("tool-{tool_name}"),
                run_id: None,
                session_id: None,
                skill_id: tool_name.to_string(),
                phase: Some("complete".to_string()),
                input: arguments.clone(),
            },
            SkillExecutionContext {
                run_id: None,
                session_id: None,
                trust_mode: SkillTrustMode::Declarative,
                approved_capabilities: Vec::new(),
                workspace_root,
            },
        )?;
        if result.ok {
            Ok(result.output)
        } else {
            Err(KernelError::Other(
                result
                    .error
                    .unwrap_or_else(|| format!("tool {tool_name} failed")),
            ))
        }
    }

    fn tool_workspace_root(
        &self,
        run_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> KernelResult<Option<String>> {
        if let Some(root) = arguments
            .get("kernelExecutionRoot")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !matches!(
                tool_name,
                "fs.write"
                    | "fs.patch"
                    | "fs.delete"
                    | "fs.read"
                    | "fs.list"
                    | "code.search"
                    | "git.status"
                    | "git.diff"
                    | "git.stage"
                    | "git.unstage"
                    | "git.commit"
                    | "git.push"
            ) {
                return Err(KernelError::PermissionDenied(
                    "kernelExecutionRoot is only allowed for Kernel-compiled workspace tools"
                        .to_string(),
                ));
            }
            if arguments.get("kernelContext").is_none() {
                return Err(KernelError::PermissionDenied(
                    "kernelExecutionRoot requires Kernel actionBatch context".to_string(),
                ));
            }
            let root_path = PathBuf::from(root);
            if !root_path.is_dir() {
                return Err(KernelError::InvalidCommand(format!(
                    "kernelExecutionRoot is not a directory: {root}"
                )));
            }
            return Ok(Some(root.to_string()));
        }
        if let Some(root) = arguments
            .get("attachmentRoot")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            self.validate_attachment_tool_root(run_id, tool_name, root, arguments)?;
            return Ok(Some(root.to_string()));
        }
        Ok(self
            .state
            .current_workspace
            .as_ref()
            .map(|workspace| workspace.root.to_string_lossy().to_string()))
    }

    fn validate_attachment_tool_root(
        &self,
        run_id: &str,
        tool_name: &str,
        root: &str,
        arguments: &Value,
    ) -> KernelResult<()> {
        if !matches!(tool_name, "fs.read" | "fs.list" | "code.search") {
            return Err(KernelError::PermissionDenied(
                "attachmentRoot is only allowed for read-only workspace tools".to_string(),
            ));
        }
        let record = self.record_by_run(run_id)?;
        let root = PathBuf::from(root)
            .canonicalize()
            .map_err(|error| KernelError::InvalidCommand(format!("attachmentRoot: {error}")))?;
        let relative = arguments
            .get("path")
            .or_else(|| arguments.get("include"))
            .and_then(Value::as_str)
            .unwrap_or(".");
        let target = WorkspaceBoundary::new(&root).resolve(relative)?;
        let target = target.canonicalize().unwrap_or(target);
        let allowed = record
            .attachments
            .iter()
            .any(|attachment| explicit_attachment_allows_target(attachment, &root, &target));
        if !allowed {
            return Err(KernelError::PermissionDenied(
                "attachmentRoot must match an explicit user attachment".to_string(),
            ));
        }
        Ok(())
    }

    fn attach_workspace_tool_diagnostics(
        &self,
        tool_name: &str,
        arguments: &Value,
        output: &mut Value,
    ) -> KernelResult<()> {
        if !matches!(
            tool_name,
            "fs.write" | "fs.patch" | "fs.delete" | "fs.read" | "fs.list" | "code.search"
        ) {
            return Ok(());
        }
        let diagnostic_root = arguments
            .get("kernelExecutionRoot")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .or_else(|| {
                arguments
                    .get("attachmentRoot")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
            })
            .or_else(|| {
                self.state
                    .current_workspace
                    .as_ref()
                    .map(|workspace| workspace.root.clone())
            });
        let Some(diagnostic_root) = diagnostic_root else {
            return Ok(());
        };
        if let Some(object) = output.as_object_mut() {
            object.insert(
                "workspaceRoot".to_string(),
                Value::String(diagnostic_root.to_string_lossy().to_string()),
            );
            if let Some(path) = arguments.get("path").and_then(Value::as_str) {
                if let Ok(target) = WorkspaceBoundary::new(&diagnostic_root).resolve(path) {
                    object.insert(
                        "absolutePath".to_string(),
                        Value::String(target.to_string_lossy().to_string()),
                    );
                    if tool_name == "fs.write" {
                        let expected = arguments
                            .get("content")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let actual = fs::read(&target).map_err(|error| {
                            KernelError::Other(format!("read back {path}: {error}"))
                        })?;
                        let expected_hash =
                            deepcode_kernel_skills::hash::hash_bytes(expected.as_bytes());
                        let actual_hash = deepcode_kernel_skills::hash::hash_bytes(&actual);
                        object.insert(
                            "validation".to_string(),
                            serde_json::json!({
                                "kind": "readBack",
                                "passed": actual == expected.as_bytes(),
                                "path": path,
                                "contentBytes": actual.len(),
                                "contentHash": actual_hash,
                                "expectedContentBytes": expected.len(),
                                "expectedContentHash": expected_hash
                            }),
                        );
                    } else if tool_name == "fs.patch" {
                        let old_hash = object
                            .get("oldContentHash")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let new_hash = object
                            .get("newContentHash")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let changed_ranges =
                            object.get("changedRanges").cloned().unwrap_or(Value::Null);
                        object.insert(
                            "validation".to_string(),
                            serde_json::json!({
                                "kind": "patchReadBack",
                                "passed": target.is_file(),
                                "path": path,
                                "oldContentHash": old_hash,
                                "newContentHash": new_hash,
                                "changedRanges": changed_ranges
                            }),
                        );
                    } else if tool_name == "fs.delete" {
                        object.insert(
                            "validation".to_string(),
                            serde_json::json!({
                                "kind": "deleteVerified",
                                "passed": !target.exists(),
                                "path": path,
                                "exists": target.exists()
                            }),
                        );
                    }
                }
            }
        }
        Ok(())
    }

    pub(crate) fn skill_discover(&self, request_id: RequestId) -> KernelResult<Vec<KernelEvent>> {
        let descriptors = self.skills.list()?;
        let effective_capabilities = self
            .policy_profile
            .grants
            .values()
            .filter(|grant| grant.decision != PolicyDecisionKind::Deny)
            .map(|grant| grant.capability.clone())
            .collect::<Vec<_>>();
        let descriptors = model_visible_skill_descriptors(
            &descriptors,
            &self.state.skill_trust_records,
            &effective_capabilities,
        );
        Ok(vec![KernelEvent::SkillResult {
            request_id,
            skill_id: None,
            ok: true,
            output: Some(serde_json::json!({ "skills": descriptors })),
            error: None,
            sequence: None,
        }])
    }

    pub(crate) fn skill_trust_approve(
        &mut self,
        request_id: RequestId,
        skill_id: String,
        decision: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let approval = SkillTrustApprovalDecision::from_value(decision)?;
        if matches!(approval.decision.as_deref(), Some("reject" | "deny")) {
            return Ok(vec![KernelEvent::SkillResult {
                request_id,
                skill_id: Some(skill_id),
                ok: true,
                output: Some(serde_json::json!({ "decision": "rejected" })),
                error: None,
                sequence: None,
            }]);
        }
        if approval.trust_mode == SkillTrustMode::DirectHostScript {
            return Err(KernelError::PermissionDenied(
                "DirectHostScript is reserved for a later high-risk extension and is disabled in v1"
                    .to_string(),
            ));
        }

        let record = SkillTrustRecord {
            skill_id: skill_id.clone(),
            revision_hash: approval.revision_hash,
            approved_capabilities: approval.approved_capabilities,
            approved_at: approval.approved_at,
            approved_by: approval.approved_by,
            trust_mode: approval.trust_mode,
            ledger_event_ref: None,
            expires_at: approval.expires_at,
        };
        self.state
            .skill_trust_records
            .retain(|existing| existing.skill_id != skill_id);
        self.state.skill_trust_records.push(record.clone());
        let sequence = self.ledger.list_all()?.len() as u64 + 1;
        self.ledger.append(LedgerEvent {
            id: format!("evt-skill-trust-{sequence}"),
            run_id: None,
            session_id: None,
            kind: "skill.trust_granted".to_string(),
            sequence: Some(sequence),
            payload: serde_json::json!({
                "summary": format!("Skill trust granted: {skill_id}"),
                "skillId": skill_id,
                "trustRecord": &record
            }),
            created_at: None,
        })?;
        Ok(vec![KernelEvent::SkillTrustGranted {
            request_id: Some(request_id),
            skill_id: record.skill_id.clone(),
            trust_record: serde_json::to_value(record).unwrap_or(Value::Null),
            sequence: Some(sequence),
        }])
    }

    pub(crate) fn skill_invoke(
        &mut self,
        request_id: RequestId,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        skill_id: String,
        input: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let (run_id, session_id) = self.resolve_run_session(run_id, session_id)?;
        let result = self
            .skills
            .invoke(deepcode_kernel_skills::SkillInvocation {
                id: request_id.0.clone(),
                run_id: Some(run_id.clone()),
                session_id: Some(session_id.clone()),
                skill_id: skill_id.clone(),
                phase: Some("complete".to_string()),
                input,
            })
            .map(|value| serde_json::to_value(value).unwrap_or(Value::Null));
        let sequence = self.ledger.list_all()?.len() as u64 + 1;
        let lifecycle_events = result
            .as_ref()
            .ok()
            .and_then(|output| output.get("output"))
            .and_then(|output| output.get("lifecycleEvents"))
            .cloned()
            .unwrap_or(Value::Null);
        let request_id_value = request_id.0.clone();
        let audit_projection = serde_json::json!({
            "eventType": "skill.invocation_completed",
            "requestId": request_id_value.clone(),
            "runId": run_id,
            "sessionId": session_id,
            "skillId": skill_id.clone(),
            "ok": result.is_ok(),
            "error": result.as_ref().err().map(|error| error.to_string()),
            "lifecycleEvents": lifecycle_events,
            "redaction": "raw skill output is excluded from audit projection"
        });
        self.ledger.append(LedgerEvent {
            id: format!("evt-skill-invoke-{sequence}"),
            run_id: Some(run_id.clone()),
            session_id: Some(session_id.clone()),
            kind: "skill.invocation_completed".to_string(),
            sequence: Some(sequence),
            payload: serde_json::json!({
                "summary": format!("Skill invocation completed: {}", skill_id),
                "skillId": skill_id.clone(),
                "invocationId": request_id_value.clone(),
                "ok": result.is_ok(),
                "error": result.as_ref().err().map(|error| error.to_string()),
                "attribution": {
                    "requestId": request_id_value,
                    "runId": run_id,
                    "sessionId": session_id,
                    "source": "KernelCommand::SkillInvoke"
                },
                "auditProjection": audit_projection
            }),
            created_at: None,
        })?;
        self.append_signed_audit_entry(
            &run_id,
            &session_id,
            Some(request_id.0.clone()),
            "skill.invocation_completed",
            audit_projection,
        )?;

        Ok(vec![KernelEvent::SkillResult {
            request_id,
            skill_id: Some(skill_id),
            ok: result.is_ok(),
            output: result.as_ref().ok().cloned(),
            error: result.as_ref().err().map(Into::into),
            sequence: None,
        }])
    }

    #[allow(dead_code)]
    pub(crate) fn brokered_script_dispatch(
        &mut self,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        request: deepcode_kernel_skills::BrokeredScriptRequest,
        approved_capabilities: Vec<deepcode_kernel_policy::Capability>,
    ) -> KernelResult<deepcode_kernel_skills::BrokeredScriptResponse> {
        let (run_id, session_id) = self.resolve_run_session(run_id, session_id)?;
        let policy = deepcode_kernel_skills::ScriptBrokerPolicy::new(approved_capabilities);
        let decision = policy.evaluate(&request);
        let response = if !decision.authorized {
            deepcode_kernel_skills::BrokeredScriptResponse {
                request_id: request.request_id.clone(),
                ok: false,
                output: None,
                error: decision.error.clone(),
            }
        } else {
            self.dispatch_authorized_broker_request(&request)
        };
        let sequence = self.ledger.list_all()?.len() as u64 + 1;
        self.ledger.append(LedgerEvent {
            id: format!("evt-skill-broker-{sequence}"),
            run_id: Some(run_id.clone()),
            session_id: Some(session_id.clone()),
            kind: "skill.broker_request_completed".to_string(),
            sequence: Some(sequence),
            payload: serde_json::json!({
                "summary": format!("Broker request completed: {}", request.method),
                "runId": run_id,
                "sessionId": session_id,
                "requestId": request.request_id,
                "invocationId": request.invocation_id,
                "method": request.method,
                "ok": response.ok,
                "error": response.error,
                "auditProjection": decision.audit_projection()
            }),
            created_at: None,
        })?;
        self.append_signed_audit_entry(
            &run_id,
            &session_id,
            Some(request.request_id.clone()),
            "skill.broker_request_completed",
            serde_json::json!({
                "requestId": request.request_id,
                "invocationId": request.invocation_id,
                "method": request.method,
                "capability": request.capability.0,
                "authorized": decision.authorized,
                "ok": response.ok,
                "error": response.error
            }),
        )?;
        Ok(response)
    }

    #[allow(dead_code)]
    fn dispatch_authorized_broker_request(
        &self,
        request: &deepcode_kernel_skills::BrokeredScriptRequest,
    ) -> deepcode_kernel_skills::BrokeredScriptResponse {
        let result = match request.method.as_str() {
            "kernel.fs.read" => {
                let path = request
                    .arguments
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| {
                        KernelError::InvalidCommand(
                            "kernel.fs.read broker request requires path".to_string(),
                        )
                    });
                path.and_then(|path| {
                    self.workspace_read(RequestId(request.request_id.clone()), None, path)
                        .and_then(broker_workspace_output)
                })
            }
            "kernel.code.search" => {
                let query = request
                    .arguments
                    .get("query")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| {
                        KernelError::InvalidCommand(
                            "kernel.code.search broker request requires query".to_string(),
                        )
                    });
                query.and_then(|query| {
                    let include = request
                        .arguments
                        .get("include")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect::<Vec<_>>()
                        });
                    let context_lines = request
                        .arguments
                        .get("contextLines")
                        .and_then(Value::as_u64)
                        .map(|value| value as u32);
                    let max_results = request
                        .arguments
                        .get("maxResults")
                        .and_then(Value::as_u64)
                        .map(|value| value as u32);
                    self.workspace_search(
                        RequestId(request.request_id.clone()),
                        None,
                        query,
                        include,
                        context_lines,
                        max_results,
                        false,
                    )
                    .and_then(broker_workspace_output)
                })
            }
            "kernel.fs.write"
            | "kernel.network.fetch"
            | "kernel.secret.read"
            | "kernel.temp.create" => Err(KernelError::PermissionDenied(
                "broker request requires run/session permission continuation and is fail-closed in stage 13"
                    .to_string(),
            )),
            _ => Err(KernelError::PermissionDenied(format!(
                "unsupported authorized broker method {}",
                request.method
            ))),
        };
        match result {
            Ok(output) => deepcode_kernel_skills::BrokeredScriptResponse {
                request_id: request.request_id.clone(),
                ok: true,
                output: Some(output),
                error: None,
            },
            Err(error) => deepcode_kernel_skills::BrokeredScriptResponse {
                request_id: request.request_id.clone(),
                ok: false,
                output: None,
                error: Some(error.to_string()),
            },
        }
    }

    #[allow(dead_code)]
    pub(crate) fn record_mcp_stdio_tool_call_completed(
        &mut self,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        invocation_id: String,
        connector_id: String,
        tool_id: String,
        ok: bool,
        error: Option<String>,
    ) -> KernelResult<()> {
        let (run_id, session_id) = self.resolve_run_session(run_id, session_id)?;
        let sequence = self.ledger.next_sequence(&run_id)?;
        let redacted_payload = serde_json::json!({
            "invocationId": invocation_id,
            "connectorId": connector_id,
            "toolId": tool_id,
            "ok": ok,
            "error": error
        });
        self.append_ledger(
            &run_id,
            &session_id,
            "mcp.stdio_tool_call_completed",
            sequence,
            serde_json::json!({
                "summary": "MCP stdio tool call completed",
                "auditProjection": redacted_payload
            }),
        )?;
        self.append_signed_audit_entry(
            &run_id,
            &session_id,
            None,
            "mcp.stdio_tool_call_completed",
            redacted_payload,
        )?;
        Ok(())
    }

    fn append_signed_audit_entry(
        &self,
        run_id: &str,
        session_id: &str,
        request_id: Option<String>,
        event_type: &str,
        redacted_payload: Value,
    ) -> KernelResult<SignedAuditEntryV1> {
        let signer = runtime_audit_signer()?;
        let existing = self.signed_audit_entries()?;
        let mut chain = AuditChain::from_entries(runtime_audit_segment_id(), signer, existing)
            .map_err(|error| KernelError::Other(format!("restore audit chain: {error}")))?;
        let entry = chain
            .append(
                now_millis() as i64,
                AuditBody {
                    actor: AuditActor::Kernel,
                    category: AuditCategory::Tool,
                    event_type: event_type.to_string(),
                    session_id: Some(session_id.to_string()),
                    run_id: Some(run_id.to_string()),
                    request_id,
                    redacted_payload,
                },
            )
            .map_err(|error| KernelError::Other(format!("append audit entry: {error}")))?;
        let ledger_sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "audit.signed_entry_created",
            ledger_sequence,
            serde_json::json!({
                "summary": format!("Signed audit entry created: {}", entry.event_type),
                "signedEntry": &entry
            }),
        )?;
        Ok(entry)
    }

    fn signed_audit_entries(&self) -> KernelResult<Vec<SignedAuditEntryV1>> {
        self.ledger
            .list_all()?
            .into_iter()
            .filter(|event| event.kind == "audit.signed_entry_created")
            .filter_map(|event| event.payload.get("signedEntry").cloned())
            .map(|value| {
                serde_json::from_value::<SignedAuditEntryV1>(value).map_err(|error| {
                    KernelError::Other(format!("decode signed audit entry: {error}"))
                })
            })
            .collect()
    }

    pub(crate) fn audit_verify(
        &self,
        request_id: RequestId,
        scope: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let entries = self.signed_audit_entries()?;
        let verifier = AuditVerifier::new(runtime_audit_signer()?);
        let (ok, report) = match verifier.verify_entries(&entries) {
            Ok(report) => (true, serde_json::to_value(report).unwrap_or(Value::Null)),
            Err(error) => (
                false,
                serde_json::json!({
                    "ok": false,
                    "entriesVerified": 0,
                    "message": error.to_string()
                }),
            ),
        };
        let sequence = self.ledger.list_all()?.len() as u64 + 1;
        Ok(vec![
            KernelEvent::AuditVerifyStarted {
                request_id: Some(request_id.clone()),
                scope,
                sequence: Some(sequence),
            },
            KernelEvent::AuditVerifyCompleted {
                request_id: Some(request_id),
                ok,
                report,
                sequence: Some(sequence + 1),
            },
        ])
    }

    pub(crate) fn mcp_risk_acknowledgment_submit(
        &mut self,
        request_id: RequestId,
        connector_id: String,
        binding_id: Option<String>,
        acknowledgment: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let decision = acknowledgment
            .get("decision")
            .and_then(Value::as_str)
            .unwrap_or("acknowledge");
        let record = serde_json::json!({
            "connectorId": connector_id,
            "bindingId": binding_id,
            "decision": decision,
            "revisionHash": get_string(&acknowledgment, "revisionHash"),
            "acknowledgedBy": get_string(&acknowledgment, "acknowledgedBy"),
            "acknowledgedAt": get_string(&acknowledgment, "acknowledgedAt"),
            "riskLevel": acknowledgment.get("riskLevel").cloned().unwrap_or_else(|| serde_json::json!("medium")),
            "permissionGranted": false,
            "boundary": "MCP risk acknowledgment records user understanding only; it does not grant workspace, shell, network, or secret permission."
        });
        self.state.mcp_risk_acknowledgments.push(record.clone());
        let sequence = self.ledger.list_all()?.len() as u64 + 1;
        self.ledger.append(LedgerEvent {
            id: format!("evt-mcp-risk-ack-{sequence}"),
            run_id: None,
            session_id: None,
            kind: "mcp.risk_acknowledgment_recorded".to_string(),
            sequence: Some(sequence),
            payload: serde_json::json!({
                "summary": "MCP risk acknowledgment recorded",
                "record": &record
            }),
            created_at: None,
        })?;
        Ok(vec![KernelEvent::SkillResult {
            request_id,
            skill_id: Some("mcp.risk_acknowledgment".to_string()),
            ok: true,
            output: Some(record),
            error: None,
            sequence: Some(sequence),
        }])
    }
}

fn attach_agent_generated_artifact_metadata(
    run_id: &str,
    session_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    arguments: &Value,
    output: &mut Value,
) {
    if !matches!(
        tool_name,
        "fs.write" | "fs.patch" | "fs.rename" | "fs.delete"
    ) {
        return;
    }
    let Some(object) = output.as_object_mut() else {
        return;
    };
    object.insert(
        "artifactOrigin".to_string(),
        Value::String("agentGenerated".to_string()),
    );
    object.insert("runId".to_string(), Value::String(run_id.to_string()));
    object.insert(
        "sessionId".to_string(),
        Value::String(session_id.to_string()),
    );
    object.insert(
        "toolCallId".to_string(),
        Value::String(tool_call_id.to_string()),
    );
    if let Some(context) = arguments.get("kernelContext") {
        object.insert("kernelContext".to_string(), context.clone());
        if let Some(plan_id) = context.get("planId").and_then(Value::as_str) {
            object.insert("planId".to_string(), Value::String(plan_id.to_string()));
        }
        if let Some(work_unit_id) = context.get("workUnitId").and_then(Value::as_str) {
            object.insert(
                "workUnitId".to_string(),
                Value::String(work_unit_id.to_string()),
            );
        }
        if let Some(action_id) = context.get("actionId").and_then(Value::as_str) {
            object.insert("actionId".to_string(), Value::String(action_id.to_string()));
        }
        if let Some(operation_kind) = context.get("operationKind").and_then(Value::as_str) {
            object.insert(
                "operation".to_string(),
                Value::String(operation_kind.to_string()),
            );
        }
    }
    if let Some(path_normalization) = arguments.get("pathNormalization") {
        object.insert("pathNormalization".to_string(), path_normalization.clone());
        if let Some(normalized) = path_normalization
            .get("normalizedTargetPath")
            .and_then(Value::as_str)
        {
            object.insert(
                "normalizedTargetPath".to_string(),
                Value::String(normalized.to_string()),
            );
        }
        if let Some(duplicate) = path_normalization
            .get("duplicateRootPathDetected")
            .and_then(Value::as_bool)
        {
            object.insert(
                "duplicateRootPathDetected".to_string(),
                Value::Bool(duplicate),
            );
        }
    }
    if tool_name == "fs.write" {
        let validation = object.get("validation").and_then(Value::as_object).cloned();
        if let Some(validation) = validation {
            if let Some(hash) = validation.get("contentHash").and_then(Value::as_str) {
                object.insert("contentHash".to_string(), Value::String(hash.to_string()));
            }
            if let Some(bytes) = validation.get("contentBytes").and_then(Value::as_u64) {
                object.insert(
                    "contentBytes".to_string(),
                    Value::Number(serde_json::Number::from(bytes)),
                );
            }
        }
    }
}

#[derive(Debug)]
struct SkillTrustApprovalDecision {
    decision: Option<String>,
    trust_mode: SkillTrustMode,
    revision_hash: Option<String>,
    approved_capabilities: Vec<deepcode_kernel_policy::Capability>,
    approved_at: Option<String>,
    approved_by: Option<String>,
    expires_at: Option<String>,
}

impl SkillTrustApprovalDecision {
    fn from_value(value: Value) -> KernelResult<Self> {
        let decision = value
            .get("decision")
            .and_then(Value::as_str)
            .map(|value| value.to_ascii_lowercase());
        let trust_mode = value
            .get("trustMode")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| {
                KernelError::InvalidCommand(format!("invalid skill trust mode: {error}"))
            })?
            .unwrap_or(SkillTrustMode::BrokeredScript);
        let approved_capabilities = value
            .get("approvedCapabilities")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(deepcode_kernel_policy::Capability::new)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(Self {
            decision,
            trust_mode,
            revision_hash: get_string(&value, "revisionHash")
                .or_else(|| get_string(&value, "scriptHash")),
            approved_capabilities,
            approved_at: get_string(&value, "approvedAt"),
            approved_by: get_string(&value, "approvedBy"),
            expires_at: get_string(&value, "expiresAt"),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PermissionAction {
    Allow,
    Ask,
    Deny,
}

pub(crate) fn permission_action_for_kernel_tool(tool_id: &str) -> PermissionAction {
    match KernelToolRegistry::default().permission_mode_for_tool(tool_id) {
        ToolPermissionMode::Allow => PermissionAction::Allow,
        ToolPermissionMode::Ask => PermissionAction::Ask,
        ToolPermissionMode::Deny => PermissionAction::Deny,
    }
}

fn explicit_attachment_allows_target(attachment: &Value, root: &Path, target: &Path) -> bool {
    let source = attachment
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(source, "userSelected" | "contextMenu" | "mention") {
        return false;
    }
    let Some(absolute_path) = attachment
        .get("absolutePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    let Ok(attachment_path) = PathBuf::from(absolute_path).canonicalize() else {
        return false;
    };
    let kind = attachment
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("file");
    if kind == "directory" {
        root == attachment_path && target.starts_with(&attachment_path)
    } else {
        attachment_path
            .parent()
            .map(|parent| parent == root && target == attachment_path)
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KernelCommandDeny {
    pub(crate) category: &'static str,
    pub(crate) reason: String,
}

pub(crate) fn deny_kernel_shell_command(
    tool_name: &str,
    arguments: &Value,
) -> Option<KernelCommandDeny> {
    if tool_name != "shell.propose" {
        return None;
    }
    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if command.is_empty() {
        return None;
    }
    let lower = command.to_ascii_lowercase();
    if lower.contains("open -a terminal")
        || (lower.contains("osascript") && lower.contains("terminal"))
        || contains_shell_word(&lower, "gnome-terminal")
        || contains_shell_word(&lower, "xterm")
        || contains_shell_word(&lower, "konsole")
        || contains_shell_word(&lower, "alacritty")
        || contains_shell_word(&lower, "wezterm")
        || contains_shell_word(&lower, "wt.exe")
        || lower.contains("cmd.exe /c start")
        || lower.contains("powershell start-process")
        || lower.contains("pwsh -c start-process")
    {
        return Some(KernelCommandDeny {
            category: "nestedTerminal",
            reason: "starting nested terminal/session managers is denied".to_string(),
        });
    }
    if contains_shell_word(&lower, "nohup")
        || contains_shell_word(&lower, "disown")
        || contains_shell_word(&lower, "setsid")
        || lower.ends_with('&')
        || lower.contains(" & ")
    {
        return Some(KernelCommandDeny {
            category: "backgroundEscape",
            reason: "background or detached processes must be modeled as Kernel resources"
                .to_string(),
        });
    }
    if contains_shell_word(&lower, "tmux")
        || contains_shell_word(&lower, "screen")
        || contains_shell_word(&lower, "script")
    {
        return Some(KernelCommandDeny {
            category: "terminalReuseEscape",
            reason: "terminal multiplexer/session capture commands are denied".to_string(),
        });
    }
    if contains_shell_word(&lower, "rm") {
        return Some(KernelCommandDeny {
            category: "deleteBypass",
            reason: "delete operations must use fs.delete or Kernel cleanup".to_string(),
        });
    }
    if contains_unmanaged_shell_redirection(&lower) {
        return Some(KernelCommandDeny {
            category: "unmanagedRedirect",
            reason: "shell redirection must target a Kernel-allocated redirect/cache resource"
                .to_string(),
        });
    }
    None
}

fn contains_shell_word(command: &str, word: &str) -> bool {
    command
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.')))
        .any(|part| part == word)
}

fn contains_unmanaged_shell_redirection(command: &str) -> bool {
    command.contains(">>")
        || command.contains("&>")
        || command.contains("2>")
        || command.contains(">")
        || command.contains("| tee ")
        || command.starts_with("tee ")
}

fn broker_workspace_output(events: Vec<KernelEvent>) -> KernelResult<Value> {
    let mut last_unexpected = None;
    for event in events {
        match event {
            KernelEvent::ToolCompleted {
            ok: true,
            output: Some(output),
            ..
            } => return Ok(output),
            KernelEvent::ToolCompleted {
            ok: false,
            error: Some(error),
            ..
            } => return Err(KernelError::Other(error.message)),
            other => last_unexpected = Some(other),
        }
    }
    if let Some(other) = last_unexpected {
        return Err(KernelError::Other(format!(
            "unexpected broker workspace event {other:?}"
        )));
    }
    Err(KernelError::Other(
        "broker workspace request produced no event".to_string(),
    ))
}

fn runtime_audit_segment_id() -> &'static str {
    "deepcode-runtime-process-v1"
}

fn runtime_audit_signer() -> KernelResult<LocalAuditSigner> {
    let key = AuditKeyMaterial::load_or_degraded(
        AuditRuntimeMode::Development,
        "deepcode-runtime-v1",
        None,
    )
    .map_err(|error| KernelError::Other(format!("load runtime audit key: {error}")))?;
    Ok(LocalAuditSigner::new(key))
}

pub(crate) fn capability_for_tool(tool_id: &str) -> &'static str {
    KernelToolRegistry::default().capability_for_tool(tool_id)
}

pub(crate) fn risk_for_tool(tool_id: &str) -> &'static str {
    KernelToolRegistry::default().risk_for_tool(tool_id)
}

pub(crate) fn redact_tool_arguments(tool_id: &str, arguments: &Value) -> Value {
    match tool_id {
        "shell.propose" => {
            let command = arguments
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            serde_json::json!({
                "commandPreview": limit_preview(command, 160),
                "commandBytes": command.len(),
                "commandHash": deepcode_kernel_skills::hash::hash_bytes(command.as_bytes())
            })
        }
        "fs.write" | "fs.diff" => {
            let content = arguments
                .get("content")
                .or_else(|| arguments.get("newContent"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            serde_json::json!({
                "path": arguments.get("path").cloned().unwrap_or(Value::Null),
                "contentBytes": content.len(),
                "contentHash": deepcode_kernel_skills::hash::hash_bytes(content.as_bytes())
            })
        }
        "fs.patch" => {
            let content = arguments
                .get("replacement")
                .and_then(Value::as_str)
                .unwrap_or_default();
            serde_json::json!({
                "path": arguments.get("path").cloned().unwrap_or(Value::Null),
                "replacementBytes": content.len(),
                "replacementHash": deepcode_kernel_skills::hash::hash_bytes(content.as_bytes()),
                "patchSpec": arguments.get("patchSpec").cloned().unwrap_or(Value::Null)
            })
        }
        "browser.type" => {
            let text = arguments
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            serde_json::json!({
                "selector": arguments.get("selector").cloned().unwrap_or(Value::Null),
                "textPreview": limit_preview(text, 80),
                "textBytes": text.len(),
                "textHash": deepcode_kernel_skills::hash::hash_bytes(text.as_bytes())
            })
        }
        _ => arguments.clone(),
    }
}

fn limit_preview(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    format!("{}…", value.chars().take(max_chars).collect::<String>())
}

fn workflow_temp_resource_id(run_id: &str, path: &str) -> String {
    let normalized = path
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    format!("agent-temp-{run_id}-{normalized}")
}

fn is_temp_file_path(value: &str) -> bool {
    value.contains("_agent_tmp_")
}

pub(crate) fn get_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}
