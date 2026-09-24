//! Native Windows implementation of the shared workspace permission scope.
//! Each invocation has its own LPAC identity. No dedicated account, elevation,
//! persistent password, or machine-wide firewall configuration is required.
use super::{windows_policy, SandboxStatus};
use crate::executors::WorkspaceWriteTarget;
use crate::file_access::FileAccessScope;
use std::path::Path;

mod acl;
mod os;
mod profile;
mod runner;
mod token;

pub(crate) use runner::Child;

pub(crate) struct Sandbox {
    // ACL cleanup must precede deleting the invocation's profile.
    acl: acl::Grants,
    profile: profile::Profile,
    grants: Vec<windows_policy::Grant>,
}

impl Sandbox {
    pub(crate) fn prepare(
        root: &Path,
        mode: &str,
        targets: Option<&[WorkspaceWriteTarget]>,
        temporary: &Path,
        executable: &Path,
        files: &FileAccessScope,
    ) -> Result<Self, String> {
        let grants = windows_policy::grants(root, mode, targets, temporary, executable, files)
            .map_err(|error| error.to_string())?;
        let profile = profile::Profile::create(files.network_access)?;
        Ok(Self {
            acl: acl::Grants::new(&profile.sid_string()?)?,
            profile,
            grants,
        })
    }

    pub(crate) fn spawn(
        &mut self,
        command: &std::process::Command,
        terminal: bool,
    ) -> Result<Child, String> {
        runner::spawn(command, terminal, &self.profile, |token| {
            self.acl.apply(&self.grants, token)
        })
    }

    pub(crate) fn cleanup(&mut self) -> Result<(), String> {
        finish(self.acl.cleanup(), self.profile.cleanup())
    }
}

pub fn probe() -> SandboxStatus {
    SandboxStatus::observed("windows-lpac", request_setup())
}

/// Retain the operator check endpoint. The backend needs no administrator setup.
/// Probe the actual LPAC launch path instead of treating an API import as support.
pub fn request_setup() -> Result<(), String> {
    let mut profile = profile::Profile::create(false)?;
    let result = runner::probe(&profile);
    finish(result, profile.cleanup())
}

fn finish<T>(result: Result<T, String>, cleanup: Result<(), String>) -> Result<T, String> {
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; cleanup failed: {cleanup}")),
    }
}
