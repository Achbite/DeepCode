use super::compiler::action_bundle_value;
use super::*;

pub(super) fn summarize_action_batch(batch: &Value) -> Value {
    let action_bundle = action_bundle_value(batch);
    let actions = action_bundle
        .and_then(|bundle| bundle.get("actions"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let content_blocks = batch
        .get("contentBlocks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    serde_json::json!({
        "planId": batch.get("planId").and_then(Value::as_str),
        "actionBundleId": action_bundle.and_then(|bundle| bundle.get("id")).and_then(Value::as_str),
        "goal": action_bundle.and_then(|bundle| bundle.get("goal")).and_then(Value::as_str),
        "actionCount": actions.len(),
        "actions": actions.iter().map(summarize_action).collect::<Vec<_>>(),
        "contentBlocks": content_blocks.iter().map(summarize_content_block).collect::<Vec<_>>()
    })
}

pub(super) fn summarize_action(action: &Value) -> Value {
    serde_json::json!({
        "actionId": action.get("actionId").and_then(Value::as_str),
        "toolId": action.get("toolId").and_then(Value::as_str),
        "description": action.get("description").and_then(Value::as_str),
        "args": action.get("args").cloned().unwrap_or(Value::Null),
        "dependsOn": action.get("dependsOn").cloned().unwrap_or_else(|| serde_json::json!([]))
    })
}

pub(super) fn summarize_content_block(block: &Value) -> Value {
    let content = block
        .get("contentLines")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join("\n");
    serde_json::json!({
        "blockId": block.get("blockId").and_then(Value::as_str),
        "targetPath": block.get("targetPath").and_then(Value::as_str),
        "language": block.get("language").and_then(Value::as_str),
        "operation": block.get("operation").and_then(Value::as_str),
        "contentBytes": content.len(),
        "contentHash": deepcode_kernel_tools::hash_bytes(content.as_bytes())
    })
}

pub(crate) fn safe_work_unit_segment(value: &str) -> String {
    let mut out = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').chars().take(80).collect::<String>()
}
