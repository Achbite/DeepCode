use crate::prelude::*;
use crate::*;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) runtime: Arc<Mutex<DeepCodeKernelRuntime>>,
    pub(crate) gui: Arc<Mutex<GuiState>>,
    pub(crate) terminal_runtime: Arc<Mutex<crate::terminal_api::TerminalRuntime>>,
    pub(crate) kernel_events: Arc<Mutex<Vec<KernelEvent>>>,
    pub(crate) session_runs: Arc<Mutex<HashMap<String, AgentRunState>>>,
    pub(crate) session_run_deltas: Arc<Mutex<HashMap<String, Vec<Value>>>>,
}

pub(crate) type SharedRuntime = Arc<Mutex<DeepCodeKernelRuntime>>;

#[derive(Debug)]
pub(crate) struct HostPaths {
    pub(crate) settings_path: PathBuf,
    pub(crate) llm_profiles_path: PathBuf,
    pub(crate) llm_secrets_path: PathBuf,
    pub(crate) workflow_config_path: PathBuf,
    pub(crate) projects_path: PathBuf,
    pub(crate) sessions_index_path: PathBuf,
    pub(crate) sessions_dir: PathBuf,
    pub(crate) conversation_archives_dir: PathBuf,
    pub(crate) memory_archives_dir: PathBuf,
}

#[derive(Debug)]
pub(crate) struct GuiState {
    pub(crate) paths: HostPaths,
    pub(crate) user_settings: Value,
    pub(crate) llm_profiles: Value,
    pub(crate) workflow_config: Value,
    pub(crate) projects: Vec<Value>,
    pub(crate) sessions: Vec<Value>,
    pub(crate) current_session_id: Option<String>,
    pub(crate) current_session_ids_by_scope: HashMap<String, String>,
    pub(crate) session_projection_cache: HashMap<String, Vec<Value>>,
    pub(crate) session_timeline_cache: HashMap<String, Value>,
    pub(crate) trace_events: HashMap<String, Vec<Value>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRunState {
    pub(crate) run_id: String,
    pub(crate) session_id: String,
    pub(crate) status: String,
    pub(crate) start_event_count: usize,
    pub(crate) started_at: String,
    pub(crate) updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) final_text: Option<String>,
}

impl AgentRunState {
    pub(crate) fn running(run_id: String, session_id: String, start_event_count: usize) -> Self {
        let now = now_text();
        Self {
            run_id,
            session_id,
            status: "running".to_string(),
            start_event_count,
            started_at: now.clone(),
            updated_at: now,
            completed_at: None,
            message: None,
            final_text: None,
        }
    }
}

impl GuiState {
    pub(crate) fn new() -> Self {
        let paths = HostPaths::new();
        let user_settings =
            read_json_file(&paths.settings_path).unwrap_or_else(default_user_settings);
        let llm_profiles =
            read_json_file(&paths.llm_profiles_path).unwrap_or_else(default_llm_profiles);
        let workflow_config =
            read_json_file(&paths.workflow_config_path).unwrap_or_else(default_workflow_config);
        let projects = restore_agent_projects(&paths.projects_path);
        let sessions = restore_session_index(&paths);
        let current_session_id = sessions
            .iter()
            .find(|session| !is_archived_session(session))
            .and_then(|session| session.get("id").and_then(Value::as_str))
            .map(ToOwned::to_owned);
        let current_session_ids_by_scope = restored_current_session_ids_by_scope(&sessions);
        Self {
            paths,
            user_settings,
            llm_profiles,
            workflow_config,
            projects,
            sessions,
            current_session_id,
            current_session_ids_by_scope,
            session_projection_cache: HashMap::new(),
            session_timeline_cache: HashMap::new(),
            trace_events: HashMap::new(),
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
            workflow_config_path: settings_dir.join("agent-workflow-config.json"),
            projects_path: root.join("projects.json"),
            sessions_index_path: root.join("agent-sessions.json"),
            sessions_dir: root.join("sessions"),
            conversation_archives_dir: root.join("conversation-archives"),
            memory_archives_dir: root.join("memory").join("projects"),
        }
    }
}
