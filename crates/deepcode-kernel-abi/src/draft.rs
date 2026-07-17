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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactDraftPartKind {
    ArtifactChunk,
    BatchDone,
    Diagnostic,
}

impl ArtifactDraftLedgerFrame {
    pub fn base(&self) -> &ArtifactDraftFrameBase {
        match self {
            Self::ArtifactChunk { base, .. }
            | Self::BatchDone { base, .. }
            | Self::Diagnostic { base, .. } => base,
        }
    }

    pub const fn part_kind(&self) -> ArtifactDraftPartKind {
        match self {
            Self::ArtifactChunk { .. } => ArtifactDraftPartKind::ArtifactChunk,
            Self::BatchDone { .. } => ArtifactDraftPartKind::BatchDone,
            Self::Diagnostic { .. } => ArtifactDraftPartKind::Diagnostic,
        }
    }

    pub fn base_mut(&mut self) -> &mut ArtifactDraftFrameBase {
        match self {
            Self::ArtifactChunk { base, .. }
            | Self::BatchDone { base, .. }
            | Self::Diagnostic { base, .. } => base,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactDraftStatus {
    Open,
    Chunk,
    BatchCompleted,
    Discarded,
    Committed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDraftEvent {
    pub draft_id: String,
    pub status: ArtifactDraftStatus,
    pub frame: ArtifactDraftLedgerFrame,
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
