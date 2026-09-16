use crate::app::TuiApp;
use deepcode_kernel_client::{
    ActivityProjection, AssistantDraftProjection, ContextCompositionProjection,
    ContextUsageProjection, NarrativeProjection, PendingPlanProjection, PlanProjection,
    ProjectionMessage, SessionProjection, SessionTimelineItem, TokenUsageProjection,
};
use ratatui::{
    layout::{Constraint, Direction, Layout, Margin, Rect},
    prelude::Frame,
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, BorderType, Borders, Clear, Paragraph, Scrollbar, ScrollbarState, Wrap},
};
use std::{
    cell::RefCell,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub struct Renderer {
    animation_started: Instant,
    transcript: RefCell<Option<TranscriptCache>>,
}

#[derive(Clone, PartialEq)]
struct TranscriptKey {
    session: Option<(String, u64)>,
    draft: Option<AssistantDraftProjection>,
    live_output: Vec<(String, deepcode_kernel_client::ToolOutputProjection)>,
    reasoning: bool,
    width: u16,
    height: u16,
}

#[derive(Clone)]
struct TranscriptCache {
    key: TranscriptKey,
    text: Text<'static>,
}

impl Default for Renderer {
    fn default() -> Self {
        Self {
            animation_started: Instant::now(),
            transcript: RefCell::new(None),
        }
    }
}

pub(crate) fn working_indicator(app: &TuiApp, tick: usize) -> Option<String> {
    if app.connection_error().is_some() {
        return None;
    }
    let projection = app.projection()?;
    let run = projection.run.as_ref()?;
    if !matches!(run.status.as_str(), "running" | "releasing") {
        return None;
    }
    let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let mut label = run_label(Some(projection));
    if run.status == "running" {
        if let Some(activity) = projection.activities.iter().rev().find(|activity| {
            activity.kind == "tool" && activity.status == "active" && activity.run_id == run.run_id
        }) {
            label.push_str(&format!(
                " · {}",
                activity
                    .tool
                    .as_ref()
                    .map(|tool| tool.operation.as_str())
                    .unwrap_or(&activity.label)
            ));
        }
    }
    Some(format!(
        "{} {label} · /cancel 停止",
        frames[tick % frames.len()]
    ))
}

fn clipped(text: &str, width: u16) -> String {
    let text = text.replace(['\n', '\r', '\t'], " ");
    let source = Line::from(text.as_str());
    let limit = usize::from(width);
    if source.width() <= limit {
        return text;
    }
    if limit == 0 {
        return String::new();
    }
    let mut result = String::new();
    let mut used = 0;
    for grapheme in source.styled_graphemes(Style::default()) {
        let cells = Span::raw(grapheme.symbol).width();
        if used + cells >= limit {
            break;
        }
        result.push_str(grapheme.symbol);
        used += cells;
    }
    result.push('…');
    result
}

fn run_label(projection: Option<&SessionProjection>) -> String {
    let Some(projection) = projection else {
        return "初始化".into();
    };
    let Some(run) = &projection.run else {
        return "就绪".into();
    };
    if run.status == "running" {
        if let Some(attempt) = projection
            .provider_attempts
            .last()
            .filter(|item| item.run_id == run.run_id)
        {
            if attempt.phase == "retryWaiting" {
                return format!("网络重试 · 等待第 {}/5 次尝试", attempt.attempt + 1);
            }
            if attempt.phase == "started" && attempt.attempt > 1 {
                return format!("正在连接 · 第 {}/5 次尝试", attempt.attempt);
            }
        }
    }
    match run.status.as_str() {
        "running" => "运行中",
        "waiting" => match run.waiting_reason.as_deref() {
            Some("approval") => "等待授权",
            Some("plan") => "等待计划确认",
            Some("userInput") => "等待回答",
            _ => "等待中",
        },
        "releasing" => "正在结束",
        "releaseFailed" => "资源释放失败",
        "completed" => "已完成",
        "failed" => "失败 · /error",
        "cancelled" => "已取消",
        "indeterminate" => "结果未确定 · /error",
        other => other,
    }
    .into()
}

fn decision_lines(projection: Option<&SessionProjection>) -> Vec<Line<'static>> {
    let Some(projection) = projection else {
        return vec![];
    };
    let (title, actions, summary) = if let Some(approval) = &projection.pending_approval {
        (
            "等待授权 · /decision 查看完整范围",
            if approval.preview.authorization_scope.as_deref() == Some("runHostShell") {
                "/reply 1 允许一次 · /reply 2 拒绝 · /reply 3 允许本轮"
            } else {
                "/reply 1 允许 · /reply 2 拒绝"
            },
            approval.preview.summary.clone(),
        )
    } else if let Some(interaction) = &projection.pending_interaction {
        (
            "等待回答 · /decision 查看选项",
            "/reply <内容或选项编号> 回答",
            interaction.prompt.clone(),
        )
    } else if let Some(plan) = &projection.pending_plan {
        (
            "等待计划确认 · /decision 查看计划",
            "/reply 1 确认 · /reply <意见> 修订 · /cancel-plan 取消",
            plan.title.clone(),
        )
    } else {
        return vec![];
    };
    vec![
        Line::from(Span::styled(
            title,
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(actions),
        Line::from(Span::raw(summary)),
        Line::from(Span::styled(
            "普通输入会排队为后续消息",
            Style::default().fg(Color::DarkGray),
        )),
    ]
}

pub(crate) fn decision_details(projection: Option<&SessionProjection>) -> String {
    let Some(projection) = projection else {
        return "Session 尚未初始化。".into();
    };
    if let Some(approval) = &projection.pending_approval {
        let mut text = format!("授权请求\n{}\n", approval.preview.summary);
        for target in &approval.preview.logical_targets {
            text.push_str(&format!("\n{target}"));
        }
        if approval.preview.authorization_scope.as_deref() == Some("sessionBrowser") {
            text.push_str("\n允许后覆盖当前对话的浏览器页面操作。");
        }
        text.push('\n');
        text.push_str(
            &decision_lines(Some(projection))
                .iter()
                .take(2)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        );
        return text;
    }
    if let Some(plan) = &projection.pending_plan {
        let mut text = String::new();
        render_plan_plain(&mut text, plan);
        return text;
    }
    if let Some(interaction) = &projection.pending_interaction {
        let mut text = format!("{}\n/reply <内容或选项编号> 回答\n", interaction.prompt);
        for (index, option) in interaction.options.iter().flatten().enumerate() {
            text.push_str(&format!("\n{}. {}", index + 1, option.label));
        }
        return text;
    }
    "当前没有待处理决策。".into()
}

pub(crate) fn failure_details(projection: Option<&SessionProjection>) -> String {
    let Some(projection) = projection else {
        return "Session 尚未初始化。".into();
    };
    let error = projection.terminal_error.as_ref().or_else(|| {
        projection
            .failure_snapshot
            .as_ref()
            .map(|snapshot| &snapshot.error)
    });
    let Some(error) = error else {
        return "当前没有失败诊断。".into();
    };
    let mut text = format!("{}: {}\n", error.code, error.message);
    if let Some(details) = &error.diagnostics {
        text.push_str(&format!(
            "\n来源 {} · 阶段 {} · 分类 {}\n",
            details.source, details.phase, details.category
        ));
        for cause in &details.causes {
            text.push_str(&format!(
                "\n{}{}",
                cause.message,
                cause
                    .os_code
                    .map(|code| format!(" [OS {code}]"))
                    .unwrap_or_default()
            ));
        }
        if let Some(path) = &details.archive_path {
            text.push_str(&format!("\n\n请求归档：{path}"));
        }
        for secondary in &details.secondary {
            text.push_str(&format!(
                "\n附加错误 {}: {}",
                secondary.code, secondary.message
            ));
        }
    }
    if let Some(snapshot) = &projection.failure_snapshot {
        text.push_str(&format!(
            "\n\n最近失败快照 · revision {} · 阶段 {}\n尝试 {} 次 · 工具记录 {} · 未结调用 {}",
            snapshot.revision,
            snapshot.phase,
            snapshot.provider_attempt_ids.len(),
            snapshot.tool_record_ids.len(),
            snapshot.pending_call_ids.len()
        ));
        if let Some(request) = &snapshot.provider_request_id {
            text.push_str(&format!("\n请求：{request}"));
        }
    }
    text
}

fn push_tool_summary(lines: &mut Vec<Line<'_>>, activity: &ActivityProjection) {
    let operation = activity
        .tool
        .as_ref()
        .map(|tool| tool.operation.as_str())
        .unwrap_or(&activity.label);
    lines.push(Line::from(Span::styled(
        format!("工具 {operation} [{}]", activity.status),
        Style::default().fg(activity_color(&activity.status)),
    )));
    for error in tool_error_lines(activity) {
        lines.push(Line::from(Span::styled(
            error,
            Style::default().fg(Color::Red),
        )));
    }
    if activity.status == "active" {
        if let Some(output) = &activity.live_output {
            for line in output
                .stdout
                .lines()
                .rev()
                .take(3)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
            {
                lines.push(Line::from(Span::styled(
                    format!("  {line}"),
                    Style::default().fg(Color::DarkGray),
                )));
            }
            if let Some(line) = output.stderr.lines().last() {
                lines.push(Line::from(Span::styled(
                    format!("  {line}"),
                    Style::default().fg(Color::Yellow),
                )));
            }
        }
    }
    lines.push(Line::from(Span::styled(
        format!("  /tool {} 查看详情", activity.activity_id),
        Style::default().fg(Color::DarkGray),
    )));
}

pub(crate) fn tool_details(projection: Option<&SessionProjection>, activity_id: &str) -> String {
    let Some(activity) = projection.and_then(|p| {
        p.activities
            .iter()
            .find(|activity| activity.activity_id == activity_id)
    }) else {
        return format!("工具记录不存在：{activity_id}");
    };
    let mut text = String::new();
    render_tool_plain(&mut text, activity);
    text
}

fn multiline_text(lines: Vec<Line<'_>>) -> Text<'static> {
    let mut result = Vec::new();
    for line in lines {
        let mut current = Line::default().style(line.style);
        for span in line.spans {
            for (index, part) in span.content.split('\n').enumerate() {
                if index > 0 {
                    result.push(current);
                    current = Line::default().style(line.style);
                }
                current
                    .spans
                    .push(Span::styled(part.to_string(), span.style));
            }
        }
        result.push(current);
    }
    Text::from(result)
}

/// Hard-wrap the editor by terminal cells, retaining a final cursor cell.
fn input_lines(input: &str, width: u16) -> Vec<Line<'static>> {
    let width = usize::from(width.max(1));
    let mut lines = Vec::new();
    let text = format!("{input} ");
    for part in text.split('\n') {
        let source = Line::from(part);
        let mut current = String::new();
        let mut column = 0;
        for grapheme in source.styled_graphemes(Style::default()) {
            let cells = Span::raw(grapheme.symbol).width();
            if column + cells > width && !current.is_empty() {
                lines.push(Line::from(current));
                current = String::new();
                column = 0;
            }
            current.push_str(grapheme.symbol);
            column += cells;
        }
        lines.push(Line::from(current));
    }
    lines
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    use crate::app::TuiHostOptions;
    use deepcode_kernel_client::{HttpKernelClient, KernelClientConfig};
    use ratatui::{backend::TestBackend, Terminal};

    #[test]
    fn tool_progress_is_visible_before_the_terminal_snapshot() {
        let mut activity: ActivityProjection = serde_json::from_value(serde_json::json!({
            "activityId":"tool:live", "kind":"tool", "status":"active", "label":"bash",
            "runId":"run:test", "callId":"call:live", "sequence":1, "startedAt":"1",
            "liveOutput":{"stdout":"执行中\n", "stderr":"诊断\n", "stdoutBytes":10, "stderrBytes":7, "truncated":true}
        })).unwrap();
        let mut plain = String::new();
        render_tool_plain(&mut plain, &activity);
        let mut lines = Vec::new();
        push_tool_lines(&mut lines, &activity);
        let styled = lines
            .iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        for output in [&plain, &styled] {
            assert!(output.contains("[active]"));
            assert!(output.contains("执行中"));
            assert!(output.contains("诊断"));
            assert!(output.contains("stdout 10 bytes · stderr 7 bytes"));
            assert!(output.contains("仅保留最新片段"));
            assert!(output.contains("已执行"));
        }
        activity.status = "completed".into();
        activity.live_output = None;
        let mut terminal = String::new();
        render_tool_plain(&mut terminal, &activity);
        assert!(terminal.contains("[completed]"));
        assert!(!terminal.contains("执行中"));
        assert!(!terminal.contains("实时输出"));
        assert!(!terminal.contains("已执行"));
    }

    #[test]
    fn plain_and_terminal_tools_keep_original_error_details() {
        for (status, fields, expected) in [
            (
                "failed",
                serde_json::json!({"tool":{"operation":"fs.read", "resources":[], "error":{"code":"fs_read_failed", "message":"原始读取错误"}}}),
                "fs_read_failed: 原始读取错误",
            ),
            (
                "indeterminate",
                serde_json::json!({"interruption":{"code":"result_unknown", "message":"原始传输错误"}}),
                "result_unknown: 原始传输错误",
            ),
            (
                "rejected",
                serde_json::json!({"inputRejection":{"code":"workspace_target_invalid", "message":"Not a directory", "issues":[{"path":"$.path", "rule":"path", "message":"invalid path"}]}}),
                "workspace_target_invalid: Not a directory",
            ),
        ] {
            let mut value = serde_json::json!({"activityId":"tool:error", "kind":"tool", "status":status,
                "label":"fs.read", "runId":"run:test", "callId":"call:error", "sequence":1});
            value
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            let activity: ActivityProjection = serde_json::from_value(value).unwrap();
            let mut plain = String::new();
            render_tool_plain(&mut plain, &activity);
            let mut lines = Vec::new();
            push_tool_lines(&mut lines, &activity);
            assert!(plain.contains(expected));
            assert!(lines.iter().any(|line| line.to_string().contains(expected)));
        }
        let input = serde_json::from_value(serde_json::json!({"commandId":"command:q", "messageId":"message:q", "runId":"run:q",
            "text":"保留原文🙂", "filesystemReferences":[], "pluginSelections":[], "sequence":1, "createdAt":"now", "status":"notApplied"})).unwrap();
        assert_eq!(queued_input_lines(&input), vec!["未执行: 保留原文🙂"]);
    }

    #[test]
    fn single_column_layout_keeps_long_input_cursor_inside_editor() {
        let client = HttpKernelClient::new(
            KernelClientConfig::new("http://127.0.0.1:1")
                .with_host_shell_token(format!("dchost_{}", "01".repeat(32))),
        )
        .unwrap();
        let mut app = TuiApp::new(
            client,
            Renderer::default(),
            TuiHostOptions {
                workspace_path: None,
                session_id: None,
                plugin_uris: vec![],
            },
        );
        app.push_input_text(&format!("{}\n最后一行", "中文输入 e\u{301} ".repeat(100)));
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal
            .draw(|frame| app.renderer().draw(frame, &app))
            .unwrap();
        let contents = format!("{:?}", terminal.backend().buffer());
        assert!(contents.contains("DeepCode"));
        assert!(contents.contains("最后一行"));
        assert!(!contents.contains("本对话暂无任务"));
        let cursor = terminal.get_cursor_position().unwrap();
        assert!(
            cursor.x < 79 && cursor.y >= 17 && cursor.y < 21,
            "{cursor:?}"
        );
    }

    #[test]
    fn transcript_preserves_newlines_and_scrolls_wrapped_rows() {
        let paragraph =
            Paragraph::new(Text::raw("abcdefghijklmnop\n最终正文")).wrap(Wrap { trim: false });
        assert_eq!(paragraph.line_count(8), 3);
        let mut terminal = Terminal::new(TestBackend::new(8, 1)).unwrap();
        terminal
            .draw(|frame| frame.render_widget(paragraph.clone().scroll((2, 0)), frame.area()))
            .unwrap();
        assert!(format!("{:?}", terminal.backend().buffer()).contains("最终正文"));
        let short = Paragraph::new(Text::raw("短行\n\n第二段\n末行"));
        assert_eq!(
            short.line_count(80),
            4,
            "explicit newlines must survive even when no wrapping is needed"
        );
        terminal
            .draw(|frame| frame.render_widget(short.clone().scroll((2, 0)), frame.area()))
            .unwrap();
        assert!(format!("{:?}", terminal.backend().buffer()).contains("第二段"));
    }
}

impl Renderer {
    pub fn draw(&self, frame: &mut Frame<'_>, app: &TuiApp) {
        let area = frame.area().inner(Margin::new(1, 0));
        let input_height = input_lines(app.input(), area.width.saturating_sub(4))
            .len()
            .clamp(1, 4) as u16
            + 2;
        let decision = decision_lines(app.projection());
        let working = working_indicator(
            app,
            (self.animation_started.elapsed().as_millis() / 150) as usize,
        );
        let decision_height = if decision.is_empty() {
            0
        } else {
            (decision.len() as u16 + 2).min(if area.height < 20 { 4 } else { 6 })
        };
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(if area.height < 18 { 1 } else { 2 }),
                Constraint::Min(1),
                Constraint::Length(decision_height),
                Constraint::Length(u16::from(working.is_some())),
                Constraint::Length(input_height),
                Constraint::Length(2),
            ])
            .split(area);
        self.draw_header(frame, rows[0], app);
        if app.context_open() {
            self.draw_context(frame, rows[1], app);
        } else if app.resource_preview().is_some() || app.detail_preview().is_some() {
            self.draw_resource(frame, rows[1], app);
        } else if app.tasks_open() {
            self.draw_todo(frame, rows[1], app);
        } else {
            self.draw_projection(frame, rows[1], app);
        }
        if !decision.is_empty() {
            frame.render_widget(
                Paragraph::new(multiline_text(decision))
                    .block(
                        Block::default()
                            .borders(Borders::LEFT)
                            .border_style(Style::default().fg(Color::Yellow)),
                    )
                    .wrap(Wrap { trim: false }),
                rows[2],
            );
        }
        if let Some(working) = working {
            frame.render_widget(
                Paragraph::new(clipped(&working, rows[3].width))
                    .style(Style::default().fg(Color::Cyan)),
                rows[3],
            );
        }
        self.draw_input(frame, rows[4], app);
        if app.plugin_picker_open() {
            self.draw_plugin_picker(frame, rows[1], app);
        }
        self.draw_footer(frame, rows[5], app);
    }

    pub fn render_plain(&self, app: &TuiApp) -> String {
        let mut output = String::from("DeepCode TUI\n");
        output.push_str("────────────────────────────────────────\n");
        if let Some(projection) = app.projection() {
            output.push_str(&format!(
                "session={} revision={}\n",
                projection.session_id, projection.revision
            ));
            for binding in &projection.session_directory_indexes {
                output.push_str(&format!(
                    "目录索引 {} ({})\n",
                    binding.display_name, binding.workspace_id
                ));
            }
            if app.context_open() {
                render_context_plain(&mut output, projection);
            }
            let items = timeline_items(projection);
            let last_by_run: std::collections::HashMap<_, _> = items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| item.run_id().map(|run| (run.to_string(), index)))
                .collect();
            for (index, item) in items.into_iter().enumerate() {
                let last_run = item
                    .run_id()
                    .filter(|run| last_by_run.get(*run) == Some(&index))
                    .map(str::to_string);
                match item {
                    TimelineItem::Message { value: message, .. } => {
                        output.push_str(&format!("{}: {}\n", message.role, message.content));
                        if !message.filesystem_references.is_empty() {
                            output.push_str(&format!(
                                "  文件系统引用：{}\n",
                                message
                                    .filesystem_references
                                    .iter()
                                    .map(|reference| reference.display_name.as_str())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ));
                        }
                    }
                    TimelineItem::Narrative {
                        value: narrative, ..
                    } => {
                        output.push_str(&format!("{}\n", narrative.content));
                    }
                    TimelineItem::Plan { value: plan, .. } => {
                        render_timeline_plan_plain(&mut output, plan);
                    }
                    TimelineItem::ToolGroup { activities, .. } => {
                        for activity in activities {
                            render_tool_plain(&mut output, activity);
                        }
                    }
                }
                if let Some(run) = last_run {
                    for line in round_change_lines(projection, &run) {
                        output.push_str(&line);
                        output.push('\n');
                    }
                }
            }
            if let Some(draft) = visible_assistant_draft(projection) {
                if let Some(preview) = draft.plan_preview.as_ref() {
                    output.push_str(&format!(
                        "正在生成计划 · {}\n{}\n",
                        preview.title, preview.summary
                    ));
                    for (index, title) in preview.steps.iter().enumerate() {
                        output.push_str(&format!("{}. {title}\n", index + 1));
                    }
                    output.push_str("生成完成后统一确认\n");
                }
                for block in &draft.blocks {
                    if let Some((_, content)) = block.text() {
                        output.push_str(content);
                        output.push_str("▋\n");
                    }
                }
            }
            for input in &projection.queued_inputs {
                for line in queued_input_lines(input) {
                    output.push_str(&line);
                    output.push('\n');
                }
            }
            if let Some(plan) = projection.pending_plan.as_ref() {
                render_plan_plain(&mut output, plan);
            }
            if let Some(interaction) = projection.pending_interaction.as_ref() {
                output.push_str(&format!(
                    "需要你回答（/reply <内容>）：{}\n",
                    interaction.prompt
                ));
                if let Some(options) = interaction.options.as_ref() {
                    for (index, option) in options.iter().enumerate() {
                        output.push_str(&format!("  {}. {}\n", index + 1, option.label));
                    }
                }
            }
            if let Some(approval) = projection.pending_approval.as_ref() {
                output.push_str(&format!(
                    "需要你批准（/reply 1 或 /reply 2）：{}\n",
                    approval.preview.summary
                ));
                if approval.preview.authorization_scope.as_deref() == Some("sessionBrowser") {
                    output.push_str("允许后，当前对话内的浏览器页面操作无需重复确认。\n");
                }
                if approval.preview.authorization_scope.as_deref() == Some("runHostShell") {
                    output.push_str("/reply 3 允许本轮相同工作目录和执行环境的宿主 Shell。\n");
                }
                for target in &approval.preview.logical_targets {
                    output.push_str(&format!("  - {target}\n"));
                }
                output.push_str("输入 /reply 1 允许或 /reply 2 拒绝。\n");
            }
            for activity in projection
                .activities
                .iter()
                .filter(|activity| activity.kind != "tool")
            {
                output.push_str(&format!(
                    "{} [{}]: {}\n",
                    activity.kind, activity.status, activity.label
                ));
            }
            render_todo_plain(&mut output, projection);
            if !app.context_open() {
                output.push_str(&format!("总缓存命中 {}\n", cache_hit_label(projection)));
            }
            output.push_str(&format!("{}\n", run_label(Some(projection))));
            if projection.terminal_error.is_some() {
                output.push_str(&failure_details(Some(projection)));
                output.push('\n');
            }
        } else {
            output.push_str("Session 尚未初始化。\n");
        }
        let selected_plugins = app.selected_plugin_labels();
        if !selected_plugins.is_empty() {
            output.push_str(&format!(
                "下一次请求插件：{}\n",
                selected_plugins.join(", ")
            ));
        }
        if app.plugin_picker_open() {
            output.push_str("插件候选：\n");
            for entry in app.plugin_picker_entries() {
                output.push_str(&format!(
                    "  {} {} · {} ({})\n",
                    if entry.highlighted { ">" } else { " " },
                    entry.display_name,
                    entry.short_description,
                    entry.uri,
                ));
            }
        }
        output.push_str("────────────────────────────────────────\n");
        if let Some(detail) = app.detail_preview() {
            output.push_str(detail);
            output.push('\n');
        }
        if let Some(resource) = app.resource_preview() {
            output.push_str(&resource.content);
            if resource.truncated {
                output.push_str("\n部分内容；/next 续读。\n");
            }
        }
        if app.reasoning_enabled() {
            if let Some(draft) = app
                .projection()
                .and_then(|projection| projection.assistant_draft.as_ref())
            {
                output.push_str(&format!("查看推理：/reasoning {}\n", draft.turn_id));
            }
        }
        output.push_str(app.status());
        output.push('\n');
        output
    }

    fn draw_header(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let projection = app.projection();
        let model = projection
            .and_then(|p| {
                p.run
                    .as_ref()
                    .map(|run| run.profile_id.as_str())
                    .or_else(|| {
                        p.model_settings
                            .as_ref()
                            .map(|settings| settings.profile_id.as_str())
                    })
            })
            .unwrap_or("");
        let effort = projection.and_then(|p| {
            p.run
                .as_ref()
                .and_then(|run| run.reasoning_effort.as_deref())
                .or_else(|| {
                    p.model_settings
                        .as_ref()
                        .and_then(|settings| settings.reasoning_effort_override.as_deref())
                })
        });
        let model = format!(
            "{model}{}",
            effort
                .map(|value| format!(" · {value}"))
                .unwrap_or_default()
        );
        let status = run_label(projection);
        let left = format!("DeepCode  ·  {status}");
        let available = area
            .width
            .saturating_sub(Line::from(left.as_str()).width() as u16 + 2);
        let right = clipped(&model, available);
        let gap = usize::from(area.width)
            .saturating_sub(Line::from(left.as_str()).width() + Line::from(right.as_str()).width());
        let workspace = projection
            .map(|p| {
                p.session_directory_indexes
                    .iter()
                    .map(|binding| binding.display_name.as_str())
                    .collect::<Vec<_>>()
                    .join(" · ")
            })
            .unwrap_or_default();
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(vec![
                    Span::styled(
                        left,
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(" ".repeat(gap)),
                    Span::raw(right),
                ]),
                Line::from(Span::styled(
                    clipped(&workspace, area.width),
                    Style::default().fg(Color::DarkGray),
                )),
            ]),
            area,
        );
    }

    fn draw_footer(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let mut metrics = Vec::new();
        if let Some(projection) = app.projection() {
            if let Some(usage) = projection.context_usage.as_ref() {
                metrics.push(format!(
                    "上下文 {}",
                    percent_label(
                        usage.input_tokens.saturating_add(usage.output_tokens),
                        usage.context_window_tokens
                    )
                ));
            }
            metrics.push(format!(
                "输入 {} · 输出 {}",
                format_number(projection.token_usage.input_tokens),
                format_number(projection.token_usage.output_tokens)
            ));
            if projection.token_usage.cache_available {
                metrics.push(format!("总缓存命中 {}", cache_hit_label(projection)));
            }
        }
        let metrics = metrics.join(" · ");
        let hint = if area.width >= 84 {
            "  /help · @ 插件 · PgUp/PgDn / 滚轮"
        } else {
            "  /help"
        };
        let metrics = clipped(&format!("{metrics}{hint}"), area.width);
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(metrics),
                Line::from(clipped(app.status(), area.width)),
            ])
            .style(Style::default().fg(Color::DarkGray)),
            area,
        );
    }

    fn draw_todo(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let mut lines = Vec::new();
        if let Some(todo) = app
            .projection()
            .and_then(|projection| projection.todo_list.as_ref())
        {
            if todo.items.is_empty() {
                lines.push(Line::from(Span::styled(
                    "暂无任务",
                    Style::default().fg(Color::DarkGray),
                )));
            } else {
                for item in &todo.items {
                    let (marker, color) = match item.status.as_str() {
                        "completed" => ("✓", Color::Green),
                        "inProgress" => ("●", Color::Cyan),
                        _ => ("○", Color::DarkGray),
                    };
                    lines.push(Line::from(vec![
                        Span::styled(format!("{marker} "), Style::default().fg(color)),
                        Span::raw(item.label.as_str()),
                    ]));
                }
            }
        } else {
            lines.push(Line::from(Span::styled(
                "本对话暂无任务",
                Style::default().fg(Color::DarkGray),
            )));
        }
        frame.render_widget(
            Paragraph::new(lines)
                .wrap(Wrap { trim: false })
                .scroll((app.detail_scroll(), 0))
                .block(
                    Block::default()
                        .borders(Borders::TOP)
                        .title(" 任务 · /close 返回 "),
                ),
            area,
        );
    }

    fn draw_resource(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        if let Some(detail) = app.detail_preview() {
            frame.render_widget(
                Paragraph::new(detail)
                    .scroll((app.detail_scroll(), 0))
                    .wrap(Wrap { trim: false })
                    .block(
                        Block::default()
                            .borders(Borders::ALL)
                            .title(" 按需详情 · /close "),
                    ),
                area,
            );
            return;
        }
        let Some(resource) = app.resource_preview() else {
            return;
        };
        frame.render_widget(
            Paragraph::new(resource.content.as_str())
                .scroll((app.detail_scroll(), 0))
                .wrap(Wrap { trim: false })
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title(format!(" {} · read only · /close ", resource.logical_path)),
                ),
            area,
        );
    }

    fn draw_context(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let width = usize::from(area.width.saturating_sub(4)).max(1);
        frame.render_widget(
            Paragraph::new(context_lines(app.projection(), width))
                .wrap(Wrap { trim: false })
                .scroll((app.detail_scroll(), 0))
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title(" Context · /context "),
                ),
            area,
        );
    }

    fn draw_projection(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let body = Rect {
            width: area.width.saturating_sub(1),
            ..area
        };
        let key = TranscriptKey {
            session: app
                .projection()
                .map(|projection| (projection.session_id.clone(), projection.revision)),
            // Drafts and tool output are live overlays; they need not advance journal revision.
            draft: app
                .projection()
                .and_then(|projection| projection.assistant_draft.clone()),
            live_output: app
                .projection()
                .into_iter()
                .flat_map(|projection| &projection.activities)
                .filter_map(|activity| {
                    activity
                        .live_output
                        .clone()
                        .map(|output| (activity.activity_id.clone(), output))
                })
                .collect(),
            reasoning: app.reasoning_enabled(),
            width: body.width,
            height: body.height,
        };
        let mut cache = self.transcript.borrow_mut();
        if cache.as_ref().is_none_or(|cache| cache.key != key) {
            *cache = Some(TranscriptCache {
                key,
                text: self.transcript_text(body, app),
            });
        }
        let paragraph =
            Paragraph::new(cache.as_ref().unwrap().text.clone()).wrap(Wrap { trim: false });
        let height = paragraph.line_count(body.width);
        let maximum = height.saturating_sub(usize::from(body.height));
        let offset = app.transcript_offset(maximum);
        frame.render_widget(
            paragraph.scroll((offset.min(u16::MAX as usize) as u16, 0)),
            body,
        );
        if maximum > 0 {
            frame.render_stateful_widget(
                Scrollbar::default()
                    .begin_symbol(None)
                    .end_symbol(None)
                    .track_symbol(Some("│"))
                    .thumb_symbol("┃")
                    .track_style(Style::default().fg(Color::DarkGray))
                    .thumb_style(Style::default().fg(Color::Gray)),
                area,
                &mut ScrollbarState::new(maximum + 1).position(offset),
            );
        }
    }

    fn transcript_text(&self, area: Rect, app: &TuiApp) -> Text<'static> {
        let mut lines = Vec::new();
        if let Some(projection) = app.projection() {
            let items = timeline_items(projection);
            let last_by_run: std::collections::HashMap<_, _> = items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| item.run_id().map(|run| (run.to_string(), index)))
                .collect();
            for (index, item) in items.into_iter().enumerate() {
                let last_run = item
                    .run_id()
                    .filter(|run| last_by_run.get(*run) == Some(&index))
                    .map(str::to_string);
                match item {
                    TimelineItem::Message { value: message, .. } => {
                        let color = if message.role == "user" {
                            Color::Blue
                        } else if message.role == "assistant" {
                            Color::Reset
                        } else {
                            Color::DarkGray
                        };
                        let role = match message.role.as_str() {
                            "user" => "你",
                            "assistant" => "DeepCode",
                            other => other,
                        };
                        lines.push(Line::from(Span::styled(
                            role.to_string(),
                            Style::default().fg(color).add_modifier(Modifier::BOLD),
                        )));
                        if message.role == "assistant" {
                            lines.extend(crate::markdown::render(
                                &message.content,
                                area.width,
                                Style::default(),
                            ));
                        } else {
                            lines.extend(Text::raw(message.content.clone()).lines);
                        }
                        if !message.filesystem_references.is_empty() {
                            lines.push(Line::from(Span::styled(
                                format!(
                                    "  文件系统引用：{}",
                                    message
                                        .filesystem_references
                                        .iter()
                                        .map(|reference| reference.display_name.as_str())
                                        .collect::<Vec<_>>()
                                        .join(", ")
                                ),
                                Style::default().fg(Color::DarkGray),
                            )));
                        }
                    }
                    TimelineItem::Narrative {
                        value: narrative, ..
                    } => {
                        lines.extend(crate::markdown::render(
                            &narrative.content,
                            area.width,
                            Style::default().fg(Color::Gray),
                        ));
                    }
                    TimelineItem::Plan { value: plan, .. } => {
                        push_timeline_plan_lines(&mut lines, plan);
                    }
                    TimelineItem::ToolGroup { activities, .. } => {
                        for activity in activities {
                            push_tool_summary(&mut lines, activity);
                        }
                    }
                }
                if let Some(run) = last_run {
                    lines.extend(
                        round_change_lines(projection, &run)
                            .into_iter()
                            .map(Line::from),
                    );
                }
                lines.push(Line::from(""));
            }
            for input in &projection.queued_inputs {
                lines.extend(
                    queued_input_lines(input)
                        .into_iter()
                        .flat_map(|line| Text::raw(line).lines),
                );
            }
            if app.reasoning_enabled() {
                if let Some(draft) = projection.assistant_draft.as_ref() {
                    lines.push(Line::from(format!(
                        "推理详情：/reasoning {}",
                        draft.turn_id
                    )));
                }
            }
            if let Some(draft) = visible_assistant_draft(projection) {
                if let Some(preview) = draft.plan_preview.as_ref() {
                    lines.push(Line::from(format!("正在生成计划 · {}", preview.title)));
                    lines.extend(Text::raw(preview.summary.clone()).lines);
                    for (index, title) in preview.steps.iter().enumerate() {
                        lines.push(Line::from(format!("{}. {title}", index + 1)));
                    }
                    lines.push(Line::from("生成完成后统一确认"));
                }
                for block in &draft.blocks {
                    if let Some((_, content)) = block.text() {
                        lines.extend(crate::markdown::render(
                            content,
                            area.width,
                            Style::default(),
                        ));
                        lines.push(Line::from(Span::styled(
                            "▋",
                            Style::default().fg(Color::Cyan),
                        )));
                        lines.push(Line::from(""));
                    }
                }
            }
            for activity in projection.activities.iter().filter(|activity| {
                activity.kind != "tool"
                    && !(activity.kind == "run"
                        && matches!(
                            activity.status.as_str(),
                            "requested" | "active" | "completed"
                        ))
            }) {
                lines.push(Line::from(Span::styled(
                    format!(
                        "{} [{}] · {}",
                        activity.kind, activity.status, activity.label
                    ),
                    Style::default().fg(if activity.status == "completed" {
                        Color::Green
                    } else if matches!(activity.status.as_str(), "failed" | "indeterminate") {
                        Color::Red
                    } else {
                        Color::Yellow
                    }),
                )));
            }
        }
        if let Some(error) = app.projection().and_then(|p| p.terminal_error.as_ref()) {
            lines.push(Line::from(Span::styled(
                format!("{}: {}", error.code, error.message),
                Style::default().fg(Color::Red),
            )));
            lines.push(Line::from(Span::styled(
                "/error 查看诊断和失败快照",
                Style::default().fg(Color::DarkGray),
            )));
        }
        if lines.is_empty() {
            let logo = if area.width >= 62 && area.height >= 14 {
                vec![
                    r"  ____                  ____          _",
                    r" |  _ \  ___  ___ _ __ / ___|___   __| | ___",
                    r" | | | |/ _ \/ _ \ '_ \ |   / _ \ / _` |/ _ \",
                    r" | |_| |  __/  __/ |_) | |__| (_) | (_| |  __/",
                    r" |____/ \___|\___| .__/ \____\___/ \__,_|\___|",
                    r"                |_|",
                ]
            } else {
                vec!["", "  DeepCode", ""]
            };
            lines.extend(
                logo.into_iter()
                    .map(|line| Line::from(Span::styled(line, Style::default().fg(Color::Cyan)))),
            );
            lines.push(Line::from(""));
            lines.push(Line::from("  输入消息开始工作，或使用 @ 选择插件。"));
            lines.push(Line::from(Span::styled(
                "  /help 帮助 · /tasks 任务 · /context 上下文",
                Style::default().fg(Color::DarkGray),
            )));
        }
        multiline_text(lines)
    }

    fn draw_input(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let selected_plugins = app.selected_plugin_labels();
        let mut title = " 输入消息".to_string();
        if let Some(profile) = app.next_message_profile() {
            title.push_str(&format!(" · 下次 {profile}"));
        }
        if selected_plugins.is_empty() {
            title.push_str(" · @ 插件 ");
        } else {
            title.push_str(&format!(" · 插件 {} ", selected_plugins.join(", ")));
        }
        let title = clipped(&title, area.width.saturating_sub(2));
        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .title(title)
            .border_style(Style::default().fg(Color::DarkGray));
        let inner = block.inner(area).inner(Margin::new(1, 0));
        frame.render_widget(block, area);
        if inner.width == 0 || inner.height == 0 {
            return;
        }
        let lines = input_lines(app.input(), inner.width);
        let column = lines
            .last()
            .map(|line| line.width().saturating_sub(1))
            .unwrap_or(0) as u16;
        let start = lines.len().saturating_sub(usize::from(inner.height));
        let row = lines.len().saturating_sub(start + 1) as u16;
        frame.render_widget(
            Paragraph::new(lines.into_iter().skip(start).collect::<Vec<_>>()),
            inner,
        );
        frame.set_cursor_position((inner.x + column.min(inner.width - 1), inner.y + row));
    }

    fn draw_plugin_picker(&self, frame: &mut Frame<'_>, anchor: Rect, app: &TuiApp) {
        let entries = app.plugin_picker_entries();
        let content_height = entries.len().saturating_mul(2).max(1);
        let height = u16::try_from(content_height.saturating_add(2))
            .unwrap_or(anchor.height)
            .min(anchor.height.max(1));
        let area = Rect {
            x: anchor.x,
            y: anchor
                .y
                .saturating_add(anchor.height.saturating_sub(height)),
            width: anchor.width,
            height,
        };
        let mut lines = Vec::new();
        if entries.is_empty() {
            lines.push(Line::from(Span::styled(
                "没有匹配的可用插件",
                Style::default().fg(Color::DarkGray),
            )));
        } else {
            for entry in entries {
                let marker = if entry.highlighted { ">" } else { " " };
                let selected = if entry.already_selected {
                    " · selected"
                } else {
                    ""
                };
                let style = if entry.highlighted {
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::Reset)
                };
                lines.push(Line::from(Span::styled(
                    format!("{marker} {}{selected}", entry.display_name),
                    style,
                )));
                lines.push(Line::from(Span::styled(
                    format!("  {} · {}", entry.short_description, entry.uri),
                    Style::default().fg(Color::DarkGray),
                )));
            }
        }
        let title = app
            .plugin_picker_query()
            .filter(|query| !query.is_empty())
            .map(|query| format!(" Plugins · @{query} · Enter/Tab select · Esc close "))
            .unwrap_or_else(|| " Plugins · Enter/Tab select · Esc close ".to_string());
        frame.render_widget(Clear, area);
        frame.render_widget(
            Paragraph::new(lines)
                .wrap(Wrap { trim: false })
                .block(Block::default().borders(Borders::ALL).title(title)),
            area,
        );
    }
}

