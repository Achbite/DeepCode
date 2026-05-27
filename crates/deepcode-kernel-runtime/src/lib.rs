use deepcode_kernel_abi::{
    AnswerObligation, AnswerObligationId, AnswerObligationStatus, ConfigSnapshotRef, HostStatus,
    KernelCommand, KernelError, KernelEvent, KernelEventSummary, KernelResult, KernelSnapshot,
    RequestId, RunId, SessionId, StageStatus, WorkflowDecision, WorkflowDecisionAction,
    WorkflowDecisionReason, WorkspaceBinding,
};
use deepcode_kernel_config::{
    ConfigLayer, ConfigResolver, ConfigResolverInput, ConfigScope, ConfigSource, ConfigSourceKind,
    ConfigTrustLevel, DefaultConfigResolver,
};
use deepcode_kernel_ledger::{EventLedger, InMemoryEventLedger, LedgerEvent};
use deepcode_kernel_policy::PolicyProfile;
use deepcode_kernel_prompt::LayeredPromptCompiler;
use deepcode_kernel_skills::{InMemorySkillRegistry, SkillRegistry, SkillRuntime};
use deepcode_kernel_workflow::{BuiltinWorkflowMachine, WorkflowMachine, WorkflowPhase};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug)]
pub struct DeepCodeKernelRuntime {
    config_resolver: DefaultConfigResolver,
    prompt_compiler: LayeredPromptCompiler,
    workflow: BuiltinWorkflowMachine,
    policy_profile: PolicyProfile,
    skills: InMemorySkillRegistry,
    ledger: InMemoryEventLedger,
    state: RuntimeState,
}

#[derive(Debug, Default)]
struct RuntimeState {
    next_run_index: u64,
    next_workspace_index: u64,
    current_workspace: Option<RuntimeWorkspace>,
    records_by_session: BTreeMap<String, RuntimeRunRecord>,
}

