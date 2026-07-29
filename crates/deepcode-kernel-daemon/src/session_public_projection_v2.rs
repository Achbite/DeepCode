use serde_json::Value;
use std::collections::HashSet;

const PROJECTION_SCHEMA_V2: &str = "deepcode.shared-conversation-projection.v2";

pub(crate) fn validate_shared_projection_timeline(timeline: &Value) -> Result<(), String> {
    let object = timeline
        .as_object()
        .ok_or_else(|| "Session v2 public projection must be an object".to_string())?;
    let allowed_root = HashSet::from([
        "schemaVersion",
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
    let session_id = required_identity(object.get("sessionId"), "projection.sessionId")?;
    required_identity(object.get("generatedAt"), "projection.generatedAt")?;
    for field in ["revision", "sourceEventVersion", "eventCount"] {
        if object.get(field).and_then(Value::as_u64).is_none() {
            return Err(format!(
                "Session v2 public projection requires safe integer {field}"
            ));
        }
    }
    let turns = object
        .get("turns")
        .and_then(Value::as_array)
        .ok_or_else(|| "Session v2 public projection requires turns".to_string())?;
    let mut turn_ids = HashSet::new();
    let mut block_ids = HashSet::new();
    for turn in turns {
        validate_turn(turn, session_id, &mut turn_ids, &mut block_ids)?;
    }
    Ok(())
}

fn validate_turn<'a>(
    turn: &'a Value,
    session_id: &str,
    turn_ids: &mut HashSet<&'a str>,
    block_ids: &mut HashSet<&'a str>,
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
    ]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, "turn")?;
    let turn_id = required_identity(object.get("id"), "turn.id")?;
    if !turn_ids.insert(turn_id) {
        return Err(format!(
            "Session v2 public projection repeats turn {turn_id}"
        ));
    }
    if object.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err("Session v2 public projection turn crosses Session identity".to_string());
    }
    if object
        .get("sequence")
        .is_some_and(|value| value.as_u64().is_none())
    {
        return Err("Session v2 public projection turn sequence is invalid".to_string());
    }
    if !matches!(
        object.get("status").and_then(Value::as_str),
        Some("queued" | "running" | "waiting" | "blocked" | "completed" | "cancelled" | "failed")
    ) {
        return Err("Session v2 public projection turn status is invalid".to_string());
    }
    for field in ["startedAt", "completedAt"] {
        if object
            .get(field)
            .is_some_and(|value| value.as_str().is_none())
        {
            return Err(format!(
                "Session v2 public projection turn {field} is invalid"
            ));
        }
    }
    let blocks = object
        .get("blocks")
        .and_then(Value::as_array)
        .ok_or_else(|| "Session v2 public projection turn requires blocks".to_string())?;
    for block in blocks {
        validate_block(block, block_ids)?;
    }
    Ok(())
}

fn validate_block<'a>(block: &'a Value, block_ids: &mut HashSet<&'a str>) -> Result<(), String> {
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
        "displayHints",
        "evidenceRefs",
        "provenance",
        "languageBinding",
        "taskProjectionRef",
    ]);
    reject_unknown_fields(object.keys().map(String::as_str), &allowed, "block")?;
    let block_id = required_identity(object.get("id"), "block.id")?;
    if !block_ids.insert(block_id) {
        return Err(format!(
            "Session v2 public projection repeats block {block_id}"
        ));
    }
    required_identity(object.get("kind"), "block.kind")?;
    required_identity(object.get("title"), "block.title")?;
    if object.get("summary").and_then(Value::as_str).is_none()
        || object
            .get("defaultCollapsed")
            .and_then(Value::as_bool)
            .is_none()
        || !matches!(
            object.get("durability").and_then(Value::as_str),
            Some("live" | "committed")
        )
        || !matches!(
            object.get("entryRole").and_then(Value::as_str),
            Some(
                "userMessage"
                    | "agentUpdate"
                    | "activityGroup"
                    | "evidence"
                    | "interaction"
                    | "finalAnswer"
                    | "diagnostic"
            )
        )
        || !matches!(
            object.get("status").and_then(Value::as_str),
            Some(
                "queued" | "running" | "waiting" | "blocked" | "completed" | "cancelled" | "failed"
            )
        )
    {
        return Err(format!(
            "Session v2 public projection block {block_id} has invalid required fields"
        ));
    }
    if let Some(attachments) = object.get("attachments") {
        deepcode_kernel_abi::decode_agent_input_attachments_v2(attachments).map_err(|error| {
            format!(
                "Session v2 public projection block {block_id} has invalid attachments: {}",
                error.code
            )
        })?;
    }
    validate_provenance(object.get("provenance"))?;
    validate_language_binding(object.get("languageBinding"))?;
    Ok(())
}

fn validate_provenance(value: Option<&Value>) -> Result<(), String> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| "Session v2 public projection block requires provenance".to_string())?;
    if !matches!(
        object.get("origin").and_then(Value::as_str),
        Some("user" | "session" | "kernel" | "provider")
    ) || !matches!(
        object.get("authority").and_then(Value::as_str),
        Some("user" | "session" | "kernel")
    ) || !string_array(object.get("sourceEventRefs"))
        || !string_array(object.get("factRefs"))
        || !string_array(object.get("evidenceRefs"))
    {
        return Err("Session v2 public projection block provenance is invalid".to_string());
    }
    Ok(())
}

fn validate_language_binding(value: Option<&Value>) -> Result<(), String> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| "Session v2 public projection block requires languageBinding".to_string())?;
    if !matches!(
        object.get("language").and_then(Value::as_str),
        Some("neutral" | "zh-CN" | "en-US")
    ) || !matches!(
        object.get("status").and_then(Value::as_str),
        Some("pending" | "resolved" | "fallback" | "superseded" | "unavailable")
    ) {
        return Err("Session v2 public projection block languageBinding is invalid".to_string());
    }
    Ok(())
}

fn string_array(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().all(Value::is_string))
}

fn required_identity<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a str, String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Session v2 public projection requires {field}"))
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