const CONTEXT_PARTITIONS: [(&str, &str); 7] = [
    ("instructions", "系统与会话指令"),
    ("sessionControls", "Session 控制接口"),
    ("tools", "工具目录"),
    ("workspaceBindings", "目录索引"),
    ("contextProviders", "上下文提供项"),
    ("journalMessages", "对话消息"),
    ("filesystemReferences", "文件系统引用"),
];

fn context_lines(projection: Option<&SessionProjection>, bar_width: usize) -> Vec<Line<'static>> {
    let Some(projection) = projection else {
        return vec![Line::from(Span::styled(
            "Context N/A",
            Style::default().fg(Color::DarkGray),
        ))];
    };
    let mut lines = Vec::new();
    if let Some(usage) = projection.context_usage.as_ref() {
        let used = usage.input_tokens.saturating_add(usage.output_tokens);
        lines.push(Line::from(vec![
            Span::styled(
                "Context ",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(format!(
                "{} / {} Token · {}",
                format_number(used),
                format_number(usage.context_window_tokens),
                percent_label(used, usage.context_window_tokens),
            )),
        ]));
        lines.push(context_usage_bar(usage, bar_width));
        lines.push(context_usage_legend(usage));
    } else {
        lines.push(Line::from(Span::styled(
            "Context N/A",
            Style::default().fg(Color::DarkGray),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled(
            "总缓存命中 ",
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(cache_detail_label(&projection.token_usage)),
    ]));
    let (detail, ratio) = last_request_cache_summary(projection.context_usage.as_ref());
    lines.push(Line::from(vec![
        Span::styled("最近一次请求 · 输入缓存 ", Style::default().fg(Color::Cyan)),
        Span::raw(detail),
    ]));
    lines.push(cache_bar(ratio, bar_width));

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "Request",
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    )));
    let Some(receipt) = current_context_receipt(projection) else {
        lines.push(Line::from(Span::styled(
            "N/A",
            Style::default().fg(Color::DarkGray),
        )));
        return lines;
    };
    let metrics = context_partition_metrics(receipt);
    for ((_, label), metric) in CONTEXT_PARTITIONS.iter().zip(metrics) {
        let token_label = partition_token_label(metric);
        lines.push(Line::from(vec![
            Span::styled("▪ ", Style::default().fg(partition_color(label))),
            Span::raw(format!("{label} · {} 项 · ", metric.item_count)),
            if metric.estimated_input_tokens.is_some() {
                Span::raw(token_label)
            } else {
                Span::styled(token_label, Style::default().fg(Color::DarkGray))
            },
        ]));
    }
    lines
}

