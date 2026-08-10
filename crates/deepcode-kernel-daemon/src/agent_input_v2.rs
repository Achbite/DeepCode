pub(crate) use deepcode_kernel_abi::{
    AgentInputAttachmentV2, AgentInputAttachmentValidationErrorV2,
};

pub(crate) fn validate_agent_input_attachments_v2(
    attachments: Option<&[AgentInputAttachmentV2]>,
) -> Result<Vec<AgentInputAttachmentV2>, AgentInputAttachmentValidationErrorV2> {
    let attachments = attachments.unwrap_or_default();
    deepcode_kernel_abi::validate_agent_input_attachments_v2(attachments)?;
    Ok(attachments.to_vec())
}

pub(crate) fn validate_agent_input_attachment_slice_v2(
    attachments: &[AgentInputAttachmentV2],
) -> Result<(), AgentInputAttachmentValidationErrorV2> {
    deepcode_kernel_abi::validate_agent_input_attachments_v2(attachments)
}

pub(crate) fn validate_agent_attachment_folder_binding_v2(
    attachments: &[AgentInputAttachmentV2],
    authoritative_folder_id: Option<&str>,
) -> Result<(), AgentInputAttachmentValidationErrorV2> {
    for attachment in attachments {
        let Some(folder_id) = attachment.folder_id.as_deref() else {
            continue;
        };
        match authoritative_folder_id {
            Some(authoritative) if folder_id == authoritative => {}
            Some(_) => {
                return Err(AgentInputAttachmentValidationErrorV2 {
                    code: "agent_input_attachment_folder_mismatch",
                    message:
                        "Attachment folderId does not match the authoritative Run workspace root."
                            .to_string(),
                })
            }
            None => {
                return Err(AgentInputAttachmentValidationErrorV2 {
                    code: "agent_input_attachment_folder_unverifiable",
                    message:
                        "Attachment folderId cannot be verified for this Run workspace binding."
                            .to_string(),
                })
            }
        }
    }
    Ok(())
}
