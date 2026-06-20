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
        let mut state = Self::default();
        if has_identity_request(input, &lower) {
            state.answer_obligations.push(AnswerObligation {
                id: AnswerObligationId::Identity,
                description: "Answer the Agent identity exactly once in final/review output."
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
            KernelEvent::ToolRequested { .. } => {}
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
            }
            KernelEvent::ProposalRejected { reason, .. } => {
                self.blocked_reason = Some(reason.clone());
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
        Vec::new()
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

fn has_identity_request(input: &str, lower: &str) -> bool {
    input.contains("身份")
        || input.contains("你是谁")
        || lower.contains("identity")
        || lower.contains("who are you")
}

fn extract_tool_path(
    tool_name: &str,
    output: &Option<Value>,
    error: &Option<deepcode_kernel_abi::KernelErrorEnvelope>,
) -> Option<String> {
    match tool_name {
        "fs.list" | "fs.read" | "fs.write" | "fs.patch" | "fs.delete" | "code.search" => output
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
        KernelEvent::StateEntered { .. } => "state.entered",
        KernelEvent::DriverRequestProduced { .. } => "driver.request_produced",
        KernelEvent::ProposalAccepted { .. } => "proposal.accepted",
        KernelEvent::ProposalReviewed { .. } => "proposal.reviewed",
        KernelEvent::ProposalRejected { .. } => "proposal.rejected",
        KernelEvent::ResourcePacketProduced { .. } => "resource.packet_produced",
        KernelEvent::ArtifactRegistered { .. } => "artifact.registered",
        KernelEvent::DraftOpen { .. } => "draft.open",
        KernelEvent::DraftChunk { .. } => "draft.chunk",
        KernelEvent::DraftFileCompleted { .. } => "draft.file_completed",
        KernelEvent::DraftBatchCompleted { .. } => "draft.batch_completed",
        KernelEvent::DraftDiscarded { .. } => "draft.discarded",
        KernelEvent::DraftCommitted { .. } => "draft.committed",
        KernelEvent::ActionBatchAccepted { .. } => "action_batch.accepted",
        KernelEvent::WorkUnitQueued { .. } => "work_unit.queued",
        KernelEvent::WorkUnitStarted { .. } => "work_unit.started",
        KernelEvent::WorkUnitCompleted { .. } => "work_unit.completed",
        KernelEvent::WorkUnitFailed { .. } => "work_unit.failed",
        KernelEvent::WorkUnitBlocked { .. } => "work_unit.blocked",
        KernelEvent::ReviewFactsProduced { .. } => "review.facts_produced",
        KernelEvent::ReviewGateEvaluated { .. } => "review_gate.evaluated",
        KernelEvent::RunCompleted { .. } => "run.completed",
        KernelEvent::StageChanged { .. } => "stage.changed",
        KernelEvent::MessageAppended { .. } => "message.appended",
        KernelEvent::LlmProviderError { .. } => "llm.provider_error",
        KernelEvent::ToolRequested { .. } => "tool.requested",
        KernelEvent::ToolCompleted { .. } => "tool.completed",
        KernelEvent::PermissionRequested { .. } => "permission.requested",
        KernelEvent::PermissionResolved { .. } => "permission.resolved",
        KernelEvent::AutonomyTransitioned { .. } => "autonomy.transitioned",
        KernelEvent::ConfigSnapshotAttached { .. } => "config.snapshot.attached",
        KernelEvent::WorkflowCheckpointed { .. } => "workflow.checkpointed",
        KernelEvent::WorkflowResumed { .. } => "workflow.resumed",
        KernelEvent::WorkflowDecisionMade { .. } => "workflow.decision_made",
        KernelEvent::WorkspaceResult { .. } => "workspace.result",
        KernelEvent::SkillResult { .. } => "skill.result",
        KernelEvent::SkillTrustRequested { .. } => "skill.trust_requested",
        KernelEvent::SkillTrustGranted { .. } => "skill.trust_granted",
        KernelEvent::McpRiskAcknowledgmentRequired { .. } => "mcp.risk_acknowledgment_required",
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
        KernelEvent::StateEntered { sequence, .. }
        | KernelEvent::DriverRequestProduced { sequence, .. }
        | KernelEvent::ProposalAccepted { sequence, .. }
        | KernelEvent::ProposalReviewed { sequence, .. }
        | KernelEvent::ProposalRejected { sequence, .. }
        | KernelEvent::ResourcePacketProduced { sequence, .. }
        | KernelEvent::ArtifactRegistered { sequence, .. }
        | KernelEvent::DraftOpen { sequence, .. }
        | KernelEvent::DraftChunk { sequence, .. }
        | KernelEvent::DraftFileCompleted { sequence, .. }
        | KernelEvent::DraftBatchCompleted { sequence, .. }
        | KernelEvent::DraftDiscarded { sequence, .. }
        | KernelEvent::DraftCommitted { sequence, .. }
        | KernelEvent::ActionBatchAccepted { sequence, .. }
        | KernelEvent::WorkUnitQueued { sequence, .. }
        | KernelEvent::WorkUnitStarted { sequence, .. }
        | KernelEvent::WorkUnitCompleted { sequence, .. }
        | KernelEvent::WorkUnitFailed { sequence, .. }
        | KernelEvent::WorkUnitBlocked { sequence, .. }
        | KernelEvent::ReviewFactsProduced { sequence, .. }
        | KernelEvent::ReviewGateEvaluated { sequence, .. }
        | KernelEvent::RunCompleted { sequence, .. }
        | KernelEvent::StageChanged { sequence, .. }
        | KernelEvent::MessageAppended { sequence, .. }
        | KernelEvent::LlmProviderError { sequence, .. }
        | KernelEvent::ToolRequested { sequence, .. }
        | KernelEvent::ToolCompleted { sequence, .. }
        | KernelEvent::PermissionRequested { sequence, .. }
        | KernelEvent::PermissionResolved { sequence, .. }
        | KernelEvent::AutonomyTransitioned { sequence, .. }
        | KernelEvent::ConfigSnapshotAttached { sequence, .. }
        | KernelEvent::WorkflowCheckpointed { sequence, .. }
        | KernelEvent::WorkflowResumed { sequence, .. }
        | KernelEvent::WorkflowDecisionMade { sequence, .. }
        | KernelEvent::WorkspaceResult { sequence, .. }
        | KernelEvent::SkillResult { sequence, .. }
        | KernelEvent::SkillTrustRequested { sequence, .. }
        | KernelEvent::SkillTrustGranted { sequence, .. }
        | KernelEvent::McpRiskAcknowledgmentRequired { sequence, .. }
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
