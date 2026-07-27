use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::fmt;

const LINEAGE_SCHEMA_V1: &str = "deepcode.session.fact-lineage.v1";
const KERNEL_FACT_REF_SCHEMA_V1: &str = "deepcode.session.kernel-fact-ref.v1";
const PROVIDER_ADMISSION_SCHEMA_V1: &str = "deepcode.session.provider-admission-metadata.v1";
const TURN_AUTHORITY_SCHEMA_V2: &str = "deepcode.session.turn-authority.v2";
const LANGUAGE_POLICY_SCHEMA_V1: &str = "deepcode.session.conversation-language-policy.v1";
const SHARED_PROJECTION_SCHEMA_V2: &str = "deepcode.shared-conversation-projection.v2";
const TURN_KERNEL_EFFECT_TASK_IDS_STAGING_FIELD: &str = "kernelEffectTaskIdsPendingMaterialization";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionFactLineageValidationError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) event_id: Option<String>,
}

impl SessionFactLineageValidationError {
    fn invalid(event_id: Option<&str>, message: impl Into<String>) -> Self {
        Self {
            code: "session_append_lineage_invalid",
            message: message.into(),
            event_id: event_id.map(str::to_owned),
        }
    }

    fn legacy(event_id: &str, kind: &str) -> Self {
        Self {
            code: "session_append_legacy_read_only",
            message: format!(
                "Legacy Session domain event {event_id} ({kind}) has no SessionFactLineage v1."
            ),
            event_id: Some(event_id.to_owned()),
        }
    }
}

impl fmt::Display for SessionFactLineageValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SessionFactLineageValidationError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EventDisposition {
    Authority,
    PersistentDomainFact,
    Excluded,
    NonDomain,
}

#[derive(Debug)]
struct EventView<'a> {
    id: String,
    session_id: String,
    kind: String,
    payload: Option<&'a Map<String, Value>>,
    display: Option<&'a Map<String, Value>>,
}

#[derive(Debug, Clone)]
struct TurnAuthority {
    event_id: String,
    event_index: usize,
    session_id: String,
    run_id: String,
    turn_id: String,
    task_id: String,
    language_revision: u64,
    language: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnAuthorityHashCore<'a> {
    schema_version: &'static str,
    session_id: &'a str,
    run_id: &'a str,
    turn_id: &'a str,
    task_id: &'a str,
    source_message_ids: &'a [&'a str],
    source_message_hashes: &'a [&'a str],
    relation: &'a str,
    bound_at_hook_ref: &'a str,
    language_policy: TurnAuthorityLanguagePolicyHashCore<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_epoch_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_task_id: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnAuthorityLanguagePolicyHashCore<'a> {
    schema_version: &'static str,
    revision: u64,
    source_turn_id: &'a str,
    source_message_ids: &'a [&'a str],
    host_language: &'a str,
    status: &'static str,
}

#[derive(Debug, Clone)]
struct ProviderAdmission {
    request_id: String,
    parent_request_id: Option<String>,
    turn_authority_ref: String,
    language_revision: Option<u64>,
}

#[derive(Debug, Clone)]
enum FactProducer {
    ProviderAdmission {
        provider_request_id: String,
        proposal_id: Option<String>,
    },
    SessionRule {
        rule_id: String,
        source_event_refs: Vec<String>,
    },
}

#[derive(Debug, Clone)]
struct KernelFactRef {
    kernel_event_ref: String,
    kind: String,
    run_id: String,
    identities: Vec<(&'static str, String)>,
}

#[derive(Debug, Clone)]
struct TurnKernelEffectClaim {
    task_id: String,
    operation_ids: Vec<String>,
    work_unit_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct FactLineage {
    turn_authority_ref: String,
    producer: FactProducer,
    domain_parent_refs: Vec<String>,
    kernel_fact_refs: Vec<KernelFactRef>,
}

/// Validate the D-AUTH-01 portion of one canonical Session domain append.
///
/// The function is intentionally pure: it reads only the supplied flattened
/// logical events, command-local Provider admission metadata, and optional
/// Shared Projection. Persistence, append CAS, permission, and Kernel effect
/// decisions remain outside this module.
pub(crate) fn validate_session_fact_lineage_batch(
    session_id: &str,
    existing_events: &[Value],
    incoming_events: &[Value],
    provider_admissions: &[Value],
    timeline: Option<&Value>,
) -> Result<(), SessionFactLineageValidationError> {
    let expected_session_id = required_text(session_id).ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            None,
            "Session lineage validation requires a non-empty session id.",
        )
    })?;
    let values = existing_events
        .iter()
        .chain(incoming_events.iter())
        .collect::<Vec<_>>();
    let events = values
        .iter()
        .enumerate()
        .map(|(index, value)| parse_event(value, index))
        .collect::<Result<Vec<_>, _>>()?;
    let incoming_start = existing_events.len();
    let mut event_indices = HashMap::new();
    for (index, event) in events.iter().enumerate() {
        if event.session_id != expected_session_id {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!(
                    "Session event {} belongs to {}, expected {}.",
                    event.id, event.session_id, expected_session_id
                ),
            ));
        }
        if event_indices.insert(event.id.clone(), index).is_some() {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!("Session event id {} is duplicated.", event.id),
            ));
        }
    }

    let admissions = parse_provider_admissions(provider_admissions)?;
    let mut referenced_provider_admissions = HashSet::new();

    for (index, event) in events.iter().enumerate() {
        let disposition = event_disposition(event);
        let raw_lineage = event.payload.and_then(|payload| payload.get("lineage"));
        if index < incoming_start {
            if disposition == EventDisposition::PersistentDomainFact {
                let Some(value) = raw_lineage else {
                    return Err(SessionFactLineageValidationError::legacy(
                        &event.id,
                        &event.kind,
                    ));
                };
                parse_lineage(value, &event.id)?;
            } else if raw_lineage.is_some() {
                return Err(SessionFactLineageValidationError::invalid(
                    Some(&event.id),
                    format!(
                        "Excluded or non-domain event {} ({}) must not carry SessionFactLineage.",
                        event.id, event.kind
                    ),
                ));
            }
            continue;
        }
        if event.kind == "cache_telemetry" {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!(
                    "Cache telemetry event {} belongs to its auxiliary ledger and cannot advance the canonical Session domain head.",
                    event.id
                ),
            ));
        }

        match disposition {
            EventDisposition::Authority => {
                if raw_lineage.is_some() {
                    return Err(SessionFactLineageValidationError::invalid(
                        Some(&event.id),
                        "session_turn_authority must not carry SessionFactLineage.",
                    ));
                }
                parse_turn_authority(&events, index, event)?;
            }
            EventDisposition::PersistentDomainFact => {
                let raw_lineage = raw_lineage.ok_or_else(|| {
                    SessionFactLineageValidationError::invalid(
                        Some(&event.id),
                        format!(
                            "Persistent Session domain event {} ({}) has no SessionFactLineage v1.",
                            event.id, event.kind
                        ),
                    )
                })?;
                let lineage = parse_lineage(raw_lineage, &event.id)?;
                let authority = resolve_turn_authority(
                    &events,
                    &event_indices,
                    index,
                    &lineage.turn_authority_ref,
                    &event.id,
                )?;
                validate_consumer_authority(event, &authority)?;
                validate_producer(
                    event,
                    &lineage,
                    &authority,
                    &admissions,
                    &mut referenced_provider_admissions,
                )?;
                validate_earlier_domain_parents(
                    &events,
                    index,
                    event,
                    &lineage.turn_authority_ref,
                    &lineage.domain_parent_refs,
                )?;
                validate_session_rule_sources(
                    &events,
                    &event_indices,
                    index,
                    event,
                    &lineage.producer,
                )?;
                validate_kernel_fact_refs(
                    &events,
                    &event_indices,
                    index,
                    event,
                    &authority,
                    &lineage.kernel_fact_refs,
                )?;
                validate_required_kernel_facts(
                    &events,
                    incoming_start,
                    index,
                    event,
                    &authority,
                    &lineage.kernel_fact_refs,
                )?;
            }
            EventDisposition::Excluded | EventDisposition::NonDomain => {
                if raw_lineage.is_some() {
                    return Err(SessionFactLineageValidationError::invalid(
                        Some(&event.id),
                        format!(
                            "Excluded or non-domain event {} ({}) must not carry SessionFactLineage.",
                            event.id, event.kind
                        ),
                    ));
                }
            }
        }
    }

    let mut referenced_or_ancestor_provider_admissions = referenced_provider_admissions.clone();
    let mut pending_ancestors = referenced_provider_admissions
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    while let Some(request_id) = pending_ancestors.pop() {
        let Some(parent_request_id) = admissions
            .get(&request_id)
            .and_then(|admission| admission.parent_request_id.as_ref())
        else {
            continue;
        };
        if admissions.contains_key(parent_request_id)
            && referenced_or_ancestor_provider_admissions.insert(parent_request_id.clone())
        {
            pending_ancestors.push(parent_request_id.clone());
        }
    }
    for request_id in admissions.keys() {
        if !referenced_or_ancestor_provider_admissions.contains(request_id) {
            return Err(SessionFactLineageValidationError::invalid(
                None,
                format!(
                    "Provider admission metadata {request_id} is not referenced by an incoming Session fact."
                ),
            ));
        }
    }

    validate_timeline_parents(
        expected_session_id,
        &events,
        &event_indices,
        incoming_start,
        timeline,
    )
}

