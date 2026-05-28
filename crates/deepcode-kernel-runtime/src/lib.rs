use deepcode_kernel_abi::{
    AnswerObligation, AnswerObligationId, AnswerObligationStatus, ConfigSnapshotRef, HostStatus,
    KernelCommand, KernelError, KernelErrorEnvelope, KernelEvent, KernelEventSummary, KernelResult,
    KernelSnapshot, ProfileRef, RequestId, RunId, SessionId, StageStatus, WorkflowDecision,
    WorkflowDecisionAction, WorkflowDecisionReason, WorkspaceBinding,
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
    pending_tools: BTreeMap<String, PendingKernelTool>,
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
    input_text: String,
    workspace_binding: WorkspaceBinding,
    config_ref: ConfigSnapshotRef,
    profile_ref: Option<ProfileRef>,
    phase: WorkflowPhase,
    active_llm_call_id: Option<String>,
    llm_call_index: u64,
    decision_state: WorkflowDecisionState,
}

#[derive(Debug, Clone)]
struct PendingKernelTool {
    run_id: String,
    session_id: String,
    tool_call_id: String,
    tool_name: String,
    arguments: Value,
}

#[derive(Debug, Clone)]
struct KernelLlmToolCall {
    id: String,
    name: String,
    arguments: Value,
}

#[derive(Debug, Clone, Default)]
struct WorkflowDecisionState {
    answer_obligations: Vec<AnswerObligation>,
    temp_lifecycle_required: bool,
    workspace_summary_required: bool,
    tool_component_required: bool,
    workspace_listed: bool,
    workspace_file_read: bool,
    workspace_search_completed: bool,
    workspace_summary_file_path: Option<String>,
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
        let tool_component_required = has_tool_component_request(input, &lower);
        let mut state = Self {
            temp_lifecycle_required: has_temp_file_lifecycle_request(input, &lower),
            workspace_summary_required: has_workspace_summary_request(input, &lower),
            tool_component_required,
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
        if tool_component_required {
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
                    "fs.list" => {
                        self.workspace_listed = true;
                        if self.workspace_summary_file_path.is_none() {
                            self.workspace_summary_file_path =
                                output.as_ref().and_then(find_workspace_summary_file_path);
                        }
                    }
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
                        let mentions_temp = output
                            .as_ref()
                            .map(output_mentions_temp_file)
                            .unwrap_or(false);
                        if mentions_temp {
                            self.temp_read_back = true;
                        } else if self.workspace_summary_required {
                            self.workspace_file_read = true;
                        }
                    }
                    "code.search" => self.workspace_search_completed = true,
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
        let mut steps = Vec::new();
        if (self.workspace_summary_required
            || self.tool_component_required
            || self.temp_lifecycle_required)
            && !self.workspace_listed
        {
            steps.push("list workspace root".to_string());
        }
        if self.workspace_summary_required && !self.workspace_file_read {
            steps.push("read at least one workspace file before summarizing".to_string());
        }
        if self.tool_component_required && !self.workspace_search_completed {
            steps.push("run workspace search to verify code.search component".to_string());
        }
        if !self.temp_lifecycle_required {
            return steps;
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
                profile_ref,
                workflow_ref.map(|value| value.id),
                run_overrides,
            ),
            KernelCommand::LlmResponseSubmit {
                request_id,
                run_id,
                session_id,
                llm_call_id,
                response_envelope,
            } => self.llm_response_submit(
                request_id,
                run_id,
                session_id,
                llm_call_id,
                response_envelope,
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
            KernelCommand::ToolInvoke {
                request_id,
                run_id,
                session_id,
                tool_call_id,
                tool_name,
                arguments,
                workspace_binding,
            } => self.tool_invoke(
                request_id,
                run_id,
                session_id,
                tool_call_id,
                tool_name,
                arguments,
                workspace_binding,
            ),
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
            KernelCommand::PermissionResolve {
                request_id,
                permission_id,
                decision,
            } => self.permission_resolve(request_id, permission_id, decision),
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
                decision_state: WorkflowDecisionState::from_user_input(&input_text),
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

    fn llm_call_requested_event(
        &mut self,
        run_id: &str,
        session_id: &str,
    ) -> KernelResult<KernelEvent> {
        let (phase, input_text, profile_ref, decision_state, llm_call_id) = {
            let record = self.record_by_run_mut(run_id)?;
            record.llm_call_index += 1;
            let phase = record.phase.as_str().to_string();
            let llm_call_id = format!("llm-{run_id}-{phase}-{}", record.llm_call_index);
            record.active_llm_call_id = Some(llm_call_id.clone());
            (
                phase,
                record.input_text.clone(),
                record.profile_ref.clone(),
                record.decision_state.clone(),
                llm_call_id,
            )
        };
        let request_envelope = compile_llm_request_envelope(&phase, &input_text, &decision_state);
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "llm.call_requested",
            sequence,
            serde_json::json!({
                "summary": format!("Kernel requested LLM call for {phase}."),
                "phase": &phase,
                "llmCallId": &llm_call_id,
                "profileRef": &profile_ref,
                "requestEnvelope": &request_envelope
            }),
        )?;
        Ok(KernelEvent::LlmCallRequested {
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            phase,
            llm_call_id,
            profile_ref,
            request_envelope,
            sequence: Some(sequence),
        })
    }

    fn llm_response_submit(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        llm_call_id: String,
        response_envelope: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = self.record_by_run(&run_id.0)?;
        let session_id = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| record.session_id.clone());
        if record.session_id != session_id {
            return Err(KernelError::InvalidCommand(format!(
                "run {} is not bound to session {}",
                run_id.0, session_id
            )));
        }
        if record.active_llm_call_id.as_deref() != Some(llm_call_id.as_str()) {
            return Err(KernelError::InvalidCommand(format!(
                "llm call {llm_call_id} is not active for run {}",
                run_id.0
            )));
        }

        let phase = record.phase.as_str().to_string();
        let mut events = Vec::new();
        for event in self.message_events_from_llm_response(
            &request_id,
            &run_id.0,
            &session_id,
            &phase,
            &response_envelope,
        )? {
            events.push(event);
        }

        if phase == "complete" {
            let tool_calls = extract_llm_tool_calls(&response_envelope);
            for call in tool_calls {
                let mut tool_events = self.invoke_llm_tool_call(&run_id.0, &session_id, call)?;
                let waiting_for_permission = tool_events
                    .iter()
                    .any(|event| matches!(event, KernelEvent::PermissionRequested { .. }));
                events.append(&mut tool_events);
                if waiting_for_permission {
                    events.push(self.workflow_decision_event(
                        request_id,
                        &run_id.0,
                        &session_id,
                        "permission.requested",
                    )?);
                    return Ok(events);
                }
            }
            let mut auto_events = self.auto_continue_after_tool(&run_id.0, &session_id)?;
            let waiting_for_permission = auto_events
                .iter()
                .any(|event| matches!(event, KernelEvent::PermissionRequested { .. }));
            events.append(&mut auto_events);
            if waiting_for_permission {
                events.push(self.workflow_decision_event(
                    request_id,
                    &run_id.0,
                    &session_id,
                    "permission.requested",
                )?);
                return Ok(events);
            }
        }

        let decision_event = self.workflow_decision_event(
            request_id.clone(),
            &run_id.0,
            &session_id,
            "llm.response",
        )?;
        let decision = match &decision_event {
            KernelEvent::WorkflowDecisionMade { decision, .. } => decision.clone(),
            _ => unreachable!("workflow_decision_event must emit workflow.decision_made"),
        };
        events.push(decision_event);

        let next = next_phase_after_llm_response(&phase, &decision);
        match next {
            LlmPhaseAdvance::Continue(next_phase) => {
                events.push(self.enter_phase_event(&run_id.0, &session_id, next_phase)?);
                events.push(self.llm_call_requested_event(&run_id.0, &session_id)?);
            }
            LlmPhaseAdvance::Finish => {
                events.push(self.complete_run_event(&run_id.0, &session_id)?);
            }
            LlmPhaseAdvance::Stop => {}
        }

        Ok(events)
    }

