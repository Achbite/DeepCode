use crate::app::TuiApp;
use deepcode_kernel_client::{
    ActivityProjection, ContextCompositionProjection, ContextUsageProjection, NarrativeProjection,
    PendingPlanProjection, ProjectionMessage, SessionProjection,
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
        if app.context_open() {
            self.draw_context(frame, rows[1], app);
        } else if app.resource_preview().is_some() {
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
            if !app.context_open() {
                output.push_str(&format!("缓存命中 {}\n", cache_hit_label(projection)));
            }
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
                        "Session {session} · indexes {} · cache {cache}",
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

    fn draw_context(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let width = usize::from(area.width.saturating_sub(4)).max(1);
        frame.render_widget(
            Paragraph::new(context_lines(app.projection(), width))
                .wrap(Wrap { trim: false })
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title(" Context · /context "),
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

const CONTEXT_PARTITIONS: [(&str, &str); 7] = [
    ("instructions", "系统与会话指令"),
    ("sessionControls", "Session 控制接口"),
    ("tools", "工具目录"),
    ("workspaceBindings", "目录索引"),
    ("contextProviders", "上下文提供项"),
    ("journalMessages", "对话消息"),
    ("messageAttachments", "消息附件"),
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
        lines.push(Line::from(""));
        if let Some((hit, miss)) = context_cache_counts(usage) {
            lines.push(Line::from(vec![
                Span::styled(
                    "Cache ",
                    Style::default()
                        .fg(Color::Green)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(format!(
                    "{} · hit {} · miss {}",
                    percent_label(hit, hit.saturating_add(miss)),
                    format_number(hit),
                    format_number(miss),
                )),
            ]));
            lines.push(cache_bar(hit, miss, bar_width));
        } else {
            lines.push(Line::from(Span::styled(
                "Cache N/A",
                Style::default().fg(Color::DarkGray),
            )));
        }
    } else {
        lines.push(Line::from(Span::styled(
            "Context N/A",
            Style::default().fg(Color::DarkGray),
        )));
        lines.push(Line::from(Span::styled(
            "Cache N/A",
            Style::default().fg(Color::DarkGray),
        )));
    }

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

fn cache_bar(hit: u64, miss: u64, width: usize) -> Line<'static> {
    let total = hit.saturating_add(miss);
    if total == 0 {
        return Line::from(Span::styled("N/A", Style::default().fg(Color::DarkGray)));
    }
    let hit_width = scaled_width(hit, total, width).min(width);
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

fn context_cache_counts(usage: &ContextUsageProjection) -> Option<(u64, u64)> {
    let hit = usage.cache_read_input_tokens?;
    let miss = usage.cache_miss_input_tokens?;
    (hit.saturating_add(miss) > 0).then_some((hit, miss))
}

fn current_context_receipt(
    projection: &SessionProjection,
) -> Option<&ContextCompositionProjection> {
    if let Some(usage) = projection.context_usage.as_ref() {
        return projection
            .context_compositions
            .iter()
            .rev()
            .find(|receipt| receipt.provider_request_id == usage.provider_request_id);
    }
    projection.context_compositions.last()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ContextPartitionMetric {
    item_count: u64,
    estimated_input_tokens: Option<u64>,
}

fn context_partition_metrics(
    receipt: &ContextCompositionProjection,
) -> [ContextPartitionMetric; 7] {
    if let Some(partitions) = receipt.partitions.as_ref() {
        let mut metrics = [ContextPartitionMetric::default(); 7];
        for partition in partitions {
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
        return metrics;
    }
    let mut metrics = [ContextPartitionMetric::default(); 7];
    if let Some(messages) = receipt.messages.as_ref() {
        for message in messages {
            if let Some(index) = partition_index(&message.contribution_kind) {
                metrics[index].item_count = metrics[index].item_count.saturating_add(1);
            }
            metrics[6].item_count = metrics[6]
                .item_count
                .saturating_add(message.attachments.len() as u64);
        }
        metrics[2].item_count = metrics[2].item_count.saturating_add(
            receipt
                .tools
                .as_ref()
                .map(|items| items.len() as u64)
                .unwrap_or_default(),
        );
        metrics[3].item_count = metrics[3].item_count.saturating_add(
            receipt
                .workspace_bindings
                .as_ref()
                .map(|items| items.len() as u64)
                .unwrap_or_default(),
        );
    } else if let Some(categories) = receipt.categories.as_ref() {
        for category in categories {
            if let Some(index) = partition_index(&category.kind) {
                metrics[index].item_count = metrics[index]
                    .item_count
                    .saturating_add(category.item_count);
            }
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
        if let Some((hit, miss)) = context_cache_counts(usage) {
            output.push_str(&format!(
                "Cache {} · hit {} · miss {}\n",
                percent_label(hit, hit.saturating_add(miss)),
                format_number(hit),
                format_number(miss),
            ));
        } else {
            output.push_str("Cache N/A\n");
        }
    } else {
        output.push_str("Context N/A\nCache N/A\n");
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use deepcode_kernel_client::{
        ContextCompositionItem, ContextCompositionMessage, ContextCompositionPartitionProjection,
    };

    #[test]
    fn context_partition_metrics_follow_session_projection_without_shell_estimates() {
        let receipt = ContextCompositionProjection {
            provider_request_id: "provider-request:test".to_string(),
            run_id: "run:test".to_string(),
            response_constraint: "normal".to_string(),
            categories: None,
            messages: Some(vec![
                ContextCompositionMessage {
                    message_index: 0,
                    contribution_id: "session:instructions".to_string(),
                    contribution_kind: "instructions".to_string(),
                    label: "instructions".to_string(),
                    role: "system".to_string(),
                    blocks: Vec::new(),
                    attachments: Vec::new(),
                },
                ContextCompositionMessage {
                    message_index: 1,
                    contribution_id: "message:user".to_string(),
                    contribution_kind: "journalMessages".to_string(),
                    label: "user".to_string(),
                    role: "user".to_string(),
                    blocks: Vec::new(),
                    attachments: vec![
                        context_item("attachment:one"),
                        context_item("attachment:two"),
                    ],
                },
            ]),
            workspace_bindings: Some(vec![context_item("workspace:test")]),
            tools: Some(vec![context_item("fs.read"), context_item("code.grep")]),
            partitions: None,
            sequence: 1,
            created_at: "2026-08-27T00:00:00Z".to_string(),
        };

        assert_eq!(
            context_partition_metrics(&receipt),
            [
                ContextPartitionMetric {
                    item_count: 1,
                    estimated_input_tokens: None
                },
                ContextPartitionMetric::default(),
                ContextPartitionMetric {
                    item_count: 2,
                    estimated_input_tokens: None
                },
                ContextPartitionMetric {
                    item_count: 1,
                    estimated_input_tokens: None
                },
                ContextPartitionMetric::default(),
                ContextPartitionMetric {
                    item_count: 1,
                    estimated_input_tokens: None
                },
                ContextPartitionMetric {
                    item_count: 2,
                    estimated_input_tokens: None
                },
            ],
        );
    }

    #[test]
    fn context_partition_metrics_render_only_session_owned_estimates() {
        let mut receipt = ContextCompositionProjection {
            provider_request_id: "provider-request:test".to_string(),
            run_id: "run:test".to_string(),
            response_constraint: "normal".to_string(),
            categories: None,
            messages: Some(Vec::new()),
            workspace_bindings: Some(Vec::new()),
            tools: Some(Vec::new()),
            partitions: Some(
                CONTEXT_PARTITIONS
                    .iter()
                    .enumerate()
                    .map(|(index, (kind, _))| ContextCompositionPartitionProjection {
                        kind: (*kind).to_string(),
                        item_count: index as u64,
                        request_shape_units: index as u64 + 1,
                        estimated_input_tokens: Some(index as u64 + 10),
                        token_source: Some("sessionEstimated".to_string()),
                    })
                    .collect(),
            ),
            sequence: 1,
            created_at: "2026-08-27T00:00:00Z".to_string(),
        };
        let metrics = context_partition_metrics(&receipt);
        assert_eq!(metrics[2].estimated_input_tokens, Some(12));
        assert_eq!(partition_token_label(metrics[2]), "≈12 Token");

        receipt.partitions.as_mut().unwrap()[2].token_source = None;
        assert_eq!(
            context_partition_metrics(&receipt)[2].estimated_input_tokens,
            None,
        );
    }

    #[test]
    fn context_bar_widths_preserve_total_width() {
        let widths = segment_widths(36_000, 4_000, 24_000, 40);
        assert_eq!(widths.0 + widths.1 + widths.2, 40);
        assert_eq!(format_number(64_000), "64,000");
    }

    fn context_item(id: &str) -> ContextCompositionItem {
        ContextCompositionItem {
            item_id: id.to_string(),
            label: id.to_string(),
        }
    }
}
