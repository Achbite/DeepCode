use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

const PROJECTION_SCHEMA_V2: &str = "deepcode.shared-conversation-projection.v2";
const WORK_SEGMENTS_SHAPE_V2: &str = "deepcode.shared-conversation.work-segments.v2";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_PROVIDER_USAGE_TOKENS: u64 = 1_000_000_000_000;

pub(crate) fn validate_work_segments_shared_projection_timeline(
    timeline: &Value,
) -> Result<(), String> {
    validate_work_segments_projection(timeline)
}

fn validate_work_segments_projection(timeline: &Value) -> Result<(), String> {
    let object = timeline
        .as_object()
        .ok_or_else(|| "Session v2 public projection must be an object".to_string())?;
    let allowed_root = HashSet::from([
        "schemaVersion",
        "shapeVersion",
        "sessionId",
        "revision",
        "sourceEventVersion",
        "generatedAt",
        "turns",
        "eventCount",
        "taskProjection",
        "interactionProjection",
        "runProjection",
        "tokenUsageProjection",
        "workspaceProjection",
    ]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed_root,
        "projection",
    )?;
    if object.get("schemaVersion").and_then(Value::as_str) != Some(PROJECTION_SCHEMA_V2) {
        return Err("Session v2 public projection has an unsupported schema".to_string());
    }
    if object.get("shapeVersion").and_then(Value::as_str) != Some(WORK_SEGMENTS_SHAPE_V2) {
        return Err("Session v2 public projection requires the work-segments shape".to_string());
    }
    reject_private_projection_fields(timeline)?;
    validate_projection_identity(object)?;

    let session_id = required_identity(object.get("sessionId"), "projection.sessionId")?;
    let turns = object
        .get("turns")
        .and_then(Value::as_array)
        .ok_or_else(|| "Session v2 public projection requires turns".to_string())?;
    let mut identities = NativeProjectionIdentities::default();
    for (index, turn) in turns.iter().enumerate() {
        validate_native_turn(turn, session_id, index as u64, &mut identities)?;
    }
    if let Some(task_projection) = object.get("taskProjection") {
        validate_task_projection(task_projection, &identities)?;
    }
    if let Some(interaction_projection) = object.get("interactionProjection") {
        validate_interaction_projection(interaction_projection, &identities.block_ids)?;
    }
    if let Some(run_projection) = object.get("runProjection") {
        validate_run_projection(run_projection, &identities)?;
    }
    if let Some(token_usage_projection) = object.get("tokenUsageProjection") {
        validate_token_usage_projection(token_usage_projection)?;
    }
    if let Some(workspace_projection) = object.get("workspaceProjection") {
        validate_workspace_projection(workspace_projection)?;
    }
    Ok(())
}

#[derive(Clone, Default)]
struct NativeProjectionIdentities<'a> {
    turn_ids: HashSet<&'a str>,
    block_ids: HashSet<&'a str>,
    work_segment_ids: HashSet<&'a str>,
    work_segment_turn_ids: HashMap<&'a str, &'a str>,
    operation_ids: HashSet<&'a str>,
    operation_segment_ids: HashMap<&'a str, &'a str>,
}

fn validate_projection_identity(object: &Map<String, Value>) -> Result<(), String> {
    required_identity(object.get("sessionId"), "projection.sessionId")?;
    required_identity(object.get("generatedAt"), "projection.generatedAt")?;
    for field in ["revision", "sourceEventVersion", "eventCount"] {
        required_safe_integer(object.get(field), field)?;
    }
    Ok(())
}

fn validate_native_turn<'a>(
    turn: &'a Value,
    session_id: &str,
    expected_sequence: u64,
    identities: &mut NativeProjectionIdentities<'a>,
) -> Result<(), String> {
    let object = turn
        .as_object()
        .ok_or_else(|| "Session v2 public projection turn must be an object".to_string())?;
    let allowed = HashSet::from([
        "id",
        "sequence",
        "sessionId",
        "status",
        "startedAt",
        "completedAt",
        "blocks",
        "workSegments",
        "parts",
    ]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, "turn")?;
    let turn_id = required_identity(object.get("id"), "turn.id")?;
    if !identities.turn_ids.insert(turn_id) {
        return Err(format!(
            "Session v2 public projection repeats turn {turn_id}"
        ));
    }
    if object.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err("Session v2 public projection turn crosses Session identity".to_string());
    }
    validate_native_turn_invariants(turn, expected_sequence)?;
    validate_timeline_status(object.get("status"), "turn.status")?;
    validate_optional_strings(object, &["startedAt", "completedAt"], "turn")?;

    let blocks = object
        .get("blocks")
        .and_then(Value::as_array)
        .ok_or_else(|| "Session v2 public projection turn requires blocks".to_string())?;
    let mut local_block_ids = HashSet::new();
    for (index, block) in blocks.iter().enumerate() {
        if required_safe_integer(block.get("sequence"), "block.sequence")? != index as u64 {
            return Err(
                "Session v2 public projection native block sequence is inconsistent".to_string(),
            );
        }
        let block_id = validate_native_block(block)?;
        if !identities.block_ids.insert(block_id) || !local_block_ids.insert(block_id) {
            return Err(format!(
                "Session v2 public projection repeats block {block_id}"
            ));
        }
    }

    let work_segments = object
        .get("workSegments")
        .and_then(Value::as_array)
        .ok_or_else(|| "Session v2 public projection turn requires workSegments".to_string())?;
    let mut local_work_segment_ids = HashSet::new();
    for (index, segment) in work_segments.iter().enumerate() {
        if required_safe_integer(segment.get("sequence"), "workSegment.sequence")? != index as u64 {
            return Err(
                "Session v2 public projection native work segment sequence is inconsistent"
                    .to_string(),
            );
        }
        let segment_id = validate_work_segment(segment, identities)?;
        if !identities.work_segment_ids.insert(segment_id)
            || !local_work_segment_ids.insert(segment_id)
        {
            return Err(format!(
                "Session v2 public projection repeats work segment {segment_id}"
            ));
        }
        identities.work_segment_turn_ids.insert(segment_id, turn_id);
    }

    validate_turn_parts(
        object.get("parts"),
        &local_block_ids,
        &local_work_segment_ids,
    )?;
    validate_turn_retry_relations(work_segments, object.get("parts"))
}

