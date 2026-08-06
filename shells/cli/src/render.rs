use crate::*;

pub(crate) fn render_timeline(timeline: &AgentTimelineSnapshot) -> Result<(), String> {
    for turn in &timeline.turns {
        println!("turn: {}", timeline_status_label(turn.status));
        let blocks = turn
            .blocks
            .iter()
            .map(|block| (block.id.as_str(), block))
            .collect::<std::collections::HashMap<_, _>>();
        let segments = turn
            .work_segments
            .iter()
            .map(|segment| (segment.id.as_str(), segment))
            .collect::<std::collections::HashMap<_, _>>();
        for part in &turn.parts {
            match part {
                AgentTimelineTurnPart::Block { block_id } => {
                    let block = blocks.get(block_id.as_str()).ok_or_else(|| {
                        format!("typed Shared Projection references missing block {block_id}")
                    })?;
                    render_timeline_block(block)?;
                }
                AgentTimelineTurnPart::WorkSegment { work_segment_id } => {
                    let segment = segments.get(work_segment_id.as_str()).ok_or_else(|| {
                        format!(
                            "typed Shared Projection references missing work segment {work_segment_id}"
                        )
                    })?;
                    render_timeline_work_segment(segment);
                }
            }
        }
    }
    Ok(())
}

fn render_timeline_block(block: &deepcode_kernel_client::AgentTimelineBlock) -> Result<(), String> {
    if block.entry_role == AgentTimelineEntryRole::FinalAnswer
        && block.durability != AgentTimelineDurability::Committed
    {
        return Ok(());
    }
    let kind = timeline_block_kind_label(block);
    let title = (!block.title.trim().is_empty())
        .then_some(block.title.as_str())
        .unwrap_or(kind);
    let body = timeline_block_text(block)?;
    println!("  {kind}: {title}");
    for line in body.lines().take(24) {
        println!("    {line}");
    }
    Ok(())
}

fn timeline_block_text(
    block: &deepcode_kernel_client::AgentTimelineBlock,
) -> Result<String, String> {
    if matches!(
        block.kind,
        deepcode_kernel_client::AgentTimelineBlockKind::Plan
            | deepcode_kernel_client::AgentTimelineBlockKind::Review
    ) {
        if let Some(readable) = block.structured_projection.as_ref() {
            let text = render_readable_projection(readable);
            if !text.trim().is_empty() {
                return Ok(text);
            }
        }
    }
    Ok(block
        .body_markdown
        .as_deref()
        .or_else(|| {
            block
                .localized_content
                .as_ref()
                .and_then(|content| content.text.as_deref())
        })
        .unwrap_or(block.summary.as_str())
        .to_string())
}

fn render_timeline_work_segment(segment: &deepcode_kernel_client::AgentTimelineWorkSegment) {
    println!(
        "  work: {} ({} operation{})",
        work_segment_lifecycle_label(segment.lifecycle),
        segment.operations.len(),
        if segment.operations.len() == 1 {
            ""
        } else {
            "s"
        }
    );
    if let Some(attention) = segment.attention.0.as_ref() {
        println!(
            "    attention [{}]: {}",
            work_attention_status_label(attention.status),
            attention.summary
        );
    }
    for operation in &segment.operations {
        let name = operation
            .display_name
            .as_deref()
            .unwrap_or(operation.tool_id.as_str());
        println!(
            "    {name}: {}",
            work_operation_status_label(operation.status)
        );
        if let Some(retry) = &operation.retry {
            println!(
                "      retry: #{} after {}",
                retry.retry_ordinal, retry.predecessor_operation_id
            );
        }
        if let Some(action) = operation
            .canonical_action
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            println!("      action: {action}");
        }
        if let Some(targets) = operation
            .targets
            .as_ref()
            .filter(|targets| !targets.is_empty())
        {
            println!("      targets: {}", targets.join(", "));
        }
        if let Some(effect) = operation
            .effect_summary
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            println!("      effect: {effect}");
        }
    }
}