/// Bind every incoming Session kernelFactRef to one immutable event in the
/// authoritative Kernel ledger. Structural lineage validation runs first; this
/// second boundary prevents a caller from manufacturing a self-consistent
/// payload.kernelEvent and treating it as Kernel execution evidence.
pub(crate) fn validate_session_kernel_fact_authority(
    session_id: &str,
    existing_events: &[Value],
    incoming_events: &[Value],
    authoritative_ledger_events: &[Value],
) -> Result<(), SessionFactLineageValidationError> {
    let values = existing_events
        .iter()
        .chain(incoming_events.iter())
        .collect::<Vec<_>>();
    let events = values
        .iter()
        .enumerate()
        .map(|(index, value)| parse_event(value, index))
        .collect::<Result<Vec<_>, _>>()?;
    let mut event_indices = HashMap::new();
    for (index, event) in events.iter().enumerate() {
        event_indices.insert(event.id.clone(), index);
    }
    let incoming_start = existing_events.len();
    for (consumer_index, consumer) in events.iter().enumerate().skip(incoming_start) {
        if event_disposition(consumer) != EventDisposition::PersistentDomainFact {
            continue;
        }
        let raw_lineage = consumer
            .payload
            .and_then(|payload| payload.get("lineage"))
            .ok_or_else(|| {
                SessionFactLineageValidationError::invalid(
                    Some(&consumer.id),
                    "Persistent Session fact has no lineage for Kernel authority validation.",
                )
            })?;
        let lineage = parse_lineage(raw_lineage, &consumer.id)?;
        for fact_ref in &lineage.kernel_fact_refs {
            let source_index = earlier_index(
                &event_indices,
                &fact_ref.kernel_event_ref,
                consumer_index,
                &consumer.id,
                "Kernel fact",
            )?;
            let source = &events[source_index];
            let kernel_event = source
                .payload
                .and_then(|payload| payload.get("kernelEvent"))
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    SessionFactLineageValidationError::invalid(
                        Some(&consumer.id),
                        format!(
                            "Kernel fact ref {} has no projected Kernel event.",
                            fact_ref.kernel_event_ref
                        ),
                    )
                })?;
            validate_authoritative_kernel_fact(
                session_id,
                &events[..consumer_index],
                source,
                kernel_event,
                fact_ref,
                authoritative_ledger_events,
                &consumer.id,
            )?;
        }
    }
    Ok(())
}

fn validate_authoritative_kernel_fact(
    session_id: &str,
    earlier_events: &[EventView<'_>],
    source: &EventView<'_>,
    projected: &Map<String, Value>,
    fact_ref: &KernelFactRef,
    authoritative_ledger_events: &[Value],
    consumer_id: &str,
) -> Result<(), SessionFactLineageValidationError> {
    let sequence = projected
        .get("sequence")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            SessionFactLineageValidationError::invalid(
                Some(consumer_id),
                format!(
                    "Projected Kernel fact {} has no positive ledger sequence.",
                    fact_ref.kernel_event_ref
                ),
            )
        })?;
    let projected_identity_count = earlier_events
        .iter()
        .filter(|candidate| {
            candidate
                .payload
                .and_then(|payload| payload.get("kernelEvent"))
                .and_then(Value::as_object)
                .is_some_and(|candidate| {
                    authoritative_kernel_identity_matches(
                        candidate,
                        session_id,
                        &fact_ref.run_id,
                        &fact_ref.kind,
                        sequence,
                    )
                })
        })
        .count();
    if projected_identity_count != 1
        || !authoritative_kernel_identity_matches(
            projected,
            session_id,
            &fact_ref.run_id,
            &fact_ref.kind,
            sequence,
        )
    {
        return Err(SessionFactLineageValidationError::invalid(
            Some(consumer_id),
            format!(
                "Kernel fact {} does not resolve one unique projected Kernel identity.",
                fact_ref.kernel_event_ref
            ),
        ));
    }
    let expected_ledger_id = format!("evt-{}-{sequence}", fact_ref.run_id);
    let matching = authoritative_ledger_events
        .iter()
        .filter_map(Value::as_object)
        .filter(|ledger_event| {
            text_field(ledger_event, "id") == Some(expected_ledger_id.as_str())
                && text_field(ledger_event, "sessionId") == Some(session_id)
                && text_field(ledger_event, "runId") == Some(fact_ref.run_id.as_str())
                && text_field(ledger_event, "kind") == Some(fact_ref.kind.as_str())
                && ledger_event.get("sequence").and_then(Value::as_u64) == Some(sequence)
        })
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return Err(SessionFactLineageValidationError::invalid(
            Some(consumer_id),
            format!(
                "Kernel fact {} does not resolve one authoritative ledger event.",
                fact_ref.kernel_event_ref
            ),
        ));
    }
    let ledger_payload = matching[0]
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            SessionFactLineageValidationError::invalid(
                Some(consumer_id),
                format!(
                    "Authoritative Kernel ledger event for {} has no object payload.",
                    fact_ref.kernel_event_ref
                ),
            )
        })?;
    let projected_material =
        projected_kernel_fact_material(&fact_ref.kind, projected).ok_or_else(|| {
            SessionFactLineageValidationError::invalid(
                Some(consumer_id),
                format!(
                    "Projected Kernel fact {} has no comparable fact material.",
                    fact_ref.kernel_event_ref
                ),
            )
        })?;
    let ledger_material =
        ledger_kernel_fact_material(&fact_ref.kind, ledger_payload).ok_or_else(|| {
            SessionFactLineageValidationError::invalid(
                Some(consumer_id),
                format!(
                    "Authoritative Kernel fact {} has no comparable fact material.",
                    fact_ref.kernel_event_ref
                ),
            )
        })?;
    if projected_material != ledger_material {
        return Err(SessionFactLineageValidationError::invalid(
            Some(consumer_id),
            format!(
                "Projected Kernel fact {} does not match authoritative ledger material.",
                fact_ref.kernel_event_ref
            ),
        ));
    }
    if source.session_id != session_id {
        return Err(SessionFactLineageValidationError::invalid(
            Some(consumer_id),
            format!(
                "Kernel fact {} crosses the Session boundary.",
                fact_ref.kernel_event_ref
            ),
        ));
    }
    Ok(())
}

fn authoritative_kernel_identity_matches(
    kernel_event: &Map<String, Value>,
    session_id: &str,
    run_id: &str,
    kind: &str,
    sequence: u64,
) -> bool {
    text_field(kernel_event, "sessionId") == Some(session_id)
        && text_field(kernel_event, "runId") == Some(run_id)
        && text_field(kernel_event, "kind") == Some(kind)
        && kernel_event.get("sequence").and_then(Value::as_u64) == Some(sequence)
}

fn projected_kernel_fact_material(kind: &str, event: &Map<String, Value>) -> Option<Value> {
    match kind {
        "plan_authorization.decision_recorded" => selected_kernel_material(
            event,
            &["authorizationContractId", "decision", "leaseId"],
        ),
        "tool.execution_attempted"
        | "tool.effect_observed"
        | "tool.outcome_indeterminate"
        | "tool.completed"
        | "resource.cleanup_state_changed" => event.get("fact").cloned(),
        "work_unit.completed" => selected_kernel_material(event, &["workUnitId", "output"]),
        "work_unit.failed" => selected_kernel_material(event, &["workUnitId", "error"]),
        "work_unit.blocked" => selected_kernel_material(event, &["workUnitId", "reason"]),
        "review.facts_produced" => event.get("facts").cloned(),
        "review_gate.evaluated" => event.get("result").cloned(),
        // Kernel cancellation deliberately uses a different presentation
        // summary from its ledger audit summary. Status is the authoritative
        // settlement material; display text must not become an effect claim.
        "run.completed" => selected_kernel_material(event, &["status"]),
        "runtime.lifecycle_changed" => {
            selected_kernel_material(event, &["previousState", "currentState", "reason"])
        }
        _ => None,
    }
}

fn ledger_kernel_fact_material(kind: &str, payload: &Map<String, Value>) -> Option<Value> {
    match kind {
        "plan_authorization.decision_recorded" => selected_kernel_material(
            payload,
            &["authorizationContractId", "decision", "leaseId"],
        ),
        "tool.execution_attempted"
        | "tool.effect_observed"
        | "tool.outcome_indeterminate"
        | "tool.completed" => Some(Value::Object(payload.clone())),
        "resource.cleanup_state_changed" => payload
            .get("fact")
            .cloned()
            .or_else(|| Some(Value::Object(payload.clone()))),
        "work_unit.completed" => selected_kernel_material(payload, &["workUnitId", "output"]),
        "work_unit.failed" => selected_kernel_material(payload, &["workUnitId", "error"]),
        "work_unit.blocked" => selected_kernel_material(payload, &["workUnitId", "reason"]),
        "review.facts_produced" => payload.get("facts").cloned(),
        "review_gate.evaluated" => payload.get("result").cloned(),
        "run.completed" => selected_kernel_material(payload, &["status"]),
        "runtime.lifecycle_changed" => {
            selected_kernel_material(payload, &["previousState", "currentState", "reason"])
        }
        _ => None,
    }
}

