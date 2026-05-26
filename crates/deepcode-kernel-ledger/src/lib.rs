use deepcode_kernel_abi::KernelResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEvent {
    pub id: String,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub kind: String,
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
}

pub trait EventLedger {
    fn append(&self, event: LedgerEvent) -> KernelResult<()>;
    fn list_by_run(&self, run_id: &str) -> KernelResult<Vec<LedgerEvent>>;
}
