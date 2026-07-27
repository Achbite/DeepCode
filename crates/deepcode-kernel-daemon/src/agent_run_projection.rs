use crate::prelude::*;
use crate::*;

pub(crate) fn validated_bridge_timeline(
    result: &Value,
    session_id: &str,
    expected_event_count: usize,
) -> Result<Value, String> {
    let mut timeline = result
        .get("timeline")
        .cloned()
        .ok_or_else(|| "session bridge result is missing the canonical timeline".to_string())?;
    canonicalize_projection_safe_integers(&mut timeline);
    validate_shared_projection_timeline(&timeline)?;
    if timeline.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err("session bridge timeline does not belong to the active session".to_string());
    }
    if timeline
        .get("eventCount")
        .and_then(json_safe_nonnegative_integer)
        != Some(expected_event_count as u64)
    {
        return Err(format!(
            "session bridge timeline event count does not match committed projection: expected {expected_event_count}"
        ));
    }
    if timeline
        .get("sourceEventVersion")
        .and_then(json_safe_nonnegative_integer)
        != Some(expected_event_count as u64)
    {
        return Err(
            "session bridge timeline source event version does not match committed projection"
                .to_string(),
        );
    }
    Ok(timeline)
}

pub(crate) fn validate_shared_projection_timeline(timeline: &Value) -> Result<(), String> {
    validate_object_keys(
        timeline,
        &[
            "schemaVersion",
            "sessionId",
            "revision",
            "sourceEventVersion",
            "lastDeltaSeq",
            "generatedAt",
            "turns",
            "eventCount",
            "taskProjection",
            "interactionProjection",
            "runProjection",
            "tokenUsageProjection",
            "workspaceProjection",
        ],
        "runtime timeline",
    )?;
    if timeline.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.shared-conversation-projection.v2")
    {
        return Err("runtime timeline has an unsupported schema version".to_string());
    }
    require_nonempty_string_field(timeline, "sessionId", "runtime timeline")?;
    require_string_field(timeline, "generatedAt", "runtime timeline")?;
    for field in [
        "revision",
        "sourceEventVersion",
        "lastDeltaSeq",
        "eventCount",
    ] {
        require_u64_field(timeline, field, "runtime timeline")?;
    }
    let turns = timeline
        .get("turns")
        .and_then(Value::as_array)
        .ok_or_else(|| "runtime timeline is missing structured turns".to_string())?;
    let session_id = timeline
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut turn_ids = std::collections::HashSet::new();
    let mut block_ids = std::collections::HashSet::new();
    for turn in turns {
        validate_shared_projection_turn(turn, session_id)?;
        let turn_id = turn.get("id").and_then(Value::as_str).unwrap_or_default();
        if !turn_ids.insert(turn_id) {
            return Err(format!(
                "runtime timeline contains duplicate turn id {turn_id}"
            ));
        }
        for block in turn
            .get("blocks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let block_id = block.get("id").and_then(Value::as_str).unwrap_or_default();
            if !block_ids.insert(block_id) {
                return Err(format!(
                    "runtime timeline contains duplicate block id {block_id}"
                ));
            }
        }
    }
    if let Some(task_projection) = timeline.get("taskProjection") {
        validate_task_projection(task_projection)?;
    }
    if let Some(run_projection) = timeline.get("runProjection") {
        validate_run_projection(run_projection)?;
    }
    if let Some(usage_projection) = timeline.get("tokenUsageProjection") {
        validate_usage_projection(usage_projection)?;
    }
    if let Some(workspace_projection) = timeline.get("workspaceProjection") {
        validate_workspace_projection(workspace_projection)?;
    }
    if let Some(interaction_projection) = timeline.get("interactionProjection") {
        validate_interaction_projection(interaction_projection)?;
    }
    validate_shared_projection_blocks(timeline)?;
    if contains_private_projection_key(timeline) {
        return Err("runtime timeline contains private analysis payload".to_string());
    }
    Ok(())
}

fn validate_shared_projection_turn(turn: &Value, session_id: &str) -> Result<(), String> {
    validate_object_keys(
        turn,
        &[
            "id",
            "sequence",
            "sessionId",
            "status",
            "startedAt",
            "completedAt",
            "settlement",
            "executionEvidence",
            "blocks",
        ],
        "timeline turn",
    )?;
    require_nonempty_string_field(turn, "id", "timeline turn")?;
    if turn.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err("timeline turn does not belong to the projection session".to_string());
    }
    optional_u64_field(turn, "sequence", "timeline turn")?;
    enum_field(
        turn,
        "status",
        &[
            "queued",
            "running",
            "waiting",
            "blocked",
            "completed",
            "cancelled",
            "failed",
        ],
        "timeline turn",
    )?;
    optional_string_field(turn, "startedAt", "timeline turn")?;
    optional_string_field(turn, "completedAt", "timeline turn")?;
    if let Some(settlement) = turn.get("settlement") {
        validate_turn_settlement(settlement)?;
    }
    if let Some(evidence) = turn.get("executionEvidence") {
        validate_turn_execution_evidence(evidence)?;
    }
    turn.get("blocks")
        .and_then(Value::as_array)
        .ok_or_else(|| "timeline turn requires blocks".to_string())?;
    Ok(())
}

fn validate_turn_settlement(settlement: &Value) -> Result<(), String> {
    validate_object_keys(
        settlement,
        &["schemaVersion", "status", "factRef", "turnAuthorityRef"],
        "turn settlement",
    )?;
    if settlement.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.session.turn-settlement.v1")
    {
        return Err("turn settlement has an unsupported schema version".to_string());
    }
    enum_field(
        settlement,
        "status",
        &["waiting", "completed", "failed", "cancelled"],
        "turn settlement",
    )?;
    require_nonempty_string_field(settlement, "factRef", "turn settlement")?;
    require_event_fact_ref(settlement, "factRef", "turn settlement")?;
    require_nonempty_string_field(settlement, "turnAuthorityRef", "turn settlement")
}

fn validate_turn_execution_evidence(evidence: &Value) -> Result<(), String> {
    validate_object_keys(
        evidence,
        &["kind", "sourceFactRef", "taskClaims"],
        "turn execution evidence",
    )?;
    enum_field(
        evidence,
        "kind",
        &["notRequired", "kernelFactBacked"],
        "turn execution evidence",
    )?;
    require_nonempty_string_field(evidence, "sourceFactRef", "turn execution evidence")?;
    require_event_fact_ref(evidence, "sourceFactRef", "turn execution evidence")?;
    let claims = evidence
        .get("taskClaims")
        .and_then(Value::as_array)
        .ok_or_else(|| "turn execution evidence requires taskClaims".to_string())?;
    let kind = evidence
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind == "notRequired" && !claims.is_empty() {
        return Err("notRequired turn execution evidence must not contain task claims".to_string());
    }
    if kind == "kernelFactBacked" && claims.is_empty() {
        return Err(
            "kernelFactBacked turn execution evidence requires exact task claims".to_string(),
        );
    }
    let mut task_ids = std::collections::HashSet::new();
    let mut claimed_work_units = std::collections::HashSet::new();
    let mut previous_task_id: Option<&str> = None;
    for claim in claims {
        validate_object_keys(
            claim,
            &["taskId", "workUnitIds", "factRefs"],
            "turn execution evidence task claim",
        )?;
        require_nonempty_string_field(claim, "taskId", "turn execution evidence task claim")?;
        require_string_array_field(claim, "workUnitIds", "turn execution evidence task claim")?;
        require_string_array_field(claim, "factRefs", "turn execution evidence task claim")?;
        let task_id = claim
            .get("taskId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let work_unit_ids = strict_nonempty_unique_string_array(
            claim.get("workUnitIds"),
            "turn execution evidence task claim workUnitIds",
        )?;
        let fact_refs = strict_nonempty_unique_string_array(
            claim.get("factRefs"),
            "turn execution evidence task claim factRefs",
        )?;
        if work_unit_ids.is_empty() || fact_refs.is_empty() {
            return Err(
                "kernelFactBacked task claims require work units and durable fact refs".to_string(),
            );
        }
        if !task_ids.insert(task_id) {
            return Err("turn execution evidence contains duplicate task identities".to_string());
        }
        if previous_task_id.is_some_and(|previous| previous >= task_id) {
            return Err(
                "turn execution evidence task claims must use canonical sorted order".to_string(),
            );
        }
        previous_task_id = Some(task_id);
        if work_unit_ids
            .iter()
            .any(|work_unit_id| !claimed_work_units.insert(*work_unit_id))
        {
            return Err(
                "turn execution evidence assigns one work unit to multiple tasks".to_string(),
            );
        }
        if !is_sorted_strictly(work_unit_ids.as_slice())
            || !is_sorted_strictly(fact_refs.as_slice())
        {
            return Err(
                "turn execution evidence task identities must use canonical sorted order"
                    .to_string(),
            );
        }
        if fact_refs
            .iter()
            .any(|reference| !is_event_fact_ref(reference))
        {
            return Err(
                "turn execution evidence factRefs must identify durable AgentEvents".to_string(),
            );
        }
    }
    Ok(())
}

fn validate_task_projection(projection: &Value) -> Result<(), String> {
    validate_object_keys(projection, &["title", "items"], "task projection")?;
    require_string_field(projection, "title", "task projection")?;
    let items = projection
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "task projection requires items".to_string())?;
    for item in items {
        validate_object_keys(
            item,
            &[
                "id",
                "title",
                "summary",
                "status",
                "blockId",
                "narrativeKind",
                "settlementKind",
            ],
            "task projection item",
        )?;
        for field in ["id", "title", "summary", "blockId"] {
            require_string_field(item, field, "task projection item")?;
        }
        enum_field(
            item,
            "status",
            &[
                "queued",
                "running",
                "waiting",
                "blocked",
                "completed",
                "cancelled",
                "failed",
            ],
            "task projection item",
        )?;
        enum_field(
            item,
            "narrativeKind",
            &[
                "user",
                "assistantNarration",
                "assistantText",
                "operationEvidence",
                "requirement",
                "plan",
                "permission",
                "verification",
                "review",
                "diagnostic",
            ],
            "task projection item",
        )?;
        optional_enum_field(
            item,
            "settlementKind",
            &[
                "kernelCompleted",
                "sessionEvidenceSatisfied",
                "userSkipped",
                "userAcceptedIncomplete",
                "failed",
            ],
            "task projection item",
        )?;
    }
    Ok(())
}

fn validate_run_projection(projection: &Value) -> Result<(), String> {
    validate_object_keys(
        projection,
        &[
            "runId",
            "turnId",
            "taskId",
            "revision",
            "status",
            "phase",
            "waitReason",
            "activeInteractionId",
            "languageBinding",
        ],
        "run projection",
    )?;
    require_nonempty_string_field(projection, "runId", "run projection")?;
    optional_string_field(projection, "turnId", "run projection")?;
    optional_string_field(projection, "taskId", "run projection")?;
    require_u64_field(projection, "revision", "run projection")?;
    enum_field(
        projection,
        "status",
        &[
            "active",
            "waitingUser",
            "waitingExternal",
            "paused",
            "succeeded",
            "failed",
            "cancelled",
        ],
        "run projection",
    )?;
    enum_field(
        projection,
        "phase",
        &[
            "preparing",
            "processing",
            "executing",
            "validating",
            "waiting",
            "settled",
        ],
        "run projection",
    )?;
    optional_string_field(projection, "waitReason", "run projection")?;
    optional_string_field(projection, "activeInteractionId", "run projection")?;
    validate_language_binding(
        projection
            .get("languageBinding")
            .ok_or_else(|| "run projection requires languageBinding".to_string())?,
        "run projection language binding",
    )
}