    fn message_events_from_llm_response(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        phase: &str,
        response_envelope: &Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let mut events = Vec::new();
        if let Some(reasoning) = response_envelope
            .pointer("/assistantMessage/reasoningContent")
            .or_else(|| response_envelope.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            let event = self.message_appended_event(
                request_id,
                run_id,
                session_id,
                "reasoning",
                Some(reasoning.to_string()),
            )?;
            events.push(event);
        }
        if let Some(content) = response_envelope
            .pointer("/assistantMessage/content")
            .or_else(|| response_envelope.get("content"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            let channel = if phase == "review" { "final" } else { phase };
            let event = self.message_appended_event(
                request_id,
                run_id,
                session_id,
                channel,
                Some(content.to_string()),
            )?;
            events.push(event);
        }
        Ok(events)
    }

    fn message_appended_event(
        &mut self,
        _request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        channel: &str,
        content: Option<String>,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        let event = KernelEvent::MessageAppended {
            run_id: Some(RunId(run_id.to_string())),
            session_id: Some(SessionId(session_id.to_string())),
            turn_id: None,
            role: deepcode_kernel_abi::MessageRole::Agent,
            channel: Some(channel.to_string()),
            content: content.clone(),
            message_key: None,
            args: None,
            sequence: Some(sequence),
        };
        {
            let record = self.record_by_run_mut(run_id)?;
            record.decision_state.apply_event(&event);
        }
        self.append_ledger(
            run_id,
            session_id,
            "message.appended",
            sequence,
            serde_json::json!({
                "summary": format!("Agent message appended on {channel}."),
                "channel": channel,
                "content": content
            }),
        )?;
        Ok(event)
    }

    fn invoke_llm_tool_call(
        &mut self,
        run_id: &str,
        session_id: &str,
        call: KernelLlmToolCall,
    ) -> KernelResult<Vec<KernelEvent>> {
        if permission_action_for_kernel_tool(&call.name) == PermissionAction::Deny {
            return Err(KernelError::PermissionDenied(format!(
                "tool {} is not allowed",
                call.name
            )));
        }
        let request_sequence = self.ledger.next_sequence(run_id)?;
        let requested = KernelEvent::ToolRequested {
            run_id: Some(RunId(run_id.to_string())),
            session_id: Some(SessionId(session_id.to_string())),
            turn_id: None,
            tool_call_id: call.id.clone(),
            tool_name: call.name.clone(),
            args_preview: redact_tool_arguments(&call.name, &call.arguments),
            sequence: Some(request_sequence),
        };
        self.append_ledger(
            run_id,
            session_id,
            "tool.requested",
            request_sequence,
            serde_json::json!({
                "summary": format!("LLM requested tool: {}", call.name),
                "toolCallId": &call.id,
                "toolName": &call.name,
                "argsPreview": redact_tool_arguments(&call.name, &call.arguments)
            }),
        )?;

        if permission_action_for_kernel_tool(&call.name) == PermissionAction::Ask {
            let permission_id = call.id.clone();
            self.state.pending_tools.insert(
                permission_id.clone(),
                PendingKernelTool {
                    run_id: run_id.to_string(),
                    session_id: session_id.to_string(),
                    tool_call_id: call.id,
                    tool_name: call.name.clone(),
                    arguments: call.arguments,
                },
            );
            let permission_sequence = self.ledger.next_sequence(run_id)?;
            let permission = KernelEvent::PermissionRequested {
                run_id: Some(RunId(run_id.to_string())),
                session_id: SessionId(session_id.to_string()),
                request: deepcode_kernel_abi::PermissionRequestEnvelope {
                    id: permission_id.clone(),
                    capability: capability_for_tool(&call.name).to_string(),
                    risk_level: risk_for_tool(&call.name).to_string(),
                    summary: format!("Allow {} to access workspace resources?", call.name),
                    args_preview: redact_tool_arguments(&call.name, &serde_json::json!({})),
                },
                sequence: Some(permission_sequence),
            };
            {
                let record = self.record_by_run_mut(run_id)?;
                record.decision_state.apply_event(&permission);
            }
            self.append_ledger(
                run_id,
                session_id,
                "permission.requested",
                permission_sequence,
                serde_json::json!({
                    "summary": format!("Permission requested for {}.", call.name),
                    "permissionId": permission_id,
                    "toolName": call.name
                }),
            )?;
            return Ok(vec![requested, permission]);
        }

        let completed =
            self.execute_bound_tool(run_id, session_id, call.id, call.name, call.arguments)?;
        let mut events = vec![requested, completed];
        events.extend(self.auto_continue_after_tool(run_id, session_id)?);
        Ok(events)
    }

    fn enter_phase_event(
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

    fn complete_run_event(&mut self, run_id: &str, session_id: &str) -> KernelResult<KernelEvent> {
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

    fn permission_resolve(
        &mut self,
        request_id: RequestId,
        permission_id: String,
        decision: deepcode_kernel_abi::PermissionDecisionKind,
    ) -> KernelResult<Vec<KernelEvent>> {
        let pending = self
            .state
            .pending_tools
            .remove(&permission_id)
            .ok_or_else(|| {
                KernelError::InvalidCommand(format!("unknown permission {permission_id}"))
            })?;
        let session_id = pending.session_id.clone();
        let run_id = pending.run_id.clone();
        let phase = self
            .state
            .records_by_session
            .get(&session_id)
            .map(|record| record.phase.as_str().to_string())
            .ok_or_else(|| KernelError::InvalidCommand("missing run record".to_string()))?;
        let resolved_sequence = self.ledger.next_sequence(&run_id)?;
        let resolved_event = KernelEvent::PermissionResolved {
            run_id: Some(RunId(run_id.clone())),
            session_id: Some(SessionId(session_id.clone())),
            permission_id: permission_id.clone(),
            decision: decision.clone(),
            reason: None,
            sequence: Some(resolved_sequence),
        };

        {
            let record = self
                .state
                .records_by_session
                .get_mut(&session_id)
                .ok_or_else(|| KernelError::InvalidCommand("missing run record".to_string()))?;
            record.decision_state.apply_event(&resolved_event);
        }

        self.append_ledger(
            &run_id,
            &session_id,
            "permission.resolved",
            resolved_sequence,
            serde_json::json!({
                "summary": "Permission resolved by Kernel command.",
                "permissionId": &permission_id,
                "decision": &decision
            }),
        )?;

        let mut events = vec![resolved_event];
        if matches!(
            decision,
            deepcode_kernel_abi::PermissionDecisionKind::Accept
        ) {
            let completed = self.execute_bound_tool(
                &run_id,
                &session_id,
                pending.tool_call_id,
                pending.tool_name,
                pending.arguments,
            )?;
            events.push(completed);
            events.extend(self.auto_continue_after_tool(&run_id, &session_id)?);
        }

        let workflow_decision = {
            let record = self
                .state
                .records_by_session
                .get(&session_id)
                .ok_or_else(|| KernelError::InvalidCommand("missing run record".to_string()))?;
            record.decision_state.decide(&phase)
        };
        let workflow_sequence = self.ledger.next_sequence(&run_id)?;
        self.append_ledger(
            &run_id,
            &session_id,
            "workflow.decision_made",
            workflow_sequence,
            serde_json::json!({
                "summary": workflow_decision.summary,
                "observedKind": "permission.resolved",
                "observedSequence": resolved_sequence,
                "decision": workflow_decision
            }),
        )?;

        events.push(KernelEvent::WorkflowDecisionMade {
            request_id: Some(request_id),
            run_id: RunId(run_id),
            session_id: Some(SessionId(session_id)),
            decision: workflow_decision.clone(),
            sequence: Some(workflow_sequence),
        });
        let run_id = match events.last() {
            Some(KernelEvent::WorkflowDecisionMade { run_id, .. }) => run_id.0.clone(),
            _ => unreachable!("last event is workflow decision"),
        };
        let session_id = match events.last() {
            Some(KernelEvent::WorkflowDecisionMade {
                session_id: Some(session_id),
                ..
            }) => session_id.0.clone(),
            _ => unreachable!("workflow decision has session id"),
        };
        if let LlmPhaseAdvance::Continue(next_phase) =
            next_phase_after_llm_response(&phase, &workflow_decision)
        {
            events.push(self.enter_phase_event(&run_id, &session_id, next_phase)?);
            events.push(self.llm_call_requested_event(&run_id, &session_id)?);
        }
        Ok(events)
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

    fn tool_invoke(
        &mut self,
        request_id: RequestId,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        tool_call_id: String,
        tool_name: String,
        arguments: Value,
        workspace_binding: Option<WorkspaceBinding>,
    ) -> KernelResult<Vec<KernelEvent>> {
        if needs_workspace_tool(&tool_name) {
            if let Some(binding) = workspace_binding {
                if let Some(open_path) = binding.open_path {
                    if self.state.current_workspace.is_none() {
                        self.workspace_open(
                            RequestId("tool-workspace-open".to_string()),
                            open_path,
                        )?;
                    }
                }
            }
            self.current_workspace()?;
        }
        if permission_action_for_kernel_tool(&tool_name) == PermissionAction::Deny {
            return Err(KernelError::PermissionDenied(format!(
                "tool {tool_name} is not allowed"
            )));
        }

        let (run_id, session_id) = self.resolve_run_session(run_id, session_id)?;
        let request_sequence = self.ledger.next_sequence(&run_id)?;
        let requested = KernelEvent::ToolRequested {
            run_id: Some(RunId(run_id.clone())),
            session_id: Some(SessionId(session_id.clone())),
            turn_id: None,
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            args_preview: redact_tool_arguments(&tool_name, &arguments),
            sequence: Some(request_sequence),
        };
        self.append_ledger(
            &run_id,
            &session_id,
            "tool.requested",
            request_sequence,
            serde_json::json!({
                "summary": format!("Tool requested: {tool_name}"),
                "toolCallId": &tool_call_id,
                "toolName": &tool_name,
                "argsPreview": redact_tool_arguments(&tool_name, &arguments)
            }),
        )?;

        if permission_action_for_kernel_tool(&tool_name) == PermissionAction::Ask {
            let permission_id = tool_call_id.clone();
            self.state.pending_tools.insert(
                permission_id.clone(),
                PendingKernelTool {
                    run_id: run_id.clone(),
                    session_id: session_id.clone(),
                    tool_call_id,
                    tool_name: tool_name.clone(),
                    arguments,
                },
            );
            let permission_sequence = self.ledger.next_sequence(&run_id)?;
            let permission = KernelEvent::PermissionRequested {
                run_id: Some(RunId(run_id.clone())),
                session_id: SessionId(session_id.clone()),
                request: deepcode_kernel_abi::PermissionRequestEnvelope {
                    id: permission_id.clone(),
                    capability: capability_for_tool(&tool_name).to_string(),
                    risk_level: risk_for_tool(&tool_name).to_string(),
                    summary: format!("Allow {tool_name} to access workspace resources?"),
                    args_preview: redact_tool_arguments(&tool_name, &serde_json::json!({})),
                },
                sequence: Some(permission_sequence),
            };
            {
                let record = self.record_by_run_mut(&run_id)?;
                record.decision_state.apply_event(&permission);
            }
            self.append_ledger(
                &run_id,
                &session_id,
                "permission.requested",
                permission_sequence,
                serde_json::json!({
                    "summary": format!("Permission requested for {tool_name}."),
                    "permissionId": permission_id,
                    "toolName": tool_name
                }),
            )?;
            return Ok(vec![requested, permission]);
        }

        let completed =
            self.execute_bound_tool(&run_id, &session_id, tool_call_id, tool_name, arguments)?;
        let mut events = vec![requested, completed];
        events.extend(self.auto_continue_after_tool(&run_id, &session_id)?);
        events.push(self.workflow_decision_event(
            request_id,
            &run_id,
            &session_id,
            "tool.completed",
        )?);
        Ok(events)
    }

    fn execute_bound_tool(
        &mut self,
        run_id: &str,
        session_id: &str,
        tool_call_id: String,
        tool_name: String,
        arguments: Value,
    ) -> KernelResult<KernelEvent> {
        let result = self.execute_kernel_tool(&tool_name, &arguments);
        let sequence = self.ledger.next_sequence(run_id)?;
        let event = KernelEvent::ToolCompleted {
            run_id: Some(RunId(run_id.to_string())),
            session_id: Some(SessionId(session_id.to_string())),
            turn_id: None,
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            ok: result.is_ok(),
            output: result.as_ref().ok().cloned(),
            error: result.as_ref().err().map(Into::into),
            sequence: Some(sequence),
        };
        {
            let record = self.record_by_run_mut(run_id)?;
            record.decision_state.apply_event(&event);
        }
        self.append_ledger(
            run_id,
            session_id,
            "tool.completed",
            sequence,
            serde_json::json!({
                "summary": format!("Tool completed: {tool_name}"),
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "ok": result.is_ok(),
                "output": result.as_ref().ok(),
                "error": result.as_ref().err().map(KernelErrorEnvelope::from)
            }),
        )?;
        Ok(event)
    }

    fn auto_continue_after_tool(
        &mut self,
        run_id: &str,
        session_id: &str,
    ) -> KernelResult<Vec<KernelEvent>> {
        let mut events = Vec::new();
        loop {
            let next = {
                let record = self.record_by_run(run_id)?;
                next_kernel_autorun_tool(&record.decision_state)
            };
            let Some((tool_name, arguments)) = next else {
                break;
            };
            let tool_call_id = format!(
                "kernel-auto-{}-{}",
                tool_name.replace('.', "-"),
                now_millis()
            );
            let request_sequence = self.ledger.next_sequence(run_id)?;
            let requested = KernelEvent::ToolRequested {
                run_id: Some(RunId(run_id.to_string())),
                session_id: Some(SessionId(session_id.to_string())),
                turn_id: None,
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.to_string(),
                args_preview: redact_tool_arguments(tool_name, &arguments),
                sequence: Some(request_sequence),
            };
            self.append_ledger(
                run_id,
                session_id,
                "tool.requested",
                request_sequence,
                serde_json::json!({
                    "summary": format!("Kernel auto requested: {tool_name}"),
                    "toolCallId": &tool_call_id,
                    "toolName": tool_name,
                    "argsPreview": redact_tool_arguments(tool_name, &arguments)
                }),
            )?;
            events.push(requested);
            if permission_action_for_kernel_tool(tool_name) == PermissionAction::Ask
                && !is_kernel_owned_temp_cleanup(tool_name, &arguments)
            {
                let permission_id = tool_call_id.clone();
                self.state.pending_tools.insert(
                    permission_id.clone(),
                    PendingKernelTool {
                        run_id: run_id.to_string(),
                        session_id: session_id.to_string(),
                        tool_call_id,
                        tool_name: tool_name.to_string(),
                        arguments,
                    },
                );
                let permission_sequence = self.ledger.next_sequence(run_id)?;
                let permission = KernelEvent::PermissionRequested {
                    run_id: Some(RunId(run_id.to_string())),
                    session_id: SessionId(session_id.to_string()),
                    request: deepcode_kernel_abi::PermissionRequestEnvelope {
                        id: permission_id.clone(),
                        capability: capability_for_tool(tool_name).to_string(),
                        risk_level: risk_for_tool(tool_name).to_string(),
                        summary: format!("Allow {tool_name} to access workspace resources?"),
                        args_preview: redact_tool_arguments(tool_name, &serde_json::json!({})),
                    },
                    sequence: Some(permission_sequence),
                };
                {
                    let record = self.record_by_run_mut(run_id)?;
                    record.decision_state.apply_event(&permission);
                }
                self.append_ledger(
                    run_id,
                    session_id,
                    "permission.requested",
                    permission_sequence,
                    serde_json::json!({
                        "summary": format!("Permission requested for {tool_name}."),
                        "permissionId": permission_id,
                        "toolName": tool_name
                    }),
                )?;
                events.push(permission);
                break;
            }
            let completed = self.execute_bound_tool(
                run_id,
                session_id,
                tool_call_id,
                tool_name.to_string(),
                arguments,
            )?;
            events.push(completed);
        }
        Ok(events)
    }

    fn workflow_decision_event(
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

    fn execute_kernel_tool(&self, tool_name: &str, arguments: &Value) -> KernelResult<Value> {
        match tool_name {
            "fs.list" => {
                let workspace = self.current_workspace()?;
                let relative = get_string(arguments, "path").unwrap_or_else(|| ".".to_string());
                let target = self.resolve_workspace_path(&relative)?;
                Ok(serde_json::json!({
                    "folderId": "wf-0",
                    "path": normalize_relative_path(&relative),
                    "nodes": list_nodes(&target, &workspace.root, 2)?
                }))
            }
            "fs.read" => {
                let path = get_string(arguments, "path").unwrap_or_default();
                let target = self.resolve_workspace_path(&path)?;
                if !target.is_file() {
                    return Err(KernelError::InvalidCommand(format!("{path} is not a file")));
                }
                let content = fs::read_to_string(&target)
                    .map_err(|error| KernelError::Other(format!("read {path}: {error}")))?;
                Ok(serde_json::json!({
                    "folderId": "wf-0",
                    "path": normalize_relative_path(&path),
                    "content": content,
                    "sizeBytes": content.len(),
                    "binary": false
                }))
            }
            "fs.write" => {
                let path = get_string(arguments, "path").unwrap_or_default();
                deny_protected_deepcode_mutation(&path)?;
                let target = self.resolve_workspace_path(&path)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|error| KernelError::Other(format!("create parent: {error}")))?;
                }
                let content = get_string(arguments, "content").unwrap_or_default();
                fs::write(&target, content)
                    .map_err(|error| KernelError::Other(format!("write {path}: {error}")))?;
                Ok(serde_json::json!({
                    "folderId": "wf-0",
                    "path": normalize_relative_path(&path),
                    "saved": true,
                    "sizeBytes": fs::metadata(&target).map(|metadata| metadata.len()).unwrap_or(0)
                }))
            }
            "fs.delete" => {
                let path = get_string(arguments, "path").unwrap_or_default();
                deny_protected_deepcode_mutation(&path)?;
                let target = self.resolve_workspace_path(&path)?;
                if target.is_dir() {
                    return Err(KernelError::PermissionDenied(
                        "fs.delete only accepts files".to_string(),
                    ));
                }
                fs::remove_file(&target)
                    .map_err(|error| KernelError::Other(format!("delete {path}: {error}")))?;
                Ok(serde_json::json!({
                    "folderId": "wf-0",
                    "path": normalize_relative_path(&path),
                    "deleted": true,
                    "kind": "file"
                }))
            }
            "fs.diff" => {
                let path = get_string(arguments, "path").unwrap_or_default();
                let target = self.resolve_workspace_path(&path)?;
                let old_content = fs::read_to_string(&target).unwrap_or_default();
                let new_content = get_string(arguments, "newContent").unwrap_or_default();
                Ok(serde_json::json!({
                    "path": path,
                    "diff": format!("--- old\n+++ new\n-{}\n+{}", old_content, new_content)
                }))
            }
            "code.search" => {
                let workspace = self.current_workspace()?;
                let query = get_string(arguments, "query").unwrap_or_default();
                if query.trim().is_empty() {
                    return Err(KernelError::InvalidCommand(
                        "search query is required".to_string(),
                    ));
                }
                Ok(serde_json::json!({
                    "folderId": "wf-0",
                    "query": query,
                    "matches": search_workspace(&workspace.root, &query, &[])?
                }))
            }
            "shell.propose" => Ok(serde_json::json!({
                "dryRun": true,
                "executed": false,
                "command": get_string(arguments, "command")
            })),
            "shell.exec" => self.execute_kernel_shell(arguments),
            _ => Err(KernelError::InvalidCommand(format!(
                "unknown tool {tool_name}"
            ))),
        }
    }

    fn execute_kernel_shell(&self, arguments: &Value) -> KernelResult<Value> {
        let command = get_string(arguments, "command").unwrap_or_default();
        if command.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "shell.exec command is required".to_string(),
            ));
        }
        if command.contains("rm -rf") || command.contains("git reset --hard") {
            return Err(KernelError::PermissionDenied(
                "destructive shell command is blocked by Kernel policy".to_string(),
            ));
        }
        let cwd = self
            .state
            .current_workspace
            .as_ref()
            .map(|workspace| workspace.root.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string());
        let started = now_millis();
        let output = if cfg!(windows) {
            std::process::Command::new("wsl.exe")
                .arg("sh")
                .arg("-lc")
                .arg(&command)
                .current_dir(&cwd)
                .output()
        } else {
            std::process::Command::new("bash")
                .arg("-lc")
                .arg(&command)
                .current_dir(&cwd)
                .output()
        }
        .map_err(|error| {
            KernelError::Other(format!("failed to start kernel controlled shell: {error}"))
        })?;
        Ok(serde_json::json!({
            "command": command,
            "cwd": cwd,
            "executed": true,
            "exitCode": output.status.code(),
            "stdout": limit_text(&String::from_utf8_lossy(&output.stdout), 16 * 1024),
            "stderr": limit_text(&String::from_utf8_lossy(&output.stderr), 16 * 1024),
            "durationMs": now_millis().saturating_sub(started),
            "truncated": output.stdout.len() > 16 * 1024 || output.stderr.len() > 16 * 1024,
            "tempSessionId": format!("kernel-shell-{}", started),
            "cleanupStatus": "alreadyExited"
        }))
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

    fn resolve_run_session(
        &self,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
    ) -> KernelResult<(String, String)> {
        if let Some(run_id) = run_id {
            let record = self.record_by_run(&run_id.0)?;
            return Ok((run_id.0, record.session_id));
        }
        if let Some(session_id) = session_id {
            let record = self
                .state
                .records_by_session
                .get(&session_id.0)
                .ok_or_else(|| {
                    KernelError::InvalidCommand(format!(
                        "session {} has no active run",
                        session_id.0
                    ))
                })?;
            return Ok((record.run_id.clone(), session_id.0));
        }
        self.state
            .records_by_session
            .iter()
            .next_back()
            .map(|(session_id, record)| (record.run_id.clone(), session_id.clone()))
            .ok_or_else(|| KernelError::InvalidCommand("no active run".to_string()))
    }

    fn not_implemented(
        &self,
        _request_id: RequestId,
        operation: &'static str,
    ) -> KernelResult<Vec<KernelEvent>> {
        Err(KernelError::NotImplemented(operation))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum LlmPhaseAdvance {
    Continue(WorkflowPhase),
    Finish,
    Stop,
}

fn next_phase_after_llm_response(phase: &str, decision: &WorkflowDecision) -> LlmPhaseAdvance {
    if decision.fail_closed
        || matches!(
            decision.action,
            WorkflowDecisionAction::AwaitPermission | WorkflowDecisionAction::Blocked
        )
    {
        return LlmPhaseAdvance::Stop;
    }
    match phase {
        "plan" => LlmPhaseAdvance::Continue(WorkflowPhase::Check),
        "check" => LlmPhaseAdvance::Continue(WorkflowPhase::Complete),
        "complete" => {
            if matches!(
                decision.action,
                WorkflowDecisionAction::Review | WorkflowDecisionAction::Done
            ) {
                LlmPhaseAdvance::Continue(WorkflowPhase::Review)
            } else {
                LlmPhaseAdvance::Stop
            }
        }
        "review" => {
            if matches!(decision.action, WorkflowDecisionAction::Done) {
                LlmPhaseAdvance::Finish
            } else {
                LlmPhaseAdvance::Stop
            }
        }
        _ => LlmPhaseAdvance::Stop,
    }
}

fn compile_llm_request_envelope(
    phase: &str,
    input_text: &str,
    decision_state: &WorkflowDecisionState,
) -> Value {
    let system = compile_kernel_phase_instruction(phase, decision_state);
    let tools = if phase == "complete" {
        kernel_visible_tool_schemas()
    } else {
        Vec::new()
    };
    serde_json::json!({
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": input_text }
        ],
        "tools": tools,
        "answerObligations": decision_state.answer_obligations,
        "completionCriteria": {
            "tempLifecycleRequired": decision_state.temp_lifecycle_required,
            "workspaceSummaryRequired": decision_state.workspace_summary_required,
            "toolComponentRequired": decision_state.tool_component_required,
            "workspaceSummaryFilePath": decision_state.workspace_summary_file_path,
            "pendingSteps": decision_state.pending_steps()
        }
    })
}

fn compile_kernel_phase_instruction(phase: &str, decision_state: &WorkflowDecisionState) -> String {
    let stage_instruction = match phase {
        "plan" => "你是 DeepCode Kernel 调度的规划阶段。只产出计划、范围、禁止项、风险和完成条件，不直接回答最终身份、结果或总结。",
        "check" => "你是 DeepCode Kernel 调度的检查阶段。只审查计划风险、路径、权限和可执行性，不重复最终答案。",
        "complete" => "你是 DeepCode Kernel 调度的执行阶段。需要本地操作时只能使用 Kernel 提供的工具调用；不要把自然语言当作本地操作。",
        "review" => "你是 DeepCode Kernel 调度的复核阶段。只有结构化完成条件满足后才输出最终答案；未完成时说明 blocked/replan。",
        _ => "你是 DeepCode Kernel 调度的 Agent 阶段。",
    };
    format!(
        "{stage_instruction}\n\n\
        输出语言默认简体中文。工具路径必须是工作区相对路径，禁止 /tmp、绝对路径和 ..。\n\
        fs.delete 是隐藏的内核受控能力，不在普通模型工具目录中；临时测试文件清理由 Kernel 受控流程完成。\n\
        不要重复已经满足的 AnswerObligation。\n\
        当前待满足步骤：{}",
        decision_state.pending_steps().join("；")
    )
}

fn kernel_visible_tool_schemas() -> Vec<Value> {
    vec![
        serde_json::json!({
            "name": "fs.list",
            "description": "List a workspace directory tree with bounded depth.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "folderId": { "type": "string" }
                }
            }
        }),
        serde_json::json!({
            "name": "fs.read",
            "description": "Read a text file from the active workspace.",
            "inputSchema": {
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": { "type": "string" },
                    "folderId": { "type": "string" }
                }
            }
        }),
        serde_json::json!({
            "name": "fs.diff",
            "description": "Preview a file diff without writing.",
            "inputSchema": {
                "type": "object",
                "required": ["path", "newContent"],
                "properties": {
                    "path": { "type": "string" },
                    "newContent": { "type": "string" },
                    "folderId": { "type": "string" }
                }
            }
        }),
        serde_json::json!({
            "name": "code.search",
            "description": "Search text across the workspace.",
            "inputSchema": {
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": { "type": "string" },
                    "isRegex": { "type": "boolean" },
                    "include": { "type": "array", "items": { "type": "string" } },
                    "folderId": { "type": "string" }
                }
            }
        }),
        serde_json::json!({
            "name": "fs.write",
            "description": "Write a text file after explicit permission approval.",
            "inputSchema": {
                "type": "object",
                "required": ["path", "content"],
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" },
                    "folderId": { "type": "string" }
                }
            }
        }),
        serde_json::json!({
            "name": "shell.propose",
            "description": "Propose a shell command without executing it.",
            "inputSchema": {
                "type": "object",
                "required": ["command"],
                "properties": {
                    "command": { "type": "string" },
                    "reason": { "type": "string" }
                }
            }
        }),
        serde_json::json!({
            "name": "shell.exec",
            "description": "Run a command in a Kernel controlled shell after explicit approval.",
            "inputSchema": {
                "type": "object",
                "required": ["command"],
                "properties": {
                    "command": { "type": "string" },
                    "cwd": { "type": "string" },
                    "timeoutMs": { "type": "number" },
                    "reason": { "type": "string" }
                }
            }
        }),
    ]
}

