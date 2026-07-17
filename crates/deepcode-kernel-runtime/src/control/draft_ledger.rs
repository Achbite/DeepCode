use super::*;
use deepcode_kernel_abi::{
    ArtifactDraftLedgerFrame, ArtifactDraftPartKind, ArtifactEditMatch,
    ARTIFACT_DRAFT_SCHEMA_VERSION,
};
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct ArtifactDraftAdmission {
    pub(super) draft_id: String,
    pub(super) draft_key: String,
    pub(super) part_kind: ArtifactDraftPartKind,
    pub(super) opened: bool,
    pub(super) terminal: bool,
    pub(super) record: ArtifactDraftRuntimeRecord,
}

pub(super) fn admit_artifact_draft_frame(
    state: &RuntimeState,
    command_run_id: &str,
    command_session_id: &str,
    frame: &ArtifactDraftLedgerFrame,
) -> KernelResult<ArtifactDraftAdmission> {
    let base = frame.base();
    if base.schema_version != ARTIFACT_DRAFT_SCHEMA_VERSION {
        return Err(invalid(
            "artifact draft frame has an unsupported schemaVersion",
        ));
    }
    require_text(&base.run_id, "runId")?;
    require_text(&base.session_id, "sessionId")?;
    require_text(&base.draft_id, "draftId")?;
    require_text(&base.frame_id, "frameId")?;
    require_text(&base.task_id, "taskId")?;
    require_text(&base.content_hash, "contentHash")?;
    if base.run_id != command_run_id {
        return Err(invalid(
            "artifact draft frame runId does not match the command run",
        ));
    }
    if base.session_id != command_session_id {
        return Err(invalid(
            "artifact draft frame sessionId does not match the command session",
        ));
    }
    if base.sequence == 0 {
        return Err(invalid("artifact draft frame requires a positive sequence"));
    }
    let expected_slot_ids = string_set(&base.expected_slot_ids, "expectedSlotIds")?;
    if expected_slot_ids.is_empty() {
        return Err(invalid(
            "artifact draft frame expectedSlotIds must not be empty",
        ));
    }

    let draft_key = format!("{command_run_id}:{}", base.draft_id);
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
            task_id: base.task_id.clone(),
            draft_id: base.draft_id.clone(),
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
        || record.task_id != base.task_id
        || record.draft_id != base.draft_id
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
    if base.sequence != record.next_sequence {
        return Err(invalid(format!(
            "artifact draft sequence must be {}; received {}",
            record.next_sequence, base.sequence
        )));
    }
    if !record.frame_ids.insert(base.frame_id.clone()) {
        return Err(invalid("artifact draft frameId was already recorded"));
    }

    match frame {
        ArtifactDraftLedgerFrame::ArtifactChunk {
            slot_id,
            content_lines,
            final_chunk,
            edit_match,
            ..
        } => admit_chunk(
            &mut record,
            base,
            slot_id,
            content_lines,
            *final_chunk,
            edit_match.as_ref(),
        )?,
        ArtifactDraftLedgerFrame::BatchDone { metadata, .. } => {
            admit_batch_done(&mut record, base, &metadata.summary)?
        }
        ArtifactDraftLedgerFrame::Diagnostic { metadata, .. } => {
            admit_diagnostic(&mut record, base, &metadata.reason)?
        }
    }
    record.next_sequence += 1;
    let terminal = record.terminal;
    Ok(ArtifactDraftAdmission {
        draft_id: base.draft_id.clone(),
        draft_key,
        part_kind: frame.part_kind(),
        opened,
        terminal,
        record,
    })
}