fn validate_turn_retry_relations(
    work_segments: &[Value],
    parts: Option<&Value>,
) -> Result<(), String> {
    let segments = work_segments
        .iter()
        .filter_map(|segment| {
            let object = segment.as_object()?;
            Some((object.get("id")?.as_str()?, object))
        })
        .collect::<HashMap<_, _>>();
    let parts = parts
        .and_then(Value::as_array)
        .ok_or_else(|| "Session v2 public projection turn requires parts".to_string())?;
    let mut ordered_operations = Vec::new();
    for part in parts {
        let Some(work_segment_id) = part
            .as_object()
            .filter(|part| part.get("kind").and_then(Value::as_str) == Some("workSegment"))
            .and_then(|part| part.get("workSegmentId"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let segment = segments
            .get(work_segment_id)
            .ok_or_else(|| "Session v2 public projection retry segment is missing".to_string())?;
        let operations = segment
            .get("operations")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                "Session v2 public projection retry segment has no operations".to_string()
            })?;
        for operation in operations {
            ordered_operations.push(operation.as_object().ok_or_else(|| {
                "Session v2 public projection retry operation is invalid".to_string()
            })?);
        }
    }
    let operation_positions = ordered_operations
        .iter()
        .enumerate()
        .filter_map(|(index, operation)| {
            Some((operation.get("operationId")?.as_str()?, (index, *operation)))
        })
        .collect::<HashMap<_, _>>();
    let mut corrected_predecessors = HashSet::new();
    for (index, operation) in ordered_operations.iter().enumerate() {
        let Some(retry_value) = operation.get("retry") else {
            continue;
        };
        let retry = retry_value
            .as_object()
            .ok_or_else(|| "Session v2 public projection retry is invalid".to_string())?;
        let operation_id =
            required_identity(operation.get("operationId"), "operation.operationId")?;
        let retry_group_id =
            required_identity(retry.get("retryGroupId"), "operation.retry.retryGroupId")?;
        let predecessor_id = required_identity(
            retry.get("predecessorOperationId"),
            "operation.retry.predecessorOperationId",
        )?;
        let retry_ordinal =
            required_safe_integer(retry.get("retryOrdinal"), "operation.retry.retryOrdinal")?;
        let Some((predecessor_index, predecessor)) =
            operation_positions.get(predecessor_id).copied()
        else {
            return Err(format!(
                "Session v2 public projection operation {operation_id} retry predecessor is missing"
            ));
        };
        let predecessor_status = predecessor
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if predecessor_index >= index
            || !corrected_predecessors.insert(predecessor_id)
            || !matches!(predecessor_status, "denied" | "failed" | "unexecuted")
        {
            return Err(format!(
                "Session v2 public projection operation {operation_id} has an invalid retry predecessor"
            ));
        }
        match predecessor.get("retry").and_then(Value::as_object) {
            Some(predecessor_retry)
                if predecessor_retry
                    .get("retryGroupId")
                    .and_then(Value::as_str)
                    == Some(retry_group_id)
                    && predecessor_retry
                        .get("retryOrdinal")
                        .and_then(Value::as_u64)
                        .and_then(|value| value.checked_add(1))
                        == Some(retry_ordinal) => {}
            None if retry_ordinal == 2 => {}
            _ => {
                return Err(format!(
                "Session v2 public projection operation {operation_id} has an invalid retry chain"
            ))
            }
        }
    }
    Ok(())
}