fn timeline_status_label(status: AgentTimelineStatus) -> &'static str {
    use AgentTimelineStatus::*;
    match status {
        Queued => "queued",
        Running => "running",
        Waiting => "waiting",
        Blocked => "blocked",
        Completed => "completed",
        Cancelled => "cancelled",
        Failed => "failed",
    }
}

fn timeline_block_kind_label(block: &deepcode_kernel_client::AgentTimelineBlock) -> &'static str {
    use deepcode_kernel_client::AgentTimelineBlockKind::*;
    match block.kind {
        User => "user",
        Assistant => "assistant",
        Permission => "permission",
        Plan => "plan",
        Review => "review",
        Error => "error",
    }
}

fn work_segment_lifecycle_label(
    lifecycle: deepcode_kernel_client::AgentTimelineWorkSegmentLifecycle,
) -> &'static str {
    use deepcode_kernel_client::AgentTimelineWorkSegmentLifecycle::*;
    match lifecycle {
        Active => "active",
        Completed => "completed",
        Cancelled => "cancelled",
        Failed => "failed",
    }
}

fn work_attention_status_label(
    status: deepcode_kernel_client::AgentTimelineWorkAttentionStatus,
) -> &'static str {
    use deepcode_kernel_client::AgentTimelineWorkAttentionStatus::*;
    match status {
        Unresolved => "unresolved",
        Resolved => "resolved",
    }
}

fn work_operation_status_label(
    status: deepcode_kernel_client::AgentTimelineWorkOperationStatus,
) -> &'static str {
    use deepcode_kernel_client::AgentTimelineWorkOperationStatus::*;
    match status {
        Preparing => "preparing",
        Queued => "queued",
        Running => "running",
        AwaitingCapability => "awaiting capability",
        Completed => "completed",
        Denied => "denied",
        Failed => "failed",
        FailedAfterObservedEffect => "failed after observed effect",
        Indeterminate => "indeterminate",
        Cancelled => "cancelled",
        Stale => "stale",
        Unexecuted => "unexecuted",
    }
}

fn render_readable_projection(
    readable: &deepcode_kernel_client::AgentTimelineStructuredProjection,
) -> String {
    let mut lines = Vec::new();
    let summary_is_structured = readable
        .sections
        .iter()
        .any(readable_section_has_summary_items);
    if !summary_is_structured {
        if let Some(summary) = readable.summary.as_deref() {
            lines.push(summary.to_string());
        } else if let Some(summary_key) = readable.summary_key.as_deref() {
            lines.push(
                readable_summary_text(summary_key, readable)
                    .unwrap_or_else(|| summary_key.to_string()),
            );
        }
    }
    for section in &readable.sections {
        lines.push(format!("## {}", readable_section_title(section)));
        let mut seen_section_lines: Vec<String> = Vec::new();
        if section.items.is_empty() {
            if let Some(empty) = section.empty_message_key.as_deref() {
                if let Some(message) = readable_empty_message(empty) {
                    lines.push(format!("- {message}"));
                }
            }
        }
        for item in &section.items {
            let item_text = readable_item_text(item);
            if let Some(text) = &item_text {
                push_unique_render_line(&mut lines, &mut seen_section_lines, format!("- {text}"));
            }
            if let Some(targets) = item.target_refs.as_ref() {
                let target_text = targets.join(", ");
                let target_is_already_visible = item_text
                    .as_ref()
                    .map(|text| text.contains(&target_text))
                    .unwrap_or(false);
                if !target_text.is_empty() && !target_is_already_visible {
                    push_unique_render_line(
                        &mut lines,
                        &mut seen_section_lines,
                        format!("  - targets: {target_text}"),
                    );
                }
            }
        }
    }
    lines.join("\n")
}

