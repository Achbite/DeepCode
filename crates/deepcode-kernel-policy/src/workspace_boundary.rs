use deepcode_kernel_abi::{KernelError, KernelResult};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone)]
pub struct WorkspaceBoundary {
    root: PathBuf,
}

impl WorkspaceBoundary {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn resolve(&self, relative_path: &str) -> KernelResult<PathBuf> {
        if relative_path.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "workspace path is required".to_string(),
            ));
        }
        let relative = Path::new(relative_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
            || looks_like_windows_drive_path(relative_path)
        {
            return Err(KernelError::PermissionDenied(format!(
                "workspace syscall requires a workspace-relative path: {relative_path}"
            )));
        }
        Ok(self.root.join(relative))
    }

    pub fn assert_mutable_config_asset(path: &str) -> KernelResult<()> {
        let normalized = path.replace('\\', "/");
        let protected = [".deepcode/skills/", ".deepcode/ruler/", ".deepcode/policy/"];
        if protected.iter().any(|prefix| {
            normalized == prefix.trim_end_matches('/') || normalized.starts_with(prefix)
        }) {
            return Err(KernelError::PermissionDenied(
                "ordinary workspace mutation cannot modify .deepcode config assets".to_string(),
            ));
        }
        Ok(())
    }
}

fn looks_like_windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
        && (bytes[0] as char).is_ascii_alphabetic()
}