fn extract_llm_tool_calls(response_envelope: &Value) -> Vec<KernelLlmToolCall> {
    response_envelope
        .pointer("/assistantMessage/toolCalls")
        .or_else(|| response_envelope.get("toolCalls"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item.get("name").and_then(Value::as_str)?;
                    Some(KernelLlmToolCall {
                        id: item
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("tool-call")
                            .to_string(),
                        name: name.to_string(),
                        arguments: item
                            .get("arguments")
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({})),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn has_identity_request(input: &str, lower: &str) -> bool {
    input.contains("身份")
        || input.contains("你是谁")
        || lower.contains("identity")
        || lower.contains("who are you")
}

fn has_tool_component_request(input: &str, lower: &str) -> bool {
    input.contains("功能组件")
        || input.contains("各组件")
        || input.contains("所有组件")
        || input.contains("所有的功能")
        || input.contains("工具组件")
        || input.contains("组件正常")
        || input.contains("调用各组件")
        || input.contains("测试agent")
        || lower.contains("action type")
        || lower.contains("tool component")
}

fn has_workspace_summary_request(input: &str, lower: &str) -> bool {
    input.contains("读取当前工作区")
        || (input.contains("工作区") && input.contains("总结"))
        || (input.contains("当前项目") && input.contains("总结"))
        || lower.contains("read current workspace")
        || lower.contains("summarize workspace")
        || lower.contains("workspace summary")
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

fn find_workspace_summary_file_path(value: &Value) -> Option<String> {
    let mut paths = Vec::new();
    collect_workspace_file_paths(value, &mut paths);
    paths.sort_by_key(|path| workspace_summary_path_score(path));
    paths.into_iter().next()
}

fn collect_workspace_file_paths(value: &Value, paths: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_workspace_file_paths(item, paths);
            }
        }
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("file") {
                if let Some(path) = map.get("path").and_then(Value::as_str) {
                    if is_workspace_summary_candidate(path) {
                        paths.push(path.to_string());
                    }
                }
            }
            for value in map.values() {
                collect_workspace_file_paths(value, paths);
            }
        }
        _ => {}
    }
}

fn is_workspace_summary_candidate(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    if lower.contains("_agent_tmp_")
        || lower.ends_with(".exe")
        || lower.ends_with(".dll")
        || lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".zip")
        || lower.ends_with(".7z")
    {
        return false;
    }
    [
        ".md", ".txt", ".rs", ".ts", ".tsx", ".js", ".jsx", ".json", ".toml", ".yaml", ".yml",
        ".cpp", ".h", ".hpp", ".c", ".py",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
}

fn workspace_summary_path_score(path: &str) -> (u8, usize, String) {
    let lower = path.to_ascii_lowercase();
    let priority = if lower.ends_with("readme.md") {
        0
    } else if lower.ends_with(".md") {
        1
    } else if lower.ends_with(".txt") {
        2
    } else if lower.ends_with(".json") || lower.ends_with(".toml") || lower.ends_with(".yaml") {
        3
    } else {
        4
    };
    (priority, path.len(), lower)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PermissionAction {
    Allow,
    Ask,
    Deny,
}

fn permission_action_for_kernel_tool(tool_name: &str) -> PermissionAction {
    match tool_name {
        "fs.write" | "shell.exec" => PermissionAction::Ask,
        "fs.delete" => PermissionAction::Ask,
        "fs.read" | "fs.list" | "fs.diff" | "code.search" | "shell.propose" => {
            PermissionAction::Allow
        }
        _ => PermissionAction::Deny,
    }
}

fn needs_workspace_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "fs.read" | "fs.list" | "fs.diff" | "fs.write" | "fs.delete" | "code.search"
    )
}