fn push_unique_render_line(lines: &mut Vec<String>, seen: &mut Vec<String>, line: String) {
    let normalized = normalize_render_text(&line);
    if seen.iter().any(|item| item == &normalized) {
        return;
    }
    seen.push(normalized);
    lines.push(line);
}

fn readable_section_has_summary_items(
    section: &deepcode_kernel_client::AgentTimelineStructuredProjectionSection,
) -> bool {
    let section_key = structured_section_key(section);
    if !matches!(
        section_key,
        "summary" | "session.projection.plan.section.summary"
    ) {
        return false;
    }
    section
        .items
        .iter()
        .any(|item| readable_item_text(item).is_some())
}

fn readable_summary_key_text(key: &str) -> Option<&'static str> {
    match key {
        "review.summary.waitingUserReview" => {
            Some("The current batch has executed. Review the tool facts and validation results.")
        }
        "review.summary.needsAttention" => {
            Some("The current batch has failed or blocked items. Review the facts before deciding whether to revise.")
        }
        _ => None,
    }
}

fn readable_summary_text(
    key: &str,
    readable: &deepcode_kernel_client::AgentTimelineStructuredProjection,
) -> Option<String> {
    if key == "session.projection.review.summary.counts" {
        let arg = |name: &str| {
            readable
                .message_args
                .as_ref()
                .and_then(|args| args.get(name))
                .cloned()
                .unwrap_or_else(|| "0".to_string())
        };
        return Some(format!(
            "{} planned; {} effects; {} unexecuted; {} rejected; {} cleanup; {} indeterminate.",
            arg("planned"),
            arg("effects"),
            arg("unexecuted"),
            arg("rejected"),
            arg("cleanup"),
            arg("indeterminate")
        ));
    }
    readable_summary_key_text(key).map(str::to_string)
}

fn readable_item_text(
    item: &deepcode_kernel_client::AgentTimelineStructuredProjectionItem,
) -> Option<String> {
    if let Some(text) = item.text.as_deref() {
        if !text.trim().is_empty() {
            return Some(text.to_string());
        }
    }
    item.message_key
        .as_deref()
        .and_then(|key| readable_message_text(key, item))
}

