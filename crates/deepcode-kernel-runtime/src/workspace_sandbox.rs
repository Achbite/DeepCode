//! Platform implementations of the existing workspace Shell policy.
use deepcode_kernel_abi::{KernelError, KernelResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
pub(crate) mod linux;
#[cfg(windows)]
pub mod windows;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStatus {
    pub backend: String,
    pub available: bool,
    pub reason: Option<String>,
}

impl SandboxStatus {
    pub(crate) fn observed(backend: &str, result: Result<(), String>) -> Self {
        Self {
            backend: backend.into(),
            available: result.is_ok(),
            reason: result.err(),
        }
    }
}

/// Capture at an environment boundary, never per LLM/tool round.
pub fn probe() -> SandboxStatus {
    #[cfg(target_os = "linux")]
    {
        linux::probe()
    }
    #[cfg(windows)]
    {
        windows::probe()
    }
    #[cfg(target_os = "macos")]
    {
        SandboxStatus::observed(
            "sandbox-exec",
            if Path::new("/usr/bin/sandbox-exec").is_file() {
                Ok(())
            } else {
                Err("sandbox-exec is unavailable.".into())
            },
        )
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        SandboxStatus::observed(
            "unavailable",
            Err("Workspace Shell is not implemented on this platform.".into()),
        )
    }
}

pub(crate) fn unavailable(tool: &str, message: impl Into<String>) -> KernelError {
    KernelError::Structured {
        code: if tool == "powershell" {
            "powershell_workspace_sandbox_unavailable"
        } else {
            "bash_workspace_sandbox_unavailable"
        },
        stage: "execution",
        message: message.into(),
        details: serde_json::json!({"toolId": tool}),
    }
}

/// Directory grants may create the authorized output directory. File grants do
/// not implicitly authorize creating or renaming entries in their parent.
pub(crate) fn writable_paths(
    root: &Path,
    mode: &str,
    targets: Option<&[crate::executors::WorkspaceWriteTarget]>,
) -> KernelResult<Vec<PathBuf>> {
    if mode == "read" {
        return Ok(Vec::new());
    }
    let Some(targets) = targets else {
        return Ok(vec![root.to_path_buf()]);
    };
    targets.iter().map(|target| {
        if target.directory {
            std::fs::create_dir_all(&target.path).map_err(|error| KernelError::Other(format!("Create authorized Shell output directory: {error}")))?;
        } else if !target.path.is_file() {
            return Err(KernelError::Structured {
                code: "workspace_shell_write_target_unavailable", stage: "execution",
                message: "A file-level Shell grant requires an existing file. Use fs.edit to create the file, or request its output directory for a generator/build command.".into(),
                details: serde_json::json!({"path": target.path}),
            });
        }
        target.path.canonicalize().map_err(|error| KernelError::Other(format!("Resolve Shell write target: {error}")))
    }).collect()
}