fn selected_kernel_material(record: &Map<String, Value>, fields: &[&str]) -> Option<Value> {
    let mut selected = Map::new();
    for field in fields {
        selected.insert((*field).to_string(), record.get(*field)?.clone());
    }
    Some(Value::Object(selected))
}

fn parse_event<'a>(
    value: &'a Value,
    index: usize,
) -> Result<EventView<'a>, SessionFactLineageValidationError> {
    let record = value.as_object().ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            None,
            format!("Session event at index {index} is not an object."),
        )
    })?;
    let id = text_field(record, "id").ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            None,
            format!("Session event at index {index} has no id."),
        )
    })?;
    let session_id = text_field(record, "sessionId").ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(id),
            format!("Session event {id} has no sessionId."),
        )
    })?;
    let kind = text_field(record, "kind").ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(id),
            format!("Session event {id} has no kind."),
        )
    })?;
    Ok(EventView {
        id: id.to_owned(),
        session_id: session_id.to_owned(),
        kind: kind.to_owned(),
        payload: record.get("payload").and_then(Value::as_object),
        display: record.get("display").and_then(Value::as_object),
    })
}

fn event_disposition(event: &EventView<'_>) -> EventDisposition {
    if event.kind == "session_turn_authority" {
        return EventDisposition::Authority;
    }
    if event.kind == "session_goal_fact" {
        return EventDisposition::PersistentDomainFact;
    }
    let payload = event.payload;
    // Terminal run state is a durable outcome fact even though presentation
    // keeps it out of the visible conversation. An initial running state is
    // durable only when the atomic bootstrap supplied explicit lineage.
    if terminal_session_run_state(event) || durable_session_run_bootstrap_fact(event) {
        return EventDisposition::PersistentDomainFact;
    }
    if matches!(
        event.kind.as_str(),
        "permission_request" | "permission_result"
    ) {
        let kernel_kind = payload
            .and_then(|item| item.get("kernelEvent"))
            .and_then(Value::as_object)
            .and_then(|item| text_field(item, "kind"));
        if kernel_kind.is_none()
            || matches!(
                (event.kind.as_str(), kernel_kind),
                ("permission_request", Some("permission.requested"))
                    | ("permission_result", Some("permission.resolved"))
            )
        {
            return EventDisposition::PersistentDomainFact;
        }
        return EventDisposition::Excluded;
    }
    if event.kind == "cache_telemetry"
        || event.kind.starts_with("trace/")
        || payload.and_then(|item| item.get("kernelEvent")).is_some()
        || matches!(
            event.kind.as_str(),
            "workflow_stage" | "workflow_decision" | "tool_call" | "tool_result"
        )
        || payload
            .and_then(|item| text_field(item, "channel"))
            .is_some_and(|channel| channel == "reasoning")
        || payload
            .and_then(|item| item.get("reasoningTrace"))
            .and_then(Value::as_bool)
            == Some(true)
        || payload
            .and_then(|item| text_field(item, "channel"))
            .is_some_and(|channel| {
                channel == "progress"
                    && event.kind != "requirement_decision"
                    && event.kind != "plan_review"
                    && event.kind != "review_summary"
            })
        || payload
            .and_then(|item| text_field(item, "visibility"))
            .is_some_and(|visibility| visibility == "hidden")
        || payload
            .and_then(|item| text_field(item, "presentation"))
            .is_some_and(|presentation| presentation == "traceOnly")
        || event
            .display
            .and_then(|item| text_field(item, "presentation"))
            .is_some_and(|presentation| presentation == "traceOnly")
    {
        return EventDisposition::Excluded;
    }
    if matches!(
        event.kind.as_str(),
        "requirement_confirmation"
            | "requirement_decision"
            | "plan_card"
            | "plan_review"
            | "review_summary"
            | "error"
    ) || (event.kind == "assistant_msg"
        && payload
            .and_then(|item| text_field(item, "channel"))
            .is_some_and(|channel| channel == "final"))
    {
        EventDisposition::PersistentDomainFact
    } else {
        EventDisposition::NonDomain
    }
}

fn terminal_session_run_state(event: &EventView<'_>) -> bool {
    event.kind == "session_run_state"
        && matches!(
            event
                .payload
                .and_then(|payload| text_field(payload, "status")),
            Some("completed" | "failed" | "cancelled" | "waiting")
        )
}

fn durable_session_run_bootstrap_fact(event: &EventView<'_>) -> bool {
    let Some(payload) = event.payload else {
        return false;
    };
    let Some(decision_owner) = payload.get("decisionOwner").and_then(Value::as_object) else {
        return false;
    };
    let run_id = text_field(payload, "runId");
    event.kind == "session_run_state"
        && text_field(payload, "status") == Some("running")
        && text_field(payload, "phase") == Some("context_reading")
        && text_field(payload, "reason") == Some("session")
        && text_field(payload, "decisionKind") == Some("session")
        && text_field(decision_owner, "kind") == Some("session")
        && run_id.is_some()
        && text_field(decision_owner, "runId") == run_id
        && payload.get("lineage").is_some()
}

fn parse_turn_authority(
    events: &[EventView<'_>],
    index: usize,
    event: &EventView<'_>,
) -> Result<TurnAuthority, SessionFactLineageValidationError> {
    let payload = event.payload.ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(&event.id),
            "session_turn_authority payload must be an object.",
        )
    })?;
    if text_field(payload, "schemaVersion") != Some(TURN_AUTHORITY_SCHEMA_V2) {
        return Err(SessionFactLineageValidationError::invalid(
            Some(&event.id),
            "Session fact must reference session_turn_authority v2.",
        ));
    }
    let session_id = required_payload_text(payload, "sessionId", &event.id)?;
    let run_id = required_payload_text(payload, "runId", &event.id)?;
    let turn_id = required_payload_text(payload, "turnId", &event.id)?;
    let task_id = required_payload_text(payload, "taskId", &event.id)?;
    if session_id != event.session_id {
        return Err(SessionFactLineageValidationError::invalid(
            Some(&event.id),
            "session_turn_authority payload sessionId does not match its event.",
        ));
    }
    let relation = text_field(payload, "relation");
    let bound_at_hook_ref = text_field(payload, "boundAtHookRef");
    let authority_hash = text_field(payload, "authorityHash");
    if !matches!(relation, Some("newTask" | "interactionContinuation"))
        || bound_at_hook_ref.is_none()
        || authority_hash.is_none()
    {
        return Err(SessionFactLineageValidationError::invalid(
            Some(&event.id),
            "session_turn_authority v2 has an invalid relation, hook ref, or authority hash.",
        ));
    }
    let source_message_ids = strict_string_array(payload.get("sourceMessageIds"), &event.id)?;
    let source_message_hashes = strict_string_array(payload.get("sourceMessageHashes"), &event.id)?;
    if source_message_ids.is_empty() || source_message_ids.len() != source_message_hashes.len() {
        return Err(SessionFactLineageValidationError::invalid(
            Some(&event.id),
            "session_turn_authority source message ids and hashes are incomplete.",
        ));
    }
    let mut unique_source_ids = HashSet::new();
    if source_message_ids
        .iter()
        .any(|message_id| !unique_source_ids.insert(message_id))
    {
        return Err(SessionFactLineageValidationError::invalid(
            Some(&event.id),
            "session_turn_authority source message ids must be unique.",
        ));
    }
    validate_turn_authority_source_messages(
        events,
        index,
        event,
        &source_message_ids,
        &source_message_hashes,
    )?;
    let language_policy = payload
        .get("languagePolicy")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            SessionFactLineageValidationError::invalid(
                Some(&event.id),
                "session_turn_authority has no ConversationLanguagePolicy v1.",
            )
        })?;
    let host_language = text_field(language_policy, "hostLanguage");
    if text_field(language_policy, "schemaVersion") != Some(LANGUAGE_POLICY_SCHEMA_V1)
        || text_field(language_policy, "sourceTurnId") != Some(turn_id)
        || strict_string_array(language_policy.get("sourceMessageIds"), &event.id)?
            != source_message_ids
        || !matches!(host_language, Some("zh-CN" | "en-US"))
        || text_field(language_policy, "status") != Some("pending")
    {
        return Err(SessionFactLineageValidationError::invalid(
            Some(&event.id),
            "session_turn_authority has an invalid language policy binding.",
        ));
    }
    let language_revision = positive_u64_field(language_policy, "revision").ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(&event.id),
            "session_turn_authority language revision must be positive.",
        )
    })?;
    let language = match text_field(language_policy, "language") {
        Some(value @ ("zh-CN" | "en-US")) => Some(value.to_owned()),
        Some(_) => {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                "session_turn_authority language policy contains an invalid language.",
            ));
        }
        None => None,
    };
    validate_turn_authority_hash(
        payload,
        language_policy,
        &event.id,
        session_id,
        run_id,
        turn_id,
        task_id,
        relation.expect("validated turn-authority relation"),
        bound_at_hook_ref.expect("validated turn-authority hook ref"),
        host_language.expect("validated turn-authority host language"),
        language_revision,
        authority_hash.expect("validated turn-authority hash"),
    )?;
    Ok(TurnAuthority {
        event_id: event.id.clone(),
        event_index: index,
        session_id: session_id.to_owned(),
        run_id: run_id.to_owned(),
        turn_id: turn_id.to_owned(),
        task_id: task_id.to_owned(),
        language_revision,
        language,
    })
}