fn validate_native_turn_invariants(turn: &Value, expected_sequence: u64) -> Result<(), String> {
    let object = turn
        .as_object()
        .ok_or_else(|| "Session v2 public projection turn must be an object".to_string())?;
    if required_safe_integer(object.get("sequence"), "turn.sequence")? != expected_sequence {
        return Err(
            "Session v2 public projection native turn sequence is inconsistent".to_string(),
        );
    }
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let terminal = matches!(status, "completed" | "cancelled" | "failed");
    let completed = object.get("completedAt").and_then(Value::as_str).is_some();
    if terminal != completed {
        return Err(
            "Session v2 public projection native turn lifecycle is inconsistent".to_string(),
        );
    }
    let blocks = object
        .get("blocks")
        .and_then(Value::as_array)
        .ok_or_else(|| "Session v2 public projection turn requires blocks".to_string())?;
    for (index, block) in blocks.iter().enumerate() {
        if required_safe_integer(block.get("sequence"), "block.sequence")? != index as u64 {
            return Err(
                "Session v2 public projection native block sequence is inconsistent".to_string(),
            );
        }
    }
    let work_segments = object
        .get("workSegments")
        .and_then(Value::as_array)
        .ok_or_else(|| "Session v2 public projection turn requires workSegments".to_string())?;
    for (index, segment) in work_segments.iter().enumerate() {
        if required_safe_integer(segment.get("sequence"), "workSegment.sequence")? != index as u64 {
            return Err(
                "Session v2 public projection native work segment sequence is inconsistent"
                    .to_string(),
            );
        }
        let lifecycle = segment
            .get("lifecycle")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let active = lifecycle == "active";
        let completed = segment.get("completedAt").and_then(Value::as_str).is_some();
        if active == completed {
            return Err(
                "Session v2 public projection native work segment lifecycle is inconsistent"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn validate_native_block(block: &Value) -> Result<&str, String> {
    let object = block
        .as_object()
        .ok_or_else(|| "Session v2 public projection block must be an object".to_string())?;
    let allowed = HashSet::from([
        "id",
        "sequence",
        "revision",
        "deliveryMode",
        "durability",
        "kind",
        "narrativeKind",
        "entryRole",
        "providerPhase",
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
        "displayHints",
        "evidenceRefs",
        "provenance",
        "languageBinding",
        "taskProjectionRef",
    ]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, "block")?;
    let block_id = required_identity(object.get("id"), "block.id")?;
    validate_optional_safe_integer(object.get("sequence"), "block.sequence")?;
    validate_optional_safe_integer(object.get("revision"), "block.revision")?;
    validate_optional_enum(
        object.get("deliveryMode"),
        &["live", "buffered", "replay"],
        "block.deliveryMode",
    )?;
    validate_required_enum(
        object.get("durability"),
        &["live", "committed"],
        "block.durability",
    )?;
    validate_required_enum(
        object.get("kind"),
        &["user", "assistant", "permission", "plan", "review", "error"],
        "block.kind",
    )?;
    validate_optional_enum(
        object.get("narrativeKind"),
        &[
            "user",
            "assistantText",
            "plan",
            "permission",
            "review",
            "diagnostic",
        ],
        "block.narrativeKind",
    )?;
    validate_required_enum(
        object.get("entryRole"),
        &[
            "userMessage",
            "agentUpdate",
            "interaction",
            "finalAnswer",
            "diagnostic",
        ],
        "block.entryRole",
    )?;
    validate_optional_enum(
        object.get("providerPhase"),
        &["commentary", "final_answer"],
        "block.providerPhase",
    )?;
    validate_native_block_semantics(object)?;
    required_identity(object.get("title"), "block.title")?;
    if object.get("summary").and_then(Value::as_str).is_none()
        || object
            .get("defaultCollapsed")
            .and_then(Value::as_bool)
            .is_none()
    {
        return Err(format!(
            "Session v2 public projection block {block_id} has invalid required fields"
        ));
    }
    validate_timeline_status(object.get("status"), "block.status")?;
    validate_optional_strings(object, &["bodyMarkdown", "taskProjectionRef"], "block")?;
    if let Some(confirmable) = object.get("confirmable") {
        if !confirmable.is_boolean() {
            return Err(format!(
                "Session v2 public projection block {block_id} has invalid confirmable"
            ));
        }
    }
    if let Some(evidence_refs) = object.get("evidenceRefs") {
        validate_string_array(Some(evidence_refs), "block.evidenceRefs")?;
    }
    if let Some(localized) = object.get("localizedContent") {
        validate_localized_text(localized, "block.localizedContent")?;
    }
    if let Some(structured) = object.get("structuredProjection") {
        validate_structured_projection(structured)?;
    }
    if let Some(decision) = object.get("decisionRequest") {
        validate_decision_request(decision, "block.decisionRequest")?;
    }
    if let Some(interaction) = object.get("interaction") {
        validate_interaction_view(interaction)?;
    }
    if let Some(display_hints) = object.get("displayHints") {
        validate_display_hints(display_hints)?;
    }
    if let Some(attachments) = object.get("attachments") {
        deepcode_kernel_abi::decode_agent_input_attachments_v3(attachments).map_err(|error| {
            format!(
                "Session v2 public projection block {block_id} has invalid attachments: {}",
                error.code
            )
        })?;
    }
    validate_provenance(object.get("provenance"), "block.provenance")?;
    validate_language_binding(object.get("languageBinding"), "block.languageBinding")?;
    Ok(block_id)
}

fn validate_native_block_semantics(object: &Map<String, Value>) -> Result<(), String> {
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let entry_role = object
        .get("entryRole")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let narrative_kind = object
        .get("narrativeKind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let provider_phase = object.get("providerPhase").and_then(Value::as_str);
    let provenance = object.get("provenance").and_then(Value::as_object);
    let provenance_origin = provenance
        .and_then(|value| value.get("origin"))
        .and_then(Value::as_str);
    let provenance_authority = provenance
        .and_then(|value| value.get("authority"))
        .and_then(Value::as_str);
    let semantics_are_valid = match kind {
        "user" => {
            narrative_kind == "user"
                && entry_role == "userMessage"
                && provider_phase.is_none()
                && provenance_origin == Some("user")
                && provenance_authority == Some("user")
        }
        "assistant" => {
            narrative_kind == "assistantText"
                && provenance_origin == Some("provider")
                && provenance_authority == Some("session")
                && match provider_phase {
                    Some("commentary") => entry_role == "agentUpdate",
                    Some("final_answer") => entry_role == "finalAnswer",
                    None => matches!(entry_role, "agentUpdate" | "finalAnswer"),
                    Some(_) => false,
                }
        }
        "permission" => {
            narrative_kind == "permission"
                && entry_role == "interaction"
                && provider_phase.is_none()
        }
        "plan" => {
            narrative_kind == "plan" && entry_role == "interaction" && provider_phase.is_none()
        }
        "review" => {
            narrative_kind == "review" && entry_role == "interaction" && provider_phase.is_none()
        }
        "error" => {
            narrative_kind == "diagnostic" && entry_role == "diagnostic" && provider_phase.is_none()
        }
        _ => false,
    };
    if !semantics_are_valid {
        return Err(
            "Session v2 public projection native block semantics are inconsistent".to_string(),
        );
    }
    if object.contains_key("attachments") && kind != "user" {
        return Err(
            "Session v2 public projection attachments are only valid on user blocks".to_string(),
        );
    }
    if (object.contains_key("decisionRequest") || object.contains_key("interaction"))
        && !matches!(kind, "plan" | "permission")
    {
        return Err(
            "Session v2 public projection interaction data is only valid on plan or permission blocks"
                .to_string(),
        );
    }
    if let Some(structured) = object
        .get("structuredProjection")
        .and_then(Value::as_object)
    {
        let structured_kind = structured
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let valid_binding = (kind == "plan" && structured_kind == "plan")
            || (kind == "review" && structured_kind == "review")
            || (kind == "assistant" && entry_role == "finalAnswer" && structured_kind == "review");
        if !valid_binding {
            return Err(
                "Session v2 public projection structured data has an invalid block binding"
                    .to_string(),
            );
        }
    }
    if object.contains_key("taskProjectionRef") && kind != "plan" {
        return Err(
            "Session v2 public projection taskProjectionRef is only valid on plan blocks"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_localized_text(value: &Value, field: &str) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("Session v2 public projection {field} must be an object"))?;
    let allowed = HashSet::from(["text", "messageKey", "messageArgs"]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, field)?;
    validate_optional_strings(object, &["text", "messageKey"], field)?;
    if object.get("text").is_none() && object.get("messageKey").is_none() {
        return Err(format!(
            "Session v2 public projection {field} requires text or messageKey"
        ));
    }
    if let Some(arguments) = object.get("messageArgs") {
        validate_string_map(arguments, &format!("{field}.messageArgs"))?;
    }
    Ok(())
}

fn validate_structured_projection(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or_else(|| {
        "Session v2 public projection structuredProjection must be an object".to_string()
    })?;
    let allowed = HashSet::from([
        "kind",
        "schemaVersion",
        "title",
        "titleKey",
        "titleArgs",
        "summary",
        "summaryKey",
        "messageArgs",
        "sections",
    ]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed,
        "structuredProjection",
    )?;
    validate_required_enum(
        object.get("kind"),
        &["plan", "review"],
        "structuredProjection.kind",
    )?;
    required_identity(
        object.get("schemaVersion"),
        "structuredProjection.schemaVersion",
    )?;
    validate_optional_strings(
        object,
        &["title", "titleKey", "summary", "summaryKey"],
        "structuredProjection",
    )?;
    for field in ["titleArgs", "messageArgs"] {
        if let Some(arguments) = object.get(field) {
            validate_string_map(arguments, &format!("structuredProjection.{field}"))?;
        }
    }
    let sections = object
        .get("sections")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "Session v2 public projection structuredProjection requires sections".to_string()
        })?;
    let mut section_ids = HashSet::new();
    for section in sections {
        validate_structured_section(section, &mut section_ids)?;
    }
    Ok(())
}

fn validate_structured_section<'a>(
    value: &'a Value,
    section_ids: &mut HashSet<&'a str>,
) -> Result<(), String> {
    let object = value.as_object().ok_or_else(|| {
        "Session v2 public projection structured section must be an object".to_string()
    })?;
    let allowed = HashSet::from([
        "sectionId",
        "titleKey",
        "titleArgs",
        "emptyMessageKey",
        "items",
    ]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed,
        "structured section",
    )?;
    let section_id = required_identity(object.get("sectionId"), "structured section.sectionId")?;
    if !section_ids.insert(section_id) {
        return Err(format!(
            "Session v2 public projection repeats structured section {section_id}"
        ));
    }
    required_identity(object.get("titleKey"), "structured section.titleKey")?;
    validate_optional_strings(object, &["emptyMessageKey"], "structured section")?;
    if let Some(arguments) = object.get("titleArgs") {
        validate_string_map(arguments, "structured section.titleArgs")?;
    }
    let items = object
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "Session v2 public projection structured section requires items".to_string()
        })?;
    let mut item_ids = HashSet::new();
    for item in items {
        validate_structured_item(item, &mut item_ids)?;
    }
    Ok(())
}

fn validate_structured_item<'a>(
    value: &'a Value,
    item_ids: &mut HashSet<&'a str>,
) -> Result<(), String> {
    let object = value.as_object().ok_or_else(|| {
        "Session v2 public projection structured item must be an object".to_string()
    })?;
    let allowed = HashSet::from([
        "itemId",
        "kind",
        "text",
        "messageKey",
        "messageArgs",
        "status",
        "targetRefs",
        "resourcePresentation",
        "auditRefs",
        "objective",
        "acceptanceCriteria",
        "failureConditions",
    ]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed,
        "structured item",
    )?;
    let item_id = required_identity(object.get("itemId"), "structured item.itemId")?;
    if !item_ids.insert(item_id) {
        return Err(format!(
            "Session v2 public projection repeats structured item {item_id}"
        ));
    }
    required_identity(object.get("kind"), "structured item.kind")?;
    validate_optional_strings(
        object,
        &["text", "messageKey", "status", "objective"],
        "structured item",
    )?;
    if let Some(arguments) = object.get("messageArgs") {
        validate_string_map(arguments, "structured item.messageArgs")?;
    }
    for field in [
        "targetRefs",
        "auditRefs",
        "acceptanceCriteria",
        "failureConditions",
    ] {
        if let Some(values) = object.get(field) {
            validate_string_array(Some(values), &format!("structured item.{field}"))?;
        }
    }
    if let Some(presentation) = object.get("resourcePresentation") {
        validate_resource_presentations(
            Some(presentation),
            "structured item.resourcePresentation",
        )?;
    }
    Ok(())
}

fn validate_decision_request(value: &Value, field: &str) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("Session v2 public projection {field} must be an object"))?;
    let allowed = HashSet::from(["id", "reason", "summary", "allowsFreeform", "options"]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, field)?;
    validate_optional_strings(object, &["id", "reason", "summary"], field)?;
    if object
        .get("allowsFreeform")
        .and_then(Value::as_bool)
        .is_none()
    {
        return Err(format!(
            "Session v2 public projection {field}.allowsFreeform is invalid"
        ));
    }
    let options = object
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Session v2 public projection {field} requires options"))?;
    let mut option_ids = HashSet::new();
    for option in options {
        validate_interaction_option(option, field, &mut option_ids)?;
    }
    Ok(())
}

