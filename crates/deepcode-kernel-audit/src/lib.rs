use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use thiserror::Error;

pub type AuditResult<T> = Result<T, AuditError>;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AuditError {
    #[error("audit body contains unsupported floating point value")]
    UnsupportedFloat,
    #[error("audit key is missing in production mode")]
    MissingProductionKey,
    #[error("audit chain verification failed: {0}")]
    VerifyFailed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditRuntimeMode {
    Development,
    Production,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AuditDegradedReason {
    UnsignedDevKey,
    VerifyFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SignatureAlg {
    LocalSha256V1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AuditActor {
    Kernel,
    User,
    Host,
    Skill,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AuditCategory {
    Run,
    Workflow,
    Permission,
    Tool,
    Workspace,
    Validation,
    Review,
    Audit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditBody {
    pub actor: AuditActor,
    pub category: AuditCategory,
    pub event_type: String,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub request_id: Option<String>,
    pub redacted_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignedAuditEntryV1 {
    pub schema_version: u32,
    pub segment_id: String,
    pub sequence: u64,
    pub timestamp_ms: i64,
    pub actor: AuditActor,
    pub category: AuditCategory,
    pub event_type: String,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub request_id: Option<String>,
    pub prev_hash: String,
    pub body_hash: String,
    pub entry_hash: String,
    pub body_redacted: Value,
    pub key_id: String,
    pub signature_alg: SignatureAlg,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditSegmentSealV1 {
    pub schema_version: u32,
    pub segment_id: String,
    pub first_sequence: u64,
    pub last_sequence: u64,
    pub first_hash: String,
    pub last_hash: String,
    pub prev_segment_hash: Option<String>,
    pub segment_hash: String,
    pub key_id: String,
    pub signature_alg: SignatureAlg,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditKeyMaterial {
    pub key_id: String,
    secret: Vec<u8>,
    pub degraded_reason: Option<AuditDegradedReason>,
}

impl AuditKeyMaterial {
    pub fn new(key_id: impl Into<String>, secret: impl Into<Vec<u8>>) -> Self {
        Self {
            key_id: key_id.into(),
            secret: secret.into(),
            degraded_reason: None,
        }
    }

    pub fn load_or_degraded(
        mode: AuditRuntimeMode,
        key_id: impl Into<String>,
        secret: Option<Vec<u8>>,
    ) -> AuditResult<Self> {
        match (mode, secret) {
            (_, Some(secret)) => Ok(Self::new(key_id, secret)),
            (AuditRuntimeMode::Development, None) => Ok(Self {
                key_id: key_id.into(),
                secret: b"deepcode-dev-unsigned-audit-key".to_vec(),
                degraded_reason: Some(AuditDegradedReason::UnsignedDevKey),
            }),
            (AuditRuntimeMode::Production, None) => Err(AuditError::MissingProductionKey),
        }
    }
}

#[derive(Debug, Clone)]
pub struct LocalAuditSigner {
    key: AuditKeyMaterial,
}

impl LocalAuditSigner {
    pub fn new(key: AuditKeyMaterial) -> Self {
        Self { key }
    }

    pub fn key_id(&self) -> &str {
        &self.key.key_id
    }

    pub fn sign(&self, entry_hash: &str) -> String {
        let mut bytes = self.key.secret.clone();
        bytes.extend_from_slice(b":");
        bytes.extend_from_slice(entry_hash.as_bytes());
        hash_hex(&bytes)
    }

    pub fn verify(&self, entry_hash: &str, signature: &str) -> bool {
        self.sign(entry_hash) == signature
    }

    pub fn degraded_reason(&self) -> Option<AuditDegradedReason> {
        self.key.degraded_reason.clone()
    }
}

#[derive(Debug, Clone)]
pub struct AuditChain {
    segment_id: String,
    signer: LocalAuditSigner,
    entries: Vec<SignedAuditEntryV1>,
}

impl AuditChain {
    pub fn new(segment_id: impl Into<String>, signer: LocalAuditSigner) -> Self {
        Self {
            segment_id: segment_id.into(),
            signer,
            entries: Vec::new(),
        }
    }

    pub fn from_entries(
        segment_id: impl Into<String>,
        signer: LocalAuditSigner,
        entries: Vec<SignedAuditEntryV1>,
    ) -> AuditResult<Self> {
        let segment_id = segment_id.into();
        if let Some(entry) = entries.iter().find(|entry| entry.segment_id != segment_id) {
            return verify_error(format!(
                "segment mismatch at {}: expected {} but got {}",
                entry.sequence, segment_id, entry.segment_id
            ));
        }
        AuditVerifier::new(signer.clone()).verify_entries(&entries)?;
        Ok(Self {
            segment_id,
            signer,
            entries,
        })
    }

    pub fn append(
        &mut self,
        timestamp_ms: i64,
        body: AuditBody,
    ) -> AuditResult<SignedAuditEntryV1> {
        let sequence = self.entries.len() as u64 + 1;
        let prev_hash = self
            .entries
            .last()
            .map(|entry| entry.entry_hash.clone())
            .unwrap_or_else(|| zero_hash().to_string());
        let body_hash = hash_hex(&canonical_bytes(&body.redacted_payload)?);
        let entry_hash = entry_hash(
            &self.segment_id,
            sequence,
            timestamp_ms,
            &body,
            &prev_hash,
            &body_hash,
            self.signer.key_id(),
            SignatureAlg::LocalSha256V1,
        )?;
        let signature = self.signer.sign(&entry_hash);
        let entry = SignedAuditEntryV1 {
            schema_version: 1,
            segment_id: self.segment_id.clone(),
            sequence,
            timestamp_ms,
            actor: body.actor,
            category: body.category,
            event_type: body.event_type,
            session_id: body.session_id,
            run_id: body.run_id,
            request_id: body.request_id,
            prev_hash,
            body_hash,
            entry_hash,
            body_redacted: body.redacted_payload,
            key_id: self.signer.key_id().to_string(),
            signature_alg: SignatureAlg::LocalSha256V1,
            signature,
        };
        self.entries.push(entry.clone());
        Ok(entry)
    }

    pub fn entries(&self) -> &[SignedAuditEntryV1] {
        &self.entries
    }

    pub fn seal(&self, prev_segment_hash: Option<String>) -> AuditResult<AuditSegmentSealV1> {
        let first = self
            .entries
            .first()
            .ok_or_else(|| AuditError::VerifyFailed("cannot seal empty segment".to_string()))?;
        let last = self
            .entries
            .last()
            .ok_or_else(|| AuditError::VerifyFailed("cannot seal empty segment".to_string()))?;
        let segment_hash = hash_hex(&canonical_bytes(&Value::Array(
            self.entries
                .iter()
                .map(|entry| Value::String(entry.entry_hash.clone()))
                .collect(),
        ))?);
        let seal_hash = hash_hex(
            format!(
                "{}:{}:{}:{}:{}:{}",
                self.segment_id,
                first.sequence,
                last.sequence,
                first.entry_hash,
                last.entry_hash,
                segment_hash
            )
            .as_bytes(),
        );
        Ok(AuditSegmentSealV1 {
            schema_version: 1,
            segment_id: self.segment_id.clone(),
            first_sequence: first.sequence,
            last_sequence: last.sequence,
            first_hash: first.entry_hash.clone(),
            last_hash: last.entry_hash.clone(),
            prev_segment_hash,
            segment_hash,
            key_id: self.signer.key_id().to_string(),
            signature_alg: SignatureAlg::LocalSha256V1,
            signature: self.signer.sign(&seal_hash),
        })
    }
}

pub struct AuditVerifier {
    signer: LocalAuditSigner,
}

impl AuditVerifier {
    pub fn new(signer: LocalAuditSigner) -> Self {
        Self { signer }
    }

    pub fn verify_entries(&self, entries: &[SignedAuditEntryV1]) -> AuditResult<AuditVerifyReport> {
        let mut expected_prev_hash = zero_hash().to_string();
        for (index, entry) in entries.iter().enumerate() {
            let expected_sequence = index as u64 + 1;
            if entry.sequence != expected_sequence {
                return verify_error(format!("sequence mismatch at {}", entry.sequence));
            }
            if entry.prev_hash != expected_prev_hash {
                return verify_error(format!("prev_hash mismatch at {}", entry.sequence));
            }
            let body_hash = hash_hex(&canonical_bytes(&entry.body_redacted)?);
            if entry.body_hash != body_hash {
                return verify_error(format!("body_hash mismatch at {}", entry.sequence));
            }
            let body = AuditBody {
                actor: entry.actor.clone(),
                category: entry.category.clone(),
                event_type: entry.event_type.clone(),
                session_id: entry.session_id.clone(),
                run_id: entry.run_id.clone(),
                request_id: entry.request_id.clone(),
                redacted_payload: entry.body_redacted.clone(),
            };
            let expected_entry_hash = entry_hash(
                &entry.segment_id,
                entry.sequence,
                entry.timestamp_ms,
                &body,
                &entry.prev_hash,
                &entry.body_hash,
                &entry.key_id,
                entry.signature_alg.clone(),
            )?;
            if entry.entry_hash != expected_entry_hash {
                return verify_error(format!("entry_hash mismatch at {}", entry.sequence));
            }
            if !self.signer.verify(&entry.entry_hash, &entry.signature) {
                return verify_error(format!("signature mismatch at {}", entry.sequence));
            }
            expected_prev_hash = entry.entry_hash.clone();
        }
        Ok(AuditVerifyReport {
            ok: true,
            degraded: self.signer.degraded_reason().is_some(),
            degraded_reason: self.signer.degraded_reason(),
            entries_verified: entries.len(),
            message: "audit chain verified".to_string(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditVerifyReport {
    pub ok: bool,
    pub degraded: bool,
    pub degraded_reason: Option<AuditDegradedReason>,
    pub entries_verified: usize,
    pub message: String,
}

pub fn canonical_bytes(value: &Value) -> AuditResult<Vec<u8>> {
    let canonical = canonical_value(value)?;
    serde_json::to_vec(&canonical).map_err(|error| AuditError::VerifyFailed(error.to_string()))
}

fn canonical_value(value: &Value) -> AuditResult<Value> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(value.clone()),
        Value::Number(number) => {
            if number.is_i64() || number.is_u64() {
                Ok(value.clone())
            } else {
                Err(AuditError::UnsupportedFloat)
            }
        }
        Value::Array(items) => items
            .iter()
            .map(canonical_value)
            .collect::<AuditResult<Vec<_>>>()
            .map(Value::Array),
        Value::Object(map) => {
            let mut sorted = BTreeMap::new();
            for (key, child) in map {
                sorted.insert(key.clone(), canonical_value(child)?);
            }
            serde_json::to_value(sorted)
                .map_err(|error| AuditError::VerifyFailed(error.to_string()))
        }
    }
}

fn entry_hash(
    segment_id: &str,
    sequence: u64,
    timestamp_ms: i64,
    body: &AuditBody,
    prev_hash: &str,
    body_hash: &str,
    key_id: &str,
    signature_alg: SignatureAlg,
) -> AuditResult<String> {
    let value = serde_json::json!({
        "schema_version": 1,
        "segment_id": segment_id,
        "sequence": sequence,
        "timestamp_ms": timestamp_ms,
        "actor": &body.actor,
        "category": &body.category,
        "event_type": &body.event_type,
        "session_id": &body.session_id,
        "run_id": &body.run_id,
        "request_id": &body.request_id,
        "prev_hash": prev_hash,
        "body_hash": body_hash,
        "key_id": key_id,
        "signature_alg": &signature_alg,
    });
    Ok(hash_hex(&canonical_bytes(&value)?))
}

pub fn hash_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn zero_hash() -> &'static str {
    "0000000000000000000000000000000000000000000000000000000000000000"
}

fn verify_error<T>(message: String) -> AuditResult<T> {
    Err(AuditError::VerifyFailed(message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn signer(secret: &[u8]) -> LocalAuditSigner {
        LocalAuditSigner::new(AuditKeyMaterial::new("local-test-key", secret.to_vec()))
    }

    fn body(event_type: &str, payload: Value) -> AuditBody {
        AuditBody {
            actor: AuditActor::Kernel,
            category: AuditCategory::Permission,
            event_type: event_type.to_string(),
            session_id: Some("session-1".to_string()),
            run_id: Some("run-1".to_string()),
            request_id: Some("req-1".to_string()),
            redacted_payload: payload,
        }
    }

    fn sample_entries() -> Vec<SignedAuditEntryV1> {
        let mut chain = AuditChain::new("segment-1", signer(b"secret"));
        chain
            .append(1, body("permission.requested", json!({"b": 2, "a": 1})))
            .unwrap();
        chain
            .append(2, body("permission.resolved", json!({"decision": "allow"})))
            .unwrap();
        chain.entries().to_vec()
    }

    #[test]
    fn canonical_sorting_is_stable() {
        let left = canonical_bytes(&json!({"b": 2, "a": 1})).unwrap();
        let right = canonical_bytes(&json!({"a": 1, "b": 2})).unwrap();
        assert_eq!(left, right);
    }

    #[test]
    fn normal_append_verify_ok() {
        let entries = sample_entries();
        let report = AuditVerifier::new(signer(b"secret"))
            .verify_entries(&entries)
            .unwrap();
        assert!(report.ok);
        assert_eq!(report.entries_verified, 2);
    }

    #[test]
    fn chain_can_resume_from_verified_entries() {
        let entries = sample_entries();
        let mut chain =
            AuditChain::from_entries("segment-1", signer(b"secret"), entries.clone()).unwrap();
        let entry = chain
            .append(3, body("permission.rechecked", json!({"ok": true})))
            .unwrap();
        assert_eq!(entry.sequence, 3);
        assert_eq!(entry.prev_hash, entries[1].entry_hash);
    }

    #[test]
    fn chain_resume_rejects_tampered_entries() {
        let mut entries = sample_entries();
        entries[0].body_redacted = json!({"tampered": true});
        assert!(AuditChain::from_entries("segment-1", signer(b"secret"), entries).is_err());
    }

    #[test]
    fn modify_body_verify_fail() {
        let mut entries = sample_entries();
        entries[0].body_redacted = json!({"a": 1, "b": 3});
        assert!(AuditVerifier::new(signer(b"secret"))
            .verify_entries(&entries)
            .is_err());
    }

    #[test]
    fn modify_prev_hash_verify_fail() {
        let mut entries = sample_entries();
        entries[1].prev_hash = zero_hash().to_string();
        assert!(AuditVerifier::new(signer(b"secret"))
            .verify_entries(&entries)
            .is_err());
    }

    #[test]
    fn modify_signature_verify_fail() {
        let mut entries = sample_entries();
        entries[1].signature = "bad".to_string();
        assert!(AuditVerifier::new(signer(b"secret"))
            .verify_entries(&entries)
            .is_err());
    }

    #[test]
    fn delete_middle_entry_verify_fail() {
        let mut chain = AuditChain::new("segment-1", signer(b"secret"));
        chain.append(1, body("one", json!({"n": 1}))).unwrap();
        chain.append(2, body("two", json!({"n": 2}))).unwrap();
        chain.append(3, body("three", json!({"n": 3}))).unwrap();
        let mut entries = chain.entries().to_vec();
        entries.remove(1);
        assert!(AuditVerifier::new(signer(b"secret"))
            .verify_entries(&entries)
            .is_err());
    }

    #[test]
    fn swap_two_entries_verify_fail() {
        let mut entries = sample_entries();
        entries.swap(0, 1);
        assert!(AuditVerifier::new(signer(b"secret"))
            .verify_entries(&entries)
            .is_err());
    }

    #[test]
    fn wrong_key_verify_fail() {
        let entries = sample_entries();
        assert!(AuditVerifier::new(signer(b"wrong"))
            .verify_entries(&entries)
            .is_err());
    }

    #[test]
    fn key_missing_dev_degraded() {
        let key =
            AuditKeyMaterial::load_or_degraded(AuditRuntimeMode::Development, "dev-key", None)
                .unwrap();
        assert_eq!(
            key.degraded_reason,
            Some(AuditDegradedReason::UnsignedDevKey)
        );
    }

    #[test]
    fn key_missing_prod_fail_closed() {
        let result =
            AuditKeyMaterial::load_or_degraded(AuditRuntimeMode::Production, "prod-key", None);
        assert_eq!(result.unwrap_err(), AuditError::MissingProductionKey);
    }

    #[test]
    fn segment_seal_covers_entry_hashes() {
        let mut chain = AuditChain::new("segment-1", signer(b"secret"));
        chain.append(1, body("one", json!({"n": 1}))).unwrap();
        chain.append(2, body("two", json!({"n": 2}))).unwrap();
        let seal = chain.seal(None).unwrap();
        assert_eq!(seal.first_sequence, 1);
        assert_eq!(seal.last_sequence, 2);
        assert_ne!(seal.segment_hash, zero_hash());
    }
}
