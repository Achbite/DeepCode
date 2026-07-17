use crate::{KernelCommand, KernelErrorEnvelope, KernelEvent, KernelSnapshot};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelCommandEnvelope {
    pub request_id: Option<String>,
    pub command: KernelCommand,
    pub idempotency_key: Option<String>,
    pub expected_snapshot_seq: Option<u64>,
}

impl KernelCommandEnvelope {
    pub fn new(command: KernelCommand) -> Self {
        Self {
            request_id: None,
            command,
            idempotency_key: None,
            expected_snapshot_seq: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelReply {
    pub ok: bool,
    pub events: Vec<KernelEvent>,
    pub snapshot: Option<KernelSnapshot>,
    pub error: Option<KernelErrorEnvelope>,
}
