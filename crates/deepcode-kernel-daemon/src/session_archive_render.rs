use crate::prelude::*;
use crate::*;

pub(crate) fn append_jsonl_file(path: &FsPath, entries: &[Value]) -> std::io::Result<()> {
    use std::io::Write;

    let _append_guard = jsonl_file_lock(path)
        .lock()
        .expect("archive jsonl append lock");
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent)?;
    let mut bytes = Vec::new();
    for entry in entries {
        bytes.extend(serde_json::to_vec(entry).unwrap_or_else(|_| b"{}".to_vec()));
        bytes.push(b'\n');
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(&bytes)?;
    Ok(())
}

pub(crate) fn atomic_write_json_file(path: &FsPath, value: &Value) -> std::io::Result<()> {
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    atomic_write_text_file(path, &content)
}

pub(crate) fn atomic_write_text_file(path: &FsPath, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content)?;
    fs::rename(&tmp, path)
}

pub(crate) fn read_optional_text_file(path: &FsPath) -> Option<String> {
    fs::read_to_string(path).ok()
}

pub(crate) fn read_jsonl_file(path: &FsPath) -> Vec<Value> {
    let _read_guard = jsonl_file_lock(path)
        .lock()
        .expect("archive jsonl read lock");
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    parse_jsonl_records(&content, path)
}

fn jsonl_file_lock(path: &FsPath) -> &'static std::sync::Mutex<()> {
    use std::hash::{Hash, Hasher};

    const SHARD_COUNT: usize = 64;
    static SHARDS: std::sync::OnceLock<Vec<std::sync::Mutex<()>>> = std::sync::OnceLock::new();
    let shards = SHARDS.get_or_init(|| {
        (0..SHARD_COUNT)
            .map(|_| std::sync::Mutex::new(()))
            .collect()
    });
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    &shards[(hasher.finish() as usize) % SHARD_COUNT]
}

pub(crate) fn parse_jsonl_records(content: &str, path: &FsPath) -> Vec<Value> {
    let mut records = Vec::new();
    for (line_index, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let mut stream = serde_json::Deserializer::from_str(line).into_iter::<Value>();
        while let Some(record) = stream.next() {
            match record {
                Ok(record) => records.push(record),
                Err(error) => {
                    eprintln!(
                        "invalid JSONL record in {} at line {}: {}",
                        path.display(),
                        line_index + 1,
                        error
                    );
                    break;
                }
            }
        }
    }
    records
}