#[derive(Debug, Clone)]
struct RuntimeWorkspace {
    id: String,
    name: String,
    source: WorkspaceSource,
    source_path: Option<PathBuf>,
    root: PathBuf,
    original_folder_path: String,
    folder_is_absolute: bool,
    settings: Value,
    unsupported_fields: Vec<Value>,
    opened_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkspaceSource {
    Directory,
    CodeWorkspace,
}

#[derive(Debug, Clone)]
struct RuntimeRunRecord {
    session_id: String,
    run_id: String,
    workspace_binding: WorkspaceBinding,
    config_ref: ConfigSnapshotRef,
    phase: WorkflowPhase,
    decision_state: WorkflowDecisionState,
}

#[derive(Debug, Clone, Default)]
struct WorkflowDecisionState {
    answer_obligations: Vec<AnswerObligation>,
    temp_lifecycle_required: bool,
    workspace_listed: bool,
    temp_created: bool,
    temp_read_back: bool,
    temp_cleanup_requested: bool,
    temp_cleaned: bool,
    awaiting_permission: bool,
    blocked_reason: Option<String>,
}

impl WorkflowDecisionState {
    fn from_user_input(input: &str) -> Self {
        let lower = input.to_lowercase();
        let mut state = Self {
            temp_lifecycle_required: has_temp_file_lifecycle_request(input, &lower),
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
        if has_tool_component_request(input, &lower) {
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

    fn apply_event(&mut self, event: &KernelEvent) {
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
                tool_name,
                ok,
                output,
                error,
                ..
            } => {
                self.awaiting_permission = false;
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
                    "fs.list" => self.workspace_listed = true,
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
                        if output
                            .as_ref()
                            .map(output_mentions_temp_file)
                            .unwrap_or(false)
                        {
                            self.temp_read_back = true;
                        }
                    }
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
            KernelEvent::PermissionResolved { decision, .. } => {
                self.awaiting_permission = false;
                if matches!(
                    decision,
                    deepcode_kernel_abi::PermissionDecisionKind::Reject
                ) {
                    self.blocked_reason = Some("permission rejected".to_string());
                } else {
                    self.blocked_reason = None;
                }
            }
            KernelEvent::MessageAppended { role, content, .. } => {
                if !matches!(role, deepcode_kernel_abi::MessageRole::Agent) {
                    return;
                }
                let content = content.as_deref().unwrap_or_default();
                if content.contains("DeepCode Agent") {
                    self.satisfy_obligation(AnswerObligationId::Identity, event);
                }
                if content.contains("fs.read")
                    || content.contains("fs.list")
                    || content.contains("fs.write")
                    || content.contains("shell.exec")
                {
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

    fn decide(&self, phase: &str) -> WorkflowDecision {
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

    fn pending_steps(&self) -> Vec<String> {
        if !self.temp_lifecycle_required {
            return Vec::new();
        }
        let mut steps = Vec::new();
        if !self.workspace_listed {
            steps.push("list workspace root".to_string());
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

    fn temp_lifecycle_complete(&self) -> bool {
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
            obligation.satisfied_by_event = Some(kernel_event_identity(event));
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

impl Default for DeepCodeKernelRuntime {
    fn default() -> Self {
        Self {
            config_resolver: DefaultConfigResolver,
            prompt_compiler: LayeredPromptCompiler::default(),
            workflow: BuiltinWorkflowMachine::default(),
            policy_profile: PolicyProfile::developer_defaults(),
            skills: InMemorySkillRegistry::with_builtin_tools(),
            ledger: InMemoryEventLedger::new(),
            state: RuntimeState::default(),
        }
    }
}

impl DeepCodeKernelRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn dispatch(&mut self, command: KernelCommand) -> KernelResult<Vec<KernelEvent>> {
        match command {
            KernelCommand::HealthCheck { request_id } => Ok(vec![KernelEvent::HostStatus {
                request_id: Some(request_id),
                status: HostStatus::Ready,
                detail: Some("headless kernel runtime ready".to_string()),
                message_key: Some("kernel.host.ready".to_string()),
                args: None,
            }]),
            KernelCommand::RunStart {
                request_id,
                session_id,
                input,
                workspace_binding,
                profile_ref,
                workflow_ref,
                run_overrides,
            } => self.run_start(
                request_id,
                session_id,
                input.text,
                workspace_binding,
                profile_ref.map(|value| value.id),
                workflow_ref.map(|value| value.id),
                run_overrides,
            ),
            KernelCommand::SnapshotGet {
                request_id,
                session_id,
            } => self.snapshot_get(request_id, session_id),
            KernelCommand::ConfigGet { request_id } => {
                self.not_implemented(request_id, "config.get")
            }
            KernelCommand::ConfigPatch { request_id, .. } => {
                self.not_implemented(request_id, "config.patch")
            }
            KernelCommand::RunCancel { request_id, .. } => {
                self.not_implemented(request_id, "run.cancel")
            }
            KernelCommand::RunResume {
                request_id,
                session_id,
            } => self.run_resume(request_id, session_id),
            KernelCommand::WorkspaceOpen { request_id, path } => {
                self.workspace_open(request_id, path)
            }
            KernelCommand::WorkspaceCurrent { request_id } => self.workspace_current(request_id),
            KernelCommand::WorkspaceList {
                request_id,
                folder_id,
                path,
                depth,
            } => self.workspace_list(request_id, folder_id, path, depth),
            KernelCommand::WorkspaceRead {
                request_id,
                folder_id,
                path,
            } => self.workspace_read(request_id, folder_id, path),
            KernelCommand::WorkspaceWrite {
                request_id,
                folder_id,
                path,
                content,
                create,
            } => self.workspace_write(request_id, folder_id, path, content, create),
            KernelCommand::WorkspaceCreate {
                request_id,
                folder_id,
                path,
                content,
            } => self.workspace_create(request_id, folder_id, path, content),
            KernelCommand::WorkspaceCreateFolder {
                request_id,
                folder_id,
                path,
            } => self.workspace_create_folder(request_id, folder_id, path),
            KernelCommand::WorkspaceRename {
                request_id,
                folder_id,
                old_path,
                new_path,
            } => self.workspace_rename(request_id, folder_id, old_path, new_path),
            KernelCommand::WorkspaceDelete {
                request_id,
                folder_id,
                path,
            } => self.workspace_delete(request_id, folder_id, path),
            KernelCommand::WorkspaceSearch {
                request_id,
                folder_id,
                query,
                include,
                is_regex,
            } => self.workspace_search(request_id, folder_id, query, include, is_regex),
            KernelCommand::SkillDiscover { request_id } => self.skill_discover(request_id),
            KernelCommand::SkillInvoke {
                request_id,
                skill_id,
                input,
            } => self.skill_invoke(request_id, skill_id, input),
            KernelCommand::ContextAttachReference {
                request_id,
                source_path,
                import_copy,
            } => self.context_attach_reference(request_id, source_path, import_copy),
            KernelCommand::ContextListReferences { request_id } => {
                self.context_list_references(request_id)
            }
            KernelCommand::WorkflowObserve {
                request_id,
                run_id,
                session_id,
                event,
            } => self.workflow_observe(request_id, run_id, session_id, *event),
            KernelCommand::PermissionResolve { request_id, .. } => {
                self.not_implemented(request_id, "permission.resolve")
            }
            KernelCommand::PlanAccept {
                request_id,
                run_id,
                plan_id,
            } => self.plan_accept(request_id, run_id, plan_id, false),
            KernelCommand::PlanReject {
                request_id,
                run_id,
                plan_id,
                reason,
            } => self.plan_reject(request_id, run_id, plan_id, reason),
            KernelCommand::PlanRevise {
                request_id,
                run_id,
                plan_id,
                guidance,
            } => self.plan_revise(request_id, run_id, plan_id, guidance),
            KernelCommand::PermissionGrantTemporary {
                request_id,
                run_id,
                grant,
            } => self.permission_grant_temporary(request_id, run_id, grant),
        }
    }

    pub fn snapshot(&self, session_id: Option<&str>) -> KernelSnapshot {
        let record = session_id
            .and_then(|id| self.state.records_by_session.get(id))
            .or_else(|| self.state.records_by_session.values().last());

        let events = record
            .map(|record| self.ledger.list_by_run(&record.run_id).unwrap_or_default())
            .unwrap_or_default();

        KernelSnapshot {
            session_id: record.map(|value| SessionId(value.session_id.clone())),
            run_id: record.map(|value| RunId(value.run_id.clone())),
            workspace_binding: record.map(|value| value.workspace_binding.clone()),
            config_ref: record.map(|value| value.config_ref.clone()),
            workflow_phase: record.map(|value| value.phase.as_str().to_string()),
            pending_stage: None,
            events: events
                .iter()
                .map(|event| KernelEventSummary {
                    id: Some(event.id.clone()),
                    kind: event.kind.clone(),
                    sequence: event.sequence,
                    summary: event
                        .payload
                        .get("summary")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
                .collect(),
            pending_permission: None,
            updated_at: None,
        }
    }

    pub fn ledger(&self, run_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        self.ledger.list_by_run(run_id)
    }

    fn run_start(
        &mut self,
        request_id: RequestId,
        session_id: Option<SessionId>,
        input_text: String,
        workspace_binding: Option<WorkspaceBinding>,
        profile_id: Option<String>,
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
            profile_id.clone(),
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
                workspace_binding: workspace_binding.clone(),
                config_ref: config_ref.clone(),
                phase: workflow_state.phase.clone(),
                decision_state: WorkflowDecisionState::from_user_input(&input_text),
            },
        );

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
        ])
    }

    fn run_resume(
        &self,
        request_id: RequestId,
        session_id: SessionId,
    ) -> KernelResult<Vec<KernelEvent>> {
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

    fn workflow_observe(
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
            record.decision_state.apply_event(&event);
            record.decision_state.decide(record.phase.as_str())
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

    fn plan_accept(
        &self,
        _request_id: RequestId,
        run_id: RunId,
        plan_id: String,
        auto_accepted: bool,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?;
        let sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &record.session_id,
            "plan.accepted",
            sequence,
            serde_json::json!({
                "summary": "Plan accepted.",
                "planId": &plan_id,
                "autoAccepted": auto_accepted
            }),
        )?;
        Ok(vec![KernelEvent::PlanAccepted {
            run_id,
            session_id: Some(SessionId(record.session_id)),
            plan_id,
            auto_accepted,
            sequence: Some(sequence),
        }])
    }

    fn plan_reject(
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

    fn plan_revise(
        &self,
        request_id: RequestId,
        run_id: RunId,
        plan_id: String,
        guidance: String,
    ) -> KernelResult<Vec<KernelEvent>> {
        self.plan_reject(request_id, run_id, plan_id, Some(guidance))
    }

    fn permission_grant_temporary(
        &self,
        _request_id: RequestId,
        run_id: RunId,
        grant: deepcode_kernel_abi::TemporaryGrantEnvelope,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?;
        let sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &record.session_id,
            "temporaryGrant.created",
            sequence,
            serde_json::json!({
                "summary": "Temporary permission grant recorded.",
                "grant": grant
            }),
        )?;
        Ok(vec![KernelEvent::MessageAppended {
            run_id: Some(run_id),
            session_id: Some(SessionId(record.session_id)),
            turn_id: None,
            role: deepcode_kernel_abi::MessageRole::System,
            channel: Some("policy".to_string()),
            content: None,
            message_key: Some("permission.temporaryGrant.created".to_string()),
            args: None,
            sequence: Some(sequence),
        }])
    }

    fn workspace_open(
        &mut self,
        request_id: RequestId,
        path: String,
    ) -> KernelResult<Vec<KernelEvent>> {
        let resolved = resolve_workspace_root(&path).map_err(KernelError::InvalidCommand)?;
        self.state.next_workspace_index += 1;
        let id = format!("ws-{}", self.state.next_workspace_index);
        let name = resolved
            .source_path
            .as_ref()
            .or(Some(&resolved.root))
            .and_then(|path| path.file_stem().or_else(|| path.file_name()))
            .and_then(OsStr::to_str)
            .unwrap_or("workspace")
            .to_string();
        let workspace = RuntimeWorkspace {
            id: id.clone(),
            name,
            source: resolved.source,
            source_path: resolved.source_path,
            root: resolved.root,
            original_folder_path: resolved.original_folder_path,
            folder_is_absolute: resolved.folder_is_absolute,
            settings: resolved.settings,
            unsupported_fields: resolved.unsupported_fields,
            opened_at: now_millis().to_string(),
        };
        let output = workspace_json(&workspace);
        self.state.current_workspace = Some(workspace);
        Ok(vec![KernelEvent::WorkspaceResult {
            request_id,
            operation: "workspace.open".to_string(),
            ok: true,
            output: Some(serde_json::json!({ "workspace": output })),
            error: None,
            sequence: None,
        }])
    }

    fn workspace_current(&self, request_id: RequestId) -> KernelResult<Vec<KernelEvent>> {
        Ok(vec![KernelEvent::WorkspaceResult {
            request_id,
            operation: "workspace.current".to_string(),
            ok: true,
            output: Some(serde_json::json!({
                "current": self.state.current_workspace.as_ref().map(workspace_json),
                "fallbackUsed": false,
                "lastError": null
            })),
            error: None,
            sequence: None,
        }])
    }

    fn workspace_list(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        path: Option<String>,
        depth: Option<u32>,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            let relative = path.unwrap_or_else(|| ".".to_string());
            let target = self.resolve_workspace_path(&relative)?;
            let nodes = list_nodes(&target, &workspace.root, depth.unwrap_or(2).min(5))?;
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&relative),
                "nodes": nodes
            }))
        })();
        self.workspace_result(request_id, "workspace.list", result)
    }

    fn workspace_read(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let _workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            let target = self.resolve_workspace_path(&path)?;
            if !target.is_file() {
                return Err(KernelError::InvalidCommand(format!("{path} is not a file")));
            }
            let content = fs::read_to_string(&target)
                .map_err(|error| KernelError::Other(format!("read {path}: {error}")))?;
            let size_bytes = content.len();
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "content": content,
                "sizeBytes": size_bytes,
                "binary": false
            }))
        })();
        self.workspace_result(request_id, "workspace.read", result)
    }

    fn workspace_write(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
        content: String,
        create: bool,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let _workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            deny_protected_deepcode_mutation(&path)?;
            let target = self.resolve_workspace_path(&path)?;
            if !create && !target.exists() {
                return Err(KernelError::InvalidCommand(format!(
                    "{path} does not exist"
                )));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| KernelError::Other(format!("create parent: {error}")))?;
            }
            fs::write(&target, content)
                .map_err(|error| KernelError::Other(format!("write {path}: {error}")))?;
            let size_bytes = fs::metadata(&target)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "saved": true,
                "sizeBytes": size_bytes
            }))
        })();
        self.workspace_result(request_id, "workspace.write", result)
    }

    fn workspace_create(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
        content: Option<String>,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let _workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            deny_protected_deepcode_mutation(&path)?;
            let target = self.resolve_workspace_path(&path)?;
            if target.exists() {
                return Err(KernelError::InvalidCommand(format!(
                    "{path} already exists"
                )));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| KernelError::Other(format!("create parent: {error}")))?;
            }
            fs::write(&target, content.unwrap_or_default())
                .map_err(|error| KernelError::Other(format!("create {path}: {error}")))?;
            let size_bytes = fs::metadata(&target)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "created": true,
                "saved": true,
                "sizeBytes": size_bytes
            }))
        })();
        self.workspace_result(request_id, "workspace.create", result)
    }

    fn workspace_create_folder(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let _workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            deny_protected_deepcode_mutation(&path)?;
            let target = self.resolve_workspace_path(&path)?;
            if target.exists() && !target.is_dir() {
                return Err(KernelError::InvalidCommand(format!(
                    "{path} already exists and is not a directory"
                )));
            }
            fs::create_dir_all(&target)
                .map_err(|error| KernelError::Other(format!("create folder {path}: {error}")))?;
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "created": true
            }))
        })();
        self.workspace_result(request_id, "workspace.create_folder", result)
    }

    fn workspace_rename(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        old_path: String,
        new_path: String,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let _workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            deny_protected_deepcode_mutation(&old_path)?;
            deny_protected_deepcode_mutation(&new_path)?;
            let old_target = self.resolve_workspace_path(&old_path)?;
            let new_target = self.resolve_workspace_path(&new_path)?;
            if let Some(parent) = new_target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| KernelError::Other(format!("create parent: {error}")))?;
            }
            fs::rename(&old_target, &new_target)
                .map_err(|error| KernelError::Other(format!("rename {old_path}: {error}")))?;
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "oldPath": normalize_relative_path(&old_path),
                "newPath": normalize_relative_path(&new_path),
                "renamed": true
            }))
        })();
        self.workspace_result(request_id, "workspace.rename", result)
    }

    fn workspace_delete(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let _workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            deny_protected_deepcode_mutation(&path)?;
            let target = self.resolve_workspace_path(&path)?;
            let kind = if target.is_dir() { "directory" } else { "file" };
            if target.is_dir() {
                return Err(KernelError::PermissionDenied(
                    "workspace.delete only accepts files in this kernel stage".to_string(),
                ));
            }
            fs::remove_file(&target)
                .map_err(|error| KernelError::Other(format!("delete {path}: {error}")))?;
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "deleted": true,
                "kind": kind
            }))
        })();
        self.workspace_result(request_id, "workspace.delete", result)
    }

    fn workspace_search(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        query: String,
        include: Option<Vec<String>>,
        is_regex: bool,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            if is_regex {
                return Err(KernelError::NotImplemented("workspace.search.regex"));
            }
            if query.trim().is_empty() {
                return Err(KernelError::InvalidCommand(
                    "search query is required".to_string(),
                ));
            }
            let includes = include.unwrap_or_default();
            let matches = search_workspace(&workspace.root, &query, &includes)?;
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "query": query,
                "matches": matches
            }))
        })();
        self.workspace_result(request_id, "workspace.search", result)
    }

    fn skill_discover(&self, request_id: RequestId) -> KernelResult<Vec<KernelEvent>> {
        let descriptors = self.skills.list()?;
        Ok(vec![KernelEvent::SkillResult {
            request_id,
            skill_id: None,
            ok: true,
            output: Some(serde_json::json!({ "skills": descriptors })),
            error: None,
            sequence: None,
        }])
    }

    fn skill_invoke(
        &self,
        request_id: RequestId,
        skill_id: String,
        input: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = self
            .skills
            .invoke(deepcode_kernel_skills::SkillInvocation {
                id: request_id.0.clone(),
                skill_id: skill_id.clone(),
                phase: Some("complete".to_string()),
                input,
            })
            .map(|value| serde_json::to_value(value).unwrap_or(Value::Null));

        Ok(vec![KernelEvent::SkillResult {
            request_id,
            skill_id: Some(skill_id),
            ok: result.is_ok(),
            output: result.as_ref().ok().cloned(),
            error: result.as_ref().err().map(Into::into),
            sequence: None,
        }])
    }

    fn context_attach_reference(
        &self,
        request_id: RequestId,
        source_path: String,
        import_copy: bool,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            if source_path.trim().is_empty() {
                return Err(KernelError::InvalidCommand(
                    "reference source path is required".to_string(),
                ));
            }
            if import_copy {
                return Err(KernelError::NotImplemented("context.reference.import"));
            }
            Ok(serde_json::json!({
                "reference": {
                    "sourcePath": source_path,
                    "mode": "externalReadOnly"
                }
            }))
        })();
        self.context_result(request_id, "context.attachReference", result)
    }

    fn context_list_references(&self, request_id: RequestId) -> KernelResult<Vec<KernelEvent>> {
        self.context_result(
            request_id,
            "context.listReferences",
            Ok(serde_json::json!({ "references": [] })),
        )
    }

    fn current_workspace(&self) -> KernelResult<&RuntimeWorkspace> {
        self.state
            .current_workspace
            .as_ref()
            .ok_or(KernelError::MissingWorkspaceBinding)
    }

    fn resolve_workspace_path(&self, relative_path: &str) -> KernelResult<PathBuf> {
        let workspace = self.current_workspace()?;
        resolve_relative_path(&workspace.root, relative_path)
    }

    fn workspace_result(
        &self,
        request_id: RequestId,
        operation: &str,
        result: KernelResult<Value>,
    ) -> KernelResult<Vec<KernelEvent>> {
        Ok(vec![KernelEvent::WorkspaceResult {
            request_id,
            operation: operation.to_string(),
            ok: result.is_ok(),
            output: result.as_ref().ok().cloned(),
            error: result.as_ref().err().map(Into::into),
            sequence: None,
        }])
    }

    fn context_result(
        &self,
        request_id: RequestId,
        operation: &str,
        result: KernelResult<Value>,
    ) -> KernelResult<Vec<KernelEvent>> {
        Ok(vec![KernelEvent::ContextResult {
            request_id,
            operation: operation.to_string(),
            ok: result.is_ok(),
            output: result.as_ref().ok().cloned(),
            error: result.as_ref().err().map(Into::into),
            sequence: None,
        }])
    }

    fn snapshot_get(
        &self,
        request_id: RequestId,
        session_id: Option<SessionId>,
    ) -> KernelResult<Vec<KernelEvent>> {
        Ok(vec![KernelEvent::SnapshotReady {
            request_id,
            snapshot: self.snapshot(session_id.as_ref().map(|value| value.0.as_str())),
        }])
    }

    fn resolve_minimal_config(
        &self,
        run_id: &str,
        profile_id: Option<String>,
        workflow_id: Option<String>,
        run_overrides: Option<Value>,
    ) -> KernelResult<deepcode_kernel_abi::ConfigSnapshot> {
        let mut layers = vec![ConfigLayer {
            source: ConfigSource {
                id: "kernel-default".to_string(),
                kind: ConfigSourceKind::KernelDefault,
                scope: ConfigScope::Run,
                path: None,
                trust_level: ConfigTrustLevel::Kernel,
                schema_version: "1".to_string(),
                content_hash: None,
            },
            domain: None,
            values: serde_json::json!({
                "run": { "id": run_id },
                "workflow": { "default": workflow_id.unwrap_or_else(|| "plan-first".to_string()) },
                "policy": { "profile": profile_id.unwrap_or_else(|| self.policy_profile.id.clone()) },
                "prompt": { "compiler": "layered" }
            }),
        }];

        if let Some(overrides) = run_overrides {
            layers.push(ConfigLayer {
                source: ConfigSource {
                    id: "run-overrides".to_string(),
                    kind: ConfigSourceKind::RunOverride,
                    scope: ConfigScope::Run,
                    path: None,
                    trust_level: ConfigTrustLevel::User,
                    schema_version: "1".to_string(),
                    content_hash: None,
                },
                domain: None,
                values: overrides,
            });
        }

        self.config_resolver.resolve(ConfigResolverInput {
            schema_version: "1".to_string(),
            layers,
            kernel_invariants: Some(serde_json::json!({
                "kernel": { "hardBoundary": true }
            })),
            created_at: None,
        })
    }

    fn append_ledger(
        &self,
        run_id: &str,
        session_id: &str,
        kind: &str,
        sequence: u64,
        payload: Value,
    ) -> KernelResult<()> {
        self.ledger.append(LedgerEvent {
            id: format!("evt-{run_id}-{sequence}"),
            run_id: Some(run_id.to_string()),
            session_id: Some(session_id.to_string()),
            kind: kind.to_string(),
            sequence: Some(sequence),
            payload,
            created_at: None,
        })
    }

    fn record_by_run(&self, run_id: &str) -> KernelResult<RuntimeRunRecord> {
        self.state
            .records_by_session
            .values()
            .find(|record| record.run_id == run_id)
            .cloned()
            .ok_or_else(|| KernelError::InvalidCommand(format!("run {run_id} is not active")))
    }

    fn record_by_run_mut(&mut self, run_id: &str) -> KernelResult<&mut RuntimeRunRecord> {
        self.state
            .records_by_session
            .values_mut()
            .find(|record| record.run_id == run_id)
            .ok_or_else(|| KernelError::InvalidCommand(format!("run {run_id} is not active")))
    }

    fn not_implemented(
        &self,
        _request_id: RequestId,
        operation: &'static str,
    ) -> KernelResult<Vec<KernelEvent>> {
        Err(KernelError::NotImplemented(operation))
    }
}