fn validate_interaction_option<'a>(
    value: &'a Value,
    field: &str,
    option_ids: &mut HashSet<&'a str>,
) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("Session v2 public projection {field} option must be an object"))?;
    let allowed = HashSet::from(["id", "label", "description", "recommended"]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed,
        &format!("{field} option"),
    )?;
    let option_id = required_identity(object.get("id"), &format!("{field} option.id"))?;
    if !option_ids.insert(option_id) {
        return Err(format!(
            "Session v2 public projection repeats {field} option {option_id}"
        ));
    }
    required_identity(object.get("label"), &format!("{field} option.label"))?;
    validate_optional_strings(object, &["description"], &format!("{field} option"))?;
    if object
        .get("recommended")
        .is_some_and(|recommended| !recommended.is_boolean())
    {
        return Err(format!(
            "Session v2 public projection {field} option.recommended is invalid"
        ));
    }
    Ok(())
}

fn validate_interaction_view(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or_else(|| {
        "Session v2 public projection block interaction must be an object".to_string()
    })?;
    let allowed = HashSet::from([
        "interactionId",
        "interactionRevision",
        "targetId",
        "kind",
        "runId",
        "state",
        "decisionRequest",
        "selectedDecision",
    ]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed,
        "block interaction",
    )?;
    validate_interaction_identity(object, "block interaction")?;
    validate_required_enum(
        object.get("kind"),
        &["plan", "permission"],
        "block interaction.kind",
    )?;
    validate_required_enum(
        object.get("state"),
        &[
            "open",
            "submitting",
            "accepted",
            "rejected",
            "needsRevision",
            "superseded",
            "expired",
        ],
        "block interaction.state",
    )?;
    validate_optional_strings(object, &["runId"], "block interaction")?;
    if let Some(decision) = object.get("decisionRequest") {
        validate_decision_request(decision, "block interaction.decisionRequest")?;
    }
    if let Some(selected) = object.get("selectedDecision") {
        validate_selected_decision(selected)?;
    }
    Ok(())
}

fn validate_selected_decision(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or_else(|| {
        "Session v2 public projection selectedDecision must be an object".to_string()
    })?;
    let allowed = HashSet::from(["decision", "source", "decidedAt"]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed,
        "selectedDecision",
    )?;
    required_identity(object.get("decision"), "selectedDecision.decision")?;
    validate_required_enum(
        object.get("source"),
        &["button", "freeText"],
        "selectedDecision.source",
    )?;
    validate_optional_strings(object, &["decidedAt"], "selectedDecision")
}

fn validate_display_hints(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Session v2 public projection displayHints must be an object".to_string())?;
    let allowed = HashSet::from([
        "density",
        "evidenceMode",
        "collapseAfterComplete",
        "checkpointKind",
        "showInTaskList",
        "taskListLabel",
        "taskListSummary",
        "phase",
    ]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, "displayHints")?;
    validate_optional_enum(
        object.get("density"),
        &["normal", "compact", "debug"],
        "displayHints.density",
    )?;
    validate_optional_enum(
        object.get("evidenceMode"),
        &["inline", "collapsed", "debugOnly"],
        "displayHints.evidenceMode",
    )?;
    validate_optional_enum(
        object.get("checkpointKind"),
        &[
            "turnStart",
            "llmProposal",
            "resourceFact",
            "userGuidance",
            "permission",
            "review",
            "final",
            "diagnostic",
        ],
        "displayHints.checkpointKind",
    )?;
    validate_optional_enum(
        object.get("phase"),
        &["explore", "execute"],
        "displayHints.phase",
    )?;
    validate_optional_strings(
        object,
        &["taskListLabel", "taskListSummary"],
        "displayHints",
    )?;
    for field in ["collapseAfterComplete", "showInTaskList"] {
        if object
            .get(field)
            .is_some_and(|candidate| !candidate.is_boolean())
        {
            return Err(format!(
                "Session v2 public projection displayHints.{field} is invalid"
            ));
        }
    }
    Ok(())
}

fn validate_work_segment<'a>(
    segment: &'a Value,
    identities: &mut NativeProjectionIdentities<'a>,
) -> Result<&'a str, String> {
    let object = segment
        .as_object()
        .ok_or_else(|| "Session v2 public projection work segment must be an object".to_string())?;
    let allowed = HashSet::from([
        "id",
        "revision",
        "sequence",
        "lifecycle",
        "attention",
        "activeOperationId",
        "operations",
        "startedAt",
        "completedAt",
        "provenance",
        "factRefs",
    ]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, "work segment")?;
    let segment_id = required_identity(object.get("id"), "workSegment.id")?;
    required_safe_integer(object.get("revision"), "workSegment.revision")?;
    required_safe_integer(object.get("sequence"), "workSegment.sequence")?;
    validate_required_enum(
        object.get("lifecycle"),
        &["active", "completed", "cancelled", "failed"],
        "workSegment.lifecycle",
    )?;
    validate_optional_strings(object, &["startedAt", "completedAt"], "workSegment")?;
    validate_provenance(object.get("provenance"), "workSegment.provenance")?;
    validate_string_array(object.get("factRefs"), "workSegment.factRefs")?;

    let operations = object
        .get("operations")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "Session v2 public projection work segment requires operations".to_string()
        })?;
    let mut local_operation_ids = HashSet::new();
    let mut local_operation_statuses = HashMap::new();
    for operation in operations {
        let (operation_id, operation_status) = validate_work_operation(operation)?;
        if !identities.operation_ids.insert(operation_id)
            || !local_operation_ids.insert(operation_id)
        {
            return Err(format!(
                "Session v2 public projection repeats operation {operation_id}"
            ));
        }
        identities
            .operation_segment_ids
            .insert(operation_id, segment_id);
        local_operation_statuses.insert(operation_id, operation_status);
    }
    match object.get("attention") {
        Some(Value::Null) => {}
        Some(attention) => validate_work_attention(attention, &local_operation_ids)?,
        None => {
            return Err("Session v2 public projection work segment requires attention".to_string())
        }
    }
    if let Some(active_operation_id) = object.get("activeOperationId") {
        let active_operation_id =
            required_identity(Some(active_operation_id), "workSegment.activeOperationId")?;
        if object.get("lifecycle").and_then(Value::as_str) != Some("active")
            || !local_operation_ids.contains(active_operation_id)
            || !local_operation_statuses
                .get(active_operation_id)
                .is_some_and(|status| {
                    ["preparing", "queued", "running", "awaitingCapability"].contains(status)
                })
        {
            return Err(
                "Session v2 public projection activeOperationId is not an active local operation"
                    .to_string(),
            );
        }
    }
    Ok(segment_id)
}