fn validate_usage_projection(projection: &Value) -> Result<(), String> {
    validate_object_keys(
        projection,
        &["totals", "requests"],
        "token usage projection",
    )?;
    validate_usage_record(
        projection
            .get("totals")
            .ok_or_else(|| "token usage projection requires totals".to_string())?,
        "token usage totals",
        &[],
    )?;
    let requests = projection
        .get("requests")
        .and_then(Value::as_array)
        .ok_or_else(|| "token usage projection requires requests".to_string())?;
    for request in requests {
        validate_usage_record(
            request,
            "token usage request",
            &[
                "requestId",
                "turnId",
                "userEventId",
                "title",
                "startedAt",
                "completedAt",
                "stages",
            ],
        )?;
        for field in ["requestId", "turnId", "userEventId", "title"] {
            require_string_field(request, field, "token usage request")?;
        }
        optional_string_field(request, "startedAt", "token usage request")?;
        optional_string_field(request, "completedAt", "token usage request")?;
        require_string_array_field(request, "stages", "token usage request")?;
    }
    Ok(())
}

fn validate_usage_record(value: &Value, label: &str, extra_keys: &[&str]) -> Result<(), String> {
    let mut allowed = vec![
        "promptCacheHitTokens",
        "promptCacheMissTokens",
        "cachedTokens",
        "promptTokens",
        "completionTokens",
        "totalTokens",
        "cacheHitRate",
        "providerCallCount",
        "providers",
    ];
    allowed.extend_from_slice(extra_keys);
    validate_object_keys(value, &allowed, label)?;
    for field in [
        "promptCacheHitTokens",
        "promptCacheMissTokens",
        "cachedTokens",
        "promptTokens",
        "completionTokens",
        "totalTokens",
        "providerCallCount",
    ] {
        require_u64_field(value, field, label)?;
    }
    match value.get("cacheHitRate") {
        Some(Value::Null) => {}
        Some(rate)
            if rate
                .as_f64()
                .is_some_and(|rate| (0.0..=1.0).contains(&rate)) => {}
        _ => return Err(format!("{label} has invalid cacheHitRate")),
    }
    require_string_array_field(value, "providers", label)
}

fn validate_workspace_projection(projection: &Value) -> Result<(), String> {
    validate_object_keys(
        projection,
        &["revision", "changedTargets"],
        "workspace projection",
    )?;
    require_u64_field(projection, "revision", "workspace projection")?;
    require_string_array_field(projection, "changedTargets", "workspace projection")
}

fn validate_interaction_projection(projection: &Value) -> Result<(), String> {
    validate_object_keys(projection, &["pending"], "interaction projection")?;
    let Some(pending) = projection.get("pending") else {
        return Ok(());
    };
    let kind = pending
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "pending interaction requires kind".to_string())?;
    let mut allowed = vec![
        "kind",
        "interactionId",
        "interactionRevision",
        "targetId",
        "blockId",
        "title",
        "summary",
    ];
    match kind {
        "permission" => allowed.extend(["requestId", "request"]),
        "plan" => allowed.extend(["runId", "planId"]),
        "review" => allowed.extend(["runId", "reviewId"]),
        "requirement" => allowed.extend(["runId", "requirementId", "decisionRequest"]),
        _ => return Err("pending interaction has unsupported kind".to_string()),
    }
    validate_object_keys(pending, &allowed, "pending interaction")?;
    for field in ["interactionId", "interactionRevision", "targetId"] {
        require_nonempty_string_field(pending, field, "pending interaction")?;
    }
    optional_string_field(pending, "blockId", "pending interaction")?;
    optional_string_field(pending, "title", "pending interaction")?;
    optional_string_field(pending, "summary", "pending interaction")?;
    match kind {
        "permission" => {
            require_nonempty_string_field(pending, "requestId", "pending permission")?;
            validate_permission_request(
                pending
                    .get("request")
                    .ok_or_else(|| "pending permission requires request".to_string())?,
            )?;
        }
        "plan" => {
            require_nonempty_string_field(pending, "runId", "pending plan")?;
            require_target_alias(pending, "planId", "pending plan")?;
        }
        "review" => {
            require_nonempty_string_field(pending, "runId", "pending review")?;
            require_target_alias(pending, "reviewId", "pending review")?;
        }
        "requirement" => {
            require_nonempty_string_field(pending, "runId", "pending requirement")?;
            require_target_alias(pending, "requirementId", "pending requirement")?;
        }
        _ => unreachable!("pending interaction kind validated above"),
    }
    if let Some(request) = pending.get("decisionRequest") {
        validate_decision_request(request, "pending decision request")?;
    }
    Ok(())
}

pub(crate) fn validate_shared_projection_commit(
    timeline: &Value,
    session_id: &str,
    events: &[Value],
) -> Result<(), String> {
    validate_shared_projection_timeline(timeline)?;
    if timeline.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err("runtime timeline does not belong to the route session".to_string());
    }
    let expected_event_count = events.len() as u64;
    if timeline
        .get("eventCount")
        .and_then(json_safe_nonnegative_integer)
        != Some(expected_event_count)
        || timeline
            .get("sourceEventVersion")
            .and_then(json_safe_nonnegative_integer)
            != Some(expected_event_count)
    {
        return Err(
            "runtime timeline source version does not match durable Session events".to_string(),
        );
    }
    validate_final_answer_facts(timeline, events)?;
    validate_pending_interaction_opening_fact(timeline, events)?;
    validate_projected_turn_evidence(timeline, events)
}

#[derive(Debug, Clone)]
struct ProjectionTurnAuthority {
    event_index: usize,
    event_id: String,
    session_id: String,
    run_id: String,
    turn_id: String,
}

#[derive(Debug)]
struct ProjectedKernelEffectClaim {
    task_id: String,
    operation_ids: Vec<String>,
    work_unit_ids: Vec<String>,
}

#[derive(Debug)]
struct ProjectedKernelFactRef {
    kernel_event_ref: String,
    operation_id: Option<String>,
    work_unit_id: Option<String>,
}

fn validate_projected_turn_evidence(timeline: &Value, events: &[Value]) -> Result<(), String> {
    let session_id = timeline
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut event_indices = std::collections::HashMap::new();
    for (index, event) in events.iter().enumerate() {
        let event_id = event
            .get("id")
            .and_then(Value::as_str)
            .filter(|event_id| !event_id.trim().is_empty())
            .ok_or_else(|| "durable AgentEvent is missing identity".to_string())?;
        if event_indices.insert(event_id.to_string(), index).is_some() {
            return Err(format!(
                "durable AgentEvent identity {event_id} is duplicated"
            ));
        }
    }

    let mut authorities = std::collections::HashMap::new();
    let mut authority_turn_occurrences = std::collections::HashMap::<String, usize>::new();
    for (index, event) in events.iter().enumerate() {
        if event.get("kind").and_then(Value::as_str) != Some("session_turn_authority") {
            continue;
        }
        let event_id = event.get("id").and_then(Value::as_str).unwrap_or_default();
        let event_session_id = event
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("turn authority {event_id} is missing its Session identity"))?;
        let payload = event
            .get("payload")
            .and_then(Value::as_object)
            .ok_or_else(|| format!("turn authority {event_id} has no object payload"))?;
        if payload.get("schemaVersion").and_then(Value::as_str)
            != Some("deepcode.session.turn-authority.v2")
        {
            continue;
        }
        let authority_session_id = payload
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                format!("turn authority {event_id} payload is missing its Session identity")
            })?;
        let run_id = payload
            .get("runId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("turn authority {event_id} is missing runId"))?;
        let turn_id = payload
            .get("turnId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("turn authority {event_id} is missing turnId"))?;
        if event_session_id != session_id || authority_session_id != session_id {
            return Err(format!(
                "turn authority {event_id} crosses the projection Session boundary"
            ));
        }
        *authority_turn_occurrences
            .entry(turn_id.to_string())
            .or_default() += 1;
        authorities.insert(
            event_id.to_string(),
            ProjectionTurnAuthority {
                event_index: index,
                event_id: event_id.to_string(),
                session_id: event_session_id.to_string(),
                run_id: run_id.to_string(),
                turn_id: turn_id.to_string(),
            },
        );
    }
    let ambiguous_authority_turn_ids = authority_turn_occurrences
        .into_iter()
        .filter_map(|(turn_id, count)| (count != 1).then_some(turn_id))
        .collect::<std::collections::HashSet<_>>();

    let mut expected_settlements = std::collections::HashMap::<String, Value>::new();
    let mut expected_execution_evidence = std::collections::HashMap::<String, Option<Value>>::new();
    for (event_index, event) in events.iter().enumerate() {
        let kind = event
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = event.get("payload").and_then(Value::as_object);
        let relevant = kind == "session_run_state"
            || kind == "assistant_msg"
                && payload
                    .and_then(|payload| payload.get("channel"))
                    .and_then(Value::as_str)
                    == Some("final");
        if !relevant {
            continue;
        }
        let Some(authority) = projected_event_turn_authority(
            event,
            event_index,
            &authorities,
            &ambiguous_authority_turn_ids,
            session_id,
        )?
        else {
            continue;
        };
        let event_id = event.get("id").and_then(Value::as_str).unwrap_or_default();
        if kind == "session_run_state" {
            let Some(status) = payload
                .and_then(|payload| payload.get("status"))
                .and_then(Value::as_str)
                .filter(|status| {
                    matches!(*status, "waiting" | "completed" | "failed" | "cancelled")
                })
            else {
                continue;
            };
            if payload
                .and_then(|payload| payload.get("runId"))
                .and_then(Value::as_str)
                .is_some_and(|run_id| run_id != authority.run_id)
                || payload
                    .and_then(|payload| payload.get("turnId"))
                    .and_then(Value::as_str)
                    .is_some_and(|turn_id| turn_id != authority.turn_id)
            {
                return Err(format!(
                    "Session settlement fact {event_id} does not match its exact turn authority"
                ));
            }
            expected_settlements.insert(
                authority.turn_id.clone(),
                json!({
                    "schemaVersion": "deepcode.session.turn-settlement.v1",
                    "status": status,
                    "factRef": format!("event:{event_id}"),
                    "turnAuthorityRef": authority.event_id,
                }),
            );
            continue;
        }

        let expected = expected_execution_evidence_for_final(
            event,
            event_index,
            authority,
            events,
            &event_indices,
        )?;
        // The latest exact-authority final fact owns the turn evidence slot.
        // A final without an explicit evidence decision intentionally clears
        // any earlier candidate rather than inheriting an obsolete claim.
        expected_execution_evidence.insert(authority.turn_id.clone(), expected);
    }

    let mut projected_turn_ids = std::collections::HashSet::new();
    for turn in timeline
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let turn_id = turn.get("id").and_then(Value::as_str).unwrap_or_default();
        projected_turn_ids.insert(turn_id);
        let actual_settlement = turn.get("settlement");
        let expected_settlement = expected_settlements.get(turn_id);
        if actual_settlement != expected_settlement {
            return Err(format!(
                "turn {turn_id} settlement does not exactly match durable Session settlement facts"
            ));
        }
        let actual_evidence = turn.get("executionEvidence");
        let expected_evidence = expected_execution_evidence
            .get(turn_id)
            .and_then(Option::as_ref);
        if actual_evidence != expected_evidence {
            return Err(format!(
                "turn {turn_id} execution evidence does not exactly match durable final and Kernel facts"
            ));
        }
    }
    if expected_settlements
        .keys()
        .chain(
            expected_execution_evidence
                .iter()
                .filter_map(|(turn_id, evidence)| evidence.as_ref().map(|_| turn_id)),
        )
        .any(|turn_id| !projected_turn_ids.contains(turn_id.as_str()))
    {
        return Err(
            "durable Session turn evidence has no exact Shared Projection turn".to_string(),
        );
    }
    Ok(())
}

