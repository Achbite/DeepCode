use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn llm_call_requested_event(
        &mut self,
        run_id: &str,
        session_id: &str,
    ) -> KernelResult<KernelEvent> {
        let (phase, input_text, profile_ref, decision_state, llm_call_id) = {
            let record = self.record_by_run_mut(run_id)?;
            record.llm_call_index += 1;
            let phase = record.phase.as_str().to_string();
            let llm_call_id = format!("llm-{run_id}-{phase}-{}", record.llm_call_index);
            record.active_llm_call_id = Some(llm_call_id.clone());
            (
                phase,
                record.input_text.clone(),
                record.profile_ref.clone(),
                record.decision_state.clone(),
                llm_call_id,
            )
        };
        let context_snapshot = self.context_runtime.create_snapshot(
            vec![ContextCandidatePayload {
                id: format!("latest-user-input-{run_id}"),
                kind: "latestUserInput".to_string(),
                payload: serde_json::json!({ "content": input_text }),
                source_refs: vec![format!("run:{run_id}")],
            }],
            Vec::new(),
        )?;
        let request_envelope = compile_llm_request_envelope(
            &phase,
            &input_text,
            &decision_state,
            Some(&context_snapshot.reference.id),
        );
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "llm.call_requested",
            sequence,
            serde_json::json!({
                "summary": format!("Kernel requested LLM call for {phase}."),
                "phase": &phase,
                "llmCallId": &llm_call_id,
                "profileRef": &profile_ref,
                "contextSnapshotId": &context_snapshot.reference.id,
                "requestEnvelope": &request_envelope
            }),
        )?;
        Ok(KernelEvent::LlmCallRequested {
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            phase,
            llm_call_id,
            profile_ref,
            request_envelope,
            sequence: Some(sequence),
        })
    }

    pub(crate) fn llm_response_submit(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        llm_call_id: String,
        response_envelope: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?;
        let session_id = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| record.session_id.clone());
        if record.session_id != session_id {
            return Err(KernelError::InvalidCommand(format!(
                "run {} is not bound to session {}",
                run_id.0, session_id
            )));
        }
        if record.active_llm_call_id.as_deref() != Some(llm_call_id.as_str()) {
            return Err(KernelError::InvalidCommand(format!(
                "llm call {llm_call_id} is not active for run {}",
                run_id.0
            )));
        }

        let phase = record.phase.as_str().to_string();
        let mut events = Vec::new();
        for event in self.message_events_from_llm_response(
            &request_id,
            &run_id.0,
            &session_id,
            &phase,
            &response_envelope,
        )? {
            events.push(event);
        }

        if phase == "complete" {
            let tool_calls = extract_llm_tool_calls(&response_envelope);
            for call in tool_calls {
                let mut tool_events = self.invoke_llm_tool_call(&run_id.0, &session_id, call)?;
                let waiting_for_permission = tool_events
                    .iter()
                    .any(|event| matches!(event, KernelEvent::PermissionRequested { .. }));
                events.append(&mut tool_events);
                if waiting_for_permission {
                    events.push(self.workflow_decision_event(
                        request_id,
                        &run_id.0,
                        &session_id,
                        "permission.requested",
                    )?);
                    return Ok(events);
                }
            }
            let mut auto_events = self.auto_continue_after_tool(&run_id.0, &session_id)?;
            let waiting_for_permission = auto_events
                .iter()
                .any(|event| matches!(event, KernelEvent::PermissionRequested { .. }));
            events.append(&mut auto_events);
            if waiting_for_permission {
                events.push(self.workflow_decision_event(
                    request_id,
                    &run_id.0,
                    &session_id,
                    "permission.requested",
                )?);
                return Ok(events);
            }
        }

        let decision_event = self.workflow_decision_event(
            request_id.clone(),
            &run_id.0,
            &session_id,
            "llm.response",
        )?;
        let decision = match &decision_event {
            KernelEvent::WorkflowDecisionMade { decision, .. } => decision.clone(),
            _ => unreachable!("workflow_decision_event must emit workflow.decision_made"),
        };
        events.push(decision_event);

        let next = next_phase_after_llm_response(&phase, &decision);
        match next {
            LlmPhaseAdvance::Continue(next_phase) => {
                events.push(self.enter_phase_event(&run_id.0, &session_id, next_phase)?);
                events.push(self.llm_call_requested_event(&run_id.0, &session_id)?);
            }
            LlmPhaseAdvance::Finish => {
                events.push(self.complete_run_event(&run_id.0, &session_id)?);
            }
            LlmPhaseAdvance::Stop => {}
        }

        Ok(events)
    }

    pub(crate) fn message_events_from_llm_response(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        phase: &str,
        response_envelope: &Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let mut events = Vec::new();
        if let Some(reasoning) = response_envelope
            .pointer("/assistantMessage/reasoningContent")
            .or_else(|| response_envelope.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            let event = self.message_appended_event(
                request_id,
                run_id,
                session_id,
                "reasoning",
                Some(reasoning.to_string()),
            )?;
            events.push(event);
        }
        if let Some(content) = response_envelope
            .pointer("/assistantMessage/content")
            .or_else(|| response_envelope.get("content"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            if phase == "complete" {
                return Ok(events);
            }
            let channel = if phase == "review" { "review" } else { phase };
            let event = self.message_appended_event(
                request_id,
                run_id,
                session_id,
                channel,
                Some(content.to_string()),
            )?;
            events.push(event);
        }
        Ok(events)
    }

    pub(crate) fn message_appended_event(
        &mut self,
        _request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        channel: &str,
        content: Option<String>,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        let event = KernelEvent::MessageAppended {
            run_id: Some(RunId(run_id.to_string())),
            session_id: Some(SessionId(session_id.to_string())),
            turn_id: None,
            role: deepcode_kernel_abi::MessageRole::Agent,
            channel: Some(channel.to_string()),
            content: content.clone(),
            message_key: None,
            args: None,
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
            "message.appended",
            sequence,
            serde_json::json!({
                "summary": format!("Agent message appended on {channel}."),
                "channel": channel,
                "content": content
            }),
        )?;
        Ok(event)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LlmPhaseAdvance {
    Continue(WorkflowPhase),
    Finish,
    Stop,
}

pub(crate) fn next_phase_after_llm_response(
    phase: &str,
    decision: &WorkflowDecision,
) -> LlmPhaseAdvance {
    if decision.fail_closed
        || matches!(
            decision.action,
            WorkflowDecisionAction::AwaitPermission | WorkflowDecisionAction::Blocked
        )
    {
        return LlmPhaseAdvance::Stop;
    }
    match phase {
        "plan" => LlmPhaseAdvance::Stop,
        "check" => LlmPhaseAdvance::Continue(WorkflowPhase::Complete),
        "complete" => {
            if matches!(
                decision.action,
                WorkflowDecisionAction::Review | WorkflowDecisionAction::Done
            ) {
                LlmPhaseAdvance::Continue(WorkflowPhase::Review)
            } else {
                LlmPhaseAdvance::Stop
            }
        }
        "review" => {
            if matches!(decision.action, WorkflowDecisionAction::Done) {
                LlmPhaseAdvance::Finish
            } else {
                LlmPhaseAdvance::Stop
            }
        }
        _ => LlmPhaseAdvance::Stop,
    }
}

pub(crate) fn compile_llm_request_envelope(
    phase: &str,
    input_text: &str,
    decision_state: &RunDecisionState,
    context_snapshot_id: Option<&str>,
) -> Value {
    let system = compile_kernel_phase_instruction(phase, decision_state);
    let tools = if phase == "complete" {
        kernel_visible_tool_schemas()
    } else {
        Vec::new()
    };
    serde_json::json!({
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": input_text }
        ],
        "tools": tools,
        "contextSnapshotId": context_snapshot_id,
        "answerObligations": decision_state.answer_obligations,
        "completionCriteria": {
            "tempLifecycleRequired": decision_state.temp_lifecycle_required,
            "workspaceSummaryRequired": decision_state.workspace_summary_required,
            "toolComponentRequired": decision_state.tool_component_required,
            "workspaceSummaryFilePath": decision_state.workspace_summary_file_path,
            "pendingSteps": decision_state.pending_steps()
        }
    })
}

pub(crate) fn compile_kernel_phase_instruction(
    phase: &str,
    decision_state: &RunDecisionState,
) -> String {
    let stage_instruction = match phase {
        "plan" => "你是 DeepCode 的计划草案生成器。只输出 USER_PLAN、ACTION_BUNDLE、EXPECTED_VALIDATION、REVIEW_GUIDE 四个标签块；ACTION_BUNDLE 必须是 JSON，且只是执行草案，不是授权或执行事实。",
        "check" => "当前检查由 Kernel PlanReview 自动完成。若收到本阶段请求，只输出一句说明：应返回 PlanReview 等待用户确认，不得输出新的检查报告。",
        "complete" => "你是 DeepCode 的执行草案到工具调用适配器。需要本地操作时只能发起 Kernel 提供的工具调用；不要输出自然语言开场白，不要声称工具已经执行，不回答身份信息或最终总结。",
        "review" => "你是 DeepCode 的 Review guidance 生成器。只能根据 Kernel 工具事实、权限结果和验证候选输出用户审查建议与最终摘要；不得补造 Kernel facts，不得替用户接受验收。",
        _ => "你是 DeepCode Kernel 调度的 Agent 阶段。",
    };
    let mut prompt = format!(
        "{stage_instruction}\n\n\
        输出语言根据用户问题决定。自然语言永远不可执行，权限摘要只能来自 Kernel PlanReview。\n\
        plan 阶段输出格式必须是：<USER_PLAN>...</USER_PLAN>、<ACTION_BUNDLE format=\"json\" version=\"1\">{{...}}</ACTION_BUNDLE>、<EXPECTED_VALIDATION>...</EXPECTED_VALIDATION>、<REVIEW_GUIDE>...</REVIEW_GUIDE>。\n\
        ACTION_BUNDLE JSON 必须使用 camelCase 字段：version、id、goal、actions、validationExpectations、reviewExpectations；每个 action 至少包含 id、title、capability、kind、resourceScope。\n\
        工具路径必须是工作区相对路径，禁止 /tmp、绝对路径和 ..。\n\
        DeepCode 允许的工具名仅有：fs.list、fs.read、fs.write、fs.delete、code.search、shell.exec；\n\
        严禁出现 list_dir、write_file、read_file、delete_file、execute_command、list_files 等非 DeepCode 命名；\n\
        引用工具时必须使用 fs.list/fs.read/fs.write/fs.delete/code.search/shell.exec 的精确写法，可见工具目录以 requestEnvelope.tools 为准。\n\
        fs.delete 是隐藏的内核受控能力，不在普通模型工具目录中；临时测试文件清理由 Kernel 受控流程完成。\n\
        Plan 生成后必须等待 Kernel PlanReview 与用户计划确认；执行后必须进入 Review guidance，不单独输出 final 卡。\n\
        不要重复已经满足的 AnswerObligation。\n\
        当前待满足步骤：{}",
        decision_state.pending_steps().join("；")
    );
    // review 阶段把 Kernel 工具事实作为唯一事实源注入 prompt；LLM 只能输出 guidance，
    // 不允许从对话历史推断或补造"哪个工具失败 / 哪个工具不可用"。
    if phase == "review" && !decision_state.evidence.is_empty() {
        let evidence_json = serde_json::to_string_pretty(&decision_state.evidence)
            .unwrap_or_else(|_| "[]".to_string());
        prompt.push_str(&format!(
            "\n\nKernel 工具事实证据（review/final 必须以此为唯一事实源；evidence 中 status=ok 即代表该工具调用成功，不得再说\"无法执行\"或\"工具不可用\"）：\n```json\n{evidence_json}\n```",
        ));
    }
    prompt
}

pub(crate) fn kernel_visible_tool_schemas() -> Vec<Value> {
    vec![
        serde_json::json!({
            "name": "fs.list",
            "description": "List a workspace directory tree with bounded depth.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "folderId": { "type": "string" }
                }
            }
        }),
        serde_json::json!({
            "name": "fs.read",
            "description": "Read a text file from the active workspace.",
            "inputSchema": {
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": { "type": "string" },
                    "folderId": { "type": "string" }
                }
            }
        }),
        serde_json::json!({
            "name": "fs.diff",
            "description": "Preview a file diff without writing.",
            "inputSchema": {
                "type": "object",
                "required": ["path", "newContent"],
                "properties": {
                    "path": { "type": "string" },
                    "newContent": { "type": "string" },
                    "folderId": { "type": "string" }
                }
            }
        }),
        serde_json::json!({
            "name": "code.search",
            "description": "Search text across the workspace.",
            "inputSchema": {
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": { "type": "string" },
                    "isRegex": { "type": "boolean" },
                    "include": { "type": "array", "items": { "type": "string" } },
                    "folderId": { "type": "string" }
                }
            }
        }),
        serde_json::json!({
            "name": "fs.write",
            "description": "Write a text file after explicit permission approval.",
            "inputSchema": {
                "type": "object",
                "required": ["path", "content"],
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" },
                    "folderId": { "type": "string" }
                }
            }
        }),
        serde_json::json!({
            "name": "shell.propose",
            "description": "Propose a shell command without executing it.",
            "inputSchema": {
                "type": "object",
                "required": ["command"],
                "properties": {
                    "command": { "type": "string" },
                    "reason": { "type": "string" }
                }
            }
        }),
        serde_json::json!({
            "name": "shell.exec",
            "description": "Run a command in a Kernel controlled shell after explicit approval.",
            "inputSchema": {
                "type": "object",
                "required": ["command"],
                "properties": {
                    "command": { "type": "string" },
                    "cwd": { "type": "string" },
                    "timeoutMs": { "type": "number" },
                    "reason": { "type": "string" }
                }
            }
        }),
    ]
}

pub(crate) fn extract_llm_tool_calls(response_envelope: &Value) -> Vec<KernelLlmToolCall> {
    response_envelope
        .pointer("/assistantMessage/toolCalls")
        .or_else(|| response_envelope.get("toolCalls"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item.get("name").and_then(Value::as_str)?;
                    Some(KernelLlmToolCall {
                        id: item
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("tool-call")
                            .to_string(),
                        name: name.to_string(),
                        arguments: item
                            .get("arguments")
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({})),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}