fn context_usage_bar(usage: &ContextUsageProjection, width: usize) -> Line<'static> {
    let total = usage.context_window_tokens;
    if total == 0 {
        return Line::from(Span::styled("N/A", Style::default().fg(Color::DarkGray)));
    }
    let input = usage.input_tokens.min(total);
    let output = usage.output_tokens.min(total.saturating_sub(input));
    let free = total.saturating_sub(input.saturating_add(output));
    let (input_width, output_width, free_width) = segment_widths(input, output, free, width);
    Line::from(vec![
        Span::styled("█".repeat(input_width), Style::default().fg(Color::Green)),
        Span::styled("█".repeat(output_width), Style::default().fg(Color::Yellow)),
        Span::styled("░".repeat(free_width), Style::default().fg(Color::DarkGray)),
    ])
}

fn context_usage_legend(usage: &ContextUsageProjection) -> Line<'static> {
    let used = usage.input_tokens.saturating_add(usage.output_tokens);
    let free = usage.context_window_tokens.saturating_sub(used);
    Line::from(vec![
        Span::styled("input ", Style::default().fg(Color::Green)),
        Span::raw(format_number(usage.input_tokens)),
        Span::styled(" · output ", Style::default().fg(Color::Yellow)),
        Span::raw(format_number(usage.output_tokens)),
        Span::styled(" · free ", Style::default().fg(Color::DarkGray)),
        Span::raw(format_number(free)),
    ])
}

