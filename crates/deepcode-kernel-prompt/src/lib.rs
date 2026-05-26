use deepcode_kernel_abi::KernelResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSourceRef {
    pub id: String,
    pub kind: String,
    pub path: Option<String>,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEnvelope {
    pub id: String,
    pub profile_id: Option<String>,
    pub workflow_phase: Option<String>,
    pub messages: Vec<Value>,
    pub variables: Value,
    pub source_refs: Vec<PromptSourceRef>,
    pub locale: Option<String>,
    pub output_contract: Value,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCompileRequest {
    pub session_id: Option<String>,
    pub workflow_phase: Option<String>,
    pub user_input: String,
    pub context: Value,
}

pub trait PromptCompiler {
    fn compile(&self, request: PromptCompileRequest) -> KernelResult<PromptEnvelope>;
}