fn capability_for_tool(tool_name: &str) -> &'static str {
    match tool_name {
        "fs.write" => "cap.fs.write",
        "fs.delete" => "cap.fs.delete",
        "shell.exec" => "cap.shell.exec",
        "fs.read" | "fs.list" | "fs.diff" => "cap.fs.read",
        "code.search" => "cap.code.search",
        "shell.propose" => "cap.shell.propose",
        _ => "cap.unknown",
    }
}

fn risk_for_tool(tool_name: &str) -> &'static str {
    match tool_name {
        "fs.delete" | "shell.exec" => "high",
        "fs.write" => "medium",
        _ => "low",
    }
}

fn redact_tool_arguments(tool_name: &str, arguments: &Value) -> Value {
    if tool_name == "shell.exec" {
        return serde_json::json!({
            "command": arguments.get("command").and_then(Value::as_str).unwrap_or_default()
        });
    }
    arguments.clone()
}

fn next_kernel_autorun_tool(state: &WorkflowDecisionState) -> Option<(&'static str, Value)> {
    if !(state.workspace_summary_required
        || state.tool_component_required
        || state.temp_lifecycle_required)
    {
        return None;
    }
    if !state.workspace_listed {
        return Some(("fs.list", serde_json::json!({ "path": "." })));
    }
    if state.workspace_summary_required && !state.workspace_file_read {
        let path = state
            .workspace_summary_file_path
            .as_deref()
            .unwrap_or("README.md");
        return Some(("fs.read", serde_json::json!({ "path": path })));
    }
    if state.tool_component_required && !state.workspace_search_completed {
        return Some(("code.search", serde_json::json!({ "query": "DeepCode" })));
    }
    if !state.temp_lifecycle_required {
        return None;
    }
    if !state.temp_created {
        return Some((
            "fs.write",
            serde_json::json!({
                "path": "_agent_tmp_functional_test.txt",
                "content": format!("DeepCode Agent temp lifecycle test at {}", now_millis())
            }),
        ));
    }
    if !state.temp_read_back {
        return Some((
            "fs.read",
            serde_json::json!({ "path": "_agent_tmp_functional_test.txt" }),
        ));
    }
    if !state.temp_cleaned {
        return Some((
            "fs.delete",
            serde_json::json!({ "path": "_agent_tmp_functional_test.txt" }),
        ));
    }
    None
}

