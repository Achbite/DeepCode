use deepcode_kernel_abi::{ConfigSnapshotRef, ProfileRef, WorkspaceBinding};
use deepcode_kernel_workflow::{RunDecisionState, WorkflowPhase};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Default)]
pub(crate) struct RuntimeState {
    pub(crate) next_run_index: u64,
    pub(crate) next_workspace_index: u64,
    pub(crate) current_workspace: Option<RuntimeWorkspace>,
    pub(crate) records_by_session: BTreeMap<String, RuntimeRunRecord>,
    pub(crate) pending_tools: BTreeMap<String, PendingKernelTool>,
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
