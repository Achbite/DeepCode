use crate::app::TuiApp;
use deepcode_kernel_client::{
    ActivityProjection, AssistantDraftProjection, ContextCompositionProjection,
    ContextUsageProjection, NarrativeProjection, PendingPlanProjection, PlanProjection,
    ProjectionMessage, SessionProjection, SessionTimelineItem, TokenUsageProjection,
};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    prelude::Frame,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
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
        if app.plugin_picker_open() {
            self.draw_plugin_picker(frame, rows[1], app);
        }
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
            }
            if let Some(draft) = visible_assistant_draft(projection) {
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
                    TimelineItem::Message { value: message, .. } => {
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
                        lines.push(Line::from(Span::styled(
                            narrative.content.as_str(),
                            Style::default().fg(Color::DarkGray),
                        )));
                    }
                    TimelineItem::Plan { value: plan, .. } => {
                        push_timeline_plan_lines(&mut lines, plan);
                    }
                    TimelineItem::ToolGroup { activities, .. } => {
                        for activity in activities {
                            push_tool_lines(&mut lines, activity);
                        }
                    }
                }
                lines.push(Line::from(""));
            }
            if let Some(draft) = visible_assistant_draft(projection) {
                lines.push(Line::from(Span::styled(
                    format!("{}▋", draft.content),
                    Style::default().fg(Color::White),
                )));
                lines.push(Line::from(""));
            }
            if let Some(plan) = projection.pending_plan.as_ref() {
                lines.push(Line::from(Span::styled(
                    format!("Plan · revision {}", plan.revision),
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                )));
                lines.push(Line::from(Span::styled(
                    plan.title.as_str(),
                    Style::default().add_modifier(Modifier::BOLD),
                )));
                lines.push(Line::from(plan.summary.as_str()));
                for (index, step) in plan.steps.iter().enumerate() {
                    lines.push(Line::from(format!("{}. {}", index + 1, step.title)));
                    lines.push(Line::from(Span::styled(
                        format!("   {}", step.details),
                        Style::default().fg(Color::DarkGray),
                    )));
                    if let Some(verification) = step.verification.as_ref() {
                        for item in verification {
                            lines.push(Line::from(Span::styled(
                                format!("   验证：{item}"),
                                Style::default().fg(Color::DarkGray),
                            )));
                        }
                    }
                }
                lines.push(Line::from(
                    "输入 1/确认；其他文本用于修订；Esc 或 /cancel-plan 明确取消。",
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
        let selected_plugins = app.selected_plugin_labels();
        let title = if app.has_pending_plan() {
            " Plan response ".to_string()
        } else if app
            .projection()
            .is_some_and(|projection| projection.pending_approval.is_some())
        {
            " Approval (1 allow / 2 deny) ".to_string()
        } else if selected_plugins.is_empty() {
            " Message · @ plugins ".to_string()
        } else {
            format!(" Message · plugins: {} ", selected_plugins.join(", "))
        };
        frame.render_widget(
            Paragraph::new(app.input())
                .wrap(Wrap { trim: false })
                .block(Block::default().borders(Borders::ALL).title(title)),
            area,
        );
        let width = usize::from(area.width.saturating_sub(2).max(1));
        let offset = Line::from(app.input()).width();
        let column = u16::try_from(offset % width).unwrap_or(0);
        let row = u16::try_from(offset / width).unwrap_or(u16::MAX);
        frame.set_cursor_position((area.x + 1 + column, area.y + 1 + row));
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
                    Style::default().fg(Color::White)
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
        lines.push(Line::from(""));
        let cache = &projection.token_usage;
        if cache.cache_available {
            lines.push(Line::from(vec![
                Span::styled(
                    "Cache ",
                    Style::default()
                        .fg(Color::Green)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(cache_detail_label(cache)),
            ]));
            lines.push(cache_bar(cache.cache_hit_ratio, bar_width));
        } else {
            lines.push(Line::from(vec![
                Span::styled("Cache N/A", Style::default().fg(Color::DarkGray)),
                Span::styled(
                    format!(
                        " · reports {}/{} ({})",
                        cache.reported_call_count,
                        cache.provider_call_count,
                        cache_coverage_label(cache),
                    ),
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
        }
    } else {
        lines.push(Line::from(Span::styled(
            "Context N/A",
            Style::default().fg(Color::DarkGray),
        )));
        let cache = &projection.token_usage;
        if cache.cache_available {
            lines.push(Line::from(vec![
                Span::styled(
                    "Cache ",
                    Style::default()
                        .fg(Color::Green)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(cache_detail_label(cache)),
            ]));
            lines.push(cache_bar(cache.cache_hit_ratio, bar_width));
        } else {
            lines.push(Line::from(Span::styled(
                "Cache N/A",
                Style::default().fg(Color::DarkGray),
            )));
        }
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
    let cache = &projection.token_usage;
    if cache.cache_available {
        output.push_str(&format!("Cache {}\n", cache_detail_label(cache)));
    } else {
        output.push_str(&format!(
            "Cache N/A · reports {}/{} ({})\n",
            cache.reported_call_count,
            cache.provider_call_count,
            cache_coverage_label(cache),
        ));
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
    lines.push(Line::from(plan.summary.clone()));
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
        .map(|ratio| format!("{:.0}%", ratio * 100.0))
        .unwrap_or_else(|| "--%".to_string())
}

fn cache_detail_label(usage: &TokenUsageProjection) -> String {
    format!(
        "{} · hit {} · miss {} · reports {}/{} ({})",
        usage
            .cache_hit_ratio
            .map(|ratio| format!("{:.1}%", ratio * 100.0))
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
    output.push_str("输入 1/确认；其他非空文本用于修订；/cancel-plan 明确取消。\n");
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