fn projected_event_turn_authority<'a>(
    event: &Value,
    event_index: usize,
    authorities: &'a std::collections::HashMap<String, ProjectionTurnAuthority>,
    ambiguous_authority_turn_ids: &std::collections::HashSet<String>,
    session_id: &str,
) -> Result<Option<&'a ProjectionTurnAuthority>, String> {
    let Some(lineage) = event.pointer("/payload/lineage").and_then(Value::as_object) else {
        return Ok(None);
    };
    if lineage.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.session.fact-lineage.v1")
    {
        return Err("projected Session evidence has malformed fact lineage".to_string());
    }
    let authority_ref = lineage
        .get("turnAuthorityRef")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "projected Session evidence lineage is missing turnAuthorityRef".to_string()
        })?;
    let authority = authorities.get(authority_ref).ok_or_else(|| {
        format!("projected Session evidence references unknown turn authority {authority_ref}")
    })?;
    if authority.event_index >= event_index
        || authority.session_id != session_id
        || event.get("sessionId").and_then(Value::as_str) != Some(session_id)
    {
        return Err(format!(
            "projected Session evidence does not follow exact earlier authority {authority_ref}"
        ));
    }
    if ambiguous_authority_turn_ids.contains(&authority.turn_id) {
        return Err(format!(
            "projected Session evidence authority turn {} is ambiguous",
            authority.turn_id
        ));
    }
    Ok(Some(authority))
}

fn expected_execution_evidence_for_final(
    event: &Value,
    event_index: usize,
    authority: &ProjectionTurnAuthority,
    events: &[Value],
    event_indices: &std::collections::HashMap<String, usize>,
) -> Result<Option<Value>, String> {
    let event_id = event.get("id").and_then(Value::as_str).unwrap_or_default();
    let payload = event
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("final Session fact {event_id} has no object payload"))?;
    if payload
        .get("runId")
        .and_then(Value::as_str)
        .is_some_and(|run_id| run_id != authority.run_id)
        || payload
            .get("turnId")
            .and_then(Value::as_str)
            .is_some_and(|turn_id| turn_id != authority.turn_id)
    {
        return Err(format!(
            "final Session fact {event_id} does not match its exact turn authority"
        ));
    }
    let Some(requires_kernel_facts) = payload.get("requiresKernelFacts") else {
        return Ok(None);
    };
    let requires_kernel_facts = requires_kernel_facts
        .as_bool()
        .ok_or_else(|| format!("final Session fact {event_id} has invalid requiresKernelFacts"))?;
    let lineage = payload
        .get("lineage")
        .and_then(Value::as_object)
        .expect("lineage was resolved before final evidence");
    let refs = lineage
        .get("kernelFactRefs")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            format!("final Session fact {event_id} lineage has invalid kernelFactRefs")
        })?;
    let claims = match payload.get("kernelEffectClaims") {
        None => &[][..],
        Some(value) => value.as_array().ok_or_else(|| {
            format!("final Session fact {event_id} has invalid kernelEffectClaims")
        })?,
    };
    if !requires_kernel_facts {
        if !claims.is_empty() || !refs.is_empty() {
            return Err(format!(
                "notRequired final Session fact {event_id} contains Kernel claims or refs"
            ));
        }
        return Ok(Some(json!({
            "kind": "notRequired",
            "sourceFactRef": format!("event:{event_id}"),
            "taskClaims": [],
        })));
    }

    let claims = parse_projected_kernel_effect_claims(claims, event_id)?;
    if claims.is_empty() || refs.is_empty() {
        return Err(format!(
            "kernelFactBacked final Session fact {event_id} requires claims and Kernel refs"
        ));
    }
    let refs = parse_projected_kernel_fact_refs(
        refs,
        event_id,
        event_index,
        authority,
        events,
        event_indices,
    )?;
    let mut projected_claims = Vec::with_capacity(claims.len());
    let mut associated_refs = std::collections::HashSet::new();
    for claim in &claims {
        let operation_ids = claim
            .operation_ids
            .iter()
            .collect::<std::collections::HashSet<_>>();
        let work_unit_ids = claim
            .work_unit_ids
            .iter()
            .collect::<std::collections::HashSet<_>>();
        let mut fact_refs = refs
            .iter()
            .filter(|reference| {
                reference
                    .operation_id
                    .as_ref()
                    .is_some_and(|operation_id| operation_ids.contains(operation_id))
                    || reference
                        .work_unit_id
                        .as_ref()
                        .is_some_and(|work_unit_id| work_unit_ids.contains(work_unit_id))
            })
            .map(|reference| {
                associated_refs.insert(reference.kernel_event_ref.as_str());
                format!("event:{}", reference.kernel_event_ref)
            })
            .collect::<Vec<_>>();
        fact_refs.sort();
        fact_refs.dedup();
        for operation_id in &claim.operation_ids {
            if !refs
                .iter()
                .any(|reference| reference.operation_id.as_ref() == Some(operation_id))
            {
                return Err(format!(
                    "final Session fact {event_id} has no exact Kernel ref for operation {operation_id}"
                ));
            }
        }
        for work_unit_id in &claim.work_unit_ids {
            if !refs
                .iter()
                .any(|reference| reference.work_unit_id.as_ref() == Some(work_unit_id))
            {
                return Err(format!(
                    "final Session fact {event_id} has no exact Kernel ref for work unit {work_unit_id}"
                ));
            }
        }
        if fact_refs.is_empty() {
            return Err(format!(
                "final Session fact {event_id} task {} has no exact Kernel fact refs",
                claim.task_id
            ));
        }
        let mut work_unit_ids = claim.work_unit_ids.clone();
        work_unit_ids.sort();
        projected_claims.push(json!({
            "taskId": claim.task_id,
            "workUnitIds": work_unit_ids,
            "factRefs": fact_refs,
        }));
    }
    projected_claims.sort_by(|left, right| {
        left.get("taskId")
            .and_then(Value::as_str)
            .cmp(&right.get("taskId").and_then(Value::as_str))
    });
    if refs
        .iter()
        .any(|reference| !associated_refs.contains(reference.kernel_event_ref.as_str()))
    {
        return Err(format!(
            "final Session fact {event_id} contains a Kernel ref outside its exact task claims"
        ));
    }
    Ok(Some(json!({
        "kind": "kernelFactBacked",
        "sourceFactRef": format!("event:{event_id}"),
        "taskClaims": projected_claims,
    })))
}

fn parse_projected_kernel_effect_claims(
    claims: &[Value],
    event_id: &str,
) -> Result<Vec<ProjectedKernelEffectClaim>, String> {
    let mut task_ids = std::collections::HashSet::new();
    let mut operation_ids = std::collections::HashSet::new();
    let mut work_unit_ids = std::collections::HashSet::new();
    claims
        .iter()
        .enumerate()
        .map(|(index, claim)| {
            let claim = claim.as_object().ok_or_else(|| {
                format!("final Session fact {event_id} has invalid Kernel claim at index {index}")
            })?;
            let task_id = claim
                .get("taskId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    format!("final Session fact {event_id} Kernel claim {index} has no taskId")
                })?
                .to_string();
            let claim_operation_ids =
                projected_identity_array(claim.get("operationIds"), event_id, "operationIds")?;
            let claim_work_unit_ids =
                projected_identity_array(claim.get("workUnitIds"), event_id, "workUnitIds")?;
            if claim_work_unit_ids.is_empty() {
                return Err(format!(
                    "final Session fact {event_id} Kernel claim {task_id} has no exact work units"
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
                return Err(format!(
                    "final Session fact {event_id} contains conflicting Kernel claim identities"
                ));
            }
            Ok(ProjectedKernelEffectClaim {
                task_id,
                operation_ids: claim_operation_ids,
                work_unit_ids: claim_work_unit_ids,
            })
        })
        .collect()
}

fn projected_identity_array(
    value: Option<&Value>,
    event_id: &str,
    field: &str,
) -> Result<Vec<String>, String> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| format!("final Session fact {event_id} Kernel claim has invalid {field}"))?;
    let mut seen = std::collections::HashSet::new();
    values
        .iter()
        .map(|value| {
            let value = value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "final Session fact {event_id} Kernel claim {field} has an invalid identity"
                    )
                })?
                .to_string();
            if !seen.insert(value.clone()) {
                return Err(format!(
                    "final Session fact {event_id} Kernel claim {field} contains duplicate identities"
                ));
            }
            Ok(value)
        })
        .collect()
}

