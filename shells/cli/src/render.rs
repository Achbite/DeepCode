use deepcode_kernel_client::{
    is_terminal_run_status, ActivityProjection, ApprovalProjection, ExecutionPlanStep,
    InteractionProjection, PlanOperation, ProjectionMessage, SessionProjection,
    SessionTimelineItem, TodoListProjection,
};
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};

/// Output-local bookkeeping; Session remains the owner of ordering and state.
#[derive(Default)]
pub(crate) struct CliRenderState {
    items: HashSet<String>,
    plans: HashMap<(String, u64), String>,
    activities: HashMap<String, ActivityProjection>,
    todo: Option<TodoListProjection>,
    text: HashMap<String, String>,
    active_stream: Option<String>,
    line_open: bool,
    plan_preview: Option<(String, String)>,
    summarized_runs: HashSet<String>,
}

impl CliRenderState {
    pub(crate) fn after(projection: &SessionProjection) -> Self {
        Self {
            items: projection
                .timeline
                .iter()
                .map(|item| item.timeline_id().to_owned())
                .collect(),
            plans: projection
                .plans
                .iter()
                .map(|plan| ((plan.plan_id.clone(), plan.revision), plan.status.clone()))
                .collect(),
            activities: projection
                .activities
                .iter()
                .map(|activity| (activity.activity_id.clone(), activity.clone()))
                .collect(),
            todo: projection.todo_list.clone(),
            ..Self::default()
        }
    }

    pub(crate) fn render(
        &mut self,
        out: &mut impl Write,
        projection: &SessionProjection,
    ) -> io::Result<()> {
        // Finish a streamed block before any newly observed status can interrupt it.
        if let Some(active) = self.active_stream.clone() {
            let committed = projection.timeline.iter().find_map(|item| {
                let (stream, content) = committed_text(projection, item)?;
                (stream == Some(active.as_str())).then_some(content)
            });
            if let Some(content) = committed {
                self.write_text(out, &active, content)?;
                self.finish_text(out)?;
            } else if projection.assistant_draft.as_ref().is_some_and(|draft| {
                draft
                    .blocks
                    .iter()
                    .any(|block| block.text().is_some_and(|(id, _)| id == active))
            }) {
                self.render_draft(out, projection)?;
                let boundary = projection.run.as_ref().is_some_and(|run| {
                    run.status == "waiting" || is_terminal_run_status(&run.status)
                });
                if self.active_stream.is_some() && !boundary {
                    return out.flush();
                }
                self.finish_text(out)?;
            } else {
                self.finish_text(out)?;
            }
        }

        // timelineId is stable; sequence is a fact version, not a display cursor.
        for item in &projection.timeline {
            match item {
                SessionTimelineItem::Message {
                    message_id,
                    stream_id,
                    ..
                } => {
                    if self.items.contains(item.timeline_id()) {
                        continue;
                    }
                    let message = projection
                        .messages
                        .iter()
                        .find(|message| message.message_id == *message_id)
                        .expect("validated Session timeline message reference");
                    if let Some(stream) = stream_id {
                        self.write_text(out, stream, &message.content)?;
                        self.finish_text(out)?;
                    } else {
                        writeln!(out, "{}: {}", message.role, message.content)?;
                    }
                    render_attachments(out, message)?;
                }
                SessionTimelineItem::Narrative {
                    narrative_id,
                    stream_id,
                    ..
                } => {
                    if self.items.contains(item.timeline_id()) {
                        continue;
                    }
                    let narrative = projection
                        .narratives
                        .iter()
                        .find(|value| value.narrative_id == *narrative_id)
                        .expect("validated Session timeline narrative reference");
                    self.write_text(out, stream_id, &narrative.content)?;
                    self.finish_text(out)?;
                }
                SessionTimelineItem::Plan {
                    plan_id, revision, ..
                } => {
                    let plan = projection
                        .plans
                        .iter()
                        .find(|plan| plan.plan_id == *plan_id && plan.revision == *revision)
                        .expect("validated Session timeline plan reference");
                    let key = (plan.plan_id.clone(), plan.revision);
                    match self.plans.get(&key) {
                        None => render_plan_document(
                            out,
                            plan.revision,
                            &plan.status,
                            &plan.title,
                            &plan.summary,
                            &plan.steps,
                            &plan.mutation_manifest,
                        )?,
                        Some(status) if status != &plan.status => writeln!(
                            out,
                            "Plan 状态 · revision {} · {}",
                            plan.revision, plan.status
                        )?,
                        Some(_) => {}
                    }
                    self.plans.insert(key, plan.status.clone());
                }
                SessionTimelineItem::ToolGroup { activity_ids, .. } => {
                    for id in activity_ids {
                        let activity = projection
                            .activities
                            .iter()
                            .find(|activity| activity.activity_id == *id)
                            .expect("validated Session timeline activity reference");
                        if self.activities.get(id) != Some(activity) {
                            render_tool_activity(out, projection, activity)?;
                            self.activities.insert(id.clone(), activity.clone());
                        }
                    }
                }
            }
            self.items.insert(item.timeline_id().to_owned());
        }
        if self.todo.as_ref() != projection.todo_list.as_ref() {
            render_todo(out, projection)?;
            self.todo = projection.todo_list.clone();
        }
        self.render_draft(out, projection)?;
        out.flush()
    }

