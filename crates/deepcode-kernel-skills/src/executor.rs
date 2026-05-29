use crate::{SkillDescriptor, SkillInvocation, SkillResult, SkillTrustMode};
use deepcode_kernel_abi::{KernelError, KernelResult};
use deepcode_kernel_policy::Capability;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillExecutionContext {
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub trust_mode: SkillTrustMode,
    pub approved_capabilities: Vec<Capability>,
}

pub trait SkillExecutor {
    fn descriptor(&self) -> SkillDescriptor;
    fn invoke(
        &self,
        invocation: SkillInvocation,
        context: SkillExecutionContext,
    ) -> KernelResult<SkillResult>;
}

#[derive(Default)]
pub struct SkillExecutorRegistry {
    executors: BTreeMap<String, Box<dyn SkillExecutor>>,
}

impl SkillExecutorRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, executor: Box<dyn SkillExecutor>) {
        self.executors
            .insert(executor.descriptor().id.clone(), executor);
    }

    pub fn invoke(
        &self,
        invocation: SkillInvocation,
        context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        if context.trust_mode == SkillTrustMode::DirectHostScript {
            return Err(KernelError::PermissionDenied(
                "direct host script skills are a reserved high-risk extension and are disabled in v1"
                    .to_string(),
            ));
        }
        let executor = self.executors.get(&invocation.skill_id).ok_or_else(|| {
            KernelError::PermissionDenied(format!("unknown skill {}", invocation.skill_id))
        })?;
        executor.invoke(invocation, context)
    }
}
