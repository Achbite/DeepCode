use crate::{KernelClientError, KernelClientResult};
use deepcode_kernel_abi::validate_agent_input_attachments_v3 as validate_attachment_slice_v3;
pub use deepcode_kernel_abi::{
    AgentInputAttachmentKindV3, AgentInputAttachmentScopeV3, AgentInputAttachmentV3,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConversationTargetV1 {
    pub schema_version: String,
    pub target_id: String,
    pub target_revision: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub workspace_scope_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_binding_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_binding_identity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProjectConversationTargetV1 {
    pub schema_version: String,
    pub target_id: String,
    pub target_revision: String,
    pub project_id: String,
    pub workspace_scope_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_binding_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_binding_identity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentConversationDraftTargetV1 {
    Public {
        schema_version: String,
        target_id: String,
        target_revision: String,
        workspace_scope_key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_hash: Option<String>,
    },
    Project {
        schema_version: String,
        target_id: String,
        target_revision: String,
        project_id: String,
        workspace_scope_key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_binding_ref: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_binding_identity: Option<String>,
    },
}

impl AgentConversationDraftTargetV1 {
    pub(crate) fn validate(&self) -> KernelClientResult<()> {
        let (schema_version, target_id, target_revision, workspace_scope_key) = match self {
            Self::Public {
                schema_version,
                target_id,
                target_revision,
                workspace_scope_key,
                ..
            }
            | Self::Project {
                schema_version,
                target_id,
                target_revision,
                workspace_scope_key,
                ..
            } => (
                schema_version,
                target_id,
                target_revision,
                workspace_scope_key,
            ),
        };
        let project_valid = match self {
            Self::Public { .. } => true,
            Self::Project { project_id, .. } => !project_id.trim().is_empty(),
        };
        if schema_version != "deepcode.host.conversation-draft-target.v1"
            || target_id.trim().is_empty()
            || target_revision.trim().is_empty()
            || workspace_scope_key.trim().is_empty()
            || !project_valid
        {
            return Err(KernelClientError::Api(
                "agent_conversation_draft_target_invalid: conversationDraftTarget is incomplete or uses an unsupported schema"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentComposerProfileV1 {
    pub profile_id: String,
    pub name: String,
    pub model: String,
    pub provider_flavor: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentComposerProjectionV1 {
    pub schema_version: String,
    pub revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_target: Option<AgentConversationTargetV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_draft_target: Option<AgentConversationDraftTargetV1>,
    pub enabled_profiles: Vec<AgentComposerProfileV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_profile_id: Option<String>,
    pub selection_mutable: bool,
    pub can_submit: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_run: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_interaction: Option<Value>,
}

impl AgentProjectConversationTargetV1 {
    pub fn from_project(project: &Value) -> KernelClientResult<Self> {
        let value = project.get("conversationTarget").cloned().ok_or_else(|| {
            KernelClientError::Api(
                "agent_project_conversation_target_missing: Project response has no canonical conversationTarget"
                    .to_string(),
            )
        })?;
        let target: Self = serde_json::from_value(value).map_err(|error| {
            KernelClientError::Api(format!(
                "agent_project_conversation_target_invalid: invalid canonical conversationTarget: {error}"
            ))
        })?;
        target.validate()?;
        Ok(target)
    }

    pub(crate) fn validate(&self) -> KernelClientResult<()> {
        if self.schema_version != "deepcode.host.project-conversation-target.v1"
            || self.target_id.trim().is_empty()
            || self.target_revision.trim().is_empty()
            || self.project_id.trim().is_empty()
            || self.workspace_scope_key.trim().is_empty()
        {
            return Err(KernelClientError::Api(
                "agent_project_conversation_target_invalid: project conversationTarget is incomplete or uses an unsupported schema"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

impl AgentConversationTargetV1 {
    pub fn from_session(session: &Value) -> KernelClientResult<Self> {
        let value = session.get("conversationTarget").cloned().ok_or_else(|| {
            KernelClientError::Api(
                "agent_conversation_target_missing: Session response has no canonical conversationTarget"
                    .to_string(),
            )
        })?;
        let target: Self = serde_json::from_value(value).map_err(|error| {
            KernelClientError::Api(format!(
                "agent_conversation_target_invalid: invalid canonical conversationTarget: {error}"
            ))
        })?;
        target.validate()?;
        Ok(target)
    }

    pub(crate) fn validate(&self) -> KernelClientResult<()> {
        if self.schema_version != "deepcode.host.conversation-target.v1"
            || self.target_id.trim().is_empty()
            || self.target_revision.trim().is_empty()
            || self.session_id.trim().is_empty()
            || self.workspace_scope_key.trim().is_empty()
        {
            return Err(KernelClientError::Api(
                "agent_conversation_target_invalid: conversationTarget is incomplete or uses an unsupported schema"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentSessionsRequest {
    pub workspace_id: Option<String>,
    pub workspace_hash: Option<String>,
    pub include_archived: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentSessionRequest {
    pub profile_id: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_hash: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartConversationDraftRunRequest {
    pub conversation_draft_target: AgentConversationDraftTargetV1,
    pub profile_id: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<AgentInputAttachmentV3>>,
    pub caller_request_id: String,
}

impl StartConversationDraftRunRequest {
    pub fn new(
        conversation_draft_target: AgentConversationDraftTargetV1,
        profile_id: impl Into<String>,
        content: impl Into<String>,
        caller_request_id: impl Into<String>,
    ) -> Self {
        Self {
            conversation_draft_target,
            profile_id: profile_id.into(),
            content: content.into(),
            attachments: None,
            caller_request_id: caller_request_id.into(),
        }
    }

    pub(crate) fn validate(&self) -> KernelClientResult<()> {
        validate_caller_request_id(&self.caller_request_id)?;
        self.conversation_draft_target.validate()?;
        if self.profile_id.trim().is_empty() || self.content.trim().is_empty() {
            return Err(KernelClientError::Api(
                "conversation_draft_admission_invalid: Draft admission requires a selected Profile and one non-empty user input"
                    .to_string(),
            ));
        }
        validate_agent_input_attachments_v3(self.attachments.as_deref())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionListResult {
    pub sessions: Vec<Value>,
    pub current_session_id: Option<String>,
    pub workspace_scope_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionResult {
    pub session: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAgentRunRequest {
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_workspace: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<AgentInputAttachmentV3>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guidance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_set_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_projection_cursor: Option<u64>,
    pub conversation_target: AgentConversationTargetV1,
    pub caller_request_id: String,
}

impl StartAgentRunRequest {
    pub fn ask(
        content: impl Into<String>,
        caller_request_id: impl Into<String>,
        conversation_target: AgentConversationTargetV1,
    ) -> Self {
        Self {
            op: "ask".to_string(),
            content: Some(content.into()),
            workspace_path: None,
            no_workspace: None,
            attachments: None,
            decision_kind: None,
            decision: None,
            guidance: None,
            run_id: None,
            target_id: None,
            option_id: None,
            interaction_id: None,
            interaction_revision: None,
            candidate_set_digest: None,
            expected_projection_cursor: None,
            conversation_target,
            caller_request_id: caller_request_id.into(),
        }
    }

    pub fn resolve_decision(
        kind: impl Into<String>,
        decision: impl Into<String>,
        caller_request_id: impl Into<String>,
        conversation_target: AgentConversationTargetV1,
    ) -> Self {
        Self {
            op: "resolveDecision".to_string(),
            content: None,
            workspace_path: None,
            no_workspace: None,
            attachments: None,
            decision_kind: Some(kind.into()),
            decision: Some(decision.into()),
            guidance: None,
            run_id: None,
            target_id: None,
            option_id: None,
            interaction_id: None,
            interaction_revision: None,
            candidate_set_digest: None,
            expected_projection_cursor: None,
            conversation_target,
            caller_request_id: caller_request_id.into(),
        }
    }

    pub(crate) fn validate(&self) -> KernelClientResult<()> {
        validate_caller_request_id(&self.caller_request_id)?;
        self.conversation_target.validate()?;
        match self.op.as_str() {
            "ask" => {
                validate_agent_input_attachments_v3(self.attachments.as_deref())?;
                if self
                    .content
                    .as_deref()
                    .map(str::trim)
                    .is_none_or(str::is_empty)
                {
                    return Err(KernelClientError::Api(
                        "agent_prompt_required: ask requires non-empty content".to_string(),
                    ));
                }
                if self.decision_kind.is_some()
                    || self.decision.is_some()
                    || self.guidance.is_some()
                    || self.run_id.is_some()
                    || self.target_id.is_some()
                    || self.option_id.is_some()
                    || self.interaction_id.is_some()
                    || self.interaction_revision.is_some()
                    || self.candidate_set_digest.is_some()
                    || self.expected_projection_cursor.is_some()
                {
                    return Err(KernelClientError::Api(
                        "session_operation_v2_invalid: ask cannot carry decision identity"
                            .to_string(),
                    ));
                }
            }
            "resolveDecision" => {
                let kind = self.decision_kind.as_deref();
                if !matches!(kind, Some("plan" | "permission" | "userIntervention"))
                    || self
                        .decision
                        .as_deref()
                        .map(str::trim)
                        .is_none_or(str::is_empty)
                    || self
                        .run_id
                        .as_deref()
                        .map(str::trim)
                        .is_none_or(str::is_empty)
                    || self
                        .target_id
                        .as_deref()
                        .map(str::trim)
                        .is_none_or(str::is_empty)
                {
                    return Err(KernelClientError::Api(
                        "session_interaction_identity_required: decision requires plan/permission, decision, runId, and targetId".to_string(),
                    ));
                }
                if kind == Some("userIntervention") {
                    let decision = self.decision.as_deref();
                    if !matches!(decision, Some("select" | "revise" | "reject"))
                        || self
                            .interaction_id
                            .as_deref()
                            .map(str::trim)
                            .is_none_or(str::is_empty)
                        || self
                            .interaction_revision
                            .as_deref()
                            .map(str::trim)
                            .is_none_or(str::is_empty)
                        || self
                            .candidate_set_digest
                            .as_deref()
                            .map(str::trim)
                            .is_none_or(str::is_empty)
                        || self.expected_projection_cursor.is_none()
                        || (decision == Some("select")
                            && self
                                .option_id
                                .as_deref()
                                .map(str::trim)
                                .is_none_or(str::is_empty))
                        || (decision == Some("revise")
                            && self
                                .guidance
                                .as_deref()
                                .map(str::trim)
                                .is_none_or(str::is_empty))
                    {
                        return Err(KernelClientError::Api(
                            "session_intervention_identity_required: intervention decisions require exact interaction revision, candidate-set digest, projection cursor, and decision payload".to_string(),
                        ));
                    }
                } else if self.option_id.is_some()
                    || self.interaction_id.is_some()
                    || self.interaction_revision.is_some()
                    || self.candidate_set_digest.is_some()
                    || self.expected_projection_cursor.is_some()
                {
                    return Err(KernelClientError::Api(
                        "session_operation_v2_invalid: plan and permission decisions cannot carry intervention identity".to_string(),
                    ));
                }
                if self.content.is_some()
                    || self.workspace_path.is_some()
                    || self.no_workspace.is_some()
                    || self.attachments.is_some()
                {
                    return Err(KernelClientError::Api(
                        "session_operation_v2_invalid: decision cannot alter Run workspace, content, or attachments"
                            .to_string(),
                    ));
                }
            }
            _ => {
                return Err(KernelClientError::Api(
                    "session_operation_v2_unsupported: only ask and resolveDecision are supported"
                        .to_string(),
                ))
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunCallerRequest {
    pub conversation_target: AgentConversationTargetV1,
    pub caller_request_id: String,
}

impl AgentRunCallerRequest {
    pub fn new(
        caller_request_id: impl Into<String>,
        conversation_target: AgentConversationTargetV1,
    ) -> Self {
        Self {
            conversation_target,
            caller_request_id: caller_request_id.into(),
        }
    }

    pub(crate) fn validate(&self) -> KernelClientResult<()> {
        validate_caller_request_id(&self.caller_request_id)?;
        self.conversation_target.validate()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunGuidanceRequest {
    pub guidance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_workspace: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<AgentInputAttachmentV3>>,
    pub conversation_target: AgentConversationTargetV1,
    pub caller_request_id: String,
}

impl AgentRunGuidanceRequest {
    pub fn new(
        guidance: impl Into<String>,
        caller_request_id: impl Into<String>,
        conversation_target: AgentConversationTargetV1,
    ) -> Self {
        Self {
            guidance: guidance.into(),
            workspace_path: None,
            no_workspace: None,
            attachments: None,
            conversation_target,
            caller_request_id: caller_request_id.into(),
        }
    }

    pub(crate) fn validate(&self) -> KernelClientResult<()> {
        validate_caller_request_id(&self.caller_request_id)?;
        self.conversation_target.validate()?;
        if self.guidance.trim().is_empty() {
            return Err(KernelClientError::Api(
                "empty_guidance: guidance must not be empty".to_string(),
            ));
        }
        validate_agent_input_attachments_v3(self.attachments.as_deref())?;
        if self.no_workspace == Some(true) && self.workspace_path.is_some() {
            return Err(KernelClientError::Api(
                "agent_guidance_workspace_conflict: guidance cannot request both a workspace path and no-workspace mode"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

fn validate_agent_input_attachments_v3(
    attachments: Option<&[AgentInputAttachmentV3]>,
) -> KernelClientResult<()> {
    let Some(attachments) = attachments else {
        return Ok(());
    };
    validate_attachment_slice_v3(attachments)
        .map_err(|error| KernelClientError::Api(format!("{}: {}", error.code, error.message)))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunStatus {
    pub run_id: String,
    #[serde(default)]
    pub kernel_run_id: Option<String>,
    pub session_id: String,
    pub profile_id: Option<String>,
    pub status: String,
    pub started_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub message: Option<String>,
}

impl AgentRunStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed" | "cancelled")
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunResult {
    pub run: AgentRunStatus,
    pub session: Value,
    #[serde(default)]
    pub input_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TerminalWorkspaceScope {
    pub workspace_id: String,
    pub workspace_hash: String,
    pub normalized_path: String,
}

pub fn terminal_workspace_scope(path: Option<&str>) -> Option<TerminalWorkspaceScope> {
    let normalized_path = normalize_terminal_workspace_path(path?)?;
    Some(TerminalWorkspaceScope {
        workspace_id: "terminal".to_string(),
        workspace_hash: simple_workspace_hash(&normalized_path),
        normalized_path,
    })
}

fn validate_caller_request_id(value: &str) -> KernelClientResult<()> {
    let value = value.trim();
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(KernelClientError::Api(
            "caller_request_id_invalid: callerRequestId must be a non-empty bounded identity"
                .to_string(),
        ));
    }
    Ok(())
}

fn normalize_terminal_workspace_path(path: &str) -> Option<String> {
    let normalized_path = path.trim().replace('\\', "/");
    let normalized_path = normalized_path.trim_end_matches('/').to_string();
    (!normalized_path.is_empty()).then_some(normalized_path)
}

fn simple_workspace_hash(value: &str) -> String {
    let mut hash = 2166136261u32;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(16777619);
    }
    format!("ws-{hash:x}")
}