fn parse_projected_kernel_fact_refs(
    refs: &[Value],
    event_id: &str,
    event_index: usize,
    authority: &ProjectionTurnAuthority,
    events: &[Value],
    event_indices: &std::collections::HashMap<String, usize>,
) -> Result<Vec<ProjectedKernelFactRef>, String> {
    let mut seen = std::collections::HashSet::new();
    refs.iter()
        .map(|reference| {
            let reference = reference.as_object().ok_or_else(|| {
                format!("final Session fact {event_id} has an invalid Kernel fact ref")
            })?;
            if reference.get("schemaVersion").and_then(Value::as_str)
                != Some("deepcode.session.kernel-fact-ref.v1")
            {
                return Err(format!(
                    "final Session fact {event_id} has an unsupported Kernel fact ref"
                ));
            }
            let kernel_event_ref = reference
                .get("kernelEventRef")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    format!("final Session fact {event_id} Kernel ref has no event identity")
                })?;
            if !seen.insert(kernel_event_ref) {
                return Err(format!(
                    "final Session fact {event_id} has duplicate Kernel fact refs"
                ));
            }
            let kind = reference
                .get("kind")
                .and_then(Value::as_str)
                .filter(|kind| projected_terminal_or_effect_kind(kind))
                .ok_or_else(|| {
                    format!(
                        "final Session fact {event_id} Kernel ref is not terminal/effect evidence"
                    )
                })?;
            if reference.get("runId").and_then(Value::as_str)
                != Some(authority.run_id.as_str())
            {
                return Err(format!(
                    "final Session fact {event_id} Kernel ref crosses its authority run"
                ));
            }
            let source_index = *event_indices.get(kernel_event_ref).ok_or_else(|| {
                format!(
                    "final Session fact {event_id} Kernel ref {kernel_event_ref} is not durable"
                )
            })?;
            if source_index >= event_index {
                return Err(format!(
                    "final Session fact {event_id} Kernel ref {kernel_event_ref} is not earlier"
                ));
            }
            let source = &events[source_index];
            if source.get("sessionId").and_then(Value::as_str)
                != Some(authority.session_id.as_str())
            {
                return Err(format!(
                    "final Session fact {event_id} Kernel ref {kernel_event_ref} crosses the Session boundary"
                ));
            }
            let kernel_event = source
                .pointer("/payload/kernelEvent")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    format!(
                        "final Session fact {event_id} Kernel ref {kernel_event_ref} has no typed Kernel event"
                    )
                })?;
            if kernel_event.get("kind").and_then(Value::as_str) != Some(kind)
                || kernel_event
                    .get("runId")
                    .and_then(Value::as_str)
                    .is_some_and(|run_id| run_id != authority.run_id)
                || kernel_event
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .is_some_and(|session_id| session_id != authority.session_id)
            {
                return Err(format!(
                    "final Session fact {event_id} Kernel ref {kernel_event_ref} does not match its typed fact"
                ));
            }
            for field in [
                "factId",
                "planActionId",
                "capabilityGrantId",
                "authorizationContractId",
                "operationId",
                "workUnitId",
            ] {
                if let Some(expected) = reference.get(field).and_then(Value::as_str) {
                    if projected_kernel_identity(kernel_event, field) != Some(expected) {
                        return Err(format!(
                            "final Session fact {event_id} Kernel ref {kernel_event_ref} has mismatched {field}"
                        ));
                    }
                }
            }
            Ok(ProjectedKernelFactRef {
                kernel_event_ref: kernel_event_ref.to_string(),
                operation_id: reference
                    .get("operationId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                work_unit_id: reference
                    .get("workUnitId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

fn projected_terminal_or_effect_kind(kind: &str) -> bool {
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

fn projected_kernel_identity<'a>(
    kernel_event: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Option<&'a str> {
    let aliases: &[&str] = match field {
        "factId" => &["factId", "id"],
        "authorizationContractId" => &["authorizationContractId", "contractId"],
        _ => &[field],
    };
    let mut containers = vec![kernel_event];
    for container_field in ["fact", "result", "output"] {
        if let Some(record) = kernel_event.get(container_field).and_then(Value::as_object) {
            containers.push(record);
            for nested in ["attempt", "receipt"] {
                if let Some(record) = record.get(nested).and_then(Value::as_object) {
                    containers.push(record);
                }
            }
        }
    }
    for container in containers {
        for alias in aliases {
            if let Some(value) = container.get(*alias).and_then(Value::as_str) {
                return Some(value);
            }
        }
    }
    None
}

pub(crate) fn validate_committed_final_history(
    previous: &Value,
    incoming: &Value,
) -> Result<(), String> {
    if previous.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.shared-conversation-projection.v2")
    {
        return Ok(());
    }
    for turn in previous
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let turn_id = turn
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "committed final answer parent turn is missing identity".to_string())?;
        for block in turn
            .get("blocks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|block| {
                block.get("entryRole").and_then(Value::as_str) == Some("finalAnswer")
                    && block.get("durability").and_then(Value::as_str) == Some("committed")
            })
        {
            let block_id = block.get("id").and_then(Value::as_str).ok_or_else(|| {
                "committed final answer is missing its block identity".to_string()
            })?;
            let candidate =
                timeline_block_in_turn(incoming, turn_id, block_id).ok_or_else(|| {
                    format!(
                        "committed final answer {block_id} was removed or moved from turn {turn_id}"
                    )
                })?;
            if candidate != block {
                return Err(format!(
                    "committed final answer {block_id} was mutated after durable acknowledgement"
                ));
            }
        }
    }
    Ok(())
}

fn validate_final_answer_facts(timeline: &Value, events: &[Value]) -> Result<(), String> {
    let durable_events = events
        .iter()
        .filter_map(|event| {
            event
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id, event))
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut expected_final_event_ids = std::collections::HashSet::new();
    for event in events
        .iter()
        .filter(|event| is_projectable_final_answer_event(event))
    {
        let event_id = event
            .get("id")
            .and_then(Value::as_str)
            .filter(|event_id| !event_id.is_empty())
            .ok_or_else(|| {
                "projectable final AgentEvent is missing durable identity".to_string()
            })?;
        if !expected_final_event_ids.insert(event_id) {
            return Err(format!(
                "projectable final AgentEvent {event_id} has duplicate durable identity"
            ));
        }
    }
    let mut used_final_event_ids = std::collections::HashSet::new();
    for block in timeline
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|turn| turn.get("blocks").and_then(Value::as_array))
        .flatten()
        .filter(|block| block.get("entryRole").and_then(Value::as_str) == Some("finalAnswer"))
    {
        if block.get("durability").and_then(Value::as_str) != Some("committed")
            || block.get("narrativeKind").and_then(Value::as_str) != Some("assistantText")
        {
            return Err("final answer is not a committed assistantText projection".to_string());
        }
        let provenance = block
            .get("provenance")
            .ok_or_else(|| "final answer is missing provenance".to_string())?;
        if provenance.get("origin").and_then(Value::as_str) != Some("provider")
            || provenance.get("authority").and_then(Value::as_str) != Some("session")
        {
            return Err("final answer has invalid projection authority".to_string());
        }
        let source_refs = provenance
            .get("sourceEventRefs")
            .and_then(Value::as_array)
            .filter(|refs| refs.len() == 1)
            .ok_or_else(|| {
                "final answer must reference exactly one durable AgentEvent".to_string()
            })?;
        let event_ref = source_refs[0]
            .as_str()
            .and_then(|reference| reference.strip_prefix("event:"))
            .filter(|id| !id.starts_with("live:") && !id.is_empty())
            .ok_or_else(|| "final answer has an invalid AgentEvent reference".to_string())?;
        let fact_refs = provenance
            .get("factRefs")
            .and_then(Value::as_array)
            .ok_or_else(|| "final answer is missing durable factRefs".to_string())?;
        if fact_refs.len() != 1
            || fact_refs[0].as_str() != Some(source_refs[0].as_str().unwrap_or_default())
        {
            return Err(
                "final answer sourceEventRefs and factRefs do not identify one fact".to_string(),
            );
        }
        if !used_final_event_ids.insert(event_ref) {
            return Err("one durable final AgentEvent cannot produce multiple answers".to_string());
        }
        let event = durable_events
            .get(event_ref)
            .ok_or_else(|| "final answer references a non-durable AgentEvent".to_string())?;
        if !is_projectable_final_answer_event(event) {
            return Err(
                "final answer reference is not a projectable assistant_msg/channel=final fact"
                    .to_string(),
            );
        }
        let expected_block_id = format!("timeline:final:{event_ref}");
        if block.get("id").and_then(Value::as_str) != Some(expected_block_id.as_str()) {
            return Err(
                "final answer block identity does not match its durable AgentEvent".to_string(),
            );
        }
        let content = event
            .get("payload")
            .and_then(|payload| payload.get("content"))
            .and_then(Value::as_str)
            .ok_or_else(|| "durable final AgentEvent has no non-empty content".to_string())?;
        if content.trim().is_empty() {
            return Err("durable final AgentEvent has no non-empty content".to_string());
        }
        if block.get("bodyMarkdown").and_then(Value::as_str) != Some(content) {
            return Err(
                "final answer body does not match its durable AgentEvent content".to_string(),
            );
        }
    }
    if used_final_event_ids != expected_final_event_ids {
        let missing = expected_final_event_ids
            .difference(&used_final_event_ids)
            .copied()
            .collect::<Vec<_>>();
        return Err(format!(
            "runtime timeline omits durable final AgentEvent(s): {}",
            missing.join(",")
        ));
    }
    Ok(())
}

fn validate_pending_interaction_opening_fact(
    timeline: &Value,
    events: &[Value],
) -> Result<(), String> {
    let Some(pending) = timeline
        .pointer("/interactionProjection/pending")
        .filter(|value| value.is_object())
    else {
        return Ok(());
    };
    let kind = pending
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "pending interaction is missing kind".to_string())?;
    let revision = pending
        .get("interactionRevision")
        .and_then(Value::as_str)
        .ok_or_else(|| "pending interaction is missing interactionRevision".to_string())?;
    let target_id = pending
        .get("targetId")
        .and_then(Value::as_str)
        .ok_or_else(|| "pending interaction is missing targetId".to_string())?;
    let opening_index = events
        .iter()
        .position(|event| event.get("id").and_then(Value::as_str) == Some(revision))
        .ok_or_else(|| {
            "pending interaction revision is not a durable opening AgentEvent".to_string()
        })?;
    let opening = &events[opening_index];
    let event_kind = opening
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = opening.get("payload").unwrap_or(&Value::Null);
    let run_id = payload.get("runId").and_then(Value::as_str);
    let expected_target = match kind {
        "requirement" if event_kind == "requirement_confirmation" => {
            payload.get("requirementId").and_then(Value::as_str)
        }
        "plan" if matches!(event_kind, "plan_card" | "plan_review") => {
            payload.get("planId").and_then(Value::as_str)
        }
        "review" if event_kind == "review_summary" => {
            payload.get("reviewId").and_then(Value::as_str)
        }
        "permission" if event_kind == "permission_request" => payload
            .get("id")
            .or_else(|| payload.get("requestId"))
            .or_else(|| payload.get("permissionId"))
            .and_then(Value::as_str),
        _ => None,
    };
    if expected_target != Some(target_id) {
        return Err(
            "pending interaction target does not match its durable opening AgentEvent".to_string(),
        );
    }
    let opening_is_waiting = match kind {
        "requirement" => {
            payload.get("confirmable").and_then(Value::as_bool) == Some(true)
                && payload.get("status").and_then(Value::as_str) == Some("waitingUserConfirmation")
        }
        "plan" => payload.get("confirmable").and_then(Value::as_bool) == Some(true),
        "review" => {
            payload.get("confirmable").and_then(Value::as_bool) == Some(true)
                && payload.get("status").and_then(Value::as_str) == Some("waitingUserReview")
        }
        "permission" => true,
        _ => false,
    };
    if !opening_is_waiting {
        return Err(
            "pending interaction opening AgentEvent is not awaiting user input".to_string(),
        );
    }
    if events
        .iter()
        .skip(opening_index + 1)
        .any(|event| interaction_event_settles(event, kind, run_id, target_id))
    {
        return Err("pending interaction was already settled by a durable AgentEvent".to_string());
    }
    if kind != "permission" && pending.get("runId").and_then(Value::as_str) != run_id {
        return Err(
            "pending interaction run does not match its durable opening AgentEvent".to_string(),
        );
    }
    if kind == "review" && pending.get("reviewId").and_then(Value::as_str) != Some(target_id) {
        return Err(
            "pending review identity does not match its durable opening AgentEvent".to_string(),
        );
    }
    let expected_interaction_id = format!(
        "interaction:{kind}:{}:{target_id}",
        run_id.unwrap_or("session")
    );
    if pending.get("interactionId").and_then(Value::as_str)
        != Some(expected_interaction_id.as_str())
    {
        return Err(
            "pending interactionId does not match its durable opening AgentEvent".to_string(),
        );
    }
    Ok(())
}

