use crate::registrations::{builtin_tool_registrations, KernelToolRegistration};
use deepcode_kernel_abi::v2::V2ValidationError;
use deepcode_kernel_abi::{
    canonical_arguments_digest_v2, render_kernel_tool_prompt_v2, tool_catalog_digest_v2,
    tool_context_digest_v2, CanonicalArgumentsDigestV2, RawToolArgumentsV2, ToolAvailabilityV2,
    ToolContextBundleV2, ToolContextVersionV2, ToolIdV2, ToolInventoryV2,
    KERNEL_TOOL_REGISTRY_VERSION_V2, TOOL_CONTEXT_FORMAT_V2, TOOL_INVENTORY_FORMAT_V2,
};
use serde_json::Value;
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum KernelToolRegistryErrorV2 {
    #[error("tool `{0}` is not registered")]
    ToolNotRegistered(String),
    #[error("tool `{0}` is not ready")]
    ToolUnavailable(String),
    #[error("runtime availability for `{0}` may only shrink ready to revoked or unavailable")]
    InvalidRuntimeAvailability(String),
    #[error("tool `{tool_id}` arguments are invalid: {reason}")]
    InvalidArguments { tool_id: String, reason: String },
    #[error(transparent)]
    Contract(#[from] V2ValidationError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalToolInvocationV2 {
    pub tool_id: ToolIdV2,
    pub arguments: Value,
    pub arguments_digest: CanonicalArgumentsDigestV2,
    invocation: crate::invocation_types::KernelCanonicalInvocation,
}

impl CanonicalToolInvocationV2 {
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
                "duplicate canonical Kernel tool registration: {tool_id}"
            );
        }
        let ready = registrations
            .values()
            .filter(|registration| {
                registration.descriptor_v2.availability == ToolAvailabilityV2::Ready
            })
            .count();
        let executable = registrations
            .values()
            .filter(|registration| registration.executor_binding.is_some())
            .count();
        assert_eq!(
            registrations.len(),
            19,
            "compiled Kernel registry must contain the frozen 19 registrations"
        );
        assert_eq!(
            ready, 13,
            "compiled Kernel registry must expose exactly 13 ready tools"
        );
        assert_eq!(
            executable, 13,
            "only the frozen 13 ready tools may install executors"
        );
        let disabled = registrations
            .values()
            .filter(|registration| {
                registration.descriptor_v2.availability == ToolAvailabilityV2::Disabled
            })
            .map(KernelToolRegistration::tool_id)
            .collect::<Vec<_>>();
        assert_eq!(
            disabled,
            vec![
                "fs.rename",
                "git.commit",
                "git.diff",
                "git.stage",
                "git.status",
                "git.unstage",
            ],
            "compiled Kernel registry must preserve the frozen six disabled identities"
        );
        for registration in registrations.values() {
            assert_eq!(
                registration.descriptor_v2.availability == ToolAvailabilityV2::Ready,
                registration.executor_binding.is_some(),
                "tool availability and executor binding diverged for {}",
                registration.tool_id()
            );
        }
        Self { registrations }
    }

    fn get_v2(&self, tool_id: &ToolIdV2) -> Option<&KernelToolRegistration> {
        self.registrations.get(tool_id.as_str())
    }

    pub fn descriptor_v2(
        &self,
        tool_id: &ToolIdV2,
    ) -> Option<&deepcode_kernel_abi::ToolDescriptorV2> {
        self.get_v2(tool_id)
            .map(|registration| &registration.descriptor_v2)
    }

    #[doc(hidden)]
    pub fn kernel_internal_tool_kind(
        &self,
        tool_id: &ToolIdV2,
    ) -> Option<crate::kernel_internal::KernelToolKind> {
        self.get_v2(tool_id)
            .map(KernelToolRegistration::private_tool_kind)
    }

    #[doc(hidden)]
    pub fn kernel_internal_execution_adapter(
        &self,
        tool_id: &str,
    ) -> Option<crate::kernel_internal::KernelExecutionAdapter> {
        self.registrations
            .get(tool_id)
            .filter(|registration| {
                registration.descriptor_v2.availability == ToolAvailabilityV2::Ready
                    && registration.executor_binding.is_some()
            })
            .map(|registration| registration.admission_v2.execution_adapter)
    }

    #[doc(hidden)]
    pub fn kernel_internal_admission_metadata(
        &self,
        tool_id: &ToolIdV2,
    ) -> Option<crate::kernel_internal::KernelAdmissionMetadata> {
        self.get_v2(tool_id).and_then(|registration| {
            if registration.descriptor_v2.availability == ToolAvailabilityV2::Ready
                && registration.executor_binding.is_some()
            {
                Some(registration.admission_v2)
            } else {
                None
            }
        })
    }

    #[doc(hidden)]
    pub fn kernel_internal_ready_executor_bindings(
        &self,
    ) -> impl Iterator<Item = (&'static str, crate::kernel_internal::KernelExecutorBinding)> + '_
    {
        self.registrations.values().filter_map(|registration| {
            if registration.descriptor_v2.availability == ToolAvailabilityV2::Ready {
                registration
                    .executor_binding
                    .map(|binding| (registration.tool_id(), binding))
            } else {
                None
            }
        })
    }

    pub fn tool_inventory_v2(&self) -> Result<ToolInventoryV2, KernelToolRegistryErrorV2> {
        let tools = self
            .registrations
            .values()
            .map(|registration| registration.descriptor_v2.clone())
            .collect::<Vec<_>>();
        let inventory = ToolInventoryV2 {
            format_version: TOOL_INVENTORY_FORMAT_V2.to_owned(),
            catalog_version: KERNEL_TOOL_REGISTRY_VERSION_V2.to_owned(),
            catalog_digest: tool_catalog_digest_v2(&tools)?,
            tools,
        };
        inventory.validate()?;
        Ok(inventory)
    }

    pub fn tool_context_v2(
        &self,
        context_version: ToolContextVersionV2,
    ) -> Result<ToolContextBundleV2, KernelToolRegistryErrorV2> {
        self.tool_context_v2_with_runtime_availability(context_version, &BTreeMap::new())
    }

    pub fn tool_context_v2_with_runtime_availability(
        &self,
        context_version: ToolContextVersionV2,
        runtime_availability: &BTreeMap<ToolIdV2, ToolAvailabilityV2>,
    ) -> Result<ToolContextBundleV2, KernelToolRegistryErrorV2> {
        for (tool_id, availability) in runtime_availability {
            let registration = self
                .get_v2(tool_id)
                .ok_or_else(|| KernelToolRegistryErrorV2::ToolNotRegistered(tool_id.to_string()))?;
            if registration.descriptor_v2.availability != ToolAvailabilityV2::Ready
                || !matches!(
                    availability,
                    ToolAvailabilityV2::Revoked | ToolAvailabilityV2::Unavailable
                )
            {
                return Err(KernelToolRegistryErrorV2::InvalidRuntimeAvailability(
                    tool_id.to_string(),
                ));
            }
        }
        let inventory = self.tool_inventory_v2()?;
        let tools = self
            .registrations
            .values()
            .filter(|registration| {
                registration.descriptor_v2.availability == ToolAvailabilityV2::Ready
                    && !runtime_availability.contains_key(&registration.descriptor_v2.tool_id)
            })
            .map(|registration| registration.descriptor_v2.clone())
            .collect::<Vec<_>>();
        let fixed_prompt = render_kernel_tool_prompt_v2(&tools)?;
        let context_digest = tool_context_digest_v2(
            context_version,
            &inventory.catalog_digest,
            &fixed_prompt,
            &tools,
        )?;
        let context = ToolContextBundleV2 {
            format_version: TOOL_CONTEXT_FORMAT_V2.to_owned(),
            context_version,
            catalog_digest: inventory.catalog_digest,
            context_digest,
            fixed_prompt,
            tools,
        };
        context.validate()?;
        Ok(context)
    }

    pub fn canonicalize_v2(
        &self,
        tool_id: &ToolIdV2,
        raw_arguments: RawToolArgumentsV2,
    ) -> Result<CanonicalToolInvocationV2, KernelToolRegistryErrorV2> {
        let registration = self
            .get_v2(tool_id)
            .ok_or_else(|| KernelToolRegistryErrorV2::ToolNotRegistered(tool_id.to_string()))?;
        if registration.descriptor_v2.availability != ToolAvailabilityV2::Ready
            || registration.executor_binding.is_none()
        {
            return Err(KernelToolRegistryErrorV2::ToolUnavailable(
                tool_id.to_string(),
            ));
        }
        let invocation = (registration.canonicalize_invocation)(raw_arguments.into_value())
            .map_err(|reason| KernelToolRegistryErrorV2::InvalidArguments {
                tool_id: tool_id.to_string(),
                reason,
            })?;
        let arguments = serde_json::to_value(&invocation)
            .ok()
            .and_then(|value| value.get("arguments").cloned())
            .ok_or_else(|| KernelToolRegistryErrorV2::InvalidArguments {
                tool_id: tool_id.to_string(),
                reason: "private invocation adapter omitted canonical arguments".to_owned(),
            })?;
        let arguments_digest = canonical_arguments_digest_v2(tool_id, &arguments)?;
        Ok(CanonicalToolInvocationV2 {
            tool_id: tool_id.clone(),
            arguments,
            arguments_digest,
            invocation,
        })
    }
}
