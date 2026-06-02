use deepcode_kernel_abi::{
    AnswerObligation, AnswerObligationId, AnswerObligationStatus, KernelEvent, MessageRole,
    PermissionDecisionKind, WorkflowDecision, WorkflowDecisionAction, WorkflowDecisionReason,
};
use serde::Serialize;
use serde_json::Value;

pub trait DecisionEngine {
    fn decide(&self, state: &mut RunDecisionState, phase: &str) -> WorkflowDecision;
}

#[derive(Debug, Clone, Default)]
pub struct RunDecisionState {
    pub answer_obligations: Vec<AnswerObligation>,
    pub temp_lifecycle_required: bool,
    pub workspace_summary_required: bool,
    pub tool_component_required: bool,
    pub workspace_listed: bool,
    pub workspace_file_read: bool,
    pub workspace_search_completed: bool,
    pub workspace_summary_file_path: Option<String>,
    pub temp_created: bool,
    pub temp_read_back: bool,
    pub temp_cleanup_requested: bool,
    pub temp_cleaned: bool,
    pub awaiting_permission: bool,
    pub blocked_reason: Option<String>,
    pub evidence: Vec<WorkflowEvidence>,
    pub current_phase: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEvidence {
    pub tool_name: String,
    pub tool_call_id: Option<String>,
    pub status: String,
    pub path: Option<String>,
    pub permission_decision: Option<String>,
    pub cleanup_status: Option<String>,
    pub kernel_event_refs: Vec<String>,
}

impl RunDecisionState {
    pub fn from_user_input(input: &str) -> Self {
        let lower = input.to_lowercase();
        let tool_component_required = has_tool_component_request(input, &lower);
        let mut state = Self {
            temp_lifecycle_required: has_temp_file_lifecycle_request(input, &lower),
            workspace_summary_required: has_workspace_summary_request(input, &lower),
            tool_component_required,
            ..Self::default()
        };
        if has_identity_request(input, &lower) {
            state.answer_obligations.push(AnswerObligation {
                id: AnswerObligationId::Identity,
                description: "Answer the Agent identity exactly once in final/review output."
                    .to_string(),
                status: AnswerObligationStatus::Pending,
                satisfied_by_event: None,
            });
        }
        if tool_component_required {
            state.answer_obligations.push(AnswerObligation {
                id: AnswerObligationId::ToolComponentSummary,
                description: "Summarize tested tool components once in final/review output."
                    .to_string(),
                status: AnswerObligationStatus::Pending,
                satisfied_by_event: None,
            });
        }
        if state.temp_lifecycle_required {
            state.answer_obligations.push(AnswerObligation {
                id: AnswerObligationId::TempFileLifecycleResult,
                description: "Report temp file create, read verification, and cleanup result once."
                    .to_string(),
                status: AnswerObligationStatus::Pending,
                satisfied_by_event: None,
            });
        }
        state
    }