fn interaction_event_settles(
    event: &Value,
    kind: &str,
    run_id: Option<&str>,
    target_id: &str,
) -> bool {
    let event_kind = event
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = event.get("payload").unwrap_or(&Value::Null);
    let status = payload.get("status").and_then(Value::as_str);
    let terminal = matches!(
        status,
        Some(
            "accepted"
                | "rejected"
                | "needsRevision"
                | "cancelled"
                | "failed"
                | "completed"
                | "superseded"
                | "expired"
        )
    );
    if event_kind == "session_run_state"
        && matches!(status, Some("completed" | "failed" | "cancelled"))
        && payload.get("runId").and_then(Value::as_str) == run_id
    {
        let owner = payload.get("decisionOwner").unwrap_or(&Value::Null);
        let owner_kind = payload
            .get("decisionKind")
            .and_then(Value::as_str)
            .or_else(|| owner.get("kind").and_then(Value::as_str));
        let owner_target = match kind {
            "requirement" => payload
                .get("requirementId")
                .or_else(|| payload.get("targetId"))
                .or_else(|| owner.get("requirementId"))
                .or_else(|| owner.get("targetId"))
                .and_then(Value::as_str),
            "plan" => payload
                .get("planId")
                .or_else(|| payload.get("sourcePlanId"))
                .or_else(|| payload.get("targetId"))
                .or_else(|| owner.get("planId"))
                .or_else(|| owner.get("targetId"))
                .and_then(Value::as_str),
            "review" => payload
                .get("reviewId")
                .or_else(|| payload.get("targetId"))
                .or_else(|| owner.get("reviewId"))
                .or_else(|| owner.get("targetId"))
                .and_then(Value::as_str),
            _ => None,
        };
        if owner_kind == Some(kind) && owner_target == Some(target_id) {
            return true;
        }
    }
    match kind {
        "requirement" => {
            event_kind == "requirement_decision"
                && terminal
                && payload.get("runId").and_then(Value::as_str) == run_id
                && payload.get("requirementId").and_then(Value::as_str) == Some(target_id)
        }
        "plan" => {
            event_kind == "plan_review"
                && terminal
                && payload.get("runId").and_then(Value::as_str) == run_id
                && payload.get("planId").and_then(Value::as_str) == Some(target_id)
        }
        "review" => {
            event_kind == "review_summary"
                && terminal
                && payload.get("runId").and_then(Value::as_str) == run_id
                && payload.get("reviewId").and_then(Value::as_str) == Some(target_id)
        }
        "permission" => {
            event_kind == "permission_result"
                && payload
                    .get("permissionId")
                    .or_else(|| payload.get("id"))
                    .and_then(Value::as_str)
                    == Some(target_id)
        }
        _ => false,
    }
}

fn validate_shared_projection_blocks(timeline: &Value) -> Result<(), String> {
    let turns = timeline
        .get("turns")
        .and_then(Value::as_array)
        .ok_or_else(|| "session bridge timeline is missing structured turns".to_string())?;
    for block in turns
        .iter()
        .filter_map(|turn| turn.get("blocks").and_then(Value::as_array))
        .flatten()
    {
        validate_shared_projection_block(block)?;
    }

    let pending = timeline
        .pointer("/interactionProjection/pending")
        .filter(|value| value.is_object());
    if let Some(pending) = pending {
        let block_id = pending
            .get("blockId")
            .and_then(Value::as_str)
            .ok_or_else(|| "pending interaction is missing blockId".to_string())?;
        let interaction_id = pending
            .get("interactionId")
            .and_then(Value::as_str)
            .ok_or_else(|| "pending interaction is missing interactionId".to_string())?;
        let interaction_revision = pending
            .get("interactionRevision")
            .and_then(Value::as_str)
            .ok_or_else(|| "pending interaction is missing interactionRevision".to_string())?;
        let target_id = pending
            .get("targetId")
            .and_then(Value::as_str)
            .ok_or_else(|| "pending interaction is missing targetId".to_string())?;
        let block = turns
            .iter()
            .filter_map(|turn| turn.get("blocks").and_then(Value::as_array))
            .flatten()
            .find(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
            .ok_or_else(|| "pending interaction block is missing".to_string())?;
        let interaction = block
            .get("interaction")
            .filter(|value| value.is_object())
            .ok_or_else(|| "pending interaction block has no interaction view".to_string())?;
        if interaction.get("interactionId").and_then(Value::as_str) != Some(interaction_id)
            || interaction
                .get("interactionRevision")
                .and_then(Value::as_str)
                != Some(interaction_revision)
            || interaction.get("targetId").and_then(Value::as_str) != Some(target_id)
        {
            return Err("pending interaction identity does not match its block".to_string());
        }
        if pending.get("kind").and_then(Value::as_str) == Some("permission") {
            validate_permission_request(pending.get("request").unwrap_or(&Value::Null))?;
        }
    }
    Ok(())
}

fn validate_shared_projection_block(block: &Value) -> Result<(), String> {
    validate_object_keys(
        block,
        &[
            "id",
            "sequence",
            "revision",
            "deliveryMode",
            "durability",
            "kind",
            "narrativeKind",
            "entryRole",
            "activity",
            "title",
            "summary",
            "status",
            "defaultCollapsed",
            "bodyMarkdown",
            "localizedContent",
            "structuredProjection",
            "decisionRequest",
            "interaction",
            "confirmable",
            "attachments",
            "feedbackRef",
            "displayHints",
            "evidenceRefs",
            "provenance",
            "languageBinding",
            "taskProjectionRef",
        ],
        "timeline block",
    )?;
    let block_id = block
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("<unknown>");
    require_nonempty_string_field(block, "id", "timeline block")?;
    optional_u64_field(block, "sequence", "timeline block")?;
    optional_u64_field(block, "revision", "timeline block")?;
    optional_enum_field(
        block,
        "deliveryMode",
        &["live", "buffered", "replay"],
        "timeline block",
    )?;
    enum_field(
        block,
        "durability",
        &["live", "committed"],
        "timeline block",
    )?;
    enum_field(
        block,
        "kind",
        &[
            "user",
            "assistant",
            "thinking",
            "stage",
            "toolBatch",
            "permission",
            "plan",
            "review",
            "error",
            "turnActions",
        ],
        "timeline block",
    )?;
    optional_enum_field(
        block,
        "narrativeKind",
        &[
            "user",
            "thinking",
            "assistantNarration",
            "assistantText",
            "operationEvidence",
            "requirement",
            "plan",
            "permission",
            "verification",
            "review",
            "diagnostic",
        ],
        "timeline block",
    )?;
    enum_field(
        block,
        "entryRole",
        &[
            "userMessage",
            "agentUpdate",
            "activityGroup",
            "evidence",
            "interaction",
            "finalAnswer",
            "diagnostic",
        ],
        "timeline block",
    )?;
    for field in ["title", "summary"] {
        require_string_field(block, field, "timeline block")?;
    }
    enum_field(
        block,
        "status",
        &[
            "queued",
            "running",
            "waiting",
            "blocked",
            "completed",
            "cancelled",
            "failed",
        ],
        "timeline block",
    )?;
    require_bool_field(block, "defaultCollapsed", "timeline block")?;
    optional_string_field(block, "bodyMarkdown", "timeline block")?;
    optional_bool_field(block, "confirmable", "timeline block")?;
    optional_string_array_field(block, "evidenceRefs", "timeline block")?;
    optional_string_field(block, "taskProjectionRef", "timeline block")?;
    let entry_role = block.get("entryRole").and_then(Value::as_str);
    let durability = block.get("durability").and_then(Value::as_str);
    if block.get("kind").and_then(Value::as_str) == Some("thinking")
        || block.get("narrativeKind").and_then(Value::as_str) == Some("thinking")
    {
        return Err(format!(
            "session bridge timeline block {block_id} exposes private reasoning"
        ));
    }
    if entry_role == Some("finalAnswer") && durability != Some("committed") {
        return Err(format!(
            "session bridge timeline block {block_id} exposes an uncommitted final answer"
        ));
    }
    if let Some(activity) = block.get("activity") {
        validate_object_keys(
            activity,
            &[
                "activityId",
                "activityRevision",
                "kind",
                "status",
                "title",
                "summary",
                "source",
                "runId",
                "planId",
                "draftId",
                "targets",
                "actionIds",
                "workUnitIds",
                "resourcePacketIds",
                "toolName",
                "operation",
                "itemCount",
                "errorCode",
                "errorMessage",
            ],
            "timeline activity",
        )?;
        require_nonempty_string_field(activity, "activityId", "timeline activity")?;
        optional_u64_field(activity, "activityRevision", "timeline activity")?;
        enum_field(
            activity,
            "kind",
            &[
                "resourceSearch",
                "resourceRead",
                "editBatchQueued",
                "editFileStarted",
                "editFileCompleted",
                "editFileFailed",
                "toolExecution",
                "reviewCheckpoint",
                "diagnostic",
            ],
            "timeline activity",
        )?;
        enum_field(
            activity,
            "status",
            &[
                "queued",
                "running",
                "waiting",
                "blocked",
                "completed",
                "cancelled",
                "failed",
            ],
            "timeline activity",
        )?;
        for field in ["title", "summary"] {
            require_string_field(activity, field, "timeline activity")?;
        }
        enum_field(
            activity,
            "source",
            &["session", "kernel", "provider", "llm"],
            "timeline activity",
        )?;
        for field in [
            "runId",
            "planId",
            "draftId",
            "toolName",
            "operation",
            "errorCode",
            "errorMessage",
        ] {
            optional_string_field(activity, field, "timeline activity")?;
        }
        for field in ["targets", "actionIds", "workUnitIds", "resourcePacketIds"] {
            optional_string_array_field(activity, field, "timeline activity")?;
        }
        optional_u64_field(activity, "itemCount", "timeline activity")?;
    }
    if let Some(provenance) = block.get("provenance") {
        validate_object_keys(
            provenance,
            &[
                "origin",
                "authority",
                "sourceEventRefs",
                "factRefs",
                "evidenceRefs",
            ],
            "timeline provenance",
        )?;
        enum_field(
            provenance,
            "origin",
            &["user", "session", "kernel", "provider"],
            "timeline provenance",
        )?;
        enum_field(
            provenance,
            "authority",
            &["user", "session", "kernel"],
            "timeline provenance",
        )?;
        for field in ["sourceEventRefs", "factRefs", "evidenceRefs"] {
            require_string_array_field(provenance, field, "timeline provenance")?;
        }
    } else {
        return Err("timeline block requires provenance".to_string());
    }
    if let Some(binding) = block.get("languageBinding") {
        validate_language_binding(binding, "timeline language binding")?;
    } else {
        return Err("timeline block requires languageBinding".to_string());
    }
    if let Some(localized) = block.get("localizedContent") {
        validate_object_keys(
            localized,
            &["text", "messageKey", "messageArgs"],
            "timeline localized content",
        )?;
        optional_string_field(localized, "text", "timeline localized content")?;
        optional_string_field(localized, "messageKey", "timeline localized content")?;
        optional_string_map_field(localized, "messageArgs", "timeline localized content")?;
    }
    if let Some(decision_request) = block.get("decisionRequest") {
        validate_decision_request(decision_request, "timeline decision request")?;
    }
    if let Some(interaction) = block.get("interaction") {
        validate_object_keys(
            interaction,
            &[
                "kind",
                "interactionId",
                "interactionRevision",
                "targetId",
                "runId",
                "state",
                "decisionRequest",
                "selectedDecision",
            ],
            "timeline interaction",
        )?;
        enum_field(
            interaction,
            "kind",
            &["requirement", "plan", "permission", "review"],
            "timeline interaction",
        )?;
        for field in ["interactionId", "interactionRevision", "targetId"] {
            require_nonempty_string_field(interaction, field, "timeline interaction")?;
        }
        optional_string_field(interaction, "runId", "timeline interaction")?;
        enum_field(
            interaction,
            "state",
            &[
                "open",
                "submitting",
                "accepted",
                "rejected",
                "needsRevision",
                "superseded",
                "expired",
            ],
            "timeline interaction",
        )?;
        if let Some(request) = interaction.get("decisionRequest") {
            validate_decision_request(request, "timeline interaction decision request")?;
        }
        if let Some(selected) = interaction.get("selectedDecision") {
            validate_object_keys(
                selected,
                &["decision", "source", "decidedAt"],
                "timeline selected decision",
            )?;
            require_string_field(selected, "decision", "timeline selected decision")?;
            enum_field(
                selected,
                "source",
                &["button", "freeText"],
                "timeline selected decision",
            )?;
            optional_string_field(selected, "decidedAt", "timeline selected decision")?;
        }
    }
    if let Some(structured) = block.get("structuredProjection") {
        validate_object_keys(
            structured,
            &[
                "kind",
                "schemaVersion",
                "title",
                "titleKey",
                "titleArgs",
                "summary",
                "summaryKey",
                "messageArgs",
                "sections",
            ],
            "structured projection",
        )?;
        enum_field(
            structured,
            "kind",
            &["plan", "review"],
            "structured projection",
        )?;
        require_string_field(structured, "schemaVersion", "structured projection")?;
        for field in ["title", "titleKey", "summary", "summaryKey"] {
            optional_string_field(structured, field, "structured projection")?;
        }
        for field in ["titleArgs", "messageArgs"] {
            optional_string_map_field(structured, field, "structured projection")?;
        }
        let sections = structured
            .get("sections")
            .and_then(Value::as_array)
            .ok_or_else(|| "structured projection requires sections".to_string())?;
        for section in sections {
            validate_object_keys(
                section,
                &[
                    "sectionId",
                    "titleKey",
                    "titleArgs",
                    "emptyMessageKey",
                    "items",
                ],
                "structured projection section",
            )?;
            require_string_field(section, "sectionId", "structured projection section")?;
            require_string_field(section, "titleKey", "structured projection section")?;
            optional_string_map_field(section, "titleArgs", "structured projection section")?;
            optional_string_field(section, "emptyMessageKey", "structured projection section")?;
            let items = section
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| "structured projection section requires items".to_string())?;
            for item in items {
                validate_object_keys(
                    item,
                    &[
                        "itemId",
                        "kind",
                        "text",
                        "messageKey",
                        "messageArgs",
                        "status",
                        "targetRefs",
                        "auditRefs",
                        "objective",
                        "acceptanceCriteria",
                        "failureConditions",
                    ],
                    "structured projection item",
                )?;
                require_string_field(item, "itemId", "structured projection item")?;
                require_string_field(item, "kind", "structured projection item")?;
                for field in ["text", "messageKey", "status", "objective"] {
                    optional_string_field(item, field, "structured projection item")?;
                }
                optional_string_map_field(item, "messageArgs", "structured projection item")?;
                for field in [
                    "targetRefs",
                    "auditRefs",
                    "acceptanceCriteria",
                    "failureConditions",
                ] {
                    optional_string_array_field(item, field, "structured projection item")?;
                }
            }
        }
    }
    if let Some(attachments) = block.get("attachments") {
        let attachments = attachments
            .as_array()
            .ok_or_else(|| "timeline attachments must be an array".to_string())?;
        for attachment in attachments {
            validate_object_keys(
                attachment,
                &[
                    "kind",
                    "path",
                    "absolutePath",
                    "resourceId",
                    "folderId",
                    "source",
                    "scope",
                ],
                "timeline attachment",
            )?;
            enum_field(
                attachment,
                "kind",
                &["file", "directory"],
                "timeline attachment",
            )?;
            require_string_field(attachment, "path", "timeline attachment")?;
            for field in ["absolutePath", "resourceId", "folderId"] {
                optional_string_field(attachment, field, "timeline attachment")?;
            }
            enum_field(
                attachment,
                "source",
                &["mention", "contextMenu", "userSelected"],
                "timeline attachment",
            )?;
            enum_field(
                attachment,
                "scope",
                &["message", "session"],
                "timeline attachment",
            )?;
        }
    }
    if let Some(feedback_ref) = block.get("feedbackRef") {
        validate_object_keys(
            feedback_ref,
            &["eventId", "sessionId", "kind"],
            "timeline feedback ref",
        )?;
        for field in ["eventId", "sessionId", "kind"] {
            require_string_field(feedback_ref, field, "timeline feedback ref")?;
        }
    }
    if let Some(display_hints) = block.get("displayHints") {
        validate_object_keys(
            display_hints,
            &[
                "density",
                "evidenceMode",
                "collapseAfterComplete",
                "checkpointKind",
                "showInTaskList",
                "taskListLabel",
                "taskListSummary",
                "phase",
            ],
            "timeline display hints",
        )?;
        optional_enum_field(
            display_hints,
            "density",
            &["normal", "compact", "debug"],
            "timeline display hints",
        )?;
        optional_enum_field(
            display_hints,
            "evidenceMode",
            &["inline", "collapsed", "debugOnly"],
            "timeline display hints",
        )?;
        optional_bool_field(
            display_hints,
            "collapseAfterComplete",
            "timeline display hints",
        )?;
        optional_enum_field(
            display_hints,
            "checkpointKind",
            &[
                "turnStart",
                "llmProposal",
                "resourcePacket",
                "userGuidance",
                "permission",
                "review",
                "final",
                "diagnostic",
            ],
            "timeline display hints",
        )?;
        optional_bool_field(display_hints, "showInTaskList", "timeline display hints")?;
        optional_string_field(display_hints, "taskListLabel", "timeline display hints")?;
        optional_string_field(display_hints, "taskListSummary", "timeline display hints")?;
        optional_enum_field(
            display_hints,
            "phase",
            &["explore", "execute"],
            "timeline display hints",
        )?;
    }
    Ok(())
}

