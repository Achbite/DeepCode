use crate::*;

pub(crate) fn render_timeline(timeline: &Value) {
    let timeline = timeline_payload(timeline);
    let is_v2 = timeline.get("schemaVersion").and_then(Value::as_str)
        == Some("deepcode.shared-conversation-projection.v2");
    let turns = timeline
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for turn in turns {
        let status = turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        println!("turn: {status}");
        for block in turn
            .get("blocks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let entry_role = block
                .get("entryRole")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let kind = block
                .get("narrativeKind")
                .or_else(|| block.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or("stage");
            if kind == "thinking"
                || (is_v2
                    && entry_role == "finalAnswer"
                    && block.get("durability").and_then(Value::as_str) != Some("committed"))
            {
                continue;
            }
            let title = block
                .get("title")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(kind);
            let body = timeline_block_text(block, kind);
            println!("  {kind}: {title}");
            for line in body.lines().take(12) {
                println!("    {line}");
            }
        }
    }
}

pub(crate) fn render_decision_result(timeline: &Value) {
    if let Some(text) = extract_decision_result_text(timeline) {
        println!("{text}");
        return;
    }
    render_timeline(timeline);
}

fn extract_decision_result_text(timeline: &Value) -> Option<String> {
    extract_plain_text(timeline)
}

fn timeline_block_text(block: &Value, kind: &str) -> String {
    if matches!(kind, "plan" | "review") {
        if let Some(text) = block
            .get("structuredProjection")
            .map(render_readable_projection)
            .filter(|text| !text.trim().is_empty())
        {
            return text;
        }
    }
    block
        .get("bodyMarkdown")
        .or_else(|| block.pointer("/localizedContent/text"))
        .or_else(|| block.get("summary"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default()
}

fn render_readable_projection(readable: &Value) -> String {
    let mut lines = Vec::new();
    let sections = readable.get("sections").and_then(Value::as_array);
    let summary_is_structured = sections
        .map(|sections| sections.iter().any(readable_section_has_summary_items))
        .unwrap_or(false);
    if !summary_is_structured {
        if let Some(summary) = readable.get("summary").and_then(Value::as_str) {
            lines.push(summary.to_string());
        } else if let Some(summary_key) = readable.get("summaryKey").and_then(Value::as_str) {
            lines.push(
                readable_summary_key_text(summary_key)
                    .unwrap_or(summary_key)
                    .to_string(),
            );
        }
    }
    if let Some(sections) = sections {
        for section in sections {
            if let Some(title) = readable_section_title(section) {
                lines.push(format!("## {title}"));
            }
            let mut seen_section_lines: Vec<String> = Vec::new();
            let items = section
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if items.is_empty() {
                if let Some(empty) = section.get("emptyMessageKey").and_then(Value::as_str) {
                    if let Some(message) = readable_empty_message(empty) {
                        lines.push(format!("- {message}"));
                    }
                }
            }
            for item in items {
                let item_text = readable_item_text(&item);
                if let Some(text) = &item_text {
                    push_unique_render_line(
                        &mut lines,
                        &mut seen_section_lines,
                        format!("- {text}"),
                    );
                }
                if let Some(targets) = item.get("targetRefs").and_then(Value::as_array) {
                    let target_text = targets
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ");
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

fn readable_section_has_summary_items(section: &Value) -> bool {
    let section_key = section
        .get("sectionId")
        .or_else(|| section.get("titleKey"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(
        section_key,
        "summary" | "session.projection.plan.section.summary"
    ) {
        return false;
    }
    section
        .get("items")
        .and_then(Value::as_array)
        .map(|items| items.iter().any(|item| readable_item_text(item).is_some()))
        .unwrap_or(false)
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

fn readable_item_text(item: &Value) -> Option<String> {
    if let Some(text) = item.get("text").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            return Some(text.to_string());
        }
    }
    item.get("messageKey")
        .and_then(Value::as_str)
        .and_then(|key| readable_message_text(key, item))
}

fn readable_message_text(key: &str, item: &Value) -> Option<String> {
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
        "session.projection.review.count.workUnitsCompleted" => {
            Some(format!("WorkUnits completed: {}", arg("count")))
        }
        "session.projection.review.count.workUnitsFailed" => {
            Some(format!("WorkUnits failed: {}", arg("count")))
        }
        "session.projection.review.count.workUnitsBlocked" => {
            Some(format!("WorkUnits blocked: {}", arg("count")))
        }
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
        _ => None,
    }
}

fn readable_message_arg(item: &Value, name: &str) -> Option<String> {
    item.get("messageArgs")?
        .get(name)?
        .as_str()
        .map(str::to_string)
}

fn readable_section_title(section: &Value) -> Option<String> {
    if let Some(title) = section.get("title").and_then(Value::as_str) {
        return Some(title.to_string());
    }
    let key = section
        .get("sectionId")
        .or_else(|| section.get("titleKey"))
        .and_then(Value::as_str)?;
    Some(
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
            _ => key,
        }
        .to_string(),
    )
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
    timeline: &Value,
    requested_kind: &str,
    run_filter: Option<&str>,
) -> Option<PendingSessionDecision> {
    let timeline = timeline_payload(timeline);
    if timeline.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.shared-conversation-projection.v2")
    {
        return None;
    }
    let pending = timeline.get("interactionProjection")?.get("pending")?;
    let kind = pending.get("kind").and_then(Value::as_str)?;
    if kind != requested_kind {
        return None;
    }
    let run_id = if kind == "permission" {
        let request = pending.get("request")?;
        let request_id = request
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())?;
        let pending_request_id = pending
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())?;
        let target_id = pending
            .get("targetId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())?;
        if request_id != pending_request_id || request_id != target_id {
            return None;
        }
        request
            .get("runId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())?
            .to_string()
    } else {
        pending
            .get("runId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())?
            .to_string()
    };
    if run_filter.is_some_and(|expected| expected != run_id) {
        return None;
    }
    let target_id = pending
        .get("targetId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?
        .to_string();
    let interaction_id = pending
        .get("interactionId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?
        .to_string();
    let interaction_revision = pending
        .get("interactionRevision")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?
        .to_string();
    let review_id = if kind == "review" {
        Some(
            pending
                .get("reviewId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())?
                .to_string(),
        )
    } else {
        None
    };
    Some(PendingSessionDecision {
        run_id,
        target_id,
        interaction_id,
        interaction_revision,
        review_id,
    })
}

fn extract_final_text(timeline: &Value) -> Option<String> {
    let is_v2 = timeline.get("schemaVersion").and_then(Value::as_str)
        == Some("deepcode.shared-conversation-projection.v2");
    let turns = timeline.get("turns").and_then(Value::as_array)?;
    for turn in turns.iter().rev() {
        let Some(blocks) = turn.get("blocks").and_then(Value::as_array) else {
            continue;
        };
        for block in blocks.iter().rev() {
            if is_v2 {
                if block.get("entryRole").and_then(Value::as_str) != Some("finalAnswer")
                    || block.get("durability").and_then(Value::as_str) != Some("committed")
                {
                    continue;
                }
            }
            let narrative = block
                .get("narrativeKind")
                .or_else(|| block.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !is_v2 && narrative != "assistantText" && narrative != "assistant" {
                continue;
            }
            let text = block
                .get("bodyMarkdown")
                .or_else(|| block.pointer("/localizedContent/text"))
                .or_else(|| block.get("summary"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

pub(crate) fn extract_plain_text(timeline: &Value) -> Option<String> {
    extract_final_text(timeline).or_else(|| extract_pending_decision_text(timeline))
}

fn extract_pending_decision_text(timeline: &Value) -> Option<String> {
    let timeline = timeline_payload(timeline);
    let pending_value = timeline.get("interactionProjection")?.get("pending")?;
    let decision_kind = pending_value.get("kind").and_then(Value::as_str)?;
    let pending = find_pending_session_decision(timeline, decision_kind, None)?;
    let heading = match decision_kind {
        "plan" => "Pending plan decision",
        "review" => "Pending review decision",
        "requirement" => "Pending requirement decision",
        "permission" => "Pending permission decision",
        _ => "Pending decision",
    };
    let block = pending_value
        .get("blockId")
        .and_then(Value::as_str)
        .and_then(|block_id| timeline_block_by_id(timeline, block_id));
    Some(render_pending_decision_text(
        timeline.get("sessionId").and_then(Value::as_str),
        decision_kind,
        heading,
        pending_value,
        block,
        pending,
    ))
}

fn render_pending_decision_text(
    session_id: Option<&str>,
    decision_kind: &str,
    heading: &str,
    pending_value: &Value,
    block: Option<&Value>,
    pending: PendingSessionDecision,
) -> String {
    let mut lines = vec![heading.to_string()];
    if let Some(title) = pending_value
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(title.to_string());
    }
    if let Some(readable) = block.and_then(|item| item.get("structuredProjection")) {
        let rendered = render_readable_projection(readable);
        if !rendered.trim().is_empty() {
            lines.push(rendered);
        }
    } else if let Some(summary) = pending_value
        .get("summary")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(summary.to_string());
    }
    lines.push(format!(
        "Decision target: {decision_kind} run={} target={}",
        pending.run_id, pending.target_id
    ));
    if let Some(session_id) = session_id {
        lines.push(format!(
            "Accept: DeepCode-CLI --session {session_id} decision {decision_kind} accept"
        ));
        if decision_kind == "permission" {
            lines.push(format!(
                "Reject: DeepCode-CLI --session {session_id} decision permission reject"
            ));
        } else {
            lines.push(format!(
                "Revise: DeepCode-CLI --session {session_id} decision {decision_kind} revise <guidance>"
            ));
        }
    }
    lines.join("\n")
}

fn timeline_block_by_id<'a>(timeline: &'a Value, block_id: &str) -> Option<&'a Value> {
    for turn in timeline.get("turns")?.as_array()? {
        for block in turn.get("blocks")?.as_array()? {
            if block.get("id").and_then(Value::as_str) == Some(block_id) {
                return Some(block);
            }
        }
    }
    None
}

fn normalize_render_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn session_id(session: &Value) -> Option<&str> {
    session.get("id").and_then(Value::as_str)
}

pub(crate) fn timeline_payload(timeline: &Value) -> &Value {
    timeline.get("data").unwrap_or(timeline)
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
  DeepCode-CLI decision <requirement|plan|review> <accept|reject|revise> [--session <id>] [run-id] [target-id] [guidance]
  DeepCode-CLI decision permission <accept|reject> [--session <id>] [run-id] [target-id]
  DeepCode-CLI ask [-p|--print] [--session <id>] [--workspace <path>|--no-workspace] <prompt>
  DeepCode-CLI tools run <toolId> --workspace <path> --args-file <json> [--approve-contract]
  DeepCode-CLI tools verify --workspace <path> --cases <jsonl> [--approve-contract]

Options:
  --api <url>                 Kernel daemon HTTP base URL. Defaults to DEEPCODE_API_URL or http://$DEEPCODE_HOST:$DEEPCODE_PORT.
  --no-auto-start-kernel      Do not start a local Kernel when the API is unavailable.
  --workspace, -C             Bind the turn to a workspace path. Defaults to DEEPCODE_WORKSPACE or the current directory.
  --no-workspace              Send an ordinary chat turn without a workspace binding.
  --session <id>              Continue a specific Agent session.
  --approve-contract          Explicitly accept mutation contracts for CLI tool verification.

Environment:
  DEEPCODE_KERNEL_AUTO_START=0 disables local Kernel auto-start.
  DEEPCODE_KERNEL_BIN=/path/to/deepcode-kernel overrides Kernel binary lookup.
  DEEPCODE_WORKSPACE=/path/to/project sets the default terminal workspace.
  DEEPCODE_SESSION_BRIDGE=/path/to/hostBridge.js overrides daemon session-core lookup.
  DEEPCODE_NODE=/path/to/node overrides daemon internal Node runtime lookup.
  DEEPCODE_SESSION_BRIDGE_TIMEOUT_MS controls daemon session run timeout. Defaults to 600000; 0 disables it.
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
  /decision ...         Resolve requirement/plan/review/permission through the shared Session Runtime
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
    println!(
        "session run timeout: DEEPCODE_SESSION_BRIDGE_TIMEOUT_MS, default 600000 ms, 0 disables"
    );
    println!("cli wait timeout: DEEPCODE_CLI_RUN_TIMEOUT_MS, default unset, 0 disables");
    if !io::stdin().is_terminal() {
        println!("stdin is not a terminal; EOF exits immediately.");
    }
}
