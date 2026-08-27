use crate::app::TuiApp;
use deepcode_kernel_client::{
    ActivityProjection, NarrativeProjection, PendingPlanProjection, ProjectionMessage,
    SessionProjection,
};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    prelude::Frame,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};

#[derive(Clone, Default)]
pub struct Renderer;

impl Renderer {
    pub fn draw(&self, frame: &mut Frame<'_>, app: &TuiApp) {
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(2),
                Constraint::Min(8),
                Constraint::Length(4),
                Constraint::Length(1),
            ])
            .split(frame.area());
        self.draw_header(frame, rows[0], app);
        if app.resource_preview().is_some() {
            self.draw_resource(frame, rows[1], app);
        } else if rows[1].width >= 88 {
            let columns = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Min(42), Constraint::Length(32)])
                .split(rows[1]);
            self.draw_projection(frame, columns[0], app);
            self.draw_todo(frame, columns[1], app);
        } else {
            let content = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Min(6), Constraint::Length(8)])
                .split(rows[1]);
            self.draw_projection(frame, content[0], app);
            self.draw_todo(frame, content[1], app);
        }
        self.draw_input(frame, rows[2], app);
        frame.render_widget(
            Paragraph::new(app.status()).style(Style::default().fg(Color::DarkGray)),
            rows[3],
        );
    }

    pub fn render_plain(&self, app: &TuiApp) -> String {
        let mut output = String::from("DeepCode TUI · shared SessionProjection\n");
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
            for item in timeline_items(projection) {
                match item {
                    TimelineItem::Message(message) => {
                        output.push_str(&format!("{}: {}\n", message.role, message.content));
                        if !message.attachments.is_empty() {
                            output.push_str(&format!(
                                "  附件：{}\n",
                                message
                                    .attachments
                                    .iter()
                                    .map(|attachment| attachment.name.as_str())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ));
                        }
                    }
                    TimelineItem::Narrative(narrative) => {
                        output.push_str(&format!("{}\n", narrative.content));
                    }
                    TimelineItem::Tool(activity) => {
                        render_tool_plain(&mut output, activity);
                    }
                }
            }
            if let Some(draft) = projection.assistant_draft.as_ref() {
                output.push_str(&draft.content);
                output.push_str("▋\n");
            }
            if let Some(plan) = projection.pending_plan.as_ref() {
                render_plan_plain(&mut output, plan);
            }
            if let Some(interaction) = projection.pending_interaction.as_ref() {
                output.push_str(&format!("需要你回答：{}\n", interaction.prompt));
                if let Some(options) = interaction.options.as_ref() {
                    for (index, option) in options.iter().enumerate() {
                        output.push_str(&format!("  {}. {}\n", index + 1, option.label));
                    }
                }
            }
            if let Some(approval) = projection.pending_approval.as_ref() {
                output.push_str(&format!("需要你批准：{}\n", approval.preview.summary));
                for target in &approval.preview.logical_targets {
                    output.push_str(&format!("  - {target}\n"));
                }
                output.push_str("输入 1/允许 或 2/拒绝。\n");
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
            output.push_str(&format!("缓存命中 {}\n", cache_hit_label(projection)));
            if let Some(error) = projection.terminal_error.as_ref() {
                output.push_str(&format!("{}: {}\n", error.code, error.message));
            }
        } else {
            output.push_str("Session 尚未初始化。\n");
        }
        output.push_str("────────────────────────────────────────\n");
        output.push_str(app.status());
        output.push('\n');
        output
    }

    fn draw_header(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let projection = app.projection();
        let session = projection
            .map(|projection| projection.session_id.as_str())
            .unwrap_or("-");
        let cache = projection
            .map(cache_hit_label)
            .unwrap_or_else(|| "--%".to_string());
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(vec![
                    Span::styled(
                        "DeepCode",
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(" TUI · 本地编码 Agent"),
                ]),
                Line::from(Span::styled(
                    format!(
                        "Session {session} · indexes {} · cache {cache} · one Loop / one projection",
                        projection
                            .map(|value| value.session_directory_indexes.len())
                            .unwrap_or(0)
                    ),
                    Style::default().fg(Color::DarkGray),
                )),
            ]),
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
                .block(Block::default().borders(Borders::ALL).title(" Todo ")),
            area,
        );
    }

    fn draw_resource(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let Some(resource) = app.resource_preview() else {
            return;
        };
        frame.render_widget(
            Paragraph::new(resource.content.as_str())
                .wrap(Wrap { trim: false })
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title(format!(" {} · read only · /close ", resource.logical_path)),
                ),
            area,
        );
    }

    fn draw_projection(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let mut lines = Vec::new();
        if let Some(projection) = app.projection() {
            for item in timeline_items(projection) {
                match item {
                    TimelineItem::Message(message) => {
                        let color = if message.role == "user" {
                            Color::Blue
                        } else if message.role == "assistant" {
                            Color::White
                        } else {
                            Color::DarkGray
                        };
                        lines.push(Line::from(Span::styled(
                            format!("{}: {}", message.role, message.content),
                            Style::default().fg(color),
                        )));
                        if !message.attachments.is_empty() {
                            lines.push(Line::from(Span::styled(
                                format!(
                                    "  附件：{}",
                                    message
                                        .attachments
                                        .iter()
                                        .map(|attachment| attachment.name.as_str())
                                        .collect::<Vec<_>>()
                                        .join(", ")
                                ),
                                Style::default().fg(Color::DarkGray),
                            )));
                        }
                    }
                    TimelineItem::Narrative(narrative) => {
                        lines.push(Line::from(Span::styled(
                            narrative.content.as_str(),
                            Style::default().fg(Color::DarkGray),
                        )));
                    }
                    TimelineItem::Tool(activity) => {
                        push_tool_lines(&mut lines, activity);
                    }
                }
                lines.push(Line::from(""));
            }
            if let Some(draft) = projection.assistant_draft.as_ref() {
                lines.push(Line::from(Span::styled(
                    format!("{}▋", draft.content),
                    Style::default().fg(Color::White),
                )));
                lines.push(Line::from(""));
            }
            if let Some(plan) = projection.pending_plan.as_ref() {
                lines.push(Line::from(Span::styled(
                    "Plan",
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                )));
                lines.push(Line::from(plan.prompt.as_str()));
                for (index, option) in plan.options.iter().enumerate() {
                    lines.push(Line::from(format!("{}. {}", index + 1, option.label)));
                    if let Some(description) = option.description.as_deref() {
                        lines.push(Line::from(Span::styled(
                            format!("   {description}"),
                            Style::default().fg(Color::DarkGray),
                        )));
                    }
                    for operation in &option.operations_display {
                        lines.push(Line::from(Span::styled(
                            format!("   - {operation}"),
                            Style::default().fg(Color::DarkGray),
                        )));
                    }
                }
                lines.push(Line::from(
                    "输入编号选择；其他文本用于调整；Esc 或 /ignore 明确忽略。",
                ));
                lines.push(Line::from(""));
            }
            if let Some(interaction) = projection.pending_interaction.as_ref() {
                lines.push(Line::from(Span::styled(
                    format!("需要你回答：{}", interaction.prompt),
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                )));
                if let Some(options) = interaction.options.as_ref() {
                    for (index, option) in options.iter().enumerate() {
                        lines.push(Line::from(format!("  {}. {}", index + 1, option.label)));
                    }
                }
            }
            if let Some(approval) = projection.pending_approval.as_ref() {
                lines.push(Line::from(Span::styled(
                    format!("需要你批准：{}", approval.preview.summary),
                    Style::default()
                        .fg(Color::Yellow)
                        .add_modifier(Modifier::BOLD),
                )));
                for target in &approval.preview.logical_targets {
                    lines.push(Line::from(format!("  - {target}")));
                }
                lines.push(Line::from("输入 1/允许 或 2/拒绝。"));
                lines.push(Line::from(""));
            }
            for activity in projection
                .activities
                .iter()
                .filter(|activity| activity.kind != "tool")
            {
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
        if lines.is_empty() {
            lines.push(Line::from(Span::styled(
                "输入一条消息开始本地编码任务。",
                Style::default().fg(Color::DarkGray),
            )));
        }
        let visible = usize::from(area.height.saturating_sub(2));
        let start = lines.len().saturating_sub(visible);
        frame.render_widget(
            Paragraph::new(lines.into_iter().skip(start).collect::<Vec<_>>())
                .wrap(Wrap { trim: false })
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title(" Conversation "),
                ),
            area,
        );
    }

    fn draw_input(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        frame.render_widget(
            Paragraph::new(app.input())
                .wrap(Wrap { trim: false })
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title(if app.has_pending_plan() {
                            " Plan response "
                        } else if app
                            .projection()
                            .is_some_and(|projection| projection.pending_approval.is_some())
                        {
                            " Approval (1 allow / 2 deny) "
                        } else {
                            " Message "
                        }),
                ),
            area,
        );
        let width = area.width.saturating_sub(2).max(1);
        let offset = app.input().chars().count() as u16;
        frame.set_cursor_position((area.x + 1 + offset % width, area.y + 1 + offset / width));
    }
}

