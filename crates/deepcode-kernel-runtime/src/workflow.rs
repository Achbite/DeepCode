use super::*;

impl DeepCodeKernelRuntime {
    pub fn config_modified_audit(
        &mut self,
        config_kind: &str,
        changed_keys: Vec<String>,
        store_path: Option<String>,
        old_hash: Option<String>,
        new_hash: Option<String>,
        source: &str,
    ) -> KernelResult<Value> {
        let sequence = self.ledger.list_all()?.len() as u64 + 1;
        let payload = serde_json::json!({
            "summary": "Protected configuration modified.",
            "configKind": config_kind,
            "changedKeys": changed_keys,
            "storePath": store_path,
            "oldHash": old_hash,
            "newHash": new_hash,
            "source": source,
            "message": "配置文件已修改，并已写入 Kernel 审计记录。"
        });
        self.ledger.append(LedgerEvent {
            id: format!("evt-config-modified-{sequence}"),
            run_id: None,
            session_id: None,
            kind: "config.modified".to_string(),
            sequence: Some(sequence),
            payload: payload.clone(),
            created_at: None,
        })?;
        Ok(payload)
    }

    pub(crate) fn run_create(
        &mut self,
        request_id: RequestId,
        session_id: Option<SessionId>,
        input: UserInput,
        workspace_binding: Option<WorkspaceBinding>,
        profile_ref: Option<ProfileRef>,
        workflow_ref: Option<WorkflowRef>,
        run_overrides: Option<Value>,
    ) -> KernelResult<Vec<KernelEvent>> {
        let workspace_binding = workspace_binding.unwrap_or_else(empty_workspace_binding);
        self.state.next_run_index += 1;
        let run_id = format!("run-{}", self.state.next_run_index);
        let session_id = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| format!("session-{}", self.state.next_run_index));
        let workflow_id = workflow_ref.as_ref().map(|value| value.id.clone());
        let config_snapshot = self.resolve_minimal_config(
            &run_id,
            profile_ref.as_ref().map(|value| value.id.clone()),
            workflow_id,
            run_overrides,
        )?;
        let config_ref = ConfigSnapshotRef {
            snapshot_id: config_snapshot.snapshot_id.clone(),
            hash: config_snapshot.hash.clone(),
        };
        let workflow_state = self.workflow.initial_state(&session_id, Some(3));
        let mut sequence = 0_u64;

        sequence += 1;
        self.append_ledger(
            &run_id,
            &session_id,
            "run.started",
            sequence,
            serde_json::json!({
                "summary": "Kernel driver run created.",
                "inputText": &input.text,
                "attachmentCount": input.attachments.len(),
                "workspaceBinding": &workspace_binding,
                "configRef": &config_ref,
                "profileRef": &profile_ref,
                "policyProfile": &self.policy_profile.id,
                "driverLoop": "session"
            }),
        )?;

        sequence += 1;
        self.append_ledger(
            &run_id,
            &session_id,
            "config.snapshot.attached",
            sequence,
            serde_json::json!({
                "summary": "Config snapshot attached.",
                "snapshotRef": &config_ref,
                "sources": &config_snapshot.source_refs
            }),
        )?;

        sequence += 1;
        self.append_ledger(
            &run_id,
            &session_id,
            "workflow.checkpointed",
            sequence,
            serde_json::json!({
                "summary": "Workflow checkpoint created for Session DriverLoop.",
                "runId": &run_id,
                "sessionId": &session_id,
                "phase": workflow_state.phase.as_str(),
                "sequence": sequence,
                "pendingPermissionId": null,
                "activeWorkUnitIds": []
            }),
        )?;

        self.state.records_by_session.insert(
            session_id.clone(),
            RuntimeRunRecord {
                session_id: session_id.clone(),
                run_id: run_id.clone(),
                attachments: input.attachments.clone(),
                workspace_binding,
                config_ref,
                phase: workflow_state.phase.clone(),
                decision_state: RunDecisionState::from_user_input(&input.text),
            },
        );