fn cache_bar(cache_hit_ratio: Option<f64>, width: usize) -> Line<'static> {
    let Some(cache_hit_ratio) = cache_hit_ratio else {
        return Line::from(Span::styled("N/A", Style::default().fg(Color::DarkGray)));
    };
    let hit_width = (cache_hit_ratio * width as f64).round() as usize;
    let hit_width = hit_width.min(width);
    let miss_width = width.saturating_sub(hit_width);
    Line::from(vec![
        Span::styled("█".repeat(hit_width), Style::default().fg(Color::Green)),
        Span::styled("█".repeat(miss_width), Style::default().fg(Color::Yellow)),
    ])
}

fn segment_widths(input: u64, output: u64, free: u64, width: usize) -> (usize, usize, usize) {
    let total = input.saturating_add(output).saturating_add(free);
    if total == 0 {
        return (0, 0, width);
    }
    let input_width = scaled_width(input, total, width).min(width);
    let output_width = scaled_width(output, total, width).min(width.saturating_sub(input_width));
    let free_width = width.saturating_sub(input_width.saturating_add(output_width));
    (input_width, output_width, free_width)
}

fn scaled_width(value: u64, total: u64, width: usize) -> usize {
    if total == 0 || width == 0 {
        return 0;
    }
    let numerator = u128::from(value)
        .saturating_mul(width as u128)
        .saturating_add(u128::from(total / 2));
    usize::try_from(numerator / u128::from(total)).unwrap_or(width)
}