#[allow(clippy::too_many_arguments)]
fn validate_turn_authority_hash(
    payload: &Map<String, Value>,
    language_policy: &Map<String, Value>,
    event_id: &str,
    session_id: &str,
    run_id: &str,
    turn_id: &str,
    task_id: &str,
    relation: &str,
    bound_at_hook_ref: &str,
    host_language: &str,
    language_revision: u64,
    authority_hash: &str,
) -> Result<(), SessionFactLineageValidationError> {
    let source_message_ids = exact_hash_string_array(
        payload.get("sourceMessageIds"),
        event_id,
        "sourceMessageIds",
    )?;
    let source_message_hashes = exact_hash_string_array(
        payload.get("sourceMessageHashes"),
        event_id,
        "sourceMessageHashes",
    )?;
    let language_source_message_ids = exact_hash_string_array(
        language_policy.get("sourceMessageIds"),
        event_id,
        "languagePolicy.sourceMessageIds",
    )?;
    if language_source_message_ids != source_message_ids {
        return Err(SessionFactLineageValidationError::invalid(
            Some(event_id),
            "session_turn_authority language policy source ids do not exactly match its authority source ids.",
        ));
    }
    let core = TurnAuthorityHashCore {
        schema_version: TURN_AUTHORITY_SCHEMA_V2,
        session_id,
        run_id,
        turn_id,
        task_id,
        source_message_ids: &source_message_ids,
        source_message_hashes: &source_message_hashes,
        relation,
        bound_at_hook_ref,
        language_policy: TurnAuthorityLanguagePolicyHashCore {
            schema_version: LANGUAGE_POLICY_SCHEMA_V1,
            revision: language_revision,
            source_turn_id: turn_id,
            source_message_ids: &language_source_message_ids,
            host_language,
            status: "pending",
        },
        prompt_epoch_id: text_field(payload, "promptEpochId"),
        previous_task_id: text_field(payload, "previousTaskId"),
    };
    let material = serde_json::to_string(&core).map_err(|error| {
        SessionFactLineageValidationError::invalid(
            Some(event_id),
            format!("session_turn_authority hash material cannot be serialized: {error}"),
        )
    })?;
    if stable_text_hash(&material) != authority_hash {
        return Err(SessionFactLineageValidationError::invalid(
            Some(event_id),
            "session_turn_authority authorityHash does not match its v2 authority material.",
        ));
    }
    Ok(())
}

fn exact_hash_string_array<'a>(
    value: Option<&'a Value>,
    event_id: &str,
    field: &str,
) -> Result<Vec<&'a str>, SessionFactLineageValidationError> {
    let values = value.and_then(Value::as_array).ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(event_id),
            format!("session_turn_authority {field} must be an array."),
        )
    })?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    SessionFactLineageValidationError::invalid(
                        Some(event_id),
                        format!("session_turn_authority {field} must contain non-empty strings."),
                    )
                })
        })
        .collect()
}

fn validate_turn_authority_source_messages(
    events: &[EventView<'_>],
    authority_index: usize,
    authority: &EventView<'_>,
    message_ids: &[String],
    message_hashes: &[String],
) -> Result<(), SessionFactLineageValidationError> {
    for (message_id, expected_hash) in message_ids.iter().zip(message_hashes) {
        let matching_sources = events[..authority_index]
            .iter()
            .filter(|candidate| {
                if candidate.session_id != authority.session_id {
                    return false;
                }
                if candidate.kind == "user_msg" {
                    return candidate.id == *message_id;
                }
                if candidate.kind != "user_guidance" {
                    return false;
                }
                candidate
                    .payload
                    .and_then(|payload| text_field(payload, "guidanceId"))
                    .unwrap_or(&candidate.id)
                    == message_id
            })
            .collect::<Vec<_>>();
        if matching_sources.len() != 1 {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&authority.id),
                format!(
                    "Turn authority {} source message {} is missing or ambiguous.",
                    authority.id, message_id
                ),
            ));
        }
        let source = matching_sources[0];
        let content = if source.kind == "user_guidance" {
            source.payload.and_then(|payload| {
                payload
                    .get("content")
                    .and_then(Value::as_str)
                    .or_else(|| payload.get("guidance").and_then(Value::as_str))
            })
        } else {
            source
                .payload
                .and_then(|payload| payload.get("content"))
                .and_then(Value::as_str)
        };
        if content.is_none_or(|value| stable_text_hash(value) != *expected_hash) {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&authority.id),
                format!(
                    "Turn authority {} source message {} is missing or does not match its persisted hash.",
                    authority.id, message_id
                ),
            ));
        }
    }
    Ok(())
}

fn stable_text_hash(value: &str) -> String {
    let mut hash = 2_166_136_261_u32;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(16_777_619);
    }
    format!("fnv1a32:{hash:08x}")
}

fn resolve_turn_authority(
    events: &[EventView<'_>],
    event_indices: &HashMap<String, usize>,
    consumer_index: usize,
    authority_ref: &str,
    consumer_id: &str,
) -> Result<TurnAuthority, SessionFactLineageValidationError> {
    let authority_index = event_indices.get(authority_ref).copied().ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(consumer_id),
            format!("Session fact {consumer_id} references missing authority {authority_ref}."),
        )
    })?;
    if authority_index >= consumer_index {
        return Err(SessionFactLineageValidationError::invalid(
            Some(consumer_id),
            format!("Session fact {consumer_id} references future authority {authority_ref}."),
        ));
    }
    let event = &events[authority_index];
    if event.kind != "session_turn_authority" {
        return Err(SessionFactLineageValidationError::invalid(
            Some(consumer_id),
            format!("Session fact authority ref {authority_ref} is not session_turn_authority."),
        ));
    }
    let authority = parse_turn_authority(events, authority_index, event)?;
    if authority.event_id != authority_ref || authority.event_index != authority_index {
        return Err(SessionFactLineageValidationError::invalid(
            Some(consumer_id),
            "Resolved turn authority identity is inconsistent.",
        ));
    }
    Ok(authority)
}

fn parse_lineage(
    value: &Value,
    event_id: &str,
) -> Result<FactLineage, SessionFactLineageValidationError> {
    let record = value.as_object().ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(event_id),
            "Session fact lineage must be an object.",
        )
    })?;
    if text_field(record, "schemaVersion") != Some(LINEAGE_SCHEMA_V1) {
        return Err(SessionFactLineageValidationError::invalid(
            Some(event_id),
            "Session fact lineage must use deepcode.session.fact-lineage.v1.",
        ));
    }
    let turn_authority_ref =
        required_payload_text(record, "turnAuthorityRef", event_id)?.to_owned();
    let domain_parent_refs =
        strict_unique_refs(record.get("domainParentRefs"), event_id, "domain parent")?;
    let kernel_fact_values = record
        .get("kernelFactRefs")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            SessionFactLineageValidationError::invalid(
                Some(event_id),
                "Session fact lineage kernelFactRefs must be an array.",
            )
        })?;
    let mut kernel_fact_refs = Vec::with_capacity(kernel_fact_values.len());
    let mut kernel_event_refs = HashSet::new();
    for value in kernel_fact_values {
        let fact_ref = parse_kernel_fact_ref(value, event_id)?;
        if !kernel_event_refs.insert(fact_ref.kernel_event_ref.clone()) {
            return Err(SessionFactLineageValidationError::invalid(
                Some(event_id),
                "Session fact lineage contains duplicate Kernel event refs.",
            ));
        }
        kernel_fact_refs.push(fact_ref);
    }
    let producer_record = record
        .get("producer")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            SessionFactLineageValidationError::invalid(
                Some(event_id),
                "Session fact lineage producer must be an object.",
            )
        })?;
    let producer = match text_field(producer_record, "kind") {
        Some("providerAdmission") => FactProducer::ProviderAdmission {
            provider_request_id: required_payload_text(
                producer_record,
                "providerRequestId",
                event_id,
            )?
            .to_owned(),
            proposal_id: optional_text_field(producer_record, "proposalId", event_id)?,
        },
        Some("sessionRule") => FactProducer::SessionRule {
            rule_id: required_payload_text(producer_record, "ruleId", event_id)?.to_owned(),
            source_event_refs: strict_unique_refs(
                producer_record.get("sourceEventRefs"),
                event_id,
                "Session rule source",
            )?,
        },
        _ => {
            return Err(SessionFactLineageValidationError::invalid(
                Some(event_id),
                "Session fact lineage has an unknown producer kind.",
            ));
        }
    };
    if matches!(
        &producer,
        FactProducer::SessionRule {
            source_event_refs,
            ..
        } if source_event_refs.is_empty()
    ) {
        return Err(SessionFactLineageValidationError::invalid(
            Some(event_id),
            "Session rule lineage requires at least one immutable source event ref.",
        ));
    }
    Ok(FactLineage {
        turn_authority_ref,
        producer,
        domain_parent_refs,
        kernel_fact_refs,
    })
}

