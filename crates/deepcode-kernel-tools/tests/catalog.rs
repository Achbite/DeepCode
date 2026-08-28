use deepcode_kernel_tools::{KernelToolCatalogError, KernelToolRegistry, ToolAvailability};
use serde_json::json;

#[test]
fn catalog_contains_callable_tools_and_blocked_capability_slots() {
    let registry = KernelToolRegistry::new();
    let names = registry
        .descriptors()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(names.len(), 14);
    assert!(names.contains(&"fs.read"));
    assert!(names.contains(&"fs.edit"));
    assert!(names.contains(&"web.fetch"));
    assert!(names.contains(&"process.shell"));
    assert_eq!(
        registry.descriptor("fs.read").unwrap().availability,
        ToolAvailability::Callable,
    );
    for blocked in ["web.search", "web.fetch", "process.shell"] {
        assert_eq!(
            registry.descriptor(blocked).unwrap().availability,
            ToolAvailability::Blocked,
        );
        assert!(matches!(
            registry.canonicalize(blocked, json!({})),
            Err(KernelToolCatalogError::ToolBlocked(name)) if name == blocked
        ));
    }
    for removed in [
        "fs.rename",
        "git.commit",
        "git.diff",
        "git.stage",
        "git.status",
        "git.unstage",
    ] {
        assert!(registry.descriptor(removed).is_none());
    }
}

#[test]
fn canonical_arguments_match_the_executor_boundary() {
    let registry = KernelToolRegistry::new();
    let read = registry
        .canonicalize(
            "fs.read",
            json!({"path":"src/lib.rs","startLine":2,"endLine":4}),
        )
        .unwrap();
    assert_eq!(
        read.arguments,
        json!({"path":"src/lib.rs","startLine":2,"endLine":4})
    );

    let delete = registry
        .canonicalize(
            "fs.delete",
            json!({"path":"build/cache","targetKind":"directoryTree"}),
        )
        .unwrap();
    assert_eq!(
        delete.arguments,
        json!({"path":"build/cache","targetKind":"directoryTree"})
    );

    assert!(registry
        .canonicalize(
            "fs.delete",
            json!({"path":"build/cache","targetKind":"directory","recursive":true}),
        )
        .is_err());
    assert!(registry
        .canonicalize("fs.delete", json!({"path":"build/cache"}))
        .is_err());

    let edit = registry
        .canonicalize(
            "fs.edit",
            json!({
                "path":"src/lib.rs",
                "matcher":{"kind":"exactBlock","data":{"text":"old"}},
                "replacement":"new"
            }),
        )
        .unwrap();
    assert_eq!(
        edit.arguments,
        json!({
            "path":"src/lib.rs",
            "patchSpec":{"match":{"kind":"exactBlock","text":"old"}},
            "replacement":"new"
        })
    );
}

#[test]
fn catalog_rejects_unknown_fields_and_workspace_escape() {
    let registry = KernelToolRegistry::new();
    assert!(registry
        .canonicalize("fs.read", json!({"path":"src/lib.rs","extra":true}))
        .is_err());
    assert!(registry
        .canonicalize("fs.read", json!({"path":"../outside"}))
        .is_err());
    assert!(registry
        .canonicalize("fs.glob", json!({"pattern":"**/*","path":""}))
        .is_err());
    assert_eq!(
        registry
            .descriptor("fs.glob")
            .unwrap()
            .input_schema["properties"]["path"]["description"],
        "Optional normalized workspace-relative directory. Omit it for the workspace root; if explicitly provided for the root, use '.' and never an empty string."
    );
}
