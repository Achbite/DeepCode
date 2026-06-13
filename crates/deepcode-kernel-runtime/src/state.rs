use deepcode_kernel_abi::{
    ConfigSnapshotRef, ProfileRef, TemporaryGrantEnvelope, WorkspaceBinding,
};
use deepcode_kernel_ledger::{ChangeOperation, KernelResourceRegistry, ValidationResult};
use deepcode_kernel_workflow::{RunDecisionState, WorkflowPhase};
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
    pub(crate) approved_tools_by_run: BTreeMap<String, Vec<KernelLlmToolCall>>,
    pub(crate) temporary_grants_by_run: BTreeMap<String, Vec<TemporaryGrantEnvelope>>,
    pub(crate) change_operations_by_run: BTreeMap<String, Vec<ChangeOperation>>,
    pub(crate) validations_by_run: BTreeMap<String, Vec<ValidationResult>>,
    pub(crate) skill_trust_records: Vec<SkillTrustRecord>,
    pub(crate) mcp_risk_acknowledgments: Vec<Value>,
    pub(crate) resource_registry: KernelResourceRegistry,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeWorkspace {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) source: WorkspaceSource,
    pub(crate) source_path: Option<PathBuf>,
    pub(crate) root: PathBuf,
    pub(crate) original_folder_path: String,
    pub(crate) folder_is_absolute: bool,
    pub(crate) settings: Value,
    pub(crate) unsupported_fields: Vec<Value>,
    pub(crate) opened_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceSource {
    Directory,
    CodeWorkspace,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeRunRecord {
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) input_text: String,
    pub(crate) attachments: Vec<Value>,
    pub(crate) workspace_binding: WorkspaceBinding,
    pub(crate) config_ref: ConfigSnapshotRef,
    pub(crate) profile_ref: Option<ProfileRef>,
    pub(crate) phase: WorkflowPhase,
    pub(crate) active_llm_call_id: Option<String>,
    pub(crate) llm_call_index: u64,
    pub(crate) decision_state: RunDecisionState,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingKernelTool {
    pub(crate) run_id: String,
    pub(crate) session_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) tool_name: String,
    pub(crate) arguments: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct KernelLlmToolCall {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) arguments: Value,
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

    pub(crate) fn runtime_record_for_snapshot(
        &self,
        session_id: Option<&str>,
    ) -> Option<RuntimeRunRecord> {
        session_id
            .and_then(|id| self.state.records_by_session.get(id).cloned())
            .or_else(|| {
                session_id.and_then(|id| self.runtime_record_from_session_ledger(id).ok().flatten())
            })
            .or_else(|| self.state.records_by_session.values().last().cloned())
            .or_else(|| self.runtime_record_from_latest_ledger().ok().flatten())
    }

    pub(crate) fn runtime_record_from_latest_ledger(
        &self,
    ) -> KernelResult<Option<RuntimeRunRecord>> {
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

    pub(crate) fn runtime_record_from_session_ledger(
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
            attachments: started
                .payload
                .get("attachments")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            workspace_binding,
            config_ref,
            profile_ref,
            phase,
            active_llm_call_id: None,
            llm_call_index,
            decision_state: RunDecisionState::default(),
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

    pub(crate) fn restore_workspace_from_open_path(&mut self, open_path: &str) -> KernelResult<()> {
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

    pub fn grant_explicit_attachments_for_run(
        &mut self,
        run_id: &str,
        attachments: &[Value],
    ) -> KernelResult<usize> {
        let grants = attachments
            .iter()
            .filter_map(normalized_explicit_attachment_grant)
            .collect::<Vec<_>>();
        if grants.is_empty() {
            return Ok(0);
        }

        let record = self.record_by_run_mut(run_id)?;
        let mut existing = record
            .attachments
            .iter()
            .filter_map(explicit_attachment_grant_key)
            .collect::<BTreeSet<_>>();
        let mut added = 0_usize;
        for grant in grants {
            let Some(key) = explicit_attachment_grant_key(&grant) else {
                continue;
            };
            if existing.insert(key) {
                record.attachments.push(grant);
                added += 1;
            }
        }
        Ok(added)
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
        self.state
            .records_by_session
            .iter()
            .next_back()
            .map(|(session_id, record)| (record.run_id.clone(), session_id.clone()))
            .ok_or_else(|| KernelError::InvalidCommand("no active run".to_string()))
    }

    pub(crate) fn not_implemented(
        &self,
        _request_id: RequestId,
        operation: &'static str,
    ) -> KernelResult<Vec<KernelEvent>> {
        Err(KernelError::NotImplemented(operation))
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
}

fn normalized_explicit_attachment_grant(attachment: &Value) -> Option<Value> {
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

fn explicit_attachment_grant_key(attachment: &Value) -> Option<String> {
    let source = attachment.get("source").and_then(Value::as_str)?;
    let kind = attachment.get("kind").and_then(Value::as_str)?;
    let absolute_path = attachment.get("absolutePath").and_then(Value::as_str)?;
    Some(format!("{source}\u{1f}{kind}\u{1f}{absolute_path}"))
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
