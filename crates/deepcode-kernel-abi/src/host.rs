use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HostInspectionQuery {
    Browse {
        path: Option<String>,
    },
    List {
        folder_id: Option<String>,
        path: String,
        depth: u32,
    },
    Read {
        folder_id: Option<String>,
        path: String,
    },
    Grep {
        folder_id: Option<String>,
        query: String,
        path: String,
        include: Vec<String>,
        exclude: Vec<String>,
        strategy: String,
        context_lines: u32,
        max_results: u32,
    },
    GitStatus,
    GitDiff {
        path: Option<String>,
        staged: bool,
    },
}

impl HostInspectionQuery {
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Browse { .. } => "browse",
            Self::List { .. } => "list",
            Self::Read { .. } => "read",
            Self::Grep { .. } => "grep",
            Self::GitStatus => "gitStatus",
            Self::GitDiff { .. } => "gitDiff",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInspectionResult {
    pub source: String,
    pub query_kind: String,
    pub output: Value,
}
