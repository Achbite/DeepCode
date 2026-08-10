use serde::{Deserialize, Serialize};

pub mod workspace_boundary;

pub use workspace_boundary::WorkspaceBoundary;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability(pub String);

impl Capability {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn workspace_read() -> Self {
        Self::new("workspace.read")
    }

    pub fn workspace_write() -> Self {
        Self::new("workspace.write")
    }

    pub fn network_egress() -> Self {
        Self::new("network.egress")
    }

    pub fn secret_read() -> Self {
        Self::new("secret.read")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityEffect {
    ReadsWorkspace,
    WritesWorkspace,
    CreatesWorkspace,
    DeletesWorkspace,
    ReadsGit,
    RunsProcess,
    UsesNetwork,
    ReadsSecret,
    ModifiesGit,
    PushesGit,
    ControlsBrowser,
    ModifiesKernel,
    ModifiesConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[cfg(test)]
mod tests;