fn parse_provider_admissions(
    values: &[Value],
) -> Result<HashMap<String, ProviderAdmission>, SessionFactLineageValidationError> {
    let mut admissions = HashMap::new();
    for (index, value) in values.iter().enumerate() {
        let record = value.as_object().ok_or_else(|| {
            SessionFactLineageValidationError::invalid(
                None,
                format!("Provider admission metadata at index {index} is not an object."),
            )
        })?;
        if text_field(record, "schemaVersion") != Some(PROVIDER_ADMISSION_SCHEMA_V1) {
            return Err(SessionFactLineageValidationError::invalid(
                None,
                "Provider admission metadata has an invalid schema version.",
            ));
        }
        let request_id = required_payload_text(record, "requestId", "provider-admission")?;
        let turn_authority_ref =
            required_payload_text(record, "turnAuthorityRef", "provider-admission")?;
        if !matches!(
            text_field(record, "attemptKind"),
            Some("primary" | "resume" | "repair" | "emptyRetry" | "streamFallback" | "review")
        ) || text_field(record, "stage").is_none()
            || text_field(record, "providerPayloadDigest").is_none()
            || text_field(record, "transportDigest").is_none()
        {
            return Err(SessionFactLineageValidationError::invalid(
                None,
                format!("Provider admission metadata {request_id} is incomplete."),
            ));
        }
        let language_revision = match record.get("languageRevision") {
            Some(_) => Some(
                positive_u64_field(record, "languageRevision").ok_or_else(|| {
                    SessionFactLineageValidationError::invalid(
                        None,
                        format!(
                        "Provider admission metadata {request_id} has an invalid language revision."
                    ),
                    )
                })?,
            ),
            None => None,
        };
        let parent_request_id = optional_text_field(record, "parentRequestId", request_id)?;
        if parent_request_id.as_deref() == Some(request_id) {
            return Err(SessionFactLineageValidationError::invalid(
                None,
                format!("Provider admission {request_id} cannot parent itself."),
            ));
        }
        if admissions
            .insert(
                request_id.to_owned(),
                ProviderAdmission {
                    request_id: request_id.to_owned(),
                    parent_request_id,
                    turn_authority_ref: turn_authority_ref.to_owned(),
                    language_revision,
                },
            )
            .is_some()
        {
            return Err(SessionFactLineageValidationError::invalid(
                None,
                format!("Provider admission request id {request_id} is duplicated."),
            ));
        }
    }
    Ok(admissions)
}

fn validate_consumer_authority(
    event: &EventView<'_>,
    authority: &TurnAuthority,
) -> Result<(), SessionFactLineageValidationError> {
    if event.session_id != authority.session_id {
        return Err(authority_mismatch(
            event,
            "sessionId",
            &event.session_id,
            &authority.session_id,
        ));
    }
    let payload = event.payload.ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(&event.id),
            "Persistent Session fact payload must be an object.",
        )
    })?;
    for (field, expected) in [
        ("runId", authority.run_id.as_str()),
        ("turnId", authority.turn_id.as_str()),
        ("sourceTurnId", authority.turn_id.as_str()),
        ("taskId", authority.task_id.as_str()),
    ] {
        if let Some(actual) = text_field(payload, field) {
            if actual != expected {
                return Err(authority_mismatch(event, field, actual, expected));
            }
        } else if payload.get(field).is_some() {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!("Session fact {} has an invalid {field}.", event.id),
            ));
        }
    }
    if let Some(value) = payload.get("languageRevision") {
        let revision = value.as_u64().filter(|value| *value > 0).ok_or_else(|| {
            SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!("Session fact {} has an invalid languageRevision.", event.id),
            )
        })?;
        if revision != authority.language_revision {
            return Err(authority_mismatch(
                event,
                "languageRevision",
                &revision.to_string(),
                &authority.language_revision.to_string(),
            ));
        }
    }
    if let Some(expected_language) = authority.language.as_deref() {
        for field in ["responseLanguage", "presentationLanguage"] {
            if let Some(actual) = text_field(payload, field) {
                if !matches!(actual, "zh-CN" | "en-US") || actual != expected_language {
                    return Err(authority_mismatch(event, field, actual, expected_language));
                }
            } else if payload.get(field).is_some() {
                return Err(SessionFactLineageValidationError::invalid(
                    Some(&event.id),
                    format!("Session fact {} has an invalid {field}.", event.id),
                ));
            }
        }
    }
    Ok(())
}

