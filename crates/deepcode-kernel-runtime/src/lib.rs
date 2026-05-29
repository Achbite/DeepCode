use deepcode_kernel_abi::{
    ConfigSnapshotRef, HostStatus, KernelCommand, KernelError, KernelErrorEnvelope, KernelEvent,
    KernelEventSummary, KernelResult, KernelSnapshot, ProfileRef, RequestId, RunId, SessionId,
    StageStatus, WorkflowDecision, WorkflowDecisionAction, WorkspaceBinding,
};
use deepcode_kernel_config::{
    ConfigLayer, ConfigResolver, ConfigResolverInput, ConfigScope, ConfigSource, ConfigSourceKind,
    ConfigTrustLevel, DefaultConfigResolver,
};
use deepcode_kernel_context::{ContextCandidatePayload, ContextRuntime};
use deepcode_kernel_ledger::{
    ChangeOperation, ChangeSet, EventLedger, InMemoryEventLedger, LedgerEvent, NdjsonEventLedger,
    ReviewGate, ReviewGateStatus, ValidationKind, ValidationResult,
};
use deepcode_kernel_policy::{AutonomyLevel, PolicyProfile, WorkspaceBoundary};
use deepcode_kernel_prompt::LayeredPromptCompiler;
use deepcode_kernel_skills::{
    builtin::builtin_executors, InMemorySkillRegistry, SkillExecutionContext,
    SkillExecutorRegistry, SkillInvocation, SkillRegistry, SkillRuntime, SkillTrustMode,
};
use deepcode_kernel_workflow::{
    BuiltinWorkflowMachine, RunDecisionState, WorkflowMachine, WorkflowPhase,
};
use serde_json::Value;
use std::cmp::Ordering;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

mod state;

use state::{
    KernelLlmToolCall, PendingKernelTool, RuntimeRunRecord, RuntimeState, RuntimeWorkspace,
    WorkspaceSource,
};

pub struct DeepCodeKernelRuntime {
    config_resolver: DefaultConfigResolver,
    prompt_compiler: LayeredPromptCompiler,
    workflow: BuiltinWorkflowMachine,
    policy_profile: PolicyProfile,
    skills: InMemorySkillRegistry,
    tool_executors: SkillExecutorRegistry,
    ledger: Box<dyn EventLedger>,
    context_runtime: ContextRuntime,
    state: RuntimeState,
}

impl Default for DeepCodeKernelRuntime {
    fn default() -> Self {
        Self::with_ledger(Box::new(InMemoryEventLedger::new()))
    }
}

impl DeepCodeKernelRuntime {
    pub fn with_ledger(ledger: Box<dyn EventLedger>) -> Self {
        let mut state = RuntimeState::default();
        state.next_run_index = ledger
            .list_all()
            .unwrap_or_default()
            .iter()
            .filter_map(|event| event.run_id.as_deref())
            .filter_map(run_index_from_id)
            .max()
            .unwrap_or(0);
        Self {
            config_resolver: DefaultConfigResolver,
            prompt_compiler: LayeredPromptCompiler::default(),
            workflow: BuiltinWorkflowMachine::default(),
            policy_profile: PolicyProfile::developer_defaults(),
            skills: InMemorySkillRegistry::with_builtin_tools(),
            tool_executors: SkillExecutorRegistry::from_executors(builtin_executors()),
            ledger,
            context_runtime: ContextRuntime::new(),
            state,
        }
    }

