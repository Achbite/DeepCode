use super::*;

pub(super) fn draft_payload(draft_id: &str, status: &str, frame: &Value) -> Value {
    serde_json::json!({
        "summary": format!("Kernel draft ledger recorded {status}."),
        "draftId": draft_id,
        "status": status,
        "frame": frame
    })
}