fn validate_producer(
    event: &EventView<'_>,
    lineage: &FactLineage,
    authority: &TurnAuthority,
    admissions: &HashMap<String, ProviderAdmission>,
    referenced_admissions: &mut HashSet<String>,
) -> Result<(), SessionFactLineageValidationError> {
    match &lineage.producer {
        FactProducer::ProviderAdmission {
            provider_request_id,
            proposal_id,
        } => {
            let admission = admissions.get(provider_request_id).ok_or_else(|| {
                SessionFactLineageValidationError::invalid(
                    Some(&event.id),
                    format!(
                        "Session fact {} has no matching Provider admission {}.",
                        event.id, provider_request_id
                    ),
                )
            })?;
            if admission.request_id != *provider_request_id
                || admission.turn_authority_ref != lineage.turn_authority_ref
                || admission
                    .language_revision
                    .is_some_and(|revision| revision != authority.language_revision)
            {
                return Err(SessionFactLineageValidationError::invalid(
                    Some(&event.id),
                    format!(
                        "Session fact {} Provider admission does not match its turn authority.",
                        event.id
                    ),
                ));
            }
            let payload_proposal_id = event
                .payload
                .and_then(|payload| text_field(payload, "proposalId"))
                .map(str::to_owned);
            if proposal_id != &payload_proposal_id {
                return Err(SessionFactLineageValidationError::invalid(
                    Some(&event.id),
                    format!(
                        "Session fact {} proposal identity does not match its Provider producer.",
                        event.id
                    ),
                ));
            }
            referenced_admissions.insert(provider_request_id.clone());
        }
        FactProducer::SessionRule {
            rule_id,
            source_event_refs,
        } => {
            if required_text(rule_id).is_none()
                || source_event_refs.is_empty()
                || source_event_refs.iter().any(|item| item == &event.id)
            {
                return Err(SessionFactLineageValidationError::invalid(
                    Some(&event.id),
                    format!(
                        "Session rule producer for {} has no stable rule or earlier sources.",
                        event.id
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn validate_earlier_domain_parents(
    events: &[EventView<'_>],
    consumer_index: usize,
    consumer: &EventView<'_>,
    consumer_authority_ref: &str,
    refs: &[String],
) -> Result<(), SessionFactLineageValidationError> {
    let mut expected_parent = None;
    for source in events[..consumer_index].iter().rev() {
        if source.session_id != consumer.session_id
            || event_disposition(source) != EventDisposition::PersistentDomainFact
        {
            continue;
        }
        let raw_lineage = source
            .payload
            .and_then(|payload| payload.get("lineage"))
            .ok_or_else(|| SessionFactLineageValidationError::legacy(&source.id, &source.kind))?;
        let source_lineage = parse_lineage(raw_lineage, &source.id)?;
        if source_lineage.turn_authority_ref == consumer_authority_ref {
            expected_parent = Some(source.id.as_str());
            break;
        }
    }
    let exact = match expected_parent {
        Some(expected) => refs.len() == 1 && refs[0] == expected,
        None => refs.is_empty(),
    };
    if exact {
        return Ok(());
    }
    Err(SessionFactLineageValidationError::invalid(
        Some(&consumer.id),
        format!(
            "Session fact {} must reference the latest earlier same-authority domain fact{}.",
            consumer.id,
            expected_parent
                .map(|value| format!(" {value}"))
                .unwrap_or_default()
        ),
    ))
}

fn validate_session_rule_sources(
    events: &[EventView<'_>],
    event_indices: &HashMap<String, usize>,
    consumer_index: usize,
    consumer: &EventView<'_>,
    producer: &FactProducer,
) -> Result<(), SessionFactLineageValidationError> {
    let FactProducer::SessionRule {
        source_event_refs, ..
    } = producer
    else {
        return Ok(());
    };
    for reference in source_event_refs {
        let source_index = earlier_index(
            event_indices,
            reference,
            consumer_index,
            &consumer.id,
            "Session rule source",
        )?;
        if events[source_index].session_id != consumer.session_id {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&consumer.id),
                format!(
                    "Session rule source {} crosses the Session boundary.",
                    reference
                ),
            ));
        }
    }
    Ok(())
}

fn validate_kernel_fact_refs(
    events: &[EventView<'_>],
    event_indices: &HashMap<String, usize>,
    consumer_index: usize,
    consumer: &EventView<'_>,
    authority: &TurnAuthority,
    refs: &[KernelFactRef],
) -> Result<(), SessionFactLineageValidationError> {
    for fact_ref in refs {
        let source_index = earlier_index(
            event_indices,
            &fact_ref.kernel_event_ref,
            consumer_index,
            &consumer.id,
            "Kernel fact",
        )?;
        let source = &events[source_index];
        let kernel_event = source
            .payload
            .and_then(|payload| payload.get("kernelEvent"))
            .and_then(Value::as_object)
            .ok_or_else(|| {
                SessionFactLineageValidationError::invalid(
                    Some(&consumer.id),
                    format!(
                        "Kernel fact ref {} does not resolve to payload.kernelEvent.",
                        fact_ref.kernel_event_ref
                    ),
                )
            })?;
        if source.session_id != consumer.session_id
            || text_field(kernel_event, "kind") != Some(fact_ref.kind.as_str())
            || fact_ref.run_id != authority.run_id
            || text_field(kernel_event, "sessionId")
                .is_some_and(|value| value != consumer.session_id)
            || text_field(kernel_event, "runId").is_some_and(|value| value != fact_ref.run_id)
        {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&consumer.id),
                format!(
                    "Session fact {} has a mismatched Kernel fact ref {}.",
                    consumer.id, fact_ref.kernel_event_ref
                ),
            ));
        }
        for (field, expected) in &fact_ref.identities {
            let actual = kernel_identity(kernel_event, field).ok_or_else(|| {
                SessionFactLineageValidationError::invalid(
                    Some(&consumer.id),
                    format!(
                        "Kernel fact {} has no referenced identity {}.",
                        fact_ref.kernel_event_ref, field
                    ),
                )
            })?;
            if actual != expected {
                return Err(SessionFactLineageValidationError::invalid(
                    Some(&consumer.id),
                    format!(
                        "Kernel fact {} identity {} does not match its Session ref.",
                        fact_ref.kernel_event_ref, field
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn validate_required_kernel_facts(
    events: &[EventView<'_>],
    incoming_start: usize,
    event_index: usize,
    event: &EventView<'_>,
    authority: &TurnAuthority,
    refs: &[KernelFactRef],
) -> Result<(), SessionFactLineageValidationError> {
    let Some(payload) = event.payload else {
        return Ok(());
    };
    if payload
        .get(TURN_KERNEL_EFFECT_TASK_IDS_STAGING_FIELD)
        .is_some()
    {
        return Err(SessionFactLineageValidationError::invalid(
            Some(&event.id),
            format!(
                "Session fact {} contains unmaterialized Kernel effect staging.",
                event.id
            ),
        ));
    }
    let final_assistant =
        event.kind == "assistant_msg" && text_field(payload, "channel") == Some("final");
    let waiting_review = event.kind == "review_summary"
        && text_field(payload, "status") == Some("waitingUserReview");
    let review_evidence = waiting_review
        && (payload.get("requiresKernelFacts").is_some()
            || payload.get("kernelEffectClaims").is_some());
    if !final_assistant && !review_evidence {
        return Ok(());
    }
    let claims = parse_turn_kernel_effect_claims(payload, &event.id)?;
    let Some(value) = payload.get("requiresKernelFacts") else {
        if claims.is_empty() && refs.is_empty() {
            return Ok(());
        }
        return Err(SessionFactLineageValidationError::invalid(
            Some(&event.id),
            format!(
                "Turn execution evidence fact {} has Kernel fact refs or effect claims without requiresKernelFacts.",
                event.id
            ),
        ));
    };
    let required = value.as_bool().ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(&event.id),
            format!(
                "Turn execution evidence fact {} requiresKernelFacts must be boolean.",
                event.id
            ),
        )
    })?;
    if !required && !claims.is_empty() {
        return Err(SessionFactLineageValidationError::invalid(
            Some(&event.id),
            format!(
                "Turn execution evidence fact {} has Kernel effect claims without requiring Kernel facts.",
                event.id
            ),
        ));
    }
    if required && claims.is_empty() {
        return Err(SessionFactLineageValidationError::invalid(
            Some(&event.id),
            format!(
                "Turn execution evidence fact {} requires exact per-task Kernel effect claims.",
                event.id
            ),
        ));
    }
    if review_evidence && !required {
        return Err(SessionFactLineageValidationError::invalid(
            Some(&event.id),
            format!(
                "Waiting review execution evidence fact {} must require exact Kernel facts.",
                event.id
            ),
        ));
    }
    if !required {
        if !refs.is_empty() {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!(
                    "Turn execution evidence fact {} has unclaimed Kernel facts.",
                    event.id
                ),
            ));
        }
        return Ok(());
    }

    validate_turn_effect_claim_checkpoints(
        events,
        incoming_start,
        event_index,
        event,
        authority,
        &claims,
    )?;

    let claimed_operation_ids = claims
        .iter()
        .flat_map(|claim| claim.operation_ids.iter())
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let claimed_work_unit_ids = claims
        .iter()
        .flat_map(|claim| claim.work_unit_ids.iter())
        .map(String::as_str)
        .collect::<HashSet<_>>();
    for reference in refs {
        let operation_id = kernel_fact_ref_identity(reference, "operationId");
        let work_unit_id = kernel_fact_ref_identity(reference, "workUnitId");
        if !terminal_or_effect_fact_kind(&reference.kind)
            || !operation_id.is_some_and(|value| claimed_operation_ids.contains(value))
                && !work_unit_id.is_some_and(|value| claimed_work_unit_ids.contains(value))
        {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!(
                    "Turn execution evidence fact {} contains a Kernel ref outside its exact effect claims.",
                    event.id
                ),
            ));
        }
    }
    for claim in &claims {
        let missing_operations = claim
            .operation_ids
            .iter()
            .filter(|operation_id| {
                !refs.iter().any(|reference| {
                    terminal_or_effect_fact_kind(&reference.kind)
                        && kernel_fact_ref_identity(reference, "operationId")
                            == Some(operation_id.as_str())
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        let missing_work_units = claim
            .work_unit_ids
            .iter()
            .filter(|work_unit_id| {
                !refs.iter().any(|reference| {
                    terminal_or_effect_fact_kind(&reference.kind)
                        && kernel_fact_ref_identity(reference, "workUnitId")
                            == Some(work_unit_id.as_str())
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        if !missing_operations.is_empty() || !missing_work_units.is_empty() {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!(
                    "Turn execution evidence fact {} is missing exact Kernel terminal/effect refs for task {}: operations={} workUnits={}.",
                    event.id,
                    claim.task_id,
                    if missing_operations.is_empty() {
                        "none".to_string()
                    } else {
                        missing_operations.join(",")
                    },
                    if missing_work_units.is_empty() {
                        "none".to_string()
                    } else {
                        missing_work_units.join(",")
                    },
                ),
            ));
        }
    }
    Ok(())
}

fn validate_turn_effect_claim_checkpoints(
    events: &[EventView<'_>],
    incoming_start: usize,
    event_index: usize,
    event: &EventView<'_>,
    authority: &TurnAuthority,
    claims: &[TurnKernelEffectClaim],
) -> Result<(), SessionFactLineageValidationError> {
    let claimed_task_ids = claims
        .iter()
        .map(|claim| claim.task_id.as_str())
        .collect::<HashSet<_>>();
    let mut durable_work_units_by_task: HashMap<String, (String, Vec<String>)> = HashMap::new();

    // Only the prefix that was already durable before this append may settle a
    // turn effect claim. A checkpoint placed beside the consuming fact in the
    // same uncommitted batch is not prior durable evidence.
    for (checkpoint_index, checkpoint) in events
        .iter()
        .take(incoming_start.min(event_index))
        .enumerate()
    {
        if checkpoint.kind != "workflow_stage" {
            continue;
        }
        let Some(payload) = checkpoint.payload else {
            continue;
        };
        let Some(stage @ ("accepted_plan.batch_checkpoint" | "accepted_plan.task_savepoint")) =
            text_field(payload, "stage")
        else {
            continue;
        };
        let checkpoint_authority =
            checkpoint_turn_authority(events, checkpoint_index, checkpoint, payload)?;
        if text_field(payload, "runId") != Some(checkpoint_authority.run_id.as_str()) {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!(
                    "Accepted-plan checkpoint {} runId does not match its turn authority.",
                    checkpoint.id
                ),
            ));
        }
        if checkpoint_authority.event_id != authority.event_id {
            continue;
        }
        if checkpoint_authority.run_id != authority.run_id {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!(
                    "Accepted-plan checkpoint {} runId does not match the final turn authority.",
                    checkpoint.id
                ),
            ));
        }

        let completed_task_ids = strict_effect_checkpoint_identities(
            payload.get("newlyCompletedTaskIds"),
            &checkpoint.id,
            "newlyCompletedTaskIds",
        )?;
        let relevant_task_ids = completed_task_ids
            .iter()
            .filter(|task_id| claimed_task_ids.contains(task_id.as_str()))
            .collect::<Vec<_>>();
        if relevant_task_ids.is_empty() {
            continue;
        }
        if completed_task_ids.len() != 1 {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!(
                    "Accepted-plan checkpoint {} must settle exactly one claimed task.",
                    checkpoint.id
                ),
            ));
        }
        match (stage, text_field(payload, "status")) {
            ("accepted_plan.batch_checkpoint", Some("completed"))
            | ("accepted_plan.task_savepoint", Some("completed" | "running")) => {}
            _ => {
                return Err(SessionFactLineageValidationError::invalid(
                    Some(&event.id),
                    format!(
                        "Accepted-plan checkpoint {} has no valid settled status for a Kernel effect claim.",
                        checkpoint.id
                    ),
                ));
            }
        }

        let task_id = completed_task_ids[0].clone();
        let mut work_unit_ids = strict_effect_checkpoint_identities(
            payload.get("workUnitIds"),
            &checkpoint.id,
            "workUnitIds",
        )?;
        if work_unit_ids.is_empty() {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!(
                    "Accepted-plan checkpoint {} has no exact work units for task {}.",
                    checkpoint.id, task_id
                ),
            ));
        }
        work_unit_ids.sort();
        if let Some((prior_checkpoint_id, prior_work_unit_ids)) =
            durable_work_units_by_task.get(&task_id)
        {
            if prior_work_unit_ids != &work_unit_ids {
                return Err(SessionFactLineageValidationError::invalid(
                    Some(&event.id),
                    format!(
                        "Accepted-plan checkpoints {} and {} disagree on exact work units for task {}.",
                        prior_checkpoint_id, checkpoint.id, task_id
                    ),
                ));
            }
            continue;
        }
        durable_work_units_by_task.insert(task_id, (checkpoint.id.clone(), work_unit_ids));
    }

    for claim in claims {
        let Some((checkpoint_id, checkpoint_work_unit_ids)) =
            durable_work_units_by_task.get(&claim.task_id)
        else {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!(
                    "Turn execution evidence fact {} has no earlier durable same-authority accepted-plan checkpoint for task {}.",
                    event.id, claim.task_id
                ),
            ));
        };
        let mut claimed_work_unit_ids = claim.work_unit_ids.clone();
        claimed_work_unit_ids.sort();
        if claimed_work_unit_ids.is_empty() || &claimed_work_unit_ids != checkpoint_work_unit_ids {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&event.id),
                format!(
                    "Turn execution evidence fact {} work units for task {} do not exactly match checkpoint {}.",
                    event.id, claim.task_id, checkpoint_id
                ),
            ));
        }
    }
    Ok(())
}

