use deepcode_kernel_abi::KernelResult;
use deepcode_kernel_policy::{Capability, CapabilityEffect, RiskLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInputSchemaRef {
    pub schema_ref: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillOutputSchemaRef {
    pub schema_ref: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDescriptor {
    pub id: String,
    pub version: String,
    pub description_key: Option<String>,
    pub input_schema: SkillInputSchemaRef,
    pub output_schema: SkillOutputSchemaRef,
    pub required_capabilities: Vec<Capability>,
    pub allowed_phases: Vec<String>,
    pub risk_level: RiskLevel,
    pub effects: Vec<CapabilityEffect>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInvocation {
    pub id: String,
    pub skill_id: String,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillResult {
    pub invocation_id: String,
    pub ok: bool,
    pub output: Value,
    pub error: Option<String>,
}

pub trait SkillRegistry {
    fn list(&self) -> KernelResult<Vec<SkillDescriptor>>;
    fn get(&self, skill_id: &str) -> KernelResult<Option<SkillDescriptor>>;
}

pub trait SkillRuntime {
    fn invoke(&self, invocation: SkillInvocation) -> KernelResult<SkillResult>;
}
