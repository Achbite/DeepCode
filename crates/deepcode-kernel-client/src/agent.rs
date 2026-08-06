use crate::{KernelClientError, KernelClientResult};
use deepcode_kernel_abi::validate_agent_input_attachments_v2 as validate_attachment_slice_v2;
pub use deepcode_kernel_abi::{
    AgentInputAttachmentKindV2, AgentInputAttachmentScopeV2, AgentInputAttachmentV2,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    pub attachments: Option<Vec<AgentInputAttachmentV2>>,
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
    pub caller_request_id: String,
}

impl StartAgentRunRequest {
    pub fn ask(content: impl Into<String>, caller_request_id: impl Into<String>) -> Self {
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
            caller_request_id: caller_request_id.into(),
        }
    }

    pub fn resolve_decision(
        kind: impl Into<String>,
        decision: impl Into<String>,
        caller_request_id: impl Into<String>,
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
            caller_request_id: caller_request_id.into(),
        }
    }

    pub(crate) fn validate(&self) -> KernelClientResult<()> {
        validate_caller_request_id(&self.caller_request_id)?;
        match self.op.as_str() {
            "ask" => {
                validate_agent_input_attachments_v2(self.attachments.as_deref())?;
                if self.no_workspace == Some(true)
                    && self
                        .attachments
                        .as_ref()
                        .is_some_and(|attachments| !attachments.is_empty())
                {
                    return Err(KernelClientError::Api(
                        "agent_input_attachment_workspace_required: attachments require a bound workspace"
                            .to_string(),
                    ));
                }
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
                {
                    return Err(KernelClientError::Api(
                        "session_operation_v2_invalid: ask cannot carry decision identity"
                            .to_string(),
                    ));
                }
            }
            "resolveDecision" => {
                let kind = self.decision_kind.as_deref();
                if !matches!(kind, Some("plan" | "permission"))
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
    pub caller_request_id: String,
}

impl AgentRunCallerRequest {
    pub fn new(caller_request_id: impl Into<String>) -> Self {
        Self {
            caller_request_id: caller_request_id.into(),
        }
    }

    pub(crate) fn validate(&self) -> KernelClientResult<()> {
        validate_caller_request_id(&self.caller_request_id)
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
    pub attachments: Option<Vec<AgentInputAttachmentV2>>,
    pub caller_request_id: String,
}

impl AgentRunGuidanceRequest {
    pub fn new(guidance: impl Into<String>, caller_request_id: impl Into<String>) -> Self {
        Self {
            guidance: guidance.into(),
            workspace_path: None,
            no_workspace: None,
            attachments: None,
            caller_request_id: caller_request_id.into(),
        }
    }

    pub(crate) fn validate(&self) -> KernelClientResult<()> {
        validate_caller_request_id(&self.caller_request_id)?;
        if self.guidance.trim().is_empty() {
            return Err(KernelClientError::Api(
                "empty_guidance: guidance must not be empty".to_string(),
            ));
        }
        validate_agent_input_attachments_v2(self.attachments.as_deref())?;
        if self.no_workspace == Some(true) && self.workspace_path.is_some() {
            return Err(KernelClientError::Api(
                "agent_guidance_workspace_conflict: guidance cannot request both a workspace path and no-workspace mode"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

fn validate_agent_input_attachments_v2(
    attachments: Option<&[AgentInputAttachmentV2]>,
) -> KernelClientResult<()> {
    let Some(attachments) = attachments else {
        return Ok(());
    };
    validate_attachment_slice_v2(attachments)
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
