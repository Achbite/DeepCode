use crate::resources::KernelResourceManager;
use deepcode_kernel_abi::{
    ConfigSnapshotRef, KernelExecutionContract, KernelPlanAuthorizationContract, WorkspaceBinding,
};
use deepcode_kernel_tools::ToolOperationKind;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

#[derive(Debug, Default)]
pub(crate) struct RuntimeState {
    pub(crate) next_run_index: u64,
    pub(crate) next_workspace_index: u64,
    pub(crate) current_workspace: Option<RuntimeWorkspace>,
    pub(crate) records_by_session: BTreeMap<String, RuntimeRunRecord>,
    pub(crate) pending_tools: BTreeMap<String, PendingKernelTool>,
    pub(crate) batch_checkpoints_by_run: BTreeMap<String, BatchRuntimeCheckpoint>,
    pub(crate) cleanup_checkpoints_by_run:
        BTreeMap<String, deepcode_kernel_abi::KernelCleanupCheckpoint>,
    pub(crate) cleanup_state_by_run: BTreeMap<String, deepcode_kernel_abi::KernelCleanupState>,
    pub(crate) artifact_drafts: BTreeMap<String, ArtifactDraftRuntimeRecord>,
    pub(crate) terminal_artifact_draft_keys: BTreeSet<String>,
    pub(crate) execution_contracts_by_run:
        BTreeMap<String, BTreeMap<String, KernelExecutionContract>>,
    pub(crate) plan_authorization_contracts_by_run:
        BTreeMap<String, BTreeMap<String, KernelPlanAuthorizationContract>>,
    pub(crate) resource_manager: KernelResourceManager,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BatchOperationState {
    AwaitingPermission,
    Ready,
    Started,
    Completed,
    Failed,
    Blocked,
}

#[derive(Debug, Clone)]
pub(crate) struct BatchOperationRuntime {
    pub(crate) operation_id: String,
    pub(crate) depends_on: Vec<String>,
    pub(crate) work_unit_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) tool_id: String,
    pub(crate) operation_kind: ToolOperationKind,
    pub(crate) arguments: Value,
    pub(crate) read_set: Vec<String>,
    pub(crate) write_set: Vec<String>,
    pub(crate) state: BatchOperationState,
    pub(crate) permission_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct BatchRuntimeCheckpoint {
    pub(crate) request_id: String,
    pub(crate) session_id: String,
    pub(crate) plan_id: String,
    pub(crate) contract_id: String,
    pub(crate) operations: Vec<BatchOperationRuntime>,
    pub(crate) permission_decisions: BTreeMap<String, deepcode_kernel_abi::PermissionDecisionKind>,
    pub(crate) scheduler_revision: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct ArtifactDraftRuntimeRecord {
    pub(crate) run_id: String,
    pub(crate) session_id: String,
    pub(crate) task_id: String,
    pub(crate) draft_id: String,
    pub(crate) next_sequence: u64,
    pub(crate) expected_slot_ids: BTreeSet<String>,
    pub(crate) completed_slot_ids: BTreeSet<String>,
    pub(crate) frame_ids: BTreeSet<String>,
    pub(crate) content_bytes_by_slot: BTreeMap<String, u64>,
    pub(crate) chunk_counts_by_slot: BTreeMap<String, u64>,
    pub(crate) edit_match_hashes_by_slot: BTreeMap<String, String>,
    pub(crate) total_content_bytes: u64,
    pub(crate) terminal: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeWorkspace {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) source: HostWorkspaceSourceKind,
    pub(crate) source_path: Option<PathBuf>,
    pub(crate) root: PathBuf,
    pub(crate) original_folder_path: String,
    pub(crate) folder_is_absolute: bool,
    pub(crate) settings: Value,
    pub(crate) unsupported_fields: Vec<HostUnsupportedWorkspaceField>,
    pub(crate) opened_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeRunRecord {
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) attachments: Vec<Value>,
    pub(crate) workspace_binding: WorkspaceBinding,
    pub(crate) config_ref: ConfigSnapshotRef,
    pub(crate) lifecycle_state: RuntimeLifecycleState,
}

impl RuntimeRunRecord {
    pub(crate) fn has_workspace_execution_context(&self) -> bool {
        self.workspace_binding
            .open_path
            .as_deref()
            .is_some_and(|path| PathBuf::from(path).is_dir())
            || self
                .attachments
                .iter()
                .any(|attachment| normalized_explicit_attachment_grant(attachment).is_some())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PendingKernelTool {
    pub(crate) run_id: String,
    pub(crate) session_id: String,
    pub(crate) tool_id: String,
    pub(crate) arguments: Value,
    pub(crate) permission_bundle_id: Option<String>,
    pub(crate) contract_id: Option<String>,
    pub(crate) affected_operation_ids: Vec<String>,
    pub(crate) work_unit_ids: Vec<String>,
    pub(crate) work_unit_id: Option<String>,
    pub(crate) action_id: Option<String>,
    pub(crate) plan_id: Option<String>,
    pub(crate) operation_kind: ToolOperationKind,
    pub(crate) read_set: Vec<String>,
    pub(crate) write_set: Vec<String>,
    pub(crate) group_items: Vec<PendingKernelToolItem>,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingKernelToolItem {
    pub(crate) tool_call_id: String,
    pub(crate) tool_id: String,
    pub(crate) arguments: Value,
    pub(crate) work_unit_id: Option<String>,
    pub(crate) action_id: Option<String>,
    pub(crate) plan_id: Option<String>,
    pub(crate) operation_kind: ToolOperationKind,
    pub(crate) read_set: Vec<String>,
    pub(crate) write_set: Vec<String>,
}

use super::*;

impl DeepCodeKernelRuntime {
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
            lifecycle_state: record.as_ref().map(|value| value.lifecycle_state),
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

    pub(crate) fn runtime_record_for_snapshot(
        &self,
        session_id: Option<&str>,
    ) -> Option<RuntimeRunRecord> {
        session_id
            .and_then(|id| self.state.records_by_session.get(id).cloned())
            .or_else(|| {
                session_id.and_then(|id| self.runtime_record_from_session_ledger(id).ok().flatten())
            })
    }

    pub(crate) fn runtime_record_from_session_ledger(
        &self,
        session_id: &str,
    ) -> KernelResult<Option<RuntimeRunRecord>> {
        let events = self.ledger.list_by_session(session_id)?;
        let Some(run_id) = events
            .iter()
            .filter_map(|event| event.run_id.clone())
            .next_back()
        else {
            return Ok(None);
        };
        let run_events = self.ledger.list_by_run(&run_id)?;
        let started = run_events
            .iter()
            .find(|event| event.kind == "run.started")
            .ok_or_else(|| KernelError::Structured {
                code: "run_recovery_schema_invalid",
                stage: "run.restore",
                message: "run ledger is missing run.started".to_string(),
                details: serde_json::json!({ "runId": run_id, "sessionId": session_id }),
            })?;
        let lifecycle_value = run_events
            .iter()
            .rev()
            .find_map(|event| {
                (event.kind == "runtime.lifecycle_changed")
                    .then(|| event.payload.get("currentState").and_then(Value::as_str))
                    .flatten()
            })
            .ok_or_else(|| KernelError::Structured {
                code: "run_recovery_schema_invalid",
                stage: "run.restore",
                message: "run ledger is missing runtime lifecycle state".to_string(),
                details: serde_json::json!({ "runId": run_id, "sessionId": session_id }),
            })?;
        let lifecycle_state =
            RuntimeLifecycleState::from_wire(lifecycle_value).ok_or_else(|| {
                KernelError::Structured {
                    code: "run_recovery_schema_invalid",
                    stage: "run.restore",
                    message: "run ledger contains an unknown runtime lifecycle state".to_string(),
                    details: serde_json::json!({
                        "runId": run_id,
                        "sessionId": session_id,
                        "lifecycleState": lifecycle_value,
                    }),
                }
            })?;
        let workspace_binding = serde_json::from_value(
            started
                .payload
                .get("workspaceBinding")
                .cloned()
                .ok_or_else(|| KernelError::Structured {
                    code: "run_recovery_schema_invalid",
                    stage: "run.restore",
                    message: "run.started is missing workspaceBinding".to_string(),
                    details: serde_json::json!({ "runId": run_id, "sessionId": session_id }),
                })?,
        )
        .map_err(|error| KernelError::Structured {
            code: "run_recovery_schema_invalid",
            stage: "run.restore",
            message: format!("decode workspaceBinding: {error}"),
            details: serde_json::json!({ "runId": run_id, "sessionId": session_id }),
        })?;
        let config_ref =
            serde_json::from_value(started.payload.get("configRef").cloned().ok_or_else(|| {
                KernelError::Structured {
                    code: "run_recovery_schema_invalid",
                    stage: "run.restore",
                    message: "run.started is missing configRef".to_string(),
                    details: serde_json::json!({ "runId": run_id, "sessionId": session_id }),
                }
            })?)
            .map_err(|error| KernelError::Structured {
                code: "run_recovery_schema_invalid",
                stage: "run.restore",
                message: format!("decode configRef: {error}"),
                details: serde_json::json!({ "runId": run_id, "sessionId": session_id }),
            })?;
        Ok(Some(RuntimeRunRecord {
            session_id: session_id.to_string(),
            run_id,
            attachments: started
                .payload
                .get("attachments")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            workspace_binding,
            config_ref,
            lifecycle_state,
        }))
    }

    pub(crate) fn ensure_session_restored(&mut self, session_id: &str) -> KernelResult<()> {
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
        self.restore_run_resources_from_ledger(&record.run_id)?;

        if record.lifecycle_state == RuntimeLifecycleState::Terminal {
            let owner = KernelResourceOwner::agent_run(None::<String>, record.run_id.clone());
            let active_resources = self.state.resource_manager.active_by_owner(&owner);
            if !active_resources.is_empty() {
                return Err(KernelError::Structured {
                    code: "run_recovery_schema_invalid",
                    stage: "run.restore",
                    message: "terminal run still owns active resources".to_string(),
                    details: serde_json::json!({
                        "runId": record.run_id,
                        "sessionId": record.session_id,
                        "resourceIds": active_resources
                            .iter()
                            .map(|resource| resource.resource_id.clone())
                            .collect::<Vec<_>>(),
                    }),
                });
            }
            self.state.cleanup_checkpoints_by_run.remove(&record.run_id);
            self.state
                .records_by_session
                .insert(session_id.to_string(), record);
            return Ok(());
        }

        if record.lifecycle_state != RuntimeLifecycleState::Terminating
            && matches!(
                self.state.cleanup_state_by_run.get(&record.run_id),
                Some(KernelCleanupState::Completed)
            )
        {
            self.state.cleanup_checkpoints_by_run.remove(&record.run_id);
        }
        self.restore_plan_authorization_from_ledger(&record.run_id)?;
        self.restore_execution_contracts_from_ledger(&record.run_id)?;
        self.restore_batch_checkpoint_from_ledger(&record.run_id)?;
        self.restore_artifact_drafts_from_ledger(&record.run_id)?;
        for (permission_id, pending) in self.pending_tools_from_ledger(&record.run_id)? {
            self.state.pending_tools.insert(permission_id, pending);
        }
        self.state
            .records_by_session
            .insert(session_id.to_string(), record);
        Ok(())
    }

    pub(crate) fn append_ledger(
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

    pub(crate) fn append_ledger_batch(&self, events: Vec<LedgerEvent>) -> KernelResult<()> {
        self.ledger.append_batch(events)
    }

    pub(crate) fn record_by_run(&self, run_id: &str) -> KernelResult<RuntimeRunRecord> {
        self.state
            .records_by_session
            .values()
            .find(|record| record.run_id == run_id)
            .cloned()
            .ok_or_else(|| KernelError::InvalidCommand(format!("run {run_id} is not active")))
    }

    pub(crate) fn record_by_run_mut(
        &mut self,
        run_id: &str,
    ) -> KernelResult<&mut RuntimeRunRecord> {
        self.state
            .records_by_session
            .values_mut()
            .find(|record| record.run_id == run_id)
            .ok_or_else(|| KernelError::InvalidCommand(format!("run {run_id} is not active")))
    }

    pub(crate) fn resolve_run_session(
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
        Err(KernelError::Structured {
            code: "run_identity_required",
            stage: "run.resolve",
            message: "Kernel command requires runId or sessionId".to_string(),
            details: serde_json::json!({}),
        })
    }

    pub(crate) fn snapshot_get(
        &self,
        request_id: RequestId,
        session_id: Option<SessionId>,
    ) -> KernelResult<Vec<KernelEvent>> {
        Ok(vec![KernelEvent::SnapshotReady {
            request_id,
            snapshot: self.snapshot(session_id.as_ref().map(|value| value.0.as_str())),
        }])
    }

    pub(crate) fn resolve_minimal_config(
        &self,
        run_id: &str,
        profile_id: Option<String>,
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
                "policy": { "profile": profile_id.unwrap_or_else(|| self.policy_profile.id.clone()) }
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
}

pub(crate) fn normalized_explicit_attachment_grant(attachment: &Value) -> Option<Value> {
    let source = attachment
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(source, "userSelected" | "contextMenu" | "mention") {
        return None;
    }
    let kind = attachment
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("file");
    if !matches!(kind, "file" | "directory") {
        return None;
    }
    let absolute_path = attachment
        .get("absolutePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let canonical_path = PathBuf::from(absolute_path).canonicalize().ok()?;
    let metadata = std::fs::metadata(&canonical_path).ok()?;
    if kind == "file" && !metadata.is_file() {
        return None;
    }
    if kind == "directory" && !metadata.is_dir() {
        return None;
    }

    let mut grant = attachment.clone();
    let object = grant.as_object_mut()?;
    object.insert("kind".to_string(), Value::String(kind.to_string()));
    object.insert("source".to_string(), Value::String(source.to_string()));
    object.insert(
        "absolutePath".to_string(),
        Value::String(canonical_path.to_string_lossy().to_string()),
    );
    Some(grant)
}

pub(crate) fn run_index_from_id(run_id: &str) -> Option<u64> {
    run_id.strip_prefix("run-")?.parse::<u64>().ok()
}

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}
