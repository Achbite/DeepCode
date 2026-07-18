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
                self.tool_registry,
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
            self.state
                .execution_contracts_by_run
                .entry(run_id.0.clone())
                .or_default()
                .insert(
                    report.execution_contract.id.clone(),
                    report.execution_contract.clone(),
                );
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
                    "report": &report
                }),
            )?;
            events.push(KernelEvent::ProposalReviewed {
                request_id: None,
                run_id,
                session_id: Some(SessionId(report_session_id)),
                proposal_id: proposal.proposal_id,
                report,
                sequence: Some(review_sequence),
            });
        }

        Ok(events)
    }

    pub(crate) fn run_cancel(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?.clone();
        let mut events = Vec::new();
        if let Some(event) = self.transition_runtime_lifecycle(
            Some(request_id.clone()),
            &run_id.0,
            &record.session_id,
            RuntimeLifecycleState::Terminating,
            "runCancellationCleanupStarted",
        )? {
            events.push(event);
        }
        events.extend(self.reject_pending_permissions_for_run(
            &run_id.0,
            &record.session_id,
            "Run cancellation rejected the pending permission request.",
        )?);
        events.extend(self.discard_run_artifact_drafts(
            &request_id,
            &run_id.0,
            &record.session_id,
        )?);
        let cleanup = self.release_run_resources_with_intent(
            &run_id.0,
            &record.session_id,
            "runCancelled",
            Some(RunStatus::Cancelled),
            None,
        )?;
        events.extend(cleanup.events.clone());
        if !cleanup.failures.is_empty() {
            return Ok(events);
        }
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
            run_id: run_id.clone(),
            session_id: Some(SessionId(record.session_id)),
            status: RunStatus::Cancelled,
            summary: Some("Run cancelled by user decision.".to_string()),
            sequence: Some(sequence),
        });
        self.state.cleanup_checkpoints_by_run.remove(&run_id.0);
        Ok(events)
    }

    fn discard_run_artifact_drafts(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
    ) -> KernelResult<Vec<KernelEvent>> {
        let drafts = self
            .state
            .artifact_drafts
            .iter()
            .filter(|(_, draft)| draft.run_id == run_id)
            .map(|(key, draft)| (key.clone(), draft.clone()))
            .collect::<Vec<_>>();
        if drafts.is_empty() {
            return Ok(Vec::new());
        }
        let reason = "Run cancellation discarded the active artifact draft.";
        let first_sequence = self.ledger.next_sequence(run_id)?;
        let mut ledger_events = Vec::with_capacity(drafts.len());
        let mut kernel_events = Vec::with_capacity(drafts.len());
        for (index, (_, draft)) in drafts.iter().enumerate() {
            let sequence = first_sequence + index as u64;
            let frame = deepcode_kernel_abi::ArtifactDraftLedgerFrame::Diagnostic {
                base: deepcode_kernel_abi::ArtifactDraftFrameBase {
                    schema_version: deepcode_kernel_abi::ARTIFACT_DRAFT_SCHEMA_VERSION.to_string(),
                    draft_id: draft.draft_id.clone(),
                    frame_id: format!("kernel-cancel-{}-{}", draft.draft_id, draft.next_sequence),
                    run_id: run_id.to_string(),
                    session_id: session_id.to_string(),
                    task_id: draft.task_id.clone(),
                    sequence: draft.next_sequence,
                    content_hash: deepcode_kernel_tools::fnv1a64_hex(reason),
                    expected_slot_ids: draft.expected_slot_ids.iter().cloned().collect(),
                },
                metadata: deepcode_kernel_abi::ArtifactDraftDiagnosticMetadata {
                    reason: reason.to_string(),
                },
            };
            let fact = deepcode_kernel_abi::ArtifactDraftEvent {
                draft_id: draft.draft_id.clone(),
                status: deepcode_kernel_abi::ArtifactDraftStatus::Discarded,
                frame,
            };
            ledger_events.push(LedgerEvent {
                id: format!("evt-{run_id}-{sequence}"),
                run_id: Some(run_id.to_string()),
                session_id: Some(session_id.to_string()),
                kind: "draft.discarded".to_string(),
                sequence: Some(sequence),
                payload: serde_json::to_value(&fact).map_err(|error| {
                    KernelError::InvalidCommand(format!("encode cancelled artifact draft: {error}"))
                })?,
                created_at: None,
            });
            kernel_events.push(KernelEvent::DraftDiscarded {
                request_id: Some(request_id.clone()),
                run_id: RunId(run_id.to_string()),
                session_id: Some(SessionId(session_id.to_string())),
                draft: fact,
                sequence: Some(sequence),
            });
        }
        self.append_ledger_batch(ledger_events)?;
        for (key, _) in drafts {
            self.state.artifact_drafts.remove(&key);
            self.state.terminal_artifact_draft_keys.insert(key);
        }
        Ok(kernel_events)
    }
}