fn readable_message_text(
    key: &str,
    item: &deepcode_kernel_client::AgentTimelineStructuredProjectionItem,
) -> Option<String> {
    let arg = |name: &str| readable_message_arg(item, name).unwrap_or_default();
    match key {
        "session.projection.plan.boundary.notExecution" => {
            Some("This is a plan, not an execution result.".to_string())
        }
        "review.summary.waitingUserReview" => Some(
            "The current batch has executed. Review the tool facts and validation results."
                .to_string(),
        ),
        "review.summary.needsAttention" => Some(
            "The current batch has failed or blocked items. Review the facts before deciding whether to revise."
                .to_string(),
        ),
        "review.changedFile" => Some(format!(
            "{} operation={} status={}",
            arg("path"),
            arg("operation"),
            arg("status")
        )),
        "session.projection.review.changedFileWithReason" => Some(format!(
            "{} operation={} status={} reason={}",
            arg("path"),
            arg("operation"),
            arg("status"),
            arg("reason")
        )),
        "session.projection.review.count.toolFacts" => {
            Some(format!("Tool facts: {}", arg("count")))
        }
        "session.projection.review.generatedArtifact" => Some(format!(
            "{} operation={} contentHash={}",
            arg("path"),
            arg("operation"),
            arg("hash")
        )),
        "session.projection.review.generatedArtifacts.truncated" => Some(format!(
            "{} additional generated artifact(s) are not expanded.",
            arg("count")
        )),
        "session.projection.review.pathDiagnostic" => Some(format!(
            "{} original={} normalized={} stripped={} duplicateRootPathDetected={}",
            arg("path"),
            arg("original"),
            arg("normalized"),
            arg("stripped"),
            arg("duplicate")
        )),
        "session.projection.review.pathDiagnostics.truncated" => Some(format!(
            "{} additional path diagnostic(s) are not expanded.",
            arg("count")
        )),
        "session.projection.review.git.unavailable" => {
            Some(format!("Git diff unavailable: {}", arg("reason")))
        }
        "session.projection.review.git.stats" => Some(format!(
            "Files: {}; staged diff: {} bytes; unstaged diff: {} bytes.",
            arg("changedFiles"),
            arg("stagedBytes"),
            arg("unstagedBytes")
        )),
        "session.projection.review.git.truncated" => Some(format!(
            "{} additional Git file(s) are not expanded.",
            arg("count")
        )),
        "session.projection.review.git.diffAttached" => {
            Some("Full diff is attached as collapsible Review evidence.".to_string())
        }
        "session.projection.review.audit.available" => Some(
            "Raw Kernel facts, tool facts, and ReviewFacts are retained in developerDetails / audit refs."
                .to_string(),
        ),
        "session.projection.review.audit.unavailable" => {
            Some("No developerDetails are available.".to_string())
        }
        "session.projection.review.audit.ref" => Some(format!("auditRef: {}", arg("ref"))),
        "session.projection.review.next.failed" => Some(
            "Accept closes the current batch without retrying failed items; submit Review feedback to revise."
                .to_string(),
        ),
        "session.projection.review.next.success" => Some(
            "Accept closes the current batch; typed text is treated as Review revision feedback."
                .to_string(),
        ),
        "session.projection.review.next.continuation" => Some(format!(
            "The current plan recorded {} continuation intent(s).",
            arg("count")
        )),
        "session.projection.review.next.noContinuation" => {
            Some("The current plan did not record continuation batches.".to_string())
        }
        "session.projection.review.item.scopeExpansion" => {
            Some(format!("{}: scope expansion recorded", arg("tool")))
        }
        "session.projection.review.item.actualEffect" => {
            Some(format!("{}: {}", arg("tool"), arg("fact")))
        }
        "session.projection.review.item.unexecuted" => {
            Some(format!("{}: not executed", arg("tool")))
        }
        "session.projection.review.item.denied" => {
            Some(format!("{}: denied by user ({})", arg("tool"), arg("detail")))
        }
        "session.projection.review.item.rejection" => {
            Some(format!("{}: rejected by Kernel ({})", arg("tool"), arg("detail")))
        }
        "session.projection.review.item.cleanup" => {
            Some(format!("Cleanup: {}", arg("fact")))
        }
        "session.projection.review.item.indeterminate" => {
            Some(format!("Indeterminate outcome: {}", arg("detail")))
        }
        _ => None,
    }
}

fn readable_message_arg(
    item: &deepcode_kernel_client::AgentTimelineStructuredProjectionItem,
    name: &str,
) -> Option<String> {
    item.message_args.as_ref()?.get(name).cloned()
}