    fn write_text(&mut self, out: &mut impl Write, stream: &str, content: &str) -> io::Result<()> {
        let previous = self.text.get(stream).map(String::as_str).unwrap_or("");
        let delta = content.strip_prefix(previous).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "CLI 已输出文本与 Session 流内容不一致。",
            )
        })?;
        if delta.is_empty() {
            return Ok(());
        }
        if self.active_stream.as_deref() != Some(stream) {
            self.finish_text(out)?;
        }
        // No splitting, trimming or reformatting of Markdown / Unicode deltas.
        let previous_len = self.text.get(stream).map_or(0, String::len);
        out.write_all(content[previous_len..].as_bytes())?;
        self.line_open = !content.ends_with('\n');
        self.active_stream = Some(stream.to_owned());
        self.text.insert(stream.to_owned(), content.to_owned());
        Ok(())
    }

    fn render_draft(
        &mut self,
        out: &mut impl Write,
        projection: &SessionProjection,
    ) -> io::Result<()> {
        let Some(draft) = projection.assistant_draft.as_ref() else {
            return Ok(());
        };
        for block in &draft.blocks {
            if let Some((stream, content)) = block.text() {
                // A committed block supersedes its draft even if both are visible
                // in the projection delivered during the handoff.
                if projection.timeline.iter().any(|item| {
                    committed_text(projection, item).is_some_and(|(id, _)| id == Some(stream))
                }) {
                    continue;
                }
                self.write_text(out, stream, content)?;
            }
        }
        if let Some(preview) = draft.plan_preview.as_ref() {
            let key = format!("{}:{}", draft.turn_id, preview.provider_call_id);
            let status = format!(
                "正在生成计划 · {} · {} 个步骤",
                preview.title,
                preview.steps.len()
            );
            if self.plan_preview.as_ref() != Some(&(key.clone(), status.clone())) {
                self.finish_text(out)?;
                writeln!(out, "{status}")?;
                self.plan_preview = Some((key, status));
            }
        }
        Ok(())
    }

    pub(crate) fn finish_text(&mut self, out: &mut impl Write) -> io::Result<()> {
        if self.line_open {
            writeln!(out)?;
        }
        self.line_open = false;
        self.active_stream = None;
        out.flush()
    }

    pub(crate) fn render_action_required(
        &mut self,
        out: &mut impl Write,
        projection: &SessionProjection,
    ) -> io::Result<()> {
        self.finish_text(out)?;
        if let Some(plan) = projection.pending_plan.as_ref() {
            let key = (plan.plan_id.clone(), plan.revision);
            if !self.plans.contains_key(&key) {
                render_plan_document(
                    out,
                    plan.revision,
                    &plan.status,
                    &plan.title,
                    &plan.summary,
                    &plan.steps,
                    &plan.mutation_manifest,
                )?;
                self.plans.insert(key, plan.status.clone());
            }
            writeln!(out, "输入 1/确认；输入其他非空文本请求修订；显式运行 `deepcode-cli cancel-plan --session {}` 取消。", projection.session_id)?;
        }
        if let Some(interaction) = projection.pending_interaction.as_ref() {
            render_interaction(out, interaction)?;
            writeln!(
                out,
                "继续：deepcode-cli ask --session {} <response>",
                projection.session_id
            )?;
        }
        if let Some(approval) = projection.pending_approval.as_ref() {
            render_approval(out, approval)?;
            writeln!(out, "继续：输入 1/允许 或 2/拒绝。")?;
        }
        out.flush()
    }

    pub(crate) fn finish_run(
        &mut self,
        out: &mut impl Write,
        projection: &SessionProjection,
    ) -> io::Result<()> {
        self.finish_text(out)?;
        if let Some(run) = projection
            .run
            .as_ref()
            .filter(|run| is_terminal_run_status(&run.status))
        {
            self.render_file_changes(out, projection, &run.run_id)?;
        }
        out.flush()
    }

    fn render_file_changes(
        &mut self,
        out: &mut impl Write,
        projection: &SessionProjection,
        run_id: &str,
    ) -> io::Result<()> {
        if !self.summarized_runs.insert(run_id.to_owned()) {
            return Ok(());
        }
        let changes = projection.file_changes_for_run(run_id);
        if !changes.is_empty() {
            writeln!(out, "本轮修改 · {run_id}")?;
            for (record, index, change) in changes {
                writeln!(
                    out,
                    "  {} {} · deepcode-cli diff --session {} {} {}",
                    change.kind, change.path, projection.session_id, record, index
                )?;
            }
        }
        Ok(())
    }
}