        let record = self.record_by_run(&run_id)?;
        let contract = self.state_contract_for_record(&record);
        sequence += 1;
        self.append_ledger(
            &run_id,
            &session_id,
            "state.entered",
            sequence,
            serde_json::json!({
                "summary": "Kernel state contract produced.",
                "stateContract": &contract
            }),
        )?;
        let state_event = KernelEvent::StateEntered {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.clone()),
            session_id: Some(SessionId(session_id.clone())),
            state_contract: contract.clone(),
            sequence: Some(sequence),
        };

        let driver_request = self.driver_request_for_contract(
            &contract,
            Some(SessionId(session_id.clone())),
            DriverRequestKind::NeedProposal,
            "Session should assemble context and submit a v3 proposal.",
        );
        sequence += 1;
        self.append_ledger(
            &run_id,
            &session_id,
            "driver.request_produced",
            sequence,
            serde_json::json!({
                "summary": "DriverRequest produced for Session DriverLoop.",
                "driverRequest": &driver_request
            }),
        )?;
        let driver_event = KernelEvent::DriverRequestProduced {
            request_id: Some(request_id),
            run_id: RunId(run_id),
            session_id: Some(SessionId(session_id)),
            driver_request,
            sequence: Some(sequence),
        };

        Ok(vec![state_event, driver_event])
    }

    pub(crate) fn state_contract_get(
        &mut self,
        request_id: RequestId,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
    ) -> KernelResult<Vec<KernelEvent>> {
        let (run_id, session_id) = self.resolve_run_session(run_id, session_id)?;
        let record = self.record_by_run(&run_id)?;
        let contract = self.state_contract_for_record(&record);
        let sequence = self.ledger.next_sequence(&run_id)?;
        self.append_ledger(
            &run_id,
            &session_id,
            "state.entered",
            sequence,
            serde_json::json!({
                "summary": "Kernel state contract read.",
                "stateContract": &contract
            }),
        )?;
        Ok(vec![KernelEvent::StateEntered {
            request_id: Some(request_id),
            run_id: RunId(run_id),
            session_id: Some(SessionId(session_id)),
            state_contract: contract,
            sequence: Some(sequence),
        }])
    }

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
        if proposal.schema_version != "deepcode.agent.protocol.v3" || proposal.run_id != run_id {
            let reason = if proposal.schema_version != "deepcode.agent.protocol.v3" {
                "ProposalEnvelope schemaVersion must be deepcode.agent.protocol.v3"
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
            let review_sequence = self.ledger.next_sequence(&run_id.0)?;
            let report = proposal_action_bundle_review_report(&proposal);
            let report_value =
                serde_json::to_value(&report).unwrap_or_else(|_| serde_json::Value::Null);
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
            self.append_ledger(
                &run_id.0,
                &report_session_id,
                "proposal.reviewed",
                review_sequence,
                serde_json::json!({
                    "summary": report.kernel_generated_permission_summary,
                    "proposalId": &proposal.proposal_id,
                    "planId": report.plan_id,
                    "status": plan_review_status_name(&report.status),
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

    pub(crate) fn resource_resolve(
        &mut self,
        request_id: RequestId,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        request: ResourceResolveRequest,
    ) -> KernelResult<Vec<KernelEvent>> {
        let resolved = self.resolve_run_session(run_id, session_id).ok();
        let sequence = resolved
            .as_ref()
            .map(|(run_id, _)| self.ledger.next_sequence(run_id))
            .transpose()?;
        let packet = resource_packet_from_manifest(
            &request_id,
            &request.manifest,
            self.state
                .current_workspace
                .as_ref()
                .map(|workspace| workspace.root.as_path()),
        );
        if let (Some((run_id, session_id)), Some(sequence)) = (resolved.as_ref(), sequence) {
            self.append_ledger(
                run_id,
                session_id,
                "resource.packet_produced",
                sequence,
                serde_json::json!({
                    "summary": "ResourcePacket skeleton produced by Kernel ResourceResolve.",
                    "packet": &packet
                }),
            )?;
        }
        Ok(vec![KernelEvent::ResourcePacketProduced {
            request_id: Some(request_id),
            run_id: resolved.as_ref().map(|(run_id, _)| RunId(run_id.clone())),
            session_id: resolved
                .as_ref()
                .map(|(_, session_id)| SessionId(session_id.clone())),
            packet,
            sequence,
        }])
    }

    pub(crate) fn artifact_register(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        artifact: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?.clone();
        let session_id_text = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| record.session_id.clone());
        let sequence = self.ledger.next_sequence(&run_id.0)?;
        let artifact_id = artifact
            .get("id")
            .or_else(|| artifact.get("artifactId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("artifact-{}-{sequence}", run_id.0));
        let evidence_ref = format!("artifact:{artifact_id}");
        let mut metadata = artifact.clone();
        if let Some(object) = metadata.as_object_mut() {
            object.insert("artifactId".to_string(), Value::String(artifact_id.clone()));
            object.insert(
                "evidenceRef".to_string(),
                Value::String(evidence_ref.clone()),
            );
            object.insert(
                "sourceAuthority".to_string(),
                Value::String("session-submitted-artifact".to_string()),
            );
            object.insert(
                "sideEffectPolicy".to_string(),
                Value::String("metadata-only".to_string()),
            );
        } else {
            metadata = serde_json::json!({
                "artifactId": &artifact_id,
                "value": artifact,
                "evidenceRef": &evidence_ref,
                "sourceAuthority": "session-submitted-artifact",
                "sideEffectPolicy": "metadata-only"
            });
        }
        self.state
            .resource_registry
            .register(KernelResource::active(
                artifact_id.clone(),
                KernelResourceKind::Artifact,
                KernelResourceOwner::agent_workflow(
                    Some(session_id_text.clone()),
                    run_id.0.clone(),
                ),
                KernelResourceScope::Workflow,
                KernelResourceCleanupPolicy::OnWorkflowEnd,
                metadata.clone(),
            ))?;
        self.append_ledger(
            &run_id.0,
            &session_id_text,
            "artifact.registered",
            sequence,
            serde_json::json!({
                "summary": "Kernel registered an artifact as evidence metadata.",
                "artifactId": &artifact_id,
                "evidenceRef": &evidence_ref,
                "artifact": &metadata
            }),
        )?;
        Ok(vec![KernelEvent::ArtifactRegistered {
            request_id: Some(request_id),
            run_id,
            session_id: Some(SessionId(session_id_text)),
            artifact: metadata,
            evidence_ref,
            sequence: Some(sequence),
        }])
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
        decision: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?.clone();
        let session_id_text = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| record.session_id.clone());
        let facts = review_facts_for_run(self, &*self.ledger, &run_id.0, &record)?;
        let failed_count = facts
            .get("failedWorkUnits")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        let blocked_count = facts
            .get("blockedWorkUnits")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        let decision_kind = decision
            .get("decision")
            .and_then(Value::as_str)
            .unwrap_or("needsUserReview");
        let status = match decision_kind {
            "accept" if failed_count == 0 && blocked_count == 0 => "accepted",
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
        let revoked_temporary_grant_count = self
            .state
            .temporary_grants_by_run
            .remove(&run_id.0)
            .map(|grants| grants.len())
            .unwrap_or(0);
        let result = serde_json::json!({
            "id": format!("review-{}", run_id.0),
            "runId": run_id.0,
            "status": status,
            "decision": decision,
            "failedWorkUnitCount": failed_count,
            "blockedWorkUnitCount": blocked_count,
            "revokedTemporaryGrantCount": revoked_temporary_grant_count,
            "summary": summary,
            "factsRef": facts.get("factsRef").cloned().unwrap_or(Value::Null)
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
                "revokedTemporaryGrantCount": revoked_temporary_grant_count
            }),
        )?;
        Ok(vec![KernelEvent::ReviewGateEvaluated {
            request_id: Some(request_id),
            run_id,
            session_id: Some(SessionId(session_id_text)),
            result,
            sequence: Some(sequence),
        }])
    }

    pub(crate) fn run_resume(
        &mut self,
        request_id: RequestId,
        session_id: SessionId,
    ) -> KernelResult<Vec<KernelEvent>> {
        self.ensure_session_restored(&session_id.0)?;
        let record = self
            .state
            .records_by_session
            .get(&session_id.0)
            .ok_or_else(|| {
                KernelError::InvalidCommand(format!(
                    "session {} has no resumable run",
                    session_id.0
                ))
            })?;
        let next_sequence = self.ledger.next_sequence(&record.run_id)?;
        let checkpoint_id = format!("checkpoint-{}-resume", record.run_id);
        self.append_ledger(
            &record.run_id,
            &record.session_id,
            "workflow.resumed",
            next_sequence,
            serde_json::json!({
                "summary": "Workflow resumed from runtime record.",
                "checkpointId": &checkpoint_id,
                "phase": record.phase.as_str()
            }),
        )?;
        Ok(vec![
            KernelEvent::WorkflowResumed {
                run_id: RunId(record.run_id.clone()),
                session_id: Some(SessionId(record.session_id.clone())),
                checkpoint_id,
                phase: record.phase.as_str().to_string(),
                sequence: Some(next_sequence),
            },
            KernelEvent::SnapshotReady {
                request_id,
                snapshot: self.snapshot(Some(&record.session_id)),
            },
        ])
    }

    pub(crate) fn workflow_observe(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        event: KernelEvent,
    ) -> KernelResult<Vec<KernelEvent>> {
        let observed_kind = kernel_event_kind(&event).to_string();
        let observed_sequence = kernel_event_sequence(&event);
        let session_id = session_id
            .map(|value| value.0)
            .or_else(|| {
                self.record_by_run(&run_id.0)
                    .ok()
                    .map(|record| record.session_id)
            })
            .ok_or_else(|| {
                KernelError::InvalidCommand(format!("run {} has no active session", run_id.0))
            })?;

        let decision = {
            let record = self.record_by_run_mut(&run_id.0)?;
            if let KernelEvent::StageChanged { phase, .. } = &event {
                if let Some(next_phase) = workflow_phase_from_str(phase) {
                    record.phase = next_phase;
                }
            }
            let event_phase = record.phase.as_str().to_string();
            record.decision_state.apply_event(&event, &event_phase);
            record.decision_state.decide(&event_phase)
        };
        let sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &session_id,
            "workflow.decision_made",
            sequence,
            serde_json::json!({
                "summary": decision.summary,
                "observedKind": observed_kind,
                "observedSequence": observed_sequence,
                "decision": decision
            }),
        )?;

        Ok(vec![KernelEvent::WorkflowDecisionMade {
            request_id: Some(request_id),
            run_id,
            session_id: Some(SessionId(session_id)),
            decision,
            sequence: Some(sequence),
        }])
    }

    pub(crate) fn draft_ledger_submit(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        frame: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let session_id = session_id
            .map(|value| value.0)
            .or_else(|| {
                self.record_by_run(&run_id.0)
                    .ok()
                    .map(|record| record.session_id)
            })
            .ok_or_else(|| {
                KernelError::InvalidCommand(format!("run {} has no active session", run_id.0))
            })?;
        let part_kind = frame
            .get("partKind")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                KernelError::InvalidCommand("draft frame missing partKind".to_string())
            })?;
        let draft_id = frame
            .get("draftId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("draft-default")
            .to_string();
        let draft_key = format!("{}:{draft_id}", run_id.0);
        let mut events = Vec::new();
        if !self.state.draft_ledger_keys.contains(&draft_key) {
            self.state.draft_ledger_keys.insert(draft_key);
            let sequence = self.ledger.next_sequence(&run_id.0)?;
            let draft = draft_payload(&draft_id, "draft.open", &frame);
            self.append_ledger(
                &run_id.0,
                &session_id,
                "draft.open",
                sequence,
                draft.clone(),
            )?;
            events.push(KernelEvent::DraftOpen {
                request_id: Some(request_id.clone()),
                run_id: run_id.clone(),
                session_id: Some(SessionId(session_id.clone())),
                draft,
                sequence: Some(sequence),
            });
        }

        let (event_kind, event) = match part_kind {
            "thinkingDelta" | "codeBlockChunk" | "actionDraftChunk" => {
                let sequence = self.ledger.next_sequence(&run_id.0)?;
                let draft = draft_payload(&draft_id, "draft.chunk", &frame);
                (
                    "draft.chunk",
                    KernelEvent::DraftChunk {
                        request_id: Some(request_id.clone()),
                        run_id: run_id.clone(),
                        session_id: Some(SessionId(session_id.clone())),
                        draft: draft.clone(),
                        sequence: Some(sequence),
                    },
                )
            }
            "fileDone" => {
                let sequence = self.ledger.next_sequence(&run_id.0)?;
                let draft = draft_payload(&draft_id, "draft.file_completed", &frame);
                (
                    "draft.file_completed",
                    KernelEvent::DraftFileCompleted {
                        request_id: Some(request_id.clone()),
                        run_id: run_id.clone(),
                        session_id: Some(SessionId(session_id.clone())),
                        draft: draft.clone(),
                        sequence: Some(sequence),
                    },
                )
            }
            "batchDone" => {
                let sequence = self.ledger.next_sequence(&run_id.0)?;
                let draft = draft_payload(&draft_id, "draft.batch_completed", &frame);
                (
                    "draft.batch_completed",
                    KernelEvent::DraftBatchCompleted {
                        request_id: Some(request_id.clone()),
                        run_id: run_id.clone(),
                        session_id: Some(SessionId(session_id.clone())),
                        draft: draft.clone(),
                        sequence: Some(sequence),
                    },
                )
            }
            "diagnostic" => {
                let sequence = self.ledger.next_sequence(&run_id.0)?;
                let draft = draft_payload(&draft_id, "draft.discarded", &frame);
                (
                    "draft.discarded",
                    KernelEvent::DraftDiscarded {
                        request_id: Some(request_id.clone()),
                        run_id: run_id.clone(),
                        session_id: Some(SessionId(session_id.clone())),
                        draft: draft.clone(),
                        sequence: Some(sequence),
                    },
                )
            }
            other => {
                return Err(KernelError::InvalidCommand(format!(
                    "unsupported draft part kind: {other}"
                )));
            }
        };
        let sequence = kernel_event_sequence(&event).ok_or_else(|| {
            KernelError::InvalidCommand("draft event missing sequence".to_string())
        })?;
        let draft = match &event {
            KernelEvent::DraftChunk { draft, .. }
            | KernelEvent::DraftFileCompleted { draft, .. }
            | KernelEvent::DraftBatchCompleted { draft, .. }
            | KernelEvent::DraftDiscarded { draft, .. } => draft.clone(),
            _ => Value::Null,
        };
        self.append_ledger(&run_id.0, &session_id, event_kind, sequence, draft)?;
        events.push(event);
        Ok(events)
    }

    pub(crate) fn enter_phase_event(
        &mut self,
        run_id: &str,
        session_id: &str,
        phase: WorkflowPhase,
    ) -> KernelResult<KernelEvent> {
        {
            let record = self.record_by_run_mut(run_id)?;
            record.phase = phase.clone();
        }
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "stage.changed",
            sequence,
            serde_json::json!({
                "summary": format!("Workflow entered {} stage.", phase.as_str()),
                "phase": phase.as_str(),
                "status": "running"
            }),
        )?;
        Ok(KernelEvent::StageChanged {
            run_id: Some(RunId(run_id.to_string())),
            session_id: Some(SessionId(session_id.to_string())),
            turn_id: None,
            stage_run_id: None,
            phase: phase.as_str().to_string(),
            status: StageStatus::Running,
            reason: None,
            sequence: Some(sequence),
        })
    }

    pub(crate) fn workflow_decision_event(
        &self,
        request_id: RequestId,
        run_id: &str,
        session_id: &str,
        observed_kind: &str,
    ) -> KernelResult<KernelEvent> {
        let record = self.record_by_run(run_id)?;
        let decision = record.decision_state.decide(record.phase.as_str());
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "workflow.decision_made",
            sequence,
            serde_json::json!({
                "summary": decision.summary,
                "observedKind": observed_kind,
                "decision": decision
            }),
        )?;
        Ok(KernelEvent::WorkflowDecisionMade {
            request_id: Some(request_id),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            decision,
            sequence: Some(sequence),
        })
    }
}