fn validate_work_operation(operation: &Value) -> Result<(&str, &str), String> {
    let object = operation
        .as_object()
        .ok_or_else(|| "Session v2 public projection operation must be an object".to_string())?;
    let allowed = HashSet::from([
        "operationId",
        "invocationId",
        "attempts",
        "retry",
        "toolId",
        "displayName",
        "status",
        "canonicalAction",
        "resourcePresentation",
        "effectSummary",
        "resourceRefs",
        "factRefs",
        "effectRefs",
        "startedAt",
        "completedAt",
    ]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, "operation")?;
    let operation_id = required_identity(object.get("operationId"), "operation.operationId")?;
    required_identity(object.get("toolId"), "operation.toolId")?;
    validate_work_operation_status(object.get("status"), "operation.status")?;
    let operation_status = object
        .get("status")
        .and_then(Value::as_str)
        .expect("validated work operation status must be a string");
    validate_string_array(object.get("resourceRefs"), "operation.resourceRefs")?;
    validate_string_array(object.get("factRefs"), "operation.factRefs")?;
    validate_string_array(object.get("effectRefs"), "operation.effectRefs")?;
    validate_resource_presentations(
        object.get("resourcePresentation"),
        "operation.resourcePresentation",
    )?;
    if let Some(retry) = object.get("retry") {
        validate_work_retry(retry, operation_id)?;
    }
    validate_optional_strings(
        object,
        &[
            "invocationId",
            "displayName",
            "canonicalAction",
            "effectSummary",
            "startedAt",
            "completedAt",
        ],
        "operation",
    )?;
    if let Some(attempts) = object.get("attempts") {
        let attempts = attempts.as_array().ok_or_else(|| {
            "Session v2 public projection operation attempts must be an array".to_string()
        })?;
        let mut attempt_ids = HashSet::new();
        for attempt in attempts {
            validate_work_attempt(attempt, &mut attempt_ids)?;
        }
    }
    Ok((operation_id, operation_status))
}

fn validate_work_retry(retry: &Value, operation_id: &str) -> Result<(), String> {
    let object = retry
        .as_object()
        .ok_or_else(|| "Session v2 public projection retry must be an object".to_string())?;
    let allowed = HashSet::from(["retryGroupId", "predecessorOperationId", "retryOrdinal"]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed,
        "operation retry",
    )?;
    let retry_group_id =
        required_identity(object.get("retryGroupId"), "operation.retry.retryGroupId")?;
    let predecessor_id = required_identity(
        object.get("predecessorOperationId"),
        "operation.retry.predecessorOperationId",
    )?;
    let retry_ordinal =
        required_safe_integer(object.get("retryOrdinal"), "operation.retry.retryOrdinal")?;
    if retry_group_id.trim().is_empty() || predecessor_id == operation_id || retry_ordinal < 2 {
        return Err(format!(
            "Session v2 public projection operation {operation_id} has an invalid retry identity"
        ));
    }
    Ok(())
}

fn validate_work_attempt<'a>(
    attempt: &'a Value,
    attempt_ids: &mut HashSet<&'a str>,
) -> Result<(), String> {
    let object = attempt
        .as_object()
        .ok_or_else(|| "Session v2 public projection attempt must be an object".to_string())?;
    let allowed = HashSet::from(["attemptId", "status", "startedAt", "completedAt"]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, "attempt")?;
    let attempt_id = required_identity(object.get("attemptId"), "attempt.attemptId")?;
    if !attempt_ids.insert(attempt_id) {
        return Err(format!(
            "Session v2 public projection repeats attempt {attempt_id}"
        ));
    }
    if object.contains_key("status") {
        validate_work_operation_status(object.get("status"), "attempt.status")?;
    }
    validate_optional_strings(object, &["startedAt", "completedAt"], "attempt")
}

