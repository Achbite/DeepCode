use serde::{Deserialize, Serialize};

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
