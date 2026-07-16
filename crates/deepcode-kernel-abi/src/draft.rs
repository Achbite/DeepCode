use serde::{Deserialize, Serialize};

pub const ARTIFACT_DRAFT_SCHEMA_VERSION: &str = "deepcode.agent.artifact-draft.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDraftFrameBase {
    pub schema_version: String,
    pub draft_id: String,
    pub frame_id: String,
    pub run_id: String,
    pub session_id: String,
    pub task_id: String,
    pub sequence: u64,
    pub content_hash: String,
    pub expected_slot_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ArtifactEditMatch {
    ExactBlock {
        target_lines: Vec<String>,
    },
    ContextBlock {
        before_lines: Vec<String>,
        target_lines: Vec<String>,
        after_lines: Vec<String>,
    },
    LineRange {
        start_line: u64,
        end_line: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_file_hash: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_before_lines: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_before_text: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "partKind", rename_all_fields = "camelCase")]
pub enum ArtifactDraftLedgerFrame {
    #[serde(rename = "artifactChunk")]
    ArtifactChunk {
        #[serde(flatten)]
        base: ArtifactDraftFrameBase,
        slot_id: String,
        content_lines: Vec<String>,
        final_chunk: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        edit_match: Option<ArtifactEditMatch>,
    },
    #[serde(rename = "batchDone")]
    BatchDone {
        #[serde(flatten)]
        base: ArtifactDraftFrameBase,
        metadata: ArtifactDraftBatchMetadata,
    },
    #[serde(rename = "diagnostic")]
    Diagnostic {
        #[serde(flatten)]
        base: ArtifactDraftFrameBase,
        metadata: ArtifactDraftDiagnosticMetadata,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDraftBatchMetadata {
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDraftDiagnosticMetadata {
    pub reason: String,
}
