use super::*;
use deepcode_kernel_abi::{
    ReviewGateDecision, ReviewGateDecisionKind, ReviewGateEvaluation, ReviewGateStatus,
};

impl DeepCodeKernelRuntime {
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
        let session_id_text = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| record.session_id.clone());
        let facts = review_facts_for_run(self, &*self.ledger, &run_id.0, &record)?;
        let failed_count = facts.failed_work_units.len();
        let blocked_count = facts.blocked_work_units.len();
        let cleanup_failure_count = facts.cleanup_failures.len();
        let status = match decision.decision {
            ReviewGateDecisionKind::Accept
                if failed_count == 0 && blocked_count == 0 && cleanup_failure_count == 0 =>
            {
                ReviewGateStatus::Accepted
            }
            ReviewGateDecisionKind::Accept | ReviewGateDecisionKind::Revise => {
                ReviewGateStatus::NeedsReplan
            }
            ReviewGateDecisionKind::Reject => ReviewGateStatus::Aborted,
        };
        let summary = match status {
            ReviewGateStatus::Accepted => {
                "ReviewGate accepted Kernel facts and user review decision."
            }
            ReviewGateStatus::NeedsReplan => "ReviewGate requires replan before completion.",
            ReviewGateStatus::Aborted => "ReviewGate aborted by user decision.",
        };
        let cleanup = match status {
            ReviewGateStatus::Accepted | ReviewGateStatus::Aborted => {
                self.release_run_resources(&run_id.0, &session_id_text, "reviewGateEvaluated")?
            }
            ReviewGateStatus::NeedsReplan => self.release_plan_authorization_resources(
                &run_id.0,
                &session_id_text,
                "reviewGateNeedsReplan",
            )?,
        };
        let result = ReviewGateEvaluation {
            id: format!("review-{}", run_id.0),
            run_id: run_id.0.clone(),
            status,
            decision,
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
        let mut events = vec![KernelEvent::ReviewGateEvaluated {
            request_id: Some(request_id),
            run_id: run_id.clone(),
            session_id: Some(SessionId(session_id_text.clone())),
            result,
            sequence: Some(sequence),
        }];
        let next_state = match status {
            ReviewGateStatus::Accepted | ReviewGateStatus::Aborted => {
                RuntimeLifecycleState::Terminal
            }
            ReviewGateStatus::NeedsReplan => RuntimeLifecycleState::Ready,
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
        Ok(events)
    }
}
