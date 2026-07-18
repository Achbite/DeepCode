use crate::prelude::*;
use crate::{now_millis, now_text, AppState, SharedRuntime};
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
    command.session_id().map(|session_id| session_id.0.clone())
}

pub(crate) fn kernel_event_session_id(event: &KernelEvent) -> Option<String> {
    event.session_id().map(|session_id| session_id.0.clone())
}

pub(crate) fn dispatch_host_skill_catalog(
    runtime: &SharedRuntime,
    command: KernelCommand,
) -> Result<HostSkillCatalogResult, KernelErrorEnvelope> {
    let mut runtime = runtime.lock().expect("kernel runtime lock");
    let events = runtime
        .dispatch(command)
        .map_err(|error| KernelErrorEnvelope::from(&error))?;
    for event in events {
        if let KernelEvent::HostSkillsDiscovered { result, .. } = event {
            return Ok(result);
        }
    }
    Err(KernelErrorEnvelope {
        code: "unexpected_event".to_string(),
        message: "expected host skill catalog result".to_string(),
        message_key: None,
        args: None,
    })
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
                    "label": "Agent",
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
                "summary": packet.summary,
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
                "summary": work_unit.title,
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
        KernelEvent::BatchReviewReady { contract_id, .. } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "batch_review_ready",
                "phase": "review",
                "status": "completed",
                "summary": "Kernel WorkUnits reached terminal state; ReviewFacts are ready.",
                "contractId": contract_id,
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
                "status": result.status.as_str(),
                "summary": &result.summary,
                "result": result,
                "channel": "task",
                "visibility": "conversation",
                "presentation": "stageSummary",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::RuntimeLifecycleChanged {
            previous_state,
            current_state,
            reason,
            ..
        } => vec![agent_event(
            session_id,
            "runtime_state",
            json!({
                "stage": current_state.as_str(),
                "lifecycleState": current_state,
                "previousLifecycleState": previous_state,
                "status": runtime_lifecycle_status(*current_state),
                "summary": reason.clone().unwrap_or_else(|| format!("Kernel runtime entered {}.", current_state.as_str())),
                "channel": "task",
                "visibility": "task",
                "presentation": "stageSummary",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::RuntimeResumed {
            lifecycle_state,
            checkpoint_id,
            ..
        } => vec![agent_event(
            session_id,
            "runtime_state",
            json!({
                "stage": "runtime_resumed",
                "lifecycleState": lifecycle_state,
                "checkpointId": checkpoint_id,
                "status": runtime_lifecycle_status(*lifecycle_state),
                "summary": "Kernel runtime resumed from persisted facts.",
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
        KernelEvent::ToolRequested { fact, .. } => vec![agent_event(
            session_id,
            "tool_call",
            json!({
                "id": fact.tool_call_id,
                "name": fact.tool_id,
                "toolId": fact.tool_id,
                "operationKind": fact.operation_kind,
                "arguments": fact.args_preview,
                "channel": "tool",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::ToolCompleted { fact, .. } => vec![agent_event(
            session_id,
            "tool_result",
            json!({
                "callId": fact.tool_call_id,
                "toolId": fact.tool_id,
                "operationKind": fact.operation_kind,
                "ok": fact.ok,
                "status": if fact.ok { "ok" } else { "error" },
                "output": fact.output,
                "error": fact.error.as_ref().map(|value| value.message.clone()),
                "code": fact.error.as_ref().map(|value| value.code.clone()),
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
                "toolName": request.tool_id.as_deref().unwrap_or("kernel.permission"),
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
        KernelEvent::PlanAuthorizationReviewed {
            plan_id, review, ..
        } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "plan_authorization.reviewed",
                "status": "completed",
                "summary": "Kernel compiled the task intent into a plan authorization contract.",
                "runId": event_run_id(event),
                "planId": plan_id,
                "review": review,
                "authorizationContract": review.authorization_contract,
                "channel": "trace",
                "visibility": "debug",
                "presentation": "collapsible",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::PlanAuthorizationDecisionRecorded {
            authorization_contract_id,
            decision,
            lease_id,
            ..
        } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": "plan_authorization.decision_recorded",
                "status": "completed",
                "summary": "Kernel recorded the explicit user decision for the plan authorization contract.",
                "runId": event_run_id(event),
                "authorizationContractId": authorization_contract_id,
                "decision": decision,
                "leaseId": lease_id,
                "channel": "trace",
                "visibility": "debug",
                "presentation": "collapsible",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::ProposalReviewed {
            proposal_id,
            report,
            ..
        } => {
            let status = report.status.as_str();
            let confirmable =
                report.status != deepcode_kernel_abi::KernelExecutionContractStatus::Denied;
            vec![agent_event(
                session_id,
                "plan_review",
                json!({
                    "title": "Check / 计划确认",
                    "summary": "Kernel ProposalReview 已完成，请确认是否同意执行合约。",
                    "status": status,
                    "runId": event_run_id(event),
                    "planId": proposal_id,
                    "proposalId": proposal_id,
                    "confirmable": confirmable,
                    "requiredPermissions": &report.required_permissions,
                    "permissionBundles": &report.execution_contract.permission_bundles,
                    "interventions": &report.execution_contract.interventions,
                    "executionContract": &report.execution_contract,
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
        KernelEvent::AutonomyTransitioned { .. } => Vec::new(),
        _ => Vec::new(),
    }
}

fn runtime_lifecycle_status(state: deepcode_kernel_abi::RuntimeLifecycleState) -> &'static str {
    match state {
        deepcode_kernel_abi::RuntimeLifecycleState::Created
        | deepcode_kernel_abi::RuntimeLifecycleState::Ready => "updated",
        deepcode_kernel_abi::RuntimeLifecycleState::Executing => "started",
        deepcode_kernel_abi::RuntimeLifecycleState::AwaitingPermission => "blocked",
        deepcode_kernel_abi::RuntimeLifecycleState::ReviewReady => "completed",
        deepcode_kernel_abi::RuntimeLifecycleState::Terminating => "started",
        deepcode_kernel_abi::RuntimeLifecycleState::Terminal => "completed",
    }
}

fn plan_review_facts(report: &deepcode_kernel_abi::KernelProposalReviewReport) -> Vec<String> {
    vec![
        format!("状态：{}", report.status.as_str()),
        format!("所需权限：{}", join_or_none(&report.required_permissions)),
        format!("操作数量：{}", report.execution_contract.operations.len()),
        format!("诊断：{}", join_or_none(&report.diagnostics)),
        "用户确认的是 Kernel 执行合约；权限缺口由 Kernel permission bundle / gate intervention 驱动。".to_string(),
    ]
}

fn join_or_none(values: &[String]) -> String {
    if values.is_empty() {
        "none".to_string()
    } else {
        values.join(",")
    }
}

fn event_run_id(event: &KernelEvent) -> Option<String> {
    event.run_id().map(|run_id| run_id.0.clone())
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
