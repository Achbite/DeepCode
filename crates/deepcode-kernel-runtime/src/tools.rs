use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn tool_invoke(
        &mut self,
        request_id: RequestId,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        tool_call_id: String,
        tool_name: String,
        arguments: Value,
        workspace_binding: Option<WorkspaceBinding>,
    ) -> KernelResult<Vec<KernelEvent>> {
        if needs_workspace_tool(&tool_name) {
            if let Some(binding) = workspace_binding {
                if let Some(open_path) = binding.open_path {
                    if self.state.current_workspace.is_none() {
                        self.workspace_open(
                            RequestId("tool-workspace-open".to_string()),
                            open_path,
                        )?;
                    }
                }
            }
            self.current_workspace()?;
        }
        if permission_action_for_kernel_tool(&tool_name) == PermissionAction::Deny {
            return Err(KernelError::PermissionDenied(format!(
                "tool {tool_name} is not allowed"
            )));
        }

        let (run_id, session_id) = self.resolve_run_session(run_id, session_id)?;
        let permission_action =
            self.effective_permission_action_for_tool(&run_id, &tool_name, &arguments)?;
        let request_sequence = self.ledger.next_sequence(&run_id)?;
        let requested = KernelEvent::ToolRequested {
            run_id: Some(RunId(run_id.clone())),
            session_id: Some(SessionId(session_id.clone())),
            turn_id: None,
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            args_preview: redact_tool_arguments(&tool_name, &arguments),
            sequence: Some(request_sequence),
        };
        self.append_ledger(
            &run_id,
            &session_id,
            "tool.requested",
            request_sequence,
            serde_json::json!({
                "summary": format!("Tool requested: {tool_name}"),
                "toolCallId": &tool_call_id,
                "toolName": &tool_name,
                "argsPreview": redact_tool_arguments(&tool_name, &arguments)
            }),
        )?;

        if permission_action == PermissionAction::Ask {
            let permission_id = tool_call_id.clone();
            let pending_tool_call_id = tool_call_id.clone();
            let pending_arguments = arguments.clone();
            self.state.pending_tools.insert(
                permission_id.clone(),
                PendingKernelTool {
                    run_id: run_id.clone(),
                    session_id: session_id.clone(),
                    tool_call_id: pending_tool_call_id.clone(),
                    tool_name: tool_name.clone(),
                    arguments: pending_arguments.clone(),
                },
            );
            let permission_sequence = self.ledger.next_sequence(&run_id)?;
            let permission = KernelEvent::PermissionRequested {
                run_id: Some(RunId(run_id.clone())),
                session_id: SessionId(session_id.clone()),
                request: deepcode_kernel_abi::PermissionRequestEnvelope {
                    id: permission_id.clone(),
                    capability: capability_for_tool(&tool_name).to_string(),
                    risk_level: risk_for_tool(&tool_name).to_string(),
                    summary: format!("Allow {tool_name} to access workspace resources?"),
                    args_preview: redact_tool_arguments(&tool_name, &pending_arguments),
                },
                sequence: Some(permission_sequence),
            };
            {
                let record = self.record_by_run_mut(&run_id)?;
                let permission_phase = record.phase.as_str().to_string();
                record
                    .decision_state
                    .apply_event(&permission, &permission_phase);
            }
            self.append_ledger(
                &run_id,
                &session_id,
                "permission.requested",
                permission_sequence,
                serde_json::json!({
                    "summary": format!("Permission requested for {tool_name}."),
                    "permissionId": permission_id,
                    "toolCallId": pending_tool_call_id,
                    "toolName": tool_name,
                    "capability": capability_for_tool(&tool_name),
                    "riskLevel": risk_for_tool(&tool_name),
                    "argsPreview": redact_tool_arguments(&tool_name, &pending_arguments),
                    "argumentsRef": {
                        "storage": "runtime.pendingTools",
                        "permissionId": permission_id,
                        "redaction": "raw arguments are kept in memory only and are not persisted to permission ledger"
                    }
                }),
            )?;
            return Ok(vec![requested, permission]);
        }

        let completed =
            self.execute_bound_tool(&run_id, &session_id, tool_call_id, tool_name, arguments)?;
        let mut events = vec![requested, completed];
        events.extend(self.auto_continue_after_tool(&run_id, &session_id)?);
        events.push(self.workflow_decision_event(
            request_id,
            &run_id,
            &session_id,
            "tool.completed",
        )?);
        Ok(events)
    }

    pub(crate) fn execute_bound_tool(
        &mut self,
        run_id: &str,
        session_id: &str,
        tool_call_id: String,
        tool_name: String,
        arguments: Value,
    ) -> KernelResult<KernelEvent> {
        let result = self.execute_kernel_tool(&tool_name, &arguments);
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

    pub(crate) fn invoke_llm_tool_call(
        &mut self,
        run_id: &str,
        session_id: &str,
        call: KernelLlmToolCall,
    ) -> KernelResult<Vec<KernelEvent>> {
        if permission_action_for_kernel_tool(&call.name) == PermissionAction::Deny {
            return Err(KernelError::PermissionDenied(format!(
                "tool {} is not allowed",
                call.name
            )));
        }
        let permission_action =
            self.effective_permission_action_for_tool(run_id, &call.name, &call.arguments)?;
        let request_sequence = self.ledger.next_sequence(run_id)?;
        let requested = KernelEvent::ToolRequested {
            run_id: Some(RunId(run_id.to_string())),
            session_id: Some(SessionId(session_id.to_string())),
            turn_id: None,
            tool_call_id: call.id.clone(),
            tool_name: call.name.clone(),
            args_preview: redact_tool_arguments(&call.name, &call.arguments),
            sequence: Some(request_sequence),
        };
        self.append_ledger(
            run_id,
            session_id,
            "tool.requested",
            request_sequence,
            serde_json::json!({
                "summary": format!("LLM requested tool: {}", call.name),
                "toolCallId": &call.id,
                "toolName": &call.name,
                "argsPreview": redact_tool_arguments(&call.name, &call.arguments)
            }),
        )?;

        if permission_action == PermissionAction::Ask {
            let permission_id = call.id.clone();
            let pending_tool_call_id = call.id.clone();
            let pending_arguments = call.arguments.clone();
            self.state.pending_tools.insert(
                permission_id.clone(),
                PendingKernelTool {
                    run_id: run_id.to_string(),
                    session_id: session_id.to_string(),
                    tool_call_id: pending_tool_call_id.clone(),
                    tool_name: call.name.clone(),
                    arguments: pending_arguments.clone(),
                },
            );
            let permission_sequence = self.ledger.next_sequence(run_id)?;
            let permission = KernelEvent::PermissionRequested {
                run_id: Some(RunId(run_id.to_string())),
                session_id: SessionId(session_id.to_string()),
                request: deepcode_kernel_abi::PermissionRequestEnvelope {
                    id: permission_id.clone(),
                    capability: capability_for_tool(&call.name).to_string(),
                    risk_level: risk_for_tool(&call.name).to_string(),
                    summary: format!("Allow {} to access workspace resources?", call.name),
                    args_preview: redact_tool_arguments(&call.name, &pending_arguments),
                },
                sequence: Some(permission_sequence),
            };
            {
                let record = self.record_by_run_mut(run_id)?;
                let permission_phase = record.phase.as_str().to_string();
                record
                    .decision_state
                    .apply_event(&permission, &permission_phase);
            }
            self.append_ledger(
                run_id,
                session_id,
                "permission.requested",
                permission_sequence,
                serde_json::json!({
                    "summary": format!("Permission requested for {}.", call.name),
                    "permissionId": permission_id,
                    "toolCallId": pending_tool_call_id,
                    "toolName": call.name,
                    "capability": capability_for_tool(&call.name),
                    "riskLevel": risk_for_tool(&call.name),
                    "argsPreview": redact_tool_arguments(&call.name, &pending_arguments),
                    "argumentsRef": {
                        "storage": "runtime.pendingTools",
                        "permissionId": permission_id,
                        "redaction": "raw arguments are kept in memory only and are not persisted to permission ledger"
                    }
                }),
            )?;
            return Ok(vec![requested, permission]);
        }

        let completed =
            self.execute_bound_tool(run_id, session_id, call.id, call.name, call.arguments)?;
        let mut events = vec![requested, completed];
        events.extend(self.auto_continue_after_tool(run_id, session_id)?);
        Ok(events)
    }

    pub(crate) fn auto_continue_after_tool(
        &mut self,
        run_id: &str,
        session_id: &str,
    ) -> KernelResult<Vec<KernelEvent>> {
        let mut events = Vec::new();
        loop {
            let next = {
                let record = self.record_by_run(run_id)?;
                next_kernel_autorun_tool(&record.decision_state)
            };
            let Some((tool_name, arguments)) = next else {
                break;
            };
            let tool_call_id = format!(
                "kernel-auto-{}-{}",
                tool_name.replace('.', "-"),
                now_millis()
            );
            let request_sequence = self.ledger.next_sequence(run_id)?;
            let requested = KernelEvent::ToolRequested {
                run_id: Some(RunId(run_id.to_string())),
                session_id: Some(SessionId(session_id.to_string())),
                turn_id: None,
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.to_string(),
                args_preview: redact_tool_arguments(tool_name, &arguments),
                sequence: Some(request_sequence),
            };
            self.append_ledger(
                run_id,
                session_id,
                "tool.requested",
                request_sequence,
                serde_json::json!({
                    "summary": format!("Kernel auto requested: {tool_name}"),
                    "toolCallId": &tool_call_id,
                    "toolName": tool_name,
                    "argsPreview": redact_tool_arguments(tool_name, &arguments)
                }),
            )?;
            events.push(requested);
            let permission_action =
                self.effective_permission_action_for_tool(run_id, tool_name, &arguments)?;
            if permission_action == PermissionAction::Ask
                && !is_kernel_owned_temp_cleanup(tool_name, &arguments)
            {
                let permission_id = tool_call_id.clone();
                let pending_tool_call_id = tool_call_id.clone();
                let pending_arguments = arguments.clone();
                self.state.pending_tools.insert(
                    permission_id.clone(),
                    PendingKernelTool {
                        run_id: run_id.to_string(),
                        session_id: session_id.to_string(),
                        tool_call_id: pending_tool_call_id.clone(),
                        tool_name: tool_name.to_string(),
                        arguments: pending_arguments.clone(),
                    },
                );
                let permission_sequence = self.ledger.next_sequence(run_id)?;
                let permission = KernelEvent::PermissionRequested {
                    run_id: Some(RunId(run_id.to_string())),
                    session_id: SessionId(session_id.to_string()),
                    request: deepcode_kernel_abi::PermissionRequestEnvelope {
                        id: permission_id.clone(),
                        capability: capability_for_tool(tool_name).to_string(),
                        risk_level: risk_for_tool(tool_name).to_string(),
                        summary: format!("Allow {tool_name} to access workspace resources?"),
                        args_preview: redact_tool_arguments(tool_name, &pending_arguments),
                    },
                    sequence: Some(permission_sequence),
                };
                {
                    let record = self.record_by_run_mut(run_id)?;
                    let permission_phase = record.phase.as_str().to_string();
                    record
                        .decision_state
                        .apply_event(&permission, &permission_phase);
                }
                self.append_ledger(
                    run_id,
                    session_id,
                    "permission.requested",
                    permission_sequence,
                    serde_json::json!({
                        "summary": format!("Permission requested for {tool_name}."),
                        "permissionId": permission_id,
                        "toolCallId": pending_tool_call_id,
                        "toolName": tool_name,
                        "capability": capability_for_tool(tool_name),
                        "riskLevel": risk_for_tool(tool_name),
                        "argsPreview": redact_tool_arguments(tool_name, &pending_arguments),
                        "argumentsRef": {
                            "storage": "runtime.pendingTools",
                            "permissionId": permission_id,
                            "redaction": "raw arguments are kept in memory only and are not persisted to permission ledger"
                        }
                    }),
                )?;
                events.push(permission);
                break;
            }
            let completed = self.execute_bound_tool(
                run_id,
                session_id,
                tool_call_id,
                tool_name.to_string(),
                arguments,
            )?;
            events.push(completed);
        }
        Ok(events)
    }

    pub(crate) fn execute_kernel_tool(
        &self,
        tool_name: &str,
        arguments: &Value,
    ) -> KernelResult<Value> {
        let workspace_root = self
            .state
            .current_workspace
            .as_ref()
            .map(|workspace| workspace.root.to_string_lossy().to_string());
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
                    self.workspace_search(
                        RequestId(request.request_id.clone()),
                        None,
                        query,
                        None,
                        false,
                    )
                    .and_then(broker_workspace_output)
                })
            }
            "kernel.fs.write"
            | "kernel.network.fetch"
            | "kernel.secret.read"
            | "kernel.shell.exec"
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
    match tool_id {
        "fs.write" | "fs.delete" | "shell.exec" | "web.search" | "web.fetch" | "git.stage"
        | "git.unstage" | "git.commit" | "browser.open" | "browser.reload" | "browser.snapshot"
        | "browser.inspect" | "browser.click" | "browser.type" | "browser.scroll" => {
            PermissionAction::Ask
        }
        "fs.read" | "fs.list" | "fs.diff" | "code.search" | "shell.propose" | "git.status"
        | "git.diff" => PermissionAction::Allow,
        _ => PermissionAction::Deny,
    }
}

