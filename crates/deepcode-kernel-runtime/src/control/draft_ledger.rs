use super::*;
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct ArtifactDraftAdmission {
    pub(super) draft_id: String,
    pub(super) part_kind: String,
    pub(super) opened: bool,
    pub(super) terminal: bool,
}

pub(super) fn admit_artifact_draft_frame(
    state: &mut RuntimeState,
    command_run_id: &str,
    command_session_id: &str,
    frame: &Value,
) -> KernelResult<ArtifactDraftAdmission> {
    if require_string(frame, "schemaVersion")? != "deepcode.agent.artifact-draft.v1" {
        return Err(invalid(
            "artifact draft frame has an unsupported schemaVersion",
        ));
    }
    let frame_run_id = require_string(frame, "runId")?;
    if frame_run_id != command_run_id {
        return Err(invalid(
            "artifact draft frame runId does not match the command run",
        ));
    }
    let frame_session_id = require_string(frame, "sessionId")?;
    if frame_session_id != command_session_id {
        return Err(invalid(
            "artifact draft frame sessionId does not match the command session",
        ));
    }
    let draft_id = require_string(frame, "draftId")?.to_string();
    let frame_id = require_string(frame, "frameId")?.to_string();
    let task_id = require_string(frame, "taskId")?.to_string();
    let part_kind = require_string(frame, "partKind")?.to_string();
    let sequence = frame
        .get("sequence")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid("artifact draft frame requires a positive sequence"))?;
    let expected_slot_ids = string_set(frame, "expectedSlotIds")?;
    if expected_slot_ids.is_empty() {
        return Err(invalid(
            "artifact draft frame expectedSlotIds must not be empty",
        ));
    }
    let draft_key = format!("{command_run_id}:{draft_id}");
    if state.terminal_artifact_draft_keys.contains(&draft_key) {
        return Err(invalid("artifact draft is already terminal"));
    }
    let opened = !state.artifact_drafts.contains_key(&draft_key);
    let mut record = state
        .artifact_drafts
        .get(&draft_key)
        .cloned()
        .unwrap_or_else(|| ArtifactDraftRuntimeRecord {
            run_id: command_run_id.to_string(),
            session_id: command_session_id.to_string(),
            task_id: task_id.clone(),
            draft_id: draft_id.clone(),
            next_sequence: 1,
            expected_slot_ids: expected_slot_ids.clone(),
            completed_slot_ids: BTreeSet::new(),
            frame_ids: BTreeSet::new(),
            content_bytes_by_slot: BTreeMap::new(),
            chunk_counts_by_slot: BTreeMap::new(),
            edit_match_hashes_by_slot: BTreeMap::new(),
            total_content_bytes: 0,
            terminal: false,
        });
    if record.run_id != command_run_id
        || record.session_id != command_session_id
        || record.task_id != task_id
        || record.draft_id != draft_id
    {
        return Err(invalid(
            "artifact draft binding changed after draft creation",
        ));
    }
    if record.terminal {
        return Err(invalid("artifact draft is already terminal"));
    }
    if record.expected_slot_ids != expected_slot_ids {
        return Err(invalid(
            "artifact draft expectedSlotIds changed after draft creation",
        ));
    }
    if sequence != record.next_sequence {
        return Err(invalid(format!(
            "artifact draft sequence must be {}; received {sequence}",
            record.next_sequence
        )));
    }
    if !record.frame_ids.insert(frame_id) {
        return Err(invalid("artifact draft frameId was already recorded"));
    }

    match part_kind.as_str() {
        "artifactChunk" => admit_chunk(&mut record, frame)?,
        "batchDone" => admit_batch_done(&mut record, frame)?,
        "diagnostic" => admit_diagnostic(&mut record, frame)?,
        other => {
            return Err(invalid(format!(
                "unsupported artifact draft part kind: {other}"
            )))
        }
    }
    record.next_sequence += 1;
    let terminal = record.terminal;
    state.artifact_drafts.insert(draft_key, record);
    Ok(ArtifactDraftAdmission {
        draft_id,
        part_kind,
        opened,
        terminal,
    })
}

