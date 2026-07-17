use deepcode_kernel_abi::{ArtifactDraftEvent, ArtifactDraftLedgerFrame, ArtifactDraftStatus};

pub(super) fn draft_payload(
    draft_id: &str,
    status: ArtifactDraftStatus,
    frame: &ArtifactDraftLedgerFrame,
) -> ArtifactDraftEvent {
    ArtifactDraftEvent {
        draft_id: draft_id.to_string(),
        status,
        frame: frame.clone(),
    }
}