pub(crate) fn needs_workspace_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "fs.read"
            | "fs.list"
            | "fs.diff"
            | "fs.write"
            | "fs.delete"
            | "code.search"
            | "git.status"
            | "git.diff"
            | "git.stage"
            | "git.unstage"
            | "git.commit"
    )
}

#[allow(dead_code)]
fn broker_workspace_output(events: Vec<KernelEvent>) -> KernelResult<Value> {
    match events.into_iter().next() {
        Some(KernelEvent::WorkspaceResult {
            ok: true,
            output: Some(output),
            ..
        }) => Ok(output),
        Some(KernelEvent::WorkspaceResult {
            ok: false,
            error: Some(error),
            ..
        }) => Err(KernelError::Other(error.message)),
        Some(other) => Err(KernelError::Other(format!(
            "unexpected broker workspace event {other:?}"
        ))),
        None => Err(KernelError::Other(
            "broker workspace request produced no event".to_string(),
        )),
    }
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
    match tool_id {
        "fs.write" => "workspace.write",
        "fs.delete" => "workspace.delete",
        "shell.exec" => "process.exec",
        "web.search" | "web.fetch" => "network.egress",
        "git.stage" | "git.unstage" | "git.commit" => "git.write",
        "browser.open" | "browser.reload" | "browser.snapshot" | "browser.inspect"
        | "browser.click" | "browser.type" | "browser.scroll" => "browser.control",
        "fs.read" | "fs.list" => "workspace.read",
        "fs.diff" => "workspace.preview_diff",
        "code.search" => "workspace.search",
        "shell.propose" => "process.propose",
        "git.status" | "git.diff" => "git.read",
        _ => "unknown",
    }
}