    pub fn with_ndjson_ledger(path: impl Into<PathBuf>) -> Self {
        Self::with_ledger(Box::new(NdjsonEventLedger::new(path)))
    }

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
            KernelCommand::PlanContractSubmit { request_id, .. } => {
                self.not_implemented(request_id, "plan.contract_submit")
            }
            KernelCommand::SkillTrustApprove { request_id, .. } => {
                self.not_implemented(request_id, "skill.trust_approve")
            }
            KernelCommand::PermissionGrantTemporary {
                request_id,
                run_id,
                grant,
            } => self.permission_grant_temporary(request_id, run_id, grant),
        }
    }

    pub fn snapshot(&self, session_id: Option<&str>) -> KernelSnapshot {
        let record = self.runtime_record_for_snapshot(session_id);

        let events = record
            .as_ref()
            .map(|record| self.ledger.list_by_run(&record.run_id).unwrap_or_default())
            .unwrap_or_default();
        let pending_permission = record.as_ref().and_then(|record| {
            self.pending_permission_for_run(&record.run_id)
                .ok()
                .flatten()
        });

        KernelSnapshot {
            session_id: record
                .as_ref()
                .map(|value| SessionId(value.session_id.clone())),
            run_id: record.as_ref().map(|value| RunId(value.run_id.clone())),
            workspace_binding: record.as_ref().map(|value| value.workspace_binding.clone()),
            config_ref: record.as_ref().map(|value| value.config_ref.clone()),
            workflow_phase: record
                .as_ref()
                .map(|value| value.phase.as_str().to_string()),
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
            pending_permission,
            updated_at: None,
        }
    }

    pub fn ledger(&self, run_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        self.ledger.list_by_run(run_id)
    }

    fn runtime_record_for_snapshot(&self, session_id: Option<&str>) -> Option<RuntimeRunRecord> {
        session_id
            .and_then(|id| self.state.records_by_session.get(id).cloned())
            .or_else(|| {
                session_id.and_then(|id| self.runtime_record_from_session_ledger(id).ok().flatten())
            })
            .or_else(|| self.state.records_by_session.values().last().cloned())
            .or_else(|| self.runtime_record_from_latest_ledger().ok().flatten())
    }

    fn runtime_record_from_latest_ledger(&self) -> KernelResult<Option<RuntimeRunRecord>> {
        let latest_session = self
            .ledger
            .list_all()?
            .into_iter()
            .filter_map(|event| event.session_id)
            .last();
        latest_session
            .as_deref()
            .map(|session_id| self.runtime_record_from_session_ledger(session_id))
            .unwrap_or(Ok(None))
    }

    fn runtime_record_from_session_ledger(
        &self,
        session_id: &str,
    ) -> KernelResult<Option<RuntimeRunRecord>> {
        let events = self.ledger.list_by_session(session_id)?;
        let Some(run_id) = events
            .iter()
            .filter_map(|event| event.run_id.clone())
            .last()
        else {
            return Ok(None);
        };
        let run_events = self.ledger.list_by_run(&run_id)?;
        let Some(started) = run_events.iter().find(|event| event.kind == "run.started") else {
            return Ok(None);
        };
        let phase = run_events
            .iter()
            .rev()
            .find_map(|event| {
                if matches!(
                    event.kind.as_str(),
                    "workflow.checkpointed" | "workflow.resumed" | "stage.changed"
                ) {
                    event.payload.get("phase").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .and_then(workflow_phase_from_str)
            .unwrap_or(WorkflowPhase::Plan);
        let workspace_binding = serde_json::from_value(
            started
                .payload
                .get("workspaceBinding")
                .cloned()
                .unwrap_or(Value::Null),
        )
        .unwrap_or(WorkspaceBinding {
            workspace_id: None,
            workspace_hash: None,
            open_path: None,
            active_folder_id: None,
            folder_hash: None,
        });
        let config_ref = serde_json::from_value(
            started
                .payload
                .get("configRef")
                .cloned()
                .unwrap_or(Value::Null),
        )
        .unwrap_or(ConfigSnapshotRef {
            snapshot_id: format!("restored-config-{run_id}"),
            hash: None,
        });
        let profile_ref = started
            .payload
            .get("profileRef")
            .cloned()
            .and_then(|value| serde_json::from_value::<ProfileRef>(value).ok());
        let llm_call_index = run_events
            .iter()
            .filter(|event| event.kind == "llm.call_requested")
            .count() as u64;
        Ok(Some(RuntimeRunRecord {
            session_id: session_id.to_string(),
            run_id,
            input_text: started
                .payload
                .get("inputText")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            workspace_binding,
            config_ref,
            profile_ref,
            phase,
            active_llm_call_id: None,
            llm_call_index,
            decision_state: RunDecisionState::default(),
        }))
    }

    fn pending_permission_for_run(
        &self,
        run_id: &str,
    ) -> KernelResult<Option<deepcode_kernel_abi::PermissionRequestEnvelope>> {
        if let Some((permission_id, pending)) = self
            .state
            .pending_tools
            .iter()
            .find(|(_, pending)| pending.run_id == run_id)
        {
            return Ok(Some(permission_envelope_from_pending(
                permission_id,
                pending,
            )));
        }
        let events = self.ledger.list_by_run(run_id)?;
        let resolved = events
            .iter()
            .filter(|event| event.kind == "permission.resolved")
            .filter_map(|event| event.payload.get("permissionId").and_then(Value::as_str))
            .collect::<std::collections::BTreeSet<_>>();
        let pending = events
            .iter()
            .rev()
            .find(|event| {
                event.kind == "permission.requested"
                    && event
                        .payload
                        .get("permissionId")
                        .and_then(Value::as_str)
                        .map(|id| !resolved.contains(id))
                        .unwrap_or(false)
            })
            .and_then(|event| {
                let permission_id = event.payload.get("permissionId")?.as_str()?;
                Some(deepcode_kernel_abi::PermissionRequestEnvelope {
                    id: permission_id.to_string(),
                    capability: event
                        .payload
                        .get("capability")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| {
                            event
                                .payload
                                .get("toolName")
                                .and_then(Value::as_str)
                                .map(capability_for_tool)
                                .unwrap_or("workspace.write")
                        })
                        .to_string(),
                    risk_level: event
                        .payload
                        .get("riskLevel")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| {
                            event
                                .payload
                                .get("toolName")
                                .and_then(Value::as_str)
                                .map(risk_for_tool)
                                .unwrap_or("high")
                        })
                        .to_string(),
                    summary: event
                        .payload
                        .get("summary")
                        .and_then(Value::as_str)
                        .unwrap_or("Permission requested by Kernel.")
                        .to_string(),
                    args_preview: event
                        .payload
                        .get("argsPreview")
                        .cloned()
                        .unwrap_or(Value::Null),
                })
            });
        Ok(pending)
    }

    fn ensure_session_restored(&mut self, session_id: &str) -> KernelResult<()> {
        if self.state.records_by_session.contains_key(session_id) {
            return Ok(());
        }
        let Some(record) = self.runtime_record_from_session_ledger(session_id)? else {
            return Err(KernelError::InvalidCommand(format!(
                "session {session_id} has no resumable run"
            )));
        };
        self.state.next_run_index = self
            .state
            .next_run_index
            .max(run_index_from_id(&record.run_id).unwrap_or(0));
        if let Some((permission_id, pending)) = self.pending_tool_from_ledger(&record.run_id)? {
            self.state.pending_tools.insert(permission_id, pending);
        }
        if self.state.current_workspace.is_none() {
            if let Some(open_path) = record.workspace_binding.open_path.as_deref() {
                self.restore_workspace_from_open_path(open_path)?;
            }
        }
        self.state
            .records_by_session
            .insert(session_id.to_string(), record);
        Ok(())
    }

    fn restore_workspace_from_open_path(&mut self, open_path: &str) -> KernelResult<()> {
        let resolved = resolve_workspace_root(open_path).map_err(KernelError::InvalidCommand)?;
        self.state.next_workspace_index += 1;
        let workspace_id = format!("workspace-{}", self.state.next_workspace_index);
        self.state.current_workspace = Some(RuntimeWorkspace {
            id: workspace_id,
            name: resolved
                .root
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or("workspace")
                .to_string(),
            source: resolved.source,
            source_path: resolved.source_path,
            root: resolved.root,
            original_folder_path: open_path.to_string(),
            folder_is_absolute: true,
            settings: Value::Object(Default::default()),
            unsupported_fields: Vec::new(),
            opened_at: now_millis().to_string(),
        });
        Ok(())
    }

    fn ensure_permission_restored(&mut self, permission_id: &str) -> KernelResult<()> {
        if self.state.pending_tools.contains_key(permission_id) {
            return Ok(());
        }
        let events = self.ledger.list_all()?;
        let already_resolved = events.iter().any(|event| {
            event.kind == "permission.resolved"
                && event.payload.get("permissionId").and_then(Value::as_str) == Some(permission_id)
        });
        if already_resolved {
            return Ok(());
        }
        let Some(requested) = events.iter().rev().find(|event| {
            event.kind == "permission.requested"
                && event.payload.get("permissionId").and_then(Value::as_str) == Some(permission_id)
        }) else {
            return Ok(());
        };
        let Some(run_id) = requested.run_id.clone() else {
            return Ok(());
        };
        let Some(session_id) = requested.session_id.clone() else {
            return Ok(());
        };
        self.ensure_session_restored(&session_id)?;
        if let Some((restored_id, pending)) = self.pending_tool_from_ledger(&run_id)? {
            if restored_id == permission_id {
                self.state.pending_tools.insert(restored_id, pending);
            }
        }
        Ok(())
    }

    fn pending_tool_from_ledger(
        &self,
        run_id: &str,
    ) -> KernelResult<Option<(String, PendingKernelTool)>> {
        let events = self.ledger.list_by_run(run_id)?;
        let resolved = events
            .iter()
            .filter(|event| event.kind == "permission.resolved")
            .filter_map(|event| event.payload.get("permissionId").and_then(Value::as_str))
            .collect::<std::collections::BTreeSet<_>>();
        let pending = events
            .iter()
            .rev()
            .find(|event| {
                event.kind == "permission.requested"
                    && event
                        .payload
                        .get("permissionId")
                        .and_then(Value::as_str)
                        .map(|id| !resolved.contains(id))
                        .unwrap_or(false)
            })
            .and_then(|event| {
                let permission_id = event.payload.get("permissionId")?.as_str()?.to_string();
                let session_id = event.session_id.clone()?;
                let tool_name = event.payload.get("toolName")?.as_str()?.to_string();
                let tool_call_id = event
                    .payload
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or(&permission_id)
                    .to_string();
                let arguments = event
                    .payload
                    .get("arguments")
                    .cloned()
                    .or_else(|| event.payload.get("args").cloned())
                    .unwrap_or(Value::Null);
                Some((
                    permission_id,
                    PendingKernelTool {
                        run_id: run_id.to_string(),
                        session_id,
                        tool_call_id,
                        tool_name,
                        arguments,
                    },
                ))
            });
        Ok(pending)
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

    fn run_resume(
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
        let context_snapshot = self.context_runtime.create_snapshot(
            vec![ContextCandidatePayload {
                id: format!("latest-user-input-{run_id}"),
                kind: "latestUserInput".to_string(),
                payload: serde_json::json!({ "content": input_text }),
                source_refs: vec![format!("run:{run_id}")],
            }],
            Vec::new(),
        )?;
        let request_envelope = compile_llm_request_envelope(
            &phase,
            &input_text,
            &decision_state,
            Some(&context_snapshot.reference.id),
        );
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
                "contextSnapshotId": &context_snapshot.reference.id,
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
            let phase = record.phase.as_str().to_string();
            record.decision_state.apply_event(&event, &phase);
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
            let pending_tool_call_id = call.id.clone();
            let pending_arguments = call.arguments.clone();
            self.state.pending_tools.insert(
                permission_id.clone(),
                PendingKernelTool {
                    run_id: run_id.to_string(),
                    session_id: session_id.to_string(),
                    tool_call_id: pending_tool_call_id.clone(),
                    tool_name: call.name.clone(),
                    arguments: pending_arguments.clone(),
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
                let permission_phase = record.phase.as_str().to_string();
                record
                    .decision_state
                    .apply_event(&permission, &permission_phase);
            }
            self.append_ledger(
                run_id,
                session_id,
                "permission.requested",
                permission_sequence,
                serde_json::json!({
                    "summary": format!("Permission requested for {}.", call.name),
                    "permissionId": permission_id,
                    "toolCallId": pending_tool_call_id,
                    "toolName": call.name,
                    "capability": capability_for_tool(&call.name),
                    "riskLevel": risk_for_tool(&call.name),
                    "argsPreview": redact_tool_arguments(&call.name, &serde_json::json!({})),
                    "arguments": pending_arguments
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
        self.ensure_permission_restored(&permission_id)?;
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
            let resolved_phase = record.phase.as_str().to_string();
            record
                .decision_state
                .apply_event(&resolved_event, &resolved_phase);
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
        let autonomy_sequence = self.ledger.next_sequence(&run_id.0)?;
        self.append_ledger(
            &run_id.0,
            &record.session_id,
            "autonomy.transitioned",
            autonomy_sequence,
            serde_json::json!({
                "summary": "Temporary grant changed the effective capability set for this run.",
                "fromLevel": autonomy_level_name(&self.policy_profile.autonomy_level),
                "toLevel": autonomy_level_name(&self.policy_profile.autonomy_level),
                "capabilitySet": [&grant.capability]
            }),
        )?;
        Ok(vec![
            KernelEvent::MessageAppended {
                run_id: Some(run_id),
                session_id: Some(SessionId(record.session_id.clone())),
                turn_id: None,
                role: deepcode_kernel_abi::MessageRole::System,
                channel: Some("policy".to_string()),
                content: None,
                message_key: Some("permission.temporaryGrant.created".to_string()),
                args: None,
                sequence: Some(sequence),
            },
            KernelEvent::AutonomyTransitioned {
                run_id: Some(RunId(record.run_id.clone())),
                session_id: Some(SessionId(record.session_id)),
                from_level: Some(
                    autonomy_level_name(&self.policy_profile.autonomy_level).to_string(),
                ),
                to_level: autonomy_level_name(&self.policy_profile.autonomy_level).to_string(),
                capability_set: vec![grant.capability],
                reason: Some("temporary grant recorded".to_string()),
                sequence: Some(autonomy_sequence),
            },
        ])
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
            let pending_tool_call_id = tool_call_id.clone();
            let pending_arguments = arguments.clone();
            self.state.pending_tools.insert(
                permission_id.clone(),
                PendingKernelTool {
                    run_id: run_id.clone(),
                    session_id: session_id.clone(),
                    tool_call_id: pending_tool_call_id.clone(),
                    tool_name: tool_name.clone(),
                    arguments: pending_arguments.clone(),
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
                let permission_phase = record.phase.as_str().to_string();
                record
                    .decision_state
                    .apply_event(&permission, &permission_phase);
            }
            self.append_ledger(
                &run_id,
                &session_id,
                "permission.requested",
                permission_sequence,
                serde_json::json!({
                    "summary": format!("Permission requested for {tool_name}."),
                    "permissionId": permission_id,
                    "toolCallId": pending_tool_call_id,
                    "toolName": tool_name,
                    "capability": capability_for_tool(&tool_name),
                    "riskLevel": risk_for_tool(&tool_name),
                    "argsPreview": redact_tool_arguments(&tool_name, &serde_json::json!({})),
                    "arguments": pending_arguments
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
            let phase = record.phase.as_str().to_string();
            record.decision_state.apply_event(&event, &phase);
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
        if let Ok(output) = result.as_ref() {
            self.record_change_operation_for_tool(
                run_id,
                session_id,
                &tool_call_id,
                &tool_name,
                &arguments,
            )?;
            self.record_validation_for_tool(run_id, session_id, &tool_call_id, &tool_name, output)?;
        }
        Ok(event)
    }

    fn record_change_operation_for_tool(
        &mut self,
        run_id: &str,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> KernelResult<()> {
        let Some((kind, path)) = change_operation_for_tool(tool_name, arguments) else {
            return Ok(());
        };
        let operation = ChangeOperation {
            id: format!("change-{run_id}-{tool_call_id}"),
            work_unit_id: Some(tool_call_id.to_string()),
            kind: kind.to_string(),
            file_path: path,
            diff: None,
        };
        self.state
            .change_operations_by_run
            .entry(run_id.to_string())
            .or_default()
            .push(operation.clone());

        let operation_sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "change.operation_recorded",
            operation_sequence,
            serde_json::json!({
                "summary": format!("Change operation recorded for {tool_name}."),
                "operation": &operation
            }),
        )?;

        let operations = self
            .state
            .change_operations_by_run
            .get(run_id)
            .cloned()
            .unwrap_or_default();
        let change_set =
            ChangeSet::from_operations(format!("changeset-{run_id}"), run_id, operations);
        let change_set_sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "change_set.recorded",
            change_set_sequence,
            serde_json::json!({
                "summary": change_set.diff_summary,
                "changeSet": change_set
            }),
        )
    }

    fn record_validation_for_tool(
        &mut self,
        run_id: &str,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        output: &Value,
    ) -> KernelResult<()> {
        if tool_name != "shell.exec" {
            return Ok(());
        }
        let command = output
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(kind) = validation_kind_for_command(command) else {
            return Ok(());
        };
        let exit_code = output.get("exitCode").and_then(Value::as_i64);
        let passed = exit_code == Some(0);
        let validation = ValidationResult {
            id: format!("validation-{run_id}-{tool_call_id}"),
            run_id: run_id.to_string(),
            kind,
            passed,
            summary: if passed {
                format!("Validation command passed: {command}")
            } else {
                format!("Validation command failed with {exit_code:?}: {command}")
            },
            evidence_refs: vec![format!("tool.completed:{tool_call_id}")],
        };
        self.state
            .validations_by_run
            .entry(run_id.to_string())
            .or_default()
            .push(validation.clone());
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "validation.result",
            sequence,
            serde_json::json!({
                "summary": if validation.passed { "Validation passed." } else { "Validation failed." },
                "validation": validation
            }),
        )
    }

    fn change_set_for_run(&self, run_id: &str) -> KernelResult<Option<ChangeSet>> {
        if let Some(operations) = self.state.change_operations_by_run.get(run_id) {
            if !operations.is_empty() {
                return Ok(Some(ChangeSet::from_operations(
                    format!("changeset-{run_id}"),
                    run_id,
                    operations.clone(),
                )));
            }
        }
        let operations = self
            .ledger
            .list_by_run(run_id)?
            .into_iter()
            .filter(|event| event.kind == "change.operation_recorded")
            .filter_map(|event| {
                serde_json::from_value::<ChangeOperation>(event.payload.get("operation")?.clone())
                    .ok()
            })
            .collect::<Vec<_>>();
        if operations.is_empty() {
            Ok(None)
        } else {
            Ok(Some(ChangeSet::from_operations(
                format!("changeset-{run_id}"),
                run_id,
                operations,
            )))
        }
    }

    fn validations_for_run(&self, run_id: &str) -> KernelResult<Vec<ValidationResult>> {
        if let Some(validations) = self.state.validations_by_run.get(run_id) {
            return Ok(validations.clone());
        }
        Ok(self
            .ledger
            .list_by_run(run_id)?
            .into_iter()
            .filter(|event| event.kind == "validation.result")
            .filter_map(|event| {
                serde_json::from_value::<ValidationResult>(event.payload.get("validation")?.clone())
                    .ok()
            })
            .collect())
    }

    fn evidence_refs_for_run(&self, run_id: &str) -> KernelResult<Vec<String>> {
        Ok(self
            .ledger
            .list_by_run(run_id)?
            .into_iter()
            .filter_map(|event| match event.kind.as_str() {
                "tool.completed" => event
                    .payload
                    .get("ok")
                    .and_then(Value::as_bool)
                    .filter(|ok| *ok)
                    .map(|_| format!("tool.completed:{}", event.sequence.unwrap_or_default())),
                "workspace.result" => event
                    .payload
                    .get("ok")
                    .and_then(Value::as_bool)
                    .filter(|ok| *ok)
                    .map(|_| format!("workspace.result:{}", event.sequence.unwrap_or_default())),
                "message.appended" => event
                    .payload
                    .get("channel")
                    .and_then(Value::as_str)
                    .filter(|channel| *channel == "final")
                    .map(|_| format!("message.appended:{}", event.sequence.unwrap_or_default())),
                _ => None,
            })
            .collect())
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
                let pending_tool_call_id = tool_call_id.clone();
                let pending_arguments = arguments.clone();
                self.state.pending_tools.insert(
                    permission_id.clone(),
                    PendingKernelTool {
                        run_id: run_id.to_string(),
                        session_id: session_id.to_string(),
                        tool_call_id: pending_tool_call_id.clone(),
                        tool_name: tool_name.to_string(),
                        arguments: pending_arguments.clone(),
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
                    let permission_phase = record.phase.as_str().to_string();
                    record
                        .decision_state
                        .apply_event(&permission, &permission_phase);
                }
                self.append_ledger(
                    run_id,
                    session_id,
                    "permission.requested",
                    permission_sequence,
                    serde_json::json!({
                        "summary": format!("Permission requested for {tool_name}."),
                        "permissionId": permission_id,
                        "toolCallId": pending_tool_call_id,
                        "toolName": tool_name,
                        "capability": capability_for_tool(tool_name),
                        "riskLevel": risk_for_tool(tool_name),
                        "argsPreview": redact_tool_arguments(tool_name, &serde_json::json!({})),
                        "arguments": pending_arguments
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
        let workspace_root = self
            .state
            .current_workspace
            .as_ref()
            .map(|workspace| workspace.root.to_string_lossy().to_string());
        let result = self.tool_executors.invoke(
            SkillInvocation {
                id: format!("tool-{tool_name}"),
                skill_id: tool_name.to_string(),
                phase: Some("complete".to_string()),
                input: arguments.clone(),
            },
            SkillExecutionContext {
                run_id: None,
                session_id: None,
                trust_mode: SkillTrustMode::Declarative,
                approved_capabilities: Vec::new(),
                workspace_root,
            },
        )?;
        if result.ok {
            Ok(result.output)
        } else {
            Err(KernelError::Other(
                result
                    .error
                    .unwrap_or_else(|| format!("tool {tool_name} failed")),
            ))
        }
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
        WorkspaceBoundary::new(&workspace.root).resolve(relative_path)
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

fn permission_envelope_from_pending(
    permission_id: &str,
    pending: &PendingKernelTool,
) -> deepcode_kernel_abi::PermissionRequestEnvelope {
    deepcode_kernel_abi::PermissionRequestEnvelope {
        id: permission_id.to_string(),
        capability: capability_for_tool(&pending.tool_name).to_string(),
        risk_level: risk_for_tool(&pending.tool_name).to_string(),
        summary: format!("Allow {} to access workspace resources?", pending.tool_name),
        args_preview: redact_tool_arguments(&pending.tool_name, &pending.arguments),
    }
}

fn run_index_from_id(run_id: &str) -> Option<u64> {
    run_id.strip_prefix("run-")?.parse::<u64>().ok()
}

fn change_operation_for_tool(tool_id: &str, arguments: &Value) -> Option<(&'static str, String)> {
    match tool_id {
        "fs.write" => get_string(arguments, "path").map(|path| ("write", path)),
        "fs.delete" => get_string(arguments, "path").map(|path| ("delete", path)),
        _ => None,
    }
}

fn validation_kind_for_command(command: &str) -> Option<ValidationKind> {
    let lowered = command.to_ascii_lowercase();
    if lowered.contains("test") {
        Some(ValidationKind::Test)
    } else if lowered.contains("typecheck") || lowered.contains("tsc") {
        Some(ValidationKind::Typecheck)
    } else if lowered.contains("lint") {
        Some(ValidationKind::Lint)
    } else if lowered.contains("fmt") || lowered.contains("format") {
        Some(ValidationKind::Format)
    } else {
        None
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

fn workflow_phase_from_str(phase: &str) -> Option<WorkflowPhase> {
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

fn autonomy_level_name(level: &AutonomyLevel) -> &'static str {
    match level {
        AutonomyLevel::Safe => "safe",
        AutonomyLevel::Developer => "developer",
        AutonomyLevel::Trusted => "trusted",
        AutonomyLevel::Expert => "expert",
        AutonomyLevel::MaintainerRoot => "maintainerRoot",
    }
}

fn compile_llm_request_envelope(
    phase: &str,
    input_text: &str,
    decision_state: &RunDecisionState,
    context_snapshot_id: Option<&str>,
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
        "contextSnapshotId": context_snapshot_id,
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

fn compile_kernel_phase_instruction(phase: &str, decision_state: &RunDecisionState) -> String {
    let stage_instruction = match phase {
        "plan" => "你是 DeepCode Kernel 调度的规划阶段。只产出计划、范围、禁止项、风险和完成条件；不得回答身份信息、测试结果或最终总结。",
        "check" => "你是 DeepCode Kernel 调度的检查阶段。只审查计划风险、路径、权限和可执行性；不得写伪工具命令、不得重复计划正文、不得输出最终答案。",
        "complete" => "你是 DeepCode Kernel 调度的执行阶段。需要本地操作时只能使用 Kernel 提供的工具调用；不要用自然语言声称工具已经执行，不回答身份信息或最终总结。",
        "review" => "你是 DeepCode Kernel 调度的复核阶段。只能依据 Kernel 工具结果、权限结果和结构化完成条件输出最终答案；未完成时说明 blocked/replan，不得补造工具结果。",
        _ => "你是 DeepCode Kernel 调度的 Agent 阶段。",
    };
    let mut prompt = format!(
        "{stage_instruction}\n\n\
        输出语言默认简体中文。工具路径必须是工作区相对路径，禁止 /tmp、绝对路径和 ..。\n\
        DeepCode 允许的工具名仅有：fs.list、fs.read、fs.write、fs.delete、code.search、shell.exec；\n\
        严禁出现 list_dir、write_file、read_file、delete_file、execute_command、list_files 等非 DeepCode 命名；\n\
        引用工具时必须使用 fs.list/fs.read/fs.write/fs.delete/code.search/shell.exec 的精确写法，可见工具目录以 requestEnvelope.tools 为准。\n\
        fs.delete 是隐藏的内核受控能力，不在普通模型工具目录中；临时测试文件清理由 Kernel 受控流程完成。\n\
        规划、检查和执行阶段只能记录进度；身份信息、工具汇总和临时文件结果只允许在复核/final 阶段回答一次。\n\
        不要重复已经满足的 AnswerObligation。\n\
        当前待满足步骤：{}",
        decision_state.pending_steps().join("；")
    );
    // review 阶段把 Kernel 工具事实作为唯一事实源注入 prompt；LLM 只能基于 evidence 字段
    // 输出最终答案，不允许从对话历史推断"哪个工具失败 / 哪个工具不可用"。
    if phase == "review" && !decision_state.evidence.is_empty() {
        let evidence_json = serde_json::to_string_pretty(&decision_state.evidence)
            .unwrap_or_else(|_| "[]".to_string());
        prompt.push_str(&format!(
            "\n\nKernel 工具事实证据（review/final 必须以此为唯一事实源；evidence 中 status=ok 即代表该工具调用成功，不得再说\"无法执行\"或\"工具不可用\"）：\n```json\n{evidence_json}\n```",
        ));
    }
    prompt
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PermissionAction {
    Allow,
    Ask,
    Deny,
}

fn permission_action_for_kernel_tool(tool_id: &str) -> PermissionAction {
    match tool_id {
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

fn capability_for_tool(tool_id: &str) -> &'static str {
    match tool_id {
        "fs.write" => "cap.fs.write",
        "fs.delete" => "cap.fs.delete",
        "shell.exec" => "cap.shell.exec",
        "fs.read" | "fs.list" | "fs.diff" => "cap.fs.read",
        "code.search" => "cap.code.search",
        "shell.propose" => "cap.shell.propose",
        _ => "cap.unknown",
    }
}

fn risk_for_tool(tool_id: &str) -> &'static str {
    match tool_id {
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

fn next_kernel_autorun_tool(state: &RunDecisionState) -> Option<(&'static str, Value)> {
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

fn is_temp_file_path(value: &str) -> bool {
    value.contains("_agent_tmp_")
}

fn get_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
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

fn normalize_relative_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() {
        ".".to_string()
    } else {
        normalized
    }
}

fn deny_protected_deepcode_mutation(path: &str) -> KernelResult<()> {
    WorkspaceBoundary::assert_mutable_config_asset(path)
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
        KernelEvent::ContextResult { .. } => "context.result",
        KernelEvent::TempArtifactCreated { .. } => "tempArtifact.created",
        KernelEvent::TempArtifactCleaned { .. } => "tempArtifact.cleaned",
        KernelEvent::TempArtifactLeaseGranted { .. } => "tempArtifact.lease_granted",
        KernelEvent::TempArtifactLeaseReleased { .. } => "tempArtifact.lease_released",
        KernelEvent::TempArtifactLeasePromoted { .. } => "tempArtifact.lease_promoted",
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
        | KernelEvent::ContextResult { sequence, .. }
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

#[cfg(test)]
mod tests;