fn validate_language_binding(binding: &Value, label: &str) -> Result<(), String> {
    validate_object_keys(
        binding,
        &["language", "revision", "status", "sourceTurnId"],
        label,
    )?;
    enum_field(binding, "language", &["zh-CN", "en-US", "neutral"], label)?;
    optional_u64_field(binding, "revision", label)?;
    enum_field(
        binding,
        "status",
        &[
            "pending",
            "resolved",
            "fallback",
            "superseded",
            "unavailable",
        ],
        label,
    )?;
    optional_string_field(binding, "sourceTurnId", label)
}

fn validate_decision_request(request: &Value, label: &str) -> Result<(), String> {
    validate_object_keys(
        request,
        &["id", "reason", "summary", "allowsFreeform", "options"],
        label,
    )?;
    for field in ["id", "reason", "summary"] {
        optional_string_field(request, field, label)?;
    }
    require_bool_field(request, "allowsFreeform", label)?;
    let options = request
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{label} requires options"))?;
    for option in options {
        validate_object_keys(
            option,
            &["id", "label", "description", "recommended", "effect"],
            "decision option",
        )?;
        require_string_field(option, "id", "decision option")?;
        require_string_field(option, "label", "decision option")?;
        optional_string_field(option, "description", "decision option")?;
        optional_bool_field(option, "recommended", "decision option")?;
        if let Some(effect) = option.get("effect") {
            validate_object_keys(effect, &["kind", "reason"], "decision option effect")?;
            let kind = effect
                .get("kind")
                .and_then(Value::as_str)
                .ok_or_else(|| "decision option effect requires kind".to_string())?;
            if !matches!(
                kind,
                "continueWithAction" | "skipCurrentTask" | "replan" | "finishRun"
            ) {
                return Err("decision option effect has unsupported kind".to_string());
            }
            optional_string_field(effect, "reason", "decision option effect")?;
            if kind != "replan" && effect.get("reason").is_some() {
                return Err("only a replan decision option may include a reason".to_string());
            }
        }
    }
    Ok(())
}

fn validate_permission_request(request: &Value) -> Result<(), String> {
    validate_object_keys(
        request,
        &[
            "id",
            "runId",
            "requestKind",
            "permissionBundleId",
            "contractId",
            "affectedOperationIds",
            "workUnitIds",
            "toolId",
            "toolName",
            "riskLevel",
            "summary",
            "diff",
            "argumentsPreview",
        ],
        "permission request",
    )?;
    require_nonempty_string_field(request, "id", "permission request")?;
    require_string_field(request, "toolName", "permission request")?;
    require_string_field(request, "summary", "permission request")?;
    optional_enum_field(
        request,
        "requestKind",
        &["runtimePermission", "scopeExpansion"],
        "permission request",
    )?;
    enum_field(
        request,
        "riskLevel",
        &["low", "medium", "high", "critical"],
        "permission request",
    )?;
    for field in [
        "runId",
        "permissionBundleId",
        "contractId",
        "toolId",
        "diff",
        "argumentsPreview",
    ] {
        optional_string_field(request, field, "permission request")?;
    }
    optional_string_array_field(request, "affectedOperationIds", "permission request")?;
    optional_string_array_field(request, "workUnitIds", "permission request")
}

fn require_target_alias(value: &Value, field: &str, label: &str) -> Result<(), String> {
    require_nonempty_string_field(value, field, label)?;
    if value.get(field).and_then(Value::as_str) != value.get("targetId").and_then(Value::as_str) {
        return Err(format!("{label} {field} does not match targetId"));
    }
    Ok(())
}

fn require_string_field(value: &Value, field: &str, label: &str) -> Result<(), String> {
    if value.get(field).and_then(Value::as_str).is_none() {
        return Err(format!("{label} requires string {field}"));
    }
    Ok(())
}

fn require_nonempty_string_field(value: &Value, field: &str, label: &str) -> Result<(), String> {
    if value
        .get(field)
        .and_then(Value::as_str)
        .filter(|field| !field.trim().is_empty())
        .is_none()
    {
        return Err(format!("{label} requires non-empty string {field}"));
    }
    Ok(())
}

fn require_event_fact_ref(value: &Value, field: &str, label: &str) -> Result<(), String> {
    if value
        .get(field)
        .and_then(Value::as_str)
        .is_some_and(is_event_fact_ref)
    {
        return Ok(());
    }
    Err(format!(
        "{label} {field} must identify one durable AgentEvent"
    ))
}

fn is_event_fact_ref(value: &str) -> bool {
    value
        .strip_prefix("event:")
        .is_some_and(|event_id| !event_id.trim().is_empty() && !event_id.starts_with("live:"))
}

fn optional_string_field(value: &Value, field: &str, label: &str) -> Result<(), String> {
    if value.get(field).is_some_and(|value| !value.is_string()) {
        return Err(format!("{label} has invalid string {field}"));
    }
    Ok(())
}

fn require_u64_field(value: &Value, field: &str, label: &str) -> Result<(), String> {
    if value
        .get(field)
        .and_then(json_safe_nonnegative_integer)
        .is_none()
    {
        return Err(format!("{label} requires non-negative integer {field}"));
    }
    Ok(())
}

fn optional_u64_field(value: &Value, field: &str, label: &str) -> Result<(), String> {
    if value
        .get(field)
        .is_some_and(|value| json_safe_nonnegative_integer(value).is_none())
    {
        return Err(format!("{label} has invalid non-negative integer {field}"));
    }
    Ok(())
}

pub(crate) fn json_safe_nonnegative_integer(value: &Value) -> Option<u64> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    if let Some(integer) = value.as_u64() {
        return (integer <= MAX_SAFE_INTEGER).then_some(integer);
    }
    let number = value.as_f64()?;
    (number.is_finite()
        && number >= 0.0
        && number.fract() == 0.0
        && number <= MAX_SAFE_INTEGER as f64)
        .then_some(number as u64)
}

