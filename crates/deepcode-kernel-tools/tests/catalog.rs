use deepcode_kernel_tools::{KernelToolRegistry, ToolAvailability};
use serde_json::json;

#[test]
fn rejected_arguments_explain_required_unknown_enum_type_and_nested_bounds() {
    use deepcode_kernel_tools::KernelToolCatalogError;
    let registry = KernelToolRegistry::new();
    let error = registry
        .canonicalize(
            "bash",
            json!({"executionMode":"read", "executionScope":"outside", "timeout":"slow"}),
        )
        .unwrap_err();
    let KernelToolCatalogError::InvalidArguments { issues, .. } = error else {
        panic!("expected typed input rejection")
    };
    assert!(issues
        .iter()
        .any(|issue| issue.path == "$.command" && issue.rule == "required"));
    assert!(issues
        .iter()
        .any(|issue| issue.path == "$.executionMode" && issue.rule == "additionalProperties"));
    assert!(issues.iter().any(|issue| issue.path == "$.executionScope"
        && issue.rule == "enum"
        && issue.expected == Some(json!(["workspace", "host"]))));
    assert!(issues
        .iter()
        .any(|issue| issue.path == "$.timeout" && issue.rule == "type"));
    let error = registry
        .canonicalize(
            "fs.edit",
            json!({"path":"README.md", "edits":[{"oldText":"", "newText":"updated"}]}),
        )
        .unwrap_err();
    let KernelToolCatalogError::InvalidArguments { issues, .. } = error else {
        panic!("expected typed input rejection")
    };
    assert!(issues
        .iter()
        .any(|issue| issue.path == "$.edits[0].oldText" && issue.rule == "minLength"));
    assert!(matches!(
        registry.canonicalize("missing.tool", json!({})),
        Err(KernelToolCatalogError::ToolNotRegistered(_))
    ));
}

#[test]
fn bash_defaults_are_workspace_read_without_rewriting_the_script() {
    let script = "set -o pipefail\nprintf '%s\\n' 'literal $HOME' | head -1";
    let invocation = KernelToolRegistry::new()
        .canonicalize("bash", json!({"command": script}))
        .unwrap();
    assert_eq!(invocation.arguments["command"], script);
    assert_eq!(invocation.arguments["workspaceMode"], "read");
    assert_eq!(invocation.arguments["executionScope"], "workspace");
    assert_eq!(invocation.arguments["timeout"], 120);
}

#[test]
fn catalog_exposes_basic_callable_tools() {
    let registry = KernelToolRegistry::new();
    let names = registry
        .descriptors()
        .map(|descriptor| descriptor.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![
            "bash",
            "fs.delete",
            "fs.edit",
            "fs.read",
            "fs.write",
            "web.fetch",
            "web.search",
        ]
    );
    for name in names {
        let descriptor = registry.descriptor(name).unwrap();
        assert_eq!(descriptor.availability, ToolAvailability::Callable);
    }
    let bash = registry.descriptor("bash").expect("bash descriptor");
    let web_search = registry
        .descriptor("web.search")
        .expect("web.search descriptor");
    assert_eq!(web_search.input_schema["required"], json!(["query"]));
    assert_eq!(
        web_search.input_schema["properties"]
            .as_object()
            .expect("web.search properties")
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["limit", "query"]
    );
    assert!(registry.descriptor("process.shell").is_none());
    assert_eq!(bash.input_schema["required"], json!(["command"]));
    assert_eq!(
        bash.input_schema["properties"]
            .as_object()
            .expect("bash properties")
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec![
            "command",
            "executionScope",
            "terminal",
            "timeout",
            "workspaceMode"
        ]
    );
}

#[test]
fn canonical_arguments_reach_the_executor_boundary() {
    let registry = KernelToolRegistry::new();
    let read = registry
        .canonicalize(
            "fs.read",
            json!({"path":"src/lib.rs","startLine":2,"maxLines":3}),
        )
        .unwrap();
    assert_eq!(
        read.arguments,
        json!({
            "path":"src/lib.rs",
            "startLine":2,
            "maxLines":3,
            "maxBytes":262144
        })
    );

    let write = registry
        .canonicalize(
            "fs.write",
            json!({"path":"src/generated/main.rs","content":"fn main() {}\n"}),
        )
        .unwrap();
    assert_eq!(write.arguments["path"], "src/generated/main.rs");
    assert!(write.arguments.get("executable").is_none());

    let shell = registry
        .canonicalize(
            "bash",
            json!({
                "command":"printf ready",
                "workspaceMode":"read",
                "executionScope":"workspace"
            }),
        )
        .unwrap();
    assert_eq!(shell.arguments["command"], "printf ready");
    assert_eq!(shell.arguments["workspaceMode"], "read");
    assert_eq!(shell.arguments["executionScope"], "workspace");
    assert_eq!(shell.arguments["timeout"], 120);
    assert!(shell.arguments.get("terminal").is_none());
    assert!(shell.arguments.get("cwd").is_none());
    assert!(shell.arguments.get("maxOutputBytes").is_none());
}

#[test]
fn file_names_keep_distinct_unicode_spelling_through_invocation_and_identity() {
    use deepcode_kernel_tools::kernel_internal::{normalize_canonical_platform_path, Platform};
    let registry = KernelToolRegistry::new();
    let decomposed = "e\u{301}.txt";
    let composed = "é.txt";
    for path in [decomposed, composed] {
        let read = registry
            .canonicalize("fs.read", json!({"path": path}))
            .unwrap();
        assert_eq!(read.arguments["path"], path);
        let absolute = format!("/workspace/{path}");
        assert_eq!(
            normalize_canonical_platform_path(Platform::Linux, &absolute).unwrap(),
            absolute
        );
    }
    assert_ne!(
        registry
            .canonicalize("fs.read", json!({"path": decomposed}))
            .unwrap()
            .arguments,
        registry
            .canonicalize("fs.read", json!({"path": composed}))
            .unwrap()
            .arguments
    );
}

#[test]
fn rejected_arguments_expose_field_paths_for_extra_fields_and_bounds() {
    use deepcode_kernel_tools::KernelToolCatalogError;
    let registry = KernelToolRegistry::new();
    let error = registry
        .canonicalize(
            "fs.edit",
            json!({
                "path": "README.md",
                "edits": [{"oldText": "a", "newText": "b"}],
                "workspaceMode": "write"
            }),
        )
        .unwrap_err();
    let KernelToolCatalogError::InvalidArguments { issues, .. } = error else {
        panic!("expected typed input rejection")
    };
    assert!(issues
        .iter()
        .any(|issue| issue.path == "$.workspaceMode" && issue.rule == "additionalProperties"));

    let error = registry
        .canonicalize(
            "bash",
            json!({
                "command": "pwd",
                "workspaceMode": "read",
                "executionScope": "workspace",
                "timeout": 900
            }),
        )
        .unwrap_err();
    let KernelToolCatalogError::InvalidArguments { issues, .. } = error else {
        panic!("expected typed input rejection")
    };
    assert!(issues.iter().any(|issue| issue.path == "$.timeout"
        && issue.rule == "maximum"
        && issue.expected == Some(json!(600))));
}
