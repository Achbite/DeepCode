use deepcode_kernel_abi::{KernelError, KernelResult};
pub use deepcode_kernel_abi::{
    KernelResource, KernelResourceCleanupPolicy, KernelResourceIdentity, KernelResourceKind,
    KernelResourceMetadata, KernelResourceOwner, KernelResourceOwnerKind,
    KernelResourceReleaseResult, KernelResourceScope, KernelResourceState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

mod resources;

pub use resources::{KernelResourceAcquireBatchResult, KernelResourceManager};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEvent {
    pub id: String,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub kind: String,
    pub sequence: Option<u64>,
    pub payload: Value,
    pub created_at: Option<String>,
}

pub trait EventLedger: Send + Sync {
    fn append(&self, event: LedgerEvent) -> KernelResult<()>;
    fn append_batch(&self, events: Vec<LedgerEvent>) -> KernelResult<()>;
    fn list_all(&self) -> KernelResult<Vec<LedgerEvent>>;
    fn list_by_run(&self, run_id: &str) -> KernelResult<Vec<LedgerEvent>>;
    fn list_by_session(&self, session_id: &str) -> KernelResult<Vec<LedgerEvent>>;

    fn next_sequence(&self, run_id: &str) -> KernelResult<u64> {
        Ok(self
            .list_by_run(run_id)?
            .into_iter()
            .filter_map(|event| event.sequence)
            .max()
            .unwrap_or(0)
            + 1)
    }
}

#[derive(Debug, Default)]
pub struct InMemoryEventLedger {
    events: Mutex<Vec<LedgerEvent>>,
}

impl InMemoryEventLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn all(&self) -> KernelResult<Vec<LedgerEvent>> {
        Ok(self.events.lock().expect("ledger lock").clone())
    }

    pub fn next_sequence(&self, run_id: &str) -> KernelResult<u64> {
        EventLedger::next_sequence(self, run_id)
    }
}

impl EventLedger for InMemoryEventLedger {
    fn append(&self, event: LedgerEvent) -> KernelResult<()> {
        self.events.lock().expect("ledger lock").push(event);
        Ok(())
    }

    fn append_batch(&self, events: Vec<LedgerEvent>) -> KernelResult<()> {
        self.events.lock().expect("ledger lock").extend(events);
        Ok(())
    }

    fn list_all(&self) -> KernelResult<Vec<LedgerEvent>> {
        self.all()
    }

    fn list_by_run(&self, run_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        Ok(self
            .events
            .lock()
            .expect("ledger lock")
            .iter()
            .filter(|event| event.run_id.as_deref() == Some(run_id))
            .cloned()
            .collect())
    }

    fn list_by_session(&self, session_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        Ok(self
            .events
            .lock()
            .expect("ledger lock")
            .iter()
            .filter(|event| event.session_id.as_deref() == Some(session_id))
            .cloned()
            .collect())
    }
}

#[derive(Debug, Clone)]
pub struct NdjsonEventLedger {
    path: PathBuf,
}

impl NdjsonEventLedger {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn replay_all(&self) -> KernelResult<Vec<LedgerEvent>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let file = File::open(&self.path)
            .map_err(|error| KernelError::Other(format!("open ledger failed: {error}")))?;
        let mut events = Vec::new();
        for line in BufReader::new(file).lines() {
            let line =
                line.map_err(|error| KernelError::Other(format!("read ledger failed: {error}")))?;
            if line.trim().is_empty() {
                continue;
            }
            events.push(serde_json::from_str::<LedgerEvent>(&line).map_err(|error| {
                KernelError::Other(format!("decode ledger event failed: {error}"))
            })?);
        }
        Ok(events)
    }
}

