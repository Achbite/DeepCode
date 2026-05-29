use deepcode_kernel_abi::{KernelError, KernelResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSnapshotRef {
    pub id: String,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRef {
    pub id: String,
    pub kind: String,
    pub source_event_id: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCandidatePayload {
    pub id: String,
    pub kind: String,
    pub payload: Value,
    pub source_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSnapshot {
    pub reference: ContextSnapshotRef,
    pub candidates: Vec<ContextCandidatePayload>,
    pub evidence_refs: Vec<EvidenceRef>,
    pub token_estimate: Option<u64>,
}

#[derive(Debug, Default)]
pub struct ContextRuntime {
    snapshots: BTreeMap<String, ContextSnapshot>,
    next_snapshot_index: u64,
}

impl ContextRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create_snapshot(
        &mut self,
        candidates: Vec<ContextCandidatePayload>,
        evidence_refs: Vec<EvidenceRef>,
    ) -> KernelResult<ContextSnapshot> {
        self.next_snapshot_index += 1;
        let id = format!("context-snapshot-{}", self.next_snapshot_index);
        let hash = stable_snapshot_hash(&id, &candidates, &evidence_refs)?;
        let snapshot = ContextSnapshot {
            reference: ContextSnapshotRef {
                id: id.clone(),
                hash,
            },
            candidates,
            evidence_refs,
            token_estimate: None,
        };
        self.snapshots.insert(id, snapshot.clone());
        Ok(snapshot)
    }

    pub fn get_snapshot(&self, id: &str) -> Option<&ContextSnapshot> {
        self.snapshots.get(id)
    }
}

fn stable_snapshot_hash(
    id: &str,
    candidates: &[ContextCandidatePayload],
    evidence_refs: &[EvidenceRef],
) -> KernelResult<String> {
    let encoded = serde_json::to_string(&(id, candidates, evidence_refs))
        .map_err(|error| KernelError::Other(format!("encode context snapshot failed: {error}")))?;
    Ok(format!("{:016x}", fnv1a_64(encoded.as_bytes())))
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_deterministic_snapshot_refs() {
        let mut runtime = ContextRuntime::new();
        let snapshot = runtime
            .create_snapshot(
                vec![ContextCandidatePayload {
                    id: "candidate-1".to_string(),
                    kind: "message".to_string(),
                    payload: serde_json::json!({ "content": "hello" }),
                    source_refs: vec!["message-1".to_string()],
                }],
                vec![EvidenceRef {
                    id: "evidence-1".to_string(),
                    kind: "tool".to_string(),
                    source_event_id: Some("tool.completed:1".to_string()),
                    summary: Some("fs.read ok".to_string()),
                }],
            )
            .unwrap();

        assert_eq!(snapshot.reference.id, "context-snapshot-1");
        assert!(!snapshot.reference.hash.is_empty());
        assert!(runtime.get_snapshot("context-snapshot-1").is_some());
    }
}
