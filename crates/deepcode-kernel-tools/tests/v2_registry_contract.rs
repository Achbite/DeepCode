use deepcode_kernel_abi::{RawToolArgumentsV2, ToolAvailabilityV2, ToolContextVersionV2, ToolIdV2};
use deepcode_kernel_tools::{
    kernel_internal::{
        validate_canonical_invocation, KernelCanonicalInvocation, KernelDeleteTarget,
    },
    KernelToolRegistry, KernelToolRegistryErrorV2,
};
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

#[test]
fn fs_delete_public_schema_round_trips_file_and_directory_tree() {
    let registry = KernelToolRegistry::new();
    let delete_id = tool_id("fs.delete");
    let descriptor = registry
        .descriptor_v2(&delete_id)
        .expect("fs.delete must remain registered");
    let schema = descriptor.input_schema.as_value();

    assert_eq!(schema.get("type"), Some(&serde_json::json!("object")));
    let branches = schema
        .get("oneOf")
        .and_then(serde_json::Value::as_array)
        .expect("fs.delete must publish two mutually exclusive public branches");
    assert_eq!(branches.len(), 2);
    assert_eq!(
        branches[0].pointer("/properties/targetKind/const"),
        Some(&serde_json::json!("file"))
    );
    assert_eq!(
        branches[1].pointer("/properties/targetKind/const"),
        Some(&serde_json::json!("directory"))
    );
    assert_eq!(
        branches[1].pointer("/properties/recursive/const"),
        Some(&serde_json::json!(true))
    );
    assert_eq!(
        branches
            .iter()
            .map(|branch| branch.get("additionalProperties"))
            .collect::<Vec<_>>(),
        vec![
            Some(&serde_json::json!(false)),
            Some(&serde_json::json!(false))
        ]
    );

    let file = registry
        .canonicalize_v2(
            &delete_id,
            RawToolArgumentsV2::new(serde_json::json!({
                "path": "notes/old.txt",
                "targetKind": "file"
            }))
            .expect("public file arguments are an object"),
        )
        .expect("public file arguments must canonicalize");
    assert_eq!(
        file.arguments,
        serde_json::json!({"kind":"file","data":{"path":"notes/old.txt"}})
    );
    let file_invocation = file.into_kernel_invocation();
    assert_eq!(
        file_invocation,
        KernelCanonicalInvocation::FsDelete(KernelDeleteTarget::File {
            path: "notes/old.txt".to_owned(),
        })
    );
    validate_canonical_invocation(&file_invocation)
        .expect("canonical file deletion must round-trip through the private adapter");

    let directory = registry
        .canonicalize_v2(
            &delete_id,
            RawToolArgumentsV2::new(serde_json::json!({
                "path": "build/generated",
                "targetKind": "directory",
                "recursive": true
            }))
            .expect("public directory arguments are an object"),
        )
        .expect("explicit recursive directory arguments must canonicalize");
    assert_eq!(
        directory.arguments,
        serde_json::json!({
            "kind":"directoryTree",
            "data":{"path":"build/generated"}
        })
    );
    let directory_invocation = directory.into_kernel_invocation();
    assert_eq!(
        directory_invocation,
        KernelCanonicalInvocation::FsDelete(KernelDeleteTarget::DirectoryTree {
            path: "build/generated".to_owned(),
        })
    );
    validate_canonical_invocation(&directory_invocation)
        .expect("canonical directory-tree deletion must round-trip through the private adapter");
}

#[test]
fn fs_delete_public_schema_rejects_ambiguous_or_unsafe_targets() {
    let registry = KernelToolRegistry::new();
    let delete_id = tool_id("fs.delete");
    let invalid = [
        serde_json::json!({"path":"notes/old.txt"}),
        serde_json::json!({
            "path":"notes/old.txt",
            "targetKind":"file",
            "recursive":true
        }),
        serde_json::json!({"path":"build/generated","targetKind":"directory"}),
        serde_json::json!({
            "path":"build/generated",
            "targetKind":"directory",
            "recursive":false
        }),
        serde_json::json!({
            "path":"notes/old.txt",
            "targetKind":"file",
            "unexpected":true
        }),
        serde_json::json!({"kind":"file","data":{"path":"notes/old.txt"}}),
        serde_json::json!({"path":"../outside.txt","targetKind":"file"}),
        serde_json::json!({"path":"/tmp/outside.txt","targetKind":"file"}),
        serde_json::json!({"path":"","targetKind":"file"}),
        serde_json::json!({"path":"notes\\old.txt","targetKind":"file"}),
    ];

    for arguments in invalid {
        let raw = RawToolArgumentsV2::new(arguments.clone())
            .expect("each invalid case is still an object-shaped wire payload");
        assert!(
            matches!(
                registry.canonicalize_v2(&delete_id, raw),
                Err(KernelToolRegistryErrorV2::InvalidArguments { tool_id, .. })
                    if tool_id == "fs.delete"
            ),
            "fs.delete must reject ambiguous, internal, or unsafe public arguments: {arguments}"
        );
    }
}
