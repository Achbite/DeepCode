use deepcode_kernel_abi::{
    ConfigSnapshotRef, HostStatus, KernelCommand, KernelError, KernelEvent, KernelEventSummary,
    KernelResult, KernelSnapshot, RequestId, RunId, SessionId, StageStatus, WorkspaceBinding,
};
use deepcode_kernel_config::{
    ConfigLayer, ConfigResolver, ConfigResolverInput, ConfigScope, ConfigSource, ConfigSourceKind,
    ConfigTrustLevel, DefaultConfigResolver,
};
use deepcode_kernel_ledger::{EventLedger, InMemoryEventLedger, LedgerEvent};
use deepcode_kernel_policy::PolicyProfile;
use deepcode_kernel_prompt::LayeredPromptCompiler;
use deepcode_kernel_skills::InMemorySkillRegistry;
use deepcode_kernel_workflow::{BuiltinWorkflowMachine, WorkflowMachine, WorkflowPhase};
use serde_json::Value;
use std::collections::BTreeMap;

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
    records_by_session: BTreeMap<String, RuntimeRunRecord>,
}

#[derive(Debug, Clone)]
struct RuntimeRunRecord {
    session_id: String,
    run_id: String,
    workspace_binding: WorkspaceBinding,
    config_ref: ConfigSnapshotRef,
    phase: WorkflowPhase,
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

    fn not_implemented(
        &self,
        _request_id: RequestId,
        operation: &'static str,
    ) -> KernelResult<Vec<KernelEvent>> {
        Err(KernelError::NotImplemented(operation))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deepcode_kernel_abi::{UserInput, WorkspaceBinding};

    fn binding() -> WorkspaceBinding {
        WorkspaceBinding {
            workspace_id: Some("ws-1".to_string()),
            workspace_hash: Some("hash-1".to_string()),
            open_path: Some("/workspace".to_string()),
            active_folder_id: Some("wf-0".to_string()),
            folder_hash: Some("folder-hash".to_string()),
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
}