fn current_context_receipt(
    projection: &SessionProjection,
) -> Option<&ContextCompositionProjection> {
    if let Some(usage) = projection.context_usage.as_ref() {
        return projection
            .context_compositions
            .iter()
            .rev()
            .find(|receipt| {
                receipt.purpose == "agent"
                    && receipt.provider_request_id == usage.provider_request_id
            });
    }
    projection
        .context_compositions
        .iter()
        .rev()
        .find(|receipt| receipt.purpose == "agent")
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ContextPartitionMetric {
    item_count: u64,
    estimated_input_tokens: Option<u64>,
}

fn context_partition_metrics(
    receipt: &ContextCompositionProjection,
) -> [ContextPartitionMetric; 7] {
    let mut metrics = [ContextPartitionMetric::default(); 7];
    for partition in &receipt.partitions {
        if let Some(index) = partition_index(&partition.kind) {
            metrics[index] = ContextPartitionMetric {
                item_count: partition.item_count,
                estimated_input_tokens: (partition.token_source.as_deref()
                    == Some("sessionEstimated"))
                .then_some(partition.estimated_input_tokens)
                .flatten(),
            };
        }
    }
    metrics
}

fn partition_token_label(metric: ContextPartitionMetric) -> String {
    metric
        .estimated_input_tokens
        .map(|tokens| format!("≈{} Token", format_number(tokens)))
        .unwrap_or_else(|| "N/A Token".to_string())
}

fn partition_index(kind: &str) -> Option<usize> {
    CONTEXT_PARTITIONS
        .iter()
        .position(|(candidate, _)| *candidate == kind)
}

fn partition_color(label: &str) -> Color {
    match label {
        "工具目录" | "消息附件" => Color::Yellow,
        "目录索引" => Color::Blue,
        "上下文提供项" | "对话消息" => Color::Green,
        _ => Color::DarkGray,
    }
}

fn percent_label(value: u64, total: u64) -> String {
    if total == 0 {
        return "N/A".to_string();
    }
    format!("{:.1}%", value as f64 * 100.0 / total as f64)
}

fn format_number(value: u64) -> String {
    let digits = value.to_string();
    let mut output = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            output.push(',');
        }
        output.push(digit);
    }
    output
}