fn has_identity_request(input: &str, lower: &str) -> bool {
    input.contains("身份")
        || input.contains("你是谁")
        || lower.contains("identity")
        || lower.contains("who are you")
}

fn has_tool_component_request(input: &str, lower: &str) -> bool {
    input.contains("功能组件")
        || input.contains("所有的功能")
        || input.contains("工具组件")
        || lower.contains("action type")
        || lower.contains("tool component")
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

fn output_mentions_temp_file(value: &Value) -> bool {
    match value {
        Value::String(text) => is_temp_file_path(text),
        Value::Array(items) => items.iter().any(output_mentions_temp_file),
        Value::Object(map) => map.values().any(output_mentions_temp_file),
        _ => false,
    }
}

#[derive(Debug)]
struct ResolvedWorkspaceRoot {
    source: WorkspaceSource,
    source_path: Option<PathBuf>,
    root: PathBuf,
    original_folder_path: String,
    folder_is_absolute: bool,
    settings: Value,
    unsupported_fields: Vec<Value>,
}

fn resolve_workspace_root(path: &str) -> Result<ResolvedWorkspaceRoot, String> {
    let source = PathBuf::from(path);
    if source.is_dir() {
        let root = source
            .canonicalize()
            .map_err(|error| format!("canonicalize workspace {path}: {error}"))?;
        return Ok(ResolvedWorkspaceRoot {
            source: WorkspaceSource::Directory,
            source_path: None,
            original_folder_path: root.to_string_lossy().to_string(),
            folder_is_absolute: true,
            root,
            settings: serde_json::json!({}),
            unsupported_fields: Vec::new(),
        });
    }
    if source.is_file() && source.extension().and_then(OsStr::to_str) == Some("code-workspace") {
        let text = fs::read_to_string(&source)
            .map_err(|error| format!("read workspace file {path}: {error}"))?;
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| format!("parse workspace file: {error}"))?;
        let folder_path = value
            .get("folders")
            .and_then(Value::as_array)
            .and_then(|folders| folders.first())
            .and_then(|folder| folder.get("path"))
            .and_then(Value::as_str)
            .ok_or_else(|| "workspace file has no folders[0].path".to_string())?;
        let source_path = source
            .canonicalize()
            .map_err(|error| format!("canonicalize workspace file {path}: {error}"))?;
        let base = source.parent().unwrap_or_else(|| Path::new("."));
        let root = base
            .join(folder_path)
            .canonicalize()
            .map_err(|error| format!("canonicalize workspace folder {folder_path}: {error}"))?;
        return Ok(ResolvedWorkspaceRoot {
            source: WorkspaceSource::CodeWorkspace,
            source_path: Some(source_path),
            root,
            original_folder_path: folder_path.to_string(),
            folder_is_absolute: Path::new(folder_path).is_absolute(),
            settings: value
                .get("settings")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
            unsupported_fields: unsupported_workspace_fields(&value),
        });
    }
    Err(format!("{path} is not a directory or .code-workspace file"))
}