fn validate_work_attention(attention: &Value, operation_ids: &HashSet<&str>) -> Result<(), String> {
    let object = attention
        .as_object()
        .ok_or_else(|| "Session v2 public projection attention must be an object".to_string())?;
    let allowed = HashSet::from(["kind", "status", "summary", "operationId", "factRefs"]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, "attention")?;
    validate_required_enum(
        object.get("kind"),
        &[
            "capability",
            "denial",
            "failure",
            "observedEffectFailure",
            "indeterminate",
        ],
        "attention.kind",
    )?;
    validate_required_enum(
        object.get("status"),
        &["unresolved", "resolved"],
        "attention.status",
    )?;
    required_identity(object.get("summary"), "attention.summary")?;
    validate_string_array(object.get("factRefs"), "attention.factRefs")?;
    if let Some(operation_id) = object.get("operationId") {
        let operation_id = required_identity(Some(operation_id), "attention.operationId")?;
        if !operation_ids.contains(operation_id) {
            return Err(
                "Session v2 public projection attention references another work segment"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn validate_turn_parts(
    value: Option<&Value>,
    block_ids: &HashSet<&str>,
    work_segment_ids: &HashSet<&str>,
) -> Result<(), String> {
    let parts = value
        .and_then(Value::as_array)
        .ok_or_else(|| "Session v2 public projection turn requires parts".to_string())?;
    let mut referenced_blocks = HashSet::new();
    let mut referenced_segments = HashSet::new();
    for part in parts {
        let object = part
            .as_object()
            .ok_or_else(|| "Session v2 public projection part must be an object".to_string())?;
        match object.get("kind").and_then(Value::as_str) {
            Some("block") => {
                let allowed = HashSet::from(["kind", "blockId"]);
                reject_unknown_fields(object.keys().map(String::as_str), &allowed, "block part")?;
                let block_id = required_identity(object.get("blockId"), "part.blockId")?;
                if !block_ids.contains(block_id) || !referenced_blocks.insert(block_id) {
                    return Err(format!(
                        "Session v2 public projection has invalid block part {block_id}"
                    ));
                }
            }
            Some("workSegment") => {
                let allowed = HashSet::from(["kind", "workSegmentId"]);
                reject_unknown_fields(
                    object.keys().map(String::as_str),
                    &allowed,
                    "work segment part",
                )?;
                let segment_id =
                    required_identity(object.get("workSegmentId"), "part.workSegmentId")?;
                if !work_segment_ids.contains(segment_id) || !referenced_segments.insert(segment_id)
                {
                    return Err(format!(
                        "Session v2 public projection has invalid work segment part {segment_id}"
                    ));
                }
            }
            _ => return Err("Session v2 public projection part kind is invalid".to_string()),
        }
    }
    if referenced_blocks.len() != block_ids.len()
        || referenced_segments.len() != work_segment_ids.len()
    {
        return Err(
            "Session v2 public projection parts do not cover the complete turn".to_string(),
        );
    }
    Ok(())
}

fn validate_task_projection(
    value: &Value,
    identities: &NativeProjectionIdentities<'_>,
) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Session v2 public taskProjection must be an object".to_string())?;
    let allowed = HashSet::from(["title", "items"]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed,
        "taskProjection",
    )?;
    required_identity(object.get("title"), "taskProjection.title")?;
    let items = object
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "Session v2 public taskProjection requires items".to_string())?;
    let mut item_ids = HashSet::new();
    for item in items {
        let item = item
            .as_object()
            .ok_or_else(|| "Session v2 public taskProjection item must be an object".to_string())?;
        let allowed = HashSet::from([
            "id",
            "titleKey",
            "titleArgs",
            "summaryKey",
            "messageArgs",
            "targetRefs",
            "resourcePresentation",
            "progress",
            "outcome",
            "attention",
            "blockId",
            "narrativeKind",
            "settlementKind",
        ]);
        reject_unknown_fields(
            item.keys().map(String::as_str),
            &allowed,
            "taskProjection item",
        )?;
        let item_id = required_identity(item.get("id"), "taskProjection item.id")?;
        if !item_ids.insert(item_id) {
            return Err(format!(
                "Session v2 public projection repeats taskProjection item {item_id}"
            ));
        }
        required_identity(item.get("titleKey"), "taskProjection item.titleKey")?;
        validate_string_map(
            item.get("titleArgs").ok_or_else(|| {
                "Session v2 public projection taskProjection item requires titleArgs".to_string()
            })?,
            "taskProjection item.titleArgs",
        )?;
        required_identity(item.get("summaryKey"), "taskProjection item.summaryKey")?;
        validate_string_map(
            item.get("messageArgs").ok_or_else(|| {
                "Session v2 public projection taskProjection item requires messageArgs".to_string()
            })?,
            "taskProjection item.messageArgs",
        )?;
        validate_string_array(item.get("targetRefs"), "taskProjection item.targetRefs")?;
        validate_resource_presentations(
            item.get("resourcePresentation"),
            "taskProjection item.resourcePresentation",
        )?;
        validate_task_projection_progress(item.get("progress"), "taskProjection item.progress")?;
        match item.get("outcome") {
            Some(Value::Null) => {}
            Some(value) => validate_required_enum(
                Some(value),
                &[
                    "succeeded",
                    "failed",
                    "denied",
                    "unexecuted",
                    "cancelled",
                    "indeterminate",
                ],
                "taskProjection item.outcome",
            )?,
            None => {
                return Err(
                    "Session v2 public projection taskProjection item requires outcome".to_string(),
                )
            }
        }
        match item.get("attention") {
            Some(Value::Null) => {}
            Some(attention) => validate_work_attention(attention, &identities.operation_ids)?,
            None => {
                return Err(
                    "Session v2 public projection taskProjection item requires attention"
                        .to_string(),
                )
            }
        }
        let block_id = required_identity(item.get("blockId"), "taskProjection item.blockId")?;
        if !identities.block_ids.contains(block_id) {
            return Err(
                "Session v2 public projection taskProjection references a missing block"
                    .to_string(),
            );
        }
        validate_required_enum(
            item.get("narrativeKind"),
            &[
                "user",
                "assistantText",
                "plan",
                "permission",
                "review",
                "diagnostic",
            ],
            "taskProjection item.narrativeKind",
        )?;
        validate_optional_enum(
            item.get("settlementKind"),
            &["sessionEvidenceSatisfied"],
            "taskProjection item.settlementKind",
        )?;
    }
    Ok(())
}

fn validate_resource_presentations(value: Option<&Value>, field: &str) -> Result<(), String> {
    let presentations = value
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Session v2 public projection {field} must be an array"))?;
    for presentation in presentations {
        let object = presentation.as_object().ok_or_else(|| {
            format!("Session v2 public projection {field} item must be an object")
        })?;
        let allowed = HashSet::from([
            "kind",
            "label",
            "workspaceRelativePath",
            "canonicalResourceRef",
        ]);
        reject_unknown_fields(object.keys().map(String::as_str), &allowed, field)?;
        let kind = required_identity(object.get("kind"), &format!("{field}.kind"))?;
        if !["workspacePath", "resourceLabel"].contains(&kind) {
            return Err(format!(
                "Session v2 public projection {field}.kind is invalid"
            ));
        }
        required_identity(object.get("label"), &format!("{field}.label"))?;
        for optional_identity in ["workspaceRelativePath", "canonicalResourceRef"] {
            if let Some(value) = object.get(optional_identity) {
                required_identity(Some(value), &format!("{field}.{optional_identity}"))?;
            }
        }
        let workspace_relative_path = object.get("workspaceRelativePath");
        if (kind == "workspacePath") != workspace_relative_path.is_some() {
            return Err(format!(
                "Session v2 public projection {field}.workspaceRelativePath does not match kind"
            ));
        }
    }
    Ok(())
}

fn validate_interaction_projection(value: &Value, block_ids: &HashSet<&str>) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Session v2 public interactionProjection must be an object".to_string())?;
    let allowed = HashSet::from(["pending"]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed,
        "interactionProjection",
    )?;
    let Some(pending) = object.get("pending") else {
        return Ok(());
    };
    let pending = pending.as_object().ok_or_else(|| {
        "Session v2 public interactionProjection.pending must be an object".to_string()
    })?;
    let kind = pending.get("kind").and_then(Value::as_str).ok_or_else(|| {
        "Session v2 public interactionProjection.pending.kind is invalid".to_string()
    })?;
    let allowed = match kind {
        "permission" => HashSet::from([
            "kind",
            "interactionId",
            "interactionRevision",
            "targetId",
            "requestId",
            "request",
            "blockId",
            "title",
            "summary",
        ]),
        "plan" => HashSet::from([
            "kind",
            "interactionId",
            "interactionRevision",
            "targetId",
            "runId",
            "planId",
            "blockId",
            "title",
            "summary",
        ]),
        _ => {
            return Err(
                "Session v2 public interactionProjection.pending.kind is invalid".to_string(),
            )
        }
    };
    reject_unknown_fields(
        pending.keys().map(String::as_str),
        &allowed,
        "interactionProjection.pending",
    )?;
    validate_interaction_identity(pending, "interactionProjection.pending")?;
    validate_optional_strings(
        pending,
        &["blockId", "title", "summary"],
        "interactionProjection.pending",
    )?;
    if let Some(block_id) = pending.get("blockId").and_then(Value::as_str) {
        if !block_ids.contains(block_id) {
            return Err(
                "Session v2 public interactionProjection references a missing block".to_string(),
            );
        }
    }
    match kind {
        "permission" => {
            required_identity(
                pending.get("requestId"),
                "interactionProjection.pending.requestId",
            )?;
            let request = pending.get("request").ok_or_else(|| {
                "Session v2 public interactionProjection.pending requires request".to_string()
            })?;
            validate_permission_request(request)?;
        }
        "plan" => {
            required_identity(pending.get("runId"), "interactionProjection.pending.runId")?;
            required_identity(
                pending.get("planId"),
                "interactionProjection.pending.planId",
            )?;
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn validate_interaction_identity(object: &Map<String, Value>, field: &str) -> Result<(), String> {
    for identity in ["interactionId", "interactionRevision", "targetId"] {
        required_identity(object.get(identity), &format!("{field}.{identity}"))?;
    }
    Ok(())
}

fn validate_permission_request(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Session v2 public permission request must be an object".to_string())?;
    let allowed = HashSet::from([
        "id",
        "runId",
        "requestKind",
        "permissionBundleId",
        "contractId",
        "affectedOperationIds",
        "toolId",
        "toolName",
        "riskLevel",
        "summary",
        "diff",
        "argumentsPreview",
    ]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed,
        "permission request",
    )?;
    required_identity(object.get("id"), "permission request.id")?;
    required_identity(object.get("toolName"), "permission request.toolName")?;
    if object.get("summary").and_then(Value::as_str).is_none() {
        return Err("Session v2 public permission request.summary is invalid".to_string());
    }
    validate_required_enum(
        object.get("riskLevel"),
        &["low", "medium", "high", "critical"],
        "permission request.riskLevel",
    )?;
    validate_optional_enum(
        object.get("requestKind"),
        &["runtimePermission", "scopeExpansion"],
        "permission request.requestKind",
    )?;
    validate_optional_strings(
        object,
        &[
            "runId",
            "permissionBundleId",
            "contractId",
            "toolId",
            "diff",
            "argumentsPreview",
        ],
        "permission request",
    )?;
    if let Some(operation_ids) = object.get("affectedOperationIds") {
        validate_string_array(
            Some(operation_ids),
            "permission request.affectedOperationIds",
        )?;
    }
    Ok(())
}

fn validate_token_usage_projection(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Session v2 public tokenUsageProjection must be an object".to_string())?;
    let allowed = HashSet::from(["totals", "requests"]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed,
        "tokenUsageProjection",
    )?;
    validate_token_usage_totals(
        object
            .get("totals")
            .ok_or_else(|| "Session v2 public tokenUsageProjection requires totals".to_string())?,
        "tokenUsageProjection.totals",
        false,
    )?;
    let requests = object
        .get("requests")
        .and_then(Value::as_array)
        .ok_or_else(|| "Session v2 public tokenUsageProjection requires requests".to_string())?;
    let mut request_ids = HashSet::new();
    for request in requests {
        let request = request.as_object().ok_or_else(|| {
            "Session v2 public tokenUsageProjection request must be an object".to_string()
        })?;
        let allowed = HashSet::from([
            "requestId",
            "turnId",
            "userEventId",
            "title",
            "startedAt",
            "completedAt",
            "stages",
            "promptCacheHitTokens",
            "promptCacheMissTokens",
            "cachedTokens",
            "promptTokens",
            "completionTokens",
            "totalTokens",
            "providerCallCount",
            "providers",
        ]);
        reject_unknown_fields(
            request.keys().map(String::as_str),
            &allowed,
            "tokenUsageProjection request",
        )?;
        let request_id = required_identity(
            request.get("requestId"),
            "tokenUsageProjection request.requestId",
        )?;
        if !request_ids.insert(request_id) {
            return Err(format!(
                "Session v2 public projection repeats token usage request {request_id}"
            ));
        }
        for identity in ["turnId", "userEventId", "title"] {
            required_identity(
                request.get(identity),
                &format!("tokenUsageProjection request.{identity}"),
            )?;
        }
        validate_optional_strings(
            request,
            &["startedAt", "completedAt"],
            "tokenUsageProjection request",
        )?;
        validate_string_array(request.get("stages"), "tokenUsageProjection request.stages")?;
        validate_token_usage_totals(
            &Value::Object(request.clone()),
            "tokenUsageProjection request",
            true,
        )?;
    }
    Ok(())
}

fn validate_token_usage_totals(
    value: &Value,
    field: &str,
    permit_request_fields: bool,
) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("Session v2 public {field} must be an object"))?;
    let numeric_fields = [
        "promptCacheHitTokens",
        "promptCacheMissTokens",
        "cachedTokens",
        "promptTokens",
        "completionTokens",
        "totalTokens",
        "providerCallCount",
    ];
    if !permit_request_fields {
        let allowed = numeric_fields
            .iter()
            .copied()
            .chain(std::iter::once("providers"))
            .collect::<HashSet<_>>();
        reject_unknown_fields(object.keys().map(String::as_str), &allowed, field)?;
    }
    for numeric_field in numeric_fields {
        let value = required_safe_integer(
            object.get(numeric_field),
            &format!("{field}.{numeric_field}"),
        )?;
        if value > MAX_PROVIDER_USAGE_TOKENS {
            return Err(format!(
                "Session v2 public projection {field}.{numeric_field} exceeds its limit"
            ));
        }
    }
    let providers = object
        .get("providers")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Session v2 public projection {field}.providers is invalid"))?;
    for provider in providers {
        validate_provider_identity(provider, &format!("{field}.providers"))?;
    }
    Ok(())
}

fn validate_provider_identity(value: &Value, field: &str) -> Result<(), String> {
    let value = required_identity(Some(value), field)?;
    if value.trim() != value
        || value.len() > 1024
        || value.chars().any(|character| character.is_control())
    {
        return Err(format!(
            "Session v2 public projection {field} contains an invalid provider identity"
        ));
    }
    Ok(())
}

fn validate_workspace_projection(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Session v2 public workspaceProjection must be an object".to_string())?;
    let allowed = HashSet::from(["revision", "changedTargets"]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed,
        "workspaceProjection",
    )?;
    required_safe_integer(object.get("revision"), "workspaceProjection.revision")?;
    validate_string_array(
        object.get("changedTargets"),
        "workspaceProjection.changedTargets",
    )
}

fn validate_run_projection(
    value: &Value,
    identities: &NativeProjectionIdentities<'_>,
) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Session v2 public runProjection must be an object".to_string())?;
    let allowed = HashSet::from([
        "runId",
        "turnId",
        "taskId",
        "revision",
        "status",
        "phase",
        "currentActivity",
        "wait",
        "languageBinding",
    ]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, "runProjection")?;
    required_identity(object.get("runId"), "runProjection.runId")?;
    required_safe_integer(object.get("revision"), "runProjection.revision")?;
    validate_required_enum(
        object.get("status"),
        &[
            "active",
            "waitingUser",
            "waitingExternal",
            "paused",
            "succeeded",
            "failed",
            "cancelled",
        ],
        "runProjection.status",
    )?;
    validate_required_enum(
        object.get("phase"),
        &[
            "preparing",
            "processing",
            "executing",
            "validating",
            "waiting",
            "settled",
        ],
        "runProjection.phase",
    )?;
    validate_optional_strings(object, &["turnId", "taskId"], "runProjection")?;
    let turn_id = object.get("turnId").and_then(Value::as_str);
    if let Some(turn_id) = turn_id {
        if !identities.turn_ids.contains(turn_id) {
            return Err(
                "Session v2 public projection runProjection references a missing turn".to_string(),
            );
        }
    }
    validate_language_binding(
        object.get("languageBinding"),
        "runProjection.languageBinding",
    )?;
    match object.get("currentActivity") {
        Some(Value::Null) => {}
        Some(activity) => {
            validate_current_activity(activity)?;
            let activity = activity.as_object().expect("validated currentActivity");
            let work_segment_id = activity.get("workSegmentId").and_then(Value::as_str);
            if let Some(work_segment_id) = work_segment_id {
                if turn_id.is_none()
                    || identities
                        .work_segment_turn_ids
                        .get(work_segment_id)
                        .copied()
                        != turn_id
                {
                    return Err(
                        "Session v2 public projection currentActivity references another turn work segment"
                            .to_string(),
                    );
                }
            }
            if let Some(operation_id) = activity.get("operationId").and_then(Value::as_str) {
                if work_segment_id.is_none()
                    || identities.operation_segment_ids.get(operation_id).copied()
                        != work_segment_id
                {
                    return Err(
                        "Session v2 public projection currentActivity operation does not belong to its work segment"
                            .to_string(),
                    );
                }
            }
        }
        None => {
            return Err(
                "Session v2 public projection runProjection requires currentActivity".to_string(),
            )
        }
    }
    match object.get("wait") {
        Some(Value::Null) => {}
        Some(wait) => validate_wait(wait)?,
        None => return Err("Session v2 public projection runProjection requires wait".to_string()),
    }
    validate_run_projection_semantics(object)?;
    Ok(())
}

fn validate_run_projection_semantics(object: &Map<String, Value>) -> Result<(), String> {
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let phase = object
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let activity_is_null = object.get("currentActivity").is_some_and(Value::is_null);
    let wait = object.get("wait");
    let wait_kind = wait
        .and_then(Value::as_object)
        .and_then(|wait| wait.get("kind"))
        .and_then(Value::as_str);
    match status {
        "succeeded" | "failed" | "cancelled" => {
            if phase != "settled" || !activity_is_null || !wait.is_some_and(Value::is_null) {
                return Err(
                    "Session v2 public projection terminal run state is inconsistent".to_string(),
                );
            }
        }
        "waitingUser" => {
            if phase != "waiting" || !activity_is_null || wait_kind != Some("user") {
                return Err(
                    "Session v2 public projection waitingUser run state is inconsistent"
                        .to_string(),
                );
            }
        }
        "waitingExternal" => {
            if phase != "waiting" || !activity_is_null || wait_kind != Some("external") {
                return Err(
                    "Session v2 public projection waitingExternal run state is inconsistent"
                        .to_string(),
                );
            }
        }
        "paused" => {
            if phase != "waiting" || !activity_is_null || wait_kind != Some("paused") {
                return Err(
                    "Session v2 public projection paused run state is inconsistent".to_string(),
                );
            }
        }
        "active" => {
            if matches!(phase, "waiting" | "settled") || !wait.is_some_and(Value::is_null) {
                return Err(
                    "Session v2 public projection active run state is inconsistent".to_string(),
                );
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_current_activity(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or_else(|| {
        "Session v2 public projection currentActivity must be an object".to_string()
    })?;
    let allowed = HashSet::from([
        "code",
        "summary",
        "operationId",
        "workSegmentId",
        "updatedAt",
    ]);
    reject_unknown_fields(
        object.keys().map(String::as_str),
        &allowed,
        "currentActivity",
    )?;
    validate_required_enum(
        object.get("code"),
        &[
            "session.admitting",
            "provider.awaitingFirstByte",
            "provider.reasoning",
            "provider.composing",
            "resource.resolving",
            "kernel.executing",
            "session.validating",
            "session.persisting",
            "retry.backoff",
        ],
        "currentActivity.code",
    )?;
    if object.get("code").and_then(Value::as_str) == Some("provider.reasoning")
        && object.contains_key("summary")
    {
        return Err(
            "Session v2 public projection provider reasoning activity cannot expose a summary"
                .to_string(),
        );
    }
    required_identity(object.get("updatedAt"), "currentActivity.updatedAt")?;
    validate_optional_strings(
        object,
        &["summary", "operationId", "workSegmentId"],
        "currentActivity",
    )
}

fn validate_wait(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Session v2 public projection wait must be an object".to_string())?;
    let allowed = HashSet::from(["kind", "reason", "interactionId"]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, "wait")?;
    validate_required_enum(
        object.get("kind"),
        &["user", "external", "paused"],
        "wait.kind",
    )?;
    validate_optional_strings(object, &["reason", "interactionId"], "wait")
}

fn validate_provenance(value: Option<&Value>, field: &str) -> Result<(), String> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| format!("Session v2 public projection requires {field}"))?;
    let allowed = HashSet::from([
        "origin",
        "authority",
        "sourceEventRefs",
        "factRefs",
        "evidenceRefs",
    ]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, field)?;
    validate_required_enum(
        object.get("origin"),
        &["user", "session", "kernel", "provider"],
        &format!("{field}.origin"),
    )?;
    validate_required_enum(
        object.get("authority"),
        &["user", "session", "kernel"],
        &format!("{field}.authority"),
    )?;
    validate_string_array(
        object.get("sourceEventRefs"),
        &format!("{field}.sourceEventRefs"),
    )?;
    validate_string_array(object.get("factRefs"), &format!("{field}.factRefs"))?;
    validate_string_array(object.get("evidenceRefs"), &format!("{field}.evidenceRefs"))
}

fn validate_language_binding(value: Option<&Value>, field: &str) -> Result<(), String> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| format!("Session v2 public projection requires {field}"))?;
    let allowed = HashSet::from(["language", "revision", "status", "sourceTurnId"]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, field)?;
    validate_required_enum(
        object.get("language"),
        &["neutral", "zh-CN", "en-US"],
        &format!("{field}.language"),
    )?;
    validate_required_enum(
        object.get("status"),
        &[
            "pending",
            "resolved",
            "fallback",
            "superseded",
            "unavailable",
        ],
        &format!("{field}.status"),
    )?;
    validate_optional_safe_integer(object.get("revision"), &format!("{field}.revision"))?;
    if let Some(source_turn_id) = object.get("sourceTurnId") {
        required_identity(Some(source_turn_id), &format!("{field}.sourceTurnId"))?;
    }
    Ok(())
}

fn validate_timeline_status(value: Option<&Value>, field: &str) -> Result<(), String> {
    validate_required_enum(
        value,
        &[
            "queued",
            "running",
            "waiting",
            "blocked",
            "completed",
            "cancelled",
            "failed",
        ],
        field,
    )
}

fn validate_task_projection_progress(value: Option<&Value>, field: &str) -> Result<(), String> {
    validate_required_enum(value, &["queued", "thinking", "completed"], field)
}

fn validate_work_operation_status(value: Option<&Value>, field: &str) -> Result<(), String> {
    validate_required_enum(
        value,
        &[
            "preparing",
            "queued",
            "running",
            "awaitingCapability",
            "completed",
            "denied",
            "failed",
            "failedAfterObservedEffect",
            "indeterminate",
            "cancelled",
            "stale",
            "unexecuted",
        ],
        field,
    )
}

fn validate_required_enum(
    value: Option<&Value>,
    allowed: &[&str],
    field: &str,
) -> Result<(), String> {
    match value.and_then(Value::as_str) {
        Some(candidate) if allowed.contains(&candidate) => Ok(()),
        _ => Err(format!("Session v2 public projection {field} is invalid")),
    }
}

fn validate_optional_enum(
    value: Option<&Value>,
    allowed: &[&str],
    field: &str,
) -> Result<(), String> {
    match value {
        None => Ok(()),
        Some(value) => validate_required_enum(Some(value), allowed, field),
    }
}

fn validate_optional_strings(
    object: &Map<String, Value>,
    fields: &[&str],
    scope: &str,
) -> Result<(), String> {
    for field in fields {
        if object
            .get(*field)
            .is_some_and(|value| value.as_str().is_none())
        {
            return Err(format!(
                "Session v2 public projection {scope}.{field} is invalid"
            ));
        }
    }
    Ok(())
}

fn validate_string_array(value: Option<&Value>, field: &str) -> Result<(), String> {
    if value
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().all(Value::is_string))
    {
        Ok(())
    } else {
        Err(format!(
            "Session v2 public projection {field} must be a string array"
        ))
    }
}