fn admit_chunk(
    record: &mut ArtifactDraftRuntimeRecord,
    base: &deepcode_kernel_abi::ArtifactDraftFrameBase,
    slot_id: &str,
    content_lines: &[String],
    final_chunk: bool,
    edit_match: Option<&ArtifactEditMatch>,
) -> KernelResult<()> {
    require_text(slot_id, "slotId")?;
    if !record.expected_slot_ids.contains(slot_id) {
        return Err(invalid("artifact chunk references an unknown slotId"));
    }
    if record.completed_slot_ids.contains(slot_id) {
        return Err(invalid("artifact chunk targets an already completed slot"));
    }
    if content_lines.is_empty() {
        return Err(invalid(
            "artifact chunk contentLines must contain at least one string",
        ));
    }
    let serialized = serde_json::to_string(content_lines)
        .map_err(|error| invalid(format!("artifact chunk serialization failed: {error}")))?;
    let hash_payload = artifact_chunk_hash_payload(&serialized, edit_match)?;
    require_hash(base, fnv1a64_hex(&hash_payload))?;
    if let Some(edit_match) = edit_match {
        if record.edit_match_hashes_by_slot.contains_key(slot_id) {
            return Err(invalid(
                "artifact editMatch is only allowed on the first chunk for a slot",
            ));
        }
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
    let added_bytes =
        content_lines_utf8_bytes(content_lines) + if previous_chunks > 0 { 1 } else { 0 };
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
    if final_chunk {
        record.completed_slot_ids.insert(slot_id.to_string());
    }
    Ok(())
}

fn content_lines_utf8_bytes(lines: &[String]) -> u64 {
    let text_bytes = lines
        .iter()
        .fold(0u64, |total, line| total.saturating_add(line.len() as u64));
    text_bytes.saturating_add(lines.len().saturating_sub(1) as u64)
}

fn artifact_chunk_hash_payload(
    serialized_lines: &str,
    edit_match: Option<&ArtifactEditMatch>,
) -> KernelResult<String> {
    let Some(edit_match) = edit_match else {
        return Ok(serialized_lines.to_string());
    };
    Ok(format!(
        "{serialized_lines}\n{}",
        canonical_edit_match(edit_match)?
    ))
}

fn canonical_edit_match(edit_match: &ArtifactEditMatch) -> KernelResult<String> {
    match edit_match {
        ArtifactEditMatch::ExactBlock { target_lines } => Ok(format!(
            "exactBlock\0{}",
            serialized_lines(target_lines, "targetLines", false)?
        )),
        ArtifactEditMatch::ContextBlock {
            before_lines,
            target_lines,
            after_lines,
        } => Ok(format!(
            "contextBlock\0{}\0{}\0{}",
            serialized_lines(before_lines, "beforeLines", true)?,
            serialized_lines(target_lines, "targetLines", false)?,
            serialized_lines(after_lines, "afterLines", true)?
        )),
        ArtifactEditMatch::LineRange {
            start_line,
            end_line,
            expected_file_hash,
            expected_before_lines,
            expected_before_text,
        } => {
            if *start_line == 0 || end_line < start_line {
                return Err(invalid(
                    "artifact lineRange requires a positive startLine <= endLine",
                ));
            }
            let expected_hash = expected_file_hash.as_deref().unwrap_or_default();
            let expected_lines = expected_before_lines
                .as_ref()
                .map(|lines| serialized_lines(lines, "expectedBeforeLines", false))
                .transpose()?
                .unwrap_or_else(|| "[]".to_string());
            let expected_text =
                serde_json::to_string(expected_before_text.as_deref().unwrap_or_default())
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
    }
}

fn serialized_lines(lines: &[String], field: &str, allow_empty: bool) -> KernelResult<String> {
    if !allow_empty && lines.is_empty() {
        return Err(invalid(format!(
            "artifact editMatch {field} must be a non-empty string array"
        )));
    }
    serde_json::to_string(lines).map_err(|error| {
        invalid(format!(
            "artifact editMatch {field} serialization failed: {error}"
        ))
    })
}

fn admit_batch_done(
    record: &mut ArtifactDraftRuntimeRecord,
    base: &deepcode_kernel_abi::ArtifactDraftFrameBase,
    summary: &str,
) -> KernelResult<()> {
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
    require_text(summary, "metadata.summary")?;
    require_hash(base, fnv1a64_hex(summary))?;
    record.terminal = true;
    Ok(())
}

fn admit_diagnostic(
    record: &mut ArtifactDraftRuntimeRecord,
    base: &deepcode_kernel_abi::ArtifactDraftFrameBase,
    reason: &str,
) -> KernelResult<()> {
    require_text(reason, "metadata.reason")?;
    require_hash(base, fnv1a64_hex(reason))?;
    record.terminal = true;
    Ok(())
}

fn require_hash(
    base: &deepcode_kernel_abi::ArtifactDraftFrameBase,
    expected: String,
) -> KernelResult<()> {
    if base.content_hash != expected {
        return Err(invalid(
            "artifact draft contentHash does not match frame content",
        ));
    }
    Ok(())
}

fn require_text<'a>(value: &'a str, field: &str) -> KernelResult<&'a str> {
    if value.trim().is_empty() {
        return Err(invalid(format!("artifact draft frame missing {field}")));
    }
    Ok(value)
}

fn string_set(values: &[String], field: &str) -> KernelResult<BTreeSet<String>> {
    values
        .iter()
        .map(|value| {
            if value.trim().is_empty() {
                return Err(invalid(format!(
                    "artifact draft {field} contains an invalid value"
                )));
            }
            Ok(value.clone())
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