fn readable_section_title(
    section: &deepcode_kernel_client::AgentTimelineStructuredProjectionSection,
) -> String {
    let key = structured_section_key(section);
    match key {
        "summary" | "session.projection.plan.section.summary" => "Summary",
        "tasks" | "session.projection.plan.section.tasks" => "Tasks",
        "risks" | "session.projection.plan.section.risks" => "Risks",
        "reviewCheckpoints" | "session.projection.plan.section.reviewCheckpoints" => {
            "Review checkpoints"
        }
        "boundary" | "session.projection.plan.section.boundary" => "Boundary",
        "executionResult" | "session.projection.review.section.executionResult" => {
            "Execution result"
        }
        "execution" | "session.projection.review.section.execution" => "Execution",
        "changedFiles" | "session.projection.review.section.changedFiles" => {
            "Files changed in this batch"
        }
        "generatedArtifacts" | "session.projection.review.section.generatedArtifacts" => {
            "Agent generated artifacts"
        }
        "pathDiagnostics" | "session.projection.review.section.pathDiagnostics" => {
            "Path normalization diagnostics"
        }
        "gitChanges" | "session.projection.review.section.gitChanges" => "Git changes",
        "auditDetails" | "session.projection.review.section.auditDetails" => "Audit details",
        "originalPlan" | "session.projection.review.section.originalPlan" => {
            "Original plan summary"
        }
        "validation" | "session.projection.review.section.validation" => {
            "Validation and startup suggestions"
        }
        "nextDecision" | "session.projection.review.section.nextDecision" => "Next decision",
        "audit" | "session.projection.review.section.audit" => "Audit",
        "scopeExpansions" | "session.projection.review.section.scopeExpansions" => {
            "Scope expansions"
        }
        "actualEffects" | "session.projection.review.section.actualEffects" => "Actual effects",
        "unexecuted" | "session.projection.review.section.unexecuted" => "Unexecuted",
        "denied" | "session.projection.review.section.denied" => "Denied",
        "rejections" | "session.projection.review.section.rejections" => "Rejections",
        "cleanup" | "session.projection.review.section.cleanup" => "Cleanup",
        "indeterminate" | "session.projection.review.section.indeterminate" => "Indeterminate",
        _ => key,
    }
    .to_string()
}

fn structured_section_key(
    section: &deepcode_kernel_client::AgentTimelineStructuredProjectionSection,
) -> &str {
    if section.section_id.is_empty() {
        section.title_key.as_str()
    } else {
        section.section_id.as_str()
    }
}

fn readable_empty_message(key: &str) -> Option<&'static str> {
    match key {
        "session.projection.plan.empty.tasks" => Some("No tasks recorded."),
        "session.projection.plan.empty.risks" => Some("No risks recorded."),
        "session.projection.plan.empty.reviewCheckpoints" => {
            Some("No review checkpoints recorded.")
        }
        "session.projection.review.empty.changedFiles" => Some("No changed files recorded."),
        "session.projection.review.empty.generatedArtifacts" => {
            Some("ReviewFacts did not record generated artifacts.")
        }
        "session.projection.review.empty.pathDiagnostics" => {
            Some("No path normalization diagnostics were recorded.")
        }
        "session.projection.review.empty.gitChanges" => Some("No Git change facts are available."),
        "session.projection.review.empty.auditDetails" => Some("No audit details are available."),
        "session.projection.review.empty.validation" => {
            Some("No validation guidance was recorded.")
        }
        _ => None,
    }
}

pub(crate) fn find_pending_session_decision(
    timeline: &AgentTimelineSnapshot,
    requested_kind: &str,
    run_filter: Option<&str>,
) -> Option<PendingSessionDecision> {
    if !matches!(requested_kind, "plan" | "permission") {
        return None;
    }
    let pending = timeline.interaction_projection.as_ref()?.pending.as_ref()?;
    let (run_id, target_id) = match (requested_kind, pending) {
        ("plan", deepcode_kernel_client::AgentTimelinePendingInteraction::Plan(pending)) => {
            (pending.run_id.clone(), pending.target_id.clone())
        }
        (
            "permission",
            deepcode_kernel_client::AgentTimelinePendingInteraction::Permission(pending),
        ) => {
            let request_id = pending.request.id.trim();
            let pending_request_id = pending.request_id.trim();
            let target_id = pending.target_id.trim();
            if request_id.is_empty() || request_id != pending_request_id || request_id != target_id
            {
                return None;
            }
            let run_id = pending
                .request
                .run_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            (run_id.to_string(), pending.target_id.clone())
        }
        _ => return None,
    };
    if run_filter.is_some_and(|expected| expected != run_id) {
        return None;
    }
    if run_id.trim().is_empty() || target_id.trim().is_empty() {
        return None;
    }
    Some(PendingSessionDecision { run_id, target_id })
}

