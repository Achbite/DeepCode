use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::error::Error;
use std::fmt;

pub const AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2: &str =
    "deepcode.shared-conversation-projection.v2";
pub const AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1: &str =
    "deepcode.shared-conversation.work-segments.v1";

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct AgentProjectionValidationError {
    message: String,
}

impl AgentProjectionValidationError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for AgentProjectionValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for AgentProjectionValidationError {}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineStatus {
    #[serde(rename = "queued")]
    Queued,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "waiting")]
    Waiting,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "failed")]
    Failed,
}

impl AgentTimelineStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineDurability {
    #[serde(rename = "live")]
    Live,
    #[serde(rename = "committed")]
    Committed,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineDeliveryMode {
    #[serde(rename = "live")]
    Live,
    #[serde(rename = "buffered")]
    Buffered,
    #[serde(rename = "replay")]
    Replay,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineBlockKind {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "assistant")]
    Assistant,
    #[serde(rename = "permission")]
    Permission,
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "review")]
    Review,
    #[serde(rename = "error")]
    Error,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineNarrativeKind {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "assistantText")]
    AssistantText,
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "permission")]
    Permission,
    #[serde(rename = "review")]
    Review,
    #[serde(rename = "diagnostic")]
    Diagnostic,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineEntryRole {
    #[serde(rename = "userMessage")]
    UserMessage,
    #[serde(rename = "agentUpdate")]
    AgentUpdate,
    #[serde(rename = "interaction")]
    Interaction,
    #[serde(rename = "finalAnswer")]
    FinalAnswer,
    #[serde(rename = "diagnostic")]
    Diagnostic,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineProviderPhase {
    #[serde(rename = "commentary")]
    Commentary,
    #[serde(rename = "final_answer")]
    FinalAnswer,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineLanguage {
    #[serde(rename = "zh-CN")]
    Chinese,
    #[serde(rename = "en-US")]
    English,
    #[serde(rename = "neutral")]
    Neutral,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineLanguageBindingStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "resolved")]
    Resolved,
    #[serde(rename = "fallback")]
    Fallback,
    #[serde(rename = "superseded")]
    Superseded,
    #[serde(rename = "unavailable")]
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineLanguageBinding {
    pub language: AgentTimelineLanguage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    pub status: AgentTimelineLanguageBindingStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_turn_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineProvenanceOrigin {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "session")]
    Session,
    #[serde(rename = "kernel")]
    Kernel,
    #[serde(rename = "provider")]
    Provider,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineProvenanceAuthority {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "session")]
    Session,
    #[serde(rename = "kernel")]
    Kernel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineProvenance {
    pub origin: AgentTimelineProvenanceOrigin,
    pub authority: AgentTimelineProvenanceAuthority,
    pub source_event_refs: Vec<String>,
    pub fact_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineAttachmentKind {
    #[serde(rename = "file")]
    File,
    #[serde(rename = "directory")]
    Directory,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineAttachmentScope {
    #[serde(rename = "message")]
    Message,
    #[serde(rename = "session")]
    Session,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineAttachment {
    pub kind: AgentTimelineAttachmentKind,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    pub scope: AgentTimelineAttachmentScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineLocalizedText {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_args: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineDisplayDensity {
    #[serde(rename = "normal")]
    Normal,
    #[serde(rename = "compact")]
    Compact,
    #[serde(rename = "debug")]
    Debug,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineEvidenceMode {
    #[serde(rename = "inline")]
    Inline,
    #[serde(rename = "collapsed")]
    Collapsed,
    #[serde(rename = "debugOnly")]
    DebugOnly,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineCheckpointKind {
    #[serde(rename = "turnStart")]
    TurnStart,
    #[serde(rename = "llmProposal")]
    LlmProposal,
    #[serde(rename = "resourceFact")]
    ResourceFact,
    #[serde(rename = "userGuidance")]
    UserGuidance,
    #[serde(rename = "permission")]
    Permission,
    #[serde(rename = "review")]
    Review,
    #[serde(rename = "final")]
    Final,
    #[serde(rename = "diagnostic")]
    Diagnostic,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineExecutionPhase {
    #[serde(rename = "explore")]
    Explore,
    #[serde(rename = "execute")]
    Execute,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineDisplayHints {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub density: Option<AgentTimelineDisplayDensity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_mode: Option<AgentTimelineEvidenceMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapse_after_complete: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_kind: Option<AgentTimelineCheckpointKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_in_task_list: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_list_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_list_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<AgentTimelineExecutionPhase>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineInteractionOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineDecisionRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub allows_freeform: bool,
    pub options: Vec<AgentTimelineInteractionOption>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineInteractionKind {
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "permission")]
    Permission,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineInteractionState {
    #[serde(rename = "open")]
    Open,
    #[serde(rename = "submitting")]
    Submitting,
    #[serde(rename = "accepted")]
    Accepted,
    #[serde(rename = "rejected")]
    Rejected,
    #[serde(rename = "needsRevision")]
    NeedsRevision,
    #[serde(rename = "superseded")]
    Superseded,
    #[serde(rename = "expired")]
    Expired,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineDecisionSource {
    #[serde(rename = "button")]
    Button,
    #[serde(rename = "freeText")]
    FreeText,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineSelectedDecision {
    pub decision: String,
    pub source: AgentTimelineDecisionSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineInteractionView {
    pub interaction_id: String,
    pub interaction_revision: String,
    pub target_id: String,
    pub kind: AgentTimelineInteractionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub state: AgentTimelineInteractionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_request: Option<AgentTimelineDecisionRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_decision: Option<AgentTimelineSelectedDecision>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineStructuredProjectionKind {
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "review")]
    Review,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineStructuredProjectionItem {
    pub item_id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_args: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_refs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit_refs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance_criteria: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_conditions: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineStructuredProjectionSection {
    pub section_id: String,
    pub title_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_args: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub empty_message_key: Option<String>,
    pub items: Vec<AgentTimelineStructuredProjectionItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineStructuredProjection {
    pub kind: AgentTimelineStructuredProjectionKind,
    pub schema_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_args: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_args: Option<BTreeMap<String, String>>,
    pub sections: Vec<AgentTimelineStructuredProjectionSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineBlock {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_mode: Option<AgentTimelineDeliveryMode>,
    pub durability: AgentTimelineDurability,
    pub kind: AgentTimelineBlockKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrative_kind: Option<AgentTimelineNarrativeKind>,
    pub entry_role: AgentTimelineEntryRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_phase: Option<AgentTimelineProviderPhase>,
    pub title: String,
    pub summary: String,
    pub status: AgentTimelineStatus,
    pub default_collapsed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_markdown: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub localized_content: Option<AgentTimelineLocalizedText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_projection: Option<AgentTimelineStructuredProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_request: Option<AgentTimelineDecisionRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction: Option<AgentTimelineInteractionView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<AgentTimelineAttachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_hints: Option<AgentTimelineDisplayHints>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_refs: Option<Vec<String>>,
    pub provenance: AgentTimelineProvenance,
    pub language_binding: AgentTimelineLanguageBinding,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_projection_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineWorkOperationStatus {
    #[serde(rename = "preparing")]
    Preparing,
    #[serde(rename = "queued")]
    Queued,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "awaitingCapability")]
    AwaitingCapability,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "denied")]
    Denied,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "failedAfterObservedEffect")]
    FailedAfterObservedEffect,
    #[serde(rename = "indeterminate")]
    Indeterminate,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "stale")]
    Stale,
    #[serde(rename = "unexecuted")]
    Unexecuted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineWorkOperationAttempt {
    pub attempt_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<AgentTimelineWorkOperationStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineWorkOperation {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invocation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<Vec<AgentTimelineWorkOperationAttempt>>,
    pub tool_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub status: AgentTimelineWorkOperationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub targets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect_summary: Option<String>,
    pub resource_refs: Vec<String>,
    pub fact_refs: Vec<String>,
    pub effect_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineWorkAttentionKind {
    #[serde(rename = "capability")]
    Capability,
    #[serde(rename = "denial")]
    Denial,
    #[serde(rename = "failure")]
    Failure,
    #[serde(rename = "observedEffectFailure")]
    ObservedEffectFailure,
    #[serde(rename = "indeterminate")]
    Indeterminate,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineWorkAttentionStatus {
    #[serde(rename = "unresolved")]
    Unresolved,
    #[serde(rename = "resolved")]
    Resolved,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineWorkAttention {
    pub kind: AgentTimelineWorkAttentionKind,
    pub status: AgentTimelineWorkAttentionStatus,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub fact_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct AgentTimelineNullableWorkAttention(pub Option<AgentTimelineWorkAttention>);

impl<'de> Deserialize<'de> for AgentTimelineNullableWorkAttention {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<AgentTimelineWorkAttention>::deserialize(deserializer).map(Self)
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineWorkSegmentLifecycle {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "failed")]
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineWorkSegment {
    pub id: String,
    pub revision: u64,
    pub sequence: u64,
    pub lifecycle: AgentTimelineWorkSegmentLifecycle,
    pub attention: AgentTimelineNullableWorkAttention,
    pub operations: Vec<AgentTimelineWorkOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    pub provenance: AgentTimelineProvenance,
    pub fact_refs: Vec<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum AgentTimelineTurnPart {
    #[serde(rename = "block")]
    Block {
        #[serde(rename = "blockId")]
        block_id: String,
    },
    #[serde(rename = "workSegment")]
    WorkSegment {
        #[serde(rename = "workSegmentId")]
        work_segment_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineTurn {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    pub session_id: String,
    pub status: AgentTimelineStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    pub blocks: Vec<AgentTimelineBlock>,
    pub work_segments: Vec<AgentTimelineWorkSegment>,
    pub parts: Vec<AgentTimelineTurnPart>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineRunStatus {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "waitingUser")]
    WaitingUser,
    #[serde(rename = "waitingExternal")]
    WaitingExternal,
    #[serde(rename = "paused")]
    Paused,
    #[serde(rename = "succeeded")]
    Succeeded,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "cancelled")]
    Cancelled,
}

impl AgentTimelineRunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineRunPhase {
    #[serde(rename = "preparing")]
    Preparing,
    #[serde(rename = "processing")]
    Processing,
    #[serde(rename = "executing")]
    Executing,
    #[serde(rename = "validating")]
    Validating,
    #[serde(rename = "waiting")]
    Waiting,
    #[serde(rename = "settled")]
    Settled,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineCurrentActivityCode {
    #[serde(rename = "session.admitting")]
    SessionAdmitting,
    #[serde(rename = "provider.awaitingFirstByte")]
    ProviderAwaitingFirstByte,
    #[serde(rename = "provider.reasoning")]
    ProviderReasoning,
    #[serde(rename = "provider.composing")]
    ProviderComposing,
    #[serde(rename = "resource.resolving")]
    ResourceResolving,
    #[serde(rename = "kernel.executing")]
    KernelExecuting,
    #[serde(rename = "session.validating")]
    SessionValidating,
    #[serde(rename = "session.persisting")]
    SessionPersisting,
    #[serde(rename = "retry.backoff")]
    RetryBackoff,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineCurrentActivity {
    pub code: AgentTimelineCurrentActivityCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_segment_id: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineWaitKind {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "external")]
    External,
    #[serde(rename = "paused")]
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineWait {
    pub kind: AgentTimelineWaitKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct AgentTimelineNullableCurrentActivity(pub Option<AgentTimelineCurrentActivity>);

impl<'de> Deserialize<'de> for AgentTimelineNullableCurrentActivity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<AgentTimelineCurrentActivity>::deserialize(deserializer).map(Self)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct AgentTimelineNullableWait(pub Option<AgentTimelineWait>);

impl<'de> Deserialize<'de> for AgentTimelineNullableWait {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<AgentTimelineWait>::deserialize(deserializer).map(Self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineRunProjection {
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub revision: u64,
    pub status: AgentTimelineRunStatus,
    pub phase: AgentTimelineRunPhase,
    pub current_activity: AgentTimelineNullableCurrentActivity,
    pub wait: AgentTimelineNullableWait,
    pub language_binding: AgentTimelineLanguageBinding,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineTaskProjectionItem {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub status: AgentTimelineStatus,
    pub block_id: String,
    pub narrative_kind: AgentTimelineNarrativeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settlement_kind: Option<AgentTimelineTaskSettlementKind>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineTaskSettlementKind {
    #[serde(rename = "sessionEvidenceSatisfied")]
    SessionEvidenceSatisfied,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineTaskProjection {
    pub title: String,
    pub items: Vec<AgentTimelineTaskProjectionItem>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelinePermissionRequestKind {
    #[serde(rename = "runtimePermission")]
    RuntimePermission,
    #[serde(rename = "scopeExpansion")]
    ScopeExpansion,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum AgentTimelineRiskLevel {
    #[serde(rename = "low")]
    Low,
    #[serde(rename = "medium")]
    Medium,
    #[serde(rename = "high")]
    High,
    #[serde(rename = "critical")]
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelinePermissionRequestView {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_kind: Option<AgentTimelinePermissionRequestKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_bundle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affected_operation_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    pub tool_name: String,
    pub risk_level: AgentTimelineRiskLevel,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelinePendingPermission {
    pub interaction_id: String,
    pub interaction_revision: String,
    pub target_id: String,
    pub request_id: String,
    pub request: AgentTimelinePermissionRequestView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelinePendingPlan {
    pub interaction_id: String,
    pub interaction_revision: String,
    pub target_id: String,
    pub run_id: String,
    pub plan_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum AgentTimelinePendingInteraction {
    #[serde(rename = "permission")]
    Permission(AgentTimelinePendingPermission),
    #[serde(rename = "plan")]
    Plan(AgentTimelinePendingPlan),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineInteractionProjection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<AgentTimelinePendingInteraction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineTokenUsageTotals {
    pub prompt_cache_hit_tokens: u64,
    pub prompt_cache_miss_tokens: u64,
    pub cached_tokens: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub provider_call_count: u64,
    pub providers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineTokenUsageRequest {
    pub request_id: String,
    pub turn_id: String,
    pub user_event_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    pub stages: Vec<String>,
    pub prompt_cache_hit_tokens: u64,
    pub prompt_cache_miss_tokens: u64,
    pub cached_tokens: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub provider_call_count: u64,
    pub providers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineTokenUsageProjection {
    pub totals: AgentTimelineTokenUsageTotals,
    pub requests: Vec<AgentTimelineTokenUsageRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineWorkspaceProjection {
    pub revision: u64,
    pub changed_targets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineSnapshot {
    pub schema_version: String,
    pub shape_version: String,
    pub session_id: String,
    pub revision: u64,
    pub source_event_version: u64,
    pub generated_at: String,
    pub turns: Vec<AgentTimelineTurn>,
    pub event_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_projection: Option<AgentTimelineTaskProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_projection: Option<AgentTimelineInteractionProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_projection: Option<AgentTimelineRunProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_usage_projection: Option<AgentTimelineTokenUsageProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_projection: Option<AgentTimelineWorkspaceProjection>,
}

#[derive(Debug, Clone)]
pub enum AgentTimelineProjectionReplacement<T> {
    Unchanged,
    Clear,
    Replace(T),
}

impl<T> Default for AgentTimelineProjectionReplacement<T> {
    fn default() -> Self {
        Self::Unchanged
    }
}

impl<T> AgentTimelineProjectionReplacement<T> {
    fn is_unchanged(&self) -> bool {
        matches!(self, Self::Unchanged)
    }
}

impl<T> Serialize for AgentTimelineProjectionReplacement<T>
where
    T: Serialize,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Unchanged | Self::Clear => serializer.serialize_none(),
            Self::Replace(value) => value.serialize(serializer),
        }
    }
}

impl<'de, T> Deserialize<'de> for AgentTimelineProjectionReplacement<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer)
            .map(|value| value.map(Self::Replace).unwrap_or(Self::Clear))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineRootProjectionReplacements {
    #[serde(
        default,
        skip_serializing_if = "AgentTimelineProjectionReplacement::is_unchanged"
    )]
    pub task_projection: AgentTimelineProjectionReplacement<AgentTimelineTaskProjection>,
    #[serde(
        default,
        skip_serializing_if = "AgentTimelineProjectionReplacement::is_unchanged"
    )]
    pub interaction_projection:
        AgentTimelineProjectionReplacement<AgentTimelineInteractionProjection>,
    #[serde(
        default,
        skip_serializing_if = "AgentTimelineProjectionReplacement::is_unchanged"
    )]
    pub run_projection: AgentTimelineProjectionReplacement<AgentTimelineRunProjection>,
    #[serde(
        default,
        skip_serializing_if = "AgentTimelineProjectionReplacement::is_unchanged"
    )]
    pub token_usage_projection:
        AgentTimelineProjectionReplacement<AgentTimelineTokenUsageProjection>,
    #[serde(
        default,
        skip_serializing_if = "AgentTimelineProjectionReplacement::is_unchanged"
    )]
    pub workspace_projection: AgentTimelineProjectionReplacement<AgentTimelineWorkspaceProjection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineDelta {
    pub schema_version: String,
    pub shape_version: String,
    pub session_id: String,
    pub base_revision: u64,
    pub revision: u64,
    pub source_event_version: u64,
    pub generated_at: String,
    pub event_count: u64,
    pub turn_replacements: Vec<AgentTimelineTurn>,
    pub removed_turn_ids: Vec<String>,
    pub root_replacements: AgentTimelineRootProjectionReplacements,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentTimelineStreamEvent {
    Snapshot {
        session_id: String,
        revision: u64,
        snapshot: AgentTimelineSnapshot,
    },
    Delta {
        session_id: String,
        revision: u64,
        delta: AgentTimelineDelta,
    },
}

#[derive(Debug, Clone)]
pub enum AgentTimelineStreamReduction {
    Unchanged,
    Replace(AgentTimelineSnapshot),
    ReconcileRequired {
        current_revision: Option<u64>,
        delta_base_revision: u64,
    },
}

pub fn reduce_agent_timeline_stream_event(
    current: Option<&AgentTimelineSnapshot>,
    event: &AgentTimelineStreamEvent,
) -> Result<AgentTimelineStreamReduction, AgentProjectionValidationError> {
    event.validate()?;
    match event {
        AgentTimelineStreamEvent::Snapshot { snapshot, .. } => {
            if let Some(current) = current {
                if current.session_id != snapshot.session_id {
                    return Err(AgentProjectionValidationError::new(
                        "timeline stream snapshot belongs to another Session",
                    ));
                }
                if snapshot.revision < current.revision {
                    return Ok(AgentTimelineStreamReduction::Unchanged);
                }
                if snapshot.revision == current.revision {
                    if serialized_projection_eq(current, snapshot)? {
                        return Ok(AgentTimelineStreamReduction::Unchanged);
                    }
                    return Ok(AgentTimelineStreamReduction::ReconcileRequired {
                        current_revision: Some(current.revision),
                        delta_base_revision: snapshot.revision,
                    });
                }
            }
            Ok(AgentTimelineStreamReduction::Replace(snapshot.clone()))
        }
        AgentTimelineStreamEvent::Delta { delta, .. } => {
            let Some(current) = current else {
                return Ok(AgentTimelineStreamReduction::ReconcileRequired {
                    current_revision: None,
                    delta_base_revision: delta.base_revision,
                });
            };
            if current.session_id != delta.session_id {
                return Err(AgentProjectionValidationError::new(
                    "timeline stream delta belongs to another Session",
                ));
            }
            if delta.revision < current.revision {
                return Ok(AgentTimelineStreamReduction::Unchanged);
            }
            if delta.revision == current.revision {
                // A materialized snapshot cannot prove that a repeated delta with the same
                // terminal revision has identical replacements or baseRevision. Reconcile
                // against the canonical full snapshot instead of accepting metadata equality.
                return Ok(AgentTimelineStreamReduction::ReconcileRequired {
                    current_revision: Some(current.revision),
                    delta_base_revision: delta.base_revision,
                });
            }
            if current.revision != delta.base_revision {
                return Ok(AgentTimelineStreamReduction::ReconcileRequired {
                    current_revision: Some(current.revision),
                    delta_base_revision: delta.base_revision,
                });
            }
            Ok(AgentTimelineStreamReduction::Replace(
                current.apply_delta(delta)?,
            ))
        }
    }
}

fn serialized_projection_eq(
    left: &AgentTimelineSnapshot,
    right: &AgentTimelineSnapshot,
) -> Result<bool, AgentProjectionValidationError> {
    let left = serde_json::to_vec(left).map_err(|error| {
        AgentProjectionValidationError::new(format!(
            "current timeline snapshot could not be compared: {error}"
        ))
    })?;
    let right = serde_json::to_vec(right).map_err(|error| {
        AgentProjectionValidationError::new(format!(
            "incoming timeline snapshot could not be compared: {error}"
        ))
    })?;
    Ok(left == right)
}

impl AgentTimelineSnapshot {
    pub fn validate(&self) -> Result<(), AgentProjectionValidationError> {
        validate_schema_and_shape(&self.schema_version, &self.shape_version)?;
        validate_safe_integer(self.revision, "projection.revision")?;
        validate_safe_integer(self.source_event_version, "projection.sourceEventVersion")?;
        validate_safe_integer(self.event_count, "projection.eventCount")?;
        validate_identity(&self.session_id, "projection.sessionId")?;
        validate_identity(&self.generated_at, "projection.generatedAt")?;
        if self.event_count > self.source_event_version {
            return Err(AgentProjectionValidationError::new(
                "projection.eventCount cannot exceed projection.sourceEventVersion",
            ));
        }

        let mut identities = ProjectionIdentities::default();
        for (index, turn) in self.turns.iter().enumerate() {
            validate_turn(turn, &self.session_id, &mut identities)?;
            validate_native_turn_invariants(turn, Some(index as u64))?;
        }
        validate_optional_root_projections(
            self.task_projection.as_ref(),
            self.interaction_projection.as_ref(),
            self.run_projection.as_ref(),
            self.token_usage_projection.as_ref(),
            self.workspace_projection.as_ref(),
            Some(&identities),
        )?;
        reject_private_fields_in_serializable(self)
    }

    pub fn apply_delta(
        &self,
        delta: &AgentTimelineDelta,
    ) -> Result<Self, AgentProjectionValidationError> {
        self.validate()?;
        delta.validate()?;
        if self.session_id != delta.session_id {
            return Err(AgentProjectionValidationError::new(
                "timeline delta belongs to another Session",
            ));
        }
        if self.revision != delta.base_revision {
            return Err(AgentProjectionValidationError::new(format!(
                "timeline delta base revision mismatch: expected {}, received {}",
                self.revision, delta.base_revision
            )));
        }
        if delta.source_event_version <= self.source_event_version
            || delta.event_count <= self.event_count
        {
            return Err(AgentProjectionValidationError::new(
                "timeline delta source event version and event count must advance",
            ));
        }

        let removed = delta
            .removed_turn_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let replacements = delta
            .turn_replacements
            .iter()
            .map(|turn| (turn.id.as_str(), turn))
            .collect::<BTreeMap<_, _>>();
        if removed
            .iter()
            .any(|turn_id| replacements.contains_key(turn_id))
        {
            return Err(AgentProjectionValidationError::new(
                "timeline delta cannot replace and remove the same turn",
            ));
        }
        let mut turns = Vec::with_capacity(
            self.turns
                .len()
                .saturating_add(delta.turn_replacements.len()),
        );
        let mut known_turn_ids = HashSet::new();
        for turn in &self.turns {
            if removed.contains(turn.id.as_str()) {
                continue;
            }
            turns.push(
                replacements
                    .get(turn.id.as_str())
                    .map(|replacement| (*replacement).clone())
                    .unwrap_or_else(|| turn.clone()),
            );
            known_turn_ids.insert(turn.id.as_str());
        }
        for replacement in &delta.turn_replacements {
            if !known_turn_ids.contains(replacement.id.as_str()) {
                turns.push(replacement.clone());
            }
        }
        turns.sort_by_key(|turn| turn.sequence.unwrap_or(u64::MAX));

        let mut next = self.clone();
        next.revision = delta.revision;
        next.source_event_version = delta.source_event_version;
        next.generated_at = delta.generated_at.clone();
        next.event_count = delta.event_count;
        next.turns = turns;
        apply_root_replacements(&mut next, &delta.root_replacements);
        next.validate()?;
        Ok(next)
    }
}

impl AgentTimelineDelta {
    pub fn validate(&self) -> Result<(), AgentProjectionValidationError> {
        validate_schema_and_shape(&self.schema_version, &self.shape_version)?;
        validate_identity(&self.session_id, "delta.sessionId")?;
        validate_identity(&self.generated_at, "delta.generatedAt")?;
        validate_safe_integer(self.base_revision, "delta.baseRevision")?;
        validate_safe_integer(self.revision, "delta.revision")?;
        validate_safe_integer(self.source_event_version, "delta.sourceEventVersion")?;
        validate_safe_integer(self.event_count, "delta.eventCount")?;
        if self.revision <= self.base_revision {
            return Err(AgentProjectionValidationError::new(
                "delta.revision must be greater than delta.baseRevision",
            ));
        }
        if self.event_count > self.source_event_version {
            return Err(AgentProjectionValidationError::new(
                "delta.eventCount cannot exceed delta.sourceEventVersion",
            ));
        }

        let mut identities = ProjectionIdentities::default();
        for turn in &self.turn_replacements {
            validate_turn(turn, &self.session_id, &mut identities)?;
            validate_native_turn_invariants(turn, None)?;
        }
        let mut removed_turn_ids = HashSet::new();
        for turn_id in &self.removed_turn_ids {
            validate_identity(turn_id, "delta.removedTurnIds")?;
            if !removed_turn_ids.insert(turn_id.as_str()) {
                return Err(AgentProjectionValidationError::new(format!(
                    "delta repeats removed turn {turn_id}"
                )));
            }
            if identities.turn_ids.contains(turn_id.as_str()) {
                return Err(AgentProjectionValidationError::new(format!(
                    "delta both replaces and removes turn {turn_id}"
                )));
            }
        }
        validate_root_replacements(&self.root_replacements)?;
        reject_private_fields_in_serializable(self)
    }
}

impl AgentTimelineStreamEvent {
    pub fn validate(&self) -> Result<(), AgentProjectionValidationError> {
        match self {
            Self::Snapshot {
                session_id,
                revision,
                snapshot,
            } => {
                snapshot.validate()?;
                if session_id != &snapshot.session_id || revision != &snapshot.revision {
                    return Err(AgentProjectionValidationError::new(
                        "snapshot stream envelope identity does not match its projection",
                    ));
                }
            }
            Self::Delta {
                session_id,
                revision,
                delta,
            } => {
                delta.validate()?;
                if session_id != &delta.session_id || revision != &delta.revision {
                    return Err(AgentProjectionValidationError::new(
                        "delta stream envelope identity does not match its projection",
                    ));
                }
            }
        }
        reject_private_fields_in_serializable(self)
    }
}

pub(crate) fn reject_private_projection_fields(
    value: &Value,
) -> Result<(), AgentProjectionValidationError> {
    match value {
        Value::Array(items) => {
            for item in items {
                reject_private_projection_fields(item)?;
            }
        }
        Value::Object(fields) => {
            for (key, nested) in fields {
                let normalized = key
                    .bytes()
                    .filter(u8::is_ascii_alphanumeric)
                    .map(|byte| byte.to_ascii_lowercase())
                    .collect::<Vec<_>>();
                if matches!(
                    normalized.as_slice(),
                    b"events"
                        | b"payload"
                        | b"kernelevent"
                        | b"rawprovider"
                        | b"rawupstreamenvelope"
                        | b"providertrace"
                        | b"rawarguments"
                        | b"reasoning"
                        | b"reasoningcontent"
                        | b"reasoningtrace"
                        | b"thinking"
                        | b"thinkingdelta"
                        | b"analysis"
                        | b"chainofthought"
                ) {
                    return Err(AgentProjectionValidationError::new(format!(
                        "shared conversation projection contains private field {key}"
                    )));
                }
                reject_private_projection_fields(nested)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn reject_private_fields_in_serializable<T>(value: &T) -> Result<(), AgentProjectionValidationError>
where
    T: Serialize,
{
    let value = serde_json::to_value(value).map_err(|error| {
        AgentProjectionValidationError::new(format!(
            "shared conversation projection could not be validated: {error}"
        ))
    })?;
    reject_private_projection_fields(&value)
}

#[derive(Default)]
struct ProjectionIdentities<'a> {
    turn_ids: HashSet<&'a str>,
    block_ids: HashSet<&'a str>,
    work_segment_ids: HashSet<&'a str>,
    work_segment_turn_ids: HashMap<&'a str, &'a str>,
    operation_ids: HashSet<&'a str>,
    operation_segment_ids: HashMap<&'a str, &'a str>,
}

fn validate_schema_and_shape(
    schema_version: &str,
    shape_version: &str,
) -> Result<(), AgentProjectionValidationError> {
    if schema_version != AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2 {
        return Err(AgentProjectionValidationError::new(
            "unsupported shared conversation projection schema",
        ));
    }
    if shape_version != AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1 {
        return Err(AgentProjectionValidationError::new(
            "unsupported shared conversation projection shape",
        ));
    }
    Ok(())
}

fn validate_turn<'a>(
    turn: &'a AgentTimelineTurn,
    session_id: &str,
    identities: &mut ProjectionIdentities<'a>,
) -> Result<(), AgentProjectionValidationError> {
    validate_identity(&turn.id, "turn.id")?;
    validate_optional_safe_integer(turn.sequence, "turn.sequence")?;
    validate_optional_identity(turn.started_at.as_deref(), "turn.startedAt")?;
    validate_optional_identity(turn.completed_at.as_deref(), "turn.completedAt")?;
    if turn.session_id != session_id {
        return Err(AgentProjectionValidationError::new(
            "turn crosses Session identity",
        ));
    }
    if !identities.turn_ids.insert(&turn.id) {
        return Err(AgentProjectionValidationError::new(format!(
            "projection repeats turn {}",
            turn.id
        )));
    }

    let mut local_block_ids = HashSet::new();
    for block in &turn.blocks {
        validate_block(block)?;
        if !local_block_ids.insert(block.id.as_str())
            || !identities.block_ids.insert(block.id.as_str())
        {
            return Err(AgentProjectionValidationError::new(format!(
                "projection repeats block {}",
                block.id
            )));
        }
    }

    let mut local_segment_ids = HashSet::new();
    for segment in &turn.work_segments {
        validate_work_segment(segment, identities)?;
        if !local_segment_ids.insert(segment.id.as_str())
            || !identities.work_segment_ids.insert(segment.id.as_str())
        {
            return Err(AgentProjectionValidationError::new(format!(
                "projection repeats work segment {}",
                segment.id
            )));
        }
        identities
            .work_segment_turn_ids
            .insert(segment.id.as_str(), turn.id.as_str());
    }

    let mut referenced_blocks = HashSet::new();
    let mut referenced_segments = HashSet::new();
    for part in &turn.parts {
        match part {
            AgentTimelineTurnPart::Block { block_id } => {
                validate_identity(block_id, "part.blockId")?;
                if !local_block_ids.contains(block_id.as_str())
                    || !referenced_blocks.insert(block_id.as_str())
                {
                    return Err(AgentProjectionValidationError::new(format!(
                        "turn {} has invalid block part {block_id}",
                        turn.id
                    )));
                }
            }
            AgentTimelineTurnPart::WorkSegment { work_segment_id } => {
                validate_identity(work_segment_id, "part.workSegmentId")?;
                if !local_segment_ids.contains(work_segment_id.as_str())
                    || !referenced_segments.insert(work_segment_id.as_str())
                {
                    return Err(AgentProjectionValidationError::new(format!(
                        "turn {} has invalid work segment part {work_segment_id}",
                        turn.id
                    )));
                }
            }
        }
    }
    if referenced_blocks.len() != local_block_ids.len()
        || referenced_segments.len() != local_segment_ids.len()
    {
        return Err(AgentProjectionValidationError::new(format!(
            "turn {} parts do not cover every block and work segment exactly once",
            turn.id
        )));
    }
    Ok(())
}

fn validate_native_turn_invariants(
    turn: &AgentTimelineTurn,
    expected_sequence: Option<u64>,
) -> Result<(), AgentProjectionValidationError> {
    if turn.sequence.is_none()
        || expected_sequence.is_some_and(|expected| turn.sequence != Some(expected))
        || (turn.status.is_terminal() && turn.completed_at.is_none())
        || (!turn.status.is_terminal() && turn.completed_at.is_some())
    {
        return Err(AgentProjectionValidationError::new(
            "native turn has invalid sequence or lifecycle",
        ));
    }
    for (index, block) in turn.blocks.iter().enumerate() {
        validate_native_block_invariants(block, index as u64)?;
    }
    for (index, segment) in turn.work_segments.iter().enumerate() {
        if segment.sequence != index as u64
            || (matches!(segment.lifecycle, AgentTimelineWorkSegmentLifecycle::Active)
                && segment.completed_at.is_some())
            || (!matches!(segment.lifecycle, AgentTimelineWorkSegmentLifecycle::Active)
                && segment.completed_at.is_none())
        {
            return Err(AgentProjectionValidationError::new(
                "native work segment has invalid sequence or lifecycle",
            ));
        }
    }
    Ok(())
}

fn validate_native_block_invariants(
    block: &AgentTimelineBlock,
    expected_sequence: u64,
) -> Result<(), AgentProjectionValidationError> {
    if block.sequence != Some(expected_sequence) {
        return Err(AgentProjectionValidationError::new(
            "native block has invalid sequence",
        ));
    }
    let semantics_valid = match block.kind {
        AgentTimelineBlockKind::User => {
            block.narrative_kind == Some(AgentTimelineNarrativeKind::User)
                && block.entry_role == AgentTimelineEntryRole::UserMessage
                && block.provider_phase.is_none()
                && block.provenance.origin == AgentTimelineProvenanceOrigin::User
                && block.provenance.authority == AgentTimelineProvenanceAuthority::User
        }
        AgentTimelineBlockKind::Assistant => {
            block.narrative_kind == Some(AgentTimelineNarrativeKind::AssistantText)
                && block.provenance.origin == AgentTimelineProvenanceOrigin::Provider
                && block.provenance.authority == AgentTimelineProvenanceAuthority::Session
                && match block.provider_phase {
                    Some(AgentTimelineProviderPhase::Commentary) => {
                        block.entry_role == AgentTimelineEntryRole::AgentUpdate
                    }
                    Some(AgentTimelineProviderPhase::FinalAnswer) => {
                        block.entry_role == AgentTimelineEntryRole::FinalAnswer
                    }
                    None => matches!(
                        block.entry_role,
                        AgentTimelineEntryRole::AgentUpdate | AgentTimelineEntryRole::FinalAnswer
                    ),
                }
        }
        AgentTimelineBlockKind::Plan => {
            block.narrative_kind == Some(AgentTimelineNarrativeKind::Plan)
                && block.entry_role == AgentTimelineEntryRole::Interaction
                && block.provider_phase.is_none()
        }
        AgentTimelineBlockKind::Permission => {
            block.narrative_kind == Some(AgentTimelineNarrativeKind::Permission)
                && block.entry_role == AgentTimelineEntryRole::Interaction
                && block.provider_phase.is_none()
        }
        AgentTimelineBlockKind::Review => {
            block.narrative_kind == Some(AgentTimelineNarrativeKind::Review)
                && block.entry_role == AgentTimelineEntryRole::Interaction
                && block.provider_phase.is_none()
        }
        AgentTimelineBlockKind::Error => {
            block.narrative_kind == Some(AgentTimelineNarrativeKind::Diagnostic)
                && block.entry_role == AgentTimelineEntryRole::Diagnostic
                && block.provider_phase.is_none()
        }
    };
    if !semantics_valid
        || (block.attachments.is_some() && !matches!(block.kind, AgentTimelineBlockKind::User))
        || ((block.decision_request.is_some() || block.interaction.is_some())
            && !matches!(
                block.kind,
                AgentTimelineBlockKind::Plan | AgentTimelineBlockKind::Permission
            ))
    {
        return Err(AgentProjectionValidationError::new(
            "native block semantics are inconsistent",
        ));
    }
    Ok(())
}

fn validate_block(block: &AgentTimelineBlock) -> Result<(), AgentProjectionValidationError> {
    validate_identity(&block.id, "block.id")?;
    validate_identity(&block.title, "block.title")?;
    validate_optional_safe_integer(block.sequence, "block.sequence")?;
    validate_optional_safe_integer(block.revision, "block.revision")?;
    validate_language_binding(&block.language_binding, "block.languageBinding")?;
    validate_provenance(&block.provenance, "block.provenance")?;
    for attachment in block.attachments.iter().flatten() {
        validate_identity(&attachment.path, "block.attachments.path")?;
        validate_optional_identity(
            attachment.resource_id.as_deref(),
            "block.attachments.resourceId",
        )?;
        validate_optional_identity(
            attachment.folder_id.as_deref(),
            "block.attachments.folderId",
        )?;
    }
    if let Some(interaction) = &block.interaction {
        validate_interaction_view(interaction)?;
    }
    Ok(())
}

fn validate_work_segment<'a>(
    segment: &'a AgentTimelineWorkSegment,
    identities: &mut ProjectionIdentities<'a>,
) -> Result<(), AgentProjectionValidationError> {
    validate_identity(&segment.id, "workSegment.id")?;
    validate_safe_integer(segment.revision, "workSegment.revision")?;
    validate_safe_integer(segment.sequence, "workSegment.sequence")?;
    validate_optional_identity(segment.started_at.as_deref(), "workSegment.startedAt")?;
    validate_optional_identity(segment.completed_at.as_deref(), "workSegment.completedAt")?;
    if (matches!(segment.lifecycle, AgentTimelineWorkSegmentLifecycle::Active)
        && segment.completed_at.is_some())
        || (!matches!(segment.lifecycle, AgentTimelineWorkSegmentLifecycle::Active)
            && segment.completed_at.is_none())
    {
        return Err(AgentProjectionValidationError::new(format!(
            "work segment {} has an invalid lifecycle timestamp",
            segment.id
        )));
    }
    validate_provenance(&segment.provenance, "workSegment.provenance")?;
    validate_identity_array(&segment.fact_refs, "workSegment.factRefs")?;

    let mut local_operation_ids = HashSet::new();
    for operation in &segment.operations {
        validate_work_operation(operation)?;
        if !local_operation_ids.insert(operation.operation_id.as_str())
            || !identities
                .operation_ids
                .insert(operation.operation_id.as_str())
        {
            return Err(AgentProjectionValidationError::new(format!(
                "projection repeats operation {}",
                operation.operation_id
            )));
        }
        identities
            .operation_segment_ids
            .insert(operation.operation_id.as_str(), segment.id.as_str());
    }
    if let Some(attention) = &segment.attention.0 {
        validate_identity(&attention.summary, "workSegment.attention.summary")?;
        validate_identity_array(&attention.fact_refs, "workSegment.attention.factRefs")?;
        if let Some(operation_id) = &attention.operation_id {
            if !local_operation_ids.contains(operation_id.as_str()) {
                return Err(AgentProjectionValidationError::new(format!(
                    "work segment {} attention references another segment operation",
                    segment.id
                )));
            }
        }
    }
    Ok(())
}

fn validate_work_operation(
    operation: &AgentTimelineWorkOperation,
) -> Result<(), AgentProjectionValidationError> {
    validate_identity(&operation.operation_id, "operation.operationId")?;
    validate_identity(&operation.tool_id, "operation.toolId")?;
    validate_optional_identity(operation.invocation_id.as_deref(), "operation.invocationId")?;
    validate_identity_array(&operation.resource_refs, "operation.resourceRefs")?;
    validate_identity_array(&operation.fact_refs, "operation.factRefs")?;
    validate_identity_array(&operation.effect_refs, "operation.effectRefs")?;
    for target in operation.targets.iter().flatten() {
        validate_identity(target, "operation.targets")?;
    }
    let mut attempt_ids = HashSet::new();
    for attempt in operation.attempts.iter().flatten() {
        validate_identity(&attempt.attempt_id, "operation.attempts.attemptId")?;
        if !attempt_ids.insert(attempt.attempt_id.as_str()) {
            return Err(AgentProjectionValidationError::new(format!(
                "operation {} repeats attempt {}",
                operation.operation_id, attempt.attempt_id
            )));
        }
        validate_optional_identity(
            attempt.started_at.as_deref(),
            "operation.attempts.startedAt",
        )?;
        validate_optional_identity(
            attempt.completed_at.as_deref(),
            "operation.attempts.completedAt",
        )?;
    }
    Ok(())
}

fn validate_optional_root_projections(
    task: Option<&AgentTimelineTaskProjection>,
    interaction: Option<&AgentTimelineInteractionProjection>,
    run: Option<&AgentTimelineRunProjection>,
    token_usage: Option<&AgentTimelineTokenUsageProjection>,
    workspace: Option<&AgentTimelineWorkspaceProjection>,
    identities: Option<&ProjectionIdentities<'_>>,
) -> Result<(), AgentProjectionValidationError> {
    if let Some(task) = task {
        let mut item_ids = HashSet::new();
        for item in &task.items {
            validate_identity(&item.id, "taskProjection.items.id")?;
            validate_identity(&item.block_id, "taskProjection.items.blockId")?;
            if !item_ids.insert(item.id.as_str()) {
                return Err(AgentProjectionValidationError::new(format!(
                    "task projection repeats item {}",
                    item.id
                )));
            }
            if identities.is_some_and(|value| !value.block_ids.contains(item.block_id.as_str())) {
                return Err(AgentProjectionValidationError::new(format!(
                    "task projection references missing block {}",
                    item.block_id
                )));
            }
        }
    }
    if let Some(interaction) = interaction {
        if let Some(pending) = &interaction.pending {
            match pending {
                AgentTimelinePendingInteraction::Permission(value) => {
                    validate_pending_interaction_identity(
                        &value.interaction_id,
                        &value.interaction_revision,
                        &value.target_id,
                    )?;
                    validate_optional_block_reference(value.block_id.as_deref(), identities)?;
                }
                AgentTimelinePendingInteraction::Plan(value) => {
                    validate_pending_interaction_identity(
                        &value.interaction_id,
                        &value.interaction_revision,
                        &value.target_id,
                    )?;
                    validate_identity(&value.run_id, "interactionProjection.pending.runId")?;
                    validate_identity(&value.plan_id, "interactionProjection.pending.planId")?;
                    validate_optional_block_reference(value.block_id.as_deref(), identities)?;
                }
            }
        }
    }
    if let Some(run) = run {
        validate_run_projection(run)?;
        if let Some(identities) = identities {
            if let Some(turn_id) = &run.turn_id {
                if !identities.turn_ids.contains(turn_id.as_str()) {
                    return Err(AgentProjectionValidationError::new(format!(
                        "run projection references missing turn {turn_id}"
                    )));
                }
            }
            if let Some(activity) = &run.current_activity.0 {
                if let Some(work_segment_id) = &activity.work_segment_id {
                    let work_segment_turn_id = identities
                        .work_segment_turn_ids
                        .get(work_segment_id.as_str())
                        .copied();
                    if work_segment_turn_id.is_none()
                        || run.turn_id.as_deref() != work_segment_turn_id
                    {
                        return Err(AgentProjectionValidationError::new(format!(
                            "run projection current activity references another turn work segment {work_segment_id}"
                        )));
                    }
                }
                if let Some(operation_id) = &activity.operation_id {
                    let operation_segment_id = identities
                        .operation_segment_ids
                        .get(operation_id.as_str())
                        .copied();
                    if operation_segment_id.is_none()
                        || activity.work_segment_id.as_deref() != operation_segment_id
                    {
                        return Err(AgentProjectionValidationError::new(format!(
                            "run projection current activity has inconsistent operation {operation_id}"
                        )));
                    }
                }
            }
        }
    }
    if let Some(token_usage) = token_usage {
        validate_token_usage(token_usage)?;
    }
    if let Some(workspace) = workspace {
        validate_safe_integer(workspace.revision, "workspaceProjection.revision")?;
        validate_identity_array(
            &workspace.changed_targets,
            "workspaceProjection.changedTargets",
        )?;
    }
    Ok(())
}

fn validate_root_replacements(
    replacements: &AgentTimelineRootProjectionReplacements,
) -> Result<(), AgentProjectionValidationError> {
    let task = replacement_ref(&replacements.task_projection);
    let interaction = replacement_ref(&replacements.interaction_projection);
    let run = replacement_ref(&replacements.run_projection);
    let token_usage = replacement_ref(&replacements.token_usage_projection);
    let workspace = replacement_ref(&replacements.workspace_projection);
    validate_optional_root_projections(task, interaction, run, token_usage, workspace, None)
}

fn replacement_ref<T>(replacement: &AgentTimelineProjectionReplacement<T>) -> Option<&T> {
    match replacement {
        AgentTimelineProjectionReplacement::Replace(value) => Some(value),
        AgentTimelineProjectionReplacement::Unchanged
        | AgentTimelineProjectionReplacement::Clear => None,
    }
}

fn apply_root_replacements(
    snapshot: &mut AgentTimelineSnapshot,
    replacements: &AgentTimelineRootProjectionReplacements,
) {
    apply_projection_replacement(&mut snapshot.task_projection, &replacements.task_projection);
    apply_projection_replacement(
        &mut snapshot.interaction_projection,
        &replacements.interaction_projection,
    );
    apply_projection_replacement(&mut snapshot.run_projection, &replacements.run_projection);
    apply_projection_replacement(
        &mut snapshot.token_usage_projection,
        &replacements.token_usage_projection,
    );
    apply_projection_replacement(
        &mut snapshot.workspace_projection,
        &replacements.workspace_projection,
    );
}

fn apply_projection_replacement<T: Clone>(
    destination: &mut Option<T>,
    replacement: &AgentTimelineProjectionReplacement<T>,
) {
    match replacement {
        AgentTimelineProjectionReplacement::Unchanged => {}
        AgentTimelineProjectionReplacement::Clear => *destination = None,
        AgentTimelineProjectionReplacement::Replace(value) => {
            *destination = Some(value.clone());
        }
    }
}

fn validate_run_projection(
    run: &AgentTimelineRunProjection,
) -> Result<(), AgentProjectionValidationError> {
    validate_identity(&run.run_id, "runProjection.runId")?;
    validate_safe_integer(run.revision, "runProjection.revision")?;
    validate_optional_identity(run.turn_id.as_deref(), "runProjection.turnId")?;
    validate_optional_identity(run.task_id.as_deref(), "runProjection.taskId")?;
    validate_language_binding(&run.language_binding, "runProjection.languageBinding")?;
    if let Some(activity) = &run.current_activity.0 {
        validate_identity(
            &activity.updated_at,
            "runProjection.currentActivity.updatedAt",
        )?;
        validate_optional_identity(
            activity.operation_id.as_deref(),
            "runProjection.currentActivity.operationId",
        )?;
        validate_optional_identity(
            activity.work_segment_id.as_deref(),
            "runProjection.currentActivity.workSegmentId",
        )?;
    }
    if let Some(wait) = &run.wait.0 {
        validate_optional_identity(wait.reason.as_deref(), "runProjection.wait.reason")?;
        validate_optional_identity(
            wait.interaction_id.as_deref(),
            "runProjection.wait.interactionId",
        )?;
    }
    match run.status {
        AgentTimelineRunStatus::Succeeded
        | AgentTimelineRunStatus::Failed
        | AgentTimelineRunStatus::Cancelled => {
            if run.phase != AgentTimelineRunPhase::Settled
                || run.current_activity.0.is_some()
                || run.wait.0.is_some()
            {
                return Err(AgentProjectionValidationError::new(
                    "terminal runProjection requires phase=settled and null currentActivity/wait",
                ));
            }
        }
        AgentTimelineRunStatus::WaitingUser => {
            if run.phase != AgentTimelineRunPhase::Waiting
                || !matches!(
                    run.wait.0.as_ref().map(|value| value.kind),
                    Some(AgentTimelineWaitKind::User)
                )
                || run.current_activity.0.is_some()
            {
                return Err(AgentProjectionValidationError::new(
                    "waitingUser runProjection requires phase=waiting, wait.kind=user, and null currentActivity",
                ));
            }
        }
        AgentTimelineRunStatus::WaitingExternal => {
            if run.phase != AgentTimelineRunPhase::Waiting
                || !matches!(
                    run.wait.0.as_ref().map(|value| value.kind),
                    Some(AgentTimelineWaitKind::External)
                )
                || run.current_activity.0.is_some()
            {
                return Err(AgentProjectionValidationError::new(
                    "waitingExternal runProjection requires phase=waiting, wait.kind=external, and null currentActivity",
                ));
            }
        }
        AgentTimelineRunStatus::Paused => {
            if run.phase != AgentTimelineRunPhase::Waiting
                || !matches!(
                    run.wait.0.as_ref().map(|value| value.kind),
                    Some(AgentTimelineWaitKind::Paused)
                )
                || run.current_activity.0.is_some()
            {
                return Err(AgentProjectionValidationError::new(
                    "paused runProjection requires phase=waiting, wait.kind=paused, and null currentActivity",
                ));
            }
        }
        AgentTimelineRunStatus::Active => {
            if matches!(
                run.phase,
                AgentTimelineRunPhase::Waiting | AgentTimelineRunPhase::Settled
            ) || run.wait.0.is_some()
            {
                return Err(AgentProjectionValidationError::new(
                    "active runProjection cannot be waiting/settled and requires null wait",
                ));
            }
        }
    }
    Ok(())
}

fn validate_token_usage(
    projection: &AgentTimelineTokenUsageProjection,
) -> Result<(), AgentProjectionValidationError> {
    validate_token_usage_totals(&projection.totals, "tokenUsageProjection.totals")?;
    let mut request_ids = HashSet::new();
    for request in &projection.requests {
        validate_identity(
            &request.request_id,
            "tokenUsageProjection.requests.requestId",
        )?;
        validate_identity(&request.turn_id, "tokenUsageProjection.requests.turnId")?;
        validate_identity(
            &request.user_event_id,
            "tokenUsageProjection.requests.userEventId",
        )?;
        if !request_ids.insert(request.request_id.as_str()) {
            return Err(AgentProjectionValidationError::new(format!(
                "token usage projection repeats request {}",
                request.request_id
            )));
        }
        validate_token_usage_request(request)?;
    }
    Ok(())
}

fn validate_token_usage_totals(
    totals: &AgentTimelineTokenUsageTotals,
    scope: &str,
) -> Result<(), AgentProjectionValidationError> {
    for (field, value) in [
        ("promptCacheHitTokens", totals.prompt_cache_hit_tokens),
        ("promptCacheMissTokens", totals.prompt_cache_miss_tokens),
        ("cachedTokens", totals.cached_tokens),
        ("promptTokens", totals.prompt_tokens),
        ("completionTokens", totals.completion_tokens),
        ("totalTokens", totals.total_tokens),
        ("providerCallCount", totals.provider_call_count),
    ] {
        validate_safe_integer(value, &format!("{scope}.{field}"))?;
    }
    validate_identity_array(&totals.providers, &format!("{scope}.providers"))
}

fn validate_token_usage_request(
    request: &AgentTimelineTokenUsageRequest,
) -> Result<(), AgentProjectionValidationError> {
    for (field, value) in [
        ("promptCacheHitTokens", request.prompt_cache_hit_tokens),
        ("promptCacheMissTokens", request.prompt_cache_miss_tokens),
        ("cachedTokens", request.cached_tokens),
        ("promptTokens", request.prompt_tokens),
        ("completionTokens", request.completion_tokens),
        ("totalTokens", request.total_tokens),
        ("providerCallCount", request.provider_call_count),
    ] {
        validate_safe_integer(value, &format!("tokenUsageProjection.requests.{field}"))?;
    }
    validate_identity_array(
        &request.providers,
        "tokenUsageProjection.requests.providers",
    )?;
    validate_identity_array(&request.stages, "tokenUsageProjection.requests.stages")
}

fn validate_interaction_view(
    interaction: &AgentTimelineInteractionView,
) -> Result<(), AgentProjectionValidationError> {
    validate_pending_interaction_identity(
        &interaction.interaction_id,
        &interaction.interaction_revision,
        &interaction.target_id,
    )?;
    validate_optional_identity(interaction.run_id.as_deref(), "block.interaction.runId")
}

fn validate_pending_interaction_identity(
    interaction_id: &str,
    interaction_revision: &str,
    target_id: &str,
) -> Result<(), AgentProjectionValidationError> {
    validate_identity(
        interaction_id,
        "interactionProjection.pending.interactionId",
    )?;
    validate_identity(
        interaction_revision,
        "interactionProjection.pending.interactionRevision",
    )?;
    validate_identity(target_id, "interactionProjection.pending.targetId")
}

fn validate_optional_block_reference(
    block_id: Option<&str>,
    identities: Option<&ProjectionIdentities<'_>>,
) -> Result<(), AgentProjectionValidationError> {
    let Some(block_id) = block_id else {
        return Ok(());
    };
    validate_identity(block_id, "interactionProjection.pending.blockId")?;
    if identities.is_some_and(|value| !value.block_ids.contains(block_id)) {
        return Err(AgentProjectionValidationError::new(format!(
            "interaction projection references missing block {block_id}"
        )));
    }
    Ok(())
}

fn validate_language_binding(
    binding: &AgentTimelineLanguageBinding,
    scope: &str,
) -> Result<(), AgentProjectionValidationError> {
    validate_optional_safe_integer(binding.revision, &format!("{scope}.revision"))?;
    validate_optional_identity(
        binding.source_turn_id.as_deref(),
        &format!("{scope}.sourceTurnId"),
    )
}

fn validate_provenance(
    provenance: &AgentTimelineProvenance,
    scope: &str,
) -> Result<(), AgentProjectionValidationError> {
    validate_identity_array(
        &provenance.source_event_refs,
        &format!("{scope}.sourceEventRefs"),
    )?;
    validate_identity_array(&provenance.fact_refs, &format!("{scope}.factRefs"))?;
    validate_identity_array(&provenance.evidence_refs, &format!("{scope}.evidenceRefs"))
}

fn validate_identity_array(
    values: &[String],
    field: &str,
) -> Result<(), AgentProjectionValidationError> {
    for value in values {
        validate_identity(value, field)?;
    }
    Ok(())
}

fn validate_identity(value: &str, field: &str) -> Result<(), AgentProjectionValidationError> {
    if value.trim().is_empty() {
        return Err(AgentProjectionValidationError::new(format!(
            "{field} must be a non-empty string"
        )));
    }
    Ok(())
}

fn validate_optional_identity(
    value: Option<&str>,
    field: &str,
) -> Result<(), AgentProjectionValidationError> {
    match value {
        Some(value) => validate_identity(value, field),
        None => Ok(()),
    }
}

fn validate_safe_integer(value: u64, field: &str) -> Result<(), AgentProjectionValidationError> {
    if value > MAX_SAFE_INTEGER {
        return Err(AgentProjectionValidationError::new(format!(
            "{field} exceeds the JSON safe integer range"
        )));
    }
    Ok(())
}

fn validate_optional_safe_integer(
    value: Option<u64>,
    field: &str,
) -> Result<(), AgentProjectionValidationError> {
    match value {
        Some(value) => validate_safe_integer(value, field),
        None => Ok(()),
    }
}
