use crate::host_v2_storage::{
    stable_json_sha256, validate_bounded_identity, validate_safe_session_identity,
    validate_sha256_digest, HostV2StorageError,
};
use crate::prelude::*;
use crate::*;
use std::collections::HashSet;

pub(crate) const SESSION_PROVIDER_ADMISSION_SIDECAR_SCHEMA_V2: &str =
    "deepcode.session.provider-admission-sidecar.v2";
pub(crate) const SESSION_PROVIDER_CONVERSATION_HEAD_SCHEMA_V1: &str =
    "deepcode.session.provider-conversation-head.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionProviderCacheLaneModeV2 {
    Bootstrap,
    Append,
    Reset,
    ExactReplay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionProviderCacheLaneRelationKindV2 {
    Bootstrap,
    SameTurnToolContinuation,
    SameTurnSessionControlContinuation,
    NextUserTurn,
    ExactReplay,
    Reset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionProviderCacheLaneResetReasonV1 {
    ColdStart,
    SemanticLaneChanged,
    ProviderProfileChanged,
    ModelChanged,
    SystemContractChanged,
    ToolSchemaChanged,
    ResponseFormatChanged,
    ContextCompaction,
    Rewind,
    DaemonTraceUnavailable,
    DaemonTraceInvalid,
    LegacySessionColdStart,
    ManualReset,
}

impl SessionProviderCacheLaneResetReasonV1 {
    pub(crate) fn wire_name(self) -> &'static str {
        match self {
            Self::ColdStart => "coldStart",
            Self::SemanticLaneChanged => "semanticLaneChanged",
            Self::ProviderProfileChanged => "providerProfileChanged",
            Self::ModelChanged => "modelChanged",
            Self::SystemContractChanged => "systemContractChanged",
            Self::ToolSchemaChanged => "toolSchemaChanged",
            Self::ResponseFormatChanged => "responseFormatChanged",
            Self::ContextCompaction => "contextCompaction",
            Self::Rewind => "rewind",
            Self::DaemonTraceUnavailable => "daemonTraceUnavailable",
            Self::DaemonTraceInvalid => "daemonTraceInvalid",
            Self::LegacySessionColdStart => "legacySessionColdStart",
            Self::ManualReset => "manualReset",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderToolContextRefSidecarV1 {
    pub(crate) context_version: u64,
    pub(crate) catalog_digest: String,
    pub(crate) context_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderConversationHeadV1 {
    pub(crate) schema_version: String,
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) user_turn_id: String,
    pub(crate) provider_turn_id: String,
    pub(crate) control_epoch: u64,
    pub(crate) source_event_id: String,
    pub(crate) source_event_version: u64,
    pub(crate) source_event_digest: String,
    pub(crate) provider_profile_id: String,
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) answer_digest: String,
    pub(crate) head_digest: String,
}

impl SessionProviderConversationHeadV1 {
    pub(crate) fn validate(&self, expected_session_id: &str) -> Result<(), HostV2StorageError> {
        if self.schema_version != SESSION_PROVIDER_CONVERSATION_HEAD_SCHEMA_V1
            || self.session_id != expected_session_id
        {
            return Err(HostV2StorageError::invalid(
                "provider_conversation_head_identity_invalid",
                "Provider conversation head has an invalid schema or Session identity",
            ));
        }
        validate_safe_session_identity(&self.session_id)?;
        for (value, field, limit) in [
            (self.run_id.as_str(), "head.runId", 512),
            (self.user_turn_id.as_str(), "head.userTurnId", 512),
            (self.provider_turn_id.as_str(), "head.providerTurnId", 512),
            (self.source_event_id.as_str(), "head.sourceEventId", 512),
            (
                self.provider_profile_id.as_str(),
                "head.providerProfileId",
                512,
            ),
            (self.provider.as_str(), "head.provider", 512),
            (self.model.as_str(), "head.model", 512),
        ] {
            validate_bounded_identity(value, field, limit)?;
        }
        if self.control_epoch == 0 || self.source_event_version == 0 {
            return Err(HostV2StorageError::invalid(
                "provider_conversation_head_version_invalid",
                "Provider conversation head counters must be positive",
            ));
        }
        for (digest, field) in [
            (&self.source_event_digest, "head.sourceEventDigest"),
            (&self.answer_digest, "head.answerDigest"),
            (&self.head_digest, "head.headDigest"),
        ] {
            validate_sha256_digest(digest, field)?;
        }
        let expected_digest = stable_json_sha256(&json!({
            "schemaVersion": self.schema_version,
            "sessionId": self.session_id,
            "runId": self.run_id,
            "userTurnId": self.user_turn_id,
            "providerTurnId": self.provider_turn_id,
            "controlEpoch": self.control_epoch,
            "sourceEventId": self.source_event_id,
            "sourceEventVersion": self.source_event_version,
            "sourceEventDigest": self.source_event_digest,
            "providerProfileId": self.provider_profile_id,
            "provider": self.provider,
            "model": self.model,
            "answerDigest": self.answer_digest,
        }))?;
        if self.head_digest != expected_digest {
            return Err(HostV2StorageError::invalid(
                "provider_conversation_head_digest_mismatch",
                "Provider conversation head failed exact digest verification",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderAuthoritySidecarV2 {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plan_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) work_authority: Option<SessionWorkAuthorityV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) review_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) snapshot_high_water: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionProviderContinuationOutcomeStatusV2 {
    Completed,
    Aborted,
    Unexecuted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderContinuationRejectionV2 {
    pub(crate) reason: String,
    pub(crate) guidance: String,
    pub(crate) rejection_fact_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderContinuationOutcomeV2 {
    pub(crate) operation_id: String,
    pub(crate) status: SessionProviderContinuationOutcomeStatusV2,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) terminal_fact_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) terminal_fact_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) settlement_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rejection: Option<SessionProviderContinuationRejectionV2>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum SessionProviderTargetBindingSidecarV2 {
    Planning,
    ContextRead {
        operation_id: String,
        purpose: String,
        idempotency_key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        deadline: Option<Value>,
    },
    PlanAction {
        plan_action_id: String,
    },
    InterventionResearch {
        research_id: String,
    },
    FinalAnswer {
        input_id: String,
        control_epoch: u64,
        work_authority: SessionWorkAuthorityV3,
        review_revision: u64,
        snapshot_high_water: u64,
    },
}

impl SessionProviderTargetBindingSidecarV2 {
    pub(crate) fn kind_name(&self) -> &'static str {
        match self {
            Self::Planning => "planning",
            Self::ContextRead { .. } => "contextRead",
            Self::PlanAction { .. } => "planAction",
            Self::InterventionResearch { .. } => "interventionResearch",
            Self::FinalAnswer { .. } => "finalAnswer",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderCacheLaneSidecarV2 {
    pub(crate) lane_id: String,
    pub(crate) lane_revision: u64,
    pub(crate) mode: SessionProviderCacheLaneModeV2,
    pub(crate) relation_kind: SessionProviderCacheLaneRelationKindV2,
    pub(crate) stable_prefix_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) predecessor_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) predecessor_external_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reset_reason: Option<SessionProviderCacheLaneResetReasonV1>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) supporting_reset_reasons: Vec<SessionProviderCacheLaneResetReasonV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderAdmissionSidecarV2 {
    pub(crate) schema_version: String,
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) provider_turn_id: String,
    pub(crate) user_turn_id: String,
    pub(crate) control_epoch: u64,
    pub(crate) purpose: ProviderTracePurposeV1,
    pub(crate) target_kind: String,
    pub(crate) target_binding: SessionProviderTargetBindingSidecarV2,
    pub(crate) provider_profile_revision_digest: String,
    pub(crate) current_input_digest: String,
    pub(crate) context_assembly_digest: String,
    pub(crate) semantic_messages_digest: String,
    pub(crate) tool_schema_digest: String,
    pub(crate) response_format_digest: String,
    pub(crate) tool_context_ref: SessionProviderToolContextRefSidecarV1,
    pub(crate) authority: SessionProviderAuthoritySidecarV2,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provider_conversation_head: Option<SessionProviderConversationHeadV1>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) continuation_operation_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) continuation_outcomes: Vec<SessionProviderContinuationOutcomeV2>,
    pub(crate) cache_lane: SessionProviderCacheLaneSidecarV2,
}

impl SessionProviderAdmissionSidecarV2 {
    pub(crate) fn decode(request: &Value) -> Result<Self, (&'static str, String)> {
        let value = request
            .get("providerOptions")
            .and_then(|value| value.get("deepcode"))
            .and_then(|value| value.get("sessionKernelV2"))
            .cloned()
            .ok_or_else(|| {
                (
                    "provider_admission_sidecar_missing",
                    "Provider request is missing its trusted Session admission sidecar".to_string(),
                )
            })?;
        Self::decode_private_value(value)
    }

    pub(crate) fn decode_private_value(value: Value) -> Result<Self, (&'static str, String)> {
        let decoded = serde_json::from_value::<Self>(value).map_err(|error| {
            (
                "provider_admission_sidecar_invalid",
                format!("Decode trusted Session admission sidecar: {error}"),
            )
        })?;
        decoded
            .validate()
            .map_err(|error| (error.code, error.message))?;
        Ok(decoded)
    }

    pub(crate) fn validate_request_material(
        &self,
        request: &Value,
    ) -> Result<(), (&'static str, String)> {
        let messages = request
            .get("messages")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                (
                    "provider_admission_messages_invalid",
                    "Provider admission requires an exact messages array".to_string(),
                )
            })?;
        let tools = request
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let response_format = request
            .get("responseFormat")
            .cloned()
            .unwrap_or(Value::Null);
        let actual_messages =
            stable_json_sha256(&Value::Array(messages.clone())).map_err(storage_admission_error)?;
        let actual_tools =
            stable_json_sha256(&Value::Array(tools.clone())).map_err(storage_admission_error)?;
        let actual_response =
            stable_json_sha256(&response_format).map_err(storage_admission_error)?;
        if actual_messages != self.semantic_messages_digest
            || actual_tools != self.tool_schema_digest
            || actual_response != self.response_format_digest
        {
            return Err((
                "provider_admission_material_digest_mismatch",
                "Provider messages, tools, or response format do not match the trusted sidecar"
                    .to_string(),
            ));
        }
        if matches!(
            self.cache_lane.mode,
            SessionProviderCacheLaneModeV2::Bootstrap | SessionProviderCacheLaneModeV2::Reset
        ) {
            let system_messages = messages
                .iter()
                .filter(|message| message.get("role").and_then(Value::as_str) == Some("system"))
                .cloned()
                .collect::<Vec<_>>();
            let stable_prefix = stable_json_sha256(&json!({
                "systemMessages": system_messages,
                "tools": tools,
                "responseFormat": response_format,
            }))
            .map_err(storage_admission_error)?;
            if stable_prefix != self.cache_lane.stable_prefix_digest {
                return Err((
                    "provider_cache_lane_prefix_mismatch",
                    "Provider stable prefix does not match the trusted cache lane".to_string(),
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn validate_against_admission(
        &self,
        expected_session_id: &str,
        expected_profile_revision: &str,
        admission: &SessionProviderTurnAdmissionV2,
    ) -> Result<(), (&'static str, String)> {
        let expected_target = serde_json::to_value(&self.target_binding)
            .map_err(|error| ("provider_admission_sidecar_invalid", error.to_string()))?;
        if self.session_id != expected_session_id
            || self.provider_turn_id != admission.provider_turn_id
            || self.run_id != admission.run_id
            || self.control_epoch != admission.control_epoch
            || self.user_turn_id != admission.current_input_id
            || self.current_input_digest != admission.current_input_digest
            || self.purpose != admission.purpose
            || self.provider_profile_revision_digest != expected_profile_revision
            || self.provider_profile_revision_digest != admission.provider_profile_revision
            || self.context_assembly_digest != admission.context_assembly_digest
            || self
                .provider_conversation_head
                .as_ref()
                .is_some_and(|head| admission.provider_conversation_head.as_ref() != Some(head))
            || self.tool_context_ref != admission.tool_context_ref
            || expected_target != admission.target
            || self.authority.plan_revision != admission.plan_revision
            || self.authority.work_authority != admission.work_authority
            || self.authority.review_revision != admission.review_revision
            || self.authority.snapshot_high_water != admission.snapshot_high_water
        {
            return Err((
                "provider_admission_sidecar_mismatch",
                "Trusted Session admission sidecar does not match the durable Provider turn"
                    .to_string(),
            ));
        }
        Ok(())
    }

    pub(crate) fn dispatch_binding(&self) -> SessionProviderDispatchBindingV2 {
        SessionProviderDispatchBindingV2 {
            provider_turn_id: self.provider_turn_id.clone(),
            run_id: self.run_id.clone(),
            control_epoch: self.control_epoch,
            current_input_id: self.user_turn_id.clone(),
            current_input_digest: self.current_input_digest.clone(),
            purpose: self.purpose,
            plan_revision: self.authority.plan_revision.clone(),
            work_authority: self.authority.work_authority.clone(),
            review_revision: self.authority.review_revision,
            snapshot_high_water: self.authority.snapshot_high_water,
        }
    }

    pub(crate) fn private_trace_value(&self) -> Result<Value, (&'static str, String)> {
        serde_json::to_value(self).map_err(|error| {
            (
                "provider_admission_sidecar_invalid",
                format!("Encode trusted Session admission sidecar: {error}"),
            )
        })
    }

    fn validate(&self) -> Result<(), HostV2StorageError> {
        if self.schema_version != SESSION_PROVIDER_ADMISSION_SIDECAR_SCHEMA_V2 {
            return Err(HostV2StorageError::invalid(
                "provider_admission_sidecar_schema_invalid",
                "Trusted Session admission sidecar schema is unsupported",
            ));
        }
        validate_safe_session_identity(&self.session_id)?;
        for (value, field, limit) in [
            (self.run_id.as_str(), "runId", 512),
            (self.provider_turn_id.as_str(), "providerTurnId", 512),
            (self.user_turn_id.as_str(), "userTurnId", 512),
            (self.target_kind.as_str(), "targetKind", 64),
            (self.cache_lane.lane_id.as_str(), "laneId", 512),
        ] {
            validate_bounded_identity(value, field, limit)?;
        }
        if self.control_epoch == 0 || self.cache_lane.lane_revision == 0 {
            return Err(HostV2StorageError::invalid(
                "provider_admission_sidecar_identity_invalid",
                "Provider control epoch and cache lane revision must be positive",
            ));
        }
        for (digest, field) in [
            (
                &self.provider_profile_revision_digest,
                "providerProfileRevisionDigest",
            ),
            (&self.current_input_digest, "currentInputDigest"),
            (&self.context_assembly_digest, "contextAssemblyDigest"),
            (&self.semantic_messages_digest, "semanticMessagesDigest"),
            (&self.tool_schema_digest, "toolSchemaDigest"),
            (&self.response_format_digest, "responseFormatDigest"),
            (&self.tool_context_ref.catalog_digest, "catalogDigest"),
            (&self.tool_context_ref.context_digest, "contextDigest"),
            (&self.cache_lane.stable_prefix_digest, "stablePrefixDigest"),
        ] {
            validate_sha256_digest(digest, field)?;
        }
        if self.tool_context_ref.context_version == 0 {
            return Err(HostV2StorageError::invalid(
                "provider_admission_tool_context_invalid",
                "Provider ToolContext version must be positive",
            ));
        }
        if self.target_kind != self.target_binding.kind_name() {
            return Err(HostV2StorageError::invalid(
                "provider_admission_target_invalid",
                "Provider targetKind conflicts with its exact private target binding",
            ));
        }
        validate_target_binding(&self.target_binding)?;
        let final_answer = matches!(self.purpose, ProviderTracePurposeV1::FinalAnswer);
        if final_answer
            != matches!(
                self.target_binding,
                SessionProviderTargetBindingSidecarV2::FinalAnswer { .. }
            )
        {
            return Err(HostV2StorageError::invalid(
                "provider_admission_purpose_invalid",
                "Provider finalAnswer purpose conflicts with its exact target binding",
            ));
        }
        match (&self.target_binding, final_answer) {
            (
                SessionProviderTargetBindingSidecarV2::FinalAnswer {
                    input_id,
                    control_epoch,
                    work_authority,
                    review_revision,
                    snapshot_high_water,
                },
                true,
            ) if input_id == &self.user_turn_id
                && control_epoch == &self.control_epoch
                && self.authority.work_authority.as_ref() == Some(work_authority)
                && self.authority.review_revision == Some(*review_revision)
                && self.authority.snapshot_high_water == Some(*snapshot_high_water) => {}
            (SessionProviderTargetBindingSidecarV2::FinalAnswer { .. }, true) => {
                return Err(HostV2StorageError::invalid(
                    "provider_admission_authority_invalid",
                    "Provider finalAnswer target conflicts with its private authority binding",
                ));
            }
            (_, false)
                if self.authority.work_authority.is_none()
                    && self.authority.review_revision.is_none()
                    && self.authority.snapshot_high_water.is_none() => {}
            _ => {
                return Err(HostV2StorageError::invalid(
                    "provider_admission_authority_invalid",
                    "Non-final Provider admission cannot carry Review authority",
                ));
            }
        }
        match self.cache_lane.mode {
            SessionProviderCacheLaneModeV2::Bootstrap => {
                require_cache_relation_fields(&self.cache_lane, false, false, false)?;
                if self.cache_lane.relation_kind
                    != SessionProviderCacheLaneRelationKindV2::Bootstrap
                {
                    return Err(invalid_cache_relation_kind());
                }
            }
            SessionProviderCacheLaneModeV2::Append => {
                require_cache_relation_fields(&self.cache_lane, true, true, false)?;
                if !matches!(
                    self.cache_lane.relation_kind,
                    SessionProviderCacheLaneRelationKindV2::SameTurnToolContinuation
                        | SessionProviderCacheLaneRelationKindV2::SameTurnSessionControlContinuation
                        | SessionProviderCacheLaneRelationKindV2::NextUserTurn
                ) {
                    return Err(invalid_cache_relation_kind());
                }
            }
            SessionProviderCacheLaneModeV2::Reset => {
                require_cache_relation_fields(&self.cache_lane, false, false, true)?;
                if self.cache_lane.relation_kind != SessionProviderCacheLaneRelationKindV2::Reset {
                    return Err(invalid_cache_relation_kind());
                }
            }
            SessionProviderCacheLaneModeV2::ExactReplay => {
                require_cache_relation_fields(&self.cache_lane, true, true, false)?;
                if self.cache_lane.relation_kind
                    != SessionProviderCacheLaneRelationKindV2::ExactReplay
                {
                    return Err(invalid_cache_relation_kind());
                }
            }
        }
        let continuation_append = self.cache_lane.relation_kind
            == SessionProviderCacheLaneRelationKindV2::SameTurnToolContinuation;
        let control_continuation_append = self.cache_lane.relation_kind
            == SessionProviderCacheLaneRelationKindV2::SameTurnSessionControlContinuation;
        let next_user_append =
            self.cache_lane.relation_kind == SessionProviderCacheLaneRelationKindV2::NextUserTurn;
        if next_user_append
            != (self.purpose == ProviderTracePurposeV1::Primary
                && self.provider_conversation_head.is_some())
            || (!next_user_append && self.provider_conversation_head.is_some())
        {
            return Err(HostV2StorageError::invalid(
                "provider_conversation_head_relation_invalid",
                "Provider conversation head conflicts with the cache lane relation",
            ));
        }
        if let Some(head) = &self.provider_conversation_head {
            head.validate(&self.session_id)?;
            if head.provider_turn_id
                != self
                    .cache_lane
                    .predecessor_request_id
                    .clone()
                    .unwrap_or_default()
                || head.provider_profile_id.is_empty()
            {
                return Err(HostV2StorageError::invalid(
                    "provider_conversation_head_relation_invalid",
                    "Provider conversation head does not bind the admitted predecessor",
                ));
            }
        }
        if continuation_append != !self.continuation_operation_ids.is_empty()
            || continuation_append != !self.continuation_outcomes.is_empty()
            || self.continuation_operation_ids.len() != self.continuation_outcomes.len()
            || self.continuation_operation_ids.len() > 32
        {
            return Err(HostV2StorageError::invalid(
                "provider_continuation_operation_identity_invalid",
                "Provider append continuation operation identities are missing or out of scope",
            ));
        }
        if control_continuation_append && self.purpose != ProviderTracePurposeV1::Continuation {
            return Err(HostV2StorageError::invalid(
                "provider_control_continuation_invalid",
                "Session control continuation must remain in the current Provider turn authority",
            ));
        }
        let mut unique_continuation_operations =
            HashSet::with_capacity(self.continuation_operation_ids.len());
        for operation_id in &self.continuation_operation_ids {
            validate_bounded_identity(operation_id, "continuationOperationId", 512)?;
            if !unique_continuation_operations.insert(operation_id) {
                return Err(HostV2StorageError::invalid(
                    "provider_continuation_operation_identity_invalid",
                    "Provider append continuation operation identities must be unique",
                ));
            }
        }
        for (index, outcome) in self.continuation_outcomes.iter().enumerate() {
            validate_bounded_identity(
                &outcome.operation_id,
                "continuationOutcome.operationId",
                512,
            )?;
            if self.continuation_operation_ids.get(index) != Some(&outcome.operation_id) {
                return Err(HostV2StorageError::invalid(
                    "provider_continuation_operation_identity_invalid",
                    "Provider continuation outcomes must exactly follow admitted operation identities",
                ));
            }
            let has_terminal_id = outcome.terminal_fact_id.is_some();
            let has_terminal_kind = outcome.terminal_fact_kind.is_some();
            if has_terminal_id != has_terminal_kind {
                return Err(HostV2StorageError::invalid(
                    "provider_continuation_outcome_invalid",
                    "Provider continuation terminal fact identity is partial",
                ));
            }
            if let Some(value) = &outcome.terminal_fact_id {
                validate_bounded_identity(value, "continuationOutcome.terminalFactId", 512)?;
            }
            if let Some(value) = &outcome.terminal_fact_kind {
                validate_bounded_identity(value, "continuationOutcome.terminalFactKind", 128)?;
            }
            if let Some(value) = &outcome.settlement_reason {
                validate_bounded_identity(value, "continuationOutcome.settlementReason", 256)?;
            }
            if let Some(rejection) = &outcome.rejection {
                validate_bounded_identity(
                    &rejection.reason,
                    "continuationOutcome.rejection.reason",
                    128,
                )?;
                validate_bounded_identity(
                    &rejection.rejection_fact_id,
                    "continuationOutcome.rejection.rejectionFactId",
                    512,
                )?;
                if rejection.guidance.trim().is_empty() || rejection.guidance.len() > 64 * 1024 {
                    return Err(HostV2StorageError::invalid(
                        "provider_continuation_outcome_invalid",
                        "Provider continuation rejection guidance is empty or too large",
                    ));
                }
            }
            let invalid_shape = match outcome.status {
                SessionProviderContinuationOutcomeStatusV2::Completed => {
                    outcome.settlement_reason.is_some()
                        || outcome.rejection.is_some()
                        || !has_terminal_id
                }
                SessionProviderContinuationOutcomeStatusV2::Aborted => {
                    outcome.settlement_reason.is_none()
                        || outcome.rejection.as_ref().is_some_and(|_| {
                            outcome.settlement_reason.as_deref() != Some("kernelRejected")
                                || has_terminal_id
                        })
                }
                SessionProviderContinuationOutcomeStatusV2::Unexecuted => {
                    outcome.settlement_reason.is_none()
                        || has_terminal_id
                        || outcome.rejection.is_some()
                }
            };
            if invalid_shape {
                return Err(HostV2StorageError::invalid(
                    "provider_continuation_outcome_invalid",
                    "Provider continuation outcome status conflicts with its evidence",
                ));
            }
        }
        if self.cache_lane.supporting_reset_reasons.len() > 15
            || self
                .cache_lane
                .supporting_reset_reasons
                .iter()
                .any(|reason| Some(reason) == self.cache_lane.reset_reason.as_ref())
        {
            return Err(HostV2StorageError::invalid(
                "provider_cache_lane_reset_reasons_invalid",
                "Provider cache lane supporting reset reasons are invalid",
            ));
        }
        let mut unique_supporting = self.cache_lane.supporting_reset_reasons.clone();
        unique_supporting.sort_by_key(|reason| reason.wire_name());
        unique_supporting.dedup();
        if unique_supporting.len() != self.cache_lane.supporting_reset_reasons.len()
            || (self.cache_lane.mode != SessionProviderCacheLaneModeV2::Reset
                && !self.cache_lane.supporting_reset_reasons.is_empty())
        {
            return Err(HostV2StorageError::invalid(
                "provider_cache_lane_reset_reasons_invalid",
                "Provider cache lane supporting reset reasons conflict with its mode",
            ));
        }
        Ok(())
    }
}

fn invalid_cache_relation_kind() -> HostV2StorageError {
    HostV2StorageError::invalid(
        "provider_cache_lane_relation_invalid",
        "Provider cache lane mode conflicts with its exact relation kind",
    )
}

fn validate_target_binding(
    target: &SessionProviderTargetBindingSidecarV2,
) -> Result<(), HostV2StorageError> {
    match target {
        SessionProviderTargetBindingSidecarV2::Planning => Ok(()),
        SessionProviderTargetBindingSidecarV2::ContextRead {
            operation_id,
            purpose,
            idempotency_key,
            deadline: _,
        } => {
            validate_bounded_identity(operation_id, "operationId", 512)?;
            validate_bounded_identity(purpose, "contextReadPurpose", 2048)?;
            validate_bounded_identity(idempotency_key, "idempotencyKey", 512)
        }
        SessionProviderTargetBindingSidecarV2::PlanAction { plan_action_id } => {
            validate_bounded_identity(plan_action_id, "planActionId", 512)
        }
        SessionProviderTargetBindingSidecarV2::InterventionResearch { research_id } => {
            validate_bounded_identity(research_id, "interventionResearch.researchId", 512)
        }
        SessionProviderTargetBindingSidecarV2::FinalAnswer {
            input_id,
            control_epoch,
            review_revision,
            snapshot_high_water,
            ..
        } => {
            validate_bounded_identity(input_id, "finalAnswer.inputId", 512)?;
            if *control_epoch == 0
                || *review_revision == 0
                || *snapshot_high_water > 9_007_199_254_740_991
            {
                return Err(HostV2StorageError::invalid(
                    "provider_admission_target_invalid",
                    "Provider finalAnswer target has invalid bounded counters",
                ));
            }
            Ok(())
        }
    }
}

fn require_cache_relation_fields(
    lane: &SessionProviderCacheLaneSidecarV2,
    require_predecessor: bool,
    require_external_digest: bool,
    require_reset: bool,
) -> Result<(), HostV2StorageError> {
    if lane.predecessor_request_id.is_some() != require_predecessor
        || lane.predecessor_external_digest.is_some() != require_external_digest
        || lane.reset_reason.is_some() != require_reset
    {
        return Err(HostV2StorageError::invalid(
            "provider_cache_lane_relation_invalid",
            "Provider cache lane relation has inconsistent predecessor or reset fields",
        ));
    }
    if let Some(predecessor) = &lane.predecessor_request_id {
        validate_bounded_identity(predecessor, "predecessorRequestId", 512)?;
    }
    if let Some(digest) = &lane.predecessor_external_digest {
        validate_sha256_digest(digest, "predecessorExternalDigest")?;
    }
    Ok(())
}

fn storage_admission_error(error: HostV2StorageError) -> (&'static str, String) {
    (error.code, error.message)
}
