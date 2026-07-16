use super::*;

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
        decision: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?.clone();
        let session_id_text = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| record.session_id.clone());
        let facts = review_facts_for_run(self, &*self.ledger, &run_id.0, &record)?;
        let failed_count = facts.failed_work_units.len();
        let blocked_count = facts.blocked_work_units.len();
        let cleanup_failure_count = facts.cleanup_failures.len();
        let decision_kind = decision
            .get("decision")
            .and_then(Value::as_str)
            .unwrap_or("needsUserReview");
        let status = match decision_kind {
            "accept" if failed_count == 0 && blocked_count == 0 && cleanup_failure_count == 0 => {
                "accepted"
            }
            "accept" | "revise" => "needsReplan",
            "reject" => "aborted",
            _ => "needsUserReview",
        };
        let summary = match status {
            "accepted" => "ReviewGate accepted Kernel facts and user review decision.",
            "needsReplan" => "ReviewGate requires replan before completion.",
            "aborted" => "ReviewGate aborted by user decision.",
            _ => "ReviewGate still needs user review.",
        };
        let cleanup =
            self.release_run_resources(&run_id.0, &session_id_text, "reviewGateEvaluated")?;
        let result = serde_json::json!({
            "id": format!("review-{}", run_id.0),
            "runId": run_id.0,
            "status": status,
            "decision": decision,
            "failedWorkUnitCount": failed_count,
            "blockedWorkUnitCount": blocked_count,
            "cleanupFailureCount": cleanup_failure_count,
            "revokedTemporaryGrantCount": cleanup.revoked_grant_count,
            "releasedResourceCount": cleanup.released_resource_count,
            "removedTempFileCount": cleanup.removed_temp_file_count,
            "cleanupFailures": &cleanup.failures,
            "summary": summary,
            "factsRef": facts.facts_ref
        });
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
            "accepted" | "aborted" => Some(RuntimeLifecycleState::Terminal),
            "needsReplan" => Some(RuntimeLifecycleState::Ready),
            _ => None,
        };
        if let Some(next_state) = next_state {
            if let Some(event) = self.transition_runtime_lifecycle(
                None,
                &run_id.0,
                &session_id_text,
                next_state,
                format!("reviewGate:{status}"),
            )? {
                events.push(event);
            }
        }
        Ok(events)
    }
}
