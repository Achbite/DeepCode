use deepcode_kernel_abi::{KernelError, KernelResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

mod environment;
mod grant_v2;
pub mod workspace_boundary;

pub use environment::{
    ExecutionEnvironmentDecision, ExecutionEnvironmentPolicy, HostShellOverride,
    ShellRuntimePreference,
};
pub use grant_v2::{
    evaluate_capability_grant_auto_issue_v2, CapabilityGrantAutoIssueCandidateV2,
    CapabilityGrantAutoIssueDecisionV2, CapabilityGrantAutoIssueEvaluationV2,
    CapabilityGrantAutoIssueReasonV2, GrantAutonomyModeV2, GrantResolvedScopeV2,
};
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

    pub fn git_read() -> Self {
        Self::new("git.read")
    }

    pub fn git_write() -> Self {
        Self::new("git.write")
    }

    pub fn git_push() -> Self {
        Self::new("git.push")
    }

    pub fn process_exec() -> Self {
        Self::new("process.exec")
    }

    pub fn network_egress() -> Self {
        Self::new("network.egress")
    }

    pub fn browser_control() -> Self {
        Self::new("browser.control")
    }

    pub fn secret_read() -> Self {
        Self::new("secret.read")
    }

    pub fn config_modify() -> Self {
        Self::new("config.modify")
    }

    pub fn kernel_modify() -> Self {
        Self::new("kernel.modify")
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PolicyDecisionKind {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PolicySourceTrust {
    Kernel,
    System,
    User,
    Workspace,
    ExternalConnector,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutonomyLevel {
    Safe,
    Developer,
    Trusted,
    Expert,
    MaintainerRoot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceScopeKind {
    WorkspaceFile,
    WorkspaceConfigAsset,
    ManagedReference,
    ExternalReadOnlyFile,
    ExternalFile,
    TempArtifact,
    Process,
    Git,
    Network,
    Secret,
    Kernel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceScope {
    pub kind: ResourceScopeKind,
    pub path: Option<String>,
    pub managed_by_kernel: bool,
}

impl ResourceScope {
    pub fn workspace_file(path: impl Into<String>) -> Self {
        let path = path.into();
        let kind = if is_deepcode_config_asset(&path) {
            ResourceScopeKind::WorkspaceConfigAsset
        } else {
            ResourceScopeKind::WorkspaceFile
        };
        Self {
            kind,
            path: Some(path),
            managed_by_kernel: false,
        }
    }

    pub fn external_file(path: impl Into<String>) -> Self {
        Self {
            kind: ResourceScopeKind::ExternalFile,
            path: Some(path.into()),
            managed_by_kernel: false,
        }
    }

    pub fn temp_artifact(path: impl Into<String>) -> Self {
        Self {
            kind: ResourceScopeKind::TempArtifact,
            path: Some(path.into()),
            managed_by_kernel: true,
        }
    }

    pub fn process() -> Self {
        Self {
            kind: ResourceScopeKind::Process,
            path: None,
            managed_by_kernel: false,
        }
    }

    pub fn is_workspace_config_asset(&self) -> bool {
        self.kind == ResourceScopeKind::WorkspaceConfigAsset
            || self
                .path
                .as_deref()
                .map(is_deepcode_config_asset)
                .unwrap_or(false)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskBudget {
    pub max_tool_calls: u32,
    pub max_file_writes: u32,
    pub max_process_exec: u32,
    pub allow_destructive: bool,
}

impl RiskBudget {
    pub fn safe() -> Self {
        Self {
            max_tool_calls: 20,
            max_file_writes: 0,
            max_process_exec: 0,
            allow_destructive: false,
        }
    }

    pub fn developer() -> Self {
        Self {
            max_tool_calls: 80,
            max_file_writes: 30,
            max_process_exec: 10,
            allow_destructive: false,
        }
    }

    pub fn maintainer() -> Self {
        Self {
            max_tool_calls: 160,
            max_file_writes: 100,
            max_process_exec: 40,
            allow_destructive: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EffectSurface {
    Workspace,
    DeepcodeConfig,
    ExternalReadOnly,
    SystemPath,
    Process,
    Network,
    Secret,
    Kernel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchSize {
    Single,
    Bounded(u32),
    Unbounded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Persistence {
    Ephemeral,
    Run,
    Session,
    Persistent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutsideWorkspace {
    Forbidden,
    ReadOnlyReference,
    ManagedCopy,
    WritableOverride,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HardFloor {
    UnboundedSystemMutation,
    OutsideWorkspaceWrite,
    SecretExposure,
    KernelModifyWithoutMaintainer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionImpact {
    pub effect_surface: EffectSurface,
    pub batch_size: BatchSize,
    pub persistence: Persistence,
    pub outside_workspace: OutsideWorkspace,
    pub hard_floor: Option<HardFloor>,
}

impl Default for PermissionImpact {
    fn default() -> Self {
        Self {
            effect_surface: EffectSurface::Workspace,
            batch_size: BatchSize::Single,
            persistence: Persistence::Run,
            outside_workspace: OutsideWorkspace::Forbidden,
            hard_floor: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyGrant {
    pub capability: Capability,
    pub decision: PolicyDecisionKind,
    pub source: PolicySourceTrust,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyProfile {
    pub id: String,
    pub autonomy_level: AutonomyLevel,
    pub default_decision: PolicyDecisionKind,
    pub grants: BTreeMap<String, PolicyGrant>,
    pub rules: Vec<Value>,
    pub risk_budget: RiskBudget,
    pub execution_environment: ExecutionEnvironmentPolicy,
}

impl PolicyProfile {
    pub fn new(id: impl Into<String>, default_decision: PolicyDecisionKind) -> Self {
        Self {
            id: id.into(),
            autonomy_level: AutonomyLevel::Developer,
            default_decision,
            grants: BTreeMap::new(),
            rules: Vec::new(),
            risk_budget: RiskBudget::developer(),
            execution_environment: ExecutionEnvironmentPolicy::linux_default(),
        }
    }

    pub fn safe_defaults() -> Self {
        let mut profile = Self::new("safe", PolicyDecisionKind::Deny);
        profile.autonomy_level = AutonomyLevel::Safe;
        profile.risk_budget = RiskBudget::safe();
        for capability in [Capability::workspace_read(), Capability::git_read()] {
            profile
                .grant(PolicyGrant {
                    capability,
                    decision: PolicyDecisionKind::Allow,
                    source: PolicySourceTrust::Kernel,
                    reason: Some("safe profile read-only workspace capability".to_string()),
                })
                .expect("kernel grant");
        }
        for capability in [
            Capability::workspace_write(),
            Capability::process_exec(),
            Capability::git_write(),
            Capability::git_push(),
        ] {
            profile
                .grant(PolicyGrant {
                    capability,
                    decision: PolicyDecisionKind::Ask,
                    source: PolicySourceTrust::Kernel,
                    reason: Some("safe profile requires approval".to_string()),
                })
                .expect("kernel grant");
        }
        profile
    }

    pub fn developer_defaults() -> Self {
        let mut profile = Self::new("developer", PolicyDecisionKind::Deny);
        profile.autonomy_level = AutonomyLevel::Developer;
        profile
            .grant(PolicyGrant {
                capability: Capability::workspace_read(),
                decision: PolicyDecisionKind::Allow,
                source: PolicySourceTrust::Kernel,
                reason: Some("builtin read capability".to_string()),
            })
            .expect("kernel grant");
        profile
            .grant(PolicyGrant {
                capability: Capability::git_read(),
                decision: PolicyDecisionKind::Allow,
                source: PolicySourceTrust::Kernel,
                reason: Some("builtin git read capability".to_string()),
            })
            .expect("kernel grant");
        for capability in [
            Capability::workspace_write(),
            Capability::process_exec(),
            Capability::git_write(),
            Capability::git_push(),
        ] {
            profile
                .grant(PolicyGrant {
                    capability,
                    decision: PolicyDecisionKind::Ask,
                    source: PolicySourceTrust::Kernel,
                    reason: Some("high risk operation requires approval".to_string()),
                })
                .expect("kernel grant");
        }
        for capability in [Capability::secret_read(), Capability::kernel_modify()] {
            profile
                .grant(PolicyGrant {
                    capability,
                    decision: PolicyDecisionKind::Deny,
                    source: PolicySourceTrust::Kernel,
                    reason: Some("critical capability denied by default".to_string()),
                })
                .expect("kernel grant");
        }
        profile
    }

    pub fn trusted_workspace_defaults() -> Self {
        let mut profile = Self::developer_defaults();
        profile.id = "trusted".to_string();
        profile.autonomy_level = AutonomyLevel::Trusted;
        for capability in [
            Capability::workspace_read(),
            Capability::workspace_write(),
            Capability::git_read(),
        ] {
            profile
                .grant(PolicyGrant {
                    capability,
                    decision: PolicyDecisionKind::Allow,
                    source: PolicySourceTrust::Kernel,
                    reason: Some("trusted profile full ordinary workspace access".to_string()),
                })
                .expect("kernel grant");
        }
        profile
    }

    pub fn expert_defaults() -> Self {
        let mut profile = Self::trusted_workspace_defaults();
        profile.id = "expert".to_string();
        profile.autonomy_level = AutonomyLevel::Expert;
        profile
            .grant(PolicyGrant {
                capability: Capability::process_exec(),
                decision: PolicyDecisionKind::Ask,
                source: PolicySourceTrust::Kernel,
                reason: Some("expert profile still audits process execution".to_string()),
            })
            .expect("kernel grant");
        profile
    }

    pub fn maintainer_defaults() -> Self {
        let mut profile = Self::expert_defaults();
        profile.id = "maintainer".to_string();
        profile.autonomy_level = AutonomyLevel::MaintainerRoot;
        profile.risk_budget = RiskBudget::maintainer();
        profile
            .grant(PolicyGrant {
                capability: Capability::kernel_modify(),
                decision: PolicyDecisionKind::Ask,
                source: PolicySourceTrust::Kernel,
                reason: Some("kernel self-modify requires explicit workflow".to_string()),
            })
            .expect("kernel grant");
        profile
    }

    pub fn grant(&mut self, grant: PolicyGrant) -> KernelResult<()> {
        if grant.source == PolicySourceTrust::Workspace
            && grant.decision == PolicyDecisionKind::Allow
        {
            return Err(KernelError::PermissionDenied(
                "workspace policy source cannot grant allow permissions".to_string(),
            ));
        }
        self.grants.insert(grant.capability.0.clone(), grant);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    pub run_id: Option<String>,
    pub capability: Capability,
    pub risk_level: RiskLevel,
    pub summary: String,
    pub args_preview: Value,
    pub skill_id: Option<String>,
    pub effects: Vec<CapabilityEffect>,
    pub source_trust: Option<PolicySourceTrust>,
    pub resource_scope: Option<ResourceScope>,
    #[serde(default)]
    pub impact: PermissionImpact,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    pub decision: PolicyDecisionKind,
    pub reason: Option<String>,
    pub request: Option<PermissionRequest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub request_id: String,
    pub decision: PolicyDecisionKind,
    pub reason: Option<String>,
}

pub trait PermissionGate {
    fn evaluate(
        &self,
        profile: &PolicyProfile,
        request: &PermissionRequest,
    ) -> KernelResult<PolicyDecision>;
}

#[derive(Debug, Clone, Default)]
pub struct DefaultPermissionGate;

impl PermissionGate for DefaultPermissionGate {
    fn evaluate(
        &self,
        profile: &PolicyProfile,
        request: &PermissionRequest,
    ) -> KernelResult<PolicyDecision> {
        if request.capability.0.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "permission capability is required".to_string(),
            ));
        }

        let hard_floor = detect_hard_floor(profile, request);
        if let Some(hard_floor) = hard_floor.clone() {
            if hard_floor != HardFloor::OutsideWorkspaceWrite {
                return Ok(PolicyDecision {
                    decision: PolicyDecisionKind::Deny,
                    reason: Some(format!("hard floor denied: {hard_floor:?}")),
                    request: None,
                });
            }
        }

        if resource_is_protected_config_asset(request)
            && is_workspace_file_mutation(&request.capability)
        {
            return Ok(PolicyDecision {
                decision: PolicyDecisionKind::Deny,
                reason: Some(
                    "ordinary workspace full access does not cover .deepcode config assets"
                        .to_string(),
                ),
                request: None,
            });
        }

        if let Some(hard_floor) = hard_floor {
            return Ok(PolicyDecision {
                decision: PolicyDecisionKind::Deny,
                reason: Some(format!("hard floor denied: {hard_floor:?}")),
                request: None,
            });
        }

        let grant = profile.grants.get(&request.capability.0);
        let decision = grant
            .map(|grant| grant.decision.clone())
            .unwrap_or_else(|| profile.default_decision.clone());

        let reason = grant
            .and_then(|grant| grant.reason.clone())
            .or_else(|| Some(format!("policy profile {} decision", profile.id)));

        Ok(PolicyDecision {
            request: if decision == PolicyDecisionKind::Ask {
                Some(request.clone())
            } else {
                None
            },
            decision,
            reason,
        })
    }
}

fn detect_hard_floor(profile: &PolicyProfile, request: &PermissionRequest) -> Option<HardFloor> {
    if let Some(hard_floor) = request.impact.hard_floor.clone() {
        return Some(hard_floor);
    }

    if request.capability == Capability::kernel_modify()
        && profile.autonomy_level != AutonomyLevel::MaintainerRoot
    {
        return Some(HardFloor::KernelModifyWithoutMaintainer);
    }

    if request.capability == Capability::secret_read()
        && request.source_trust == Some(PolicySourceTrust::ExternalConnector)
    {
        return Some(HardFloor::SecretExposure);
    }

    if is_workspace_file_mutation(&request.capability)
        && matches!(
            request.impact.outside_workspace,
            OutsideWorkspace::ReadOnlyReference | OutsideWorkspace::WritableOverride
        )
    {
        return Some(HardFloor::OutsideWorkspaceWrite);
    }

    if request.capability == Capability::workspace_write()
        && (request.impact.effect_surface == EffectSurface::SystemPath
            || request.impact.batch_size == BatchSize::Unbounded)
    {
        return Some(HardFloor::UnboundedSystemMutation);
    }

    None
}

fn is_workspace_file_mutation(capability: &Capability) -> bool {
    capability == &Capability::workspace_write()
}

fn resource_is_protected_config_asset(request: &PermissionRequest) -> bool {
    request
        .resource_scope
        .as_ref()
        .map(ResourceScope::is_workspace_config_asset)
        .unwrap_or(false)
}

fn is_deepcode_config_asset(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    [".deepcode/skills/", ".deepcode/ruler/", ".deepcode/policy/"]
        .iter()
        .any(|prefix| normalized == prefix.trim_end_matches('/') || normalized.starts_with(prefix))
}

#[cfg(test)]
mod tests;
