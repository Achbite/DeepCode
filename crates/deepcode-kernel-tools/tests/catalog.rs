use deepcode_kernel_tools::kernel_internal::{
    KernelCanonicalInvocation, KernelExecutionScope, KernelWorkspaceMode,
};
use deepcode_kernel_tools::{KernelToolCatalogError, KernelToolRegistry, ToolAvailability};
use serde_json::json;

#[test]
fn invalid_arguments_explain_the_rejected_field() {
    let registry = KernelToolRegistry::new();
    for (tool, input, path, rule) in [
        ("bash", json!({}), "$.command", "required"),
        (
            "bash",
            json!({"command":"pwd", "executionMode":"read"}),
            "$.executionMode",
            "additionalProperties",
        ),
        (
            "bash",
            json!({"command":"pwd", "executionScope":"outside"}),
            "$.executionScope",
            "enum",
        ),
        (
            "bash",
            json!({"command":"pwd", "timeout":"slow"}),
            "$.timeout",
            "type",
        ),
        (
            "bash",
            json!({"command":"pwd", "timeout":0}),
            "$.timeout",
            "minimum",
        ),
        (
            "fs.edit",
            json!({"path":"README.md", "edits":[{"oldText":"", "newText":"updated"}]}),
            "$.edits[0].oldText",
            "minLength",
        ),
        (
            "fs.edit",
            json!({"path":"README.md", "edits":[{"oldText":"a", "newText":"b"}], "workspaceMode":"write"}),
            "$.workspaceMode",
            "additionalProperties",
        ),
    ] {
        let KernelToolCatalogError::InvalidArguments { issues, .. } =
            registry.canonicalize(tool, input).unwrap_err()
        else {
            panic!("expected input rejection for {tool}");
        };
        assert!(
            issues
                .iter()
                .any(|issue| issue.path == path && issue.rule == rule),
            "{issues:?}"
        );
    }
    assert!(matches!(
        registry.canonicalize("missing.tool", json!({})),
        Err(KernelToolCatalogError::ToolNotRegistered(_))
    ));
}

#[test]
fn shell_defaults_preserve_the_script_and_native_scope() {
    let registry = KernelToolRegistry::new();
    let script = "set -o pipefail\nprintf '%s\\n' 'literal $HOME' | head -1";
    let KernelCanonicalInvocation::ProcessShell {
        command,
        workspace_mode,
        execution_scope,
        timeout,
        terminal,
    } = registry
        .canonicalize("bash", json!({"command":script}))
        .unwrap()
    else {
        panic!("Bash invocation");
    };
    assert_eq!(command, script);
    assert_eq!(workspace_mode, KernelWorkspaceMode::Read);
    assert_eq!(execution_scope, KernelExecutionScope::Workspace);
    assert_eq!(timeout, 120);
    assert!(terminal.is_none());
    let script =
        "Get-Item -LiteralPath 'D:\\Repo Space\\file.txt'\n& git status -sb\nexit $LASTEXITCODE";
    let KernelCanonicalInvocation::ProcessPowerShell {
        command,
        execution_scope,
        ..
    } = registry
        .canonicalize(
            "powershell",
            json!({"command":script,"executionScope":"host"}),
        )
        .unwrap()
    else {
        panic!("PowerShell invocation");
    };
    assert_eq!(command, script);
    assert_eq!(execution_scope, KernelExecutionScope::Host);
}

#[test]
fn callable_descriptors_have_executor_bindings() {
    let registry = KernelToolRegistry::new();
    let bindings = registry
        .executor_bindings()
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    for descriptor in registry
        .descriptors()
        .filter(|tool| tool.availability == ToolAvailability::Callable)
    {
        assert!(
            bindings.contains(&descriptor.name.as_str()),
            "missing executor for {}",
            descriptor.name
        );
        assert_eq!(descriptor.input_schema["type"], "object");
    }
    assert!(registry.descriptor("fs.read").is_some());
    assert!(registry.descriptor("bash").is_some());
}

#[test]
fn file_invocations_keep_bounds_and_distinct_unicode_spelling() {
    let registry = KernelToolRegistry::new();
    let KernelCanonicalInvocation::FsRead {
        path,
        start_line,
        max_lines,
        ..
    } = registry
        .canonicalize(
            "fs.read",
            json!({"path":"src/lib.rs","startLine":2,"maxLines":3}),
        )
        .unwrap()
    else {
        panic!("Read invocation");
    };
    assert_eq!(path, "src/lib.rs");
    assert_eq!(start_line, 2);
    assert_eq!(max_lines, 3);
    for expected in ["e\u{301}.txt", "é.txt"] {
        let KernelCanonicalInvocation::FsRead { path, .. } = registry
            .canonicalize("fs.read", json!({"path":expected}))
            .unwrap()
        else {
            panic!("Read invocation");
        };
        assert_eq!(path, expected);
    }
    let KernelCanonicalInvocation::FsWrite { path, content, .. } = registry
        .canonicalize(
            "fs.write",
            json!({"path":"src/generated/main.rs","content":"fn main() {}\n"}),
        )
        .unwrap()
    else {
        panic!("Write invocation");
    };
    assert_eq!(path, "src/generated/main.rs");
    assert_eq!(content, "fn main() {}\n");
}
