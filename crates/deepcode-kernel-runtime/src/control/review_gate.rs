use super::*;
use deepcode_kernel_abi::{
    ReviewGateDecision, ReviewGateDecisionKind, ReviewGateEvaluation, ReviewGateStatus,
};

impl DeepCodeKernelRuntime {
    pub(crate) fn review_gate_cleanup_retry_event(
        &mut self,
        request_id: RequestId,
        run_id: &str,
        session_id: &str,
        checkpoint: &KernelCleanupCheckpoint,
        cleanup: &crate::resources::RunResourceCleanupSummary,
    ) -> KernelResult<Option<KernelEvent>> {
        let Some(decision) = checkpoint.review_decision.clone() else {
            return Ok(None);
        };
        let status = match checkpoint.scope {
            KernelCleanupScope::Plan => ReviewGateStatus::NeedsReplan,
            KernelCleanupScope::Run => match checkpoint.intended_run_status {
                Some(RunStatus::Completed) => ReviewGateStatus::Accepted,
                Some(RunStatus::Cancelled) => ReviewGateStatus::Aborted,
                _ => {
                    return Err(KernelError::Structured {
                        code: "run_recovery_schema_invalid",
                        stage: "review.cleanup_retry",
                        message: "review cleanup checkpoint has no terminal run status".to_string(),
                        details: serde_json::json!({ "runId": run_id }),
                    })
                }
            },
            KernelCleanupScope::Batch => return Ok(None),
        };
        let facts = ledger_review_facts_for_run(self.tool_registry, &*self.ledger, run_id)?;
        let summary = match status {
            ReviewGateStatus::Accepted => "ReviewGate cleanup retry completed acceptance.",
            ReviewGateStatus::NeedsReplan => "ReviewGate cleanup retry completed replan cleanup.",
            ReviewGateStatus::Aborted => "ReviewGate cleanup retry completed abort cleanup.",
            ReviewGateStatus::CleanupFailed => unreachable!("retry completion is successful"),
        };
        let result = ReviewGateEvaluation {
            id: format!("review-{run_id}"),
            run_id: run_id.to_string(),
            status,
            decision,
            failed_work_unit_count: facts.failed_work_units.len(),
            blocked_work_unit_count: facts.blocked_work_units.len(),
            cleanup_failure_count: facts.cleanup_failures.len(),
            revoked_temporary_grant_count: cleanup.revoked_grant_count,
            released_resource_count: cleanup.released_resource_count,
            removed_temp_file_count: cleanup.removed_temp_file_count,
            cleanup_failures: Vec::new(),
            summary: summary.to_string(),
            facts_ref: facts.facts_ref,
        };
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "review_gate.evaluated",
            sequence,
            serde_json::json!({
                "summary": summary,
                "result": &result,
                "cleanupRetryAttempt": checkpoint.attempt + 1,
            }),
        )?;
        Ok(Some(KernelEvent::ReviewGateEvaluated {
            request_id: Some(request_id),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            result,
            sequence: Some(sequence),
        }))
    }

    pub(crate) fn review_facts_get(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?.clone();
        let session_id_text = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| record.session_id.clone());
        let facts = review_facts_for_run(self, &*self.ledger, &run_id.0, &record)?;
        let sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &session_id_text,
            "review.facts_produced",
            sequence,
            serde_json::json!({
                "summary": "Kernel review facts produced.",
                "facts": &facts
            }),
        )?;
        Ok(vec![KernelEvent::ReviewFactsProduced {
            request_id: Some(request_id),
            run_id,
            session_id: Some(SessionId(session_id_text)),
            facts,
            sequence: Some(sequence),
        }])
    }

    pub(crate) fn review_gate_evaluate(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        decision: ReviewGateDecision,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?.clone();
        let run_id_text = run_id.0.clone();
        let session_id_text = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| record.session_id.clone());
        let facts = review_facts_for_run(self, &*self.ledger, &run_id.0, &record)?;
        let failed_count = facts.failed_work_units.len();
        let blocked_count = facts.blocked_work_units.len();
        let requested_status = match decision.decision {
            ReviewGateDecisionKind::Accept
                if failed_count == 0
                    && blocked_count == 0
                    && facts.cleanup_failures.is_empty()
                    && facts.indeterminate_tool_outcomes.is_empty() =>
            {
                ReviewGateStatus::Accepted
            }
            ReviewGateDecisionKind::Accept | ReviewGateDecisionKind::Revise => {
                ReviewGateStatus::NeedsReplan
            }
            ReviewGateDecisionKind::Reject => ReviewGateStatus::Aborted,
        };
        let mut events = Vec::new();
        if let Some(event) = self.transition_runtime_lifecycle(
            Some(request_id.clone()),
            &run_id.0,
            &session_id_text,
            RuntimeLifecycleState::Terminating,
            "reviewCleanupStarted",
        )? {
            events.push(event);
        }
        let intended_run_status = match requested_status {
            ReviewGateStatus::Accepted => Some(RunStatus::Completed),
            ReviewGateStatus::Aborted => Some(RunStatus::Cancelled),
            ReviewGateStatus::NeedsReplan | ReviewGateStatus::CleanupFailed => None,
        };
        let cleanup = match requested_status {
            ReviewGateStatus::Accepted | ReviewGateStatus::Aborted => self
                .release_run_resources_with_intent(
                    &run_id.0,
                    &session_id_text,
                    "reviewGateEvaluated",
                    intended_run_status.clone(),
                    Some(decision.clone()),
                )?,
            ReviewGateStatus::NeedsReplan => self
                .release_plan_authorization_resources_with_intent(
                    &run_id.0,
                    &session_id_text,
                    "reviewGateNeedsReplan",
                    Some(decision.clone()),
                )?,
            ReviewGateStatus::CleanupFailed => unreachable!("cleanup status is derived below"),
        };
        events.extend(cleanup.events.clone());
        let status = if cleanup.failures.is_empty() {
            requested_status
        } else {
            ReviewGateStatus::CleanupFailed
        };
        let summary = match status {
            ReviewGateStatus::Accepted => {
                "ReviewGate accepted Kernel facts and user review decision."
            }
            ReviewGateStatus::NeedsReplan => "ReviewGate requires replan before completion.",
            ReviewGateStatus::Aborted => "ReviewGate aborted by user decision.",
            ReviewGateStatus::CleanupFailed => "ReviewGate cleanup failed.",
        };
        let cleanup_failure_count = facts.cleanup_failures.len() + cleanup.failures.len();
        let result = ReviewGateEvaluation {
            id: format!("review-{}", run_id.0),
            run_id: run_id.0.clone(),
            status,
            decision: decision.clone(),
            failed_work_unit_count: failed_count,
            blocked_work_unit_count: blocked_count,
            cleanup_failure_count,
            revoked_temporary_grant_count: cleanup.revoked_grant_count,
            released_resource_count: cleanup.released_resource_count,
            removed_temp_file_count: cleanup.removed_temp_file_count,
            cleanup_failures: cleanup.failures.clone(),
            summary: summary.to_string(),
            facts_ref: facts.facts_ref,
        };
        let sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &session_id_text,
            "review_gate.evaluated",
            sequence,
            serde_json::json!({
                "summary": summary,
                "result": &result,
                "revokedTemporaryGrantCount": cleanup.revoked_grant_count,
                "removedTempFileCount": cleanup.removed_temp_file_count,
                "cleanupFailures": &cleanup.failures
            }),
        )?;
        events.push(KernelEvent::ReviewGateEvaluated {
            request_id: Some(request_id),
            run_id: run_id.clone(),
            session_id: Some(SessionId(session_id_text.clone())),
            result,
            sequence: Some(sequence),
        });
        if status == ReviewGateStatus::CleanupFailed {
            return Ok(events);
        }
        let next_state = match status {
            ReviewGateStatus::Accepted | ReviewGateStatus::Aborted => {
                RuntimeLifecycleState::Terminal
            }
            ReviewGateStatus::NeedsReplan => RuntimeLifecycleState::Ready,
            ReviewGateStatus::CleanupFailed => RuntimeLifecycleState::Terminating,
        };
        if let Some(event) = self.transition_runtime_lifecycle(
            None,
            &run_id.0,
            &session_id_text,
            next_state,
            format!("reviewGate:{}", status.as_str()),
        )? {
            events.push(event);
        }
        if let Some(run_status) = intended_run_status {
            let sequence = self.ledger.next_sequence(&run_id.0)?;
            self.append_ledger(
                &run_id.0,
                &session_id_text,
                "run.completed",
                sequence,
                serde_json::json!({
                    "summary": summary,
                    "status": run_status,
                    "reviewDecision": decision.decision,
                }),
            )?;
            events.push(KernelEvent::RunCompleted {
                run_id,
                session_id: Some(SessionId(session_id_text)),
                status: run_status,
                summary: Some(summary.to_string()),
                sequence: Some(sequence),
            });
        }
        self.state.cleanup_checkpoints_by_run.remove(&run_id_text);
        Ok(events)
    }
}