pub(crate) fn archive_file_entries(archive_dir: &FsPath) -> Vec<Value> {
    let mut entries = Vec::new();
    collect_archive_file_entries(archive_dir, archive_dir, &mut entries);
    entries.sort_by(|left, right| {
        left.get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(
                right
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
    });
    entries
}

fn collect_archive_file_entries(root: &FsPath, current: &FsPath, entries: &mut Vec<Value>) {
    let Ok(children) = fs::read_dir(current) else {
        return;
    };
    for child in children.filter_map(Result::ok) {
        let path = child.path();
        if path.is_dir() {
            collect_archive_file_entries(root, &path, entries);
            continue;
        }
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if !is_public_conversation_archive_file(&relative) {
            continue;
        }
        entries.push(json!({
            "path": relative,
            "sizeBytes": metadata.len()
        }));
    }
}

pub(crate) fn is_public_conversation_archive_file(relative: &str) -> bool {
    matches!(
        relative.replace('\\', "/").as_str(),
        "exports/complete.md" | "exports/chronological.md"
    )
}

pub(crate) fn conversation_complete_markdown(
    session_id: &str,
    run_id: &str,
    projection: &[Value],
    transcript: &[Value],
) -> String {
    let mut lines = vec![
        format!("# DeepCode Conversation Archive"),
        String::new(),
        format!("- Session: `{session_id}`"),
        format!("- Run: `{run_id}`"),
        format!("- Generated: `{}`", now_text()),
        String::new(),
        "## Projection".to_string(),
    ];
    let visible_projection = projection
        .iter()
        .filter(|event| !is_private_analysis_projection_entry(event))
        .collect::<Vec<_>>();
    if visible_projection.is_empty() {
        lines.push("- 无 projection events。".to_string());
    } else {
        for event in visible_projection {
            lines.push(projection_event_markdown(event));
        }
    }
    let visible_transcript = transcript
        .iter()
        .filter(|entry| !is_private_analysis_transcript_entry(entry))
        .collect::<Vec<_>>();
    if !visible_transcript.is_empty() {
        lines.push(String::new());
        lines.push("## Transcript".to_string());
        for entry in visible_transcript {
            lines.push(transcript_entry_markdown(entry));
        }
    }
    lines.join("\n")
}

pub(crate) fn conversation_chronological_markdown(session_id: &str, entries: &[Value]) -> String {
    let mut lines = vec![
        "# DeepCode Chronological Conversation".to_string(),
        String::new(),
        format!("- Session: `{session_id}`"),
        format!("- Archive generated: `{}`", now_text()),
        String::new(),
    ];
    if entries.is_empty() {
        lines.push("- No archived conversation entries.".to_string());
        return lines.join("\n");
    }
    for item in entries {
        let source = item
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("entry");
        let run_id = item.get("runId").and_then(Value::as_str).unwrap_or("run");
        let timestamp = item
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let entry = item.get("entry").unwrap_or(&Value::Null);
        if (source == "projection" && is_private_analysis_projection_entry(entry))
            || (source == "transcript" && is_private_analysis_transcript_entry(entry))
        {
            continue;
        }
        let heading = if source == "projection" {
            format!(
                "Projection / {} / {}",
                archive_projection_entry_title(entry),
                run_id
            )
        } else {
            let role = entry.get("role").and_then(Value::as_str).unwrap_or("entry");
            let channel = entry
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Transcript / {role} / {channel} / {run_id}")
        };
        let suffix = if timestamp.is_empty() {
            String::new()
        } else {
            format!(" · {timestamp}")
        };
        lines.push(format!("## {heading}{suffix}"));
        lines.push(String::new());
        lines.push(archive_record_text(entry));
        lines.push(String::new());
    }
    lines.join("\n").trim_end().to_string()
}

fn is_private_analysis_projection_entry(entry: &Value) -> bool {
    let payload = entry.get("payload").unwrap_or(&Value::Null);
    let kind = entry
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let channel = payload
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let visibility = payload
        .get("visibility")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let presentation = payload
        .get("presentation")
        .and_then(Value::as_str)
        .or_else(|| {
            entry
                .get("display")
                .and_then(|display| display.get("presentation"))
                .and_then(Value::as_str)
        })
        .unwrap_or_default();
    kind == "trace"
        || kind.starts_with("trace/")
        || matches!(channel, "reasoning" | "thinking" | "trace")
        || matches!(visibility, "hidden" | "debug" | "trace")
        || presentation == "traceOnly"
        || payload
            .get("reasoningTrace")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn is_private_analysis_transcript_entry(entry: &Value) -> bool {
    let kind = entry
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let channel = entry
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let visibility = entry
        .get("visibility")
        .and_then(Value::as_str)
        .unwrap_or_default();
    kind == "provider_trace"
        || kind == "trace"
        || kind.starts_with("trace/")
        || matches!(channel, "reasoning" | "thinking" | "trace")
        || matches!(visibility, "hidden" | "debug" | "trace")
}

pub(crate) fn conversation_context_assemblies_markdown(
    session_id: &str,
    run_id: &str,
    entries: &[Value],
) -> String {
    let mut lines = vec![
        "# DeepCode Context Assemblies".to_string(),
        String::new(),
        format!("- Session: `{session_id}`"),
        format!("- Run: `{run_id}`"),
        format!("- Export generated: `{}`", now_text()),
        String::new(),
        "This export is for prompt assembly and cache-hit analysis. Cache telemetry never decides ProposalReview, PermissionGate, execution, ReviewGate, or accepted state.".to_string(),
        String::new(),
    ];
    if entries.is_empty() {
        lines.push("- No context assembly records.".to_string());
        return lines.join("\n");
    }
    for (index, entry) in entries.iter().enumerate() {
        let empty_assembly = Value::Null;
        let stage = entry
            .get("payload")
            .and_then(|payload| payload.get("stage"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let assembly = entry
            .get("payload")
            .and_then(|payload| payload.get("payload"))
            .and_then(|payload| payload.get("contextAssembly"))
            .unwrap_or(&empty_assembly);
        let assembly_id = assembly
            .get("contextAssemblyId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        lines.push(format!("## {}. `{}` · `{}`", index + 1, stage, assembly_id));
        lines.push(String::new());
        lines.push(format!(
            "- stablePrefixHash: `{}`",
            assembly
                .get("stablePrefixHash")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ));
        lines.push(format!(
            "- dynamicSuffixHash: `{}`",
            assembly
                .get("dynamicSuffixHash")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ));
        lines.push(format!(
            "- cacheHash: `{}`",
            assembly
                .get("cacheHash")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ));
        lines.push(String::new());
        if let Some(segments) = assembly.get("segments").and_then(Value::as_array) {
            lines.push("| Segment | Cache class | Prefix | Audit | Hash | Chars |".to_string());
            lines.push("| --- | --- | --- | --- | --- | ---: |".to_string());
            for segment in segments {
                let name = segment
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("segment");
                let cache_class = segment
                    .get("cacheClass")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let prefix = segment
                    .get("stablePrefix")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let audit = segment
                    .get("auditOnly")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let hash = segment
                    .get("contentHash")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let chars = segment
                    .get("charLength")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                lines.push(format!(
                    "| `{name}` | `{cache_class}` | `{prefix}` | `{audit}` | `{hash}` | {chars} |"
                ));
            }
        } else {
            lines.push("```json".to_string());
            lines.push(
                serde_json::to_string_pretty(&redact_archive_value(assembly.clone()))
                    .unwrap_or_else(|_| "{}".to_string()),
            );
            lines.push("```".to_string());
        }
        lines.push(String::new());
        lines.push(format!(
            "- resourceFullTextCharCount: `{}`",
            assembly
                .get("resourceFullTextCharCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        ));
        lines.push(format!(
            "- resourceSummaryCharCount: `{}`",
            assembly
                .get("resourceSummaryCharCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        ));
        if let Some(blocks) = assembly.get("resourceBlocks").and_then(Value::as_array) {
            lines.push(String::new());
            lines.push(
                "| Resource block | Retention | Status | Hash | Chars | Volatile stripped |"
                    .to_string(),
            );
            lines.push("| --- | --- | --- | --- | ---: | --- |".to_string());
            for block in blocks {
                let block_key = block
                    .get("blockKey")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let display_ref = block
                    .get("displayRef")
                    .and_then(Value::as_str)
                    .unwrap_or("resource");
                let retention = block
                    .get("retention")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let status = block
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let content_hash = block
                    .get("contentHash")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let chars = block.get("charLength").and_then(Value::as_u64).unwrap_or(0);
                let stripped = block
                    .get("volatileFieldStripped")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                lines.push(format!(
                    "| `{display_ref}`<br>`{block_key}` | `{retention}` | `{status}` | `{content_hash}` | {chars} | `{stripped}` |"
                ));
            }
        }
        lines.push(String::new());
    }
    lines.join("\n").trim_end().to_string()
}

pub(crate) fn conversation_projection_delivery_markdown(
    session_id: &str,
    run_id: &str,
    entries: &[Value],
) -> String {
    let mut sorted = entries.iter().collect::<Vec<_>>();
    sorted.sort_by_key(|entry| {
        entry
            .get("at")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<u128>().ok())
            .unwrap_or_default()
    });
    let mut lines = vec![
        "# Projection Delivery Timing".to_string(),
        String::new(),
        format!("- Session: `{session_id}`"),
        format!("- Run: `{run_id}`"),
        format!("- Export generated: `{}`", now_text()),
        String::new(),
        "This diagnostic stream records delivery metadata and hashes only. It is not a conversation fact source.".to_string(),
        String::new(),
        "| at | stage | op | turn | item | block | deltaSeq | revision | mode | chars | hash | failure | result |".to_string(),
        "| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | --- | --- | --- |".to_string(),
    ];
    for entry in sorted {
        let text = |field: &str| {
            entry
                .get(field)
                .and_then(Value::as_str)
                .unwrap_or("")
                .replace('|', "\\|")
        };
        let number = |field: &str| {
            entry
                .get(field)
                .and_then(Value::as_u64)
                .map(|value| value.to_string())
                .unwrap_or_default()
        };
        lines.push(format!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            text("at"),
            text("stage"),
            text("op"),
            text("turnId"),
            text("itemId"),
            text("blockId"),
            number("deltaSeq"),
            number("revision"),
            text("deliveryMode"),
            number("charLength"),
            text("contentHash"),
            text("failureCode"),
            text("result"),
        ));
    }
    if entries.is_empty() {
        lines.push("| | No projection delivery records. | | | | | | | | | | | |".to_string());
    }
    lines.join("\n")
}

fn archive_projection_entry_title(entry: &Value) -> &'static str {
    let payload = entry.get("payload").unwrap_or(&Value::Null);
    if payload.get("traceKind").and_then(Value::as_str).is_some()
        || payload.get("visibility").and_then(Value::as_str) == Some("trace")
    {
        return "Trace";
    }
    let kind = entry.get("kind").and_then(Value::as_str).unwrap_or("event");
    if kind == "assistant_msg"
        && matches!(
            payload.get("channel").and_then(Value::as_str),
            Some("reasoning" | "thinking" | "trace")
        )
    {
        return "Thinking";
    }
    archive_projection_title(kind)
}

fn archive_projection_title(kind: &str) -> &'static str {
    match kind {
        "user_msg" => "User",
        "assistant_msg" => "Agent",
        "workflow_stage" => "Workflow Stage",
        "workflow_decision" => "Workflow Decision",
        "plan_card" => "Plan",
        "plan_review" => "Plan Review",
        "resource_request" => "Resource Request",
        "tool_call" => "Tool Call",
        "tool_result" => "Tool Result",
        "permission_request" => "Permission Request",
        "permission_result" => "Permission Result",
        "error" => "Error",
        "trace" => "Trace",
        _ => "Event",
    }
}

fn archive_record_text(entry: &Value) -> String {
    entry
        .get("payload")
        .and_then(|payload| payload.get("content"))
        .and_then(Value::as_str)
        .or_else(|| entry.get("content").and_then(Value::as_str))
        .or_else(|| {
            entry
                .get("payload")
                .and_then(|payload| payload.get("summary"))
                .and_then(Value::as_str)
        })
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            format!(
                "```json\n{}\n```",
                serde_json::to_string_pretty(&redact_archive_value(entry.clone()))
                    .unwrap_or_else(|_| "{}".to_string())
            )
        })
}

fn projection_event_markdown(event: &Value) -> String {
    let kind = event.get("kind").and_then(Value::as_str).unwrap_or("event");
    let title = match kind {
        "user_msg" => "用户",
        "assistant_msg" => "Agent",
        "tool_call" => "工具调用",
        "tool_result" => "工具结果",
        "permission_request" => "权限请求",
        "permission_result" => "权限结果",
        "trace" => "推理摘要",
        _ => kind,
    };
    let content = event
        .get("payload")
        .and_then(|payload| payload.get("content"))
        .and_then(Value::as_str)
        .or_else(|| {
            event
                .get("payload")
                .and_then(|payload| payload.get("summary"))
                .and_then(Value::as_str)
        })
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            serde_json::to_string_pretty(&redact_archive_value(event.clone()))
                .unwrap_or_else(|_| "{}".to_string())
        });
    format!("\n### {title}\n\n{content}\n")
}

fn transcript_entry_markdown(entry: &Value) -> String {
    let role = entry.get("role").and_then(Value::as_str).unwrap_or("entry");
    let channel = entry
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let content = entry
        .get("content")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            serde_json::to_string_pretty(&redact_archive_value(entry.clone()))
                .unwrap_or_else(|_| "{}".to_string())
        });
    format!("\n### {role} / {channel}\n\n{content}\n")
}

pub(crate) fn redact_archive_value(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut redacted = serde_json::Map::new();
            for (key, value) in object {
                if is_sensitive_archive_key(&key) {
                    redacted.insert(key, Value::String("[redacted]".to_string()));
                } else {
                    redacted.insert(key, redact_archive_value(value));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(redact_archive_value).collect()),
        Value::String(value) => Value::String(redact_sensitive_archive_text(&value)),
        other => other,
    }
}

pub(crate) fn is_hidden_reasoning_wire_record(value: &Value) -> bool {
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    matches!(kind, "reasoning" | "reasoningDelta" | "hiddenReasoning")
        || is_hidden_reasoning_persistence_record(value)
}

pub(crate) fn is_hidden_reasoning_persistence_record(value: &Value) -> bool {
    let payload = value.get("payload").unwrap_or(&Value::Null);
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .map(normalized_archive_key)
        .unwrap_or_default();
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| payload.get("type").and_then(Value::as_str))
        .map(normalized_archive_key)
        .unwrap_or_default();
    let channel = value
        .get("channel")
        .and_then(Value::as_str)
        .or_else(|| payload.get("channel").and_then(Value::as_str))
        .map(normalized_archive_key)
        .unwrap_or_default();
    matches!(
        kind.as_str(),
        "reasoning" | "reasoningdelta" | "providerreasoningdelta" | "hiddenreasoning"
    ) || matches!(
        event_type.as_str(),
        "reasoning" | "reasoningdelta" | "providerreasoningdelta" | "hiddenreasoning"
    ) || matches!(channel.as_str(), "reasoning" | "thinking")
        || value
            .get("reasoningTrace")
            .or_else(|| payload.get("reasoningTrace"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

pub(crate) fn strip_hidden_reasoning_fields(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .filter(|(key, _)| {
                    let normalized = normalized_archive_key(key);
                    !matches!(
                        normalized.as_str(),
                        "reasoning" | "reasoningcontent" | "hiddenreasoning"
                    )
                })
                .map(|(key, value)| (key, strip_hidden_reasoning_fields(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(strip_hidden_reasoning_fields)
                .collect(),
        ),
        other => other,
    }
}

fn redact_sensitive_archive_text(value: &str) -> String {
    value
        .lines()
        .map(|line| {
            let normalized = line.trim().to_ascii_lowercase();
            if normalized.starts_with("authorization:")
                || normalized.contains("bearer ")
                || normalized.starts_with("api_key=")
                || normalized.starts_with("token=")
            {
                "[redacted]".to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_sensitive_archive_key(key: &str) -> bool {
    let normalized = normalized_archive_key(key);
    if normalized.ends_with("tokens")
        || normalized.ends_with("tokencount")
        || normalized.ends_with("tokenbudget")
    {
        return false;
    }
    [
        "secret",
        "apikey",
        "authorization",
        "password",
        "bearer",
        "credential",
        "cookie",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
        || matches!(
            normalized.as_str(),
            "token"
                | "apitoken"
                | "accesstoken"
                | "refreshtoken"
                | "idtoken"
                | "authtoken"
                | "bearertoken"
                | "sessiontoken"
                | "privatetoken"
        )
}

fn normalized_archive_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