pub(crate) fn canonicalize_projection_safe_integers(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                canonicalize_projection_safe_integers(value);
            }
        }
        Value::Object(object) => {
            for value in object.values_mut() {
                canonicalize_projection_safe_integers(value);
            }
        }
        Value::Number(_) => {
            if let Some(integer) = json_safe_nonnegative_integer(value) {
                *value = Value::Number(integer.into());
            }
        }
        _ => {}
    }
}

fn require_bool_field(value: &Value, field: &str, label: &str) -> Result<(), String> {
    if value.get(field).and_then(Value::as_bool).is_none() {
        return Err(format!("{label} requires boolean {field}"));
    }
    Ok(())
}

fn optional_bool_field(value: &Value, field: &str, label: &str) -> Result<(), String> {
    if value
        .get(field)
        .is_some_and(|value| value.as_bool().is_none())
    {
        return Err(format!("{label} has invalid boolean {field}"));
    }
    Ok(())
}

fn enum_field(value: &Value, field: &str, allowed: &[&str], label: &str) -> Result<(), String> {
    let candidate = value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{label} requires enum {field}"))?;
    if !allowed.contains(&candidate) {
        return Err(format!("{label} has unsupported {field}"));
    }
    Ok(())
}

fn optional_enum_field(
    value: &Value,
    field: &str,
    allowed: &[&str],
    label: &str,
) -> Result<(), String> {
    let Some(candidate) = value.get(field) else {
        return Ok(());
    };
    let candidate = candidate
        .as_str()
        .ok_or_else(|| format!("{label} has invalid enum {field}"))?;
    if !allowed.contains(&candidate) {
        return Err(format!("{label} has unsupported {field}"));
    }
    Ok(())
}

fn require_string_array_field(value: &Value, field: &str, label: &str) -> Result<(), String> {
    let values = value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{label} requires string array {field}"))?;
    if values.iter().any(|value| !value.is_string()) {
        return Err(format!("{label} has invalid string array {field}"));
    }
    Ok(())
}

fn strict_nonempty_unique_string_array<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> Result<Vec<&'a str>, String> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{label} must be an array"))?;
    let mut seen = std::collections::HashSet::new();
    values
        .iter()
        .map(|value| {
            let value = value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("{label} must contain non-empty strings"))?;
            if !seen.insert(value) {
                return Err(format!("{label} must not contain duplicate identities"));
            }
            Ok(value)
        })
        .collect()
}

fn is_sorted_strictly(values: &[&str]) -> bool {
    values.windows(2).all(|pair| pair[0] < pair[1])
}

fn optional_string_array_field(value: &Value, field: &str, label: &str) -> Result<(), String> {
    let Some(values) = value.get(field) else {
        return Ok(());
    };
    let values = values
        .as_array()
        .ok_or_else(|| format!("{label} has invalid string array {field}"))?;
    if values.iter().any(|value| !value.is_string()) {
        return Err(format!("{label} has invalid string array {field}"));
    }
    Ok(())
}

fn optional_string_map_field(value: &Value, field: &str, label: &str) -> Result<(), String> {
    let Some(values) = value.get(field) else {
        return Ok(());
    };
    let values = values
        .as_object()
        .ok_or_else(|| format!("{label} has invalid string map {field}"))?;
    if values.values().any(|value| !value.is_string()) {
        return Err(format!("{label} has invalid string map {field}"));
    }
    Ok(())
}

fn validate_object_keys(value: &Value, allowed: &[&str], label: &str) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object"))?;
    if let Some(unexpected) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("{label} contains unsupported field {unexpected}"));
    }
    Ok(())
}

pub(crate) fn validate_agent_timeline_delta(
    state: &AppState,
    session_id: &str,
    delta: &Value,
) -> Result<(), String> {
    let object = delta
        .as_object()
        .ok_or_else(|| "timeline delta must be an object".to_string())?;
    if object.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.shared-conversation-projection-delta.v2")
    {
        return Err("timeline delta has an unsupported schema version".to_string());
    }
    if object.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err("timeline delta does not belong to the route session".to_string());
    }
    for field in ["op", "runId", "turnId", "blockId"] {
        if object
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .is_none()
        {
            return Err(format!("timeline delta requires {field}"));
        }
    }
    for field in ["turnSeq", "blockSeq", "revision"] {
        if object
            .get(field)
            .and_then(json_safe_nonnegative_integer)
            .is_none()
        {
            return Err(format!("timeline delta requires numeric {field}"));
        }
    }
    optional_u64_field(delta, "deltaSeq", "timeline delta")?;
    optional_string_array_field(delta, "sourceEventRefs", "timeline delta")?;
    if contains_private_projection_key(delta) {
        return Err("timeline delta contains a private analysis payload".to_string());
    }
    let op = object.get("op").and_then(Value::as_str).unwrap_or_default();
    let mut allowed = vec![
        "schemaVersion",
        "op",
        "sessionId",
        "runId",
        "turnId",
        "turnSeq",
        "blockId",
        "blockSeq",
        "revision",
        "deltaSeq",
        "sourceEventRefs",
    ];
    match op {
        "timeline.synced" => allowed.extend(["timeline", "deliveryModes"]),
        "block.started" => allowed.extend(["block", "deliveryMode"]),
        "block.updated" => allowed.push("block"),
        "text.append" => allowed.extend([
            "segmentId",
            "offset",
            "text",
            "format",
            "fullCharLength",
            "visibleCharLength",
            "truncated",
            "fullTextRef",
        ]),
        "activity.upsert" => allowed.extend(["activityId", "activityRevision", "activity"]),
        "block.completed" => allowed.extend(["status", "contentHash"]),
        "block.committed" => allowed.extend([
            "committedEventIds",
            "finalRevision",
            "finalContentHash",
            "block",
        ]),
        "block.removed" => {}
        _ => return Err("timeline delta has an unsupported operation".to_string()),
    }
    if let Some(unexpected) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!(
            "timeline delta operation {op} contains unsupported field {unexpected}"
        ));
    }

    match op {
        "timeline.synced" => {
            let timeline = object
                .get("timeline")
                .ok_or_else(|| "timeline.synced is missing timeline".to_string())?;
            validate_shared_projection_timeline(timeline)?;
            let canonical = session_timeline(state, session_id)
                .ok_or_else(|| "canonical Session timeline is unavailable".to_string())?;
            if canonical != *timeline {
                return Err(
                    "timeline.synced does not match the durably committed Session timeline"
                        .to_string(),
                );
            }
            if object
                .get("revision")
                .and_then(json_safe_nonnegative_integer)
                != timeline
                    .get("revision")
                    .and_then(json_safe_nonnegative_integer)
            {
                return Err(
                    "timeline.synced revision does not match the canonical timeline".to_string(),
                );
            }
            if let Some(delivery_modes) = object.get("deliveryModes") {
                let delivery_modes = delivery_modes
                    .as_object()
                    .ok_or_else(|| "timeline.synced has invalid deliveryModes".to_string())?;
                if delivery_modes
                    .values()
                    .any(|mode| !matches!(mode.as_str(), Some("live" | "buffered" | "replay")))
                {
                    return Err("timeline.synced has unsupported delivery mode".to_string());
                }
            }
        }
        "block.started" | "block.updated" | "block.committed" => {
            let block = object
                .get("block")
                .ok_or_else(|| format!("{op} is missing block"))?;
            validate_shared_projection_block(block)?;
            if block.get("id").and_then(Value::as_str)
                != object.get("blockId").and_then(Value::as_str)
            {
                return Err(format!("{op} block identity does not match blockId"));
            }
            if block.get("entryRole").and_then(Value::as_str) == Some("finalAnswer") {
                return Err(
                    "committed final answers are delivered only by canonical timeline.synced"
                        .to_string(),
                );
            }
            if block
                .get("sequence")
                .and_then(json_safe_nonnegative_integer)
                != object
                    .get("blockSeq")
                    .and_then(json_safe_nonnegative_integer)
                || block
                    .get("revision")
                    .and_then(json_safe_nonnegative_integer)
                    != object
                        .get("revision")
                        .and_then(json_safe_nonnegative_integer)
            {
                return Err(format!(
                    "{op} block sequence or revision does not match delta"
                ));
            }
            if op == "block.started" {
                enum_field(
                    delta,
                    "deliveryMode",
                    &["live", "buffered", "replay"],
                    "block.started",
                )?;
            }
            if op == "block.committed" {
                require_u64_field(delta, "finalRevision", "block.committed")?;
                optional_string_field(delta, "finalContentHash", "block.committed")?;
                if object
                    .get("finalRevision")
                    .and_then(json_safe_nonnegative_integer)
                    != block
                        .get("revision")
                        .and_then(json_safe_nonnegative_integer)
                {
                    return Err(
                        "block.committed finalRevision does not match block revision".to_string(),
                    );
                }
                let committed_ids = object
                    .get("committedEventIds")
                    .and_then(Value::as_array)
                    .filter(|ids| !ids.is_empty() && ids.iter().all(|id| id.as_str().is_some()))
                    .ok_or_else(|| "block.committed requires committedEventIds".to_string())?;
                let canonical = session_timeline(state, session_id)
                    .ok_or_else(|| "canonical Session timeline is unavailable".to_string())?;
                let block_id = object
                    .get("blockId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let canonical_block = timeline_block(&canonical, block_id).ok_or_else(|| {
                    "committed block is absent from canonical timeline".to_string()
                })?;
                if canonical_block != block {
                    return Err(
                        "block.committed does not match the canonical Session timeline".to_string(),
                    );
                }
                let durable_event_ids = session_projection(state, session_id)
                    .into_iter()
                    .filter_map(|event| event.get("id").and_then(Value::as_str).map(str::to_string))
                    .collect::<std::collections::HashSet<_>>();
                if committed_ids
                    .iter()
                    .any(|id| !id.as_str().is_some_and(|id| durable_event_ids.contains(id)))
                {
                    return Err("block.committed references a non-durable AgentEvent".to_string());
                }
            }
        }
        "text.append" => {
            if object.get("segmentId").and_then(Value::as_str).is_none()
                || object
                    .get("offset")
                    .and_then(json_safe_nonnegative_integer)
                    .is_none()
                || object.get("text").and_then(Value::as_str).is_none()
                || !matches!(
                    object.get("format").and_then(Value::as_str),
                    Some("plain" | "markdown")
                )
            {
                return Err("text.append has an invalid text contract".to_string());
            }
            optional_u64_field(delta, "fullCharLength", "text.append")?;
            optional_u64_field(delta, "visibleCharLength", "text.append")?;
            optional_bool_field(delta, "truncated", "text.append")?;
            optional_string_field(delta, "fullTextRef", "text.append")?;
        }
        "activity.upsert" => {
            let activity = object
                .get("activity")
                .ok_or_else(|| "activity.upsert is missing activity".to_string())?;
            validate_object_keys(
                activity,
                &[
                    "activityId",
                    "activityRevision",
                    "kind",
                    "status",
                    "title",
                    "summary",
                    "source",
                    "runId",
                    "planId",
                    "draftId",
                    "targets",
                    "actionIds",
                    "workUnitIds",
                    "resourcePacketIds",
                    "toolName",
                    "operation",
                    "itemCount",
                    "errorCode",
                    "errorMessage",
                ],
                "timeline delta activity",
            )?;
            require_nonempty_string_field(delta, "activityId", "activity.upsert")?;
            require_u64_field(delta, "activityRevision", "activity.upsert")?;
            if activity.get("activityId").and_then(Value::as_str)
                != object.get("activityId").and_then(Value::as_str)
            {
                return Err(
                    "activity.upsert activity identity does not match activityId".to_string(),
                );
            }
            require_nonempty_string_field(activity, "activityId", "timeline delta activity")?;
            optional_u64_field(activity, "activityRevision", "timeline delta activity")?;
            enum_field(
                activity,
                "kind",
                &[
                    "resourceSearch",
                    "resourceRead",
                    "editBatchQueued",
                    "editFileStarted",
                    "editFileCompleted",
                    "editFileFailed",
                    "toolExecution",
                    "reviewCheckpoint",
                    "diagnostic",
                ],
                "timeline delta activity",
            )?;
            enum_field(
                activity,
                "status",
                &[
                    "queued",
                    "running",
                    "waiting",
                    "blocked",
                    "completed",
                    "cancelled",
                    "failed",
                ],
                "timeline delta activity",
            )?;
            for field in ["title", "summary"] {
                require_string_field(activity, field, "timeline delta activity")?;
            }
            enum_field(
                activity,
                "source",
                &["session", "kernel", "provider", "llm"],
                "timeline delta activity",
            )?;
            for field in [
                "runId",
                "planId",
                "draftId",
                "toolName",
                "operation",
                "errorCode",
                "errorMessage",
            ] {
                optional_string_field(activity, field, "timeline delta activity")?;
            }
            for field in ["targets", "actionIds", "workUnitIds", "resourcePacketIds"] {
                optional_string_array_field(activity, field, "timeline delta activity")?;
            }
            optional_u64_field(activity, "itemCount", "timeline delta activity")?;
        }
        "block.completed" => {
            if !matches!(
                object.get("status").and_then(Value::as_str),
                Some("completed" | "waiting" | "failed" | "blocked" | "cancelled")
            ) {
                return Err("block.completed has an invalid status".to_string());
            }
            optional_string_field(delta, "contentHash", "block.completed")?;
        }
        "block.removed" => {}
        _ => unreachable!("timeline delta operation validated above"),
    }
    Ok(())
}