fn validate_string_map(value: &Value, field: &str) -> Result<(), String> {
    if value
        .as_object()
        .is_some_and(|entries| entries.values().all(Value::is_string))
    {
        Ok(())
    } else {
        Err(format!(
            "Session v2 public projection {field} must be a string map"
        ))
    }
}

fn required_safe_integer(value: Option<&Value>, field: &str) -> Result<u64, String> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| format!("Session v2 public projection requires safe integer {field}"))
}

fn validate_optional_safe_integer(value: Option<&Value>, field: &str) -> Result<(), String> {
    match value {
        None => Ok(()),
        Some(value) => required_safe_integer(Some(value), field).map(|_| ()),
    }
}

fn required_identity<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a str, String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Session v2 public projection requires {field}"))
}

fn reject_private_projection_fields(value: &Value) -> Result<(), String> {
    match value {
        Value::Array(items) => {
            for item in items {
                reject_private_projection_fields(item)?;
            }
        }
        Value::Object(fields) => {
            for (key, nested) in fields {
                let normalized_key = key
                    .bytes()
                    .filter(u8::is_ascii_alphanumeric)
                    .map(|byte| byte.to_ascii_lowercase())
                    .collect::<Vec<_>>();
                if matches!(
                    normalized_key.as_slice(),
                    b"events"
                        | b"payload"
                        | b"kernelevent"
                        | b"rawprovider"
                        | b"rawupstreamenvelope"
                        | b"providertrace"
                        | b"rawarguments"
                        | b"reasoning"
                        | b"reasoningcontent"
                        | b"reasoningtrace"
                        | b"thinking"
                        | b"thinkingdelta"
                        | b"analysis"
                        | b"chainofthought"
                ) {
                    return Err(format!(
                        "Session v2 public projection contains private field {key}"
                    ));
                }
                reject_private_projection_fields(nested)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn reject_unknown_fields<'a>(
    fields: impl Iterator<Item = &'a str>,
    allowed: &HashSet<&str>,
    scope: &str,
) -> Result<(), String> {
    if let Some(field) = fields.into_iter().find(|field| !allowed.contains(field)) {
        return Err(format!(
            "Session v2 public projection {scope} contains unsupported field {field}"
        ));
    }
    Ok(())
}