pub(crate) fn extract_committed_final_text_v2(timeline: &AgentTimelineSnapshot) -> Option<String> {
    let projection = timeline.run_projection.as_ref()?;
    if projection.status != AgentTimelineRunStatus::Succeeded {
        return None;
    }
    let turn_id = projection.turn_id.as_deref()?;
    let turn = timeline
        .turns
        .iter()
        .find(|turn| turn.id == turn_id && turn.status == AgentTimelineStatus::Completed)?;
    let blocks_by_id = turn
        .blocks
        .iter()
        .map(|block| (block.id.as_str(), block))
        .collect::<std::collections::HashMap<_, _>>();
    let mut text = String::new();
    for part in &turn.parts {
        let AgentTimelineTurnPart::Block { block_id } = part else {
            continue;
        };
        let block = blocks_by_id.get(block_id.as_str())?;
        if block.entry_role != AgentTimelineEntryRole::FinalAnswer
            || block.durability != AgentTimelineDurability::Committed
        {
            continue;
        }
        let fragment = block
            .body_markdown
            .as_deref()
            .or_else(|| {
                block
                    .localized_content
                    .as_ref()
                    .and_then(|content| content.text.as_deref())
            })
            .unwrap_or(block.summary.as_str());
        text.push_str(fragment);
    }
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn normalize_render_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Supporting development contract only; packaged CLI output remains the
    // user-experience acceptance path.
    #[test]
    fn cli_review_renders_counts_and_hides_raw_audit_ids() {
        let readable: deepcode_kernel_client::AgentTimelineStructuredProjection =
            serde_json::from_value(json!({
                "kind": "review",
                "schemaVersion": "deepcode.shared-conversation.readable-review.v2",
                "summaryKey": "session.projection.review.summary.counts",
                "messageArgs": {
                    "planned": "2",
                    "effects": "1",
                    "unexecuted": "1",
                    "rejected": "0",
                    "cleanup": "0",
                    "indeterminate": "0"
                },
                "sections": [{
                    "sectionId": "actualEffects",
                    "titleKey": "session.projection.review.section.actualEffects",
                    "items": [{
                        "itemId": "fact-review-cli-raw",
                        "kind": "actualEffects",
                        "messageKey": "session.projection.review.item.actualEffect",
                        "messageArgs": {
                            "tool": "fs.write",
                            "fact": "toolCompleted"
                        },
                        "status": "actualEffects",
                        "auditRefs": [
                            "fact-review-cli-raw",
                            "invocation-review-cli-raw",
                            "provider.started:raw-lifecycle",
                            "wait.changed:raw-lifecycle"
                        ]
                    }]
                }]
            }))
            .expect("exact typed readable Review projection");
        let rendered = render_readable_projection(&readable);

        assert!(rendered.contains(
            "2 planned; 1 effects; 1 unexecuted; 0 rejected; 0 cleanup; 0 indeterminate."
        ));
        assert!(rendered.contains("fs.write: toolCompleted"));
        for private in [
            "fact-review-cli-raw",
            "invocation-review-cli-raw",
            "provider.started",
            "wait.changed",
            "auditRef",
        ] {
            assert!(
                !rendered.contains(private),
                "CLI readable Review leaked audit or lifecycle identity {private}: {rendered}"
            );
        }
    }
}

pub(crate) fn session_id(session: &Value) -> Option<&str> {
    session.get("id").and_then(Value::as_str)
}

pub(crate) fn session_title(session: &Value) -> &str {
    session
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Untitled Session")
}