fn empty_workspace_binding() -> WorkspaceBinding {
    WorkspaceBinding {
        workspace_id: None,
        workspace_hash: None,
        open_path: None,
        active_folder_id: None,
        folder_hash: None,
    }
}

impl DeepCodeKernelRuntime {
    fn state_contract_for_record(&self, record: &RuntimeRunRecord) -> KernelStateContract {
        KernelStateContract {
            run_id: RunId(record.run_id.clone()),
            workflow_ref: Some(WorkflowRef {
                id: "builtin.plan-first".to_string(),
                version: None,
                hash: None,
            }),
            state_id: record.phase.as_str().to_string(),
            state_kind: "driverRequest".to_string(),
            allowed_inputs: vec![
                "proposalSubmit".to_string(),
                "userDecisionSubmit".to_string(),
                "resourceResolve".to_string(),
            ],
            allowed_proposals: vec![
                "answer".to_string(),
                "resourceRequest".to_string(),
                "decisionRequest".to_string(),
                "actionBundle".to_string(),
                "diagnostic".to_string(),
            ],
            proposal_schema_refs: vec!["deepcode.agent.protocol.v3".to_string()],
            required_user_decision: None,
            capability_projection: vec![
                "workspace.read".to_string(),
                "workspace.search".to_string(),
                "workspace.write".to_string(),
                "workspace.delete".to_string(),
                "process.exec".to_string(),
                "network.egress".to_string(),
                "git.read".to_string(),
                "git.write".to_string(),
                "git.push".to_string(),
                "config.modify".to_string(),
                "browser.control".to_string(),
                "provider.egress".to_string(),
            ],
            tool_catalog_ref: Some(TOOL_CATALOG_VERSION.to_string()),
            transition_predicates: vec![
                "proposal must match allowed proposals".to_string(),
                "side effects require Kernel permission gates".to_string(),
            ],
            fail_closed_rules: vec![
                "unknown proposal schema is rejected".to_string(),
                "Session cannot advance Kernel state directly".to_string(),
            ],
        }
    }

