use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub const MAX_AGENT_INPUT_ATTACHMENTS_V2: usize = 32;
pub const MAX_AGENT_ATTACHMENT_PATH_BYTES_V2: usize = 4096;
pub const MAX_AGENT_ATTACHMENT_ID_BYTES_V2: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentInputAttachmentKindV2 {
    File,
    Directory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentInputAttachmentScopeV2 {
    Message,
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentInputAttachmentV2 {
    pub kind: AgentInputAttachmentKindV2,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    pub scope: AgentInputAttachmentScopeV2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentInputAttachmentValidationErrorV2 {
    pub code: &'static str,
    pub message: String,
}

pub fn decode_agent_input_attachments_v2(
    value: &Value,
) -> Result<Vec<AgentInputAttachmentV2>, AgentInputAttachmentValidationErrorV2> {
    if value.as_array().is_some_and(|attachments| {
        attachments.iter().any(|attachment| {
            attachment.as_object().is_some_and(|record| {
                record.get("resourceId").is_some_and(Value::is_null)
                    || record.get("folderId").is_some_and(Value::is_null)
            })
        })
    }) {
        return Err(invalid(
            "agent_input_attachment_shape_invalid",
            "Optional attachment identities must be omitted rather than null.",
        ));
    }
    let attachments: Vec<AgentInputAttachmentV2> =
        serde_json::from_value(value.clone()).map_err(|_| {
            invalid(
                "agent_input_attachment_shape_invalid",
                "Attachments must use the exact v2 nested DTO.",
            )
        })?;
    validate_agent_input_attachments_v2(&attachments)?;
    Ok(attachments)
}

pub fn validate_agent_input_attachments_v2(
    attachments: &[AgentInputAttachmentV2],
) -> Result<(), AgentInputAttachmentValidationErrorV2> {
    if attachments.len() > MAX_AGENT_INPUT_ATTACHMENTS_V2 {
        return Err(invalid(
            "agent_input_attachments_too_many",
            format!(
                "At most {MAX_AGENT_INPUT_ATTACHMENTS_V2} attachments are allowed for one user input."
            ),
        ));
    }
    let mut paths = HashSet::with_capacity(attachments.len());
    for attachment in attachments {
        validate_workspace_relative_attachment_path_v2(&attachment.path)?;
        validate_optional_agent_attachment_id_v2(attachment.resource_id.as_deref(), "resourceId")?;
        validate_optional_agent_attachment_id_v2(attachment.folder_id.as_deref(), "folderId")?;
        if !paths.insert(attachment.path.as_str()) {
            return Err(invalid(
                "agent_input_attachment_duplicate",
                "Attachment paths must be unique within one user input.",
            ));
        }
    }
    Ok(())
}

pub fn validate_workspace_relative_attachment_path_v2(
    path: &str,
) -> Result<(), AgentInputAttachmentValidationErrorV2> {
    let bytes = path.as_bytes();
    let windows_drive_absolute =
        bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if path.is_empty()
        || path.trim() != path
        || bytes.len() > MAX_AGENT_ATTACHMENT_PATH_BYTES_V2
        || path.chars().any(char::is_control)
        || path.contains('\\')
        || path.starts_with('/')
        || windows_drive_absolute
        || path
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(invalid(
            "agent_input_attachment_path_invalid",
            "Attachment path must be a normalized workspace-relative path.",
        ));
    }
    Ok(())
}

pub fn validate_optional_agent_attachment_id_v2(
    value: Option<&str>,
    field: &str,
) -> Result<(), AgentInputAttachmentValidationErrorV2> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_empty()
        || value.trim() != value
        || value.len() > MAX_AGENT_ATTACHMENT_ID_BYTES_V2
        || value.chars().any(char::is_control)
    {
        return Err(invalid(
            "agent_input_attachment_id_invalid",
            format!("{field} must be a bounded opaque identity."),
        ));
    }
    Ok(())
}

fn invalid(
    code: &'static str,
    message: impl Into<String>,
) -> AgentInputAttachmentValidationErrorV2 {
    AgentInputAttachmentValidationErrorV2 {
        code,
        message: message.into(),
    }
}
