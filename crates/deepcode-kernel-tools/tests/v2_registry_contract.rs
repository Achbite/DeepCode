use deepcode_kernel_abi::{RawToolArgumentsV2, ToolAvailabilityV2, ToolContextVersionV2, ToolIdV2};
use deepcode_kernel_tools::{KernelToolRegistry, KernelToolRegistryErrorV2};
use std::collections::BTreeMap;

fn tool_id(value: &str) -> ToolIdV2 {
    ToolIdV2::parse(value).expect("test ToolId must be valid")
}

#[test]
fn registry_inventory_is_exactly_the_frozen_v2_set() {
    let registry = KernelToolRegistry::new();
    let inventory = registry
        .tool_inventory_v2()
        .expect("compiled v2 inventory must validate");
    let observed = inventory
        .tools
        .iter()
        .map(|descriptor| (descriptor.tool_id.as_str(), descriptor.availability))
        .collect::<Vec<_>>();

    assert_eq!(
        observed,
        vec![
            ("code.grep", ToolAvailabilityV2::Ready),
            ("document.read", ToolAvailabilityV2::Ready),
            ("fs.create", ToolAvailabilityV2::Ready),
            ("fs.delete", ToolAvailabilityV2::Ready),
            ("fs.diff", ToolAvailabilityV2::Ready),
            ("fs.edit", ToolAvailabilityV2::Ready),
            ("fs.ensure_directory", ToolAvailabilityV2::Ready),
            ("fs.glob", ToolAvailabilityV2::Ready),
            ("fs.list", ToolAvailabilityV2::Ready),
            ("fs.read", ToolAvailabilityV2::Ready),
            ("fs.rename", ToolAvailabilityV2::Disabled),
            ("fs.write", ToolAvailabilityV2::Ready),
            ("git.commit", ToolAvailabilityV2::Disabled),
            ("git.diff", ToolAvailabilityV2::Disabled),
            ("git.stage", ToolAvailabilityV2::Disabled),
            ("git.status", ToolAvailabilityV2::Disabled),
            ("git.unstage", ToolAvailabilityV2::Disabled),
            ("web.fetch", ToolAvailabilityV2::Ready),
            ("web.search", ToolAvailabilityV2::Ready),
        ]
    );
    inventory
        .validate()
        .expect("inventory digest and descriptor order must be canonical");
}

#[test]
fn disabled_tools_never_enter_tool_context_or_executor_bindings() {
    let registry = KernelToolRegistry::new();
    let disabled = [
        "fs.rename",
        "git.commit",
        "git.diff",
        "git.stage",
        "git.status",
        "git.unstage",
    ];
    let context = registry
        .tool_context_v2(ToolContextVersionV2::new(1).expect("non-zero context version"))
        .expect("tool context must validate");
    let context_ids = context
        .tools
        .iter()
        .map(|descriptor| descriptor.tool_id.as_str())
        .collect::<Vec<_>>();
    let executor_ids = registry
        .kernel_internal_ready_executor_bindings()
        .map(|(tool_id, _)| tool_id)
        .collect::<Vec<_>>();

    assert_eq!(context_ids.len(), 13);
    assert_eq!(executor_ids.len(), 13);
    for disabled_id in disabled {
        assert!(!context_ids.contains(&disabled_id));
        assert!(!executor_ids.contains(&disabled_id));
        assert!(registry
            .kernel_internal_execution_adapter(disabled_id)
            .is_none());
    }
}

#[test]
fn runtime_availability_can_only_shrink_ready_context() {
    let registry = KernelToolRegistry::new();
    let mut runtime_availability = BTreeMap::new();
    runtime_availability.insert(tool_id("fs.read"), ToolAvailabilityV2::Revoked);
    runtime_availability.insert(tool_id("web.fetch"), ToolAvailabilityV2::Unavailable);
    let context = registry
        .tool_context_v2_with_runtime_availability(
            ToolContextVersionV2::new(2).expect("non-zero context version"),
            &runtime_availability,
        )
        .expect("runtime may shrink ready tools");

    assert_eq!(context.tools.len(), 11);
    assert!(!context
        .tools
        .iter()
        .any(|descriptor| matches!(descriptor.tool_id.as_str(), "fs.read" | "web.fetch")));

    runtime_availability.clear();
    runtime_availability.insert(tool_id("fs.read"), ToolAvailabilityV2::Ready);
    assert!(matches!(
        registry.tool_context_v2_with_runtime_availability(
            ToolContextVersionV2::new(3).expect("non-zero context version"),
            &runtime_availability,
        ),
        Err(KernelToolRegistryErrorV2::InvalidRuntimeAvailability(tool_id))
            if tool_id == "fs.read"
    ));

    runtime_availability.clear();
    runtime_availability.insert(tool_id("git.status"), ToolAvailabilityV2::Revoked);
    assert!(matches!(
        registry.tool_context_v2_with_runtime_availability(
            ToolContextVersionV2::new(3).expect("non-zero context version"),
            &runtime_availability,
        ),
        Err(KernelToolRegistryErrorV2::InvalidRuntimeAvailability(tool_id))
            if tool_id == "git.status"
    ));
}

#[test]
fn disabled_and_removed_tool_ids_fail_with_distinct_typed_errors() {
    let registry = KernelToolRegistry::new();
    let empty_arguments = RawToolArgumentsV2::new(serde_json::json!({})).expect("object arguments");

    assert!(matches!(
        registry.canonicalize_v2(&tool_id("fs.rename"), empty_arguments.clone()),
        Err(KernelToolRegistryErrorV2::ToolUnavailable(tool_id))
            if tool_id == "fs.rename"
    ));
    assert!(matches!(
        registry.canonicalize_v2(&tool_id("git.push"), empty_arguments),
        Err(KernelToolRegistryErrorV2::ToolNotRegistered(tool_id))
            if tool_id == "git.push"
    ));
    for removed in [
        "process.exec",
        "browser.open",
        "browser.click",
        "provider.call",
    ] {
        assert!(registry.descriptor_v2(&tool_id(removed)).is_none());
        assert!(registry
            .kernel_internal_execution_adapter(removed)
            .is_none());
    }
}