pub(crate) fn print_help() {
    println!(
        r#"DeepCode CLI Host Shell

Usage:
  DeepCode-CLI --help
  DeepCode-CLI daemon status
  DeepCode-CLI sessions list [--include-archived]
  DeepCode-CLI sessions new [title]
  DeepCode-CLI sessions resume <session-id>
  DeepCode-CLI sessions rename <session-id> <title>
  DeepCode-CLI sessions profile <session-id> [profile-id]
  DeepCode-CLI sessions delete <session-id>
  DeepCode-CLI sessions archive <session-id>
  DeepCode-CLI timeline [session-id]
  DeepCode-CLI permission allow <permission-id>
  DeepCode-CLI permission deny <permission-id>
  DeepCode-CLI decision plan <accept|reject|revise> [--session <id>] [run-id] [plan-revision] [guidance]
  DeepCode-CLI decision permission <accept|reject> [--session <id>] [run-id] [target-id]
  DeepCode-CLI ask [-p|--print] [--session <id>] [--workspace <path>|--no-workspace] <prompt>

Options:
  --api <url>                 Kernel daemon HTTP base URL. Defaults to DEEPCODE_API_URL or http://$DEEPCODE_HOST:$DEEPCODE_PORT.
  --no-auto-start-kernel      Do not start a local Kernel when the API is unavailable.
  --workspace, -C             Bind the turn to a workspace path. Defaults to DEEPCODE_WORKSPACE or the current directory.
  --no-workspace              Send an ordinary chat turn without a workspace binding.
  --session <id>              Continue a specific Agent session.

Environment:
  DEEPCODE_KERNEL_AUTO_START=0 disables local Kernel auto-start.
  DEEPCODE_KERNEL_BIN=/path/to/deepcode-kernel overrides Kernel binary lookup.
  DEEPCODE_WORKSPACE=/path/to/project sets the default terminal workspace.
  DEEPCODE_CLI_RUN_TIMEOUT_MS stops CLI polling after the given milliseconds. Defaults to no CLI-side timeout; 0 disables it.

Session Runtime:
  Ordinary input is submitted to daemon /api/agent/sessions/:id/runs.
  CLI only polls run status and renders shared timeline projection.
  Decision run-id/target-id are optional when the current shared timeline has one pending matching decision.
  If the daemon session runtime is missing, run `pnpm --filter @deepcode/session-core build`
  or use a packaged distribution that includes session-core/dist, node_modules/@deepcode/protocol,
  and node/bin/node.

Boundary:
  CLI/TUI/GUI/Editor are shells over the same daemon Session Runtime, Kernel permissions, and timeline projection."#
    );
}

pub(crate) fn print_interactive_help(host: &SessionHostOptions) {
    println!(
        r#"DeepCode CLI Host Shell

Core:
  /help                 Show this command list
  /status               Check Kernel daemon health
  /workspace            Show current workspace binding
  /workspace <path>     Bind terminal turns to a workspace
  /workspace cwd        Bind to the current directory
  /workspace clear      Clear workspace binding; ordinary chat remains available
  /quit                 Exit

Sessions:
  /sessions             List Agent sessions for the current workspace scope
  /timeline             Print current session timeline

Permissions and decisions:
  /decision ...         Resolve an exact plan or permission wait through the shared Session Runtime
  decision plan accept  Confirm the latest pending plan in the shared timeline projection
  decision plan revise  Submit review guidance for a pending plan
  decision plan reject  End a pending plan
  decision permission accept|reject
                        Resolve the exact pending permission through a canonical decision run
  any text              Send a message through the shared Session Runtime

Non-interactive:
  DeepCode-CLI daemon status
  DeepCode-CLI sessions list
  DeepCode-CLI timeline [session-id]
  DeepCode-CLI ask "..."          Run a live turn
  DeepCode-CLI -p ask "..."       Print only the final answer

This shell uses the same daemon Session Runtime and Kernel permission settings as the GUI/Editor."#
    );
    println!("{}", workspace_status(host));
    println!("session runtime: daemon /runs");
    println!("cli wait timeout: DEEPCODE_CLI_RUN_TIMEOUT_MS, default unset, 0 disables");
    if !io::stdin().is_terminal() {
        println!("stdin is not a terminal; EOF exits immediately.");
    }
}