fn committed_text<'a>(
    projection: &'a SessionProjection,
    item: &'a SessionTimelineItem,
) -> Option<(Option<&'a str>, &'a str)> {
    match item {
        SessionTimelineItem::Message {
            message_id,
            stream_id,
            ..
        } => projection
            .messages
            .iter()
            .find(|message| message.message_id == *message_id)
            .map(|message| (stream_id.as_deref(), message.content.as_str())),
        SessionTimelineItem::Narrative {
            narrative_id,
            stream_id,
            ..
        } => projection
            .narratives
            .iter()
            .find(|narrative| narrative.narrative_id == *narrative_id)
            .map(|narrative| (Some(stream_id.as_str()), narrative.content.as_str())),
        _ => None,
    }
}

fn render_plan_document(
    out: &mut impl Write,
    revision: u64,
    status: &str,
    title: &str,
    summary: &str,
    steps: &[ExecutionPlanStep],
    operations: &[PlanOperation],
) -> io::Result<()> {
    writeln!(
        out,
        "Plan · revision {revision} · {status}\n{title}\n{summary}"
    )?;
    for (index, step) in steps.iter().enumerate() {
        writeln!(out, "{}. {}", index + 1, step.title)?;
        for line in step.details.lines() {
            writeln!(out, "   {line}")?;
        }
        if let Some(verification) = step.verification.as_ref() {
            for item in verification {
                writeln!(out, "   验证：{item}")?;
            }
        }
    }
    if !operations.is_empty() {
        writeln!(out, "修改范围：")?;
        for operation in operations {
            write!(
                out,
                "  [{}] {}",
                operation.workspace_id, operation.operation
            )?;
            if let Some(target) = &operation.target {
                write!(out, " {target}")?;
            }
            if let Some(scope) = &operation.execution_scope {
                write!(out, " · {scope}")?;
            }
            if let Some(paths) = &operation.writable_paths {
                for target in paths {
                    write!(
                        out,
                        " · {}{}",
                        target.path,
                        if target.kind == "directory" { "/" } else { "" }
                    )?;
                }
            }
            writeln!(out)?;
        }
    }
    Ok(())
}

pub(crate) fn render_action_required_if_any(
    out: &mut impl Write,
    projection: &SessionProjection,
) -> io::Result<()> {
    CliRenderState::default().render_action_required(out, projection)
}

