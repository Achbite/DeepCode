use crate::prelude::*;
use rusqlite::{params, Connection};

const CATALOG_SCHEMA: &str = include_str!("../../../contracts/agent-runtime/catalog.sql");
const CATALOG_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceBindingDisplayRecord {
    pub(crate) workspace_id: String,
    pub(crate) display_name: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ConversationWorkspaceRecord {
    pub(crate) workspace_id: String,
    pub(crate) display_name: String,
    pub(crate) canonical_root: String,
    /// Present only for Host-owned message file snapshots.
    pub(crate) owner_session_id: Option<String>,
    pub(crate) created_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ConversationProjectRecord {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) workspace_ids: Vec<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ConversationSessionRecord {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) workspace_bindings: Vec<WorkspaceBindingDisplayRecord>,
    pub(crate) project_id: Option<String>,
    pub(crate) profile_id: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ConversationCatalog {
    pub(crate) workspaces: Vec<ConversationWorkspaceRecord>,
    pub(crate) projects: Vec<ConversationProjectRecord>,
    pub(crate) sessions: Vec<ConversationSessionRecord>,
}

impl ConversationCatalog {
    pub(crate) fn load(path: &FsPath) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建 Catalog Store 目录失败：{error}"))?;
        }
        let existed = path.exists();
        let connection =
            Connection::open(path).map_err(|error| format!("打开 Catalog Store 失败：{error}"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("配置 Catalog Store 超时失败：{error}"))?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;")
            .map_err(|error| format!("配置 Catalog Store 失败：{error}"))?;
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| format!("读取 Catalog Store 版本失败：{error}"))?;
        match version {
            0 if !existed || sqlite_is_empty(&connection)? => {
                connection
                    .execute_batch(CATALOG_SCHEMA)
                    .map_err(|error| format!("创建 Catalog Store 失败：{error}"))?;
                verify_version(&connection)?;
            }
            CATALOG_VERSION => verify_tables(&connection)?,
            other => {
                return Err(format!(
                    "Catalog Store schema {other} 不受支持；当前只接受 schema {CATALOG_VERSION}。"
                ))
            }
        }
        Self::read_all(&connection)
    }

    pub(crate) fn persist(&self, path: &FsPath) -> Result<(), String> {
        self.validate()?;
        let mut connection =
            Connection::open(path).map_err(|error| format!("打开 Catalog Store 失败：{error}"))?;
        verify_version(&connection)?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("开始 Catalog 事务失败：{error}"))?;
        transaction
            .execute_batch(
                "DELETE FROM session_catalog;
                 DELETE FROM project_workspace_bindings;
                 DELETE FROM projects;
                 DELETE FROM workspaces;",
            )
            .map_err(|error| format!("清空 Catalog 事务视图失败：{error}"))?;
        for workspace in &self.workspaces {
            transaction
                .execute(
                    "INSERT INTO workspaces(
                         workspace_id, display_name, canonical_root, owner_session_id, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        workspace.workspace_id,
                        workspace.display_name,
                        workspace.canonical_root,
                        workspace.owner_session_id,
                        workspace.created_at,
                    ],
                )
                .map_err(|error| format!("写入 workspace catalog 失败：{error}"))?;
        }
        for project in &self.projects {
            transaction
                .execute(
                    "INSERT INTO projects(project_id, title, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        project.id,
                        project.title,
                        project.created_at,
                        project.updated_at
                    ],
                )
                .map_err(|error| format!("写入 project catalog 失败：{error}"))?;
            for (position, workspace_id) in project.workspace_ids.iter().enumerate() {
                transaction
                    .execute(
                        "INSERT INTO project_workspace_bindings(project_id, position, workspace_id)
                         VALUES (?1, ?2, ?3)",
                        params![project.id, position as i64, workspace_id],
                    )
                    .map_err(|error| format!("写入 project workspace binding 失败：{error}"))?;
            }
        }
        for session in &self.sessions {
            let bindings = serde_json::to_string(&session.workspace_bindings)
                .map_err(|error| format!("编码 Session binding display 失败：{error}"))?;
            transaction
                .execute(
                    "INSERT INTO session_catalog(
                         session_id, title, project_id, workspace_bindings_json,
                         profile_id, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        session.id,
                        session.title,
                        session.project_id,
                        bindings,
                        session.profile_id,
                        session.created_at,
                        session.updated_at,
                    ],
                )
                .map_err(|error| format!("写入 session catalog 失败：{error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("提交 Catalog 事务失败：{error}"))
    }

    pub(crate) fn public_value(&self) -> Value {
        let mut projects = self.projects.clone();
        let mut sessions = self.sessions.clone();
        projects.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        json!({
            "projects": projects.into_iter().map(|project| json!({
                "id": project.id,
                "title": project.title,
                "workspaceBindings": self.binding_display(&project.workspace_ids),
                "createdAt": project.created_at,
                "updatedAt": project.updated_at,
            })).collect::<Vec<_>>(),
            "sessions": sessions.into_iter().map(|session| {
                let mut value = json!({
                    "id": session.id,
                    "title": session.title,
                    "workspaceBindings": session.workspace_bindings,
                    "createdAt": session.created_at,
                    "updatedAt": session.updated_at,
                });
                if let Some(project_id) = session.project_id {
                    value["projectId"] = json!(project_id);
                }
                if let Some(profile_id) = session.profile_id {
                    value["profileId"] = json!(profile_id);
                }
                value
            }).collect::<Vec<_>>(),
        })
    }

    pub(crate) fn management_value(&self) -> Value {
        let mut value = self.public_value();
        value["workspaces"] = Value::Array(
            self.workspaces
                .iter()
                .filter(|workspace| workspace.owner_session_id.is_none())
                .map(|workspace| {
                    json!({
                        "workspaceId": workspace.workspace_id,
                        "displayName": workspace.display_name,
                        "canonicalRoot": workspace.canonical_root,
                        "createdAt": workspace.created_at,
                    })
                })
                .collect(),
        );
        value
    }

    pub(crate) fn project(&self, project_id: &str) -> Option<&ConversationProjectRecord> {
        self.projects
            .iter()
            .find(|project| project.id == project_id)
    }

    pub(crate) fn session(&self, session_id: &str) -> Option<&ConversationSessionRecord> {
        self.sessions
            .iter()
            .find(|session| session.id == session_id)
    }

    pub(crate) fn workspace_by_root(
        &self,
        canonical_root: &str,
    ) -> Option<&ConversationWorkspaceRecord> {
        self.workspaces
            .iter()
            .find(|workspace| workspace.canonical_root == canonical_root)
    }

    pub(crate) fn workspace(&self, workspace_id: &str) -> Option<&ConversationWorkspaceRecord> {
        self.workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == workspace_id)
    }

    pub(crate) fn register_workspace(&mut self, workspace: ConversationWorkspaceRecord) {
        if self.workspace(&workspace.workspace_id).is_none()
            && self.workspace_by_root(&workspace.canonical_root).is_none()
        {
            self.workspaces.push(workspace);
        }
    }

    pub(crate) fn insert_project(&mut self, project: ConversationProjectRecord) {
        self.projects.retain(|candidate| candidate.id != project.id);
        self.projects.insert(0, project);
    }

    pub(crate) fn insert_session(&mut self, session: ConversationSessionRecord) {
        self.sessions.retain(|candidate| candidate.id != session.id);
        self.sessions.insert(0, session);
    }

    pub(crate) fn replace_project_bindings(
        &mut self,
        project_id: &str,
        workspace_ids: Vec<String>,
        now: &str,
    ) -> Result<(), &'static str> {
        if workspace_ids.iter().any(|id| self.workspace(id).is_none()) {
            return Err("conversation_workspace_not_found");
        }
        let Some(project) = self
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        else {
            return Err("conversation_project_not_found");
        };
        project.workspace_ids = workspace_ids;
        project.updated_at = now.to_string();
        Ok(())
    }

    pub(crate) fn project_binding_snapshot(
        &self,
        project_id: &str,
    ) -> Result<Vec<WorkspaceBindingDisplayRecord>, &'static str> {
        let project = self
            .project(project_id)
            .ok_or("conversation_project_not_found")?;
        Ok(self.binding_display(&project.workspace_ids))
    }

    pub(crate) fn rename_project(&mut self, project_id: &str, title: &str, now: &str) -> bool {
        let Some(project) = self
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        else {
            return false;
        };
        project.title = title.to_string();
        project.updated_at = now.to_string();
        true
    }

    pub(crate) fn delete_project(&mut self, project_id: &str, now: &str) -> bool {
        let before = self.projects.len();
        self.projects.retain(|project| project.id != project_id);
        if self.projects.len() == before {
            return false;
        }
        for session in &mut self.sessions {
            if session.project_id.as_deref() == Some(project_id) {
                session.project_id = None;
                session.updated_at = now.to_string();
            }
        }
        true
    }

    pub(crate) fn rename_session(&mut self, session_id: &str, title: &str, now: &str) -> bool {
        let Some(session) = self
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
        else {
            return false;
        };
        session.title = title.to_string();
        session.updated_at = now.to_string();
        true
    }

    pub(crate) fn move_session(
        &mut self,
        session_id: &str,
        project_id: Option<&str>,
        now: &str,
    ) -> Result<(), &'static str> {
        if project_id.is_some_and(|id| self.project(id).is_none()) {
            return Err("conversation_project_not_found");
        }
        let Some(session) = self
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
        else {
            return Err("conversation_session_not_found");
        };
        session.project_id = project_id.map(str::to_string);
        session.updated_at = now.to_string();
        Ok(())
    }

    pub(crate) fn touch_session(
        &mut self,
        session_id: &str,
        automatic_title: Option<&str>,
        now: &str,
    ) -> bool {
        let Some(session) = self
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
        else {
            return false;
        };
        if session.title == "新对话" {
            if let Some(title) = automatic_title.filter(|title| !title.is_empty()) {
                session.title = title.to_string();
            }
        }
        session.updated_at = now.to_string();
        true
    }

    pub(crate) fn delete_session(&mut self, session_id: &str) -> bool {
        let before = self.sessions.len();
        self.sessions.retain(|session| session.id != session_id);
        if self.sessions.len() == before {
            return false;
        }
        self.workspaces
            .retain(|workspace| workspace.owner_session_id.as_deref() != Some(session_id));
        true
    }

    fn binding_display(&self, workspace_ids: &[String]) -> Vec<WorkspaceBindingDisplayRecord> {
        workspace_ids
            .iter()
            .filter_map(|id| self.workspace(id))
            .map(|workspace| WorkspaceBindingDisplayRecord {
                workspace_id: workspace.workspace_id.clone(),
                display_name: workspace.display_name.clone(),
            })
            .collect()
    }

    fn read_all(connection: &Connection) -> Result<Self, String> {
        let mut catalog = Self::default();
        {
            let mut statement = connection
                .prepare(
                    "SELECT workspace_id, display_name, canonical_root, owner_session_id, created_at
                     FROM workspaces ORDER BY created_at, workspace_id",
                )
                .map_err(|error| format!("读取 workspace catalog 失败：{error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok(ConversationWorkspaceRecord {
                        workspace_id: row.get(0)?,
                        display_name: row.get(1)?,
                        canonical_root: row.get(2)?,
                        owner_session_id: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                })
                .map_err(|error| format!("读取 workspace catalog 失败：{error}"))?;
            for row in rows {
                catalog
                    .workspaces
                    .push(row.map_err(|error| format!("解码 workspace catalog 失败：{error}"))?);
            }
        }
        {
            let mut statement = connection
                .prepare("SELECT project_id, title, created_at, updated_at FROM projects")
                .map_err(|error| format!("读取 project catalog 失败：{error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok(ConversationProjectRecord {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        workspace_ids: Vec::new(),
                        created_at: row.get(2)?,
                        updated_at: row.get(3)?,
                    })
                })
                .map_err(|error| format!("读取 project catalog 失败：{error}"))?;
            for row in rows {
                catalog
                    .projects
                    .push(row.map_err(|error| format!("解码 project catalog 失败：{error}"))?);
            }
            for project in &mut catalog.projects {
                let mut binding_statement = connection
                    .prepare(
                        "SELECT workspace_id FROM project_workspace_bindings
                         WHERE project_id=?1 ORDER BY position",
                    )
                    .map_err(|error| format!("读取 project binding 失败：{error}"))?;
                let bindings = binding_statement
                    .query_map(params![project.id], |row| row.get::<_, String>(0))
                    .map_err(|error| format!("读取 project binding 失败：{error}"))?;
                for binding in bindings {
                    project.workspace_ids.push(
                        binding.map_err(|error| format!("解码 project binding 失败：{error}"))?,
                    );
                }
            }
        }
        {
            let mut statement = connection
                .prepare(
                    "SELECT session_id, title, project_id,
                            workspace_bindings_json, profile_id, created_at, updated_at
                     FROM session_catalog",
                )
                .map_err(|error| format!("读取 session catalog 失败：{error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                })
                .map_err(|error| format!("读取 session catalog 失败：{error}"))?;
            for row in rows {
                let (id, title, project_id, bindings, profile_id, created_at, updated_at) =
                    row.map_err(|error| format!("解码 session catalog 失败：{error}"))?;
                catalog.sessions.push(ConversationSessionRecord {
                    id,
                    title,
                    project_id,
                    workspace_bindings: serde_json::from_str(&bindings)
                        .map_err(|error| format!("Session binding display 已损坏：{error}"))?,
                    profile_id,
                    created_at,
                    updated_at,
                });
            }
        }
        catalog.validate()?;
        Ok(catalog)
    }

    fn validate(&self) -> Result<(), String> {
        let declared_session_ids = self
            .sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let mut workspace_ids = std::collections::HashSet::new();
        let mut canonical_roots = std::collections::HashSet::new();
        for workspace in &self.workspaces {
            validate_record_id("workspaceId", &workspace.workspace_id)?;
            validate_title(&workspace.display_name)?;
            if workspace
                .owner_session_id
                .as_deref()
                .is_some_and(|session_id| !declared_session_ids.contains(session_id))
            {
                return Err("Host-owned attachment workspace 引用了不存在的 Session。".to_string());
            }
            if !workspace_ids.insert(workspace.workspace_id.as_str())
                || !canonical_roots.insert(workspace.canonical_root.as_str())
            {
                return Err("Workspace catalog 包含重复身份或路径。".to_string());
            }
        }
        let mut project_ids = std::collections::HashSet::new();
        for project in &self.projects {
            validate_record_id("projectId", &project.id)?;
            validate_title(&project.title)?;
            if !project_ids.insert(project.id.as_str()) {
                return Err("Project catalog 包含重复 projectId。".to_string());
            }
            let mut bindings = std::collections::HashSet::new();
            for workspace_id in &project.workspace_ids {
                if !workspace_ids.contains(workspace_id.as_str())
                    || self
                        .workspace(workspace_id)
                        .is_some_and(|workspace| workspace.owner_session_id.is_some())
                    || !bindings.insert(workspace_id)
                {
                    return Err(format!("项目 {} 的 workspace binding 无效。", project.id));
                }
            }
        }
        let mut session_ids = std::collections::HashSet::new();
        for session in &self.sessions {
            validate_record_id("sessionId", &session.id)?;
            validate_title(&session.title)?;
            if !session_ids.insert(session.id.as_str()) {
                return Err("Session catalog 包含重复 sessionId。".to_string());
            }
            if session
                .project_id
                .as_deref()
                .is_some_and(|id| !project_ids.contains(id))
            {
                return Err(format!("会话 {} 引用了不存在的项目。", session.id));
            }
            let mut bindings = std::collections::HashSet::new();
            for binding in &session.workspace_bindings {
                validate_record_id("workspaceId", &binding.workspace_id)?;
                validate_title(&binding.display_name)?;
                let canonical_display_name = self
                    .workspace(&binding.workspace_id)
                    .filter(|workspace| workspace.owner_session_id.is_none())
                    .map(|workspace| workspace.display_name.as_str());
                if canonical_display_name != Some(binding.display_name.as_str())
                    || !bindings.insert(binding.workspace_id.as_str())
                {
                    return Err(format!(
                        "会话 {} 的 workspace creation snapshot 无效。",
                        session.id
                    ));
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn canonical_folder_path(path: &str) -> Result<String, String> {
    let canonical = fs::canonicalize(path).map_err(|error| format!("本地文件夹不可用：{error}"))?;
    if !canonical.is_dir() {
        return Err("项目路径必须是本地文件夹。".to_string());
    }
    Ok(canonical.to_string_lossy().to_string())
}

pub(crate) fn workspace_display_name(canonical_root: &str) -> String {
    FsPath::new(canonical_root)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Workspace")
        .to_string()
}

pub(crate) fn clean_title(value: &str) -> Result<String, String> {
    let title = value.trim();
    validate_title(title)?;
    Ok(title.to_string())
}

pub(crate) fn automatic_conversation_title(value: &str) -> String {
    value
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(48)
        .collect()
}

fn verify_version(connection: &Connection) -> Result<(), String> {
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("读取 Catalog Store 版本失败：{error}"))?;
    if version != CATALOG_VERSION {
        return Err(format!(
            "Catalog Store schema {version} 不是当前 schema {CATALOG_VERSION}。"
        ));
    }
    verify_tables(connection)
}

fn verify_tables(connection: &Connection) -> Result<(), String> {
    for name in [
        "workspaces",
        "projects",
        "project_workspace_bindings",
        "session_catalog",
    ] {
        let present: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
                params![name],
                |row| row.get(0),
            )
            .map_err(|error| format!("验证 Catalog Store 失败：{error}"))?;
        if !present {
            return Err(format!("Catalog Store 缺少 {name} 表。"));
        }
    }
    Ok(())
}

fn sqlite_is_empty(connection: &Connection) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查 Catalog Store 失败：{error}"))
}

fn validate_title(value: &str) -> Result<(), String> {
    if value.is_empty() || value.chars().count() > 120 || value.chars().any(char::is_control) {
        return Err("名称必须是 1 到 120 个可显示字符。".to_string());
    }
    Ok(())
}

fn validate_record_id(field: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(format!("{field} 不是有效本地标识。"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moving_session_changes_only_project_classification() {
        let mut catalog = ConversationCatalog::default();
        catalog.workspaces.push(ConversationWorkspaceRecord {
            workspace_id: "workspace:one".to_string(),
            display_name: "One".to_string(),
            canonical_root: "/workspace/one".to_string(),
            owner_session_id: None,
            created_at: "now".to_string(),
        });
        catalog.insert_project(ConversationProjectRecord {
            id: "project:one".to_string(),
            title: "One".to_string(),
            workspace_ids: Vec::new(),
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        });
        catalog.insert_session(ConversationSessionRecord {
            id: "session:one".to_string(),
            title: "新对话".to_string(),
            workspace_bindings: vec![WorkspaceBindingDisplayRecord {
                workspace_id: "workspace:one".to_string(),
                display_name: "One".to_string(),
            }],
            project_id: None,
            profile_id: None,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        });
        let before = catalog
            .session("session:one")
            .unwrap()
            .workspace_bindings
            .clone();
        catalog
            .move_session("session:one", Some("project:one"), "later")
            .expect("classification move");
        assert_eq!(
            catalog.session("session:one").unwrap().workspace_bindings,
            before
        );
    }

    #[test]
    fn public_catalog_omits_absent_optional_session_fields() {
        let mut catalog = ConversationCatalog::default();
        catalog.insert_session(ConversationSessionRecord {
            id: "session:standalone".to_string(),
            title: "新对话".to_string(),
            workspace_bindings: Vec::new(),
            project_id: None,
            profile_id: None,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        });

        let public = catalog.public_value();
        let session = &public["sessions"][0];
        assert!(session.get("projectId").is_none());
        assert!(session.get("profileId").is_none());
    }

    #[test]
    fn deleting_session_removes_only_its_owned_attachment_workspaces() {
        let mut catalog = ConversationCatalog::default();
        catalog.insert_session(ConversationSessionRecord {
            id: "session:one".to_string(),
            title: "One".to_string(),
            workspace_bindings: Vec::new(),
            project_id: None,
            profile_id: None,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        });
        catalog.register_workspace(ConversationWorkspaceRecord {
            workspace_id: "workspace:shared".to_string(),
            display_name: "Shared".to_string(),
            canonical_root: "/workspace/shared".to_string(),
            owner_session_id: None,
            created_at: "now".to_string(),
        });
        catalog.register_workspace(ConversationWorkspaceRecord {
            workspace_id: "workspace:attachment".to_string(),
            display_name: "attachment.txt".to_string(),
            canonical_root: "/workspace/attachment".to_string(),
            owner_session_id: Some("session:one".to_string()),
            created_at: "now".to_string(),
        });

        assert!(catalog.delete_session("session:one"));
        assert!(catalog.workspace("workspace:shared").is_some());
        assert!(catalog.workspace("workspace:attachment").is_none());
    }

    #[test]
    fn noncurrent_catalog_store_is_rejected() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-catalog-outdated-{}-{}.sqlite3",
            std::process::id(),
            crate::now_millis()
        ));
        let outdated_schema =
            CATALOG_SCHEMA.replace("PRAGMA user_version = 2;", "PRAGMA user_version = 1;");
        Connection::open(&path)
            .expect("open outdated catalog")
            .execute_batch(&outdated_schema)
            .expect("create outdated catalog");

        let error =
            ConversationCatalog::load(&path).expect_err("outdated catalog must be rejected");
        assert!(error.contains("schema 1"));

        std::fs::remove_file(path).expect("remove outdated catalog fixture");
    }
}