    pub fn apply_event(&mut self, event: &KernelEvent, phase: &str) {
        self.current_phase = Some(phase.to_string());
        match event {
            KernelEvent::ToolRequested {
                tool_name,
                args_preview,
                ..
            } => {
                if tool_name == "shell.exec"
                    && args_preview
                        .get("command")
                        .and_then(Value::as_str)
                        .map(is_temp_cleanup_command)
                        .unwrap_or(false)
                {
                    self.temp_cleanup_requested = true;
                }
            }
            KernelEvent::ToolCompleted {
                tool_call_id,
                tool_name,
                ok,
                output,
                error,
                ..
            } => {
                self.awaiting_permission = false;
                let event_id = event_identity(event);
                let path = extract_tool_path(tool_name, output, error);
                let cleanup_status = if tool_name == "fs.delete" {
                    Some(if *ok { "cleaned" } else { "failed" }.to_string())
                } else if tool_name == "shell.exec" && self.temp_cleanup_requested {
                    Some(if *ok { "cleaned" } else { "failed" }.to_string())
                } else {
                    None
                };
                self.evidence.push(WorkflowEvidence {
                    tool_name: tool_name.clone(),
                    tool_call_id: Some(tool_call_id.clone()),
                    status: if *ok {
                        "ok".to_string()
                    } else {
                        "failed".to_string()
                    },
                    path,
                    permission_decision: None,
                    cleanup_status,
                    kernel_event_refs: vec![event_id],
                });
                if !ok {
                    self.blocked_reason = Some(
                        error
                            .as_ref()
                            .map(|value| value.message.clone())
                            .unwrap_or_else(|| format!("{tool_name} failed")),
                    );
                    return;
                }
                match tool_name.as_str() {
                    "fs.list" => {
                        self.workspace_listed = true;
                        if self.workspace_summary_file_path.is_none() {
                            self.workspace_summary_file_path =
                                output.as_ref().and_then(find_workspace_summary_file_path);
                        }
                    }
                    "fs.write" => {
                        if output
                            .as_ref()
                            .map(output_mentions_temp_file)
                            .unwrap_or(false)
                        {
                            self.temp_created = true;
                        }
                    }
                    "fs.read" => {
                        let mentions_temp = output
                            .as_ref()
                            .map(output_mentions_temp_file)
                            .unwrap_or(false);
                        if mentions_temp {
                            self.temp_read_back = true;
                        } else if self.workspace_summary_required {
                            self.workspace_file_read = true;
                        }
                    }
                    "code.search" => self.workspace_search_completed = true,
                    "fs.delete" => {
                        if output
                            .as_ref()
                            .map(output_mentions_temp_file)
                            .unwrap_or(false)
                        {
                            self.temp_cleaned = true;
                        }
                    }
                    "shell.exec" => {
                        if self.temp_cleanup_requested {
                            self.temp_cleaned = true;
                        }
                    }
                    _ => {}
                }
            }
            KernelEvent::PermissionRequested { request, .. } => {
                self.awaiting_permission = true;
                self.blocked_reason = Some(format!("awaiting permission {}", request.id));
            }
            KernelEvent::PermissionResolved {
                decision,
                permission_id,
                ..
            } => {
                self.awaiting_permission = false;
                let event_id = event_identity(event);
                let decision_text = match decision {
                    PermissionDecisionKind::Accept => "Accept",
                    PermissionDecisionKind::Reject => "Reject",
                };
                if let Some(last) = self
                    .evidence
                    .iter_mut()
                    .rev()
                    .find(|item| item.permission_decision.is_none())
                {
                    last.permission_decision = Some(decision_text.to_string());
                    last.kernel_event_refs.push(event_id.clone());
                } else {
                    self.evidence.push(WorkflowEvidence {
                        tool_name: format!("permission:{permission_id}"),
                        tool_call_id: None,
                        status: decision_text.to_lowercase(),
                        path: None,
                        permission_decision: Some(decision_text.to_string()),
                        cleanup_status: None,
                        kernel_event_refs: vec![event_id],
                    });
                }
                if matches!(decision, PermissionDecisionKind::Reject) {
                    self.blocked_reason = Some("permission rejected".to_string());
                } else {
                    self.blocked_reason = None;
                }
            }
            KernelEvent::MessageAppended {
                role,
                channel,
                content,
                ..
            } => {
                if !matches!(role, MessageRole::Agent) || channel.as_deref() != Some("final") {
                    return;
                }
                let in_final_phase = self
                    .current_phase
                    .as_deref()
                    .map(|phase| phase == "review" || phase == "complete")
                    .unwrap_or(false);
                if !in_final_phase {
                    return;
                }
                let content = content.as_deref().unwrap_or_default();
                if content_satisfies_identity_obligation(content) {
                    self.satisfy_obligation(AnswerObligationId::Identity, event);
                }
                if content_satisfies_tool_summary_obligation(content) {
                    self.satisfy_obligation(AnswerObligationId::ToolComponentSummary, event);
                }
                if self.temp_lifecycle_complete()
                    && content.contains("临时文件")
                    && (content.contains("删除") || content.contains("清理"))
                {
                    self.satisfy_obligation(AnswerObligationId::TempFileLifecycleResult, event);
                }
            }
            KernelEvent::PlanRejected { reason, .. } => {
                self.blocked_reason = reason.clone().or_else(|| Some("plan rejected".to_string()));
            }
            _ => {}
        }
    }

