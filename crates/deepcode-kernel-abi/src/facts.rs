use crate::{
    KernelErrorEnvelope, KernelResource, KernelResourceKind, PermissionRequestEnvelope,
    ToolFactKind, ToolOperationKind, WorkUnitDescriptor, WorkUnitStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelFactSource {
    OperationalTool,
    HostProjection,
    ContextRead,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnitFact {
    pub status: WorkUnitStatus,
    pub sequence: Option<u64>,
    pub work_unit_id: String,
    pub descriptor: Option<WorkUnitDescriptor>,
    pub summary: Option<String>,
    pub output: Option<Value>,
    pub error: Option<KernelErrorEnvelope>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolFactEnvelope {
    pub sequence: Option<u64>,
    pub tool_call_id: String,
    pub tool_id: String,
    pub operation_kind: ToolOperationKind,
    pub fact_kind: ToolFactKind,
    pub untrusted_evidence: bool,
    pub ok: bool,
    pub output: Option<Value>,
    pub error: Option<KernelErrorEnvelope>,
    pub source: KernelFactSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Create,
    Write,
    Edit,
    Delete,
    Rename,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactOrigin {
    AgentGenerated,
    UserProvided,
    ExternalEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathNormalizationFact {
    pub original_path: String,
    pub normalized_target_path: String,
    pub root_source: Option<String>,
    pub stripped_path_prefixes: Vec<String>,
    pub duplicate_root_path_detected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeFact {
    pub tool_call_id: String,
    pub tool_id: String,
    pub operation_kind: ToolOperationKind,
    pub change_kind: FileChangeKind,
    pub path: Option<String>,
    pub absolute_path: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub content_hash: Option<String>,
    pub old_content_hash: Option<String>,
    pub new_content_hash: Option<String>,
    pub changed_ranges: Vec<FileChangedRange>,
    pub artifact_origin: Option<ArtifactOrigin>,
    pub path_normalization: Option<PathNormalizationFact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangedRange {
    pub start_byte: Option<u64>,
    pub end_byte: Option<u64>,
    pub replacement_bytes: Option<u64>,
    pub start_line: Option<u64>,
    pub end_line: Option<u64>,
    pub old_start_line: Option<u64>,
    pub old_end_line: Option<u64>,
    pub new_start_line: Option<u64>,
    pub new_end_line: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedArtifactFact {
    pub tool_call_id: String,
    pub tool_id: String,
    pub operation_kind: ToolOperationKind,
    pub path: Option<String>,
    pub absolute_path: Option<String>,
    pub plan_id: Option<String>,
    pub work_unit_id: Option<String>,
    pub content_hash: Option<String>,
    pub origin: ArtifactOrigin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceLifecycleKind {
    AcquiredBatch,
    Released,
    CleanupFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLifecycleFact {
    pub kind: ResourceLifecycleKind,
    pub sequence: Option<u64>,
    pub resources: Vec<KernelResource>,
    pub reason: Option<String>,
    pub released: Option<bool>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFailureFact {
    pub sequence: Option<u64>,
    pub resource_id: String,
    pub resource_kind: Option<KernelResourceKind>,
    pub reason: Option<String>,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathNormalizationDiagnostic {
    pub tool_call_id: String,
    pub tool_id: String,
    pub path: Option<String>,
    pub absolute_path: Option<String>,
    pub normalization: PathNormalizationFact,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFacts {
    pub facts_ref: String,
    pub run_id: String,
    pub event_count: usize,
    pub work_units: Vec<WorkUnitFact>,
    pub queued_work_units: Vec<WorkUnitFact>,
    pub started_work_units: Vec<WorkUnitFact>,
    pub completed_work_units: Vec<WorkUnitFact>,
    pub failed_work_units: Vec<WorkUnitFact>,
    pub blocked_work_units: Vec<WorkUnitFact>,
    pub awaiting_permissions: Vec<PermissionRequestEnvelope>,
    pub tool_results: Vec<ToolFactEnvelope>,
    pub git_facts: Vec<ToolFactEnvelope>,
    pub written_files: Vec<FileChangeFact>,
    pub created_files: Vec<FileChangeFact>,
    pub deleted_files: Vec<FileChangeFact>,
    pub renamed_files: Vec<FileChangeFact>,
    pub patch_changed_ranges: Vec<FileChangeFact>,
    pub generated_artifacts: Vec<GeneratedArtifactFact>,
    pub resource_events: Vec<ResourceLifecycleFact>,
    pub cleanup_failures: Vec<CleanupFailureFact>,
    pub path_normalization_diagnostics: Vec<PathNormalizationDiagnostic>,
    pub batch_review_ready: bool,
}