    fn driver_request_for_contract(
        &self,
        contract: &KernelStateContract,
        session_id: Option<SessionId>,
        kind: DriverRequestKind,
        reason: &str,
    ) -> DriverRequest {
        DriverRequest {
            id: format!(
                "driver-{}-{}",
                contract.run_id.0,
                driver_request_kind_name(&kind)
            ),
            run_id: contract.run_id.clone(),
            session_id,
            kind,
            reason: reason.to_string(),
            state_contract: contract.clone(),
        }
    }
}

fn driver_request_kind_name(kind: &DriverRequestKind) -> &'static str {
    match kind {
        DriverRequestKind::NeedRequirementDraft => "need-requirement-draft",
        DriverRequestKind::NeedRequirementDecision => "need-requirement-decision",
        DriverRequestKind::NeedResourcePacket => "need-resource-packet",
        DriverRequestKind::NeedProposal => "need-proposal",
        DriverRequestKind::NeedUserPlanDecision => "need-user-plan-decision",
        DriverRequestKind::NeedUserPermissionDecision => "need-user-permission-decision",
        DriverRequestKind::NeedRepairProposal => "need-repair-proposal",
        DriverRequestKind::NeedReviewPacket => "need-review-packet",
        DriverRequestKind::NeedUserReviewDecision => "need-user-review-decision",
        DriverRequestKind::WaitKernelExecution => "wait-kernel-execution",
        DriverRequestKind::Terminal => "terminal",
    }
}

fn proposal_kind_name(kind: &ProposalEnvelopeKind) -> &'static str {
    match kind {
        ProposalEnvelopeKind::Answer => "answer",
        ProposalEnvelopeKind::ResourceRequest => "resourceRequest",
        ProposalEnvelopeKind::DecisionRequest => "decisionRequest",
        ProposalEnvelopeKind::ActionBundle => "actionBundle",
        ProposalEnvelopeKind::Diagnostic => "diagnostic",
    }
}

const RESOURCE_PACKET_MAX_FILE_CHARS: usize = 12_000;
const RESOURCE_PACKET_MAX_DIR_DEPTH: u32 = 2;

fn resource_packet_from_manifest(
    request_id: &RequestId,
    manifest: &Value,
    workspace_root: Option<&Path>,
) -> Value {
    let manifest_id = manifest
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("resource-manifest");
    let entries = manifest
        .get("entries")
        .or_else(|| manifest.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let items = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            resolve_resource_manifest_entry(request_id, index, entry, workspace_root)
        })
        .collect::<Vec<_>>();
    let evidence_refs = items
        .iter()
        .filter_map(|item| {
            item.get("evidenceRef")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "id": format!("resource-packet-{}", request_id.0),
        "requestId": request_id.0,
        "manifestId": manifest_id,
        "items": items,
        "evidenceRefs": evidence_refs,
        "summary": "Kernel ResourceResolve produced a ResourcePacket from explicit manifest entries."
    })
}