fn workspace_json(workspace: &RuntimeWorkspace) -> Value {
    serde_json::json!({
        "id": &workspace.id,
        "name": &workspace.name,
        "source": match workspace.source {
            WorkspaceSource::Directory => "directory",
            WorkspaceSource::CodeWorkspace => "code-workspace",
        },
        "sourcePath": workspace.source_path.as_ref().map(|path| path.to_string_lossy().to_string()),
        "rootPath": workspace.root.to_string_lossy(),
        "folders": [
            {
                "id": "wf-0",
                "name": &workspace.name,
                "path": workspace.root.to_string_lossy(),
                "absolutePath": workspace.root.to_string_lossy(),
                "originalPath": &workspace.original_folder_path,
                "isAbsolute": workspace.folder_is_absolute
            }
        ],
        "settings": &workspace.settings,
        "unsupportedFields": &workspace.unsupported_fields,
        "openedAt": &workspace.opened_at
    })
}

fn unsupported_workspace_fields(value: &Value) -> Vec<Value> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    object
        .iter()
        .filter(|(key, _)| key.as_str() != "folders" && key.as_str() != "settings")
        .map(|(key, value)| {
            serde_json::json!({
                "key": key,
                "kind": value_kind(value)
            })
        })
        .collect()
}

fn value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn validate_folder_id(folder_id: Option<&str>) -> KernelResult<()> {
    if let Some(folder_id) = folder_id {
        if folder_id != "wf-0" {
            return Err(KernelError::InvalidCommand(format!(
                "unknown workspace folder {folder_id}"
            )));
        }
    }
    Ok(())
}

