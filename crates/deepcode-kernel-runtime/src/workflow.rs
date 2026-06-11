use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn run_start(
        &mut self,
        request_id: RequestId,
        session_id: Option<SessionId>,
        input_text: String,
        workspace_binding: Option<WorkspaceBinding>,
        profile_ref: Option<ProfileRef>,
        workflow_id: Option<String>,
        run_overrides: Option<Value>,
    ) -> KernelResult<Vec<KernelEvent>> {
        let workspace_binding = workspace_binding.ok_or(KernelError::MissingWorkspaceBinding)?;
        self.state.next_run_index += 1;
        let run_id = format!("run-{}", self.state.next_run_index);
        let session_id = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| format!("session-{}", self.state.next_run_index));

        let config_snapshot = self.resolve_minimal_config(
            &run_id,
            profile_ref.as_ref().map(|value| value.id.clone()),
            workflow_id.clone(),
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
                "summary": "Headless kernel run skeleton started.",
                "inputText": input_text,
                "workspaceBinding": &workspace_binding,
                "configRef": &config_ref,
                "profileRef": &profile_ref,
                "policyProfile": &self.policy_profile.id,
                "skillCount": self.skills.len(),
                "promptCompiler": if self.prompt_compiler.require_kernel_safety { "layered" } else { "layered-unchecked" }
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
                "summary": "Workflow checkpoint created.",
                "runId": &run_id,
                "sessionId": &session_id,
                "phase": workflow_state.phase.as_str(),
                "sequence": sequence,
                "pendingPermissionId": null,
                "activeWorkUnitIds": []
            }),
        )?;

        sequence += 1;
        self.append_ledger(
            &run_id,
            &session_id,
            "stage.changed",
            sequence,
            serde_json::json!({
                "summary": "Workflow entered plan stage.",
                "phase": workflow_state.phase.as_str(),
                "status": "running"
            }),
        )?;

        self.state.records_by_session.insert(
            session_id.clone(),
            RuntimeRunRecord {
                session_id: session_id.clone(),
                run_id: run_id.clone(),
                input_text: input_text.clone(),
                workspace_binding: workspace_binding.clone(),
                config_ref: config_ref.clone(),
                profile_ref: profile_ref.clone(),
                phase: workflow_state.phase.clone(),
                active_llm_call_id: None,
                llm_call_index: 0,
                decision_state: RunDecisionState::from_user_input(&input_text),
            },
        );

        let llm_call = self.llm_call_requested_event(&run_id, &session_id)?;

        Ok(vec![
            KernelEvent::RunStarted {
                request_id: Some(request_id),
                run_id: RunId(run_id.clone()),
                session_id: Some(SessionId(session_id.clone())),
                workspace_binding,
                sequence: Some(1),
            },
            KernelEvent::ConfigSnapshotAttached {
                run_id: Some(RunId(run_id.clone())),
                session_id: Some(SessionId(session_id.clone())),
                snapshot_ref: config_ref,
                sequence: Some(2),
            },
            KernelEvent::WorkflowCheckpointed {
                run_id: RunId(run_id.clone()),
                session_id: Some(SessionId(session_id.clone())),
                checkpoint_id: format!("checkpoint-{run_id}-3"),
                phase: workflow_state.phase.as_str().to_string(),
                sequence: Some(3),
            },
            KernelEvent::StageChanged {
                run_id: Some(RunId(run_id)),
                session_id: Some(SessionId(session_id)),
                turn_id: None,
                stage_run_id: None,
                phase: workflow_state.phase.as_str().to_string(),
                status: StageStatus::Running,
                reason: None,
                sequence: Some(4),
            },
            llm_call,
        ])
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

    pub(crate) fn plan_accept(
        &mut self,
        _request_id: RequestId,
        run_id: RunId,
        plan_id: String,
        auto_accepted: bool,
    ) -> KernelResult<Vec<KernelEvent>> {
        let run_id_text = run_id.0.clone();
        let record = self.record_by_run(&run_id_text)?;
        let session_id = record.session_id.clone();
        let sequence = self.ledger.next_sequence(&run_id_text)?;
        self.append_ledger(
            &run_id_text,
            &session_id,
            "plan.accepted",
            sequence,
            serde_json::json!({
                "summary": "Plan accepted.",
                "planId": &plan_id,
                "autoAccepted": auto_accepted
            }),
        )?;
        let mut events = vec![KernelEvent::PlanAccepted {
            run_id,
            session_id: Some(SessionId(session_id.clone())),
            plan_id,
            auto_accepted,
            sequence: Some(sequence),
        }];
        events.push(self.enter_phase_event(&run_id_text, &session_id, WorkflowPhase::Complete)?);
        if self
            .state
            .approved_tools_by_run
            .get(&run_id_text)
            .map(|queue| !queue.is_empty())
            .unwrap_or(false)
        {
            events.extend(self.auto_continue_after_tool(&run_id_text, &session_id)?);
            events.push(self.workflow_decision_event(
                RequestId("agent-plan-approved-tools".to_string()),
                &run_id_text,
                &session_id,
                "approved_tools.completed",
            )?);
        } else {
            events.push(self.llm_call_requested_event(&run_id_text, &session_id)?);
        }
        Ok(events)
    }

    pub(crate) fn plan_reject(
        &self,
        _request_id: RequestId,
        run_id: RunId,
        plan_id: String,
        reason: Option<String>,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?;
        let sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &record.session_id,
            "plan.rejected",
            sequence,
            serde_json::json!({
                "summary": "Plan rejected.",
                "planId": &plan_id,
                "reason": &reason
            }),
        )?;
        Ok(vec![KernelEvent::PlanRejected {
            run_id,
            session_id: Some(SessionId(record.session_id)),
            plan_id,
            reason,
            sequence: Some(sequence),
        }])
    }

    pub(crate) fn plan_revise(
        &self,
        request_id: RequestId,
        run_id: RunId,
        plan_id: String,
        guidance: String,
    ) -> KernelResult<Vec<KernelEvent>> {
        self.plan_reject(request_id, run_id, plan_id, Some(guidance))
    }

    pub(crate) fn plan_contract_submit(
        &mut self,
        request_id: RequestId,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        contract: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let (run_id, session_id) = self.resolve_run_session(run_id, session_id)?;
        let report = match parse_plan_review_input(contract) {
            Ok(input) => DefaultPlanReviewEngine.review_input(input),
            Err(reason) => PlanReviewReport::denied("invalid-contract", reason),
        };
        let sequence = self.ledger.next_sequence(&run_id)?;
        let report_value =
            serde_json::to_value(&report).unwrap_or_else(|_| serde_json::Value::Null);
        self.append_ledger(
            &run_id,
            &session_id,
            "plan.review_report_produced",
            sequence,
            serde_json::json!({
                "summary": report.kernel_generated_permission_summary,
                "planId": report.plan_id,
                "status": plan_review_status_name(&report.status),
                "report": &report_value
            }),
        )?;
        Ok(vec![KernelEvent::PlanReviewReportProduced {
            request_id: Some(request_id),
            run_id: Some(RunId(run_id)),
            session_id: Some(SessionId(session_id)),
            report: report_value,
            sequence: Some(sequence),
        }])
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
            record.active_llm_call_id = None;
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

    pub(crate) fn complete_run_event(
        &mut self,
        run_id: &str,
        session_id: &str,
    ) -> KernelResult<KernelEvent> {
        let change_set = self.change_set_for_run(run_id)?;
        let validations = self.validations_for_run(run_id)?;
        let evidence_refs = self.evidence_refs_for_run(run_id)?;
        let review_gate = ReviewGate;
        let review_result =
            review_gate.evaluate(run_id, change_set.as_ref(), &validations, evidence_refs);
        let review_sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "review_gate.result",
            review_sequence,
            serde_json::json!({
                "summary": review_result.summary,
                "reviewGate": &review_result
            }),
        )?;
        if review_result.status != ReviewGateStatus::Accepted {
            return Err(KernelError::PermissionDenied(format!(
                "review gate blocked completion: {}",
                review_result.summary
            )));
        }
        self.release_workflow_resources(run_id, session_id)?;
        {
            let record = self.record_by_run_mut(run_id)?;
            record.phase = WorkflowPhase::Done;
            record.active_llm_call_id = None;
        }
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "run.completed",
            sequence,
            serde_json::json!({
                "summary": "Kernel workflow completed.",
                "status": "completed"
            }),
        )?;
        Ok(KernelEvent::RunCompleted {
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            status: deepcode_kernel_abi::RunStatus::Completed,
            summary: Some("Kernel workflow completed.".to_string()),
            sequence: Some(sequence),
        })
    }

    fn release_workflow_resources(&mut self, run_id: &str, session_id: &str) -> KernelResult<()> {
        let owner = KernelResourceOwner::agent_workflow(None::<String>, run_id.to_string());
        let resources = self.state.resource_registry.active_by_owner(&owner);
        for resource in resources {
            let cleanup = cleanup_workflow_resource(&resource);
            let release = self.state.resource_registry.release(&resource.resource_id);
            let sequence = self.ledger.next_sequence(run_id)?;
            self.append_ledger(
                run_id,
                session_id,
                "resource.released",
                sequence,
                serde_json::json!({
                    "summary": format!("Kernel released workflow resource: {}", resource.resource_id),
                    "resourceId": &resource.resource_id,
                    "kind": &resource.kind,
                    "owner": &resource.owner,
                    "scope": &resource.scope,
                    "cleanupPolicy": &resource.cleanup_policy,
                    "cleanup": cleanup,
                    "released": release.released,
                    "error": release.error
                }),
            )?;
        }
        Ok(())
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

fn cleanup_workflow_resource(resource: &KernelResource) -> Value {
    if resource.cleanup_policy != KernelResourceCleanupPolicy::OnWorkflowEnd {
        return serde_json::json!({
            "attempted": false,
            "reason": "cleanup policy is not OnWorkflowEnd"
        });
    }
    if !matches!(
        resource.kind,
        KernelResourceKind::TempArtifact
            | KernelResourceKind::RedirectOutput
            | KernelResourceKind::CacheFile
    ) {
        return serde_json::json!({
            "attempted": false,
            "reason": "resource kind has no file cleanup handler"
        });
    }
    let Some(absolute_path) = resource
        .metadata
        .get("absolutePath")
        .and_then(Value::as_str)
    else {
        return serde_json::json!({
            "attempted": false,
            "reason": "resource has no absolutePath metadata"
        });
    };
    match fs::remove_file(absolute_path) {
        Ok(()) => serde_json::json!({
            "attempted": true,
            "removed": true,
            "absolutePath": absolute_path
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({
            "attempted": true,
            "removed": true,
            "absolutePath": absolute_path,
            "alreadyMissing": true
        }),
        Err(error) => serde_json::json!({
            "attempted": true,
            "removed": false,
            "absolutePath": absolute_path,
            "error": error.to_string()
        }),
    }
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

fn parse_plan_review_input(contract: Value) -> Result<PlanReviewInput, String> {
    if let Ok(input) = serde_json::from_value::<PlanReviewInput>(contract.clone()) {
        return Ok(input);
    }
    if let Ok(plan) = serde_json::from_value::<PlanContract>(contract.clone()) {
        return Ok(PlanReviewInput {
            plan,
            action_bundle: None,
        });
    }
    if let Ok(action_bundle) = serde_json::from_value::<ActionBundleDraft>(contract) {
        let plan = plan_contract_from_action_bundle(&action_bundle);
        return Ok(PlanReviewInput {
            plan,
            action_bundle: Some(action_bundle),
        });
    }
    Err(
        "contract must be a structured PlanContract, PlanReviewInput, or ActionBundleDraft"
            .to_string(),
    )
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
        KernelEvent::RunStarted { .. } => "run.started",
        KernelEvent::RunCompleted { .. } => "run.completed",
        KernelEvent::StageChanged { .. } => "stage.changed",
        KernelEvent::MessageAppended { .. } => "message.appended",
        KernelEvent::LlmCallRequested { .. } => "llm.call_requested",
        KernelEvent::LlmProviderError { .. } => "llm.provider_error",
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

pub(crate) fn kernel_event_sequence(event: &KernelEvent) -> Option<u64> {
    match event {
        KernelEvent::RunStarted { sequence, .. }
        | KernelEvent::RunCompleted { sequence, .. }
        | KernelEvent::StageChanged { sequence, .. }
        | KernelEvent::MessageAppended { sequence, .. }
        | KernelEvent::LlmCallRequested { sequence, .. }
        | KernelEvent::LlmProviderError { sequence, .. }
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