fn timeline_block<'a>(timeline: &'a Value, block_id: &str) -> Option<&'a Value> {
    timeline
        .get("turns")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|turn| turn.get("blocks").and_then(Value::as_array))
        .flatten()
        .find(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
}

fn timeline_block_in_turn<'a>(
    timeline: &'a Value,
    turn_id: &str,
    block_id: &str,
) -> Option<&'a Value> {
    timeline
        .get("turns")
        .and_then(Value::as_array)?
        .iter()
        .find(|turn| turn.get("id").and_then(Value::as_str) == Some(turn_id))?
        .get("blocks")
        .and_then(Value::as_array)?
        .iter()
        .find(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
}

fn is_projectable_final_answer_event(event: &Value) -> bool {
    if event.get("kind").and_then(Value::as_str) != Some("assistant_msg") {
        return false;
    }
    let Some(payload) = event.get("payload") else {
        return false;
    };
    if payload.get("channel").and_then(Value::as_str) != Some("final")
        || payload.get("diagnostic").and_then(Value::as_bool) == Some(true)
        || payload.get("reasoningTrace").and_then(Value::as_bool) == Some(true)
    {
        return false;
    }
    if matches!(
        payload.get("visibility").and_then(Value::as_str),
        Some("hidden" | "debug")
    ) || payload.get("presentation").and_then(Value::as_str) == Some("traceOnly")
    {
        return false;
    }
    event
        .get("display")
        .and_then(|display| display.get("presentation"))
        .and_then(Value::as_str)
        != Some("traceOnly")
}

fn contains_private_projection_key(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(contains_private_projection_key),
        Value::Object(object) => object.iter().any(|(key, value)| {
            matches!(
                key.as_str(),
                "events"
                    | "rawEventRefs"
                    | "metadata"
                    | "payload"
                    | "kernelEvent"
                    | "developerDetails"
                    | "reasoningContent"
                    | "reasoning_content"
                    | "rawProvider"
            ) || contains_private_projection_key(value)
        }),
        _ => false,
    }
}

fn is_final_assistant_event(event: &Value) -> bool {
    if event.get("kind").and_then(Value::as_str) != Some("assistant_msg") {
        return false;
    }
    let Some(payload) = event.get("payload") else {
        return false;
    };
    payload.get("channel").and_then(Value::as_str) == Some("final")
        || payload.get("kind").and_then(Value::as_str) == Some("final")
}

pub(crate) fn latest_final_text(
    state: &AppState,
    session_id: &str,
    start_event_count: usize,
) -> Option<String> {
    session_projection(state, session_id)
        .into_iter()
        .skip(start_event_count)
        .rev()
        .find_map(|event| {
            if is_final_assistant_event(&event) {
                event_message(&event)
            } else {
                None
            }
        })
}

fn event_message(event: &Value) -> Option<String> {
    event
        .get("payload")
        .and_then(|payload| {
            payload
                .get("content")
                .or_else(|| payload.get("summary"))
                .or_else(|| payload.get("message"))
        })
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn fail_run_with_event(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    code: &str,
    message: impl Into<String>,
) {
    let message = message.into();
    match session_run_has_durable_fence(state, session_id, run_id) {
        Ok(false) => {
            let _ = set_run_terminal(state, run_id, "failed", Some(message), None);
            return;
        }
        Err(error) => {
            let _ = set_run_terminal(
                state,
                run_id,
                "failed",
                Some(format!(
                    "{message} (Session run-fence inspection failed: {})",
                    error.message
                )),
                None,
            );
            return;
        }
        Ok(true) => {}
    }
    if let Err(error) = admit_session_release_interaction_claim(state, session_id, run_id) {
        eprintln!(
            "failed to release Session interaction claim for {run_id} after {code} [{}]: {}",
            error.code, error.message
        );
    }
    match admit_session_terminal_close(
        state,
        session_id,
        run_id,
        "failed",
        Some(code),
        Some(&message),
    ) {
        Ok(outcome) => {
            let terminal_message = if outcome.status == "cancelled" {
                "Run cancelled by user.".to_string()
            } else {
                message
            };
            let _ = set_run_terminal(state, run_id, &outcome.status, Some(terminal_message), None);
        }
        Err(error) => {
            eprintln!(
                "failed to persist terminal Session close for {run_id} after {code} [{}]: {}",
                error.code, error.message
            );
            let _ = set_run_terminal(
                state,
                run_id,
                "failed",
                Some(format!(
                    "{message} (Session close persistence failed: {})",
                    error.message
                )),
                None,
            );
        }
    }
}

#[allow(dead_code)]
pub(crate) fn terminal_session_run_state_event(
    session_id: &str,
    run_id: &str,
    phase: &str,
    status: &str,
) -> Value {
    let summary_key = match status {
        "cancelled" => "session.runState.cancelled",
        _ => "session.runState.failed",
    };
    agent_event(
        session_id,
        "session_run_state",
        json!({
            "status": status,
            "phase": phase,
            "reason": "session",
            "runId": run_id,
            "decisionKind": "session",
            "decisionOwner": {
                "kind": "session",
                "runId": run_id
            },
            "summary": summary_key,
            "summaryKey": summary_key,
            "messageKey": summary_key,
            "messageArgs": {
                "reason": "session",
                "status": status
            },
            "channel": "task",
            "visibility": "debug",
            "presentation": "stageSummary"
        }),
        &now_text(),
    )
}

pub(crate) fn set_run_terminal(
    state: &AppState,
    run_id: &str,
    status: &str,
    message: Option<String>,
    final_text: Option<String>,
) -> bool {
    let mut runs = state.session_runs.lock().expect("session run state lock");
    let Some(run) = runs.get_mut(run_id) else {
        return false;
    };
    if run_status_terminal(&run.status) {
        return false;
    }
    let now = now_text();
    run.status = status.to_string();
    run.updated_at = now.clone();
    run.completed_at = Some(now);
    run.message = message;
    run.final_text = final_text;
    true
}

pub(crate) fn request_run_cancellation(
    state: &AppState,
    run_id: &str,
) -> Result<bool, SessionDomainStoreError> {
    let session_id = {
        let runs = state.session_runs.lock().expect("session run state lock");
        let Some(run) = runs.get(run_id) else {
            return Ok(false);
        };
        if run_status_terminal(&run.status) || run.status == "cancelling" {
            return Ok(false);
        }
        run.session_id.clone()
    };
    admit_session_cancel_request(state, &session_id, run_id)?;
    let mut runs = state.session_runs.lock().expect("session run state lock");
    let Some(run) = runs.get_mut(run_id) else {
        return Ok(false);
    };
    if run_status_terminal(&run.status) {
        return Ok(false);
    }
    run.status = "cancelling".to_string();
    run.updated_at = now_text();
    run.message = Some("Run cancellation requested by user.".to_string());
    Ok(true)
}

pub(crate) fn touch_run(state: &AppState, run_id: &str, message: Option<String>) -> bool {
    let mut runs = state.session_runs.lock().expect("session run state lock");
    let Some(run) = runs.get_mut(run_id) else {
        return false;
    };
    if run_status_terminal(&run.status) {
        return false;
    }
    run.updated_at = now_text();
    if let Some(message) = message {
        run.message = Some(message);
    }
    true
}

pub(crate) fn run_belongs_to_session(state: &AppState, session_id: &str, run_id: &str) -> bool {
    let runs = state.session_runs.lock().expect("session run state lock");
    runs.get(run_id)
        .map(|run| run.session_id == session_id)
        .unwrap_or(false)
}

pub(crate) fn normalize_run_delta(
    session_id: &str,
    host_run_id: &str,
    delta_seq: u64,
    mut delta: Value,
) -> Value {
    if let Value::Object(object) = &mut delta {
        object
            .entry("sessionId".to_string())
            .or_insert_with(|| json!(session_id));
        object
            .entry("hostRunId".to_string())
            .or_insert_with(|| json!(host_run_id));
        object
            .entry("deltaSeq".to_string())
            .or_insert_with(|| json!(delta_seq));
        object
            .entry("receivedAt".to_string())
            .or_insert_with(|| json!(now_text()));
    }
    delta
}

pub(crate) fn terminal_stream_event_tail(
    events: &[Value],
    sent_event_count: usize,
) -> (Vec<Value>, usize) {
    let start = sent_event_count.min(events.len());
    (events.iter().skip(start).cloned().collect(), events.len())
}

pub(crate) fn pending_permission_message(events: &[Value]) -> Option<String> {
    for event in events.iter().rev() {
        match event.get("kind").and_then(Value::as_str) {
            Some("permission_result") => return None,
            Some("permission_request") => {
                return Some(
                    event_message(event)
                        .unwrap_or_else(|| "permission confirmation is pending".to_string()),
                );
            }
            _ => {}
        }
    }
    None
}

pub(crate) fn sse_bytes(
    event: &str,
    payload: Value,
) -> Result<bytes::Bytes, std::convert::Infallible> {
    let data = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    Ok(bytes::Bytes::from(format!(
        "event: {event}\ndata: {data}\n\n"
    )))
}

pub(crate) fn run_cancelled(state: &AppState, run_id: &str) -> bool {
    let runs = state.session_runs.lock().expect("session run state lock");
    runs.get(run_id)
        .map(|run| run.status == "cancelling" || run.status == "cancelled")
        .unwrap_or(false)
}

pub(crate) fn run_status_active(status: &str) -> bool {
    !run_status_terminal(status)
}

pub(crate) fn run_status_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "waiting")
}