pub(crate) fn risk_for_tool(tool_id: &str) -> &'static str {
    match tool_id {
        "fs.delete" | "shell.exec" | "web.search" | "web.fetch" | "git.stage" | "git.unstage"
        | "git.commit" | "browser.open" | "browser.reload" | "browser.snapshot"
        | "browser.inspect" | "browser.click" | "browser.type" | "browser.scroll" => "high",
        "fs.write" => "medium",
        _ => "low",
    }
}

pub(crate) fn redact_tool_arguments(tool_name: &str, arguments: &Value) -> Value {
    match tool_name {
        "shell.exec" | "shell.propose" => {
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

pub(crate) fn next_kernel_autorun_tool(state: &RunDecisionState) -> Option<(&'static str, Value)> {
    if !(state.workspace_summary_required
        || state.tool_component_required
        || state.temp_lifecycle_required)
    {
        return None;
    }
    if !state.workspace_listed {
        return Some(("fs.list", serde_json::json!({ "path": "." })));
    }
    if state.workspace_summary_required && !state.workspace_file_read {
        let path = state
            .workspace_summary_file_path
            .as_deref()
            .unwrap_or("README.md");
        return Some(("fs.read", serde_json::json!({ "path": path })));
    }
    if state.tool_component_required && !state.workspace_search_completed {
        return Some(("code.search", serde_json::json!({ "query": "DeepCode" })));
    }
    if !state.temp_lifecycle_required {
        return None;
    }
    if !state.temp_created {
        return Some((
            "fs.write",
            serde_json::json!({
                "path": "_agent_tmp_functional_test.txt",
                "content": format!("DeepCode Agent temp lifecycle test at {}", now_millis())
            }),
        ));
    }
    if !state.temp_read_back {
        return Some((
            "fs.read",
            serde_json::json!({ "path": "_agent_tmp_functional_test.txt" }),
        ));
    }
    if !state.temp_cleaned {
        return Some((
            "fs.delete",
            serde_json::json!({ "path": "_agent_tmp_functional_test.txt" }),
        ));
    }
    None
}

pub(crate) fn get_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}