enum TimelineItem<'a> {
    Message(&'a ProjectionMessage),
    Narrative(&'a NarrativeProjection),
    Tool(&'a ActivityProjection),
}

impl TimelineItem<'_> {
    fn sequence(&self) -> u64 {
        match self {
            Self::Message(value) => value.sequence,
            Self::Narrative(value) => value.sequence,
            Self::Tool(value) => value.sequence,
        }
    }
}

fn timeline_items(projection: &SessionProjection) -> Vec<TimelineItem<'_>> {
    let tool_count = projection
        .activities
        .iter()
        .filter(|activity| activity.kind == "tool")
        .count();
    let mut items =
        Vec::with_capacity(projection.messages.len() + projection.narratives.len() + tool_count);
    items.extend(projection.messages.iter().map(TimelineItem::Message));
    items.extend(projection.narratives.iter().map(TimelineItem::Narrative));
    items.extend(
        projection
            .activities
            .iter()
            .filter(|activity| activity.kind == "tool")
            .map(TimelineItem::Tool),
    );
    items.sort_by_key(TimelineItem::sequence);
    items
}

fn push_tool_lines(lines: &mut Vec<Line<'_>>, activity: &ActivityProjection) {
    let operation = activity
        .tool
        .as_ref()
        .map(|tool| tool.operation.as_str())
        .unwrap_or(activity.label.as_str());
    let color = activity_color(&activity.status);
    lines.push(Line::from(Span::styled(
        format!("🔧 {operation} [{}]", activity.status),
        Style::default().fg(color),
    )));
    if let Some(tool) = activity.tool.as_ref() {
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

fn render_tool_plain(output: &mut String, activity: &ActivityProjection) {
    let operation = activity
        .tool
        .as_ref()
        .map(|tool| tool.operation.as_str())
        .unwrap_or(activity.label.as_str());
    output.push_str(&format!("工具 {operation} [{}]\n", activity.status));
    if let Some(tool) = activity.tool.as_ref() {
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
    if usage.cache_reported_call_count == 0 {
        return "--%".to_string();
    }
    let Some(total) = usage
        .cache_read_input_tokens
        .checked_add(usage.cache_miss_input_tokens)
        .filter(|total| *total > 0)
    else {
        return "--%".to_string();
    };
    format!(
        "{:.0}%",
        usage.cache_read_input_tokens as f64 * 100.0 / total as f64
    )
}

fn render_plan_plain(output: &mut String, plan: &PendingPlanProjection) {
    output.push_str("Plan\n");
    output.push_str(&plan.prompt);
    output.push('\n');
    for (index, option) in plan.options.iter().enumerate() {
        output.push_str(&format!("{}. {}\n", index + 1, option.label));
        if let Some(description) = option.description.as_deref() {
            output.push_str(&format!("   {description}\n"));
        }
        for operation in &option.operations_display {
            output.push_str(&format!("   - {operation}\n"));
        }
    }
    output.push_str("输入编号选择；其他非空文本用于调整；/ignore 明确忽略。\n");
}