fn render_context_plain(output: &mut String, projection: &SessionProjection) {
    if let Some(usage) = projection.context_usage.as_ref() {
        let used = usage.input_tokens.saturating_add(usage.output_tokens);
        output.push_str(&format!(
            "Context {} / {} Token · {}\n",
            format_number(used),
            format_number(usage.context_window_tokens),
            percent_label(used, usage.context_window_tokens),
        ));
        output.push_str(&plain_usage_bar(usage, 40));
        output.push('\n');
    } else {
        output.push_str("Context N/A\n");
    }
    output.push_str(&format!(
        "总缓存命中 {}\n",
        cache_detail_label(&projection.token_usage)
    ));
    let (detail, _) = last_request_cache_summary(projection.context_usage.as_ref());
    output.push_str(&format!("最近一次请求 · 输入缓存 {detail}\n"));
    output.push_str("Request\n");
    if let Some(receipt) = current_context_receipt(projection) {
        let metrics = context_partition_metrics(receipt);
        for ((_, label), metric) in CONTEXT_PARTITIONS.iter().zip(metrics) {
            output.push_str(&format!(
                "  {label} · {} 项 · {}\n",
                metric.item_count,
                partition_token_label(metric),
            ));
        }
    } else {
        output.push_str("  N/A\n");
    }
}