fn resolve_relative_path(root: &Path, relative_path: &str) -> KernelResult<PathBuf> {
    if relative_path.trim().is_empty() {
        return Err(KernelError::InvalidCommand(
            "workspace path is required".to_string(),
        ));
    }
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(KernelError::PermissionDenied(format!(
            "workspace syscall requires a workspace-relative path: {relative_path}"
        )));
    }
    Ok(root.join(relative))
}

fn normalize_relative_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() {
        ".".to_string()
    } else {
        normalized
    }
}

fn deny_protected_deepcode_mutation(path: &str) -> KernelResult<()> {
    let normalized = normalize_relative_path(path);
    let protected = [
        ".deepcode/prompts/",
        ".deepcode/skills/",
        ".deepcode/ruler/",
        ".deepcode/policy/",
    ];
    if protected
        .iter()
        .any(|prefix| normalized == prefix.trim_end_matches('/') || normalized.starts_with(prefix))
    {
        return Err(KernelError::PermissionDenied(
            "ordinary workspace mutation cannot modify .deepcode config assets".to_string(),
        ));
    }
    Ok(())
}

fn list_nodes(path: &Path, root: &Path, depth: u32) -> KernelResult<Vec<Value>> {
    let mut entries = fs::read_dir(path)
        .map_err(|error| KernelError::Other(format!("list {}: {error}", path.display())))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| KernelError::Other(format!("list {}: {error}", path.display())))?;
    entries.sort_by(compare_dir_entries);

    entries
        .into_iter()
        .take(200)
        .map(|entry| {
            let entry_path = entry.path();
            let file_type = entry.file_type().map_err(|error| {
                KernelError::Other(format!("stat {}: {error}", entry_path.display()))
            })?;
            let relative = entry_path
                .strip_prefix(root)
                .unwrap_or(&entry_path)
                .to_string_lossy()
                .replace('\\', "/");
            let children = if file_type.is_dir() && depth > 1 && !skip_directory(&entry_path) {
                Some(list_nodes(&entry_path, root, depth - 1)?)
            } else if file_type.is_dir() {
                Some(Vec::new())
            } else {
                None
            };
            Ok(serde_json::json!({
                "name": entry.file_name().to_string_lossy(),
                "path": relative,
                "type": if file_type.is_dir() { "directory" } else { "file" },
                "children": children
            }))
        })
        .collect()
}

fn compare_dir_entries(left: &fs::DirEntry, right: &fs::DirEntry) -> Ordering {
    let left_name = left.file_name().to_string_lossy().to_string();
    let right_name = right.file_name().to_string_lossy().to_string();
    let left_is_dir = left.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
    let right_is_dir = right.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
    (
        if left_is_dir { 0_u8 } else { 1_u8 },
        if left_name.starts_with('.') {
            1_u8
        } else {
            0_u8
        },
        left_name.to_lowercase(),
        left_name,
    )
        .cmp(&(
            if right_is_dir { 0_u8 } else { 1_u8 },
            if right_name.starts_with('.') {
                1_u8
            } else {
                0_u8
            },
            right_name.to_lowercase(),
            right_name,
        ))
}

fn search_workspace(root: &Path, query: &str, includes: &[String]) -> KernelResult<Vec<Value>> {
    let mut matches = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut visited_files = 0_usize;

    while let Some(path) = stack.pop() {
        if skip_directory(&path) {
            continue;
        }
        let entries = fs::read_dir(&path)
            .map_err(|error| KernelError::Other(format!("search {}: {error}", path.display())))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| KernelError::Other(format!("search entry: {error}")))?;
            let entry_path = entry.path();
            let file_type = entry.file_type().map_err(|error| {
                KernelError::Other(format!("stat {}: {error}", entry_path.display()))
            })?;
            if file_type.is_dir() {
                stack.push(entry_path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let relative = entry_path
                .strip_prefix(root)
                .unwrap_or(&entry_path)
                .to_string_lossy()
                .replace('\\', "/");
            if !includes.is_empty() && !includes.iter().any(|pattern| relative.contains(pattern)) {
                continue;
            }
            visited_files += 1;
            if visited_files > 500 {
                break;
            }
            let Ok(content) = fs::read_to_string(&entry_path) else {
                continue;
            };
            for (index, line) in content.lines().enumerate() {
                if line.contains(query) {
                    matches.push(serde_json::json!({
                        "path": relative,
                        "line": index + 1,
                        "preview": line
                    }));
                    if matches.len() >= 200 {
                        return Ok(matches);
                    }
                }
            }
        }
    }
    Ok(matches)
}

