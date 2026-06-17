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

pub trait EventLedger: Send + Sync {
    fn append(&self, event: LedgerEvent) -> KernelResult<()>;
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
pub enum TempArtifactScope {
    Run,
    Session,
    Persistent,
}

impl Default for TempArtifactScope {
    fn default() -> Self {
        Self::Run
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TempArtifactLeaseState {
    Active,
    Released,
    Promoted,
    Orphaned,
}

impl Default for TempArtifactLeaseState {
    fn default() -> Self {
        Self::Active
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempArtifactCondition {
    pub r#type: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempArtifactLeaseStatus {
    pub state: TempArtifactLeaseState,
    pub conditions: Vec<TempArtifactCondition>,
}

impl Default for TempArtifactLeaseStatus {
    fn default() -> Self {
        Self {
            state: TempArtifactLeaseState::Active,
            conditions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempArtifact {
    pub id: String,
    pub run_id: String,
    pub path: String,
    pub kind: TempArtifactKind,
    pub cleaned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<String>,
    #[serde(default)]
    pub scope: TempArtifactScope,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub status: TempArtifactLeaseStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempArtifactLease {
    pub lease_id: String,
    pub artifact_id: String,
    pub run_id: String,
    pub path: String,
    pub scope: TempArtifactScope,
    pub required: bool,
    pub status: TempArtifactLeaseStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempArtifactCleanupResult {
    pub artifact_id: String,
    pub path: String,
    pub cleaned: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelResourceKind {
    TerminalSession,
    TempArtifact,
    Artifact,
    RedirectOutput,
    CacheFile,
    ProcessHandle,
    GitHandle,
    BrowserHandle,
    NetworkHandle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelResourceOwnerKind {
    UserSession,
    AgentWorkflow,
    KernelInternal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelResourceOwner {
    pub kind: KernelResourceOwnerKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

impl KernelResourceOwner {
    pub fn user_session(session_id: impl Into<String>) -> Self {
        Self {
            kind: KernelResourceOwnerKind::UserSession,
            session_id: Some(session_id.into()),
            workflow_id: None,
            run_id: None,
        }
    }

    pub fn agent_workflow(
        session_id: Option<impl Into<String>>,
        workflow_id: impl Into<String>,
    ) -> Self {
        let workflow_id = workflow_id.into();
        Self {
            kind: KernelResourceOwnerKind::AgentWorkflow,
            session_id: session_id.map(Into::into),
            workflow_id: Some(workflow_id.clone()),
            run_id: Some(workflow_id),
        }
    }

    pub fn kernel_internal(run_id: Option<impl Into<String>>) -> Self {
        Self {
            kind: KernelResourceOwnerKind::KernelInternal,
            session_id: None,
            workflow_id: None,
            run_id: run_id.map(Into::into),
        }
    }

    fn matches(&self, other: &Self) -> bool {
        self.kind == other.kind
            && optional_match(self.session_id.as_deref(), other.session_id.as_deref())
            && optional_match(self.workflow_id.as_deref(), other.workflow_id.as_deref())
            && optional_match(self.run_id.as_deref(), other.run_id.as_deref())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelResourceScope {
    Workflow,
    Session,
    Persistent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelResourceState {
    Active,
    Released,
    Orphaned,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelResourceCleanupPolicy {
    OnWorkflowEnd,
    OnSessionEnd,
    OnRuntimeDrop,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelResource {
    pub resource_id: String,
    pub kind: KernelResourceKind,
    pub owner: KernelResourceOwner,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub scope: KernelResourceScope,
    pub state: KernelResourceState,
    pub cleanup_policy: KernelResourceCleanupPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released_at: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

impl KernelResource {
    pub fn active(
        resource_id: impl Into<String>,
        kind: KernelResourceKind,
        owner: KernelResourceOwner,
        scope: KernelResourceScope,
        cleanup_policy: KernelResourceCleanupPolicy,
        metadata: Value,
    ) -> Self {
        let session_id = owner.session_id.clone();
        let workflow_id = owner.workflow_id.clone();
        let run_id = owner.run_id.clone();
        Self {
            resource_id: resource_id.into(),
            kind,
            owner,
            session_id,
            workflow_id,
            run_id,
            scope,
            state: KernelResourceState::Active,
            cleanup_policy,
            created_at: None,
            released_at: None,
            metadata,
        }
    }

    pub fn denied(
        resource_id: impl Into<String>,
        kind: KernelResourceKind,
        owner: KernelResourceOwner,
        scope: KernelResourceScope,
        cleanup_policy: KernelResourceCleanupPolicy,
        metadata: Value,
    ) -> Self {
        let mut resource = Self::active(resource_id, kind, owner, scope, cleanup_policy, metadata);
        resource.state = KernelResourceState::Denied;
        resource
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelResourceReleaseResult {
    pub resource_id: String,
    pub released: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Default)]
pub struct KernelResourceRegistry {
    resources: Mutex<BTreeMap<String, KernelResource>>,
}

impl KernelResourceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, resource: KernelResource) -> KernelResult<KernelResource> {
        let mut resources = self.resources.lock().expect("resource registry lock");
        resources.insert(resource.resource_id.clone(), resource.clone());
        Ok(resource)
    }

    pub fn deny(&self, resource: KernelResource) -> KernelResult<KernelResource> {
        let mut denied = resource;
        denied.state = KernelResourceState::Denied;
        self.register(denied)
    }

    pub fn get(&self, resource_id: &str) -> Option<KernelResource> {
        self.resources
            .lock()
            .expect("resource registry lock")
            .get(resource_id)
            .cloned()
    }

    pub fn list(&self) -> Vec<KernelResource> {
        self.resources
            .lock()
            .expect("resource registry lock")
            .values()
            .cloned()
            .collect()
    }

    pub fn active_by_owner(&self, owner: &KernelResourceOwner) -> Vec<KernelResource> {
        self.resources
            .lock()
            .expect("resource registry lock")
            .values()
            .filter(|resource| {
                resource.state == KernelResourceState::Active && resource.owner.matches(owner)
            })
            .cloned()
            .collect()
    }

    pub fn release(&self, resource_id: &str) -> KernelResourceReleaseResult {
        let mut resources = self.resources.lock().expect("resource registry lock");
        let Some(resource) = resources.get_mut(resource_id) else {
            return KernelResourceReleaseResult {
                resource_id: resource_id.to_string(),
                released: false,
                error: Some("resource not found".to_string()),
            };
        };
        if resource.state == KernelResourceState::Released {
            return KernelResourceReleaseResult {
                resource_id: resource_id.to_string(),
                released: true,
                error: None,
            };
        }
        resource.state = KernelResourceState::Released;
        resource.released_at = Some("released".to_string());
        KernelResourceReleaseResult {
            resource_id: resource_id.to_string(),
            released: true,
            error: None,
        }
    }

    pub fn release_by_owner(
        &self,
        owner: &KernelResourceOwner,
    ) -> Vec<KernelResourceReleaseResult> {
        let ids = self
            .active_by_owner(owner)
            .into_iter()
            .map(|resource| resource.resource_id)
            .collect::<Vec<_>>();
        ids.into_iter().map(|id| self.release(&id)).collect()
    }
}

#[derive(Debug)]
pub struct TempArtifactRegistry {
    root: PathBuf,
    artifacts: Mutex<BTreeMap<String, TempArtifact>>,
    resources: KernelResourceRegistry,
}

impl TempArtifactRegistry {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            artifacts: Mutex::new(BTreeMap::new()),
            resources: KernelResourceRegistry::new(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn resource_registry(&self) -> &KernelResourceRegistry {
        &self.resources
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
        self.register_path_with_scope(run_id, relative_path, kind, TempArtifactScope::Run, false)
    }

    pub fn register_path_with_scope(
        &self,
        run_id: &str,
        relative_path: &str,
        kind: TempArtifactKind,
        scope: TempArtifactScope,
        required: bool,
    ) -> KernelResult<TempArtifact> {
        let full_path = self.safe_join(relative_path)?;
        let mut artifacts = self.artifacts.lock().expect("temp lock");
        let next_index = artifacts.len() + 1;
        let artifact_id = format!("temp-{run_id}-{next_index}");
        let artifact = TempArtifact {
            id: artifact_id.clone(),
            run_id: run_id.to_string(),
            path: full_path.to_string_lossy().to_string(),
            kind,
            cleaned: false,
            lease_id: Some(format!("lease-{artifact_id}")),
            scope,
            required,
            status: TempArtifactLeaseStatus::default(),
        };
        artifacts.insert(artifact.id.clone(), artifact.clone());
        self.resources.register(KernelResource::active(
            artifact.id.clone(),
            resource_kind_for_temp_artifact(&artifact.kind),
            KernelResourceOwner::agent_workflow(None::<String>, run_id.to_string()),
            resource_scope_for_temp_artifact(&artifact.scope),
            cleanup_policy_for_temp_artifact(&artifact.scope),
            serde_json::json!({
                "path": &artifact.path,
                "leaseId": &artifact.lease_id,
                "required": artifact.required
            }),
        ))?;
        Ok(artifact)
    }

    pub fn acquire_lease(
        &self,
        run_id: &str,
        relative_path: &str,
        kind: TempArtifactKind,
        scope: TempArtifactScope,
        required: bool,
        content: Option<&[u8]>,
    ) -> KernelResult<TempArtifactLease> {
        if let Some(content) = content {
            let full_path = self.safe_join(relative_path)?;
            if let Some(parent) = full_path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    KernelError::Other(format!("create temp artifact directory failed: {error}"))
                })?;
            }
            fs::write(&full_path, content).map_err(|error| {
                KernelError::Other(format!("write temp artifact failed: {error}"))
            })?;
        }
        let artifact =
            self.register_path_with_scope(run_id, relative_path, kind, scope, required)?;
        Ok(lease_from_artifact(&artifact))
    }

    pub fn release_lease(&self, lease_id: &str) -> KernelResult<TempArtifactCleanupResult> {
        let artifact_id = self.artifact_id_for_lease(lease_id)?;
        {
            let mut artifacts = self.artifacts.lock().expect("temp lock");
            let artifact = artifacts.get_mut(&artifact_id).ok_or_else(|| {
                KernelError::PermissionDenied(format!(
                    "refusing to release unknown temp artifact lease {lease_id}"
                ))
            })?;
            artifact.status.state = TempArtifactLeaseState::Released;
            artifact.status.conditions.push(TempArtifactCondition {
                r#type: "Released".to_string(),
                status: "True".to_string(),
                reason: Some("LeaseReleaseRequested".to_string()),
                message: None,
            });
        }
        self.clean_artifact(&artifact_id)
    }

    pub fn promote_lease(
        &self,
        lease_id: &str,
        new_scope: TempArtifactScope,
    ) -> KernelResult<TempArtifactLease> {
        let mut artifacts = self.artifacts.lock().expect("temp lock");
        let artifact = artifacts
            .values_mut()
            .find(|artifact| artifact.lease_id.as_deref() == Some(lease_id))
            .ok_or_else(|| {
                KernelError::PermissionDenied(format!(
                    "refusing to promote unknown temp artifact lease {lease_id}"
                ))
            })?;
        // 单调升级约束：Run→Session→Persistent 允许，逆向降级返回 PermissionDenied。
        // 等级数值化后比较：Run=0 / Session=1 / Persistent=2。new_scope 必须 >= 当前 scope。
        let current_rank = scope_rank(&artifact.scope);
        let new_rank = scope_rank(&new_scope);
        if new_rank < current_rank {
            return Err(KernelError::PermissionDenied(format!(
                "refusing to demote temp artifact lease {lease_id} from {:?} to {new_scope:?}; lease scope can only be monotonically promoted (Run -> Session -> Persistent)",
                artifact.scope
            )));
        }
        artifact.scope = new_scope;
        artifact.status.state = TempArtifactLeaseState::Promoted;
        artifact.status.conditions.push(TempArtifactCondition {
            r#type: "Promoted".to_string(),
            status: "True".to_string(),
            reason: Some("LeasePromoted".to_string()),
            message: None,
        });
        Ok(lease_from_artifact(artifact))
    }

    pub fn reconcile_orphan_leases(&self) -> KernelResult<Vec<TempArtifactLease>> {
        let mut artifacts = self.artifacts.lock().expect("temp lock");
        let mut orphaned = Vec::new();
        for artifact in artifacts.values_mut() {
            if artifact.cleaned
                || artifact.status.state == TempArtifactLeaseState::Released
                || artifact.scope == TempArtifactScope::Persistent
            {
                continue;
            }
            artifact.status.state = TempArtifactLeaseState::Orphaned;
            artifact.status.conditions.push(TempArtifactCondition {
                r#type: "ReconcileNeeded".to_string(),
                status: "True".to_string(),
                reason: Some("RuntimeStartup".to_string()),
                message: Some(
                    "Temp artifact lease requires explicit cleanup or promotion.".to_string(),
                ),
            });
            orphaned.push(lease_from_artifact(artifact));
        }
        Ok(orphaned)
    }

    pub fn required_open_leases(&self, run_id: &str) -> KernelResult<Vec<TempArtifactLease>> {
        Ok(self
            .artifacts
            .lock()
            .expect("temp lock")
            .values()
            .filter(|artifact| {
                artifact.run_id == run_id
                    && artifact.required
                    && !artifact.cleaned
                    && artifact.scope != TempArtifactScope::Persistent
                    && artifact.status.state != TempArtifactLeaseState::Released
            })
            .map(lease_from_artifact)
            .collect())
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
            artifact.status.state = TempArtifactLeaseState::Released;
            artifact.status.conditions.push(TempArtifactCondition {
                r#type: "Cleaned".to_string(),
                status: "True".to_string(),
                reason: Some("ArtifactRemoved".to_string()),
                message: None,
            });
        }
        if result.cleaned {
            let _ = self.resources.release(artifact_id);
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
            .filter(|artifact| {
                artifact.run_id == run_id && artifact.scope == TempArtifactScope::Run
            })
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

    fn artifact_id_for_lease(&self, lease_id: &str) -> KernelResult<String> {
        self.artifacts
            .lock()
            .expect("temp lock")
            .values()
            .find(|artifact| artifact.lease_id.as_deref() == Some(lease_id))
            .map(|artifact| artifact.id.clone())
            .ok_or_else(|| {
                KernelError::PermissionDenied(format!(
                    "refusing to access unknown temp artifact lease {lease_id}"
                ))
            })
    }
}

/// 把 TempArtifactScope 映射为单调升级用的整数等级：Run=0 / Session=1 / Persistent=2。
/// promote_lease 据此约束 new_scope 必须 >= 当前 scope，禁止逆向降级。
fn optional_match(actual: Option<&str>, expected: Option<&str>) -> bool {
    expected
        .map(|expected| Some(expected) == actual)
        .unwrap_or(true)
}

fn resource_kind_for_temp_artifact(kind: &TempArtifactKind) -> KernelResourceKind {
    match kind {
        TempArtifactKind::CheckOutput | TempArtifactKind::AgentTemp => {
            KernelResourceKind::TempArtifact
        }
        TempArtifactKind::TerminalOutput => KernelResourceKind::RedirectOutput,
        TempArtifactKind::ManagedReferenceCopy => KernelResourceKind::CacheFile,
    }
}

fn resource_scope_for_temp_artifact(scope: &TempArtifactScope) -> KernelResourceScope {
    match scope {
        TempArtifactScope::Run => KernelResourceScope::Workflow,
        TempArtifactScope::Session => KernelResourceScope::Session,
        TempArtifactScope::Persistent => KernelResourceScope::Persistent,
    }
}

fn cleanup_policy_for_temp_artifact(scope: &TempArtifactScope) -> KernelResourceCleanupPolicy {
    match scope {
        TempArtifactScope::Run => KernelResourceCleanupPolicy::OnWorkflowEnd,
        TempArtifactScope::Session => KernelResourceCleanupPolicy::OnSessionEnd,
        TempArtifactScope::Persistent => KernelResourceCleanupPolicy::Manual,
    }
}

fn scope_rank(scope: &TempArtifactScope) -> u8 {
    match scope {
        TempArtifactScope::Run => 0,
        TempArtifactScope::Session => 1,
        TempArtifactScope::Persistent => 2,
    }
}

fn lease_from_artifact(artifact: &TempArtifact) -> TempArtifactLease {
    TempArtifactLease {
        lease_id: artifact
            .lease_id
            .clone()
            .unwrap_or_else(|| format!("lease-{}", artifact.id)),
        artifact_id: artifact.id.clone(),
        run_id: artifact.run_id.clone(),
        path: artifact.path.clone(),
        scope: artifact.scope.clone(),
        required: artifact.required,
        status: artifact.status.clone(),
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
        } else if evidence_refs.is_empty() {
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

    pub fn evaluate_with_temp_leases(
        &self,
        run_id: &str,
        change_set: Option<&ChangeSet>,
        validations: &[ValidationResult],
        evidence_refs: Vec<String>,
        temp_leases: &[TempArtifactLease],
    ) -> ReviewGateResult {
        let open_required_leases = temp_leases
            .iter()
            .filter(|lease| {
                lease.required
                    && lease.scope != TempArtifactScope::Persistent
                    && lease.status.state != TempArtifactLeaseState::Released
            })
            .collect::<Vec<_>>();
        if !open_required_leases.is_empty() {
            return ReviewGateResult {
                id: format!("review-{run_id}"),
                run_id: run_id.to_string(),
                status: ReviewGateStatus::NeedsUserReview,
                summary: format!(
                    "{} required temp artifact lease(s) must be released or promoted before review.",
                    open_required_leases.len()
                ),
                evidence_refs,
                change_set_id: change_set.map(|value| value.id.clone()),
                validation_result_ids: validations
                    .iter()
                    .map(|validation| validation.id.clone())
                    .collect(),
            };
        }

        self.evaluate(run_id, change_set, validations, evidence_refs)
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
    fn kernel_resource_registry_releases_only_matching_agent_owner() {
        let registry = KernelResourceRegistry::new();
        let agent_owner =
            KernelResourceOwner::agent_workflow(Some("session-1".to_string()), "run-1");
        registry
            .register(KernelResource::active(
                "res-agent",
                KernelResourceKind::TempArtifact,
                agent_owner.clone(),
                KernelResourceScope::Workflow,
                KernelResourceCleanupPolicy::OnWorkflowEnd,
                serde_json::json!({ "path": "tmp.txt" }),
            ))
            .unwrap();
        registry
            .register(KernelResource::active(
                "res-user",
                KernelResourceKind::TerminalSession,
                KernelResourceOwner::user_session("session-1"),
                KernelResourceScope::Session,
                KernelResourceCleanupPolicy::OnSessionEnd,
                serde_json::json!({ "terminalId": "term-1" }),
            ))
            .unwrap();

        let released = registry.release_by_owner(&agent_owner);

        assert_eq!(released.len(), 1);
        assert_eq!(
            registry.get("res-agent").unwrap().state,
            KernelResourceState::Released
        );
        assert_eq!(
            registry.get("res-user").unwrap().state,
            KernelResourceState::Active
        );
    }

    #[test]
    fn temp_artifact_registers_kernel_resource_and_clean_run_releases_it() {
        let root = temp_root("resource-registry");
        let registry = TempArtifactRegistry::new(&root);
        let artifact = registry
            .create_file(
                "run-1",
                "cache/output.txt",
                TempArtifactKind::AgentTemp,
                b"temporary output",
            )
            .unwrap();

        let resource = registry
            .resource_registry()
            .get(&artifact.id)
            .expect("kernel resource");
        assert_eq!(resource.kind, KernelResourceKind::TempArtifact);
        assert_eq!(resource.owner.kind, KernelResourceOwnerKind::AgentWorkflow);
        assert_eq!(resource.scope, KernelResourceScope::Workflow);
        assert_eq!(resource.state, KernelResourceState::Active);

        let cleaned = registry.clean_run("run-1").unwrap();

        assert_eq!(cleaned.len(), 1);
        assert_eq!(
            registry
                .resource_registry()
                .get(&artifact.id)
                .unwrap()
                .state,
            KernelResourceState::Released
        );
        assert!(!Path::new(&artifact.path).exists());
        let _ = fs::remove_dir_all(root);
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
    fn temp_artifact_lease_release_promote_and_reconcile_are_explicit() {
        let root = temp_root("tmp-lease").join(".deepcode/tmp");
        let registry = TempArtifactRegistry::new(&root);
        let lease = registry
            .acquire_lease(
                "run-1",
                "runs/run-1/_agent_tmp_lease.txt",
                TempArtifactKind::AgentTemp,
                TempArtifactScope::Run,
                true,
                Some(b"lease"),
            )
            .unwrap();
        assert!(Path::new(&lease.path).exists());
        assert!(registry.required_open_leases("run-1").unwrap().len() == 1);

        let promoted = registry
            .promote_lease(&lease.lease_id, TempArtifactScope::Persistent)
            .unwrap();
        assert_eq!(promoted.scope, TempArtifactScope::Persistent);
        assert!(registry.required_open_leases("run-1").unwrap().is_empty());

        let session_lease = registry
            .acquire_lease(
                "run-1",
                "runs/run-1/_agent_tmp_session.txt",
                TempArtifactKind::AgentTemp,
                TempArtifactScope::Session,
                true,
                Some(b"session"),
            )
            .unwrap();
        let orphaned = registry.reconcile_orphan_leases().unwrap();
        assert!(orphaned
            .iter()
            .any(|lease| lease.lease_id == session_lease.lease_id
                && lease.status.state == TempArtifactLeaseState::Orphaned));

        let cleaned = registry.release_lease(&session_lease.lease_id).unwrap();
        assert!(cleaned.cleaned);
        assert!(!Path::new(&cleaned.path).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn promote_lease_rejects_monotonic_demotion() {
        let root = temp_root("tmp-lease-demote").join(".deepcode/tmp");
        let registry = TempArtifactRegistry::new(&root);
        let lease = registry
            .acquire_lease(
                "run-1",
                "runs/run-1/_agent_tmp_demote.txt",
                TempArtifactKind::AgentTemp,
                TempArtifactScope::Session,
                false,
                Some(b"demote"),
            )
            .unwrap();
        // 允许 Session -> Persistent（单调升级）。
        let promoted = registry
            .promote_lease(&lease.lease_id, TempArtifactScope::Persistent)
            .unwrap();
        assert_eq!(promoted.scope, TempArtifactScope::Persistent);
        // 禁止 Persistent -> Run（逆向降级）。
        let demote_err = registry
            .promote_lease(&lease.lease_id, TempArtifactScope::Run)
            .unwrap_err();
        match demote_err {
            KernelError::PermissionDenied(message) => {
                assert!(message.contains("monotonically promoted"));
            }
            other => panic!("expected PermissionDenied, got {other:?}"),
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn review_gate_blocks_required_open_temp_leases() {
        let gate = ReviewGate;
        let change_set = ChangeSet::from_operations(
            "cs-1",
            "run-1",
            vec![ChangeOperation {
                id: "op-1".to_string(),
                work_unit_id: None,
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
        let lease = TempArtifactLease {
            lease_id: "lease-1".to_string(),
            artifact_id: "temp-1".to_string(),
            run_id: "run-1".to_string(),
            path: ".deepcode/tmp/runs/run-1/_agent_tmp_test.txt".to_string(),
            scope: TempArtifactScope::Run,
            required: true,
            status: TempArtifactLeaseStatus::default(),
        };

        let blocked = gate.evaluate_with_temp_leases(
            "run-1",
            Some(&change_set),
            &[validation.clone()],
            vec!["evt-2".to_string()],
            &[lease],
        );
        assert_eq!(blocked.status, ReviewGateStatus::NeedsUserReview);

        let promoted = TempArtifactLease {
            lease_id: "lease-2".to_string(),
            artifact_id: "temp-2".to_string(),
            run_id: "run-1".to_string(),
            path: ".deepcode/references/ref.txt".to_string(),
            scope: TempArtifactScope::Persistent,
            required: true,
            status: TempArtifactLeaseStatus {
                state: TempArtifactLeaseState::Promoted,
                conditions: Vec::new(),
            },
        };
        let accepted = gate.evaluate_with_temp_leases(
            "run-1",
            Some(&change_set),
            &[validation],
            vec!["evt-2".to_string()],
            &[promoted],
        );
        assert_eq!(accepted.status, ReviewGateStatus::Accepted);
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
