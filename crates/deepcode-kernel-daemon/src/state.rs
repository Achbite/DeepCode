#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) runtime: Arc<Mutex<DeepCodeKernelRuntime>>,
    pub(crate) gui: Arc<Mutex<GuiState>>,
    pub(crate) terminal_runtime: Arc<Mutex<crate::terminal_api::TerminalRuntime>>,
    pub(crate) kernel_events: Arc<Mutex<Vec<KernelEvent>>>,
}

pub(crate) type SharedRuntime = Arc<Mutex<DeepCodeKernelRuntime>>;

#[derive(Debug)]
pub(crate) struct HostPaths {
    pub(crate) settings_path: PathBuf,
    pub(crate) llm_profiles_path: PathBuf,
    pub(crate) llm_secrets_path: PathBuf,
    pub(crate) workflow_config_path: PathBuf,
    pub(crate) sessions_dir: PathBuf,
    pub(crate) conversation_archives_dir: PathBuf,
}

#[derive(Debug)]
pub(crate) struct GuiState {
    pub(crate) paths: HostPaths,
    pub(crate) user_settings: Value,
    pub(crate) llm_profiles: Value,
    pub(crate) workflow_config: Value,
    pub(crate) sessions: Vec<Value>,
    pub(crate) current_session_id: Option<String>,
    pub(crate) current_session_ids_by_scope: HashMap<String, String>,
    pub(crate) session_projection_cache: HashMap<String, Vec<Value>>,
    pub(crate) pending_plans: HashMap<String, PendingAgentPlan>,
    pub(crate) pending_reviews: HashMap<String, PendingAgentReview>,
    pub(crate) trace_events: HashMap<String, Vec<Value>>,
    pub(crate) browser: BrowserState,
}

#[derive(Debug)]
pub(crate) struct BrowserState {
    pub(crate) current_url: Option<String>,
    pub(crate) inspect_state: String,
    pub(crate) snapshot: Option<Value>,
    pub(crate) attached: bool,
    pub(crate) last_action: Option<String>,
    pub(crate) last_action_at: Option<String>,
    pub(crate) last_action_result: Option<String>,
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
        Self {
            paths,
            user_settings,
            llm_profiles,
            workflow_config,
            sessions: Vec::new(),
            current_session_id: None,
            current_session_ids_by_scope: HashMap::new(),
            session_projection_cache: HashMap::new(),
            pending_plans: HashMap::new(),
            pending_reviews: HashMap::new(),
            trace_events: HashMap::new(),
            browser: BrowserState::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingAgentPlan {
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) plan_id: String,
    pub(crate) user_plan: String,
    pub(crate) action_bundle: Value,
    #[serde(default)]
    pub(crate) code_blocks: Vec<Value>,
    pub(crate) expected_validation: String,
    pub(crate) review_guide: String,
    pub(crate) plan_review_report: Option<Value>,
    pub(crate) created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingAgentReview {
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) source_plan_id: String,
    #[serde(default)]
    pub(crate) continuations: Vec<Value>,
    #[serde(default)]
    pub(crate) code_blocks: Vec<Value>,
    #[serde(default)]
    pub(crate) review_expectations: Vec<Value>,
    pub(crate) created_at: String,
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
            sessions_dir: root.join("sessions"),
            conversation_archives_dir: root.join("conversation-archives"),
        }
    }
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            current_url: None,
            inspect_state: "off".to_string(),
            snapshot: None,
            attached: false,
            last_action: None,
            last_action_at: None,
            last_action_result: None,
        }
    }
}