    pub fn decide(&self, phase: &str) -> WorkflowDecision {
        if self.awaiting_permission {
            return self.decision(
                WorkflowDecisionAction::AwaitPermission,
                WorkflowDecisionReason::AwaitingPermission,
                phase,
                false,
                self.blocked_reason.clone(),
            );
        }

        if let Some(blocked_reason) = &self.blocked_reason {
            return self.decision(
                WorkflowDecisionAction::Blocked,
                WorkflowDecisionReason::ToolFailed,
                phase,
                true,
                Some(blocked_reason.clone()),
            );
        }

        let pending_steps = self.pending_steps();
        if !pending_steps.is_empty() {
            return WorkflowDecision {
                action: WorkflowDecisionAction::Continue,
                reason: WorkflowDecisionReason::PendingCriticalSteps,
                phase: Some(phase.to_string()),
                pending_steps,
                answer_obligations: self.answer_obligations.clone(),
                summary: Some("Continue until completion criteria are satisfied.".to_string()),
                fail_closed: false,
            };
        }

        if self
            .answer_obligations
            .iter()
            .any(|value| value.status == AnswerObligationStatus::Pending)
        {
            if phase != "complete" && phase != "review" {
                return WorkflowDecision {
                    action: WorkflowDecisionAction::Continue,
                    reason: WorkflowDecisionReason::EventAccepted,
                    phase: Some(phase.to_string()),
                    pending_steps,
                    answer_obligations: self.answer_obligations.clone(),
                    summary: Some(
                        "Advance through structured workflow before final obligations.".to_string(),
                    ),
                    fail_closed: false,
                };
            }
            return self.decision(
                WorkflowDecisionAction::Review,
                WorkflowDecisionReason::CompletionCriteriaSatisfied,
                phase,
                false,
                Some("Completion criteria are satisfied; final obligations remain.".to_string()),
            );
        }

        self.decision(
            WorkflowDecisionAction::Done,
            WorkflowDecisionReason::AnswerObligationsSatisfied,
            phase,
            false,
            Some("Completion criteria and answer obligations are satisfied.".to_string()),
        )
    }

    pub fn pending_steps(&self) -> Vec<String> {
        let mut steps = Vec::new();
        if (self.workspace_summary_required
            || self.tool_component_required
            || self.temp_lifecycle_required)
            && !self.workspace_listed
        {
            steps.push("list workspace root".to_string());
        }
        if self.workspace_summary_required && !self.workspace_file_read {
            steps.push("read at least one workspace file before summarizing".to_string());
        }
        if self.tool_component_required && !self.workspace_search_completed {
            steps.push("run workspace search to verify code.search component".to_string());
        }
        if !self.temp_lifecycle_required {
            return steps;
        }
        if !self.temp_created {
            steps.push("create _agent_tmp_* workspace-relative temp file".to_string());
        }
        if !self.temp_read_back {
            steps.push("read and verify _agent_tmp_* temp file".to_string());
        }
        if !self.temp_cleaned {
            steps.push("cleanup _agent_tmp_* temp file through controlled path".to_string());
        }
        steps
    }

    pub fn temp_lifecycle_complete(&self) -> bool {
        !self.temp_lifecycle_required
            || (self.workspace_listed
                && self.temp_created
                && self.temp_read_back
                && self.temp_cleaned)
    }

    fn satisfy_obligation(&mut self, id: AnswerObligationId, event: &KernelEvent) {
        if let Some(obligation) = self
            .answer_obligations
            .iter_mut()
            .find(|obligation| obligation.id == id)
        {
            obligation.status = AnswerObligationStatus::Satisfied;
            obligation.satisfied_by_event = Some(event_identity(event));
        }
    }