fn plain_usage_bar(usage: &ContextUsageProjection, width: usize) -> String {
    let total = usage.context_window_tokens;
    if total == 0 {
        return "[N/A]".to_string();
    }
    let input = usage.input_tokens.min(total);
    let output = usage.output_tokens.min(total.saturating_sub(input));
    let free = total.saturating_sub(input.saturating_add(output));
    let (input_width, output_width, free_width) = segment_widths(input, output, free, width);
    format!(
        "[{}{}{}]",
        "I".repeat(input_width),
        "O".repeat(output_width),
        "·".repeat(free_width),
    )
}

enum TimelineItem<'a> {
    Message {
        value: &'a ProjectionMessage,
    },
    Narrative {
        value: &'a NarrativeProjection,
    },
    Plan {
        value: &'a PlanProjection,
    },
    ToolGroup {
        activities: Vec<&'a ActivityProjection>,
    },
}

impl TimelineItem<'_> {
    fn run_id(&self) -> Option<&str> {
        match self {
            Self::Message { value } => value.run_id.as_deref(),
            Self::Narrative { value } => Some(&value.run_id),
            Self::Plan { value } => Some(&value.run_id),
            Self::ToolGroup { activities } => {
                activities.first().map(|activity| activity.run_id.as_str())
            }
        }
    }
}

fn round_change_lines(projection: &SessionProjection, run_id: &str) -> Vec<String> {
    let changes = projection.file_changes_for_run(run_id);
    if changes.is_empty() {
        return Vec::new();
    }
    let mut lines = vec![format!("本轮修改 · {run_id}")];
    lines.extend(changes.into_iter().map(|(record, index, change)| {
        format!(
            "  {} {} · /diff {} {}",
            change.kind, change.path, record, index
        )
    }));
    lines
}

fn timeline_items(projection: &SessionProjection) -> Vec<TimelineItem<'_>> {
    projection
        .timeline
        .iter()
        .map(|item| match item {
            SessionTimelineItem::Message { message_id, .. } => TimelineItem::Message {
                value: projection
                    .messages
                    .iter()
                    .find(|message| message.message_id == *message_id)
                    .expect("validated Session timeline message reference"),
            },
            SessionTimelineItem::Narrative { narrative_id, .. } => TimelineItem::Narrative {
                value: projection
                    .narratives
                    .iter()
                    .find(|narrative| narrative.narrative_id == *narrative_id)
                    .expect("validated Session timeline narrative reference"),
            },
            SessionTimelineItem::Plan {
                plan_id, revision, ..
            } => TimelineItem::Plan {
                value: projection
                    .plans
                    .iter()
                    .find(|plan| plan.plan_id == *plan_id && plan.revision == *revision)
                    .expect("validated Session timeline plan reference"),
            },
            SessionTimelineItem::ToolGroup { activity_ids, .. } => TimelineItem::ToolGroup {
                activities: activity_ids
                    .iter()
                    .map(|activity_id| {
                        projection
                            .activities
                            .iter()
                            .find(|activity| activity.activity_id == *activity_id)
                            .expect("validated Session timeline activity reference")
                    })
                    .collect(),
            },
        })
        .collect()
}

fn queued_input_lines(input: &deepcode_kernel_client::QueuedInputProjection) -> Vec<String> {
    let status = if input.status == "queued" {
        "已排队"
    } else {
        "未执行"
    };
    let mut lines = vec![format!("{status}: {}", input.text)];
    lines.extend(
        input
            .filesystem_references
            .iter()
            .map(|reference| format!("  附件：{}", reference.display_name)),
    );
    lines
}

fn tool_error_lines(activity: &ActivityProjection) -> Vec<String> {
    let mut lines = Vec::new();
    for error in activity
        .interruption
        .iter()
        .chain(activity.tool.as_ref().and_then(|tool| tool.error.as_ref()))
    {
        lines.push(format!("  {}: {}", error.code, error.message));
    }
    if let Some(error) = &activity.input_rejection {
        lines.push(format!("  {}: {}", error.code, error.message));
        lines.extend(
            error
                .issues
                .iter()
                .map(|issue| format!("  {}: {}", issue.path, issue.message)),
        );
    }
    lines
}

fn push_tool_lines(lines: &mut Vec<Line<'_>>, activity: &ActivityProjection) {
    let operation = activity
        .tool
        .as_ref()
        .map(|tool| tool.operation.as_str())
        .unwrap_or(activity.label.as_str());
    let color = activity_color(&activity.status);
    lines.push(Line::from(Span::styled(
        format!("工具 {operation} [{}]", activity.status),
        Style::default().fg(color),
    )));
    for error in tool_error_lines(activity) {
        lines.push(Line::from(Span::styled(
            error,
            Style::default().fg(Color::Red),
        )));
    }
    for detail in tool_progress_details(activity) {
        lines.push(Line::from(Span::styled(
            detail,
            Style::default().fg(Color::DarkGray),
        )));
    }
    if let Some(output) = activity.live_output.as_ref() {
        push_tool_stream_lines(lines, "stdout", &output.stdout);
        push_tool_stream_lines(lines, "stderr", &output.stderr);
    }
    if let Some(tool) = activity.tool.as_ref() {
        if let Some(shell) = tool.shell.as_ref() {
            lines.push(Line::from(Span::styled(
                format!("  $ {}", shell.command),
                Style::default().fg(Color::Gray),
            )));
            lines.push(Line::from(Span::styled(
                format!("  cwd: {}", shell.cwd),
                Style::default().fg(Color::DarkGray),
            )));
            if let Some(result) = shell.result.as_ref() {
                lines.push(Line::from(Span::styled(
                    format!(
                        "  environment: shell={} · interactive={} · pathSource={} · writeScope={} · homeWritable={}",
                        result.environment.shell,
                        result.environment.interactive,
                        result.environment.path_source,
                        result.environment.write_scope,
                        result.environment.home_writable,
                    ),
                    Style::default().fg(Color::DarkGray),
                )));
                let exit = result
                    .exit_code
                    .map_or_else(|| "signal/timeout".to_string(), |code| code.to_string());
                lines.push(Line::from(Span::styled(
                    format!(
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
                    ),
                    Style::default().fg(Color::DarkGray),
                )));
                push_tool_stream_lines(lines, "stdout", &result.stdout);
                push_tool_stream_lines(lines, "stderr", &result.stderr);
            }
        }
        for (index, change) in tool.file_changes.iter().enumerate() {
            if let Some(record) = &tool.record_id {
                lines.push(Line::from(format!(
                    "  {} {} · /diff {} {}",
                    change.kind, change.path, record, index
                )));
            }
        }
        for resource in &tool.resources {
            let detail = match (
                resource.kind.as_str(),
                resource.workspace_id.as_deref(),
                resource.logical_path.as_deref(),
                resource.uri.as_deref(),
            ) {
                ("workspacePath", Some(workspace_id), Some(logical_path), _) => format!(
                    "  {} · /open {} {}",
                    resource.label, workspace_id, logical_path
                ),
                ("url", _, _, Some(uri)) => format!("  {} · {uri}", resource.label),
                _ => format!("  {}", resource.label),
            };
            lines.push(Line::from(Span::styled(
                detail,
                Style::default().fg(Color::DarkGray),
            )));
        }
    }
}

fn push_timeline_plan_lines(lines: &mut Vec<Line<'_>>, plan: &PlanProjection) {
    lines.push(Line::from(Span::styled(
        format!("Plan · revision {} · {}", plan.revision, plan.status),
        Style::default().fg(Color::Cyan),
    )));
    lines.push(Line::from(Span::styled(
        plan.title.clone(),
        Style::default().add_modifier(Modifier::BOLD),
    )));
    lines.extend(Text::raw(plan.summary.clone()).lines);
    for (index, step) in plan.steps.iter().enumerate() {
        lines.push(Line::from(format!("{}. {}", index + 1, step.title)));
        lines.push(Line::from(format!("   {}", step.details)));
    }
}

fn push_tool_stream_lines(lines: &mut Vec<Line<'_>>, label: &str, output: &str) {
    if output.is_empty() {
        return;
    }
    lines.push(Line::from(Span::styled(
        format!("  {label}:"),
        Style::default().fg(Color::DarkGray),
    )));
    for line in output.lines() {
        lines.push(Line::from(Span::raw(format!("    {line}"))));
    }
}

