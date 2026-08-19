pub(crate) use deepcode_kernel_abi::{
    AgentInputAttachmentV3, AgentInputAttachmentValidationErrorV3,
};

pub(crate) fn validate_agent_input_attachments_v3(
    attachments: Option<&[AgentInputAttachmentV3]>,
) -> Result<Vec<AgentInputAttachmentV3>, AgentInputAttachmentValidationErrorV3> {
    let attachments = attachments.unwrap_or_default();
    deepcode_kernel_abi::validate_agent_input_attachments_v3(attachments)?;
    Ok(attachments.to_vec())
}

pub(crate) fn validate_agent_input_attachment_slice_v3(
    attachments: &[AgentInputAttachmentV3],
) -> Result<(), AgentInputAttachmentValidationErrorV3> {
    deepcode_kernel_abi::validate_agent_input_attachments_v3(attachments)
}