pub(crate) fn render_projection(
    out: &mut impl Write,
    projection: &SessionProjection,
) -> io::Result<()> {
    writeln!(
        out,
        "session={} revision={} run={}",
        projection.session_id,
        projection.revision,
        projection.run.as_ref().map_or_else(
            || "-".to_owned(),
            |run| format!("{}:{}", run.run_id, run.status)
        )
    )?;
    if !projection.session_directory_indexes.is_empty() {
        writeln!(out, "对话目录索引：")?;
        for binding in &projection.session_directory_indexes {
            writeln!(out, "  {} ({})", binding.display_name, binding.workspace_id)?;
        }
    }
    let mut state = CliRenderState::default();
    state.render(out, projection)?;
    state.finish_text(out)?;
    for activity in projection
        .activities
        .iter()
        .filter(|activity| activity.kind != "tool")
    {
        writeln!(
            out,
            "{} [{}]: {}",
            activity.kind, activity.status, activity.label
        )?;
    }
    for round in &projection.file_change_rounds {
        if projection
            .run
            .as_ref()
            .is_some_and(|run| run.run_id == round.run_id && !is_terminal_run_status(&run.status))
        {
            continue;
        }
        state.render_file_changes(out, projection, &round.run_id)?;
    }
    render_usage(out, projection)?;
    state.render_action_required(out, projection)?;
    render_terminal_error(out, projection)
}

pub(crate) fn render_tool_activity(
    out: &mut impl Write,
    projection: &SessionProjection,
    activity: &ActivityProjection,
) -> io::Result<()> {
    let operation = activity
        .tool
        .as_ref()
        .map(|tool| tool.operation.as_str())
        .unwrap_or(activity.label.as_str());
    writeln!(out, "工具 {operation} [{}]", activity.status)?;
    if let Some(error) = &activity.interruption {
        writeln!(out, "  {}: {}", error.code, error.message)?;
    }
    if let Some(tool) = activity.tool.as_ref() {
        if let Some(shell) = tool.shell.as_ref() {
            writeln!(out, "  $ {}", shell.command)?;
            writeln!(out, "  cwd: {}", shell.cwd)?;
            if let Some(result) = shell.result.as_ref() {
                writeln!(out,
                    "  environment: shell={} · interactive={} · pathSource={} · writeScope={} · homeWritable={}",
                    result.environment.shell,
                    result.environment.interactive,
                    result.environment.path_source,
                    result.environment.write_scope,
                    result.environment.home_writable,
                )?;
                let exit = result
                    .exit_code
                    .map_or_else(|| "signal/timeout".to_string(), |code| code.to_string());
                writeln!(
                    out,
                    "  exit: {exit} · {} ms · {} bytes{}{}",
                    result.duration_ms,
                    result.captured_bytes,
                    if result.timed_out {
                        " · timed out"
                    } else {
                        ""
                    },
                    if result.truncated {
                        " · truncated"
                    } else {
                        ""
                    },
                )?;
                print_tool_stream(out, "stdout", &result.stdout)?;
                print_tool_stream(out, "stderr", &result.stderr)?;
            }
        }
        for (index, change) in tool.file_changes.iter().enumerate() {
            if let Some(record) = &tool.record_id {
                writeln!(
                    out,
                    "  {} {} -> deepcode-cli diff --session {} {} {}",
                    change.kind, change.path, projection.session_id, record, index
                )?;
            }
        }
        for resource in &tool.resources {
            match (
                resource.kind.as_str(),
                resource.workspace_id.as_deref(),
                resource.logical_path.as_deref(),
                resource.uri.as_deref(),
            ) {
                ("workspacePath", Some(workspace_id), Some(logical_path), _) => writeln!(
                    out,
                    "  {} -> deepcode-cli open-resource --session {} {} {:?}",
                    resource.label, projection.session_id, workspace_id, logical_path,
                )?,
                ("url", _, _, Some(uri)) => writeln!(out, "  {} -> {uri}", resource.label)?,
                _ => writeln!(out, "  {}", resource.label)?,
            }
        }
    }
    Ok(())
}

pub(crate) fn print_tool_stream(out: &mut impl Write, label: &str, output: &str) -> io::Result<()> {
    if output.is_empty() {
        return Ok(());
    }
    writeln!(out, "  {label}:")?;
    for line in output.lines() {
        writeln!(out, "    {line}")?;
    }
    Ok(())
}

