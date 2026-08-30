use deepcode_kernel_tools::{KernelToolRegistry, ToolAvailability};
use serde_json::json;

#[test]
fn catalog_contains_the_canonical_callable_tools() {
    let registry = KernelToolRegistry::new();
    let names = registry
        .descriptors()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(names.len(), 19);
    assert!(names.contains(&"fs.read"));
    assert!(names.contains(&"fs.stat"));
    assert!(names.contains(&"fs.edit"));
    assert!(names.contains(&"web.fetch"));
    assert!(names.contains(&"github.search"));
    assert!(names.contains(&"github.read"));
    assert!(names.contains(&"arxiv.search"));
    assert!(names.contains(&"arxiv.read"));
    assert!(names.contains(&"process.shell"));
    assert_eq!(
        registry.descriptor("fs.read").unwrap().availability,
        ToolAvailability::Callable,
    );
    assert_eq!(
        registry.descriptor("fs.stat").unwrap().availability,
        ToolAvailability::Callable,
    );
    for callable in [
        "web.search",
        "web.fetch",
        "github.search",
        "github.read",
        "arxiv.search",
        "arxiv.read",
    ] {
        assert_eq!(
            registry.descriptor(callable).unwrap().availability,
            ToolAvailability::Callable,
        );
    }
    assert_eq!(
        registry.descriptor("process.shell").unwrap().availability,
        if cfg!(target_os = "macos") {
            ToolAvailability::Callable
        } else {
            ToolAvailability::Blocked
        },
    );
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

    let stat = registry
        .canonicalize("fs.stat", json!({"path":"."}))
        .unwrap();
    assert_eq!(stat.arguments, json!({"path":"."}));

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

    let digest_edit = registry
        .canonicalize(
            "fs.edit",
            json!({
                "path":"src/lib.rs",
                "matcher":{
                    "kind":"lineRange",
                    "data":{
                        "startLine":1,
                        "endLine":1,
                        "precondition":{
                            "kind":"expectedFileDigest",
                            "data":{"digest":format!("sha256:{}", "a".repeat(64))}
                        }
                    }
                },
                "replacement":"new\n"
            }),
        )
        .unwrap();
    assert_eq!(
        digest_edit.arguments["patchSpec"]["match"]["expectedFileHash"],
        format!("sha256:{}", "a".repeat(64)),
    );
    assert!(registry
        .canonicalize(
            "fs.edit",
            json!({
                "path":"src/lib.rs",
                "matcher":{
                    "kind":"lineRange",
                    "data":{
                        "startLine":1,
                        "endLine":1,
                        "precondition":{
                            "kind":"expectedFileDigest",
                            "data":{"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
                        }
                    }
                },
                "replacement":"new"
            }),
        )
        .is_err());

    #[cfg(target_os = "macos")]
    {
        let shell = registry
            .canonicalize("process.shell", json!({"command":"printf ready"}))
            .unwrap();
        assert_eq!(
            shell.arguments,
            json!({
                "command":"printf ready",
                "cwd":".",
                "timeoutMs":120000,
                "maxOutputBytes":262144
            })
        );
    }
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
    assert!(registry
        .canonicalize(
            "process.shell",
            json!({"command":"printf ok","cwd":"../outside"}),
        )
        .is_err());
    for command in [
        "mkfs.ext4 /dev/disk1",
        "diskutil eraseDisk APFS Temporary /dev/disk1",
        "rm -rf /",
        "sudo /sbin/newfs_apfs /dev/disk1",
        "sh -c 'rm -rf /'",
    ] {
        assert!(
            registry
                .canonicalize("process.shell", json!({"command":command}))
                .is_err(),
            "hard-denied command unexpectedly canonicalized: {command}"
        );
    }
    #[cfg(target_os = "macos")]
    assert!(registry
        .canonicalize(
            "process.shell",
            json!({"command":"rm -rf target && printf done","cwd":"."}),
        )
        .is_ok());
    assert_eq!(
        registry
            .descriptor("fs.glob")
            .unwrap()
            .input_schema["properties"]["path"]["description"],
        "Optional normalized workspace-relative directory. Omit it for the workspace root; if explicitly provided for the root, use '.' and never an empty string."
    );
}
