use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub const MAX_AGENT_INPUT_ATTACHMENTS_V3: usize = 32;
pub const MAX_AGENT_ATTACHMENT_ID_BYTES_V3: usize = 512;
pub const MAX_AGENT_ATTACHMENT_DISPLAY_NAME_BYTES_V3: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentInputAttachmentKindV3 {
    File,
    Directory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentInputAttachmentScopeV3 {
    Message,
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentInputAttachmentV3 {
    pub kind: AgentInputAttachmentKindV3,
    pub attachment_id: String,
    pub resource_id: String,
    pub display_name: String,
    /// Message grants bind to one exact caller request. Session grants are
    /// inherited by later inputs in the same Session until Host revocation.
    pub scope: AgentInputAttachmentScopeV3,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentInputAttachmentValidationErrorV3 {
    pub code: &'static str,
    pub message: String,
}

pub fn decode_agent_input_attachments_v3(
    value: &Value,
) -> Result<Vec<AgentInputAttachmentV3>, AgentInputAttachmentValidationErrorV3> {
    let attachments: Vec<AgentInputAttachmentV3> =
        serde_json::from_value(value.clone()).map_err(|_| {
            invalid(
                "agent_input_attachment_shape_invalid",
                "Attachments must use the exact current user-resource handle DTO.",
            )
        })?;
    validate_agent_input_attachments_v3(&attachments)?;
    Ok(attachments)
}

pub fn validate_agent_input_attachments_v3(
    attachments: &[AgentInputAttachmentV3],
) -> Result<(), AgentInputAttachmentValidationErrorV3> {
    if attachments.len() > MAX_AGENT_INPUT_ATTACHMENTS_V3 {
        return Err(invalid(
            "agent_input_attachments_too_many",
            format!(
                "At most {MAX_AGENT_INPUT_ATTACHMENTS_V3} attachments are allowed for one user input."
            ),
        ));
    }
    let mut attachment_ids = HashSet::with_capacity(attachments.len());
    let mut resource_ids = HashSet::with_capacity(attachments.len());
    for attachment in attachments {
        validate_agent_attachment_id_v3(&attachment.attachment_id, "attachmentId")?;
        validate_agent_attachment_id_v3(&attachment.resource_id, "resourceId")?;
        validate_agent_attachment_display_name_v3(&attachment.display_name)?;
        if !attachment_ids.insert(attachment.attachment_id.as_str())
            || !resource_ids.insert(attachment.resource_id.as_str())
        {
            return Err(invalid(
                "agent_input_attachment_duplicate",
                "Attachment and resource identities must be unique within one user input.",
            ));
        }
    }
    Ok(())
}

pub fn validate_agent_attachment_id_v3(
    value: &str,
    field: &str,
) -> Result<(), AgentInputAttachmentValidationErrorV3> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > MAX_AGENT_ATTACHMENT_ID_BYTES_V3
        || value.chars().any(char::is_control)
    {
        return Err(invalid(
            "agent_input_attachment_id_invalid",
            format!("{field} must be a bounded opaque identity."),
        ));
    }
    Ok(())
}

pub fn validate_agent_attachment_display_name_v3(
    value: &str,
) -> Result<(), AgentInputAttachmentValidationErrorV3> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > MAX_AGENT_ATTACHMENT_DISPLAY_NAME_BYTES_V3
        || value.chars().any(char::is_control)
        || value.contains('/')
        || value.contains('\\')
        || matches!(value, "." | "..")
    {
        return Err(invalid(
            "agent_input_attachment_display_name_invalid",
            "displayName must be a bounded filename without path separators.",
        ));
    }
    Ok(())
}

fn invalid(
    code: &'static str,
    message: impl Into<String>,
) -> AgentInputAttachmentValidationErrorV3 {
    AgentInputAttachmentValidationErrorV3 {
        code,
        message: message.into(),
    }
}