fn checkpoint_turn_authority(
    events: &[EventView<'_>],
    checkpoint_index: usize,
    checkpoint: &EventView<'_>,
    payload: &Map<String, Value>,
) -> Result<TurnAuthority, SessionFactLineageValidationError> {
    let explicit_authority_ref = payload.get("turnAuthorityRef").or_else(|| {
        payload
            .get("lineage")
            .and_then(Value::as_object)
            .and_then(|lineage| lineage.get("turnAuthorityRef"))
    });
    if let Some(value) = explicit_authority_ref {
        let authority_ref = required_text_value(value).ok_or_else(|| {
            SessionFactLineageValidationError::invalid(
                Some(&checkpoint.id),
                format!(
                    "Accepted-plan checkpoint {} has an invalid turnAuthorityRef.",
                    checkpoint.id
                ),
            )
        })?;
        let (authority_index, authority_event) = events[..checkpoint_index]
            .iter()
            .enumerate()
            .find(|(_, event)| event.id == authority_ref)
            .ok_or_else(|| {
                SessionFactLineageValidationError::invalid(
                    Some(&checkpoint.id),
                    format!(
                        "Accepted-plan checkpoint {} references missing or future turn authority {}.",
                        checkpoint.id, authority_ref
                    ),
                )
            })?;
        if authority_event.kind != "session_turn_authority" {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&checkpoint.id),
                format!(
                    "Accepted-plan checkpoint {} turnAuthorityRef {} is not session_turn_authority.",
                    checkpoint.id, authority_ref
                ),
            ));
        }
        return parse_turn_authority(events, authority_index, authority_event);
    }
    let run_id = text_field(payload, "runId").ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(&checkpoint.id),
            format!(
                "Accepted-plan checkpoint {} has no runId for deterministic authority reconstruction.",
                checkpoint.id
            ),
        )
    })?;
    latest_turn_authority_for_run(events, checkpoint_index, run_id, checkpoint)
}

fn latest_turn_authority_for_run(
    events: &[EventView<'_>],
    checkpoint_index: usize,
    run_id: &str,
    checkpoint: &EventView<'_>,
) -> Result<TurnAuthority, SessionFactLineageValidationError> {
    for (authority_index, candidate) in events[..checkpoint_index].iter().enumerate().rev() {
        if candidate.kind != "session_turn_authority"
            || candidate
                .payload
                .and_then(|payload| text_field(payload, "runId"))
                != Some(run_id)
        {
            continue;
        }
        return parse_turn_authority(events, authority_index, candidate);
    }
    Err(SessionFactLineageValidationError::invalid(
        Some(&checkpoint.id),
        format!(
            "Accepted-plan checkpoint {} has no earlier turn authority for run {}.",
            checkpoint.id, run_id
        ),
    ))
}

fn strict_effect_checkpoint_identities(
    value: Option<&Value>,
    checkpoint_id: &str,
    field: &str,
) -> Result<Vec<String>, SessionFactLineageValidationError> {
    let values = value.and_then(Value::as_array).ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(checkpoint_id),
            format!("Accepted-plan checkpoint {checkpoint_id} {field} must be an array."),
        )
    })?;
    let identities = values
        .iter()
        .map(|value| {
            required_text_value(value)
                .map(str::to_owned)
                .ok_or_else(|| {
                    SessionFactLineageValidationError::invalid(
                        Some(checkpoint_id),
                        format!(
                            "Accepted-plan checkpoint {checkpoint_id} {field} must contain non-empty strings."
                        ),
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut seen = HashSet::new();
    if identities
        .iter()
        .any(|identity| !seen.insert(identity.clone()))
    {
        return Err(SessionFactLineageValidationError::invalid(
            Some(checkpoint_id),
            format!("Accepted-plan checkpoint {checkpoint_id} has duplicated {field}."),
        ));
    }
    Ok(identities)
}

fn parse_turn_kernel_effect_claims(
    payload: &Map<String, Value>,
    event_id: &str,
) -> Result<Vec<TurnKernelEffectClaim>, SessionFactLineageValidationError> {
    let Some(value) = payload.get("kernelEffectClaims") else {
        return Ok(Vec::new());
    };
    let values = value.as_array().ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(event_id),
            format!("Turn execution evidence fact {event_id} kernelEffectClaims must be an array."),
        )
    })?;
    let mut task_ids = HashSet::new();
    let mut operation_ids = HashSet::new();
    let mut work_unit_ids = HashSet::new();
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let record = value.as_object().ok_or_else(|| {
                SessionFactLineageValidationError::invalid(
                    Some(event_id),
                    format!(
                        "Turn execution evidence fact {event_id} has an invalid Kernel effect claim at index {index}."
                    ),
                )
            })?;
            let task_id = required_payload_text(record, "taskId", event_id)?.to_owned();
            let claim_operation_ids =
                strict_effect_identity_array(record.get("operationIds"), event_id)?;
            let claim_work_unit_ids =
                strict_effect_identity_array(record.get("workUnitIds"), event_id)?;
            if claim_operation_ids.is_empty() && claim_work_unit_ids.is_empty() {
                return Err(SessionFactLineageValidationError::invalid(
                    Some(event_id),
                    format!(
                        "Turn execution evidence fact {event_id} has an empty Kernel effect claim at index {index}."
                    ),
                ));
            }
            if !task_ids.insert(task_id.clone())
                || claim_operation_ids
                    .iter()
                    .any(|operation_id| !operation_ids.insert(operation_id.clone()))
                || claim_work_unit_ids
                    .iter()
                    .any(|work_unit_id| !work_unit_ids.insert(work_unit_id.clone()))
            {
                return Err(SessionFactLineageValidationError::invalid(
                    Some(event_id),
                    format!(
                        "Turn execution evidence fact {event_id} has duplicated Kernel effect claim identities."
                    ),
                ));
            }
            Ok(TurnKernelEffectClaim {
                task_id,
                operation_ids: claim_operation_ids,
                work_unit_ids: claim_work_unit_ids,
            })
        })
        .collect()
}

fn strict_effect_identity_array(
    value: Option<&Value>,
    event_id: &str,
) -> Result<Vec<String>, SessionFactLineageValidationError> {
    let values = value.and_then(Value::as_array).ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(event_id),
            format!("Turn execution evidence fact {event_id} effect identities must be arrays."),
        )
    })?;
    let identities = values
        .iter()
        .map(|value| {
            required_text_value(value)
                .map(str::to_owned)
                .ok_or_else(|| {
                    SessionFactLineageValidationError::invalid(
                        Some(event_id),
                        format!(
                            "Turn execution evidence fact {event_id} effect identities must be non-empty strings."
                        ),
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut seen = HashSet::new();
    if identities
        .iter()
        .any(|identity| !seen.insert(identity.clone()))
    {
        return Err(SessionFactLineageValidationError::invalid(
            Some(event_id),
            format!("Turn execution evidence fact {event_id} has duplicated effect identities."),
        ));
    }
    Ok(identities)
}

fn kernel_fact_ref_identity<'a>(reference: &'a KernelFactRef, field: &str) -> Option<&'a str> {
    reference
        .identities
        .iter()
        .find_map(|(identity_field, value)| (*identity_field == field).then_some(value.as_str()))
}

fn parse_kernel_fact_ref(
    value: &Value,
    event_id: &str,
) -> Result<KernelFactRef, SessionFactLineageValidationError> {
    let record = value.as_object().ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(event_id),
            "Kernel fact ref must be an object.",
        )
    })?;
    if text_field(record, "schemaVersion") != Some(KERNEL_FACT_REF_SCHEMA_V1) {
        return Err(SessionFactLineageValidationError::invalid(
            Some(event_id),
            "Kernel fact ref has an invalid schema version.",
        ));
    }
    let kind = required_payload_text(record, "kind", event_id)?;
    if !supported_kernel_fact_kind(kind) {
        return Err(SessionFactLineageValidationError::invalid(
            Some(event_id),
            format!("Kernel fact ref uses unsupported kind {kind}."),
        ));
    }
    let mut identities = Vec::new();
    for field in [
        "factId",
        "planActionId",
        "capabilityGrantId",
        "authorizationContractId",
        "operationId",
        "workUnitId",
    ] {
        if let Some(value) = optional_text_field(record, field, event_id)? {
            identities.push((field, value));
        }
    }
    Ok(KernelFactRef {
        kernel_event_ref: required_payload_text(record, "kernelEventRef", event_id)?.to_owned(),
        kind: kind.to_owned(),
        run_id: required_payload_text(record, "runId", event_id)?.to_owned(),
        identities,
    })
}