pub(crate) fn render_todo(out: &mut impl Write, projection: &SessionProjection) -> io::Result<()> {
    let Some(todo) = projection.todo_list.as_ref() else {
        return Ok(());
    };
    writeln!(out, "Todo")?;
    if todo.items.is_empty() {
        writeln!(out, "  （空）")?;
        return Ok(());
    }
    for item in &todo.items {
        let marker = match item.status.as_str() {
            "completed" => "[x]",
            "inProgress" => "[>]",
            _ => "[ ]",
        };
        writeln!(out, "  {marker} {}", item.label)?;
    }
    Ok(())
}

pub(crate) fn render_usage(out: &mut impl Write, projection: &SessionProjection) -> io::Result<()> {
    let usage = &projection.token_usage;
    let cache = match (usage.cache_available, usage.cache_hit_ratio) {
        (true, Some(ratio)) => format!("{:.0}%", ratio * 100.0),
        _ => "--%".to_string(),
    };
    let coverage = if usage.cache_complete {
        "complete"
    } else if usage.cache_available {
        "partial"
    } else {
        "unavailable"
    };
    writeln!(out,
        "Provider 调用 {} · 输入 {} · 输出 {} · 缓存命中 {} · 缓存读取 {} · 缓存未命中 {} · 缓存报告 {}/{} ({})",
        usage.provider_call_count,
        usage.input_tokens,
        usage.output_tokens,
        cache,
        usage.cache_read_input_tokens,
        usage.cache_miss_input_tokens,
        usage.reported_call_count,
        usage.provider_call_count,
        coverage,
    )?;
    Ok(())
}

