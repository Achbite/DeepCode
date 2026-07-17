use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn append_batch_review_ready_events(
        &mut self,
        events: &mut Vec<KernelEvent>,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        contract_id: &str,
    ) -> KernelResult<()> {
        events.push(self.batch_review_ready_event(request_id, run_id, session_id, contract_id)?);
        if let Some(event) = self.transition_runtime_lifecycle(
            Some(request_id.clone()),
            run_id,
            session_id,
            RuntimeLifecycleState::ReviewReady,
            "batchReviewReady",
        )? {
            events.push(event);
        }
        Ok(())
    }

    pub(crate) fn batch_review_ready_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        contract_id: &str,
    ) -> KernelResult<KernelEvent> {
        let cleanup = self.release_batch_resources(run_id, session_id, "batchReviewReady")?;
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "batch.review_ready",
            sequence,
            serde_json::json!({
                "summary": "All WorkUnits reached a terminal state; ReviewFacts are ready.",
                "contractId": contract_id,
                "revokedTemporaryGrantCount": cleanup.revoked_grant_count,
                "releasedResourceCount": cleanup.released_resource_count,
                "removedTempFileCount": cleanup.removed_temp_file_count,
                "cleanupFailures": cleanup.failures
            }),
        )?;
        Ok(KernelEvent::BatchReviewReady {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            contract_id: contract_id.to_string(),
            sequence: Some(sequence),
        })
    }

    pub(super) fn work_unit_queued_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit: WorkUnitDescriptor,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.queued",
            sequence,
            serde_json::json!({
                "summary": "Work unit queued.",
                "workUnit": &work_unit
            }),
        )?;
        Ok(KernelEvent::WorkUnitQueued {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit,
            sequence: Some(sequence),
        })
    }

    pub(super) fn work_unit_started_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.started",
            sequence,
            serde_json::json!({
                "summary": "Work unit started.",
                "workUnitId": work_unit_id
            }),
        )?;
        Ok(KernelEvent::WorkUnitStarted {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit_id: work_unit_id.to_string(),
            sequence: Some(sequence),
        })
    }

    pub(crate) fn work_unit_completed_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
        output: Option<Value>,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.completed",
            sequence,
            serde_json::json!({
                "summary": "Work unit completed.",
                "workUnitId": work_unit_id,
                "output": output
            }),
        )?;
        Ok(KernelEvent::WorkUnitCompleted {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit_id: work_unit_id.to_string(),
            output,
            sequence: Some(sequence),
        })
    }

    pub(super) fn work_unit_failed_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
        error: &KernelError,
    ) -> KernelResult<KernelEvent> {
        self.work_unit_failed_envelope_event(
            request_id,
            run_id,
            session_id,
            work_unit_id,
            KernelErrorEnvelope::from(error),
        )
    }

    pub(crate) fn work_unit_failed_envelope_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
        error: KernelErrorEnvelope,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.failed",
            sequence,
            serde_json::json!({
                "summary": "Work unit failed.",
                "workUnitId": work_unit_id,
                "error": &error
            }),
        )?;
        Ok(KernelEvent::WorkUnitFailed {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit_id: work_unit_id.to_string(),
            error,
            sequence: Some(sequence),
        })
    }

    pub(crate) fn work_unit_blocked_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
        reason: &str,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.blocked",
            sequence,
            serde_json::json!({
                "summary": "Work unit blocked.",
                "workUnitId": work_unit_id,
                "reason": reason
            }),
        )?;
        Ok(KernelEvent::WorkUnitBlocked {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit_id: work_unit_id.to_string(),
            reason: reason.to_string(),
            sequence: Some(sequence),
        })
    }
}
