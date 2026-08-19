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
    SameTurnStructuredRepair,
    NextUserTurn,
    ExactReplay,
    Reset,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderStructuredRepairSidecarV1 {
    pub(crate) schema_version: String,
    pub(crate) predecessor_provider_turn_id: String,
    pub(crate) source_terminal_kind: String,
    pub(crate) error_code: String,
    pub(crate) failure_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source_response_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderControlReceiptSidecarV2 {
    pub(crate) schema_version: String,
    pub(crate) call_id: String,
    pub(crate) tool_name: String,
    pub(crate) arguments_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderPlanEvidenceRefreshSidecarV1 {
    pub(crate) error_code: String,
    pub(crate) stale_fact_refs: Vec<String>,
    pub(crate) resource_refs: Vec<String>,
    pub(crate) read_subject_digests: Vec<String>,
    pub(crate) blocking_unknown_ids: Vec<String>,
    pub(crate) candidate_scope_digest: String,
    pub(crate) requires_current_read: bool,
    pub(crate) snapshot_high_water: u64,
    pub(crate) fact_set_digest: String,
    pub(crate) evidence_debt_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderPlanPreviewRejectionItemSidecarV1 {
    pub(crate) plan_action_id: String,
    pub(crate) operation_id: String,
    pub(crate) tool_id: String,
    pub(crate) reason: String,
    pub(crate) guidance: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderPlanPreviewRejectionSidecarV1 {
    pub(crate) plan_revision: String,
    pub(crate) rejections: Vec<SessionProviderPlanPreviewRejectionItemSidecarV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderPlanDecisionSidecarV2 {
    pub(crate) plan_revision: String,
    pub(crate) decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) guidance: Option<String>,
    pub(crate) recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderPlanActionSettlementSidecarV2 {
    pub(crate) kind: String,
    pub(crate) plan_revision: String,
    pub(crate) plan_action_id: String,
    pub(crate) control_epoch: u64,
    pub(crate) outcome: String,
    pub(crate) provider_turn_id: String,
    pub(crate) control_call_id: String,
    pub(crate) control_arguments_digest: String,
    pub(crate) snapshot_high_water: u64,
    pub(crate) recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderUserInterventionDecisionSidecarV4 {
    pub(crate) interaction_id: String,
    pub(crate) interaction_revision: String,
    pub(crate) candidate_set_digest: String,
    pub(crate) decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) option_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) guidance: Option<String>,
    pub(crate) caller_request_id: String,
    pub(crate) recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum SessionProviderControlSettlementSidecarV2 {
    PlanEvidenceRefresh {
        schema_version: String,
        run_id: String,
        input_id: String,
        control_epoch: u64,
        predecessor_provider_turn_id: String,
        next_target_kind: String,
        control: SessionProviderControlReceiptSidecarV2,
        refresh: SessionProviderPlanEvidenceRefreshSidecarV1,
        recorded_at: String,
        settlement_digest: String,
    },
    PlanPreviewRejected {
        schema_version: String,
        run_id: String,
        input_id: String,
        control_epoch: u64,
        predecessor_provider_turn_id: String,
        next_target_kind: String,
        control: SessionProviderControlReceiptSidecarV2,
        preview: SessionProviderPlanPreviewRejectionSidecarV1,
        recorded_at: String,
        settlement_digest: String,
    },
    PlanDecision {
        schema_version: String,
        run_id: String,
        input_id: String,
        control_epoch: u64,
        predecessor_provider_turn_id: String,
        next_target_kind: String,
        control: SessionProviderControlReceiptSidecarV2,
        decision: SessionProviderPlanDecisionSidecarV2,
        recorded_at: String,
        settlement_digest: String,
    },
    PlanActionComplete {
        schema_version: String,
        run_id: String,
        input_id: String,
        control_epoch: u64,
        predecessor_provider_turn_id: String,
        next_target_kind: String,
        control: SessionProviderControlReceiptSidecarV2,
        settlement: SessionProviderPlanActionSettlementSidecarV2,
        recorded_at: String,
        settlement_digest: String,
    },
    UserInterventionDecision {
        schema_version: String,
        run_id: String,
        input_id: String,
        control_epoch: u64,
        predecessor_provider_turn_id: String,
        next_target_kind: String,
        control: SessionProviderControlReceiptSidecarV2,
        decision: SessionProviderUserInterventionDecisionSidecarV4,
        disposition: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        accepted_plan_revision: Option<String>,
        recorded_at: String,
        settlement_digest: String,
    },
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) control_settlement: Option<SessionProviderControlSettlementSidecarV2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) structured_repair: Option<SessionProviderStructuredRepairSidecarV1>,
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
                        | SessionProviderCacheLaneRelationKindV2::SameTurnStructuredRepair
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
        let structured_repair_append = self.cache_lane.relation_kind
            == SessionProviderCacheLaneRelationKindV2::SameTurnStructuredRepair;
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
        let expected_control_purpose = if self.target_binding.kind_name() == "finalAnswer" {
            ProviderTracePurposeV1::FinalAnswer
        } else {
            ProviderTracePurposeV1::Continuation
        };
        if control_continuation_append != self.control_settlement.is_some()
            || control_continuation_append && self.purpose != expected_control_purpose
        {
            return Err(HostV2StorageError::invalid(
                "provider_control_continuation_invalid",
                "Session control continuation conflicts with its private settlement or Provider turn authority",
            ));
        }
        if let Some(settlement) = &self.control_settlement {
            settlement.validate()?;
            if settlement.run_id() != self.run_id
                || settlement.input_id() != self.user_turn_id
                || settlement.control_epoch() != self.control_epoch
                || settlement.predecessor_provider_turn_id()
                    != self
                        .cache_lane
                        .predecessor_request_id
                        .as_deref()
                        .unwrap_or_default()
                || settlement.next_target_kind() != self.target_binding.kind_name()
            {
                return Err(HostV2StorageError::invalid(
                    "provider_control_continuation_invalid",
                    "Session control settlement does not bind the exact admitted continuation",
                ));
            }
        }
        if structured_repair_append != self.structured_repair.is_some()
            || structured_repair_append && self.purpose != ProviderTracePurposeV1::Continuation
        {
            return Err(HostV2StorageError::invalid(
                "provider_structured_repair_relation_invalid",
                "Structured Provider repair conflicts with its append relation",
            ));
        }
        if let Some(repair) = &self.structured_repair {
            if repair.schema_version != "deepcode.session.provider-structured-repair.v1"
                || repair.predecessor_provider_turn_id
                    != self
                        .cache_lane
                        .predecessor_request_id
                        .clone()
                        .unwrap_or_default()
                || !matches!(repair.source_terminal_kind.as_str(), "failed" | "completed")
                || (repair.source_terminal_kind == "completed")
                    != repair.source_response_digest.is_some()
            {
                return Err(HostV2StorageError::invalid(
                    "provider_structured_repair_relation_invalid",
                    "Structured Provider repair has an invalid predecessor binding",
                ));
            }
            validate_bounded_identity(
                &repair.predecessor_provider_turn_id,
                "structuredRepair.predecessorProviderTurnId",
                512,
            )?;
            validate_bounded_identity(&repair.error_code, "structuredRepair.errorCode", 256)?;
            validate_sha256_digest(&repair.failure_digest, "structuredRepair.failureDigest")?;
            if let Some(digest) = &repair.source_response_digest {
                validate_sha256_digest(digest, "structuredRepair.sourceResponseDigest")?;
            }
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

impl SessionProviderControlSettlementSidecarV2 {
    pub(crate) fn run_id(&self) -> &str {
        match self {
            Self::PlanEvidenceRefresh { run_id, .. }
            | Self::PlanPreviewRejected { run_id, .. }
            | Self::PlanDecision { run_id, .. }
            | Self::PlanActionComplete { run_id, .. }
            | Self::UserInterventionDecision { run_id, .. } => run_id,
        }
    }

    pub(crate) fn input_id(&self) -> &str {
        match self {
            Self::PlanEvidenceRefresh { input_id, .. }
            | Self::PlanPreviewRejected { input_id, .. }
            | Self::PlanDecision { input_id, .. }
            | Self::PlanActionComplete { input_id, .. }
            | Self::UserInterventionDecision { input_id, .. } => input_id,
        }
    }

    pub(crate) fn control_epoch(&self) -> u64 {
        match self {
            Self::PlanEvidenceRefresh { control_epoch, .. }
            | Self::PlanPreviewRejected { control_epoch, .. }
            | Self::PlanDecision { control_epoch, .. }
            | Self::PlanActionComplete { control_epoch, .. }
            | Self::UserInterventionDecision { control_epoch, .. } => *control_epoch,
        }
    }

    pub(crate) fn predecessor_provider_turn_id(&self) -> &str {
        match self {
            Self::PlanEvidenceRefresh {
                predecessor_provider_turn_id,
                ..
            }
            | Self::PlanPreviewRejected {
                predecessor_provider_turn_id,
                ..
            }
            | Self::PlanDecision {
                predecessor_provider_turn_id,
                ..
            }
            | Self::PlanActionComplete {
                predecessor_provider_turn_id,
                ..
            }
            | Self::UserInterventionDecision {
                predecessor_provider_turn_id,
                ..
            } => predecessor_provider_turn_id,
        }
    }

    pub(crate) fn next_target_kind(&self) -> &str {
        match self {
            Self::PlanEvidenceRefresh {
                next_target_kind, ..
            }
            | Self::PlanPreviewRejected {
                next_target_kind, ..
            }
            | Self::PlanDecision {
                next_target_kind, ..
            }
            | Self::PlanActionComplete {
                next_target_kind, ..
            }
            | Self::UserInterventionDecision {
                next_target_kind, ..
            } => next_target_kind,
        }
    }

    pub(crate) fn control(&self) -> &SessionProviderControlReceiptSidecarV2 {
        match self {
            Self::PlanEvidenceRefresh { control, .. }
            | Self::PlanPreviewRejected { control, .. }
            | Self::PlanDecision { control, .. }
            | Self::PlanActionComplete { control, .. }
            | Self::UserInterventionDecision { control, .. } => control,
        }
    }

    pub(crate) fn expected_parent_tool_name(&self) -> &'static str {
        match self {
            Self::PlanEvidenceRefresh { .. }
            | Self::PlanPreviewRejected { .. }
            | Self::PlanDecision { .. } => "deepcode_session_plan_propose_v5",
            Self::PlanActionComplete { .. } => "deepcode_session_plan_action_complete_v2",
            Self::UserInterventionDecision { .. } => "deepcode_session_intervention_propose_v1",
        }
    }

    pub(crate) fn continuation_output(&self) -> Value {
        match self {
            Self::PlanEvidenceRefresh { refresh, .. } => json!({
                "schemaVersion": "deepcode.session.control-continuation-result.v2",
                "status": "rejected",
                "control": self.expected_parent_tool_name(),
                "reasonCode": "planEvidenceRefreshRequired",
                "errorCode": refresh.error_code,
                "nextTargetKind": self.next_target_kind(),
                "snapshotHighWater": refresh.snapshot_high_water,
                "factSetDigest": refresh.fact_set_digest,
                "evidenceDebtDigest": refresh.evidence_debt_digest,
                "staleFactRefs": refresh.stale_fact_refs,
                "resourceRefs": refresh.resource_refs,
                "readSubjectDigests": refresh.read_subject_digests,
                "blockingUnknownIds": refresh.blocking_unknown_ids,
                "candidateScopeDigest": refresh.candidate_scope_digest,
                "requiresCurrentRead": refresh.requires_current_read,
            }),
            Self::PlanPreviewRejected { preview, .. } => json!({
                "schemaVersion": "deepcode.session.control-continuation-result.v2",
                "status": "rejected",
                "control": self.expected_parent_tool_name(),
                "reasonCode": "planPreviewRejected",
                "nextTargetKind": self.next_target_kind(),
                "planRevision": preview.plan_revision,
                "rejections": preview.rejections,
            }),
            Self::PlanDecision { decision, .. } => json!({
                "schemaVersion": "deepcode.session.control-continuation-result.v2",
                "status": "settled",
                "control": self.expected_parent_tool_name(),
                "nextTargetKind": self.next_target_kind(),
                "decision": decision.decision,
                "planRevision": decision.plan_revision,
            }),
            Self::PlanActionComplete { settlement, .. } => json!({
                "schemaVersion": "deepcode.session.control-continuation-result.v2",
                "status": "settled",
                "control": self.expected_parent_tool_name(),
                "nextTargetKind": self.next_target_kind(),
                "planRevision": settlement.plan_revision,
                "planActionId": settlement.plan_action_id,
                "outcome": settlement.outcome,
                "snapshotHighWater": settlement.snapshot_high_water,
            }),
            Self::UserInterventionDecision {
                decision,
                disposition,
                accepted_plan_revision,
                ..
            } => json!({
                "schemaVersion": "deepcode.session.control-continuation-result.v2",
                "status": "settled",
                "control": self.expected_parent_tool_name(),
                "nextTargetKind": self.next_target_kind(),
                "decision": decision.decision,
                "interactionId": decision.interaction_id,
                "interactionRevision": decision.interaction_revision,
                "candidateSetDigest": decision.candidate_set_digest,
                "optionId": decision.option_id,
                "disposition": disposition,
                "acceptedPlanRevision": accepted_plan_revision,
            }),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), HostV2StorageError> {
        let value = serde_json::to_value(self).map_err(|error| {
            HostV2StorageError::invalid(
                "provider_control_settlement_invalid",
                format!("Encode Session control settlement: {error}"),
            )
        })?;
        let object = value.as_object().ok_or_else(|| {
            HostV2StorageError::invalid(
                "provider_control_settlement_invalid",
                "Session control settlement must be an exact object",
            )
        })?;
        let schema_version = object
            .get("schemaVersion")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let recorded_at = object
            .get("recordedAt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let settlement_digest = object
            .get("settlementDigest")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if schema_version != "deepcode.session.provider-control-settlement.v2"
            || self.control_epoch() == 0
        {
            return Err(invalid_control_settlement());
        }
        for (identity, field, limit) in [
            (self.run_id(), "controlSettlement.runId", 512),
            (self.input_id(), "controlSettlement.inputId", 512),
            (
                self.predecessor_provider_turn_id(),
                "controlSettlement.predecessorProviderTurnId",
                512,
            ),
            (recorded_at, "controlSettlement.recordedAt", 1024),
        ] {
            validate_bounded_identity(identity, field, limit)?;
        }
        validate_sha256_digest(settlement_digest, "controlSettlement.settlementDigest")?;
        let mut unsigned = value.clone();
        unsigned
            .as_object_mut()
            .expect("settlement object was checked")
            .remove("settlementDigest");
        if stable_json_sha256(&unsigned)? != settlement_digest {
            return Err(invalid_control_settlement());
        }
        validate_control_receipt(self.control(), self.expected_parent_tool_name())?;
        match self {
            Self::PlanEvidenceRefresh {
                next_target_kind,
                refresh,
                ..
            } => {
                if next_target_kind != "planning"
                    || !matches!(
                        refresh.error_code.as_str(),
                        "session_kernel_provider_plan_evidence_stale"
                            | "session_kernel_provider_plan_resource_evidence_mismatch"
                            | "session_kernel_provider_plan_blocking_unknowns"
                            | "session_kernel_provider_plan_evidence_debt_unresolved"
                    )
                {
                    return Err(invalid_control_settlement());
                }
                validate_control_identity_list(
                    &refresh.stale_fact_refs,
                    "controlSettlement.refresh.staleFactRef",
                    512,
                )?;
                validate_control_identity_list(
                    &refresh.resource_refs,
                    "controlSettlement.refresh.resourceRef",
                    4096,
                )?;
                validate_control_digest_list(
                    &refresh.read_subject_digests,
                    "controlSettlement.refresh.readSubjectDigest",
                )?;
                validate_control_identity_list(
                    &refresh.blocking_unknown_ids,
                    "controlSettlement.refresh.blockingUnknownId",
                    512,
                )?;
                let reason_has_evidence = match refresh.error_code.as_str() {
                    "session_kernel_provider_plan_evidence_stale" => {
                        !refresh.stale_fact_refs.is_empty()
                    }
                    "session_kernel_provider_plan_resource_evidence_mismatch" => {
                        !refresh.resource_refs.is_empty()
                    }
                    "session_kernel_provider_plan_blocking_unknowns" => {
                        !refresh.blocking_unknown_ids.is_empty()
                    }
                    "session_kernel_provider_plan_evidence_debt_unresolved" => {
                        refresh.requires_current_read
                            || !refresh.resource_refs.is_empty()
                            || !refresh.read_subject_digests.is_empty()
                    }
                    _ => false,
                };
                if !reason_has_evidence {
                    return Err(invalid_control_settlement());
                }
                validate_sha256_digest(
                    &refresh.candidate_scope_digest,
                    "controlSettlement.refresh.candidateScopeDigest",
                )?;
                validate_sha256_digest(
                    &refresh.fact_set_digest,
                    "controlSettlement.refresh.factSetDigest",
                )?;
                validate_sha256_digest(
                    &refresh.evidence_debt_digest,
                    "controlSettlement.refresh.evidenceDebtDigest",
                )?;
            }
            Self::PlanPreviewRejected {
                next_target_kind,
                preview,
                ..
            } => {
                if next_target_kind != "planning"
                    || preview.rejections.is_empty()
                    || preview.rejections.len() > 128
                {
                    return Err(invalid_control_settlement());
                }
                validate_bounded_identity(
                    &preview.plan_revision,
                    "controlSettlement.preview.planRevision",
                    4096,
                )?;
                let mut previous_key: Option<String> = None;
                for rejection in &preview.rejections {
                    for (identity, field) in [
                        (
                            rejection.plan_action_id.as_str(),
                            "controlSettlement.preview.rejection.planActionId",
                        ),
                        (
                            rejection.operation_id.as_str(),
                            "controlSettlement.preview.rejection.operationId",
                        ),
                        (
                            rejection.tool_id.as_str(),
                            "controlSettlement.preview.rejection.toolId",
                        ),
                    ] {
                        validate_bounded_identity(identity, field, 4096)?;
                    }
                    if !matches!(
                        rejection.reason.as_str(),
                        "toolNotRegistered"
                            | "toolUnavailable"
                            | "invalidArguments"
                            | "requestedScopeInvalid"
                            | "settingsDenied"
                            | "staleToolContext"
                            | "staleControlEpoch"
                    ) || rejection.guidance.trim().is_empty()
                        || rejection.guidance.len() > 65_536
                    {
                        return Err(invalid_control_settlement());
                    }
                    let key = format!(
                        "{}\0{}\0{}",
                        rejection.plan_action_id, rejection.operation_id, rejection.tool_id
                    );
                    if previous_key
                        .as_ref()
                        .is_some_and(|previous| previous >= &key)
                    {
                        return Err(invalid_control_settlement());
                    }
                    previous_key = Some(key);
                }
            }
            Self::PlanDecision {
                next_target_kind,
                decision,
                recorded_at,
                ..
            } => {
                let expected_target = match decision.decision.as_str() {
                    "accept" => "planAction",
                    "revise" => "planning",
                    "reject" => "finalAnswer",
                    _ => return Err(invalid_control_settlement()),
                };
                if next_target_kind != expected_target
                    || decision.recorded_at != *recorded_at
                    || decision.plan_revision.trim().is_empty()
                    || decision.decision == "revise"
                        && decision
                            .guidance
                            .as_ref()
                            .is_none_or(|value| value.trim().is_empty())
                    || decision.decision != "revise"
                        && decision
                            .guidance
                            .as_ref()
                            .is_some_and(|value| value.trim().is_empty())
                {
                    return Err(invalid_control_settlement());
                }
                validate_bounded_identity(
                    &decision.plan_revision,
                    "controlSettlement.decision.planRevision",
                    512,
                )?;
            }
            Self::PlanActionComplete {
                next_target_kind,
                settlement,
                predecessor_provider_turn_id,
                control_epoch,
                control,
                recorded_at,
                ..
            } => {
                if !matches!(next_target_kind.as_str(), "planAction" | "finalAnswer")
                    || settlement.kind != "planActionComplete"
                    || settlement.provider_turn_id != *predecessor_provider_turn_id
                    || settlement.control_epoch != *control_epoch
                    || settlement.control_call_id != control.call_id
                    || settlement.control_arguments_digest != control.arguments_digest
                    || settlement.recorded_at != *recorded_at
                    || !matches!(
                        settlement.outcome.as_str(),
                        "completed" | "no_op" | "blocked" | "skipped" | "unexecuted"
                    )
                {
                    return Err(invalid_control_settlement());
                }
                for (identity, field) in [
                    (
                        settlement.plan_revision.as_str(),
                        "controlSettlement.settlement.planRevision",
                    ),
                    (
                        settlement.plan_action_id.as_str(),
                        "controlSettlement.settlement.planActionId",
                    ),
                ] {
                    validate_bounded_identity(identity, field, 512)?;
                }
                validate_sha256_digest(
                    &settlement.control_arguments_digest,
                    "controlSettlement.settlement.controlArgumentsDigest",
                )?;
            }
            Self::UserInterventionDecision {
                next_target_kind,
                decision,
                disposition,
                accepted_plan_revision,
                recorded_at,
                ..
            } => {
                let expected_target = match disposition.as_str() {
                    "planAccepted" => "planAction",
                    "guidanceReplan" => "planning",
                    "researchRevision" => "interventionResearch",
                    "runCancellationRequired" => "none",
                    _ => return Err(invalid_control_settlement()),
                };
                if next_target_kind != expected_target
                    || decision.recorded_at != *recorded_at
                    || !matches!(decision.decision.as_str(), "select" | "revise" | "reject")
                    || (disposition == "planAccepted") != accepted_plan_revision.is_some()
                    || decision
                        .guidance
                        .as_ref()
                        .is_some_and(|value| value.trim().is_empty())
                {
                    return Err(invalid_control_settlement());
                }
                for (identity, field) in [
                    (
                        decision.interaction_id.as_str(),
                        "controlSettlement.decision.interactionId",
                    ),
                    (
                        decision.interaction_revision.as_str(),
                        "controlSettlement.decision.interactionRevision",
                    ),
                    (
                        decision.caller_request_id.as_str(),
                        "controlSettlement.decision.callerRequestId",
                    ),
                ] {
                    validate_bounded_identity(identity, field, 512)?;
                }
                validate_sha256_digest(
                    &decision.candidate_set_digest,
                    "controlSettlement.decision.candidateSetDigest",
                )?;
            }
        }
        Ok(())
    }
}

fn validate_control_receipt(
    control: &SessionProviderControlReceiptSidecarV2,
    expected_tool_name: &str,
) -> Result<(), HostV2StorageError> {
    let expected_schema = match expected_tool_name {
        "deepcode_session_plan_propose_v5" => "deepcode.session.plan-proposal.v5",
        "deepcode_session_plan_action_complete_v2" => "deepcode.session.plan-action-complete.v2",
        "deepcode_session_intervention_propose_v1" => "deepcode.session.intervention-proposal.v1",
        _ => return Err(invalid_control_settlement()),
    };
    if control.schema_version != expected_schema || control.tool_name != expected_tool_name {
        return Err(invalid_control_settlement());
    }
    validate_bounded_identity(&control.call_id, "controlSettlement.control.callId", 512)?;
    validate_sha256_digest(
        &control.arguments_digest,
        "controlSettlement.control.argumentsDigest",
    )?;
    Ok(())
}

fn invalid_control_settlement() -> HostV2StorageError {
    HostV2StorageError::invalid(
        "provider_control_settlement_invalid",
        "Session Provider control settlement is not exact durable v2 data",
    )
}

fn validate_control_identity_list(
    values: &[String],
    field: &'static str,
    max_identity_bytes: usize,
) -> Result<(), HostV2StorageError> {
    if values.len() > 128 || values.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(HostV2StorageError::invalid(
            "provider_control_continuation_invalid",
            "Plan evidence refresh identities must be bounded, unique, and sorted",
        ));
    }
    for value in values {
        validate_bounded_identity(value, field, max_identity_bytes)?;
    }
    Ok(())
}

fn validate_control_digest_list(
    values: &[String],
    field: &'static str,
) -> Result<(), HostV2StorageError> {
    if values.len() > 128 || values.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(HostV2StorageError::invalid(
            "provider_control_continuation_invalid",
            "Plan evidence refresh digests must be bounded, unique, and sorted",
        ));
    }
    for value in values {
        validate_sha256_digest(value, field)?;
    }
    Ok(())
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