    fn decision(
        &self,
        action: WorkflowDecisionAction,
        reason: WorkflowDecisionReason,
        phase: &str,
        fail_closed: bool,
        summary: Option<String>,
    ) -> WorkflowDecision {
        WorkflowDecision {
            action,
            reason,
            phase: Some(phase.to_string()),
            pending_steps: self.pending_steps(),
            answer_obligations: self.answer_obligations.clone(),
            summary,
            fail_closed,
        }
    }
}

fn content_satisfies_identity_obligation(content: &str) -> bool {
    let lower = content.to_lowercase();
    content.contains("DeepCode Agent")
        || (content.contains("DeepCode") && (content.contains("我是") || lower.contains("agent")))
}

fn content_satisfies_tool_summary_obligation(content: &str) -> bool {
    [
        "fs.read",
        "fs.list",
        "fs.write",
        "fs.delete",
        "code.search",
        "工具",
        "组件",
    ]
    .iter()
    .any(|needle| content.contains(needle))
}

fn has_identity_request(input: &str, lower: &str) -> bool {
    input.contains("身份")
        || input.contains("你是谁")
        || lower.contains("identity")
        || lower.contains("who are you")
}

fn has_tool_component_request(input: &str, lower: &str) -> bool {
    input.contains("功能组件")
        || input.contains("各组件")
        || input.contains("所有组件")
        || input.contains("所有的功能")
        || input.contains("工具组件")
        || input.contains("组件正常")
        || input.contains("调用各组件")
        || input.contains("测试agent")
        || lower.contains("action type")
        || lower.contains("tool component")
}

fn has_workspace_summary_request(input: &str, lower: &str) -> bool {
    input.contains("读取当前工作区")
        || (input.contains("工作区") && input.contains("总结"))
        || (input.contains("当前项目") && input.contains("总结"))
        || lower.contains("read current workspace")
        || lower.contains("summarize workspace")
        || lower.contains("workspace summary")
}

fn has_temp_file_lifecycle_request(input: &str, lower: &str) -> bool {
    input.contains("临时文件")
        || input.contains("读写")
        || (input.contains("新建") && input.contains("删除"))
        || lower.contains("temporary file")
        || lower.contains("temp file")
}

fn is_temp_file_path(value: &str) -> bool {
    value.contains("_agent_tmp_")
}

fn is_temp_cleanup_command(command: &str) -> bool {
    let lower = command.to_lowercase();
    is_temp_file_path(command)
        && (lower.contains("rm ")
            || lower.contains(" rm")
            || lower.starts_with("rm")
            || lower.contains("del ")
            || lower.contains("remove-item"))
}

fn extract_tool_path(
    tool_name: &str,
    output: &Option<Value>,
    error: &Option<deepcode_kernel_abi::KernelErrorEnvelope>,
) -> Option<String> {
    match tool_name {
        "fs.list" | "fs.read" | "fs.write" | "fs.delete" | "code.search" => output
            .as_ref()
            .and_then(|value| {
                [
                    "path",
                    "file_path",
                    "target",
                    "filePath",
                    "targetPath",
                    "query",
                ]
                .iter()
                .find_map(|key| value.get(*key).and_then(Value::as_str).map(str::to_string))
            })
            .or_else(|| {
                error
                    .as_ref()
                    .and_then(|envelope| envelope.message.split('\'').nth(1).map(str::to_string))
            }),
        "shell.exec" => output.as_ref().and_then(|value| {
            value
                .get("command")
                .and_then(Value::as_str)
                .map(|command| command.chars().take(120).collect::<String>())
        }),
        _ => None,
    }
}

fn output_mentions_temp_file(value: &Value) -> bool {
    match value {
        Value::String(text) => is_temp_file_path(text),
        Value::Array(items) => items.iter().any(output_mentions_temp_file),
        Value::Object(map) => map.values().any(output_mentions_temp_file),
        _ => false,
    }
}

fn find_workspace_summary_file_path(value: &Value) -> Option<String> {
    let mut paths = Vec::new();
    collect_workspace_file_paths(value, &mut paths);
    paths.sort_by_key(|path| workspace_summary_path_score(path));
    paths.into_iter().next()
}

fn collect_workspace_file_paths(value: &Value, paths: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_workspace_file_paths(item, paths);
            }
        }
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("file") {
                if let Some(path) = map.get("path").and_then(Value::as_str) {
                    if is_workspace_summary_candidate(path) {
                        paths.push(path.to_string());
                    }
                }
            }
            for value in map.values() {
                collect_workspace_file_paths(value, paths);
            }
        }
        _ => {}
    }
}

