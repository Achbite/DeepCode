use crate::prelude::*;
use crate::*;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) local_agent: crate::local_agent_api::LocalAgentRuntime,
    pub(crate) session_service: crate::session_service::SessionServiceProcess,
    pub(crate) host_connection: crate::host_connection::HostConnection,
    pub(crate) gui: Arc<Mutex<GuiState>>,
    pub(crate) host_services: HostServices,
    pub(crate) model_usage: Arc<crate::model_usage::UsageStore>,
    pub(crate) model_auth: Arc<crate::model_auth::AuthService>,
}

#[derive(Debug)]
pub(crate) struct HostPaths {
    pub(crate) root_owner_lease_path: PathBuf,
    pub(crate) settings_path: PathBuf,
    pub(crate) llm_profiles_path: PathBuf,
    pub(crate) llm_secrets_path: PathBuf,
    pub(crate) usage_store_path: PathBuf,
    pub(crate) catalog_store_path: PathBuf,
    pub(crate) session_store_path: PathBuf,
    pub(crate) tool_record_store_path: PathBuf,
    pub(crate) attachment_store_root: PathBuf,
    pub(crate) session_workdir_root: PathBuf,
}

#[derive(Debug)]
pub(crate) struct GuiState {
    _config_root_lease: ConfigRootLease,
    pub(crate) paths: HostPaths,
    pub(crate) user_settings: Value,
    pub(crate) llm_profiles: LlmProfileStore,
    pub(crate) conversation_catalog: crate::conversation_catalog::ConversationCatalog,
    pub(crate) conversation_catalog_error: Option<String>,
}

impl GuiState {
    pub(crate) fn open() -> Result<Self, String> {
        Self::open_at(&user_config_root())
    }

    pub(crate) fn open_at(root: &FsPath) -> Result<Self, String> {
        let paths = HostPaths::at(root);
        let config_root_lease = ConfigRootLease::acquire(&paths.root_owner_lease_path)?;
        let user_settings = match read_optional_json_file(&paths.settings_path)? {
            Some(value @ Value::Object(_)) => {
                validate_agent_runtime_settings(&value)?;
                value
            }
            Some(_) => return Err("本地用户设置文件必须是 JSON 对象。".to_string()),
            None => default_user_settings(),
        };
        let llm_profiles =
            LlmProfileStore::load_with_secrets(&paths.llm_profiles_path, &paths.llm_secrets_path);
        let (conversation_catalog, conversation_catalog_error) =
            match crate::conversation_catalog::ConversationCatalog::load(&paths.catalog_store_path)
            {
                Ok(catalog) => (catalog, None),
                Err(error) => (
                    crate::conversation_catalog::ConversationCatalog::default(),
                    Some(error),
                ),
            };
        Ok(Self {
            _config_root_lease: config_root_lease,
            paths,
            user_settings,
            llm_profiles,
            conversation_catalog,
            conversation_catalog_error,
        })
    }
}

impl HostPaths {
    fn at(root: &FsPath) -> Self {
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
        let runtime_root = root.join("runtime").join("agent-runtime");
        Self {
            root_owner_lease_path: runtime_root.join("root-owner.lock"),
            settings_path: settings_dir.join("user-settings.json"),
            llm_profiles_path: settings_dir.join("llm-profiles.json"),
            llm_secrets_path: secrets_dir.join("llm-secrets.json"),
            usage_store_path: runtime_root.join("provider-usage.sqlite3"),
            catalog_store_path: runtime_root.join("catalog.sqlite3"),
            session_store_path: runtime_root.join("session.sqlite3"),
            tool_record_store_path: runtime_root.join("tool-record.sqlite3"),
            attachment_store_root: runtime_root.join("attachments"),
            session_workdir_root: runtime_root.join("session-workdirs"),
        }
    }
}