fn admit_chunk(record: &mut ArtifactDraftRuntimeRecord, frame: &Value) -> KernelResult<()> {
    let slot_id = require_string(frame, "slotId")?;
    if !record.expected_slot_ids.contains(slot_id) {
        return Err(invalid("artifact chunk references an unknown slotId"));
    }
    if record.completed_slot_ids.contains(slot_id) {
        return Err(invalid("artifact chunk targets an already completed slot"));
    }
    let lines = frame
        .get("contentLines")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("artifact chunk contentLines must be an array"))?;
    if lines.is_empty() || lines.iter().any(|line| !line.is_string()) {
        return Err(invalid(
            "artifact chunk contentLines must contain at least one string",
        ));
    }
    let serialized = serde_json::to_string(lines)
        .map_err(|error| invalid(format!("artifact chunk serialization failed: {error}")))?;
    let edit_match = frame.get("editMatch");
    let hash_payload = artifact_chunk_hash_payload(&serialized, edit_match)?;
    require_hash(frame, fnv1a64_hex(&hash_payload))?;
    if let Some(edit_match) = edit_match {
        if record.edit_match_hashes_by_slot.contains_key(slot_id) {
            return Err(invalid(
                "artifact editMatch is only allowed on the first chunk for a slot",
            ));
        }
        validate_edit_match(edit_match)?;
        record.edit_match_hashes_by_slot.insert(
            slot_id.to_string(),
            fnv1a64_hex(&canonical_edit_match(edit_match)?),
        );
    }
    let previous_bytes = record
        .content_bytes_by_slot
        .get(slot_id)
        .copied()
        .unwrap_or(0);
    let previous_chunks = record
        .chunk_counts_by_slot
        .get(slot_id)
        .copied()
        .unwrap_or(0);
    let added_bytes = content_lines_utf8_bytes(lines)? + if previous_chunks > 0 { 1 } else { 0 };
    let next_total = record.total_content_bytes.saturating_add(added_bytes);
    if next_total > ARTIFACT_DRAFT_MAX_TOTAL_UTF8_BYTES {
        return Err(KernelError::InvalidCommand(format!(
            "artifact_draft_budget_exceeded: draft content would use {next_total} bytes; maximum is {ARTIFACT_DRAFT_MAX_TOTAL_UTF8_BYTES}"
        )));
    }
    record.content_bytes_by_slot.insert(
        slot_id.to_string(),
        previous_bytes.saturating_add(added_bytes),
    );
    record
        .chunk_counts_by_slot
        .insert(slot_id.to_string(), previous_chunks.saturating_add(1));
    record.total_content_bytes = next_total;
    if frame.get("finalChunk").and_then(Value::as_bool) == Some(true) {
        record.completed_slot_ids.insert(slot_id.to_string());
    }
    Ok(())
}

fn content_lines_utf8_bytes(lines: &[Value]) -> KernelResult<u64> {
    let text_bytes = lines.iter().try_fold(0u64, |total, line| {
        let value = line
            .as_str()
            .ok_or_else(|| invalid("artifact chunk contentLines contains a non-string value"))?;
        Ok::<u64, KernelError>(total.saturating_add(value.len() as u64))
    })?;
    Ok(text_bytes.saturating_add(lines.len().saturating_sub(1) as u64))
}

fn artifact_chunk_hash_payload(
    serialized_lines: &str,
    edit_match: Option<&Value>,
) -> KernelResult<String> {
    let Some(edit_match) = edit_match else {
        return Ok(serialized_lines.to_string());
    };
    Ok(format!(
        "{serialized_lines}\n{}",
        canonical_edit_match(edit_match)?
    ))
}

