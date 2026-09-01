use crate::registrations::{builtin_tool_registrations, KernelToolRegistration};
use crate::types::{ToolAvailability, ToolDescriptor};
use serde_json::Value;
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum KernelToolCatalogError {
    #[error("tool `{0}` is not registered")]
    ToolNotRegistered(String),
    #[error("tool `{0}` is blocked")]
    ToolBlocked(String),
    #[error("tool `{tool_name}` arguments are invalid: {reason}")]
    InvalidArguments { tool_name: String, reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalToolInvocation {
    pub tool_name: String,
    pub arguments: Value,
    invocation: crate::invocation_types::KernelCanonicalInvocation,
}

impl CanonicalToolInvocation {
    #[doc(hidden)]
    pub fn into_kernel_invocation(self) -> crate::kernel_internal::KernelCanonicalInvocation {
        self.invocation
    }
}

#[derive(Debug, Clone)]
pub struct KernelToolRegistry {
    registrations: BTreeMap<&'static str, KernelToolRegistration>,
}

impl Default for KernelToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl KernelToolRegistry {
    pub fn new() -> Self {
        let mut registrations = BTreeMap::new();
        for registration in builtin_tool_registrations() {
            let tool_id = registration.tool_id();
            assert!(
                registrations.insert(tool_id, registration).is_none(),
                "duplicate Kernel tool registration: {tool_id}"
            );
        }
        assert_eq!(
            registrations.len(),
            7,
            "Kernel catalog must contain the canonical callable tools"
        );
        Self { registrations }
    }

    pub fn descriptor(&self, tool_name: &str) -> Option<&ToolDescriptor> {
        self.registrations
            .get(tool_name)
            .map(|registration| &registration.descriptor)
    }

    pub fn descriptors(&self) -> impl Iterator<Item = &ToolDescriptor> {
        self.registrations
            .values()
            .map(|registration| &registration.descriptor)
    }

    #[doc(hidden)]
    pub fn executor_bindings(
        &self,
    ) -> impl Iterator<Item = (&'static str, crate::kernel_internal::KernelExecutorBinding)> + '_
    {
        self.registrations.values().filter_map(|registration| {
            registration
                .executor_binding
                .map(|binding| (registration.tool_id(), binding))
        })
    }

    pub fn canonicalize(
        &self,
        tool_name: &str,
        raw_arguments: Value,
    ) -> Result<CanonicalToolInvocation, KernelToolCatalogError> {
        let registration = self
            .registrations
            .get(tool_name)
            .ok_or_else(|| KernelToolCatalogError::ToolNotRegistered(tool_name.to_owned()))?;
        if registration.descriptor.availability == ToolAvailability::Blocked {
            return Err(KernelToolCatalogError::ToolBlocked(tool_name.to_owned()));
        }
        let canonicalize = registration
            .canonicalize_invocation
            .expect("callable Kernel tool must have a canonicalizer");
        let invocation = canonicalize(raw_arguments).map_err(|reason| {
            KernelToolCatalogError::InvalidArguments {
                tool_name: tool_name.to_owned(),
                reason,
            }
        })?;
        let arguments = invocation.executor_arguments();
        Ok(CanonicalToolInvocation {
            tool_name: tool_name.to_owned(),
            arguments,
            invocation,
        })
    }
}