fn validate_timeline_parents(
    session_id: &str,
    events: &[EventView<'_>],
    event_indices: &HashMap<String, usize>,
    incoming_start: usize,
    timeline: Option<&Value>,
) -> Result<(), SessionFactLineageValidationError> {
    let consumers = events
        .iter()
        .enumerate()
        .skip(incoming_start)
        .filter(|(_, event)| {
            event_disposition(event) == EventDisposition::PersistentDomainFact
                && requires_timeline_parent(event)
        })
        .collect::<Vec<_>>();
    if consumers.is_empty() {
        return Ok(());
    }
    let timeline = timeline.and_then(Value::as_object).ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            None,
            "User-visible Session facts require Shared Projection v2.",
        )
    })?;
    if text_field(timeline, "schemaVersion") != Some(SHARED_PROJECTION_SCHEMA_V2)
        || text_field(timeline, "sessionId") != Some(session_id)
    {
        return Err(SessionFactLineageValidationError::invalid(
            None,
            "User-visible Session facts require a matching Shared Projection v2.",
        ));
    }
    let turns = timeline
        .get("turns")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            SessionFactLineageValidationError::invalid(
                None,
                "Shared Projection v2 turns must be an array.",
            )
        })?;
    for (consumer_index, consumer) in consumers {
        let lineage = parse_lineage(
            consumer
                .payload
                .and_then(|payload| payload.get("lineage"))
                .ok_or_else(|| {
                    SessionFactLineageValidationError::invalid(
                        Some(&consumer.id),
                        "Timeline consumer has no lineage.",
                    )
                })?,
            &consumer.id,
        )?;
        let authority = resolve_turn_authority(
            events,
            event_indices,
            consumer_index,
            &lineage.turn_authority_ref,
            &consumer.id,
        )?;
        let mut matching_turns = Vec::new();
        for turn in turns {
            let Some(turn_record) = turn.as_object() else {
                return Err(SessionFactLineageValidationError::invalid(
                    Some(&consumer.id),
                    "Shared Projection v2 contains a non-object turn.",
                ));
            };
            let turn_id = text_field(turn_record, "id").ok_or_else(|| {
                SessionFactLineageValidationError::invalid(
                    Some(&consumer.id),
                    "Shared Projection v2 turn has no id.",
                )
            })?;
            let blocks = turn_record
                .get("blocks")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    SessionFactLineageValidationError::invalid(
                        Some(&consumer.id),
                        format!("Shared Projection v2 turn {turn_id} has no blocks."),
                    )
                })?;
            if blocks
                .iter()
                .any(|block| block_sources_include_event(block, &consumer.id))
            {
                matching_turns.push(turn_id.to_owned());
            }
        }
        if matching_turns.len() != 1 || matching_turns[0] != authority.turn_id {
            return Err(SessionFactLineageValidationError::invalid(
                Some(&consumer.id),
                format!(
                    "Timeline parent for {} must be authority turn {} and contain its source event ref.",
                    consumer.id, authority.turn_id
                ),
            ));
        }
    }
    Ok(())
}

fn requires_timeline_parent(event: &EventView<'_>) -> bool {
    if matches!(
        event.kind.as_str(),
        "requirement_confirmation"
            | "requirement_decision"
            | "plan_card"
            | "plan_review"
            | "review_summary"
            | "permission_request"
            | "permission_result"
    ) {
        return true;
    }
    if event.kind == "assistant_msg" {
        return event
            .payload
            .and_then(|payload| text_field(payload, "channel"))
            == Some("final");
    }
    if event.kind == "error" {
        return true;
    }
    if event.kind != "session_run_state" {
        return false;
    }
    terminal_session_run_state(event)
}

fn block_sources_include_event(block: &Value, event_id: &str) -> bool {
    let Some(provenance) = block
        .as_object()
        .and_then(|record| record.get("provenance"))
        .and_then(Value::as_object)
    else {
        return false;
    };
    let Some(refs) = provenance.get("sourceEventRefs").and_then(Value::as_array) else {
        return false;
    };
    let prefixed = format!("event:{event_id}");
    refs.iter().any(|value| {
        value
            .as_str()
            .is_some_and(|reference| reference == event_id || reference == prefixed)
    })
}

fn earlier_index(
    event_indices: &HashMap<String, usize>,
    reference: &str,
    consumer_index: usize,
    consumer_id: &str,
    label: &str,
) -> Result<usize, SessionFactLineageValidationError> {
    let index = event_indices.get(reference).copied().ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(consumer_id),
            format!("Session fact {consumer_id} references missing {label} {reference}."),
        )
    })?;
    if index >= consumer_index {
        return Err(SessionFactLineageValidationError::invalid(
            Some(consumer_id),
            format!("Session fact {consumer_id} references future {label} {reference}."),
        ));
    }
    Ok(index)
}

fn strict_unique_refs(
    value: Option<&Value>,
    event_id: &str,
    label: &str,
) -> Result<Vec<String>, SessionFactLineageValidationError> {
    let refs = strict_string_array(value, event_id)?;
    let mut seen = HashSet::new();
    if refs.iter().any(|item| !seen.insert(item.clone())) {
        return Err(SessionFactLineageValidationError::invalid(
            Some(event_id),
            format!("Session fact lineage contains duplicate {label} refs."),
        ));
    }
    Ok(refs)
}

fn strict_string_array(
    value: Option<&Value>,
    event_id: &str,
) -> Result<Vec<String>, SessionFactLineageValidationError> {
    let values = value.and_then(Value::as_array).ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(event_id),
            "Session fact lineage refs must be arrays.",
        )
    })?;
    values
        .iter()
        .map(|value| {
            required_text_value(value)
                .map(str::to_owned)
                .ok_or_else(|| {
                    SessionFactLineageValidationError::invalid(
                        Some(event_id),
                        "Session fact lineage refs must be non-empty strings.",
                    )
                })
        })
        .collect()
}

fn required_payload_text<'a>(
    record: &'a Map<String, Value>,
    field: &str,
    event_id: &str,
) -> Result<&'a str, SessionFactLineageValidationError> {
    text_field(record, field).ok_or_else(|| {
        SessionFactLineageValidationError::invalid(
            Some(event_id),
            format!("{event_id} has no valid {field}."),
        )
    })
}

fn optional_text_field(
    record: &Map<String, Value>,
    field: &str,
    event_id: &str,
) -> Result<Option<String>, SessionFactLineageValidationError> {
    match record.get(field) {
        Some(value) => required_text_value(value)
            .map(|value| Some(value.to_owned()))
            .ok_or_else(|| {
                SessionFactLineageValidationError::invalid(
                    Some(event_id),
                    format!("{event_id} has an invalid optional {field}."),
                )
            }),
        None => Ok(None),
    }
}

fn text_field<'a>(record: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    record.get(field).and_then(required_text_value)
}

fn required_text(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn required_text_value(value: &Value) -> Option<&str> {
    value.as_str().and_then(required_text)
}

fn positive_u64_field(record: &Map<String, Value>, field: &str) -> Option<u64> {
    record
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
}

fn supported_kernel_fact_kind(kind: &str) -> bool {
    matches!(
        kind,
        "plan_authorization.decision_recorded"
            | "tool.execution_attempted"
            | "tool.effect_observed"
            | "tool.outcome_indeterminate"
            | "tool.completed"
            | "work_unit.completed"
            | "work_unit.failed"
            | "work_unit.blocked"
            | "review.facts_produced"
            | "review_gate.evaluated"
            | "run.completed"
            | "runtime.lifecycle_changed"
            | "resource.cleanup_state_changed"
    )
}

fn terminal_or_effect_fact_kind(kind: &str) -> bool {
    matches!(
        kind,
        "tool.effect_observed"
            | "tool.completed"
            | "work_unit.completed"
            | "review.facts_produced"
            | "review_gate.evaluated"
            | "run.completed"
            | "resource.cleanup_state_changed"
    )
}

fn kernel_identity<'a>(kernel_event: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    let aliases: &[&str] = match field {
        "factId" => &["factId", "id"],
        "authorizationContractId" => &["authorizationContractId", "contractId"],
        _ => &[field],
    };
    for container in kernel_identity_containers(kernel_event) {
        for alias in aliases {
            if let Some(value) = text_field(container, alias) {
                return Some(value);
            }
        }
    }
    None
}

fn kernel_identity_containers<'a>(
    kernel_event: &'a Map<String, Value>,
) -> Vec<&'a Map<String, Value>> {
    let mut containers = vec![kernel_event];
    for field in ["fact", "result", "output"] {
        if let Some(record) = kernel_event.get(field).and_then(Value::as_object) {
            containers.push(record);
            for nested in ["attempt", "receipt"] {
                if let Some(value) = record.get(nested).and_then(Value::as_object) {
                    containers.push(value);
                }
            }
        }
    }
    containers
}

fn authority_mismatch(
    event: &EventView<'_>,
    field: &str,
    actual: &str,
    expected: &str,
) -> SessionFactLineageValidationError {
    SessionFactLineageValidationError::invalid(
        Some(&event.id),
        format!(
            "Session fact {} {field}={actual} does not match turn authority {expected}.",
            event.id
        ),
    )
}