fn canonical_edit_match(edit_match: &Value) -> KernelResult<String> {
    let kind = require_string(edit_match, "kind")?;
    match kind {
        "exactBlock" => Ok(format!(
            "exactBlock\0{}",
            serialized_string_array(edit_match, "targetLines", false)?
        )),
        "contextBlock" => Ok(format!(
            "contextBlock\0{}\0{}\0{}",
            serialized_string_array(edit_match, "beforeLines", true)?,
            serialized_string_array(edit_match, "targetLines", false)?,
            serialized_string_array(edit_match, "afterLines", true)?
        )),
        "lineRange" => {
            let start_line = positive_u64(edit_match, "startLine")?;
            let end_line = positive_u64(edit_match, "endLine")?;
            if end_line < start_line {
                return Err(invalid(
                    "artifact lineRange endLine must be greater than or equal to startLine",
                ));
            }
            let expected_hash = edit_match
                .get("expectedFileHash")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let expected_lines = edit_match
                .get("expectedBeforeLines")
                .map(|_| serialized_string_array(edit_match, "expectedBeforeLines", false))
                .transpose()?
                .unwrap_or_else(|| "[]".to_string());
            let expected_text = serde_json::to_string(
                edit_match
                    .get("expectedBeforeText")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
            .map_err(|error| {
                invalid(format!(
                    "artifact editMatch expectedBeforeText serialization failed: {error}"
                ))
            })?;
            if expected_hash.is_empty() && expected_lines == "[]" {
                return Err(invalid(
                    "artifact lineRange requires expectedFileHash or expectedBeforeLines",
                ));
            }
            Ok(format!(
                "lineRange\0{start_line}\0{end_line}\0{expected_hash}\0{expected_lines}\0{expected_text}"
            ))
        }
        other => Err(invalid(format!(
            "unsupported artifact editMatch kind: {other}"
        ))),
    }
}

fn validate_edit_match(edit_match: &Value) -> KernelResult<()> {
    canonical_edit_match(edit_match).map(|_| ())
}

fn serialized_string_array(value: &Value, field: &str, allow_empty: bool) -> KernelResult<String> {
    let items = value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(format!("artifact editMatch missing {field}")))?;
    if (!allow_empty && items.is_empty()) || items.iter().any(|item| !item.is_string()) {
        return Err(invalid(format!(
            "artifact editMatch {field} must be {}string array",
            if allow_empty { "a " } else { "a non-empty " }
        )));
    }
    serde_json::to_string(items).map_err(|error| {
        invalid(format!(
            "artifact editMatch {field} serialization failed: {error}"
        ))
    })
}

fn positive_u64(value: &Value, field: &str) -> KernelResult<u64> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            invalid(format!(
                "artifact editMatch {field} must be a positive integer"
            ))
        })
}

fn admit_batch_done(record: &mut ArtifactDraftRuntimeRecord, frame: &Value) -> KernelResult<()> {
    if record.completed_slot_ids != record.expected_slot_ids {
        let incomplete = record
            .expected_slot_ids
            .difference(&record.completed_slot_ids)
            .cloned()
            .collect::<Vec<_>>();
        return Err(invalid(format!(
            "artifact draft is incomplete; missing slots: {}",
            incomplete.join(", ")
        )));
    }
    let summary = frame
        .get("metadata")
        .and_then(|value| value.get("summary"))
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("artifact batchDone requires metadata.summary"))?;
    require_hash(frame, fnv1a64_hex(summary))?;
    record.terminal = true;
    Ok(())
}

fn admit_diagnostic(record: &mut ArtifactDraftRuntimeRecord, frame: &Value) -> KernelResult<()> {
    let reason = frame
        .get("metadata")
        .and_then(|value| value.get("reason"))
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("artifact diagnostic requires metadata.reason"))?;
    require_hash(frame, fnv1a64_hex(reason))?;
    record.terminal = true;
    Ok(())
}

fn require_hash(frame: &Value, expected: String) -> KernelResult<()> {
    let actual = require_string(frame, "contentHash")?;
    if actual != expected {
        return Err(invalid(
            "artifact draft contentHash does not match frame content",
        ));
    }
    Ok(())
}

fn require_string<'a>(value: &'a Value, field: &str) -> KernelResult<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid(format!("artifact draft frame missing {field}")))
}

fn string_set(value: &Value, field: &str) -> KernelResult<BTreeSet<String>> {
    let values = value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(format!("artifact draft frame missing {field}")))?;
    values
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|item| !item.trim().is_empty())
                .map(ToOwned::to_owned)
                .ok_or_else(|| invalid(format!("artifact draft {field} contains an invalid value")))
        })
        .collect()
}

fn fnv1a64_hex(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

fn invalid(message: impl Into<String>) -> KernelError {
    KernelError::InvalidCommand(message.into())
}
