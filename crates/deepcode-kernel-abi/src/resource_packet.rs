use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceTreeNodeKind {
    File,
    Directory,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceFileClassification {
    pub kind: String,
    pub readable_text: bool,
    pub binary: bool,
    pub executable: bool,
    pub size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTreeNode {
    #[serde(rename = "type")]
    pub kind: ResourceTreeNodeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<ResourceTreeNode>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_classification: Option<ResourceFileClassification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSearchContextLine {
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSearchMatch {
    pub path: String,
    pub line: usize,
    pub preview: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub before: Vec<ResourceSearchContextLine>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub after: Vec<ResourceSearchContextLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourcePacketStatus {
    Provided,
    Resolved,
    NotFound,
    Skipped,
    NeedsUserApproval,
    Denied,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourcePacketResolvedKind {
    File,
    Directory,
    Other,
    Search,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourcePacketContentKind {
    DirectoryTree,
    FileText,
    FileSkipped,
    SearchResults,
    Metadata,
    Summary,
    Text,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePacketItem {
    pub request_item_id: String,
    pub manifest_entry_id: String,
    pub status: ResourcePacketStatus,
    pub read_policy: String,
    pub source_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_kind: Option<ResourcePacketResolvedKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absolute_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_kind: Option<ResourcePacketContentKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub returned_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub returned_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub returned_matches: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory_depth: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_lines: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_results: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visited_files: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped_files: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped_binary_files: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped_executable_files: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_complete: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub include: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nodes: Vec<ResourceTreeNode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub matches: Vec<ResourceSearchMatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_classification: Option<ResourceFileClassification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePacket {
    pub id: String,
    pub request_id: String,
    pub workspace_scope_key: String,
    pub manifest_id: String,
    pub items: Vec<ResourcePacketItem>,
    pub evidence_refs: Vec<String>,
    pub summary: String,
}
