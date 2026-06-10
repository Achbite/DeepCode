use deepcode_kernel_abi::{KernelError, KernelResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

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

    pub fn workspace_preview_diff() -> Self {
        Self::new("workspace.preview_diff")
    }

    pub fn workspace_write() -> Self {
        Self::new("workspace.write")
    }

    pub fn workspace_create() -> Self {
        Self::new("workspace.create")
    }

    pub fn workspace_delete() -> Self {
        Self::new("workspace.delete")
    }

    pub fn workspace_rename() -> Self {
        Self::new("workspace.rename")
    }

    pub fn workspace_list() -> Self {
        Self::new("workspace.list")
    }

    pub fn workspace_search() -> Self {
        Self::new("workspace.search")
    }

    pub fn git_read() -> Self {
        Self::new("git.read")
    }

    pub fn git_write() -> Self {
        Self::new("git.write")
    }

    pub fn process_propose() -> Self {
        Self::new("process.propose")
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

    pub fn matches_request(&self, request: &ResourceScope) -> bool {
        self.kind == request.kind
            && self
                .path
                .as_deref()
                .map(|path| request.path.as_deref() == Some(path))
                .unwrap_or(true)
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
pub struct TemporaryGrant {
    pub id: String,
    pub run_id: String,
    pub capability: Capability,
    pub resource_scope: ResourceScope,
    pub decision: PolicyDecisionKind,
    pub expires_after_sequence: Option<u64>,
    pub reason: Option<String>,
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
    RecursiveSystemDelete,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellRuntimePreference {
    LinuxDefault,
    Wsl,
    PowerShell,
    Cmd,
    Bash,
    Zsh,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostShellOverride {
    pub shell: ShellRuntimePreference,
    pub reason: Option<String>,
    pub acknowledged_risk: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEnvironmentPolicy {
    pub prefer_docker: bool,
    pub default_shell: ShellRuntimePreference,
    pub allow_host_shell_override: bool,
    pub host_shell_override: Option<HostShellOverride>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEnvironmentDecision {
    pub shell: ShellRuntimePreference,
    pub prefer_docker: bool,
    pub requires_wsl_install: bool,
    pub message_key: Option<String>,
    pub host_override_recorded: bool,
}

impl ExecutionEnvironmentPolicy {
    pub fn linux_default() -> Self {
        Self {
            prefer_docker: true,
            default_shell: ShellRuntimePreference::LinuxDefault,
            allow_host_shell_override: true,
            host_shell_override: None,
        }
    }

    pub fn windows_default() -> Self {
        Self {
            prefer_docker: true,
            default_shell: ShellRuntimePreference::Wsl,
            allow_host_shell_override: true,
            host_shell_override: None,
        }
    }

    pub fn decide_windows_shell(&self, wsl_available: bool) -> ExecutionEnvironmentDecision {
        if let Some(host_override) = &self.host_shell_override {
            return ExecutionEnvironmentDecision {
                shell: host_override.shell.clone(),
                prefer_docker: self.prefer_docker,
                requires_wsl_install: false,
                message_key: Some("execution.hostShellOverride".to_string()),
                host_override_recorded: true,
            };
        }

        ExecutionEnvironmentDecision {
            shell: ShellRuntimePreference::Wsl,
            prefer_docker: self.prefer_docker,
            requires_wsl_install: !wsl_available,
            message_key: (!wsl_available)
                .then(|| "execution.windows.wslInstallRequired".to_string()),
            host_override_recorded: false,
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
    pub temporary_grants: Vec<TemporaryGrant>,
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
            temporary_grants: Vec::new(),
            execution_environment: ExecutionEnvironmentPolicy::linux_default(),
        }
    }

    pub fn safe_defaults() -> Self {
        let mut profile = Self::new("safe", PolicyDecisionKind::Deny);
        profile.autonomy_level = AutonomyLevel::Safe;
        profile.risk_budget = RiskBudget::safe();
        for capability in [
            Capability::workspace_read(),
            Capability::workspace_list(),
            Capability::workspace_search(),
            Capability::workspace_preview_diff(),
        ] {
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
            Capability::workspace_create(),
            Capability::workspace_delete(),
            Capability::process_exec(),
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
                capability: Capability::workspace_preview_diff(),
                decision: PolicyDecisionKind::Allow,
                source: PolicySourceTrust::Kernel,
                reason: Some("builtin diff preview capability".to_string()),
            })
            .expect("kernel grant");
        profile
            .grant(PolicyGrant {
                capability: Capability::process_propose(),
                decision: PolicyDecisionKind::Allow,
                source: PolicySourceTrust::Kernel,
                reason: Some("shell proposal is dry-run".to_string()),
            })
            .expect("kernel grant");
        for capability in [Capability::workspace_write(), Capability::process_exec()] {
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
            Capability::workspace_list(),
            Capability::workspace_search(),
            Capability::workspace_preview_diff(),
            Capability::workspace_write(),
            Capability::workspace_rename(),
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
        for capability in [
            Capability::workspace_create(),
            Capability::workspace_delete(),
        ] {
            profile
                .grant(PolicyGrant {
                    capability,
                    decision: PolicyDecisionKind::Ask,
                    source: PolicySourceTrust::Kernel,
                    reason: Some(
                        "create/delete are isolated higher-risk workspace capabilities".to_string(),
                    ),
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

    pub fn grant_temporary(&mut self, grant: TemporaryGrant) -> KernelResult<()> {
        if grant.decision == PolicyDecisionKind::Allow
            && grant.resource_scope.kind == ResourceScopeKind::Kernel
            && self.autonomy_level != AutonomyLevel::MaintainerRoot
        {
            return Err(KernelError::PermissionDenied(
                "kernel.modify temporary grants require maintainer/root autonomy".to_string(),
            ));
        }
        self.temporary_grants.push(grant);
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

        if let Some(hard_floor) = detect_hard_floor(profile, request) {
            return Ok(PolicyDecision {
                decision: PolicyDecisionKind::Deny,
                reason: Some(format!("hard floor denied: {hard_floor:?}")),
                request: None,
            });
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

        if let Some(temporary) = matching_temporary_grant(profile, request) {
            return Ok(PolicyDecision {
                request: if temporary.decision == PolicyDecisionKind::Ask {
                    Some(request.clone())
                } else {
                    None
                },
                decision: temporary.decision.clone(),
                reason: temporary
                    .reason
                    .clone()
                    .or_else(|| Some(format!("temporary grant {}", temporary.id))),
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

    if request.capability == Capability::workspace_delete()
        && (request.impact.effect_surface == EffectSurface::SystemPath
            || request.impact.batch_size == BatchSize::Unbounded)
    {
        return Some(HardFloor::RecursiveSystemDelete);
    }

    None
}

fn matching_temporary_grant<'a>(
    profile: &'a PolicyProfile,
    request: &PermissionRequest,
) -> Option<&'a TemporaryGrant> {
    profile.temporary_grants.iter().find(|grant| {
        request.run_id.as_deref() == Some(grant.run_id.as_str())
            && request.capability == grant.capability
            && request
                .resource_scope
                .as_ref()
                .map(|scope| grant.resource_scope.matches_request(scope))
                .unwrap_or(false)
    })
}

fn is_workspace_file_mutation(capability: &Capability) -> bool {
    capability == &Capability::workspace_write()
        || capability == &Capability::workspace_create()
        || capability == &Capability::workspace_delete()
        || capability == &Capability::workspace_rename()
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
    [
        ".deepcode/prompts/",
        ".deepcode/skills/",
        ".deepcode/ruler/",
        ".deepcode/policy/",
    ]
    .iter()
    .any(|prefix| normalized == prefix.trim_end_matches('/') || normalized.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn request(capability: Capability, risk_level: RiskLevel) -> PermissionRequest {
        PermissionRequest {
            id: "perm-1".to_string(),
            run_id: Some("run-1".to_string()),
            capability,
            risk_level,
            summary: "permission".to_string(),
            args_preview: serde_json::json!({}),
            skill_id: None,
            effects: Vec::new(),
            source_trust: None,
            resource_scope: Some(ResourceScope::workspace_file("src/main.rs")),
            impact: PermissionImpact::default(),
        }
    }

    #[test]
    fn developer_profile_allows_read_and_asks_write() {
        let profile = PolicyProfile::developer_defaults();
        let gate = DefaultPermissionGate;

        let read = gate
            .evaluate(
                &profile,
                &request(Capability::workspace_read(), RiskLevel::Low),
            )
            .unwrap();
        assert_eq!(read.decision, PolicyDecisionKind::Allow);
        assert!(read.request.is_none());

        let write = gate
            .evaluate(
                &profile,
                &request(Capability::workspace_write(), RiskLevel::High),
            )
            .unwrap();
        assert_eq!(write.decision, PolicyDecisionKind::Ask);
        assert!(write.request.is_some());
    }

    #[test]
    fn missing_capability_denies_by_default() {
        let profile = PolicyProfile::developer_defaults();
        let gate = DefaultPermissionGate;
        let decision = gate
            .evaluate(
                &profile,
                &request(Capability::network_egress(), RiskLevel::High),
            )
            .unwrap();
        assert_eq!(decision.decision, PolicyDecisionKind::Deny);
    }

    #[test]
    fn workspace_source_cannot_self_grant_allow() {
        let mut profile = PolicyProfile::developer_defaults();
        let error = profile
            .grant(PolicyGrant {
                capability: Capability::process_exec(),
                decision: PolicyDecisionKind::Allow,
                source: PolicySourceTrust::Workspace,
                reason: Some("workspace requested shell".to_string()),
            })
            .unwrap_err();

        assert!(matches!(error, KernelError::PermissionDenied(_)));
    }

    #[test]
    fn autonomy_profiles_have_expected_permission_matrix() {
        let gate = DefaultPermissionGate;

        let safe = PolicyProfile::safe_defaults();
        let safe_write = gate
            .evaluate(
                &safe,
                &request(Capability::workspace_write(), RiskLevel::High),
            )
            .unwrap();
        assert_eq!(safe_write.decision, PolicyDecisionKind::Ask);

        let trusted = PolicyProfile::trusted_workspace_defaults();
        let trusted_write = gate
            .evaluate(
                &trusted,
                &request(Capability::workspace_write(), RiskLevel::High),
            )
            .unwrap();
        assert_eq!(trusted_write.decision, PolicyDecisionKind::Allow);

        let trusted_create = gate
            .evaluate(
                &trusted,
                &request(Capability::workspace_create(), RiskLevel::High),
            )
            .unwrap();
        assert_eq!(trusted_create.decision, PolicyDecisionKind::Ask);

        let trusted_delete = gate
            .evaluate(
                &trusted,
                &request(Capability::workspace_delete(), RiskLevel::High),
            )
            .unwrap();
        assert_eq!(trusted_delete.decision, PolicyDecisionKind::Ask);

        let expert = PolicyProfile::expert_defaults();
        let expert_shell = gate
            .evaluate(
                &expert,
                &request(Capability::process_exec(), RiskLevel::High),
            )
            .unwrap();
        assert_eq!(expert_shell.decision, PolicyDecisionKind::Ask);

        let maintainer = PolicyProfile::maintainer_defaults();
        let kernel_modify = gate
            .evaluate(
                &maintainer,
                &PermissionRequest {
                    resource_scope: Some(ResourceScope {
                        kind: ResourceScopeKind::Kernel,
                        path: None,
                        managed_by_kernel: true,
                    }),
                    ..request(Capability::kernel_modify(), RiskLevel::Critical)
                },
            )
            .unwrap();
        assert_eq!(kernel_modify.decision, PolicyDecisionKind::Ask);
    }

    #[test]
    fn trusted_workspace_full_access_does_not_cover_deepcode_config_assets() {
        let gate = DefaultPermissionGate;
        let profile = PolicyProfile::trusted_workspace_defaults();
        let decision = gate
            .evaluate(
                &profile,
                &PermissionRequest {
                    resource_scope: Some(ResourceScope::workspace_file(
                        ".deepcode/prompts/project-agent.md",
                    )),
                    ..request(Capability::workspace_write(), RiskLevel::High)
                },
            )
            .unwrap();

        assert_eq!(decision.decision, PolicyDecisionKind::Deny);
        assert!(decision
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains(".deepcode"));
    }

    #[test]
    fn temporary_grant_is_run_capability_and_resource_scoped() {
        let gate = DefaultPermissionGate;
        let mut profile = PolicyProfile::safe_defaults();
        profile
            .grant_temporary(TemporaryGrant {
                id: "grant-1".to_string(),
                run_id: "run-allowed".to_string(),
                capability: Capability::workspace_write(),
                resource_scope: ResourceScope::workspace_file("src/main.rs"),
                decision: PolicyDecisionKind::Allow,
                expires_after_sequence: Some(20),
                reason: Some("user accepted temporary write".to_string()),
            })
            .unwrap();

        let allowed = gate
            .evaluate(
                &profile,
                &PermissionRequest {
                    run_id: Some("run-allowed".to_string()),
                    resource_scope: Some(ResourceScope::workspace_file("src/main.rs")),
                    ..request(Capability::workspace_write(), RiskLevel::High)
                },
            )
            .unwrap();
        assert_eq!(allowed.decision, PolicyDecisionKind::Allow);

        let different_run = gate
            .evaluate(
                &profile,
                &PermissionRequest {
                    run_id: Some("run-other".to_string()),
                    resource_scope: Some(ResourceScope::workspace_file("src/main.rs")),
                    ..request(Capability::workspace_write(), RiskLevel::High)
                },
            )
            .unwrap();
        assert_eq!(different_run.decision, PolicyDecisionKind::Ask);

        let different_resource = gate
            .evaluate(
                &profile,
                &PermissionRequest {
                    run_id: Some("run-allowed".to_string()),
                    resource_scope: Some(ResourceScope::workspace_file("src/lib.rs")),
                    ..request(Capability::workspace_write(), RiskLevel::High)
                },
            )
            .unwrap();
        assert_eq!(different_resource.decision, PolicyDecisionKind::Ask);
    }

    #[test]
    fn hard_floor_denies_before_temporary_grant() {
        let gate = DefaultPermissionGate;
        let mut profile = PolicyProfile::maintainer_defaults();
        profile
            .grant_temporary(TemporaryGrant {
                id: "grant-delete".to_string(),
                run_id: "run-1".to_string(),
                capability: Capability::workspace_delete(),
                resource_scope: ResourceScope::workspace_file("src"),
                decision: PolicyDecisionKind::Allow,
                expires_after_sequence: None,
                reason: Some("user allowed cleanup".to_string()),
            })
            .unwrap();

        let decision = gate
            .evaluate(
                &profile,
                &PermissionRequest {
                    resource_scope: Some(ResourceScope::workspace_file("src")),
                    impact: PermissionImpact {
                        effect_surface: EffectSurface::SystemPath,
                        batch_size: BatchSize::Unbounded,
                        persistence: Persistence::Persistent,
                        outside_workspace: OutsideWorkspace::Forbidden,
                        hard_floor: None,
                    },
                    ..request(Capability::workspace_delete(), RiskLevel::Critical)
                },
            )
            .unwrap();

        assert_eq!(decision.decision, PolicyDecisionKind::Deny);
        assert!(decision
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("hard floor"));
    }

    #[test]
    fn outside_workspace_write_is_non_overridable() {
        let gate = DefaultPermissionGate;
        let profile = PolicyProfile::trusted_workspace_defaults();
        let decision = gate
            .evaluate(
                &profile,
                &PermissionRequest {
                    resource_scope: Some(ResourceScope {
                        kind: ResourceScopeKind::ExternalReadOnlyFile,
                        path: Some("../research.md".to_string()),
                        managed_by_kernel: false,
                    }),
                    impact: PermissionImpact {
                        effect_surface: EffectSurface::ExternalReadOnly,
                        outside_workspace: OutsideWorkspace::ReadOnlyReference,
                        ..PermissionImpact::default()
                    },
                    ..request(Capability::workspace_write(), RiskLevel::Critical)
                },
            )
            .unwrap();

        assert_eq!(decision.decision, PolicyDecisionKind::Deny);
    }

    #[test]
    fn kernel_modify_requires_maintainer_autonomy_floor() {
        let gate = DefaultPermissionGate;
        let trusted = PolicyProfile::trusted_workspace_defaults();
        let denied = gate
            .evaluate(
                &trusted,
                &PermissionRequest {
                    resource_scope: Some(ResourceScope {
                        kind: ResourceScopeKind::Kernel,
                        path: None,
                        managed_by_kernel: true,
                    }),
                    impact: PermissionImpact {
                        effect_surface: EffectSurface::Kernel,
                        persistence: Persistence::Persistent,
                        ..PermissionImpact::default()
                    },
                    ..request(Capability::kernel_modify(), RiskLevel::Critical)
                },
            )
            .unwrap();
        assert_eq!(denied.decision, PolicyDecisionKind::Deny);

        let maintainer = PolicyProfile::maintainer_defaults();
        let ask = gate
            .evaluate(
                &maintainer,
                &PermissionRequest {
                    resource_scope: Some(ResourceScope {
                        kind: ResourceScopeKind::Kernel,
                        path: None,
                        managed_by_kernel: true,
                    }),
                    impact: PermissionImpact {
                        effect_surface: EffectSurface::Kernel,
                        persistence: Persistence::Persistent,
                        ..PermissionImpact::default()
                    },
                    ..request(Capability::kernel_modify(), RiskLevel::Critical)
                },
            )
            .unwrap();
        assert_eq!(ask.decision, PolicyDecisionKind::Ask);
    }

    #[test]
    fn windows_shell_policy_defaults_to_wsl_and_respects_override() {
        let policy = ExecutionEnvironmentPolicy::windows_default();
        let missing_wsl = policy.decide_windows_shell(false);
        assert_eq!(missing_wsl.shell, ShellRuntimePreference::Wsl);
        assert!(missing_wsl.requires_wsl_install);
        assert_eq!(
            missing_wsl.message_key.as_deref(),
            Some("execution.windows.wslInstallRequired")
        );

        let policy = ExecutionEnvironmentPolicy {
            host_shell_override: Some(HostShellOverride {
                shell: ShellRuntimePreference::PowerShell,
                reason: Some("user explicitly requested Windows shell".to_string()),
                acknowledged_risk: true,
            }),
            ..ExecutionEnvironmentPolicy::windows_default()
        };
        let override_decision = policy.decide_windows_shell(false);
        assert_eq!(override_decision.shell, ShellRuntimePreference::PowerShell);
        assert!(override_decision.host_override_recorded);
        assert!(!override_decision.requires_wsl_install);
    }

    #[test]
    fn docker_policy_is_default_recommendation_not_hard_requirement() {
        let policy = ExecutionEnvironmentPolicy {
            prefer_docker: false,
            host_shell_override: Some(HostShellOverride {
                shell: ShellRuntimePreference::Cmd,
                reason: Some("user disabled Docker".to_string()),
                acknowledged_risk: true,
            }),
            ..ExecutionEnvironmentPolicy::windows_default()
        };
        let decision = policy.decide_windows_shell(true);

        assert!(!decision.prefer_docker);
        assert_eq!(decision.shell, ShellRuntimePreference::Cmd);
        assert!(decision.host_override_recorded);
    }

    #[test]
    fn workspace_boundary_rejects_escaped_paths() {
        let boundary = WorkspaceBoundary::new("/workspace");
        for path in ["/etc/passwd", "../secret.txt", "C:/Users/test/file.txt"] {
            assert!(
                boundary.resolve(path).is_err(),
                "{path} must not resolve through the workspace boundary"
            );
        }
        assert_eq!(
            boundary.resolve("src/main.rs").unwrap(),
            PathBuf::from("/workspace").join("src/main.rs")
        );
    }

    #[test]
    fn workspace_boundary_blocks_protected_config_asset_mutation() {
        assert!(WorkspaceBoundary::assert_mutable_config_asset("src/lib.rs").is_ok());
        assert!(
            WorkspaceBoundary::assert_mutable_config_asset(".deepcode/policy/rules.json").is_err()
        );
        assert!(
            WorkspaceBoundary::assert_mutable_config_asset(".deepcode\\skills\\demo.json").is_err()
        );
    }
}