fn is_workspace_summary_candidate(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    if lower.contains("_agent_tmp_")
        || lower.ends_with(".exe")
        || lower.ends_with(".dll")
        || lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".zip")
        || lower.ends_with(".7z")
    {
        return false;
    }
    [
        ".md", ".txt", ".rs", ".ts", ".tsx", ".js", ".jsx", ".json", ".toml", ".yaml", ".yml",
        ".cpp", ".h", ".hpp", ".c", ".py",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
}

fn workspace_summary_path_score(path: &str) -> (u8, usize, String) {
    let lower = path.to_ascii_lowercase();
    let priority = if lower.ends_with("readme.md") {
        0
    } else if lower.ends_with(".md") {
        1
    } else if lower.ends_with(".txt") {
        2
    } else if lower.ends_with(".json") || lower.ends_with(".toml") || lower.ends_with(".yaml") {
        3
    } else {
        4
    };
    (priority, path.len(), lower)
}

fn event_identity(event: &KernelEvent) -> String {
    format!(
        "{}:{}",
        event_kind(event),
        event_sequence(event)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    )
}

fn event_kind(event: &KernelEvent) -> &'static str {
    match event {
        KernelEvent::HostStatus { .. } => "host.status",
        KernelEvent::SnapshotReady { .. } => "snapshot.ready",
        KernelEvent::RunStarted { .. } => "run.started",
        KernelEvent::RunCompleted { .. } => "run.completed",
        KernelEvent::StageChanged { .. } => "stage.changed",
        KernelEvent::MessageAppended { .. } => "message.appended",
        KernelEvent::LlmCallRequested { .. } => "llm.call_requested",
        KernelEvent::ToolRequested { .. } => "tool.requested",
        KernelEvent::ToolCompleted { .. } => "tool.completed",
        KernelEvent::PermissionRequested { .. } => "permission.requested",
        KernelEvent::PermissionResolved { .. } => "permission.resolved",
        KernelEvent::AutonomyTransitioned { .. } => "autonomy.transitioned",
        KernelEvent::ConfigSnapshotAttached { .. } => "config.snapshot.attached",
        KernelEvent::PlanProposed { .. } => "plan.proposed",
        KernelEvent::PlanAccepted { .. } => "plan.accepted",
        KernelEvent::PlanRejected { .. } => "plan.rejected",
        KernelEvent::PlanReviewReportProduced { .. } => "plan.review_report_produced",
        KernelEvent::WorkflowCheckpointed { .. } => "workflow.checkpointed",
        KernelEvent::WorkflowResumed { .. } => "workflow.resumed",
        KernelEvent::WorkflowDecisionMade { .. } => "workflow.decision_made",
        KernelEvent::WorkspaceResult { .. } => "workspace.result",
        KernelEvent::SkillResult { .. } => "skill.result",
        KernelEvent::SkillTrustRequested { .. } => "skill.trust_requested",
        KernelEvent::SkillTrustGranted { .. } => "skill.trust_granted",
        KernelEvent::McpRiskAcknowledgmentRequired { .. } => "mcp.risk_acknowledgment_required",
        KernelEvent::ContextResult { .. } => "context.result",
        KernelEvent::AuditVerifyStarted { .. } => "audit.verify_started",
        KernelEvent::AuditVerifyCompleted { .. } => "audit.verify_completed",
        KernelEvent::AuditDegradedEntered { .. } => "audit.degraded_entered",
        KernelEvent::AuditDegradedExited { .. } => "audit.degraded_exited",
        KernelEvent::AuditSegmentRotated { .. } => "audit.segment_rotated",
        KernelEvent::TempArtifactCreated { .. } => "tempArtifact.created",
        KernelEvent::TempArtifactCleaned { .. } => "tempArtifact.cleaned",
        KernelEvent::TempArtifactLeaseGranted { .. } => "tempArtifact.lease_granted",
        KernelEvent::TempArtifactLeaseReleased { .. } => "tempArtifact.lease_released",
        KernelEvent::TempArtifactLeasePromoted { .. } => "tempArtifact.lease_promoted",
        KernelEvent::TempCleanupFailed { .. } => "tempCleanup.failed",
        KernelEvent::Error { .. } => "error",
    }
}

