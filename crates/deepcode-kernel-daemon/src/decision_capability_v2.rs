use deepcode_kernel_abi::v2::{CommandRequestId, ControlEpoch, RunId};
use deepcode_kernel_abi::{user_decision_request_digest_v2, DecisionCapabilityV2, UserDecisionV2};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DECISION_CAPABILITY_PREFIX: &str = "dcv2d";
const MAX_DECISION_CAPABILITY_LIFETIME: Duration = Duration::from_secs(10 * 60);
const MAX_DECISION_CAPABILITY_RECORDS: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub(crate) enum DecisionCapabilitySubjectV2 {
    ExactUserDecision {
        request_id: CommandRequestId,
        decision: UserDecisionV2,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecisionCapabilityGrantV2 {
    pub(crate) run_id: RunId,
    pub(crate) expected_control_epoch: ControlEpoch,
    pub(crate) subject: DecisionCapabilitySubjectV2,
}

impl DecisionCapabilityGrantV2 {
    fn authorizes(&self, envelope: &deepcode_kernel_abi::UserDecisionEnvelopeV2) -> bool {
        if self.run_id != envelope.run_id
            || self.expected_control_epoch != envelope.expected_control_epoch
        {
            return false;
        }
        match &self.subject {
            DecisionCapabilitySubjectV2::ExactUserDecision {
                request_id,
                decision,
            } => request_id == &envelope.request_id && decision == &envelope.decision,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DecisionCapabilityIssueErrorV2 {
    InvalidLifetime,
    CapacityExceeded,
    EntropyUnavailable,
    EncodingFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DecisionCapabilityAuthorizationErrorV2 {
    Required,
    Invalid,
    Expired,
    BindingMismatch,
    RequestConflict,
    InUse,
    Internal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DecisionCapabilityCompletionErrorV2 {
    Internal,
    StateMismatch,
}

#[derive(Clone)]
pub(crate) struct DecisionCapabilityAuthorityV2 {
    inner: Arc<DecisionCapabilityAuthorityInnerV2>,
}

struct DecisionCapabilityAuthorityInnerV2 {
    signing_key: [u8; 32],
    records: Mutex<HashMap<[u8; 32], StoredDecisionCapabilityV2>>,
}

struct StoredDecisionCapabilityV2 {
    grant: DecisionCapabilityGrantV2,
    grant_digest: [u8; 32],
    expires_at_millis: u64,
    expires_at_instant: Instant,
    state: DecisionCapabilityStateV2,
}

enum DecisionCapabilityStateV2 {
    Available,
    InFlight {
        request_id: CommandRequestId,
        request_digest: [u8; 32],
    },
    Completed {
        request_id: CommandRequestId,
        request_digest: [u8; 32],
    },
}

pub(crate) struct DecisionCapabilityPermitV2 {
    authority: Arc<DecisionCapabilityAuthorityInnerV2>,
    token_digest: [u8; 32],
    request_id: CommandRequestId,
    request_digest: [u8; 32],
    completed: bool,
}

impl DecisionCapabilityAuthorityV2 {
    pub(crate) fn new() -> Result<Self, DecisionCapabilityIssueErrorV2> {
        Ok(Self {
            inner: Arc::new(DecisionCapabilityAuthorityInnerV2 {
                signing_key: random_32_bytes()
                    .map_err(|_| DecisionCapabilityIssueErrorV2::EntropyUnavailable)?,
                records: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub(crate) fn issue(
        &self,
        grant: DecisionCapabilityGrantV2,
        lifetime: Duration,
    ) -> Result<DecisionCapabilityV2, DecisionCapabilityIssueErrorV2> {
        if lifetime.is_zero() || lifetime > MAX_DECISION_CAPABILITY_LIFETIME {
            return Err(DecisionCapabilityIssueErrorV2::InvalidLifetime);
        }
        let now = now_millis().ok_or(DecisionCapabilityIssueErrorV2::EntropyUnavailable)?;
        let lifetime_millis = u64::try_from(lifetime.as_millis())
            .map_err(|_| DecisionCapabilityIssueErrorV2::InvalidLifetime)?;
        let expires_at_millis = now
            .checked_add(lifetime_millis)
            .ok_or(DecisionCapabilityIssueErrorV2::InvalidLifetime)?;
        let expires_at_instant = Instant::now()
            .checked_add(lifetime)
            .ok_or(DecisionCapabilityIssueErrorV2::InvalidLifetime)?;
        let grant_digest = digest_serialized(&grant)
            .map_err(|_| DecisionCapabilityIssueErrorV2::EncodingFailed)?;
        let nonce =
            random_32_bytes().map_err(|_| DecisionCapabilityIssueErrorV2::EntropyUnavailable)?;
        let signed = signed_capability_bytes(expires_at_millis, &nonce, &grant_digest);
        let signature = hmac_sha256(&self.inner.signing_key, &signed);
        let token = format!(
            "{DECISION_CAPABILITY_PREFIX}.{:016x}.{}.{}.{}",
            expires_at_millis,
            encode_hex(&nonce),
            encode_hex(&grant_digest),
            encode_hex(&signature)
        );
        let capability = DecisionCapabilityV2::new(token.clone())
            .map_err(|_| DecisionCapabilityIssueErrorV2::EncodingFailed)?;
        let token_digest = sha256(token.as_bytes());
        let mut records = self
            .inner
            .records
            .lock()
            .map_err(|_| DecisionCapabilityIssueErrorV2::EncodingFailed)?;
        prune_expired(&mut records, Instant::now());
        if records.len() >= MAX_DECISION_CAPABILITY_RECORDS {
            return Err(DecisionCapabilityIssueErrorV2::CapacityExceeded);
        }
        records.insert(
            token_digest,
            StoredDecisionCapabilityV2 {
                grant,
                grant_digest,
                expires_at_millis,
                expires_at_instant,
                state: DecisionCapabilityStateV2::Available,
            },
        );
        Ok(capability)
    }

    pub(crate) fn authorize(
        &self,
        envelope: &deepcode_kernel_abi::UserDecisionEnvelopeV2,
    ) -> Result<DecisionCapabilityPermitV2, DecisionCapabilityAuthorizationErrorV2> {
        let token = envelope.decision_capability.expose_to_transport();
        if token.is_empty() {
            return Err(DecisionCapabilityAuthorizationErrorV2::Required);
        }
        let token_parts = parse_and_verify_token(&self.inner.signing_key, token)?;
        let request_digest = user_decision_request_digest_v2(
            &envelope.run_id,
            envelope.expected_control_epoch,
            &envelope.decision,
        )
        .map(|digest| sha256(digest.as_str().as_bytes()))
        .map_err(|_| DecisionCapabilityAuthorizationErrorV2::Internal)?;
        let token_digest = sha256(token.as_bytes());
        let now = now_millis().ok_or(DecisionCapabilityAuthorizationErrorV2::Internal)?;
        let monotonic_now = Instant::now();
        if token_parts.expires_at_millis <= now {
            return Err(DecisionCapabilityAuthorizationErrorV2::Expired);
        }
        let mut records = self
            .inner
            .records
            .lock()
            .map_err(|_| DecisionCapabilityAuthorizationErrorV2::Internal)?;
        prune_expired(&mut records, monotonic_now);
        let record = records
            .get_mut(&token_digest)
            .ok_or(DecisionCapabilityAuthorizationErrorV2::Invalid)?;
        if record.expires_at_millis <= now || record.expires_at_instant <= monotonic_now {
            return Err(DecisionCapabilityAuthorizationErrorV2::Expired);
        }
        if record.expires_at_millis != token_parts.expires_at_millis
            || !constant_time_eq(&record.grant_digest, &token_parts.grant_digest)
            || !record.grant.authorizes(envelope)
        {
            return Err(DecisionCapabilityAuthorizationErrorV2::BindingMismatch);
        }
        match &record.state {
            DecisionCapabilityStateV2::Available => {
                record.state = DecisionCapabilityStateV2::InFlight {
                    request_id: envelope.request_id.clone(),
                    request_digest,
                };
                Ok(DecisionCapabilityPermitV2 {
                    authority: Arc::clone(&self.inner),
                    token_digest,
                    request_id: envelope.request_id.clone(),
                    request_digest,
                    completed: false,
                })
            }
            DecisionCapabilityStateV2::InFlight {
                request_id,
                request_digest: existing_digest,
            } => {
                if request_id == &envelope.request_id
                    && constant_time_eq(existing_digest, &request_digest)
                {
                    Err(DecisionCapabilityAuthorizationErrorV2::InUse)
                } else {
                    Err(DecisionCapabilityAuthorizationErrorV2::RequestConflict)
                }
            }
            DecisionCapabilityStateV2::Completed {
                request_id,
                request_digest: existing_digest,
            } => {
                if request_id == &envelope.request_id
                    && constant_time_eq(existing_digest, &request_digest)
                {
                    record.state = DecisionCapabilityStateV2::InFlight {
                        request_id: envelope.request_id.clone(),
                        request_digest,
                    };
                    Ok(DecisionCapabilityPermitV2 {
                        authority: Arc::clone(&self.inner),
                        token_digest,
                        request_id: envelope.request_id.clone(),
                        request_digest,
                        completed: false,
                    })
                } else {
                    Err(DecisionCapabilityAuthorizationErrorV2::RequestConflict)
                }
            }
        }
    }
}

impl DecisionCapabilityPermitV2 {
    pub(crate) fn complete(mut self) -> Result<(), DecisionCapabilityCompletionErrorV2> {
        let mut records = self
            .authority
            .records
            .lock()
            .map_err(|_| DecisionCapabilityCompletionErrorV2::Internal)?;
        let record = records
            .get_mut(&self.token_digest)
            .ok_or(DecisionCapabilityCompletionErrorV2::StateMismatch)?;
        if !matches!(
            &record.state,
            DecisionCapabilityStateV2::InFlight {
                request_id,
                request_digest,
            } if request_id == &self.request_id
                && constant_time_eq(request_digest, &self.request_digest)
        ) {
            return Err(DecisionCapabilityCompletionErrorV2::StateMismatch);
        }
        record.state = DecisionCapabilityStateV2::Completed {
            request_id: self.request_id.clone(),
            request_digest: self.request_digest,
        };
        self.completed = true;
        Ok(())
    }
}

impl Drop for DecisionCapabilityPermitV2 {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        if let Ok(mut records) = self.authority.records.lock() {
            if let Some(record) = records.get_mut(&self.token_digest) {
                if matches!(
                    &record.state,
                    DecisionCapabilityStateV2::InFlight {
                        request_id,
                        request_digest,
                    } if request_id == &self.request_id
                        && constant_time_eq(request_digest, &self.request_digest)
                ) {
                    record.state = DecisionCapabilityStateV2::Available;
                }
            }
        }
    }
}

struct ParsedDecisionCapabilityV2 {
    expires_at_millis: u64,
    grant_digest: [u8; 32],
}

fn parse_and_verify_token(
    signing_key: &[u8; 32],
    token: &str,
) -> Result<ParsedDecisionCapabilityV2, DecisionCapabilityAuthorizationErrorV2> {
    let mut parts = token.split('.');
    if parts.next() != Some(DECISION_CAPABILITY_PREFIX) {
        return Err(DecisionCapabilityAuthorizationErrorV2::Invalid);
    }
    let expires_at_millis = parts
        .next()
        .and_then(|value| u64::from_str_radix(value, 16).ok())
        .ok_or(DecisionCapabilityAuthorizationErrorV2::Invalid)?;
    let nonce = parts
        .next()
        .and_then(decode_hex_32)
        .ok_or(DecisionCapabilityAuthorizationErrorV2::Invalid)?;
    let grant_digest = parts
        .next()
        .and_then(decode_hex_32)
        .ok_or(DecisionCapabilityAuthorizationErrorV2::Invalid)?;
    let submitted_signature = parts
        .next()
        .and_then(decode_hex_32)
        .ok_or(DecisionCapabilityAuthorizationErrorV2::Invalid)?;
    if parts.next().is_some() {
        return Err(DecisionCapabilityAuthorizationErrorV2::Invalid);
    }
    let signed = signed_capability_bytes(expires_at_millis, &nonce, &grant_digest);
    let expected_signature = hmac_sha256(signing_key, &signed);
    if !constant_time_eq(&expected_signature, &submitted_signature) {
        return Err(DecisionCapabilityAuthorizationErrorV2::Invalid);
    }
    Ok(ParsedDecisionCapabilityV2 {
        expires_at_millis,
        grant_digest,
    })
}

fn signed_capability_bytes(
    expires_at_millis: u64,
    nonce: &[u8; 32],
    grant_digest: &[u8; 32],
) -> Vec<u8> {
    let mut value = Vec::with_capacity(8 + nonce.len() + grant_digest.len());
    value.extend_from_slice(&expires_at_millis.to_be_bytes());
    value.extend_from_slice(nonce);
    value.extend_from_slice(grant_digest);
    value
}

fn prune_expired(records: &mut HashMap<[u8; 32], StoredDecisionCapabilityV2>, now: Instant) {
    records.retain(|_, record| record.expires_at_instant > now);
}

fn random_32_bytes() -> Result<[u8; 32], getrandom::Error> {
    let mut value = [0_u8; 32];
    getrandom::fill(&mut value)?;
    Ok(value)
}

fn now_millis() -> Option<u64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    u64::try_from(millis).ok()
}

fn digest_serialized(value: &impl Serialize) -> Result<[u8; 32], serde_json::Error> {
    serde_json::to_vec(value).map(|encoded| sha256(&encoded))
}

fn sha256(value: &[u8]) -> [u8; 32] {
    Sha256::digest(value).into()
}

fn hmac_sha256(key: &[u8], value: &[u8]) -> [u8; 32] {
    const BLOCK_BYTES: usize = 64;
    let mut normalized_key = [0_u8; BLOCK_BYTES];
    if key.len() > BLOCK_BYTES {
        normalized_key[..32].copy_from_slice(&sha256(key));
    } else {
        normalized_key[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; BLOCK_BYTES];
    let mut outer_pad = [0x5c_u8; BLOCK_BYTES];
    for index in 0..BLOCK_BYTES {
        inner_pad[index] ^= normalized_key[index];
        outer_pad[index] ^= normalized_key[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(value);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    outer.finalize().into()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let maximum = left.len().max(right.len());
    for index in 0..maximum {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

fn encode_hex(value: &[u8]) -> String {
    let mut output = String::with_capacity(value.len() * 2);
    for byte in value {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn decode_hex_32(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut decoded = [0_u8; 32];
    for (index, slot) in decoded.iter_mut().enumerate() {
        let start = index * 2;
        *slot = u8::from_str_radix(&value[start..start + 2], 16).ok()?;
    }
    Some(decoded)
}