fn skip_directory(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(OsStr::to_str),
        Some(".git" | "node_modules" | "target" | "dist" | ".build-cache")
    )
}

fn kernel_event_identity(event: &KernelEvent) -> String {
    format!(
        "{}:{}",
        kernel_event_kind(event),
        kernel_event_sequence(event)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    )
}

fn kernel_event_kind(event: &KernelEvent) -> &'static str {
    match event {
        KernelEvent::HostStatus { .. } => "host.status",
        KernelEvent::SnapshotReady { .. } => "snapshot.ready",
        KernelEvent::RunStarted { .. } => "run.started",
        KernelEvent::RunCompleted { .. } => "run.completed",
        KernelEvent::StageChanged { .. } => "stage.changed",
        KernelEvent::MessageAppended { .. } => "message.appended",
        KernelEvent::ToolRequested { .. } => "tool.requested",
        KernelEvent::ToolCompleted { .. } => "tool.completed",
        KernelEvent::PermissionRequested { .. } => "permission.requested",
        KernelEvent::PermissionResolved { .. } => "permission.resolved",
        KernelEvent::ConfigSnapshotAttached { .. } => "config.snapshot.attached",
        KernelEvent::PlanProposed { .. } => "plan.proposed",
        KernelEvent::PlanAccepted { .. } => "plan.accepted",
        KernelEvent::PlanRejected { .. } => "plan.rejected",
        KernelEvent::WorkflowCheckpointed { .. } => "workflow.checkpointed",
        KernelEvent::WorkflowResumed { .. } => "workflow.resumed",
        KernelEvent::WorkflowDecisionMade { .. } => "workflow.decision_made",
        KernelEvent::WorkspaceResult { .. } => "workspace.result",
        KernelEvent::SkillResult { .. } => "skill.result",
        KernelEvent::ContextResult { .. } => "context.result",
        KernelEvent::TempArtifactCreated { .. } => "tempArtifact.created",
        KernelEvent::TempArtifactCleaned { .. } => "tempArtifact.cleaned",
        KernelEvent::TempCleanupFailed { .. } => "tempCleanup.failed",
        KernelEvent::Error { .. } => "error",
    }
}

