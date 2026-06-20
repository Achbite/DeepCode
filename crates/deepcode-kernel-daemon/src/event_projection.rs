#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

pub(crate) fn record_kernel_events(state: &AppState, events: &[KernelEvent]) {
    if events.is_empty() {
        return;
    }
    let mut log = state
        .kernel_events
        .lock()
        .expect("kernel event stream lock");
    log.extend(events.iter().cloned());
    const MAX_KERNEL_EVENT_CACHE: usize = 512;
    if log.len() > MAX_KERNEL_EVENT_CACHE {
        let overflow = log.len() - MAX_KERNEL_EVENT_CACHE;
        log.drain(0..overflow);
    }
}

pub(crate) fn kernel_command_session_id(command: &KernelCommand) -> Option<String> {
    serde_json::to_value(command)
        .ok()
        .and_then(|value| value.get("sessionId").cloned())
        .and_then(|value| match value {
            Value::String(value) => Some(value),
            Value::Object(map) => map
                .get("0")
                .or_else(|| map.get("value"))
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
}

pub(crate) fn kernel_event_session_id(event: &KernelEvent) -> Option<String> {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value.get("sessionId").cloned())
        .and_then(|value| match value {
            Value::String(value) => Some(value),
            Value::Object(map) => map
                .get("0")
                .or_else(|| map.get("value"))
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
}

pub(crate) fn dispatch_workspace(
    runtime: &SharedRuntime,
    command: KernelCommand,
) -> Result<Value, KernelErrorEnvelope> {
    let mut runtime = runtime.lock().expect("kernel runtime lock");
    let events = runtime
        .dispatch(command)
        .map_err(|error| KernelErrorEnvelope::from(&error))?;
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
        }) => Err(error),
        other => Err(KernelErrorEnvelope {
            code: "unexpected_event".to_string(),
            message: format!("expected workspace result, got {other:?}"),
            message_key: None,
            args: None,
        }),
    }
}

pub(crate) fn dispatch_skill(
    runtime: &SharedRuntime,
    command: KernelCommand,
) -> Result<Value, KernelErrorEnvelope> {
    let mut runtime = runtime.lock().expect("kernel runtime lock");
    let events = runtime
        .dispatch(command)
        .map_err(|error| KernelErrorEnvelope::from(&error))?;
    match events.into_iter().next() {
        Some(KernelEvent::SkillResult {
            ok: true,
            output: Some(output),
            ..
        }) => Ok(output),
        Some(KernelEvent::SkillResult {
            ok: false,
            error: Some(error),
            ..
        }) => Err(error),
        other => Err(KernelErrorEnvelope {
            code: "unexpected_event".to_string(),
            message: format!("expected skill result, got {other:?}"),
            message_key: None,
            args: None,
        }),
    }
}

pub(crate) fn kernel_events_to_agent_events(
    session_id: &str,
    events: &[KernelEvent],
) -> Vec<Value> {
    events
        .iter()
        .flat_map(|event| kernel_event_to_agent_events(session_id, event))
        .collect()
}

