use deepcode_kernel_abi::KernelError;
use deepcode_kernel_abi::KernelResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConfigSnapshot {
    pub run_id: String,
    pub effective_config_hash: String,
    pub config_sources: Vec<String>,
    pub policy_profile: Option<String>,
    pub workflow_pack: Option<String>,
    pub prompt_profile: Option<String>,
    pub locale: Option<String>,
    pub skill_packs: Vec<String>,
    pub workspace_binding_hash: Option<String>,
}

pub trait EventLedger {
    fn append(&self, event: LedgerEvent) -> KernelResult<()>;
    fn list_by_run(&self, run_id: &str) -> KernelResult<Vec<LedgerEvent>>;
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
        let events = self.events.lock().expect("ledger lock");
        Ok(events
            .iter()
            .filter(|event| event.run_id.as_deref() == Some(run_id))
            .filter_map(|event| event.sequence)
            .max()
            .unwrap_or(0)
            + 1)
    }
}

impl EventLedger for InMemoryEventLedger {
    fn append(&self, event: LedgerEvent) -> KernelResult<()> {
        self.events.lock().expect("ledger lock").push(event);
        Ok(())
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

    pub fn resume_snapshot(&self, run_id: &str) -> KernelResult<Option<WorkflowCheckpoint>> {
        let mut checkpoints = self
            .list_by_run(run_id)?
            .into_iter()
            .filter(|event| event.kind == "workflow.checkpointed")
            .filter_map(|event| serde_json::from_value::<WorkflowCheckpoint>(event.payload).ok())
            .collect::<Vec<_>>();
        checkpoints.sort_by_key(|checkpoint| checkpoint.sequence);
        Ok(checkpoints.pop())
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

    fn list_by_run(&self, run_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        let mut events = self
            .replay_all()?
            .into_iter()
            .filter(|event| event.run_id.as_deref() == Some(run_id))
            .collect::<Vec<_>>();
        events.sort_by_key(|event| event.sequence.unwrap_or_default());
        Ok(events)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCheckpoint {
    pub run_id: String,
    pub session_id: String,
    pub phase: String,
    pub sequence: u64,
    pub pending_permission_id: Option<String>,
    pub active_work_unit_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkUnitScopeKind {
    File,
    Directory,
    Range,
    DocSection,
    Symbol,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnitOwner {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkUnitStatus {
    Queued,
    Running,
    WaitingReview,
    Completed,
    Blocked,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnit {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub status: WorkUnitStatus,
    pub scope_kind: WorkUnitScopeKind,
    pub path: String,
    pub owner: Option<WorkUnitOwner>,
    pub change_set_id: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewGateStatus {
    Accepted,
    NeedsReplan,
    NeedsUserReview,
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewGateResult {
    pub id: String,
    pub run_id: String,
    pub status: ReviewGateStatus,
    pub summary: String,
    pub evidence_refs: Vec<String>,
    pub change_set_id: Option<String>,
    pub validation_result_ids: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct WorkUnitQueue {
    active_owners: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TempArtifactKind {
    CheckOutput,
    AgentTemp,
    TerminalOutput,
    ManagedReferenceCopy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempArtifact {
    pub id: String,
    pub run_id: String,
    pub path: String,
    pub kind: TempArtifactKind,
    pub cleaned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempArtifactCleanupResult {
    pub artifact_id: String,
    pub path: String,
    pub cleaned: bool,
    pub error: Option<String>,
}

#[derive(Debug)]
pub struct TempArtifactRegistry {
    root: PathBuf,
    artifacts: Mutex<BTreeMap<String, TempArtifact>>,
}

impl TempArtifactRegistry {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            artifacts: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn create_file(
        &self,
        run_id: &str,
        relative_path: &str,
        kind: TempArtifactKind,
        content: &[u8],
    ) -> KernelResult<TempArtifact> {
        let full_path = self.safe_join(relative_path)?;
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                KernelError::Other(format!("create temp artifact directory failed: {error}"))
            })?;
        }
        fs::write(&full_path, content)
            .map_err(|error| KernelError::Other(format!("write temp artifact failed: {error}")))?;
        self.register_path(run_id, relative_path, kind)
    }

    pub fn register_path(
        &self,
        run_id: &str,
        relative_path: &str,
        kind: TempArtifactKind,
    ) -> KernelResult<TempArtifact> {
        let full_path = self.safe_join(relative_path)?;
        let artifact = TempArtifact {
            id: format!(
                "temp-{run_id}-{}",
                self.artifacts.lock().expect("temp lock").len() + 1
            ),
            run_id: run_id.to_string(),
            path: full_path.to_string_lossy().to_string(),
            kind,
            cleaned: false,
        };
        self.artifacts
            .lock()
            .expect("temp lock")
            .insert(artifact.id.clone(), artifact.clone());
        Ok(artifact)
    }

    pub fn guard<'a>(
        &'a self,
        run_id: &str,
        relative_path: &str,
        kind: TempArtifactKind,
        content: &[u8],
    ) -> KernelResult<TempArtifactGuard<'a>> {
        let artifact = self.create_file(run_id, relative_path, kind, content)?;
        Ok(TempArtifactGuard {
            registry: self,
            artifact_id: artifact.id,
        })
    }

    pub fn clean_artifact(&self, artifact_id: &str) -> KernelResult<TempArtifactCleanupResult> {
        let mut artifacts = self.artifacts.lock().expect("temp lock");
        let artifact = artifacts.get_mut(artifact_id).ok_or_else(|| {
            KernelError::PermissionDenied(format!(
                "refusing to clean unregistered temp artifact {artifact_id}"
            ))
        })?;
        let path = PathBuf::from(&artifact.path);
        let result = match fs::remove_file(&path) {
            Ok(()) => TempArtifactCleanupResult {
                artifact_id: artifact.id.clone(),
                path: artifact.path.clone(),
                cleaned: true,
                error: None,
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                TempArtifactCleanupResult {
                    artifact_id: artifact.id.clone(),
                    path: artifact.path.clone(),
                    cleaned: true,
                    error: None,
                }
            }
            Err(error) => TempArtifactCleanupResult {
                artifact_id: artifact.id.clone(),
                path: artifact.path.clone(),
                cleaned: false,
                error: Some(error.to_string()),
            },
        };
        artifact.cleaned = result.cleaned;
        if result.cleaned {
            artifacts.remove(artifact_id);
        }
        Ok(result)
    }

    pub fn clean_run(&self, run_id: &str) -> KernelResult<Vec<TempArtifactCleanupResult>> {
        let ids = self
            .artifacts
            .lock()
            .expect("temp lock")
            .values()
            .filter(|artifact| artifact.run_id == run_id)
            .map(|artifact| artifact.id.clone())
            .collect::<Vec<_>>();
        ids.into_iter()
            .map(|id| self.clean_artifact(&id))
            .collect::<KernelResult<Vec<_>>>()
    }

    pub fn clean_unregistered_path(&self, _path: &Path) -> KernelResult<()> {
        Err(KernelError::PermissionDenied(
            "refusing to clean an unregistered temp artifact path".to_string(),
        ))
    }

    fn safe_join(&self, relative_path: &str) -> KernelResult<PathBuf> {
        let path = Path::new(relative_path);
        if path.is_absolute()
            || path
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(KernelError::PermissionDenied(
                "temp artifact path must stay under .deepcode/tmp".to_string(),
            ));
        }
        Ok(self.root.join(path))
    }
}

pub struct TempArtifactGuard<'a> {
    registry: &'a TempArtifactRegistry,
    artifact_id: String,
}

impl Drop for TempArtifactGuard<'_> {
    fn drop(&mut self) {
        let _ = self.registry.clean_artifact(&self.artifact_id);
    }
}

impl WorkUnitQueue {
    pub fn claim(&mut self, path: &str, owner_id: &str) -> KernelResult<()> {
        if let Some(existing) = self.active_owners.get(path) {
            if existing != owner_id {
                return Err(KernelError::PermissionDenied(format!(
                    "work unit path {path} is already owned by {existing}"
                )));
            }
        }
        self.active_owners
            .insert(path.to_string(), owner_id.to_string());
        Ok(())
    }

    pub fn release(&mut self, path: &str, owner_id: &str) -> KernelResult<()> {
        if self
            .active_owners
            .get(path)
            .map(|existing| existing == owner_id)
            .unwrap_or(false)
        {
            self.active_owners.remove(path);
            return Ok(());
        }
        Err(KernelError::PermissionDenied(format!(
            "work unit path {path} is not owned by {owner_id}"
        )))
    }
}

#[derive(Debug, Clone, Default)]
pub struct ReviewGate;

impl ReviewGate {
    pub fn evaluate(
        &self,
        run_id: &str,
        change_set: Option<&ChangeSet>,
        validations: &[ValidationResult],
        evidence_refs: Vec<String>,
    ) -> ReviewGateResult {
        let failed = validations.iter().find(|validation| !validation.passed);
        let status = if failed.is_some() {
            ReviewGateStatus::NeedsReplan
        } else if change_set.is_none() || evidence_refs.is_empty() {
            ReviewGateStatus::NeedsUserReview
        } else {
            ReviewGateStatus::Accepted
        };

        let summary = match status {
            ReviewGateStatus::Accepted => "Review gate accepted.".to_string(),
            ReviewGateStatus::NeedsReplan => "Validation failed; replan required.".to_string(),
            ReviewGateStatus::NeedsUserReview => {
                "Review gate needs evidence or user review.".to_string()
            }
            ReviewGateStatus::Aborted => "Review gate aborted.".to_string(),
        };

        ReviewGateResult {
            id: format!("review-{run_id}"),
            run_id: run_id.to_string(),
            status,
            summary,
            evidence_refs,
            change_set_id: change_set.map(|value| value.id.clone()),
            validation_result_ids: validations
                .iter()
                .map(|validation| validation.id.clone())
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("deepcode-{name}-{nonce}"))
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
    fn ndjson_ledger_appends_replays_and_resumes_checkpoint() {
        let root = temp_root("ledger");
        let ledger_path = root.join("events.ndjson");
        let ledger = NdjsonEventLedger::new(&ledger_path);
        ledger.append(event("evt-1", "run-1", 1)).unwrap();
        ledger
            .append(LedgerEvent {
                id: "evt-checkpoint".to_string(),
                run_id: Some("run-1".to_string()),
                session_id: Some("session-1".to_string()),
                kind: "workflow.checkpointed".to_string(),
                sequence: Some(2),
                payload: serde_json::to_value(WorkflowCheckpoint {
                    run_id: "run-1".to_string(),
                    session_id: "session-1".to_string(),
                    phase: "complete".to_string(),
                    sequence: 2,
                    pending_permission_id: None,
                    active_work_unit_ids: vec!["unit-1".to_string()],
                })
                .unwrap(),
                created_at: None,
            })
            .unwrap();
        ledger.append(event("evt-2", "run-2", 1)).unwrap();

        let run_events = ledger.list_by_run("run-1").unwrap();
        assert_eq!(run_events.len(), 2);
        assert_eq!(run_events[1].kind, "workflow.checkpointed");

        let checkpoint = ledger.resume_snapshot("run-1").unwrap().unwrap();
        assert_eq!(checkpoint.phase, "complete");
        assert_eq!(checkpoint.active_work_unit_ids, vec!["unit-1"]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn work_unit_owner_conflict_fails_closed() {
        let mut queue = WorkUnitQueue::default();
        queue.claim("src/main.rs", "unit-a").unwrap();
        let error = queue.claim("src/main.rs", "unit-b").unwrap_err();
        assert!(matches!(error, KernelError::PermissionDenied(_)));
        queue.release("src/main.rs", "unit-a").unwrap();
        queue.claim("src/main.rs", "unit-b").unwrap();
    }

    #[test]
    fn change_set_collects_touched_files() {
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

    #[test]
    fn review_gate_rejects_failed_validation() {
        let gate = ReviewGate;
        let change_set = ChangeSet::from_operations("cs-1", "run-1", Vec::new());
        let validation = ValidationResult {
            id: "val-1".to_string(),
            run_id: "run-1".to_string(),
            kind: ValidationKind::Test,
            passed: false,
            summary: "tests failed".to_string(),
            evidence_refs: vec!["evt-1".to_string()],
        };

        let result = gate.evaluate(
            "run-1",
            Some(&change_set),
            &[validation],
            vec!["evt-2".to_string()],
        );

        assert_eq!(result.status, ReviewGateStatus::NeedsReplan);
    }

    #[test]
    fn review_gate_accepts_only_with_changes_validation_and_evidence() {
        let gate = ReviewGate;
        let change_set = ChangeSet::from_operations(
            "cs-1",
            "run-1",
            vec![ChangeOperation {
                id: "op-1".to_string(),
                work_unit_id: Some("unit-1".to_string()),
                kind: "write".to_string(),
                file_path: "src/main.rs".to_string(),
                diff: Some("+change".to_string()),
            }],
        );
        let validation = ValidationResult {
            id: "val-1".to_string(),
            run_id: "run-1".to_string(),
            kind: ValidationKind::Test,
            passed: true,
            summary: "tests passed".to_string(),
            evidence_refs: vec!["evt-1".to_string()],
        };

        let missing_evidence =
            gate.evaluate("run-1", Some(&change_set), &[validation.clone()], vec![]);
        assert_eq!(missing_evidence.status, ReviewGateStatus::NeedsUserReview);

        let accepted = gate.evaluate(
            "run-1",
            Some(&change_set),
            &[validation],
            vec!["evt-2".to_string()],
        );
        assert_eq!(accepted.status, ReviewGateStatus::Accepted);
    }

    #[test]
    fn temp_artifact_registry_cleans_registered_paths_only() {
        let root = temp_root("tmp-registry").join(".deepcode/tmp");
        let registry = TempArtifactRegistry::new(&root);
        let artifact = registry
            .create_file(
                "run-1",
                "runs/run-1/terminal-output-1.txt",
                TempArtifactKind::TerminalOutput,
                b"terminal output",
            )
            .unwrap();

        assert!(Path::new(&artifact.path).exists());
        let result = registry.clean_artifact(&artifact.id).unwrap();
        assert!(result.cleaned);
        assert!(!Path::new(&artifact.path).exists());

        let unregistered = root.join("runs/run-1/unregistered.txt");
        let error = registry.clean_unregistered_path(&unregistered).unwrap_err();
        assert!(matches!(error, KernelError::PermissionDenied(_)));

        let traversal = registry
            .create_file("run-1", "../outside.txt", TempArtifactKind::AgentTemp, b"x")
            .unwrap_err();
        assert!(matches!(traversal, KernelError::PermissionDenied(_)));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn temp_artifact_guard_cleans_on_drop() {
        let root = temp_root("tmp-guard").join(".deepcode/tmp");
        let path = root.join("runs/run-1/_agent_tmp_test.txt");
        {
            let registry = TempArtifactRegistry::new(&root);
            let _guard = registry
                .guard(
                    "run-1",
                    "runs/run-1/_agent_tmp_test.txt",
                    TempArtifactKind::AgentTemp,
                    b"temporary",
                )
                .unwrap();
            assert!(path.exists());
        }
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }
}