impl EventLedger for NdjsonEventLedger {
    fn append(&self, event: LedgerEvent) -> KernelResult<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                KernelError::Other(format!("create ledger directory failed: {error}"))
            })?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| KernelError::Other(format!("open ledger append failed: {error}")))?;
        let encoded = serde_json::to_string(&event)
            .map_err(|error| KernelError::Other(format!("encode ledger event failed: {error}")))?;
        writeln!(file, "{encoded}")
            .map_err(|error| KernelError::Other(format!("write ledger event failed: {error}")))
    }

    fn append_batch(&self, events: Vec<LedgerEvent>) -> KernelResult<()> {
        if events.is_empty() {
            return Ok(());
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                KernelError::Other(format!("create ledger directory failed: {error}"))
            })?;
        }
        let mut encoded = Vec::new();
        for event in events {
            serde_json::to_writer(&mut encoded, &event).map_err(|error| {
                KernelError::Other(format!("encode ledger event failed: {error}"))
            })?;
            encoded.push(b'\n');
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| KernelError::Other(format!("open ledger append failed: {error}")))?;
        file.write_all(&encoded).map_err(|error| {
            KernelError::Other(format!("write ledger event batch failed: {error}"))
        })
    }

    fn list_all(&self) -> KernelResult<Vec<LedgerEvent>> {
        self.replay_all()
    }

    fn list_by_run(&self, run_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        let mut events = self
            .replay_all()?
            .into_iter()
            .filter(|event| event.run_id.as_deref() == Some(run_id))
            .collect::<Vec<_>>();
        events.sort_by_key(|event| event.sequence.unwrap_or_default());
        Ok(events)
    }

    fn list_by_session(&self, session_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        let mut events = self
            .replay_all()?
            .into_iter()
            .filter(|event| event.session_id.as_deref() == Some(session_id))
            .collect::<Vec<_>>();
        events.sort_by_key(|event| event.sequence.unwrap_or_default());
        Ok(events)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeOperation {
    pub id: String,
    pub work_unit_id: Option<String>,
    pub kind: String,
    pub file_path: String,
    pub diff: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub id: String,
    pub run_id: String,
    pub operations: Vec<ChangeOperation>,
    pub touched_files: Vec<String>,
    pub diff_summary: String,
}

impl ChangeSet {
    pub fn from_operations(
        id: impl Into<String>,
        run_id: impl Into<String>,
        operations: Vec<ChangeOperation>,
    ) -> Self {
        let mut touched = BTreeSet::new();
        for operation in &operations {
            touched.insert(operation.file_path.clone());
        }
        let touched_files = touched.into_iter().collect::<Vec<_>>();
        Self {
            id: id.into(),
            run_id: run_id.into(),
            diff_summary: format!("{} file(s) changed", touched_files.len()),
            operations,
            touched_files,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ValidationKind {
    Test,
    Lint,
    Typecheck,
    Format,
    Policy,
    SecretScan,
    ManualReview,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub id: String,
    pub run_id: String,
    pub kind: ValidationKind,
    pub passed: bool,
    pub summary: String,
    pub evidence_refs: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use deepcode_kernel_abi::KernelErrorEnvelope;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn event(id: &str, run_id: &str, sequence: u64) -> LedgerEvent {
        LedgerEvent {
            id: id.to_string(),
            run_id: Some(run_id.to_string()),
            session_id: Some("session-1".to_string()),
            kind: "test.event".to_string(),
            sequence: Some(sequence),
            payload: serde_json::json!({ "id": id }),
            created_at: None,
        }
    }

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("deepcode-{label}-{nonce}"))
    }

    fn temp_artifact_metadata(path: &str) -> KernelResourceMetadata {
        KernelResourceMetadata::TempArtifact {
            path: path.to_string(),
            absolute_path: None,
            source_tool: "test.tool".to_string(),
            tool_call_id: format!("call-{path}"),
        }
    }

    fn terminal_metadata(terminal_id: &str) -> KernelResourceMetadata {
        KernelResourceMetadata::TerminalSession {
            terminal_id: terminal_id.to_string(),
            cwd: ".".to_string(),
            shell_kind: "test".to_string(),
        }
    }

    fn external_metadata(path: &str) -> KernelResourceMetadata {
        KernelResourceMetadata::ExternalResourceLease {
            lease: deepcode_kernel_abi::ExternalResourceLease {
                resource_id: format!("external-{path}"),
                root_id: format!("root-{path}"),
                canonical_path: path.to_string(),
                target_kind: deepcode_kernel_abi::ExternalResourceKind::File,
            },
        }
    }

    fn permission_metadata(target: &str) -> KernelResourceMetadata {
        KernelResourceMetadata::TemporaryPermissionGrant {
            grant_kind: deepcode_kernel_abi::TemporaryPermissionGrantKind::PlanExecution,
            grant: deepcode_kernel_abi::TemporaryGrantEnvelope {
                id: format!("grant-{target}"),
                contract_id: "contract-test".to_string(),
                operation_ids: Vec::new(),
                capability: "workspace.write".to_string(),
                resource_kind: deepcode_kernel_abi::PermissionResourceKind::WorkspacePath,
                resource_path: Some(target.to_string()),
                expires_after_sequence: None,
                reason: None,
            },
        }
    }

    #[test]
    fn kernel_resource_registry_releases_only_matching_run_owner() {
        let registry = KernelResourceManager::new();
        let run_owner = KernelResourceOwner::agent_run(Some("session-1"), "run-1");
        registry
            .acquire_batch(
                vec![KernelResource::active(
                    KernelResourceIdentity::new(
                        "res-run",
                        "temp:run-1:tmp.txt",
                        "temp:run-1:call-1:tmp.txt",
                    ),
                    KernelResourceKind::TempArtifact,
                    run_owner.clone(),
                    KernelResourceScope::Run,
                    KernelResourceCleanupPolicy::OnRunEnd,
                    temp_artifact_metadata("tmp.txt"),
                )],
                |_| Ok(()),
            )
            .unwrap();
        registry
            .acquire_batch(
                vec![KernelResource::active(
                    KernelResourceIdentity::new(
                        "res-user",
                        "terminal:session-1",
                        "terminal:session-1:instance-1",
                    ),
                    KernelResourceKind::TerminalSession,
                    KernelResourceOwner::user_session("session-1"),
                    KernelResourceScope::Session,
                    KernelResourceCleanupPolicy::OnSessionEnd,
                    terminal_metadata("term-1"),
                )],
                |_| Ok(()),
            )
            .unwrap();

        let released = registry.release_by_owner(&run_owner, |_| Ok(())).unwrap();

        assert_eq!(released.len(), 1);
        assert_eq!(
            registry.get("res-run").unwrap().state,
            KernelResourceState::Released
        );
        assert_eq!(
            registry.get("res-user").unwrap().state,
            KernelResourceState::Active
        );
        assert!(registry
            .get("res-run")
            .and_then(|resource| resource.released_at)
            .is_some_and(|value| value.parse::<u128>().is_ok()));
    }

    #[test]
    fn kernel_resource_manager_reuses_identical_active_idempotency_key() {
        let registry = KernelResourceManager::new();
        let resource = KernelResource::active(
            KernelResourceIdentity::new(
                "duplicate-resource",
                "external:input.txt",
                "external:run-1:input.txt",
            ),
            KernelResourceKind::ExternalResourceLease,
            KernelResourceOwner::agent_run(Some("session-1"), "run-1"),
            KernelResourceScope::Run,
            KernelResourceCleanupPolicy::OnRunEnd,
            external_metadata("input.txt"),
        );
        registry
            .acquire_batch(vec![resource.clone()], |_| Ok(()))
            .unwrap();
        let second = registry.acquire_batch(vec![resource], |_| Ok(())).unwrap();
        assert_eq!(second.reused_resource_ids, vec!["duplicate-resource"]);
    }

    #[test]
    fn kernel_resource_manager_rejects_terminal_idempotency_key() {
        let registry = KernelResourceManager::new();
        let resource = KernelResource::active(
            KernelResourceIdentity::new(
                "terminal-resource",
                "external:input.txt",
                "external:run-1:input.txt",
            ),
            KernelResourceKind::ExternalResourceLease,
            KernelResourceOwner::agent_run(Some("session-1"), "run-1"),
            KernelResourceScope::Run,
            KernelResourceCleanupPolicy::OnRunEnd,
            external_metadata("input.txt"),
        );
        registry
            .acquire_batch(vec![resource.clone()], |_| Ok(()))
            .unwrap();
        assert!(
            registry
                .release("terminal-resource", |_| Ok(()))
                .unwrap()
                .released
        );
        let error = registry
            .acquire_batch(vec![resource], |_| Ok(()))
            .unwrap_err();
        assert_eq!(
            KernelErrorEnvelope::from(&error).code,
            "resource_lease_terminal"
        );
    }

    #[test]
    fn kernel_resource_manager_rejects_active_idempotency_metadata_conflict() {
        let registry = KernelResourceManager::new();
        let original = KernelResource::active(
            KernelResourceIdentity::new(
                "active-resource",
                "permission:scope",
                "permission:run-1:contract-1",
            ),
            KernelResourceKind::PermissionGrant,
            KernelResourceOwner::agent_run(Some("session-1"), "run-1"),
            KernelResourceScope::Run,
            KernelResourceCleanupPolicy::OnBatchReviewReady,
            permission_metadata("first"),
        );
        registry.acquire_batch(vec![original], |_| Ok(())).unwrap();
        let conflicting = KernelResource::active(
            KernelResourceIdentity::new(
                "other-resource",
                "permission:scope",
                "permission:run-1:contract-1",
            ),
            KernelResourceKind::PermissionGrant,
            KernelResourceOwner::agent_run(Some("session-1"), "run-1"),
            KernelResourceScope::Run,
            KernelResourceCleanupPolicy::OnBatchReviewReady,
            permission_metadata("second"),
        );

        let error = registry
            .acquire_batch(vec![conflicting], |_| Ok(()))
            .unwrap_err();

        assert_eq!(
            KernelErrorEnvelope::from(&error).code,
            "resource_lease_conflict"
        );
        assert_eq!(registry.list().len(), 1);
    }

    #[test]
    fn kernel_resource_manager_batch_is_atomic_when_persistence_fails() {
        let registry = KernelResourceManager::new();
        let first = KernelResource::active(
            KernelResourceIdentity::new(
                "batch-first",
                "permission:first",
                "permission:run-1:first",
            ),
            KernelResourceKind::PermissionGrant,
            KernelResourceOwner::agent_run(Some("session-1"), "run-1"),
            KernelResourceScope::Run,
            KernelResourceCleanupPolicy::OnBatchReviewReady,
            permission_metadata("first"),
        );
        let second = KernelResource::active(
            KernelResourceIdentity::new(
                "batch-second",
                "permission:second",
                "permission:run-1:second",
            ),
            KernelResourceKind::PermissionGrant,
            KernelResourceOwner::agent_run(Some("session-1"), "run-1"),
            KernelResourceScope::Run,
            KernelResourceCleanupPolicy::OnBatchReviewReady,
            permission_metadata("second"),
        );
        let error = registry
            .acquire_batch(vec![first, second], |_| {
                Err(KernelError::Other("ledger unavailable".to_string()))
            })
            .unwrap_err();
        assert!(matches!(error, KernelError::Other(_)));
        assert!(registry.list().is_empty());
    }

    #[test]
    fn kernel_resource_manager_batch_conflict_registers_nothing_from_the_batch() {
        let registry = KernelResourceManager::new();
        let existing = KernelResource::active(
            KernelResourceIdentity::new(
                "existing-resource",
                "permission:existing",
                "permission:run-1:existing",
            ),
            KernelResourceKind::PermissionGrant,
            KernelResourceOwner::agent_run(Some("session-1"), "run-1"),
            KernelResourceScope::Run,
            KernelResourceCleanupPolicy::OnBatchReviewReady,
            permission_metadata("existing.txt"),
        );
        registry.acquire_batch(vec![existing], |_| Ok(())).unwrap();
        let new_resource = KernelResource::active(
            KernelResourceIdentity::new("new-resource", "permission:new", "permission:run-1:new"),
            KernelResourceKind::PermissionGrant,
            KernelResourceOwner::agent_run(Some("session-1"), "run-1"),
            KernelResourceScope::Run,
            KernelResourceCleanupPolicy::OnBatchReviewReady,
            permission_metadata("new.txt"),
        );
        let conflicting = KernelResource::active(
            KernelResourceIdentity::new(
                "conflicting-resource",
                "permission:existing",
                "permission:run-1:existing",
            ),
            KernelResourceKind::PermissionGrant,
            KernelResourceOwner::agent_run(Some("session-1"), "run-1"),
            KernelResourceScope::Run,
            KernelResourceCleanupPolicy::OnBatchReviewReady,
            permission_metadata("different.txt"),
        );
        let persisted = std::cell::Cell::new(false);

        let error = registry
            .acquire_batch(vec![new_resource, conflicting], |_| {
                persisted.set(true);
                Ok(())
            })
            .unwrap_err();

        assert_eq!(
            KernelErrorEnvelope::from(&error).code,
            "resource_lease_conflict"
        );
        assert!(!persisted.get());
        assert!(registry.get("new-resource").is_none());
        assert_eq!(registry.list().len(), 1);
    }

    #[test]
    fn kernel_resource_manager_release_is_atomic_when_persistence_fails() {
        let registry = KernelResourceManager::new();
        let resource = KernelResource::active(
            KernelResourceIdentity::new(
                "release-atomic",
                "permission:scope",
                "permission:run-1:release-atomic",
            ),
            KernelResourceKind::PermissionGrant,
            KernelResourceOwner::agent_run(Some("session-1"), "run-1"),
            KernelResourceScope::Run,
            KernelResourceCleanupPolicy::OnBatchReviewReady,
            permission_metadata("relative.txt"),
        );
        registry.acquire_batch(vec![resource], |_| Ok(())).unwrap();

        let error = registry
            .release("release-atomic", |_| {
                Err(KernelError::Other("ledger unavailable".to_string()))
            })
            .unwrap_err();

        assert!(matches!(error, KernelError::Other(_)));
        assert_eq!(
            registry.get("release-atomic").unwrap().state,
            KernelResourceState::Active
        );
    }

    #[test]
    fn kernel_resource_manager_restores_exact_terminal_resource_fact() {
        let registry = KernelResourceManager::new();
        let mut resource = KernelResource::active(
            KernelResourceIdentity::new(
                "restored-terminal",
                "external:input",
                "external:run-1:input",
            ),
            KernelResourceKind::ExternalResourceLease,
            KernelResourceOwner::agent_run(Some("session-1"), "run-1"),
            KernelResourceScope::Run,
            KernelResourceCleanupPolicy::OnRunEnd,
            external_metadata("input.txt"),
        );
        resource.created_at = Some("100".to_string());
        registry
            .acquire_batch(vec![resource.clone()], |_| Ok(()))
            .unwrap();
        resource.state = KernelResourceState::Released;
        resource.released_at = Some("200".to_string());

        registry.restore_released(resource).unwrap();

        let restored = registry.get("restored-terminal").unwrap();
        assert_eq!(restored.state, KernelResourceState::Released);
        assert_eq!(restored.released_at.as_deref(), Some("200"));
    }

    #[test]
    fn in_memory_ledger_appends_and_lists_by_run() {
        let ledger = InMemoryEventLedger::new();
        ledger.append(event("evt-1", "run-1", 1)).unwrap();
        ledger.append(event("evt-2", "run-2", 1)).unwrap();
        ledger.append(event("evt-3", "run-1", 2)).unwrap();

        let run_events = ledger.list_by_run("run-1").unwrap();
        assert_eq!(run_events.len(), 2);
        assert_eq!(ledger.next_sequence("run-1").unwrap(), 3);
    }

    #[test]
    fn ndjson_ledger_appends_and_replays_in_sequence_order() {
        let root = temp_root("ledger");
        let ledger_path = root.join("events.ndjson");
        let ledger = NdjsonEventLedger::new(&ledger_path);
        ledger.append(event("evt-2", "run-1", 2)).unwrap();
        ledger.append(event("evt-1", "run-1", 1)).unwrap();

        let run_events = ledger.list_by_run("run-1").unwrap();
        assert_eq!(run_events.len(), 2);
        assert_eq!(run_events[0].id, "evt-1");
        assert_eq!(run_events[1].id, "evt-2");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn change_set_collects_unique_touched_files() {
        let change_set = ChangeSet::from_operations(
            "cs-1",
            "run-1",
            vec![
                ChangeOperation {
                    id: "op-1".to_string(),
                    work_unit_id: None,
                    kind: "write".to_string(),
                    file_path: "a.rs".to_string(),
                    diff: None,
                },
                ChangeOperation {
                    id: "op-2".to_string(),
                    work_unit_id: None,
                    kind: "edit".to_string(),
                    file_path: "a.rs".to_string(),
                    diff: None,
                },
            ],
        );

        assert_eq!(change_set.touched_files, vec!["a.rs"]);
    }
}
