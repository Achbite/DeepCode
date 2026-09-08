use deepcode_kernel_tools::{KernelToolRegistry, ToolAvailability};
use serde_json::json;

#[test]
fn rejected_arguments_explain_required_unknown_enum_type_and_nested_bounds() {
    use deepcode_kernel_tools::KernelToolCatalogError;
    let registry = KernelToolRegistry::new();
    let error = registry.canonicalize("bash", json!({"command":"pwd", "executionMode":"read", "executionScope":"outside", "timeout":"slow"})).unwrap_err();
    let KernelToolCatalogError::InvalidArguments { issues, .. } = error else {
        panic!("expected typed input rejection")
    };
    assert!(issues
        .iter()
        .any(|issue| issue.path == "$.workspaceMode" && issue.rule == "required"));
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
    assert_eq!(
        bash.input_schema["required"],
        json!(["command", "workspaceMode", "executionScope"])
    );
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
