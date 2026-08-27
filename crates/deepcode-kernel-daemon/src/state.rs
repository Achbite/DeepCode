use crate::prelude::*;
use crate::*;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) local_agent: crate::local_agent_api::LocalAgentRuntime,
    pub(crate) session_service: crate::session_service::SessionServiceProcess,
    pub(crate) host_connection: crate::host_connection::HostConnection,
    pub(crate) conversation_history: Arc<crate::conversation_history::ConversationHistoryReader>,
    pub(crate) gui: Arc<Mutex<GuiState>>,
    pub(crate) host_services: HostServices,
    pub(crate) terminal_runtime: Arc<Mutex<crate::terminal_api::TerminalRuntime>>,
}

#[derive(Debug)]
pub(crate) struct HostPaths {
    pub(crate) settings_path: PathBuf,
    pub(crate) llm_profiles_path: PathBuf,
    pub(crate) llm_secrets_path: PathBuf,
    pub(crate) catalog_store_path: PathBuf,
    pub(crate) session_store_path: PathBuf,
    pub(crate) tool_record_store_path: PathBuf,
    pub(crate) legacy_session_store_path: PathBuf,
}

#[derive(Debug)]
pub(crate) struct GuiState {
    pub(crate) paths: HostPaths,
    pub(crate) user_settings: Value,
    pub(crate) llm_profiles: Value,
    pub(crate) conversation_catalog: crate::conversation_catalog::ConversationCatalog,
    pub(crate) conversation_catalog_error: Option<String>,
}

impl GuiState {
    pub(crate) fn new() -> Self {
        let paths = HostPaths::new();
        let mut user_settings =
            read_json_file(&paths.settings_path).unwrap_or_else(default_user_settings);
        remove_legacy_workspace_permission_settings(&mut user_settings);
        let llm_profiles = if paths.llm_profiles_path.exists() {
            read_json_file(&paths.llm_profiles_path).unwrap_or(Value::Null)
        } else {
            default_llm_profiles()
        };
        let (conversation_catalog, conversation_catalog_error) =
            match crate::conversation_catalog::ConversationCatalog::load(&paths.catalog_store_path)
            {
                Ok(catalog) => (catalog, None),
                Err(error) => (
                    crate::conversation_catalog::ConversationCatalog::default(),
                    Some(error),
                ),
            };
        Self {
            paths,
            user_settings,
            llm_profiles,
            conversation_catalog,
            conversation_catalog_error,
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
        let runtime_v2_root = root.join("runtime").join("local-agent-v2");
        Self {
            settings_path: settings_dir.join("user-settings.json"),
            llm_profiles_path: settings_dir.join("llm-profiles.json"),
            llm_secrets_path: secrets_dir.join("llm-secrets.json"),
            catalog_store_path: runtime_v2_root.join("catalog.sqlite3"),
            session_store_path: runtime_v2_root.join("session.sqlite3"),
            tool_record_store_path: runtime_v2_root.join("tool-record.sqlite3"),
            legacy_session_store_path: distribution_root()
                .join("sessions")
                .join("agent-runtime-v1.sqlite3"),
        }
    }
}
