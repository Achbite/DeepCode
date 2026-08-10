use deepcode_kernel_tools::KernelToolRegistry;
use std::sync::OnceLock;

pub mod executors;
mod network_policy;
pub mod v2;

static KERNEL_TOOL_REGISTRY: OnceLock<KernelToolRegistry> = OnceLock::new();

pub(crate) fn kernel_tool_registry() -> &'static KernelToolRegistry {
    KERNEL_TOOL_REGISTRY.get_or_init(KernelToolRegistry::new)
}

#[cfg(test)]
mod tests;