fn kernel_event_sequence(event: &KernelEvent) -> Option<u64> {
    match event {
        KernelEvent::RunStarted { sequence, .. }
        | KernelEvent::RunCompleted { sequence, .. }
        | KernelEvent::StageChanged { sequence, .. }
        | KernelEvent::MessageAppended { sequence, .. }
        | KernelEvent::ToolRequested { sequence, .. }
        | KernelEvent::ToolCompleted { sequence, .. }
        | KernelEvent::PermissionRequested { sequence, .. }
        | KernelEvent::PermissionResolved { sequence, .. }
        | KernelEvent::ConfigSnapshotAttached { sequence, .. }
        | KernelEvent::PlanProposed { sequence, .. }
        | KernelEvent::PlanAccepted { sequence, .. }
        | KernelEvent::PlanRejected { sequence, .. }
        | KernelEvent::WorkflowCheckpointed { sequence, .. }
        | KernelEvent::WorkflowResumed { sequence, .. }
        | KernelEvent::WorkflowDecisionMade { sequence, .. }
        | KernelEvent::WorkspaceResult { sequence, .. }
        | KernelEvent::SkillResult { sequence, .. }
        | KernelEvent::ContextResult { sequence, .. }
        | KernelEvent::TempArtifactCreated { sequence, .. }
        | KernelEvent::TempArtifactCleaned { sequence, .. }
        | KernelEvent::TempCleanupFailed { sequence, .. } => *sequence,
        KernelEvent::HostStatus { .. }
        | KernelEvent::SnapshotReady { .. }
        | KernelEvent::Error { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deepcode_kernel_abi::{MessageRole, UserInput, WorkspaceBinding};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn binding() -> WorkspaceBinding {
        WorkspaceBinding {
            workspace_id: Some("ws-1".to_string()),
            workspace_hash: Some("hash-1".to_string()),
            open_path: Some("/workspace".to_string()),
            active_folder_id: Some("wf-0".to_string()),
            folder_hash: Some("folder-hash".to_string()),
        }
    }

    fn temp_workspace() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "deepcode-kernel-runtime-test-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn workspace_output(events: Vec<KernelEvent>) -> Value {
        match events.into_iter().next().unwrap() {
            KernelEvent::WorkspaceResult {
                ok: true,
                output: Some(output),
                ..
            } => output,
            other => panic!("expected ok workspace result, got {other:?}"),
        }
    }

    fn workspace_error(events: Vec<KernelEvent>) -> String {
        match events.into_iter().next().unwrap() {
            KernelEvent::WorkspaceResult {
                ok: false,
                error: Some(error),
                ..
            } => error.code,
            other => panic!("expected workspace error, got {other:?}"),
        }
    }

    fn start_temp_lifecycle_run(runtime: &mut DeepCodeKernelRuntime) {
        runtime
            .dispatch(KernelCommand::RunStart {
                request_id: RequestId("req-run".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                input: UserInput {
                    text: "返回你的身份信息，测试所有功能组件，新建临时文件读写后删除临时文件"
                        .to_string(),
                    attachments: vec![],
                },
                workspace_binding: Some(binding()),
                profile_ref: None,
                workflow_ref: None,
                run_overrides: None,
            })
            .unwrap();
    }

    fn observe(
        runtime: &mut DeepCodeKernelRuntime,
        request_id: &str,
        event: KernelEvent,
    ) -> WorkflowDecision {
        let events = runtime
            .dispatch(KernelCommand::WorkflowObserve {
                request_id: RequestId(request_id.to_string()),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                event: Box::new(event),
            })
            .unwrap();
        match events.into_iter().next().unwrap() {
            KernelEvent::WorkflowDecisionMade { decision, .. } => decision,
            other => panic!("expected workflow decision, got {other:?}"),
        }
    }

    #[test]
    fn health_check_returns_runtime_ready() {
        let mut runtime = DeepCodeKernelRuntime::new();
        let events = runtime
            .dispatch(KernelCommand::HealthCheck {
                request_id: RequestId("req-1".to_string()),
            })
            .unwrap();

        assert!(matches!(
            events.first(),
            Some(KernelEvent::HostStatus {
                status: HostStatus::Ready,
                ..
            })
        ));
    }

    #[test]
    fn run_start_without_workspace_binding_fails_closed() {
        let mut runtime = DeepCodeKernelRuntime::new();
        let error = runtime
            .dispatch(KernelCommand::RunStart {
                request_id: RequestId("req-run".to_string()),
                session_id: None,
                input: UserInput {
                    text: "hello".to_string(),
                    attachments: vec![],
                },
                workspace_binding: None,
                profile_ref: None,
                workflow_ref: None,
                run_overrides: None,
            })
            .unwrap_err();

        assert!(matches!(error, KernelError::MissingWorkspaceBinding));
    }

    #[test]
    fn run_start_creates_headless_skeleton_events_and_ledger() {
        let mut runtime = DeepCodeKernelRuntime::new();
        let events = runtime
            .dispatch(KernelCommand::RunStart {
                request_id: RequestId("req-run".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                input: UserInput {
                    text: "plan a change".to_string(),
                    attachments: vec![],
                },
                workspace_binding: Some(binding()),
                profile_ref: None,
                workflow_ref: None,
                run_overrides: None,
            })
            .unwrap();

        assert_eq!(events.len(), 4);
        assert!(matches!(events[0], KernelEvent::RunStarted { .. }));
        assert!(matches!(
            events[1],
            KernelEvent::ConfigSnapshotAttached { .. }
        ));
        assert!(matches!(
            events[2],
            KernelEvent::WorkflowCheckpointed { .. }
        ));
        assert!(matches!(
            events[3],
            KernelEvent::StageChanged {
                status: StageStatus::Running,
                ..
            }
        ));

        let snapshot = runtime.snapshot(Some("session-1"));
        assert_eq!(snapshot.workflow_phase.as_deref(), Some("plan"));
        assert_eq!(snapshot.events.len(), 4);

        let ledger = runtime.ledger("run-1").unwrap();
        assert_eq!(ledger.len(), 4);
        assert_eq!(ledger[0].kind, "run.started");
    }

    #[test]
    fn run_resume_emits_resume_event_and_snapshot() {
        let mut runtime = DeepCodeKernelRuntime::new();
        runtime
            .dispatch(KernelCommand::RunStart {
                request_id: RequestId("req-run".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                input: UserInput {
                    text: "plan a change".to_string(),
                    attachments: vec![],
                },
                workspace_binding: Some(binding()),
                profile_ref: None,
                workflow_ref: None,
                run_overrides: None,
            })
            .unwrap();

        let events = runtime
            .dispatch(KernelCommand::RunResume {
                request_id: RequestId("req-resume".to_string()),
                session_id: SessionId("session-1".to_string()),
            })
            .unwrap();

        assert!(matches!(events[0], KernelEvent::WorkflowResumed { .. }));
        assert!(matches!(events[1], KernelEvent::SnapshotReady { .. }));
        assert_eq!(runtime.ledger("run-1").unwrap().len(), 5);
    }

    #[test]
    fn workspace_syscalls_manage_files_under_current_workspace() {
        let root = temp_workspace();
        fs::write(root.join("README.md"), "DeepCode workspace smoke").unwrap();

        let mut runtime = DeepCodeKernelRuntime::new();
        let opened = workspace_output(
            runtime
                .dispatch(KernelCommand::WorkspaceOpen {
                    request_id: RequestId("req-open".to_string()),
                    path: root.to_string_lossy().to_string(),
                })
                .unwrap(),
        );
        assert_eq!(opened["workspace"]["folders"][0]["id"], "wf-0");

        let listed = workspace_output(
            runtime
                .dispatch(KernelCommand::WorkspaceList {
                    request_id: RequestId("req-list".to_string()),
                    folder_id: Some("wf-0".to_string()),
                    path: Some(".".to_string()),
                    depth: Some(1),
                })
                .unwrap(),
        );
        assert!(listed["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["path"] == "README.md"));

        workspace_output(
            runtime
                .dispatch(KernelCommand::WorkspaceCreate {
                    request_id: RequestId("req-create".to_string()),
                    folder_id: None,
                    path: "_agent_tmp_kernel.txt".to_string(),
                    content: Some("kernel created".to_string()),
                })
                .unwrap(),
        );
        let read = workspace_output(
            runtime
                .dispatch(KernelCommand::WorkspaceRead {
                    request_id: RequestId("req-read".to_string()),
                    folder_id: None,
                    path: "_agent_tmp_kernel.txt".to_string(),
                })
                .unwrap(),
        );
        assert_eq!(read["content"], "kernel created");

        workspace_output(
            runtime
                .dispatch(KernelCommand::WorkspaceWrite {
                    request_id: RequestId("req-write".to_string()),
                    folder_id: None,
                    path: "_agent_tmp_kernel.txt".to_string(),
                    content: "needle updated".to_string(),
                    create: false,
                })
                .unwrap(),
        );
        let searched = workspace_output(
            runtime
                .dispatch(KernelCommand::WorkspaceSearch {
                    request_id: RequestId("req-search".to_string()),
                    folder_id: None,
                    query: "needle".to_string(),
                    include: None,
                    is_regex: false,
                })
                .unwrap(),
        );
        assert_eq!(searched["matches"].as_array().unwrap().len(), 1);

        workspace_output(
            runtime
                .dispatch(KernelCommand::WorkspaceRename {
                    request_id: RequestId("req-rename".to_string()),
                    folder_id: None,
                    old_path: "_agent_tmp_kernel.txt".to_string(),
                    new_path: "_agent_tmp_kernel_renamed.txt".to_string(),
                })
                .unwrap(),
        );
        workspace_output(
            runtime
                .dispatch(KernelCommand::WorkspaceDelete {
                    request_id: RequestId("req-delete".to_string()),
                    folder_id: None,
                    path: "_agent_tmp_kernel_renamed.txt".to_string(),
                })
                .unwrap(),
        );
        assert!(!root.join("_agent_tmp_kernel_renamed.txt").exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_syscalls_fail_closed_without_workspace_or_for_unsafe_paths() {
        let mut runtime = DeepCodeKernelRuntime::new();
        let error = workspace_error(
            runtime
                .dispatch(KernelCommand::WorkspaceRead {
                    request_id: RequestId("req-read".to_string()),
                    folder_id: None,
                    path: "README.md".to_string(),
                })
                .unwrap(),
        );
        assert_eq!(error, "workspace_binding_required");

        let root = temp_workspace();
        runtime
            .dispatch(KernelCommand::WorkspaceOpen {
                request_id: RequestId("req-open".to_string()),
                path: root.to_string_lossy().to_string(),
            })
            .unwrap();

        for path in ["/tmp/escape.txt", "../escape.txt"] {
            let error = workspace_error(
                runtime
                    .dispatch(KernelCommand::WorkspaceWrite {
                        request_id: RequestId("req-write".to_string()),
                        folder_id: None,
                        path: path.to_string(),
                        content: "blocked".to_string(),
                        create: true,
                    })
                    .unwrap(),
            );
            assert_eq!(error, "permission_denied");
        }

        let error = workspace_error(
            runtime
                .dispatch(KernelCommand::WorkspaceWrite {
                    request_id: RequestId("req-write-config".to_string()),
                    folder_id: None,
                    path: ".deepcode/prompts/project.md".to_string(),
                    content: "blocked".to_string(),
                    create: true,
                })
                .unwrap(),
        );
        assert_eq!(error, "permission_denied");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plan_and_temporary_grant_commands_are_recorded() {
        let mut runtime = DeepCodeKernelRuntime::new();
        runtime
            .dispatch(KernelCommand::RunStart {
                request_id: RequestId("req-run".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                input: UserInput {
                    text: "plan a change".to_string(),
                    attachments: vec![],
                },
                workspace_binding: Some(binding()),
                profile_ref: None,
                workflow_ref: None,
                run_overrides: None,
            })
            .unwrap();

        let accepted = runtime
            .dispatch(KernelCommand::PlanAccept {
                request_id: RequestId("req-plan".to_string()),
                run_id: RunId("run-1".to_string()),
                plan_id: "plan-1".to_string(),
            })
            .unwrap();
        assert!(matches!(accepted[0], KernelEvent::PlanAccepted { .. }));

        let grant = runtime
            .dispatch(KernelCommand::PermissionGrantTemporary {
                request_id: RequestId("req-grant".to_string()),
                run_id: RunId("run-1".to_string()),
                grant: deepcode_kernel_abi::TemporaryGrantEnvelope {
                    id: "grant-1".to_string(),
                    capability: "workspace.write".to_string(),
                    resource_kind: "workspaceFile".to_string(),
                    resource_path: Some("src/main.rs".to_string()),
                    expires_after_sequence: Some(10),
                    reason: Some("test grant".to_string()),
                },
            })
            .unwrap();
        assert!(matches!(grant[0], KernelEvent::MessageAppended { .. }));
        assert_eq!(runtime.ledger("run-1").unwrap().len(), 6);
    }

    #[test]
    fn run_cancel_remains_fail_closed() {
        let mut runtime = DeepCodeKernelRuntime::new();
        let error = runtime
            .dispatch(KernelCommand::RunCancel {
                request_id: RequestId("req-cancel".to_string()),
                run_id: RunId("run-1".to_string()),
            })
            .unwrap_err();

        assert!(matches!(error, KernelError::NotImplemented("run.cancel")));
    }

    #[test]
    fn workflow_observe_only_listed_temp_lifecycle_continues() {
        let mut runtime = DeepCodeKernelRuntime::new();
        start_temp_lifecycle_run(&mut runtime);

        let decision = observe(
            &mut runtime,
            "req-observe-1",
            KernelEvent::ToolCompleted {
                run_id: Some(RunId("run-1".to_string())),
                session_id: Some(SessionId("session-1".to_string())),
                turn_id: None,
                tool_call_id: "tool-list".to_string(),
                tool_name: "fs.list".to_string(),
                ok: true,
                output: Some(serde_json::json!({ "path": "." })),
                error: None,
                sequence: Some(5),
            },
        );

        assert_eq!(decision.action, WorkflowDecisionAction::Continue);
        assert_eq!(
            decision.reason,
            WorkflowDecisionReason::PendingCriticalSteps
        );
        assert!(decision
            .pending_steps
            .iter()
            .any(|step| step.contains("create")));
        assert!(!decision.fail_closed);
    }

    #[test]
    fn workflow_observe_temp_lifecycle_requires_cleanup_before_review() {
        let mut runtime = DeepCodeKernelRuntime::new();
        start_temp_lifecycle_run(&mut runtime);

        for (request_id, tool_call_id, tool_name) in [
            ("req-observe-1", "tool-list", "fs.list"),
            ("req-observe-2", "tool-write", "fs.write"),
            ("req-observe-3", "tool-read", "fs.read"),
        ] {
            observe(
                &mut runtime,
                request_id,
                KernelEvent::ToolCompleted {
                    run_id: Some(RunId("run-1".to_string())),
                    session_id: Some(SessionId("session-1".to_string())),
                    turn_id: None,
                    tool_call_id: tool_call_id.to_string(),
                    tool_name: tool_name.to_string(),
                    ok: true,
                    output: Some(serde_json::json!({ "path": "_agent_tmp_test.txt" })),
                    error: None,
                    sequence: Some(5),
                },
            );
        }

        let decision = observe(
            &mut runtime,
            "req-observe-4",
            KernelEvent::StageChanged {
                run_id: Some(RunId("run-1".to_string())),
                session_id: Some(SessionId("session-1".to_string())),
                turn_id: None,
                stage_run_id: None,
                phase: "complete".to_string(),
                status: StageStatus::Completed,
                reason: None,
                sequence: Some(8),
            },
        );

        assert_eq!(decision.action, WorkflowDecisionAction::Continue);
        assert!(decision
            .pending_steps
            .iter()
            .any(|step| step.contains("cleanup")));
    }

    #[test]
    fn workflow_observe_temp_lifecycle_cleanup_enters_review_then_done() {
        let mut runtime = DeepCodeKernelRuntime::new();
        start_temp_lifecycle_run(&mut runtime);

        for (request_id, tool_call_id, tool_name) in [
            ("req-observe-1", "tool-list", "fs.list"),
            ("req-observe-2", "tool-write", "fs.write"),
            ("req-observe-3", "tool-read", "fs.read"),
        ] {
            observe(
                &mut runtime,
                request_id,
                KernelEvent::ToolCompleted {
                    run_id: Some(RunId("run-1".to_string())),
                    session_id: Some(SessionId("session-1".to_string())),
                    turn_id: None,
                    tool_call_id: tool_call_id.to_string(),
                    tool_name: tool_name.to_string(),
                    ok: true,
                    output: Some(serde_json::json!({ "path": "_agent_tmp_test.txt" })),
                    error: None,
                    sequence: Some(5),
                },
            );
        }
        observe(
            &mut runtime,
            "req-observe-4",
            KernelEvent::ToolRequested {
                run_id: Some(RunId("run-1".to_string())),
                session_id: Some(SessionId("session-1".to_string())),
                turn_id: None,
                tool_call_id: "tool-shell".to_string(),
                tool_name: "shell.exec".to_string(),
                args_preview: serde_json::json!({ "command": "rm _agent_tmp_test.txt" }),
                sequence: Some(8),
            },
        );
        let review = observe(
            &mut runtime,
            "req-observe-5",
            KernelEvent::ToolCompleted {
                run_id: Some(RunId("run-1".to_string())),
                session_id: Some(SessionId("session-1".to_string())),
                turn_id: None,
                tool_call_id: "tool-shell".to_string(),
                tool_name: "shell.exec".to_string(),
                ok: true,
                output: Some(serde_json::json!({ "exitCode": 0 })),
                error: None,
                sequence: Some(9),
            },
        );

        assert_eq!(review.action, WorkflowDecisionAction::Review);
        assert_eq!(
            review.reason,
            WorkflowDecisionReason::CompletionCriteriaSatisfied
        );

        let done = observe(
            &mut runtime,
            "req-observe-6",
            KernelEvent::MessageAppended {
                run_id: Some(RunId("run-1".to_string())),
                session_id: Some(SessionId("session-1".to_string())),
                turn_id: None,
                role: MessageRole::Agent,
                channel: Some("final".to_string()),
                content: Some(
                    "我是 DeepCode Agent。fs.read fs.list fs.write shell.exec 均已测试，临时文件已创建、读取并清理删除。"
                        .to_string(),
                ),
                message_key: None,
                args: None,
                sequence: Some(10),
            },
        );

        assert_eq!(done.action, WorkflowDecisionAction::Done);
        assert!(done.pending_steps.is_empty());
    }
}