fn resolve_resource_manifest_entry(
    request_id: &RequestId,
    index: usize,
    entry: &Value,
    workspace_root: Option<&Path>,
) -> Value {
    let manifest_entry_id = entry
        .get("id")
        .or_else(|| entry.get("manifestEntryId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("entry-{index}"));
    let source_kind = entry
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("resource");
    let request_item_id = format!("item-{index}");
    let evidence_ref = format!("evidence-{}-{index}", request_id.0);
    let Some(path) = resource_entry_path(entry, workspace_root) else {
        return resource_packet_error_item(
            &request_item_id,
            &manifest_entry_id,
            source_kind,
            "outside_manifest_scope",
            "manifest entry did not provide a resolvable explicit path",
        );
    };
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return resource_packet_error_item(
                &request_item_id,
                &manifest_entry_id,
                source_kind,
                "not_found",
                &format!("stat {}: {error}", path.display()),
            );
        }
    };
    let actual_kind = if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    };
    if source_kind == "file" && !metadata.is_file() {
        return resource_packet_error_item(
            &request_item_id,
            &manifest_entry_id,
            source_kind,
            "not_file",
            &format!("{} is {actual_kind}, not file", path.display()),
        );
    }
    if source_kind == "directory" && !metadata.is_dir() {
        return resource_packet_error_item(
            &request_item_id,
            &manifest_entry_id,
            source_kind,
            "not_directory",
            &format!("{} is {actual_kind}, not directory", path.display()),
        );
    }

    if metadata.is_dir() {
        let nodes =
            list_nodes(&path, &path, RESOURCE_PACKET_MAX_DIR_DEPTH).unwrap_or_else(|error| {
                vec![serde_json::json!({
                    "type": "error",
                    "message": error.to_string()
                })]
            });
        return serde_json::json!({
            "requestItemId": request_item_id,
            "manifestEntryId": manifest_entry_id,
            "status": "resolved",
            "readPolicy": "explicit-manifest-readonly",
            "sourceKind": source_kind,
            "resolvedKind": "directory",
            "path": resource_entry_display_path(entry, &path),
            "absolutePath": path.to_string_lossy(),
            "contentKind": "directoryTree",
            "nodes": nodes,
            "contentSummary": entry.get("summary").and_then(Value::as_str).unwrap_or("Directory tree resolved by Kernel ResourceResolve."),
            "evidenceRef": evidence_ref,
            "evidenceRefs": [evidence_ref]
        });
    }

    if metadata.is_file() {
        match fs::read_to_string(&path) {
            Ok(content) => {
                let offset_bytes = resource_entry_u64(entry, "offsetBytes");
                let limit_bytes = resource_entry_u64(entry, "limitBytes");
                if offset_bytes.is_some() || limit_bytes.is_some() {
                    return resource_packet_file_range_item(
                        &request_item_id,
                        &manifest_entry_id,
                        source_kind,
                        &path,
                        entry,
                        &content,
                        offset_bytes,
                        limit_bytes,
                        &evidence_ref,
                    );
                }
                let truncated = content.chars().count() > RESOURCE_PACKET_MAX_FILE_CHARS;
                let clipped = clip_resource_text(&content, RESOURCE_PACKET_MAX_FILE_CHARS);
                return serde_json::json!({
                    "requestItemId": request_item_id,
                    "manifestEntryId": manifest_entry_id,
                    "status": "resolved",
                    "readPolicy": "explicit-manifest-readonly",
                    "sourceKind": source_kind,
                    "resolvedKind": "file",
                    "path": resource_entry_display_path(entry, &path),
                    "absolutePath": path.to_string_lossy(),
                    "contentKind": "fileText",
                    "content": clipped,
                    "sizeBytes": content.len(),
                    "originalBytes": content.len(),
                    "returnedBytes": clipped.len(),
                    "truncated": truncated,
                    "rangeComplete": !truncated,
                    "contentSummary": entry.get("summary").and_then(Value::as_str).unwrap_or("File text resolved by Kernel ResourceResolve."),
                    "evidenceRef": evidence_ref,
                    "evidenceRefs": [evidence_ref]
                });
            }
            Err(error) => {
                return resource_packet_error_item(
                    &request_item_id,
                    &manifest_entry_id,
                    source_kind,
                    "read_failed",
                    &format!("read {}: {error}", path.display()),
                );
            }
        }
    }

    resource_packet_error_item(
        &request_item_id,
        &manifest_entry_id,
        source_kind,
        "unsupported_resource_kind",
        &format!("{} is not a file or directory", path.display()),
    )
}

fn resource_packet_file_range_item(
    request_item_id: &str,
    manifest_entry_id: &str,
    source_kind: &str,
    path: &Path,
    entry: &Value,
    content: &str,
    offset_bytes: Option<u64>,
    limit_bytes: Option<u64>,
    evidence_ref: &str,
) -> Value {
    let total_bytes = content.len();
    let requested_offset = offset_bytes.unwrap_or(0) as usize;
    if requested_offset > total_bytes {
        return resource_packet_error_item(
            request_item_id,
            manifest_entry_id,
            source_kind,
            "range_out_of_bounds",
            &format!(
                "offsetBytes {requested_offset} is beyond file size {total_bytes} for {}",
                path.display()
            ),
        );
    }
    let requested_limit = limit_bytes
        .map(|value| value as usize)
        .unwrap_or(RESOURCE_PACKET_MAX_FILE_CHARS)
        .min(RESOURCE_PACKET_MAX_FILE_CHARS);
    if requested_limit == 0 {
        return resource_packet_error_item(
            request_item_id,
            manifest_entry_id,
            source_kind,
            "invalid_range",
            "limitBytes must be greater than zero",
        );
    }
    let requested_end = requested_offset
        .saturating_add(requested_limit)
        .min(total_bytes);
    let start = ceil_char_boundary(content, requested_offset);
    let end = floor_char_boundary(content, requested_end);
    if start > end {
        return resource_packet_error_item(
            request_item_id,
            manifest_entry_id,
            source_kind,
            "invalid_utf8_range",
            "requested byte range does not include a valid UTF-8 text segment",
        );
    }
    let segment = &content[start..end];
    serde_json::json!({
        "requestItemId": request_item_id,
        "manifestEntryId": manifest_entry_id,
        "status": "resolved",
        "readPolicy": "explicit-manifest-readonly",
        "sourceKind": source_kind,
        "resolvedKind": "file",
        "path": resource_entry_display_path(entry, path),
        "absolutePath": path.to_string_lossy(),
        "contentKind": "fileText",
        "content": segment,
        "sizeBytes": total_bytes,
        "originalBytes": total_bytes,
        "offsetBytes": start,
        "limitBytes": requested_limit,
        "returnedBytes": segment.len(),
        "truncated": start > 0 || end < total_bytes,
        "rangeComplete": end >= total_bytes,
        "contentSummary": entry.get("summary").and_then(Value::as_str).unwrap_or("File text range resolved by Kernel ResourceResolve."),
        "evidenceRef": evidence_ref,
        "evidenceRefs": [evidence_ref]
    })
}