fn is_kernel_owned_temp_cleanup(tool_name: &str, arguments: &Value) -> bool {
    tool_name == "fs.delete"
        && arguments
            .get("path")
            .and_then(Value::as_str)
            .map(is_temp_file_path)
            .unwrap_or(false)
}

fn get_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn limit_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes.min(value.len());
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    format!("{}...[truncated]", &value[..end])
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
        KernelEvent::LlmCallRequested { .. } => "llm.call_requested",
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
        | KernelEvent::LlmCallRequested { sequence, .. }
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

    fn active_llm_call(events: &[KernelEvent]) -> (RunId, String) {
        events
            .iter()
            .rev()
            .find_map(|event| match event {
                KernelEvent::LlmCallRequested {
                    run_id,
                    llm_call_id,
                    ..
                } => Some((run_id.clone(), llm_call_id.clone())),
                _ => None,
            })
            .unwrap_or_else(|| panic!("expected active llm call in {events:?}"))
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

        assert_eq!(events.len(), 5);
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
        assert!(matches!(events[4], KernelEvent::LlmCallRequested { .. }));

        let snapshot = runtime.snapshot(Some("session-1"));
        assert_eq!(snapshot.workflow_phase.as_deref(), Some("plan"));
        assert_eq!(snapshot.events.len(), 5);

        let ledger = runtime.ledger("run-1").unwrap();
        assert_eq!(ledger.len(), 5);
        assert_eq!(ledger[0].kind, "run.started");
        assert_eq!(ledger[4].kind, "llm.call_requested");
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
        assert_eq!(runtime.ledger("run-1").unwrap().len(), 6);
    }

    #[test]
    fn llm_response_submit_advances_workflow_under_kernel_control() {
        let mut runtime = DeepCodeKernelRuntime::new();
        let started = runtime
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
        let (run_id, llm_call_id) = match started.last().unwrap() {
            KernelEvent::LlmCallRequested {
                run_id,
                llm_call_id,
                ..
            } => (run_id.clone(), llm_call_id.clone()),
            other => panic!("expected llm call request, got {other:?}"),
        };

        let events = runtime
            .dispatch(KernelCommand::LlmResponseSubmit {
                request_id: RequestId("req-llm".to_string()),
                run_id,
                session_id: Some(SessionId("session-1".to_string())),
                llm_call_id,
                response_envelope: serde_json::json!({
                    "assistantMessage": {
                        "content": "<plan>Use Kernel managed workflow.</plan>",
                        "toolCalls": []
                    }
                }),
            })
            .unwrap();

        assert!(events
            .iter()
            .any(|event| matches!(event, KernelEvent::MessageAppended { .. })));
        assert!(events.iter().any(|event| matches!(
            event,
            KernelEvent::StageChanged { phase, .. } if phase == "check"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            KernelEvent::LlmCallRequested { phase, .. } if phase == "check"
        )));
        assert_eq!(
            runtime
                .snapshot(Some("session-1"))
                .workflow_phase
                .as_deref(),
            Some("check")
        );
    }

    #[test]
    fn workspace_summary_component_request_requires_kernel_tool_evidence() {
        let state = WorkflowDecisionState::from_user_input(
            "读取当前工作区文件并总结输出给我，这是一个测试请求，用于测试agent能否调用各组件正常执行任务，最后返回你的身份信息",
        );

        let decision = state.decide("plan");
        assert_eq!(decision.action, WorkflowDecisionAction::Continue);
        assert_eq!(
            decision.reason,
            WorkflowDecisionReason::PendingCriticalSteps
        );
        assert!(decision
            .pending_steps
            .iter()
            .any(|step| step.contains("list workspace")));
        assert!(decision
            .pending_steps
            .iter()
            .any(|step| step.contains("read at least one workspace file")));
        assert!(decision
            .pending_steps
            .iter()
            .any(|step| step.contains("code.search")));
    }

    #[test]
    fn complete_phase_auto_runs_workspace_summary_tools_before_review() {
        let root = temp_workspace();
        fs::write(root.join("README.md"), "DeepCode workspace summary smoke").unwrap();

        let mut runtime = DeepCodeKernelRuntime::new();
        runtime
            .dispatch(KernelCommand::WorkspaceOpen {
                request_id: RequestId("req-open".to_string()),
                path: root.to_string_lossy().to_string(),
            })
            .unwrap();

        let started = runtime
            .dispatch(KernelCommand::RunStart {
                request_id: RequestId("req-run".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                input: UserInput {
                    text: "读取当前工作区文件并总结输出给我，这是一个测试请求，用于测试agent能否调用各组件正常执行任务，最后返回你的身份信息".to_string(),
                    attachments: vec![],
                },
                workspace_binding: Some(WorkspaceBinding {
                    workspace_id: Some("ws-1".to_string()),
                    workspace_hash: None,
                    open_path: Some(root.to_string_lossy().to_string()),
                    active_folder_id: Some("wf-0".to_string()),
                    folder_hash: None,
                }),
                profile_ref: None,
                workflow_ref: None,
                run_overrides: None,
            })
            .unwrap();

        let (run_id, plan_call_id) = active_llm_call(&started);
        let plan_events = runtime
            .dispatch(KernelCommand::LlmResponseSubmit {
                request_id: RequestId("req-plan".to_string()),
                run_id: run_id.clone(),
                session_id: Some(SessionId("session-1".to_string())),
                llm_call_id: plan_call_id,
                response_envelope: serde_json::json!({
                    "assistantMessage": { "content": "<plan>Read workspace and verify components.</plan>", "toolCalls": [] }
                }),
            })
            .unwrap();

        let (_, check_call_id) = active_llm_call(&plan_events);
        let check_events = runtime
            .dispatch(KernelCommand::LlmResponseSubmit {
                request_id: RequestId("req-check".to_string()),
                run_id: run_id.clone(),
                session_id: Some(SessionId("session-1".to_string())),
                llm_call_id: check_call_id,
                response_envelope: serde_json::json!({
                    "assistantMessage": { "content": "<observe>Plan is safe.</observe>", "toolCalls": [] }
                }),
            })
            .unwrap();

        let (_, complete_call_id) = active_llm_call(&check_events);
        let complete_events = runtime
            .dispatch(KernelCommand::LlmResponseSubmit {
                request_id: RequestId("req-complete".to_string()),
                run_id,
                session_id: Some(SessionId("session-1".to_string())),
                llm_call_id: complete_call_id,
                response_envelope: serde_json::json!({
                    "assistantMessage": { "content": "<say>开始执行工具验证。</say>", "toolCalls": [] }
                }),
            })
            .unwrap();

        assert!(complete_events.iter().any(|event| matches!(
            event,
            KernelEvent::ToolCompleted { tool_name, ok: true, .. } if tool_name == "fs.list"
        )));
        assert!(complete_events.iter().any(|event| matches!(
            event,
            KernelEvent::ToolCompleted { tool_name, ok: true, .. } if tool_name == "fs.read"
        )));
        assert!(complete_events.iter().any(|event| matches!(
            event,
            KernelEvent::ToolCompleted { tool_name, ok: true, .. } if tool_name == "code.search"
        )));
        assert!(complete_events.iter().any(|event| matches!(
            event,
            KernelEvent::WorkflowDecisionMade { decision, .. }
                if decision.action == WorkflowDecisionAction::Review
        )));

        fs::remove_dir_all(root).unwrap();
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
        assert_eq!(runtime.ledger("run-1").unwrap().len(), 7);
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
            ("req-observe-4", "tool-search", "code.search"),
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
            ("req-observe-4", "tool-search", "code.search"),
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
            "req-observe-5",
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
            "req-observe-6",
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
            "req-observe-7",
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
