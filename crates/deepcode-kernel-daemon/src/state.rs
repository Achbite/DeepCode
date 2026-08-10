use crate::prelude::*;
use crate::*;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) kernel_v2: crate::kernel_v2_transport::KernelV2TransportState,
    pub(crate) kernel_session_v2: crate::host_kernel_run_v2::HostKernelRunCoordinatorV2,
    pub(crate) kernel_wake_v2: crate::host_kernel_wake_v2::HostKernelWakeSupervisorV2,
    pub(crate) startup_readiness_v2: crate::startup_readiness_v2::HostStartupReadinessV2,
    pub(crate) host_shell_authority: crate::host_admission_v2::HostShellAuthorityV2,
    pub(crate) gui: Arc<Mutex<GuiState>>,
    pub(crate) host_services: HostServices,
    pub(crate) provider_trace_v1: ProviderTraceStoreV1,
    pub(crate) provider_trace_export_limiter_v1:
        crate::provider_trace_api::ProviderTraceExportLimiterV1,
    pub(crate) terminal_runtime: Arc<Mutex<crate::terminal_api::TerminalRuntime>>,
    pub(crate) session_runs: Arc<Mutex<HashMap<String, AgentRunState>>>,
}

impl axum::extract::FromRef<AppState> for crate::kernel_v2_transport::KernelV2TransportState {
    fn from_ref(state: &AppState) -> Self {
        state.kernel_v2.clone()
    }
}

#[derive(Debug)]
pub(crate) struct HostPaths {
    pub(crate) settings_path: PathBuf,
    pub(crate) llm_profiles_path: PathBuf,
    pub(crate) llm_secrets_path: PathBuf,
    pub(crate) projects_path: PathBuf,
    pub(crate) sessions_index_path: PathBuf,
    pub(crate) sessions_dir: PathBuf,
}

#[derive(Debug)]
pub(crate) struct GuiState {
    pub(crate) paths: HostPaths,
    pub(crate) user_settings: Value,
    pub(crate) llm_profiles: Value,
    pub(crate) projects: Vec<Value>,
    pub(crate) sessions: Vec<Value>,
    pub(crate) session_metadata_error: Option<String>,
    pub(crate) current_session_id: Option<String>,
    pub(crate) current_session_ids_by_scope: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRunState {
    pub(crate) run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) kernel_run_id: Option<String>,
    pub(crate) session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) profile_id: Option<String>,
    pub(crate) status: String,
    pub(crate) start_event_count: usize,
    pub(crate) started_at: String,
    pub(crate) updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
}

impl AgentRunState {
    pub(crate) fn running(
        run_id: String,
        session_id: String,
        profile_id: String,
        start_event_count: usize,
    ) -> Self {
        let now = now_text();
        Self {
            run_id,
            kernel_run_id: None,
            session_id,
            profile_id: Some(profile_id),
            status: "running".to_string(),
            start_event_count,
            started_at: now.clone(),
            updated_at: now,
            completed_at: None,
            message: None,
        }
    }
}

impl GuiState {
    pub(crate) fn new() -> Self {
        let paths = HostPaths::new();
        let user_settings =
            read_json_file(&paths.settings_path).unwrap_or_else(default_user_settings);
        let llm_profiles = if paths.llm_profiles_path.exists() {
            read_json_file(&paths.llm_profiles_path).unwrap_or(Value::Null)
        } else {
            default_llm_profiles()
        };
        let projects = restore_agent_projects(&paths.projects_path);
        let (sessions, session_metadata_error) =
            match crate::session_metadata_v2::restore_session_index(&paths) {
                Ok(sessions) => (sessions, None),
                Err(error) => (Vec::new(), Some(error)),
            };
        let current_session_id = sessions
            .iter()
            .find(|session| session_is_selectable(session))
            .and_then(|session| session.get("id").and_then(Value::as_str))
            .map(ToOwned::to_owned);
        let current_session_ids_by_scope =
            crate::session_metadata_v2::restored_current_session_ids_by_scope(&sessions);
        Self {
            paths,
            user_settings,
            llm_profiles,
            projects,
            sessions,
            session_metadata_error,
            current_session_id,
            current_session_ids_by_scope,
        }
    }
}

impl HostPaths {
    pub(crate) fn new() -> Self {
        let root = user_config_root();
        let settings_dir = root
            .join("config")
            .join("user")
            .join("local")
            .join("settings");
        let secrets_dir = root
            .join("config")
            .join("user")
            .join("local")
            .join("secrets");
        Self {
            settings_path: settings_dir.join("user-settings.json"),
            llm_profiles_path: settings_dir.join("llm-profiles.json"),
            llm_secrets_path: secrets_dir.join("llm-secrets.json"),
            projects_path: root.join("projects.json"),
            sessions_index_path: root.join("agent-sessions.json"),
            sessions_dir: root.join("sessions"),
        }
    }
}