fn resource_entry_path(entry: &Value, workspace_root: Option<&Path>) -> Option<PathBuf> {
    let raw = entry
        .get("absolutePath")
        .or_else(|| entry.get("resourceRef"))
        .or_else(|| entry.get("resource_ref"))
        .or_else(|| entry.get("path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let path = Path::new(raw);
    if path.is_absolute() {
        return Some(path.components().collect::<PathBuf>());
    }
    let root = workspace_root?;
    WorkspaceBoundary::new(root).resolve(raw).ok()
}

fn resource_entry_display_path(entry: &Value, path: &Path) -> String {
    entry
        .get("path")
        .or_else(|| entry.get("resourceRef"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn resource_entry_u64(entry: &Value, key: &str) -> Option<u64> {
    entry.get(key).and_then(Value::as_u64)
}

fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index < value.len() && !value.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn resource_packet_error_item(
    request_item_id: &str,
    manifest_entry_id: &str,
    source_kind: &str,
    reason: &str,
    message: &str,
) -> Value {
    serde_json::json!({
        "requestItemId": request_item_id,
        "manifestEntryId": manifest_entry_id,
        "status": "error",
        "readPolicy": "explicit-manifest-readonly",
        "sourceKind": source_kind,
        "reason": reason,
        "message": message,
        "evidenceRefs": []
    })
}

fn clip_resource_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head_len = max_chars / 2;
    let tail_len = max_chars.saturating_sub(head_len + 24);
    let head = text.chars().take(head_len).collect::<String>();
    let tail = text
        .chars()
        .rev()
        .take(tail_len)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}\n\n[... truncated ...]\n\n{tail}")
}

pub(crate) fn workflow_phase_from_str(phase: &str) -> Option<WorkflowPhase> {
    match phase {
        "plan" => Some(WorkflowPhase::Plan),
        "check" => Some(WorkflowPhase::Check),
        "complete" => Some(WorkflowPhase::Complete),
        "awaitingApproval" => Some(WorkflowPhase::AwaitingApproval),
        "review" => Some(WorkflowPhase::Review),
        "done" => Some(WorkflowPhase::Done),
        "aborted" => Some(WorkflowPhase::Aborted),
        _ => None,
    }
}

fn proposal_action_bundle_review_report(proposal: &ProposalEnvelope) -> PlanReviewReport {
    let Some(payload) = proposal.payload.as_object() else {
        return PlanReviewReport::denied(
            proposal.proposal_id.clone(),
            "actionBundle proposal payload must be an object",
        );
    };
    let Some(action_bundle_value) = payload.get("actionBundle").cloned() else {
        return PlanReviewReport::denied(
            proposal.proposal_id.clone(),
            "actionBundle proposal payload must include actionBundle",
        );
    };
    let action_bundle_value = action_bundle_with_code_block_targets(payload, action_bundle_value);
    let action_bundle = match serde_json::from_value::<ActionBundleDraft>(action_bundle_value) {
        Ok(bundle) => bundle,
        Err(error) => {
            return PlanReviewReport::denied(
                proposal.proposal_id.clone(),
                format!("actionBundle payload failed Kernel schema validation: {error}"),
            );
        }
    };
    let plan = plan_contract_from_action_bundle(&action_bundle);
    DefaultPlanReviewEngine.review_input(PlanReviewInput {
        plan,
        action_bundle: Some(action_bundle),
    })
}

fn action_bundle_with_code_block_targets(
    payload: &serde_json::Map<String, Value>,
    mut action_bundle: Value,
) -> Value {
    let code_block_targets = code_block_targets_by_id(payload);
    if code_block_targets.is_empty() {
        return action_bundle;
    }
    let Some(actions) = action_bundle
        .get_mut("actions")
        .and_then(Value::as_array_mut)
    else {
        return action_bundle;
    };
    for action in actions {
        let Some(action_object) = action.as_object_mut() else {
            continue;
        };
        let has_target = action_object
            .get("targetPath")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
            || action_object
                .get("resourceScope")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item.as_str().is_some_and(|value| !value.trim().is_empty()))
                });
        if has_target {
            continue;
        }
        let block_id = action_object
            .get("sourceBlockId")
            .or_else(|| action_object.get("replacementBlockId"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        let Some(target_path) = block_id.and_then(|id| code_block_targets.get(id)) else {
            continue;
        };
        action_object.insert("targetPath".to_string(), serde_json::json!(target_path));
        action_object.insert(
            "resourceScope".to_string(),
            serde_json::json!([target_path]),
        );
    }
    action_bundle
}

fn code_block_targets_by_id(
    payload: &serde_json::Map<String, Value>,
) -> std::collections::BTreeMap<String, String> {
    let mut targets = std::collections::BTreeMap::new();
    let Some(code_blocks) = payload.get("codeBlocks").and_then(Value::as_array) else {
        return targets;
    };
    for block in code_blocks {
        let Some(record) = block.as_object() else {
            continue;
        };
        let Some(id) = record
            .get("id")
            .or_else(|| record.get("blockId"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let Some(target_path) = record
            .get("targetPath")
            .or_else(|| record.get("path"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        targets.insert(id.to_string(), target_path.to_string());
    }
    targets
}

fn review_facts_for_run(
    runtime: &DeepCodeKernelRuntime,
    ledger: &dyn EventLedger,
    run_id: &str,
    record: &RuntimeRunRecord,
) -> KernelResult<Value> {
    let mut facts = ledger_review_facts_for_run(ledger, run_id)?;
    if let Some(object) = facts.as_object_mut() {
        object.insert(
            "gitReview".to_string(),
            git_review_facts_for_record(runtime, run_id, record),
        );
    }
    Ok(facts)
}

fn ledger_review_facts_for_run(ledger: &dyn EventLedger, run_id: &str) -> KernelResult<Value> {
    let events = ledger.list_by_run(run_id)?;
    let mut work_units = Vec::new();
    let mut completed_work_units = Vec::new();
    let mut failed_work_units = Vec::new();
    let mut blocked_work_units = Vec::new();
    let mut tool_results = Vec::new();
    let mut written_files = Vec::new();
    let mut patch_changed_ranges = Vec::new();
    let mut generated_artifacts = Vec::new();
    let mut path_normalization_diagnostics = Vec::new();

    for event in &events {
        match event.kind.as_str() {
            "work_unit.queued"
            | "work_unit.started"
            | "work_unit.completed"
            | "work_unit.failed"
            | "work_unit.blocked" => {
                let summary = review_ledger_event_summary(event);
                work_units.push(summary.clone());
                match event.kind.as_str() {
                    "work_unit.completed" => completed_work_units.push(summary),
                    "work_unit.failed" => failed_work_units.push(summary),
                    "work_unit.blocked" => blocked_work_units.push(summary),
                    _ => {}
                }
            }
            "tool.completed" => {
                let summary = review_ledger_event_summary(event);
                let tool_name = summary.get("toolName").and_then(Value::as_str);
                let output = summary.get("output");
                if let Some(output) = output {
                    if output.get("artifactOrigin").and_then(Value::as_str)
                        == Some("agentGenerated")
                    {
                        generated_artifacts.push(serde_json::json!({
                            "toolName": tool_name,
                            "toolCallId": summary.get("toolCallId").cloned().unwrap_or(Value::Null),
                            "path": output.get("path").cloned().unwrap_or(Value::Null),
                            "absolutePath": output.get("absolutePath").cloned().unwrap_or(Value::Null),
                            "operation": output.get("operation").cloned().unwrap_or(Value::Null),
                            "planId": output.get("planId").cloned().unwrap_or(Value::Null),
                            "workUnitId": output.get("workUnitId").cloned().unwrap_or(Value::Null),
                            "contentHash": output.get("contentHash").cloned().unwrap_or(Value::Null),
                            "artifactOrigin": "agentGenerated"
                        }));
                    }
                    if let Some(path_normalization) = output.get("pathNormalization") {
                        path_normalization_diagnostics.push(serde_json::json!({
                            "toolName": tool_name,
                            "toolCallId": summary.get("toolCallId").cloned().unwrap_or(Value::Null),
                            "path": output.get("path").cloned().unwrap_or(Value::Null),
                            "absolutePath": output.get("absolutePath").cloned().unwrap_or(Value::Null),
                            "pathNormalization": path_normalization,
                            "duplicateRootPathDetected": output.get("duplicateRootPathDetected").cloned().unwrap_or(Value::Bool(false))
                        }));
                    }
                }
                if matches!(tool_name, Some("fs.write" | "fs.patch")) {
                    if let Some(path) = summary
                        .get("output")
                        .and_then(|output| output.get("path"))
                        .and_then(Value::as_str)
                    {
                        written_files.push(serde_json::json!({
                            "path": path,
                            "absolutePath": summary.get("output").and_then(|output| output.get("absolutePath")).cloned().unwrap_or(Value::Null),
                            "contentHash": summary.get("output").and_then(|output| output.get("contentHash")).cloned().unwrap_or(Value::Null),
                            "artifactOrigin": summary.get("output").and_then(|output| output.get("artifactOrigin")).cloned().unwrap_or(Value::Null),
                            "pathNormalization": summary.get("output").and_then(|output| output.get("pathNormalization")).cloned().unwrap_or(Value::Null),
                            "toolCallId": summary.get("toolCallId").cloned().unwrap_or(Value::Null)
                        }));
                    }
                }
                if tool_name == Some("fs.patch") {
                    if let Some(output) = summary.get("output") {
                        patch_changed_ranges.push(serde_json::json!({
                            "path": output.get("path").cloned().unwrap_or(Value::Null),
                            "toolCallId": summary.get("toolCallId").cloned().unwrap_or(Value::Null),
                            "changedRanges": output.get("changedRanges").cloned().unwrap_or(Value::Null),
                            "oldContentHash": output.get("oldContentHash").cloned().unwrap_or(Value::Null),
                            "newContentHash": output.get("newContentHash").cloned().unwrap_or(Value::Null)
                        }));
                    }
                }
                tool_results.push(summary);
            }
            _ => {}
        }
    }

    Ok(serde_json::json!({
        "factsRef": format!("review-facts-{run_id}"),
        "runId": run_id,
        "eventCount": events.len(),
        "workUnits": work_units,
        "completedWorkUnits": completed_work_units,
        "failedWorkUnits": failed_work_units,
        "blockedWorkUnits": blocked_work_units,
        "toolResults": tool_results,
        "writtenFiles": written_files,
        "patchChangedRanges": patch_changed_ranges,
        "generatedArtifacts": generated_artifacts,
        "pathNormalizationDiagnostics": path_normalization_diagnostics
    }))
}

fn git_review_facts_for_record(
    runtime: &DeepCodeKernelRuntime,
    run_id: &str,
    record: &RuntimeRunRecord,
) -> Value {
    let Some(root) = review_git_root(runtime, record) else {
        return serde_json::json!({
            "available": false,
            "reason": "no workspace binding available for git review"
        });
    };
    let repo_root = match review_git_output(&root, &["rev-parse", "--show-toplevel"]) {
        Ok(output) => output.trim().to_string(),
        Err(error) => {
            return serde_json::json!({
                "available": false,
                "root": root.to_string_lossy(),
                "reason": error
            });
        }
    };
    let status = match review_git_output(&root, &["status", "--porcelain=v1", "-uall"]) {
        Ok(output) => output,
        Err(error) => {
            return serde_json::json!({
                "available": false,
                "root": root.to_string_lossy(),
                "repoRoot": repo_root,
                "reason": error
            });
        }
    };
    let unstaged_diff = review_git_output(&root, &["diff"]).unwrap_or_default();
    let staged_diff = review_git_output(&root, &["diff", "--cached"]).unwrap_or_default();
    let unstaged_numstat = review_git_output(&root, &["diff", "--numstat"]).unwrap_or_default();
    let staged_numstat =
        review_git_output(&root, &["diff", "--cached", "--numstat"]).unwrap_or_default();
    let files = review_git_status_files(&status, &unstaged_numstat, &staged_numstat);
    let changed_file_count = files.as_array().map(Vec::len).unwrap_or(0);
    let has_diff = !unstaged_diff.trim().is_empty() || !staged_diff.trim().is_empty();
    let mut diff_blocks = Vec::new();
    if !staged_diff.trim().is_empty() {
        diff_blocks.push(serde_json::json!({
            "id": format!("git-staged-diff-{run_id}"),
            "title": "Staged diff",
            "staged": true,
            "diff": review_limit_text(&staged_diff, 96 * 1024),
            "truncated": staged_diff.len() > 96 * 1024,
            "sizeBytes": staged_diff.len(),
            "evidenceRef": format!("git:diff:staged:{run_id}")
        }));
    }
    if !unstaged_diff.trim().is_empty() {
        diff_blocks.push(serde_json::json!({
            "id": format!("git-unstaged-diff-{run_id}"),
            "title": "Unstaged diff",
            "staged": false,
            "diff": review_limit_text(&unstaged_diff, 96 * 1024),
            "truncated": unstaged_diff.len() > 96 * 1024,
            "sizeBytes": unstaged_diff.len(),
            "evidenceRef": format!("git:diff:unstaged:{run_id}")
        }));
    }
    let truncated = diff_blocks.iter().any(|block| {
        block
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    serde_json::json!({
        "available": true,
        "root": root.to_string_lossy(),
        "repoRoot": repo_root,
        "summary": if changed_file_count == 0 {
            "Git 工作区没有可展示的修改。".to_string()
        } else {
            format!("Git 工作区包含 {changed_file_count} 个变更文件。")
        },
        "statusRaw": status,
        "files": files,
        "stats": {
            "changedFiles": changed_file_count,
            "stagedDiffBytes": staged_diff.len(),
            "unstagedDiffBytes": unstaged_diff.len(),
            "hasDiff": has_diff
        },
        "diffBlocks": diff_blocks,
        "truncated": truncated,
        "evidenceRefs": [
            format!("git:status:{run_id}"),
            format!("git:diff:staged:{run_id}"),
            format!("git:diff:unstaged:{run_id}")
        ]
    })
}

fn review_git_root(runtime: &DeepCodeKernelRuntime, record: &RuntimeRunRecord) -> Option<PathBuf> {
    runtime
        .state
        .current_workspace
        .as_ref()
        .map(|workspace| workspace.root.clone())
        .or_else(|| {
            record
                .workspace_binding
                .open_path
                .as_ref()
                .map(PathBuf::from)
        })
}

fn review_git_output(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| format!("start git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn review_git_status_files(status: &str, unstaged_numstat: &str, staged_numstat: &str) -> Value {
    let mut paths = std::collections::BTreeMap::<String, serde_json::Map<String, Value>>::new();
    for line in status.lines().filter(|line| line.len() >= 3) {
        let path = line[3..].trim().to_string();
        let entry = paths.entry(path.clone()).or_insert_with(|| {
            let mut object = serde_json::Map::new();
            object.insert("path".to_string(), Value::String(path));
            object
        });
        entry.insert("index".to_string(), Value::String(line[0..1].to_string()));
        entry.insert(
            "worktree".to_string(),
            Value::String(line[1..2].to_string()),
        );
        entry.insert("raw".to_string(), Value::String(line.to_string()));
    }
    apply_review_numstat(&mut paths, unstaged_numstat, false);
    apply_review_numstat(&mut paths, staged_numstat, true);
    Value::Array(paths.into_values().map(Value::Object).collect())
}

fn apply_review_numstat(
    paths: &mut std::collections::BTreeMap<String, serde_json::Map<String, Value>>,
    numstat: &str,
    staged: bool,
) {
    for line in numstat.lines() {
        let parts = line.split('\t').collect::<Vec<_>>();
        if parts.len() < 3 {
            continue;
        }
        let path = parts[2].to_string();
        let entry = paths.entry(path.clone()).or_insert_with(|| {
            let mut object = serde_json::Map::new();
            object.insert("path".to_string(), Value::String(path));
            object
        });
        let prefix = if staged { "staged" } else { "unstaged" };
        entry.insert(format!("{prefix}Added"), review_numstat_value(parts[0]));
        entry.insert(format!("{prefix}Deleted"), review_numstat_value(parts[1]));
    }
}

fn review_numstat_value(value: &str) -> Value {
    value
        .parse::<u64>()
        .map(|number| Value::Number(serde_json::Number::from(number)))
        .unwrap_or_else(|_| Value::String(value.to_string()))
}

fn review_limit_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &value[..end])
}

fn draft_payload(draft_id: &str, status: &str, frame: &Value) -> Value {
    serde_json::json!({
        "summary": format!("Kernel draft ledger recorded {status}."),
        "draftId": draft_id,
        "status": status,
        "frame": frame
    })
}

fn review_ledger_event_summary(event: &LedgerEvent) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("kind".to_string(), Value::String(event.kind.clone()));
    if let Some(sequence) = event.sequence {
        object.insert(
            "sequence".to_string(),
            Value::Number(serde_json::Number::from(sequence)),
        );
    }
    for key in [
        "summary",
        "workUnitId",
        "workUnit",
        "toolCallId",
        "toolName",
        "ok",
        "output",
        "error",
        "reason",
        "draft",
    ] {
        if let Some(value) = event.payload.get(key) {
            object.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(object)
}

fn plan_contract_from_action_bundle(bundle: &ActionBundleDraft) -> PlanContract {
    let mut plan = bundle.to_plan_contract();
    if plan.completion_criteria.is_empty() {
        plan.completion_criteria = vec![CompletionCriteria {
            id: "action-bundle-validation-required".to_string(),
            description: "Action bundle requires at least one validation or evidence result."
                .to_string(),
            evidence_required: Vec::new(),
            validation_kind: None,
        }];
    }
    plan
}

fn plan_review_status_name(status: &PlanReviewStatus) -> &'static str {
    match status {
        PlanReviewStatus::AutoAccepted => "autoAccepted",
        PlanReviewStatus::AwaitingUserApproval => "awaitingUserApproval",
        PlanReviewStatus::AwaitingTemporaryGrant => "awaitingTemporaryGrant",
        PlanReviewStatus::Denied => "denied",
        PlanReviewStatus::NeedsRevision => "needsRevision",
        PlanReviewStatus::InterfaceOnly => "interfaceOnly",
    }
}

pub(crate) fn autonomy_level_name(level: &AutonomyLevel) -> &'static str {
    match level {
        AutonomyLevel::Safe => "safe",
        AutonomyLevel::Developer => "developer",
        AutonomyLevel::Trusted => "trusted",
        AutonomyLevel::Expert => "expert",
        AutonomyLevel::MaintainerRoot => "maintainerRoot",
    }
}

pub(crate) fn kernel_event_kind(event: &KernelEvent) -> &'static str {
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

pub(crate) fn kernel_event_sequence(event: &KernelEvent) -> Option<u64> {
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