pub(crate) fn render_attachments(
    out: &mut impl Write,
    message: &ProjectionMessage,
) -> io::Result<()> {
    if !message.filesystem_references.is_empty() {
        writeln!(
            out,
            "  文件系统引用：{}",
            message
                .filesystem_references
                .iter()
                .map(|reference| reference.display_name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )?;
    }
    Ok(())
}

pub(crate) fn render_approval(
    out: &mut impl Write,
    approval: &ApprovalProjection,
) -> io::Result<()> {
    writeln!(out, "需要你批准：{}", approval.preview.summary)?;
    for target in &approval.preview.logical_targets {
        writeln!(out, "  - {target}")?;
    }
    Ok(())
}

pub(crate) fn render_interaction(
    out: &mut impl Write,
    interaction: &InteractionProjection,
) -> io::Result<()> {
    writeln!(out, "需要你回答：{}", interaction.prompt)?;
    if let Some(options) = interaction.options.as_ref() {
        for (index, option) in options.iter().enumerate() {
            match option.description.as_deref() {
                Some(description) => {
                    writeln!(out, "  {}. {}: {}", index + 1, option.label, description)?
                }
                None => writeln!(out, "  {}. {}", index + 1, option.label)?,
            }
        }
    }
    Ok(())
}

pub(crate) fn render_run_state(
    out: &mut impl Write,
    projection: &SessionProjection,
) -> io::Result<()> {
    if let Some(run) = projection.run.as_ref() {
        writeln!(out, "run {}: {}", run.run_id, run.status)?;
        render_usage(out, projection)?;
    }
    Ok(())
}

pub(crate) fn render_terminal_error(
    out: &mut impl Write,
    projection: &SessionProjection,
) -> io::Result<()> {
    if let Some(error) = projection.terminal_error.as_ref() {
        writeln!(out, "{}: {}", error.code, error.message)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn projection() -> SessionProjection {
        serde_json::from_value(json!({
            "schemaVersion": deepcode_kernel_client::SESSION_PROJECTION_VERSION,
            "sessionId": "session:test", "revision": 1,
            "display": {"creationTitle":"CLI display"},
            "workspaceBindings": [], "sessionDirectoryIndexes": [],
            "timeline": [], "messages": [], "narratives": [], "plans": [],
            "contextCompositions": [], "tokenUsageHistory": [], "activities": [], "artifacts": [],
            "tokenUsage": {"providerCallCount":0,"reportedCallCount":0,"inputTokens":0,"outputTokens":0,
                "cacheReadInputTokens":0,"cacheMissInputTokens":0,"cacheAvailable":false,"cacheComplete":false},
            "run": {"runId":"run:test","profileId":"profile:test","workspaceBindings":[],"status":"running"}
        })).unwrap()
    }

    fn plan(revision: u64, status: &str, sequence: u64) -> Value {
        json!({"planId":"plan:test","revision":revision,"runId":"run:test","callId":"call:plan",
            "title":format!("审核方案 {revision}"),"summary":"方案正文只输出一次",
            "steps":[{"stepId":"step:one","title":"执行并验证","details":"第一行\n第二行"}],
            "mutationManifest":[],"status":status,"sequence":sequence,"createdAt":"now","updatedAt":"now"})
    }

    fn add_plan(p: &mut SessionProjection, revision: u64, status: &str, sequence: u64) {
        p.plans
            .push(serde_json::from_value(plan(revision, status, sequence)).unwrap());
        p.timeline.push(serde_json::from_value(json!({"kind":"plan","timelineId":format!("plan:{revision}"),
            "sequence":sequence,"providerRequestId":"request:plan","planId":"plan:test","revision":revision})).unwrap());
    }

    fn narrative(p: &mut SessionProjection, id: &str, sequence: u64, content: &str) {
        p.narratives.push(
            serde_json::from_value(
                json!({"narrativeId":id,"runId":"run:test","providerRequestId":id,
            "content":content,"sequence":sequence,"createdAt":"now"}),
            )
            .unwrap(),
        );
        p.timeline.push(
            serde_json::from_value(
                json!({"kind":"narrative","timelineId":id,"sequence":sequence,
            "providerRequestId":id,"narrativeId":id,"streamId":id}),
            )
            .unwrap(),
        );
    }

    fn tool(p: &mut SessionProjection) {
        p.activities.push(serde_json::from_value(json!({"activityId":"tool:one","kind":"tool","status":"running",
            "label":"write","runId":"run:test","callId":"call:write","sequence":20,
            "tool":{"operation":"fs.write","recordId":"record:one","resources":[],"fileChanges":[{
                "workspaceId":"workspace:test","path":"result.txt","kind":"create",
                "before":{"exists":false},"after":{"exists":true,"contentRef":"content:one","sizeBytes":8}}]}})).unwrap());
        p.timeline.push(
            serde_json::from_value(
                json!({"kind":"toolGroup","timelineId":"tools:one","sequence":20,
            "providerRequestId":"request:write","activityIds":["tool:one"]}),
            )
            .unwrap(),
        );
        p.file_change_rounds.push(
            serde_json::from_value(json!({"runId":"run:test","recordIds":["record:one"]})).unwrap(),
        );
    }

    fn draft(p: &mut SessionProjection, content: &str) {
        p.assistant_draft = Some(serde_json::from_value(json!({"runId":"run:test","turnId":"turn:final",
            "blocks":[{"kind":"finalMessage","streamId":"stream:final","outputIndex":0,"content":content}]})).unwrap());
    }

    fn commit(p: &mut SessionProjection, content: &str) {
        p.messages.push(serde_json::from_value(json!({"messageId":"message:final","runId":"run:test",
            "role":"assistant","content":content,"filesystemReferences":[],"pluginSelections":[],"sequence":38,"createdAt":"now"})).unwrap());
        p.timeline.push(
            serde_json::from_value(
                json!({"kind":"message","timelineId":"message:final","sequence":38,
            "messageId":"message:final","streamId":"stream:final","outputIndex":0}),
            )
            .unwrap(),
        );
    }

    #[test]
    fn item_identity_preserves_nonmonotonic_order_and_later_updates() {
        let mut p = projection();
        narrative(&mut p, "narrative:old", 15, "已看过的过程");
        add_plan(&mut p, 1, "published", 12);
        let mut state = CliRenderState::after(&p);
        let mut out = Vec::new();
        p.plans[0].status = "confirmed".into();
        p.plans[0].sequence = 17;
        state.render(&mut out, &p).unwrap();
        state.render(&mut out, &p).unwrap();
        tool(&mut p);
        state.render(&mut out, &p).unwrap();
        p.activities[0].status = "completed".into();
        p.plans[0].status = "completed".into();
        p.plans[0].sequence = 34;
        state.render(&mut out, &p).unwrap();
        // This item becomes visible after a larger sequence has already rendered.
        narrative(&mut p, "narrative:late", 23, "后到的真实过程");
        state.render(&mut out, &p).unwrap();
        state.render(&mut out, &p).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(!text.contains("已看过的过程"));
        assert!(!text.contains("方案正文只输出一次"));
        assert_eq!(text.matches("后到的真实过程").count(), 1);
        assert_eq!(
            text.matches("Plan 状态 · revision 1 · completed").count(),
            1
        );
        assert_eq!(text.matches("工具 fs.write [running]").count(), 1);
        assert_eq!(text.matches("工具 fs.write [completed]").count(), 1);
        assert!(!text.contains("本轮修改"));
    }

    #[test]
    fn pending_plan_document_has_one_owner_and_revisions_stay_reviewable() {
        let mut p = projection();
        add_plan(&mut p, 1, "published", 12);
        let mut pending = plan(1, "published", 12);
        pending["responseMode"] = json!("confirmReviseOrCancel");
        p.pending_plan = Some(serde_json::from_value(pending).unwrap());
        let mut state = CliRenderState::default();
        let mut out = Vec::new();
        state.render(&mut out, &p).unwrap();
        state.render_action_required(&mut out, &p).unwrap();
        p.pending_plan = None;
        p.plans[0].status = "revisionRequested".into();
        add_plan(&mut p, 2, "published", 30);
        state.render(&mut out, &p).unwrap();
        state.render(&mut out, &p).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.matches("审核方案 1").count(), 1);
        assert_eq!(text.matches("审核方案 2").count(), 1);
        assert_eq!(text.matches("输入 1/确认").count(), 1);
        assert!(text.contains("   第一行\n   第二行"));
        assert!(text.contains("Plan 状态 · revision 1 · revisionRequested"));
    }

    #[test]
    fn streamed_markdown_is_contiguous_and_committed_tail_precedes_status() {
        let mut p = projection();
        add_plan(&mut p, 1, "confirmed", 17);
        let mut state = CliRenderState::after(&p);
        let mut out = Vec::new();
        let chunks = [
            "## 结果\n\n已",
            "完成。\n\n```cpp\nint n = 1;\n```\n\n不需要",
            "新的计划修订。",
        ];
        draft(&mut p, chunks[0]);
        state.render(&mut out, &p).unwrap();
        p.plans[0].status = "completed".into();
        p.plans[0].sequence = 34;
        let partial = chunks[..2].concat();
        draft(&mut p, &partial);
        state.render(&mut out, &p).unwrap();
        assert_eq!(String::from_utf8(out.clone()).unwrap(), partial);
        let complete = chunks.concat();
        commit(&mut p, &complete);
        // The committed text is authoritative even during a draft handoff.
        state.render(&mut out, &p).unwrap();
        state.render(&mut out, &p).unwrap();
        p.assistant_draft = None;
        state.render(&mut out, &p).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(
            text,
            format!("{complete}\nPlan 状态 · revision 1 · completed\n")
        );
    }

    #[test]
    fn changes_are_summarized_once_after_text_on_each_terminal_outcome() {
        for status in ["completed", "failed", "cancelled", "indeterminate"] {
            let mut p = projection();
            tool(&mut p);
            p.activities[0].status = "completed".into();
            let mut state = CliRenderState::default();
            let mut out = Vec::new();
            state.render(&mut out, &p).unwrap();
            state.finish_run(&mut out, &p).unwrap();
            assert!(!String::from_utf8(out.clone()).unwrap().contains("本轮修改"));
            draft(&mut p, "已经写入文件，");
            state.render(&mut out, &p).unwrap();
            commit(&mut p, "已经写入文件，以下为实际结果。");
            p.assistant_draft = None;
            p.run.as_mut().unwrap().status = status.into();
            state.render(&mut out, &p).unwrap();
            state.finish_run(&mut out, &p).unwrap();
            state.finish_run(&mut out, &p).unwrap();
            let text = String::from_utf8(out).unwrap();
            assert_eq!(text.matches("本轮修改").count(), 1);
            assert!(text.contains("已经写入文件，以下为实际结果。\n本轮修改"));
            assert!(text.contains("create result.txt · deepcode-cli diff"));
        }
    }
}