fn event_sequence(event: &KernelEvent) -> Option<u64> {
    match event {
        KernelEvent::RunStarted { sequence, .. }
        | KernelEvent::RunCompleted { sequence, .. }
        | KernelEvent::StageChanged { sequence, .. }
        | KernelEvent::MessageAppended { sequence, .. }
        | KernelEvent::LlmCallRequested { sequence, .. }
        | KernelEvent::ToolRequested { sequence, .. }
        | KernelEvent::ToolCompleted { sequence, .. }
        | KernelEvent::PermissionRequested { sequence, .. }
        | KernelEvent::PermissionResolved { sequence, .. }
        | KernelEvent::AutonomyTransitioned { sequence, .. }
        | KernelEvent::ConfigSnapshotAttached { sequence, .. }
        | KernelEvent::PlanProposed { sequence, .. }
        | KernelEvent::PlanAccepted { sequence, .. }
        | KernelEvent::PlanRejected { sequence, .. }
        | KernelEvent::PlanReviewReportProduced { sequence, .. }
        | KernelEvent::WorkflowCheckpointed { sequence, .. }
        | KernelEvent::WorkflowResumed { sequence, .. }
        | KernelEvent::WorkflowDecisionMade { sequence, .. }
        | KernelEvent::WorkspaceResult { sequence, .. }
        | KernelEvent::SkillResult { sequence, .. }
        | KernelEvent::SkillTrustRequested { sequence, .. }
        | KernelEvent::SkillTrustGranted { sequence, .. }
        | KernelEvent::McpRiskAcknowledgmentRequired { sequence, .. }
        | KernelEvent::ContextResult { sequence, .. }
        | KernelEvent::AuditVerifyStarted { sequence, .. }
        | KernelEvent::AuditVerifyCompleted { sequence, .. }
        | KernelEvent::AuditDegradedEntered { sequence, .. }
        | KernelEvent::AuditDegradedExited { sequence, .. }
        | KernelEvent::AuditSegmentRotated { sequence, .. }
        | KernelEvent::TempArtifactCreated { sequence, .. }
        | KernelEvent::TempArtifactCleaned { sequence, .. }
        | KernelEvent::TempArtifactLeaseGranted { sequence, .. }
        | KernelEvent::TempArtifactLeaseReleased { sequence, .. }
        | KernelEvent::TempArtifactLeasePromoted { sequence, .. }
        | KernelEvent::TempCleanupFailed { sequence, .. } => *sequence,
        KernelEvent::HostStatus { .. }
        | KernelEvent::SnapshotReady { .. }
        | KernelEvent::Error { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_state_blocks_identity_until_final_phase() {
        let mut state = RunDecisionState::from_user_input("返回你的身份信息");
        let event = KernelEvent::MessageAppended {
            run_id: None,
            session_id: None,
            turn_id: None,
            role: MessageRole::Agent,
            channel: Some("final".to_string()),
            content: Some("我是 DeepCode Agent".to_string()),
            message_key: None,
            args: None,
            sequence: Some(1),
        };
        state.apply_event(&event, "plan");
        assert_eq!(
            state.answer_obligations[0].status,
            AnswerObligationStatus::Pending
        );
        state.apply_event(&event, "review");
        assert_eq!(
            state.answer_obligations[0].status,
            AnswerObligationStatus::Satisfied
        );
    }
}