pub(crate) fn kernel_event_to_agent_events(session_id: &str, event: &KernelEvent) -> Vec<Value> {
    match event {
        KernelEvent::MessageAppended {
            channel,
            content,
            role,
            message_key,
            ..
        } => match channel.as_deref() {
            Some("plan") | Some("complete") | Some("review") => Vec::new(),
            Some("policy")
                if matches!(role, deepcode_kernel_abi::MessageRole::System)
                    && content.is_none()
                    && message_key.as_deref() == Some("permission.temporaryGrant.created") =>
            {
                vec![agent_event(
                    session_id,
                    "workflow_stage",
                    json!({
                        "stage": "permission",
                        "phase": "permission",
                        "status": "completed",
                        "summary": "Temporary permission grant recorded.",
                        "channel": "task",
                        "visibility": "task",
                        "presentation": "stageSummary",
                        "kernelEvent": event
                    }),
                    &now_text(),
                )]
            }
            Some("reasoning") => vec![agent_event(
                session_id,
                "assistant_msg",
                json!({
                    "content": content,
                    "kind": "reasoning",
                    "channel": "reasoning",
                    "visibility": "trace",
                    "presentation": "traceOnly",
                    "label": "为什么这样做？",
                    "kernelEvent": event
                }),
                &now_text(),
            )],
            _ => vec![agent_event(
                session_id,
                "assistant_msg",
                json!({
                    "content": content,
                    "kind": channel.as_deref().unwrap_or("progress"),
                    "channel": channel.as_deref().unwrap_or("progress"),
                    "visibility": "conversation",
                    "label": if channel.as_deref() == Some("final") { "Agent" } else { "Agent" },
                    "kernelEvent": event
                }),
                &now_text(),
            )],
        },
        KernelEvent::LlmProviderError {
            run_id,
            phase,
            llm_call_id,
            diagnostic,
            ..
        } => vec![agent_event(
            session_id,
            "error",
            json!({
                "message": diagnostic.to_string(),
                "summary": diagnostic.archive_text(),
                "code": "llm_provider_error",
                "providerError": diagnostic,
                "runId": run_id.0,
                "phase": phase,
                "llmCallId": llm_call_id,
                "profileId": diagnostic.profile_id.clone(),
                "model": diagnostic.model.clone(),
                "channel": "error",
                "visibility": "conversation",
                "presentation": "body",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::StateEntered { state_contract, .. } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "state_contract",
                "phase": state_contract.state_id,
                "status": "contract_ready",
                "summary": format!("Kernel state contract ready for {}.", state_contract.state_id),
                "channel": "task",
                "visibility": "task",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::DriverRequestProduced { driver_request, .. } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "driver_request",
                "phase": driver_request.kind,
                "status": "requested",
                "summary": driver_request.reason,
                "channel": "task",
                "visibility": "task",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::ProposalAccepted { proposal, .. } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "proposal",
                "phase": proposal.kind,
                "status": "accepted",
                "summary": format!("Proposal {} accepted.", proposal.proposal_id),
                "channel": "task",
                "visibility": "task",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::ProposalRejected { reason, .. } => vec![agent_event(
            session_id,
            "error",
            json!({
                "message": reason,
                "summary": reason,
                "code": "proposal_rejected",
                "channel": "error",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::ResourcePacketProduced { packet, .. } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "resource_resolve",
                "phase": "resource",
                "status": "packet_produced",
                "summary": packet.get("summary").and_then(Value::as_str).unwrap_or("ResourcePacket produced."),
                "channel": "task",
                "visibility": "task",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::ActionBatchAccepted { batch, .. } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "action_batch",
                "phase": "execution",
                "status": "accepted",
                "summary": "Kernel accepted the action batch for execution.",
                "batch": batch,
                "channel": "task",
                "visibility": "conversation",
                "presentation": "stageSummary",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::WorkUnitQueued { work_unit, .. } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "work_unit",
                "phase": "execution",
                "status": "queued",
                "summary": work_unit.get("title").and_then(Value::as_str).unwrap_or("Work unit queued."),
                "workUnit": work_unit,
                "channel": "task",
                "visibility": "conversation",
                "presentation": "stageSummary",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::WorkUnitStarted { work_unit_id, .. } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "work_unit",
                "phase": "execution",
                "status": "running",
                "summary": format!("Work unit {work_unit_id} started."),
                "workUnitId": work_unit_id,
                "channel": "task",
                "visibility": "conversation",
                "presentation": "stageSummary",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::WorkUnitCompleted {
            work_unit_id,
            output,
            ..
        } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "work_unit",
                "phase": "execution",
                "status": "completed",
                "summary": format!("Work unit {work_unit_id} completed."),
                "workUnitId": work_unit_id,
                "output": output,
                "channel": "task",
                "visibility": "conversation",
                "presentation": "stageSummary",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::WorkUnitFailed {
            work_unit_id,
            error,
            ..
        } => vec![agent_event(
            session_id,
            "error",
            json!({
                "message": error.message.clone(),
                "summary": format!("Work unit {work_unit_id} failed."),
                "code": error.code.clone(),
                "workUnitId": work_unit_id,
                "channel": "error",
                "visibility": "conversation",
                "presentation": "body",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::WorkUnitBlocked {
            work_unit_id,
            reason,
            ..
        } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "work_unit",
                "phase": "execution",
                "status": "blocked",
                "summary": reason,
                "workUnitId": work_unit_id,
                "channel": "task",
                "visibility": "conversation",
                "presentation": "stageSummary",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::ReviewFactsProduced { facts, .. } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "review_facts",
                "phase": "review",
                "status": "completed",
                "summary": "Kernel review facts produced.",
                "facts": facts,
                "channel": "task",
                "visibility": "conversation",
                "presentation": "stageSummary",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::ReviewGateEvaluated { result, .. } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "review_gate",
                "phase": "review",
                "status": result.get("status").and_then(Value::as_str).unwrap_or("needsUserReview"),
                "summary": result.get("summary").and_then(Value::as_str).unwrap_or("Kernel ReviewGate evaluated."),
                "result": result,
                "channel": "task",
                "visibility": "conversation",
                "presentation": "stageSummary",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::StageChanged {
            phase,
            status,
            reason,
            ..
        } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": phase,
                "phase": phase,
                "status": stage_status_for_gui(status),
                "summary": reason.clone().unwrap_or_else(|| format!("Kernel workflow stage {phase} {:?}.", status)),
                "channel": "task",
                "visibility": "task",
                "presentation": "stageSummary",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::RunCompleted {
            status, summary, ..
        } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "workflow",
                "phase": "workflow",
                "status": if matches!(status, deepcode_kernel_abi::RunStatus::Completed) { "completed" } else { "error" },
                "summary": summary.clone().unwrap_or_else(|| "Kernel workflow completed.".to_string()),
                "channel": "task",
                "visibility": "task",
                "presentation": "stageSummary",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::ToolRequested {
            tool_call_id,
            tool_name,
            args_preview,
            ..
        } => vec![agent_event(
            session_id,
            "tool_call",
            json!({
                "id": tool_call_id,
                "name": tool_name,
                "toolName": tool_name,
                "arguments": args_preview,
                "channel": "tool",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::ToolCompleted {
            tool_call_id,
            tool_name,
            ok,
            output,
            error,
            ..
        } => vec![agent_event(
            session_id,
            "tool_result",
            json!({
                "callId": tool_call_id,
                "toolName": tool_name,
                "ok": ok,
                "status": if *ok { "ok" } else { "error" },
                "output": output,
                "error": error.as_ref().map(|value| value.message.clone()),
                "code": error.as_ref().map(|value| value.code.clone()),
                "channel": "tool",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::PermissionRequested { request, .. } => vec![agent_event(
            session_id,
            "permission_request",
            json!({
                "id": request.id,
                "toolName": tool_name_for_capability(&request.capability),
                "capability": request.capability,
                "riskLevel": request.risk_level,
                "summary": request.summary,
                "argumentsPreview": request.args_preview,
                "channel": "tool",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::PermissionResolved {
            permission_id,
            decision,
            ..
        } => vec![agent_event(
            session_id,
            "permission_result",
            json!({
                "permissionId": permission_id,
                "decision": decision,
                "channel": "tool",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::ProposalReviewed {
            proposal_id,
            report,
            ..
        } => {
            let status = report
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("awaitingUserApproval");
            let confirmable = matches!(
                status,
                "autoAccepted" | "awaitingUserApproval" | "awaitingTemporaryGrant" | "pending"
            );
            vec![agent_event(
                session_id,
                "plan_review",
                json!({
                    "title": "Check / 计划确认",
                    "summary": report
                        .get("kernelGeneratedPermissionSummary")
                        .and_then(Value::as_str)
                        .unwrap_or("Kernel PlanReview 已完成，请确认是否同意计划。"),
                    "status": status,
                    "runId": event_run_id(event),
                    "planId": report.get("planId").and_then(Value::as_str).unwrap_or("agent-plan"),
                    "proposalId": proposal_id,
                    "confirmable": confirmable,
                    "requiredPermissions": report.get("requiredPermissions").cloned().unwrap_or_else(|| json!([])),
                    "permissionGaps": report.get("permissionGaps").cloned().unwrap_or_else(|| json!([])),
                    "requiredFileOperations": report.get("requiredFileOperations").cloned().unwrap_or_else(|| json!([])),
                    "permissionBundles": report.get("permissionBundles").cloned().unwrap_or_else(|| json!([])),
                    "interventions": report.get("interventions").cloned().unwrap_or_else(|| json!([])),
                    "executionContract": report.get("executionContract").cloned().unwrap_or_else(|| json!(null)),
                    "report": report,
                    "facts": plan_review_facts(report),
                    "channel": "progress",
                    "visibility": "conversation",
                    "presentation": "body",
                    "kernelEvent": event
                }),
                &now_text(),
            )]
        }
        KernelEvent::WorkflowDecisionMade { decision, .. } => {
            // 阶段 7/8 review 修复：把 stage / status / summary / details 提升到 payload 根字段，
            // 让 GUI MessageList 在事件分类与折叠卡标题渲染时能直接读取根字段，
            // 不再因 payload 只塞 decision 对象而出现"空标题"折叠卡（F4 残留横线根因之一）。
            let phase_text = decision
                .phase
                .clone()
                .unwrap_or_else(|| "workflow".to_string());
            let action_text = format!("{:?}", decision.action).to_lowercase();
            let summary_text = decision
                .summary
                .clone()
                .unwrap_or_else(|| format!("Workflow decision: {action_text}"));
            let details_text = if decision.pending_steps.is_empty() {
                None
            } else {
                Some(decision.pending_steps.join("\n"))
            };
            let mut payload = json!({
                "stage": phase_text,
                "phase": phase_text,
                "status": action_text,
                "summary": summary_text,
                "channel": "task",
                "visibility": "task",
                "presentation": "stageSummary",
                "decision": decision,
                "kernelEvent": event
            });
            if let Some(details) = details_text {
                payload["details"] = json!(details);
            }
            let mut result = vec![agent_event(
                session_id,
                "workflow_decision",
                payload,
                &now_text(),
            )];
            if decision.fail_closed
                || matches!(
                    decision.action,
                    deepcode_kernel_abi::WorkflowDecisionAction::Blocked
                )
            {
                result.push(assistant_final_event(
                    session_id,
                    decision
                        .summary
                        .as_deref()
                        .unwrap_or("Kernel 工作流已阻塞，未满足完成条件。"),
                ));
            }
            result
        }
        KernelEvent::Error { error, .. } => vec![agent_event(
            session_id,
            "error",
            json!({
                "message": error.message,
                "code": error.code,
                "channel": "error",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        // 临时文件生命周期事件投影为 GUI 可见的工具结果条目，确保 fs.write/fs.delete 后产生的
        // TempArtifactCreated / TempArtifactCleaned 在用户消息流中可见或可折叠查看，
        // 避免"工作流是否真的执行完"对用户不可信。
        KernelEvent::TempArtifactCreated { path, .. } => vec![agent_event(
            session_id,
            "tool_result",
            json!({
                "callId": format!("tempArtifact.created:{path}"),
                "toolName": "tempArtifact.created",
                "ok": true,
                "status": "ok",
                "output": {
                    "path": path,
                },
                "channel": "tool",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::TempArtifactCleaned { path, .. } => vec![agent_event(
            session_id,
            "tool_result",
            json!({
                "callId": format!("tempArtifact.cleaned:{path}"),
                "toolName": "tempArtifact.cleaned",
                "ok": true,
                "status": "ok",
                "output": {
                    "path": path,
                },
                "channel": "tool",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::TempCleanupFailed { path, error, .. } => vec![agent_event(
            session_id,
            "tool_result",
            json!({
                "callId": format!("tempArtifact.cleanup_failed:{path}"),
                "toolName": "tempArtifact.cleanup_failed",
                "ok": false,
                "status": "error",
                "error": error.message,
                "code": error.code,
                "output": {
                    "path": path,
                },
                "channel": "tool",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        // 阶段 7/8 新增的 4 个 KernelEvent 显式列出 fall through，避免阶段 6 G3
        // (workflow_decision 静默丢弃) 类问题复发。GUI 是否展示这些事件由阶段 15 收口决定，
        // 当前阶段 7/8 只保证它们不会被悄无声息吞掉。
        KernelEvent::AutonomyTransitioned { .. }
        | KernelEvent::TempArtifactLeaseGranted { .. }
        | KernelEvent::TempArtifactLeaseReleased { .. }
        | KernelEvent::TempArtifactLeasePromoted { .. } => Vec::new(),
        _ => Vec::new(),
    }
}

pub(crate) fn stage_status_for_gui(status: &deepcode_kernel_abi::StageStatus) -> &'static str {
    match status {
        deepcode_kernel_abi::StageStatus::Pending => "updated",
        deepcode_kernel_abi::StageStatus::Running => "started",
        deepcode_kernel_abi::StageStatus::Completed => "completed",
        deepcode_kernel_abi::StageStatus::Blocked | deepcode_kernel_abi::StageStatus::Failed => {
            "error"
        }
    }
}

pub(crate) fn tool_name_for_capability(capability: &str) -> &str {
    match capability {
        "cap.fs.write" => "fs.write",
        "cap.fs.patch" => "fs.patch",
        "cap.fs.delete" => "fs.delete",
        "process.exec" | "cap.shell.exec" => "shell.exec",
        "network.egress" => "web.fetch",
        "git.write" => "git.commit",
        "git.push" => "git.push",
        "browser.control" => "browser.snapshot",
        "cap.skill.executeExternal" => "skill.invoke",
        _ => capability,
    }
}

fn plan_review_facts(report: &Value) -> Vec<String> {
    vec![
        format!(
            "状态：{}",
            report
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ),
        format!(
            "所需能力：{}",
            report_array_text(report, "requiredCapabilities")
        ),
        format!("权限缺口：{}", report_array_text(report, "permissionGaps")),
        format!("文件操作范围：{}", required_file_operations_text(report)),
        format!("拒绝原因：{}", report_array_text(report, "deniedReasons")),
        "用户确认的是 Kernel 执行合约；权限缺口由 Kernel permission bundle / gate intervention 驱动。".to_string(),
    ]
}

fn required_file_operations_text(report: &Value) -> String {
    let Some(items) = report
        .get("requiredFileOperations")
        .and_then(Value::as_array)
    else {
        return "none".to_string();
    };
    let values = items
        .iter()
        .filter_map(|item| {
            let operation = item.get("operation").and_then(Value::as_str)?;
            let target_path = item.get("targetPath").and_then(Value::as_str)?;
            let capability = item.get("capability").and_then(Value::as_str).unwrap_or("");
            let target_kind = item
                .get("targetKind")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            let outside_workspace = item
                .get("outsideWorkspace")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let suffix = match (target_kind, outside_workspace) {
                (Some(kind), true) => format!(",{kind},outsideWorkspace"),
                (Some(kind), false) => format!(",{kind}"),
                (None, true) => ",outsideWorkspace".to_string(),
                (None, false) => String::new(),
            };
            Some(if capability.is_empty() {
                format!("{operation}:{target_path}{suffix}")
            } else {
                format!("{operation}:{target_path}({capability}{suffix})")
            })
        })
        .collect::<Vec<_>>();
    if values.is_empty() {
        "none".to_string()
    } else {
        values.join(",")
    }
}

fn report_array_text(report: &Value, key: &str) -> String {
    report
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            let values = items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            if values.is_empty() {
                "无".to_string()
            } else {
                values.join(", ")
            }
        })
        .unwrap_or_else(|| "无".to_string())
}

fn event_run_id(event: &KernelEvent) -> Option<String> {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value.get("runId").cloned())
        .and_then(|value| match value {
            Value::String(value) => Some(value),
            Value::Object(map) => map
                .get("0")
                .or_else(|| map.get("value"))
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
}

pub(crate) fn assistant_final_event(session_id: &str, content: &str) -> Value {
    agent_event(
        session_id,
        "assistant_msg",
        json!({
            "content": content,
            "channel": "final",
            "visibility": "conversation",
            "label": "Agent"
        }),
        &now_text(),
    )
}

pub(crate) fn agent_event(session_id: &str, kind: &str, payload: Value, ts: &str) -> Value {
    json!({
        "id": format!("evt-{}-{}", kind, now_millis()),
        "sessionId": session_id,
        "ts": ts,
        "kind": kind,
        "payload": payload
    })
}