fn render_tool_plain(output: &mut String, activity: &ActivityProjection) {
    let operation = activity
        .tool
        .as_ref()
        .map(|tool| tool.operation.as_str())
        .unwrap_or(activity.label.as_str());
    output.push_str(&format!("工具 {operation} [{}]\n", activity.status));
    for error in tool_error_lines(activity) {
        output.push_str(&error);
        output.push('\n');
    }
    for detail in tool_progress_details(activity) {
        output.push_str(&detail);
        output.push('\n');
    }
    if let Some(live) = activity.live_output.as_ref() {
        push_tool_stream_plain(output, "stdout", &live.stdout);
        push_tool_stream_plain(output, "stderr", &live.stderr);
    }
    if let Some(tool) = activity.tool.as_ref() {
        if let Some(shell) = tool.shell.as_ref() {
            output.push_str(&format!("  $ {}\n", shell.command));
            output.push_str(&format!("  cwd: {}\n", shell.cwd));
            if let Some(result) = shell.result.as_ref() {
                output.push_str(&format!(
                    "  environment: shell={} · interactive={} · pathSource={} · writeScope={} · homeWritable={}\n",
                    result.environment.shell,
                    result.environment.interactive,
                    result.environment.path_source,
                    result.environment.write_scope,
                    result.environment.home_writable,
                ));
                let exit = result
                    .exit_code
                    .map_or_else(|| "signal/timeout".to_string(), |code| code.to_string());
                output.push_str(&format!(
                    "  exit: {exit} · {} ms · {} bytes{}{}\n",
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
                ));
                push_tool_stream_plain(output, "stdout", &result.stdout);
                push_tool_stream_plain(output, "stderr", &result.stderr);
            }
        }
        for (index, change) in tool.file_changes.iter().enumerate() {
            if let Some(record) = &tool.record_id {
                output.push_str(&format!(
                    "  {} {} · /diff {} {}\n",
                    change.kind, change.path, record, index
                ));
            }
        }
        for resource in &tool.resources {
            match (
                resource.kind.as_str(),
                resource.workspace_id.as_deref(),
                resource.logical_path.as_deref(),
                resource.uri.as_deref(),
            ) {
                ("workspacePath", Some(workspace_id), Some(logical_path), _) => {
                    output.push_str(&format!(
                        "  {} · /open {} {}\n",
                        resource.label, workspace_id, logical_path
                    ))
                }
                ("url", _, _, Some(uri)) => {
                    output.push_str(&format!("  {} · {uri}\n", resource.label));
                }
                _ => output.push_str(&format!("  {}\n", resource.label)),
            }
        }
    }
}

fn push_tool_stream_plain(output: &mut String, label: &str, stream: &str) {
    if stream.is_empty() {
        return;
    }
    output.push_str(&format!("  {label}:\n"));
    for line in stream.lines() {
        output.push_str(&format!("    {line}\n"));
    }
}

fn tool_progress_details(activity: &ActivityProjection) -> Vec<String> {
    let mut lines = Vec::new();
    if activity.status == "active" {
        if let Some(elapsed) = activity.started_at.as_ref().and_then(|started| {
            let started = started.parse::<u128>().ok()?;
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis()
                .checked_sub(started)
        }) {
            lines.push(format!("  已执行 {:.1}s", elapsed as f64 / 1_000.0));
        }
        if let Some(output) = activity.live_output.as_ref() {
            lines.push(format!(
                "  实时输出 · stdout {} bytes · stderr {} bytes{}",
                output.stdout_bytes,
                output.stderr_bytes,
                if output.truncated {
                    " · 仅保留最新片段"
                } else {
                    ""
                }
            ));
        }
    }
    lines
}

fn render_todo_plain(output: &mut String, projection: &SessionProjection) {
    let Some(todo) = projection.todo_list.as_ref() else {
        return;
    };
    output.push_str("Todo\n");
    if todo.items.is_empty() {
        output.push_str("  （空）\n");
        return;
    }
    for item in &todo.items {
        let marker = match item.status.as_str() {
            "completed" => "[x]",
            "inProgress" => "[>]",
            _ => "[ ]",
        };
        output.push_str(&format!("  {marker} {}\n", item.label));
    }
}

fn activity_color(status: &str) -> Color {
    if status == "completed" {
        Color::Green
    } else if matches!(status, "failed" | "denied" | "indeterminate") {
        Color::Red
    } else {
        Color::Yellow
    }
}

fn cache_hit_label(projection: &SessionProjection) -> String {
    let usage = &projection.token_usage;
    if !usage.cache_available {
        return "--%".to_string();
    }
    usage
        .cache_hit_ratio
        .map(format_cache_percent)
        .unwrap_or_else(|| "--%".to_string())
}

fn format_cache_percent(ratio: f64) -> String {
    let rounded = (ratio * 100.0 * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}%")
    } else {
        format!("{rounded:.1}%")
    }
}

fn last_request_cache_summary(usage: Option<&ContextUsageProjection>) -> (String, Option<f64>) {
    let Some(usage) = usage else {
        return ("N/A".into(), None);
    };
    let (Some(hit), Some(miss)) = (usage.cache_read_input_tokens, usage.cache_miss_input_tokens)
    else {
        return (
            format!(
                "N/A · 输入 {} · 缓存用量未提供",
                format_number(usage.input_tokens)
            ),
            None,
        );
    };
    let ratio = (usage.input_tokens > 0).then(|| hit as f64 / usage.input_tokens as f64);
    (
        format!(
            "{} · 输入 {} · 命中 {} · 未命中 {}",
            ratio
                .map(format_cache_percent)
                .unwrap_or_else(|| "N/A".into()),
            format_number(usage.input_tokens),
            format_number(hit),
            format_number(miss)
        ),
        ratio,
    )
}

fn cache_detail_label(usage: &TokenUsageProjection) -> String {
    if !usage.cache_available {
        return format!(
            "N/A · reports {}/{} ({})",
            usage.reported_call_count,
            usage.provider_call_count,
            cache_coverage_label(usage)
        );
    }
    format!(
        "{} · hit {} · miss {} · reports {}/{} ({})",
        usage
            .cache_hit_ratio
            .map(format_cache_percent)
            .unwrap_or_else(|| "N/A".to_string()),
        format_number(usage.cache_read_input_tokens),
        format_number(usage.cache_miss_input_tokens),
        usage.reported_call_count,
        usage.provider_call_count,
        cache_coverage_label(usage),
    )
}

fn cache_coverage_label(usage: &TokenUsageProjection) -> &'static str {
    if usage.cache_complete {
        "complete"
    } else if usage.cache_available {
        "partial"
    } else {
        "unavailable"
    }
}

fn visible_assistant_draft(projection: &SessionProjection) -> Option<&AssistantDraftProjection> {
    projection.assistant_draft.as_ref()
}

fn render_plan_plain(output: &mut String, plan: &PendingPlanProjection) {
    output.push_str(&format!("Plan · revision {}\n", plan.revision));
    output.push_str(&format!("{}\n{}\n", plan.title, plan.summary));
    for (index, step) in plan.steps.iter().enumerate() {
        output.push_str(&format!("{}. {}\n", index + 1, step.title));
        output.push_str(&format!("   {}\n", step.details));
        if let Some(verification) = step.verification.as_ref() {
            for item in verification {
                output.push_str(&format!("   验证：{item}\n"));
            }
        }
    }
    output.push_str(
        "输入 /reply 1 确认；/reply <意见> 修订；普通消息排队；/cancel-plan 明确取消。\n",
    );
}

fn render_timeline_plan_plain(output: &mut String, plan: &PlanProjection) {
    output.push_str(&format!(
        "Plan · revision {} · {}\n",
        plan.revision, plan.status
    ));
    output.push_str(&format!("{}\n{}\n", plan.title, plan.summary));
    for (index, step) in plan.steps.iter().enumerate() {
        output.push_str(&format!("{}. {}\n", index + 1, step.title));
        output.push_str(&format!("   {}\n", step.details));
        if let Some(verification) = step.verification.as_ref() {
            for item in verification {
                output.push_str(&format!("   验证：{item}\n"));
            }
        }
    }
}
