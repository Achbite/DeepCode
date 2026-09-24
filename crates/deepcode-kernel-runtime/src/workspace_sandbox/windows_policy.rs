//! Translate the shared, admitted file scope; this module owns no approvals.
use crate::executors::WorkspaceWriteTarget;
use crate::file_access::FileAccessScope;
use deepcode_kernel_abi::{KernelError, KernelResult};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Access {
    Read,
    Traverse,
    Write,
    DenyWrite,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Grant {
    pub path: PathBuf,
    pub access: Access,
}

pub(super) fn grants(
    root: &Path,
    mode: &str,
    targets: Option<&[WorkspaceWriteTarget]>,
    temporary: &Path,
    executable: &Path,
    files: &FileAccessScope,
) -> KernelResult<Vec<Grant>> {
    if !matches!(mode, "read" | "write") {
        return Err(KernelError::InvalidCommand("Invalid workspace mode".into()));
    }
    let mut grants = Vec::new();
    let mut add = |path: &Path, access| {
        let grant = Grant {
            path: path.to_path_buf(),
            access,
        };
        if !grants.contains(&grant) {
            grants.push(grant);
        }
    };
    add(root, Access::Read);
    add(executable, Access::Read);
    for path in &files.read {
        add(path, Access::Read);
    }
    for path in super::writable_paths(root, mode, targets)? {
        add(&path, Access::Write);
    }
    for path in super::writable_paths(root, "write", Some(&files.write))? {
        add(&path, Access::Write);
    }
    add(temporary, Access::Write);
    if let Some(home) = &files.home {
        add(home, Access::Write);
    }
    for path in &files.read_only {
        // An exact approved resource overrides its protection. Descendant
        // exceptions use explicit allow ACEs, which precede inherited denies.
        if !files.write.iter().any(|grant| grant.path == *path) {
            add(path, Access::DenyWrite);
        }
    }
    // PowerShell resolves the casing/attributes of path ancestors. Grant only
    // traversal and metadata on those directories, with no inheritance/listing.
    let ancestors: Vec<_> = grants
        .iter()
        .filter(|grant| {
            matches!(grant.access, Access::Read | Access::Write) && grant.path != executable
        })
        .flat_map(|grant| grant.path.ancestors().skip(1))
        .filter(|path| path.is_absolute())
        .map(Path::to_path_buf)
        .collect();
    for path in ancestors {
        let grant = Grant {
            path,
            access: Access::Traverse,
        };
        if !grants.contains(&grant) {
            grants.push(grant);
        }
    }
    Ok(grants)
}

pub(super) fn capabilities(network: bool) -> Vec<&'static str> {
    // Windows runtime dependencies, not access to user documents or credentials.
    let mut names = vec![
        "registryRead",
        "lpacCom",
        "lpacCryptoServices",
        // PowerShell registers its ETW provider during startup.
        "lpacInstrumentation",
    ];
    if network {
        names.extend([
            "internetClient",
            "internetClientServer",
            "privateNetworkClientServer",
        ]);
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn read_scope_does_not_grant_workspace_writes_or_read_ancestors() {
        let root = std::env::temp_dir().join(format!(
            "deepcode-policy-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let workspace = root.join("workspace");
        let outside = root.join("outside/allowed.txt");
        let home = root.join("home");
        let scratch = root.join("scratch");
        let files = FileAccessScope {
            read: vec![outside.clone()],
            home: Some(home.clone()),
            read_only: vec![workspace.join(".git")],
            ..Default::default()
        };
        let result = grants(
            &workspace,
            "read",
            None,
            &scratch,
            Path::new("shell.exe"),
            &files,
        )
        .unwrap();
        for (path, access) in [
            (&workspace, Access::Read),
            (&outside, Access::Read),
            (&home, Access::Write),
            (&scratch, Access::Write),
        ] {
            assert!(result.contains(&Grant {
                path: path.clone(),
                access
            }));
        }
        assert!(!result.contains(&Grant {
            path: workspace,
            access: Access::Write
        }));
        assert!(!result.iter().any(|grant| (grant.path == root
            || grant.path == root.join("outside"))
            && grant.access != Access::Traverse));
        assert!(result.contains(&Grant {
            path: root,
            access: Access::Traverse
        }));
        assert!(result.iter().any(|grant| grant.access == Access::DenyWrite));
        assert!(!capabilities(false).contains(&"internetClient"));
        assert!(capabilities(true).contains(&"internetClient"));
    }

    #[test]
    fn plan_outputs_and_explicit_git_file_grant_preserve_other_protection() {
        let root = std::env::temp_dir().join(format!(
            "deepcode-policy-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let config = root.join(".git/config");
        std::fs::write(&config, "").unwrap();
        let root = root.canonicalize().unwrap();
        let config = config.canonicalize().unwrap();
        let output = root.join("output");
        let files = FileAccessScope {
            write: vec![WorkspaceWriteTarget {
                path: config.clone(),
                directory: false,
            }],
            read_only: vec![root.join(".git")],
            ..Default::default()
        };
        let targets = [WorkspaceWriteTarget {
            path: output.clone(),
            directory: true,
        }];
        let result = grants(
            &root,
            "write",
            Some(&targets),
            &root.join("scratch"),
            Path::new("shell.exe"),
            &files,
        )
        .unwrap();
        assert!(result.contains(&Grant {
            path: output.canonicalize().unwrap(),
            access: Access::Write
        }));
        assert!(result.contains(&Grant {
            path: config,
            access: Access::Write
        }));
        assert!(result.contains(&Grant {
            path: root.join(".git"),
            access: Access::DenyWrite
        }));
        assert!(!result.contains(&Grant {
            path: root.clone(),
            access: Access::Write
        }));
        std::fs::remove_dir_all(root).unwrap();
    }
}
