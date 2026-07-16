use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn proposal_submit(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        proposal: ProposalEnvelope,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?;
        let session_id = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| record.session_id.clone());
        let sequence = self.ledger.next_sequence(&run_id.0)?;
        if proposal.schema_version != "deepcode.agent.protocol.v4" || proposal.run_id != run_id {
            let reason = if proposal.schema_version != "deepcode.agent.protocol.v4" {
                "ProposalEnvelope schemaVersion must be deepcode.agent.protocol.v4"
            } else {
                "ProposalEnvelope runId must match command runId"
            };
            self.append_ledger(
                &run_id.0,
                &session_id,
                "proposal.rejected",
                sequence,
                serde_json::json!({
                    "summary": reason,
                    "proposalId": &proposal.proposal_id,
                    "proposalKind": proposal_kind_name(&proposal.kind),
                    "schemaVersion": &proposal.schema_version
                }),
            )?;
            return Ok(vec![KernelEvent::ProposalRejected {
                request_id: Some(request_id),
                run_id,
                session_id: Some(SessionId(session_id)),
                proposal_id: Some(proposal.proposal_id),
                reason: reason.to_string(),
                diagnostics: None,
                sequence: Some(sequence),
            }]);
        }

        self.append_ledger(
            &run_id.0,
            &session_id,
            "proposal.accepted",
            sequence,
            serde_json::json!({
                "summary": "ProposalEnvelope accepted by Kernel structural validator.",
                "proposalId": &proposal.proposal_id,
                "proposalKind": proposal_kind_name(&proposal.kind),
                "schemaVersion": &proposal.schema_version
            }),
        )?;
        let mut events = vec![KernelEvent::ProposalAccepted {
            request_id: Some(request_id),
            run_id: run_id.clone(),
            session_id: Some(SessionId(session_id)),
            proposal: proposal.clone(),
            sequence: Some(sequence),
        }];

        if proposal.kind == ProposalEnvelopeKind::ActionBundle {
            let outcome = proposal_action_bundle_review_report(
                &proposal,
                &self.tool_runtime_config,
                record.has_workspace_execution_context(),
            );
            let mut report = outcome.report;
            self.authorize_execution_contract_from_plan(
                &run_id.0,
                &record.session_id,
                &proposal,
                &mut report,
            )?;
            let report_value = serde_json::to_value(&report).unwrap_or(serde_json::Value::Null);
            for review in outcome.network_targets {
                let target_sequence = self.ledger.next_sequence(&run_id.0)?;
                self.append_ledger(
                    &run_id.0,
                    &record.session_id,
                    "network.target_reviewed",
                    target_sequence,
                    serde_json::json!({
                        "summary": "Kernel resolved and reviewed an HTTP target.",
                        "contractId": report.execution_contract.id,
                        "contractHash": report.execution_contract.contract_hash,
                        "operationId": review.operation_id,
                        "target": review.target
                    }),
                )?;
            }
            if let Some(contract) = report_value
                .get("executionContract")
                .and_then(serde_json::Value::as_object)
            {
                if let Some(contract_id) = contract.get("id").and_then(serde_json::Value::as_str) {
                    self.state
                        .execution_contracts_by_run
                        .entry(run_id.0.clone())
                        .or_default()
                        .insert(
                            contract_id.to_string(),
                            serde_json::Value::Object(contract.clone()),
                        );
                }
            }
            let report_session_id = events
                .iter()
                .find_map(|event| {
                    if let KernelEvent::ProposalAccepted { session_id, .. } = event {
                        session_id.as_ref().map(|value| value.0.clone())
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| record.session_id.clone());
            let review_sequence = self.ledger.next_sequence(&run_id.0)?;
            self.append_ledger(
                &run_id.0,
                &report_session_id,
                "proposal.reviewed",
                review_sequence,
                serde_json::json!({
                    "summary": format!("Kernel reviewed {} normalized operation(s).", report.execution_contract.operations.len()),
                    "proposalId": &proposal.proposal_id,
                    "status": report.status,
                    "report": &report_value
                }),
            )?;
            events.push(KernelEvent::ProposalReviewed {
                request_id: None,
                run_id,
                session_id: Some(SessionId(report_session_id)),
                proposal_id: proposal.proposal_id,
                report: report_value,
                sequence: Some(review_sequence),
            });
        }

        Ok(events)
    }

    pub(crate) fn user_decision_submit(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        decision: UserDecisionSubmit,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?;
        let session_id = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| record.session_id.clone());
        let sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &session_id,
            "user_decision.submitted",
            sequence,
            serde_json::json!({
                "summary": "User decision recorded for DriverLoop.",
                "decision": &decision
            }),
        )?;
        let contract = self.state_contract_for_record(&record);
        let driver_request = self.driver_request_for_contract(
            &contract,
            Some(SessionId(session_id.clone())),
            DriverRequestKind::NeedProposal,
            "Session should continue after the recorded user decision.",
        );
        let driver_sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &session_id,
            "driver.request_produced",
            driver_sequence,
            serde_json::json!({
                "summary": "DriverRequest produced after user decision.",
                "driverRequest": &driver_request
            }),
        )?;
        Ok(vec![KernelEvent::DriverRequestProduced {
            request_id: Some(request_id),
            run_id,
            session_id: Some(SessionId(session_id)),
            driver_request,
            sequence: Some(driver_sequence),
        }])
    }

    pub(crate) fn run_cancel(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?.clone();
        self.state
            .pending_tools
            .retain(|_, pending| pending.run_id != run_id.0);
        let cancelled_draft_keys = self
            .state
            .artifact_drafts
            .iter()
            .filter_map(|(key, draft)| (draft.run_id == run_id.0).then_some(key.clone()))
            .collect::<Vec<_>>();
        for key in cancelled_draft_keys {
            self.state.artifact_drafts.remove(&key);
            self.state.terminal_artifact_draft_keys.insert(key);
        }
        let cleanup = self.release_run_resources(&run_id.0, &record.session_id, "runCancelled")?;
        let mut events = Vec::new();
        if let Some(event) = self.transition_runtime_lifecycle(
            Some(request_id.clone()),
            &run_id.0,
            &record.session_id,
            RuntimeLifecycleState::Terminal,
            "runCancelled",
        )? {
            events.push(event);
        }
        let sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &record.session_id,
            "run.completed",
            sequence,
            serde_json::json!({
                "summary": "Run cancelled and temporary Kernel resources revoked.",
                "status": "cancelled",
                "requestId": request_id.0,
                "revokedGrantCount": cleanup.revoked_grant_count,
                "releasedResourceCount": cleanup.released_resource_count,
                "removedTempFileCount": cleanup.removed_temp_file_count,
                "cleanupFailures": &cleanup.failures
            }),
        )?;
        events.push(KernelEvent::RunCompleted {
            run_id,
            session_id: Some(SessionId(record.session_id)),
            status: RunStatus::Cancelled,
            summary: Some("Run cancelled by user decision.".to_string()),
            sequence: Some(sequence),
        });
        Ok(events)
    }
}
