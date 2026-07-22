use crate::prelude::*;
use crate::*;

pub(crate) fn append_jsonl_file(path: &FsPath, entries: &[Value]) -> std::io::Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    for entry in entries {
        let line = serde_json::to_string(entry).unwrap_or_else(|_| "{}".to_string());
        writeln!(file, "{line}")?;
    }
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
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
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
        entries.push(json!({
            "path": relative,
            "sizeBytes": metadata.len()
        }));
    }
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
    if projection.is_empty() {
        lines.push("- 无 projection events。".to_string());
    } else {
        for event in projection {
            lines.push(projection_event_markdown(event));
        }
    }
    if !transcript.is_empty() {
        lines.push(String::new());
        lines.push("## Transcript".to_string());
        for entry in transcript {
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
