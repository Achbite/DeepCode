use crate::{
    app::TuiApp,
    model::{CardKind, CardModel, CurrentWorkModel},
};
use ratatui::{
    layout::{Constraint, Direction, Layout, Position, Rect},
    prelude::{Alignment, Frame},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, List, ListItem, Paragraph, Wrap},
};

#[derive(Clone)]
pub struct Theme {
    pub accent: Color,
    pub success: Color,
    pub warning: Color,
    pub danger: Color,
    pub dim: Color,
    pub border: Color,
    pub user_bg: Color,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            accent: Color::Cyan,
            success: Color::Green,
            warning: Color::Yellow,
            danger: Color::Red,
            dim: Color::DarkGray,
            border: Color::Rgb(210, 214, 220),
            user_bg: Color::Rgb(235, 238, 242),
        }
    }
}

#[derive(Clone, Default)]
pub struct Renderer {
    theme: Theme,
}

impl Renderer {
    pub fn draw(&self, frame: &mut Frame<'_>, app: &TuiApp) {
        let area = frame.area();
        let composer_height = if app.input().chars().count() > usize::from(area.width / 2) {
            5
        } else {
            4
        };
        let vertical = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(2),
                Constraint::Min(8),
                Constraint::Length(composer_height),
                Constraint::Length(1),
            ])
            .split(area);

        self.draw_header(frame, vertical[0]);
        self.draw_timeline(frame, vertical[1], app);
        self.draw_composer(frame, vertical[2], app.input());
        self.draw_footer(frame, vertical[3], app.status());
    }

    pub fn render_plain(&self, app: &TuiApp) -> String {
        let mut output = String::new();
        output.push_str("DeepCode TUI · daemon Session Runtime host shell\n");
        output.push_str("────────────────────────────────────────\n");
        if app.cards().is_empty() {
            for line in cover_plain_lines(app) {
                output.push_str(&line);
                output.push('\n');
            }
            output.push('\n');
        } else {
            for card in app.cards() {
                output.push_str(&self.render_plain_card(card));
            }
        }
        if let Some(current_work) = app.current_work() {
            output.push_str(&self.render_plain_current_work(current_work));
        }
        output.push_str("────────────────────────────────────────\n");
        output.push_str("输入消息，或使用 /help /workspace /sessions /status /quit\n");
        output
    }

    fn draw_header(&self, frame: &mut Frame<'_>, area: Rect) {
        let header = Paragraph::new(vec![
            Line::from(vec![
                Span::styled(
                    "DeepCode",
                    Style::default()
                        .fg(self.theme.accent)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(" TUI"),
                Span::styled("  ·  ", Style::default().fg(self.theme.dim)),
                Span::styled("Agent Session", Style::default().fg(Color::Gray)),
            ]),
            Line::from(vec![Span::styled(
                "KernelClient Host Shell · shared daemon Session Runtime",
                Style::default().fg(self.theme.dim),
            )]),
        ]);
        frame.render_widget(header, area);
    }

    fn draw_timeline(&self, frame: &mut Frame<'_>, area: Rect, app: &TuiApp) {
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(2),
                Constraint::Min(20),
                Constraint::Length(2),
            ])
            .split(area);
        let area = columns[1];

        let cards = app.cards();
        let current_work = app.current_work();
        if cards.is_empty() && current_work.is_none() {
            let cover = Paragraph::new(self.cover_lines(app))
                .alignment(Alignment::Center)
                .wrap(Wrap { trim: true });
            frame.render_widget(cover, area);
            return;
        }

        let (timeline_area, current_work_area) = if let Some(current_work) = current_work {
            let work_height = current_work_height(current_work, area.height);
            let rows = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Min(3), Constraint::Length(work_height)])
                .split(area);
            (rows[0], Some(rows[1]))
        } else {
            (area, None)
        };

        let visible_cards = usize::from(timeline_area.height.saturating_sub(1)).max(1);
        let content_width = usize::from(timeline_area.width.saturating_sub(4));
        let items = cards
            .iter()
            .rev()
            .take(visible_cards)
            .rev()
            .map(|card| ListItem::new(self.card_lines(card, content_width)))
            .collect::<Vec<_>>();
        let list = List::new(items).block(Block::default().borders(Borders::NONE));
        frame.render_widget(list, timeline_area);
        if let (Some(current_work), Some(current_work_area)) = (current_work, current_work_area) {
            self.draw_current_work(frame, current_work_area, current_work);
        }
    }

    fn draw_current_work(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        current_work: &CurrentWorkModel,
    ) {
        let mut lines = Vec::new();
        if let Some(activity) = &current_work.activity {
            lines.push(Line::from(vec![
                Span::styled("● ", Style::default().fg(self.theme.accent)),
                Span::styled(activity.clone(), Style::default().fg(Color::White)),
            ]));
        }
        if let Some(wait) = &current_work.wait {
            lines.push(Line::from(Span::styled(
                wait.clone(),
                Style::default().fg(self.theme.warning),
            )));
        }
        for segment in &current_work.segments {
            lines.push(Line::from(vec![
                Span::styled(
                    if segment.expanded { "▾ " } else { "▸ " },
                    Style::default().fg(self.theme.dim),
                ),
                Span::styled(
                    segment.title.clone(),
                    Style::default()
                        .fg(if segment.attention_unresolved {
                            self.theme.warning
                        } else {
                            self.theme.success
                        })
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  {}", segment.summary),
                    Style::default().fg(self.theme.dim),
                ),
            ]));
            if let Some(attention) = &segment.attention {
                lines.push(Line::from(Span::styled(
                    format!("  {attention}"),
                    Style::default().fg(if segment.attention_unresolved {
                        self.theme.warning
                    } else {
                        self.theme.dim
                    }),
                )));
            }
            for operation in &segment.operations {
                let detail = operation
                    .detail
                    .as_deref()
                    .map(|detail| format!(" · {detail}"))
                    .unwrap_or_default();
                lines.push(Line::from(vec![
                    Span::styled("  └ ", Style::default().fg(self.theme.dim)),
                    Span::styled(operation.title.clone(), Style::default().fg(Color::White)),
                    Span::styled(
                        format!(" · {}{detail}", operation.status),
                        Style::default().fg(self.theme.dim),
                    ),
                ]));
            }
        }
        if lines.is_empty() {
            lines.push(Line::from(Span::styled(
                "等待共享投影更新",
                Style::default().fg(self.theme.dim),
            )));
        }
        let panel = Paragraph::new(lines).wrap(Wrap { trim: true }).block(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(self.theme.dim))
                .title(" Current Work "),
        );
        frame.render_widget(panel, area);
    }

    fn cover_lines(&self, app: &TuiApp) -> Vec<Line<'static>> {
        vec![
            Line::from(""),
            Line::from(Span::styled(
                "          +----------------------+",
                Style::default().fg(self.theme.accent),
            )),
            Line::from(vec![
                Span::styled("          | ", Style::default().fg(self.theme.accent)),
                Span::styled(
                    "D C",
                    Style::default()
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled("  01  ", Style::default().fg(self.theme.dim)),
                Span::styled("KERNEL", Style::default().fg(self.theme.warning)),
                Span::styled("      |", Style::default().fg(self.theme.accent)),
            ]),
            Line::from(vec![
                Span::styled("          | ", Style::default().fg(self.theme.accent)),
                Span::styled("TERM", Style::default().fg(self.theme.success)),
                Span::styled(" -> ", Style::default().fg(self.theme.dim)),
                Span::styled("AGENT", Style::default().fg(self.theme.accent)),
                Span::styled("        |", Style::default().fg(self.theme.accent)),
            ]),
            Line::from(Span::styled(
                "          +----------------------+",
                Style::default().fg(self.theme.accent),
            )),
            Line::from(""),
            Line::from(Span::styled(
                "DeepCode",
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                "TUI host shell over the shared daemon Session Runtime",
                Style::default().fg(self.theme.dim),
            )),
            Line::from(""),
            Line::from(Span::styled(
                app.workspace_status(),
                Style::default().fg(self.theme.success),
            )),
            Line::from(Span::styled(
                format!("session: {}", app.current_session_label()),
                Style::default().fg(self.theme.dim),
            )),
            Line::from(Span::styled(
                app.runtime_status().to_string(),
                Style::default().fg(self.theme.dim),
            )),
            Line::from(""),
            Line::from(Span::styled(
                "Type a message to start. Use /workspace, /sessions, /help, /quit.",
                Style::default().fg(Color::Gray),
            )),
        ]
    }

    fn draw_composer(&self, frame: &mut Frame<'_>, area: Rect, input: &str) {
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(18),
                Constraint::Percentage(64),
                Constraint::Percentage(18),
            ])
            .split(area);
        let content = if input.is_empty() {
            Line::from(Span::styled(
                "询问 DeepCode Agent...",
                Style::default().fg(self.theme.dim),
            ))
        } else {
            Line::from(vec![
                Span::styled("> ", Style::default().fg(self.theme.accent)),
                Span::raw(input.to_string()),
            ])
        };
        let composer_area = columns[1];
        let composer = Paragraph::new(content).wrap(Wrap { trim: true }).block(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(self.border_style())
                .title(" 消息 "),
        );
        frame.render_widget(composer, composer_area);
        frame.set_cursor_position(composer_cursor_position(composer_area, input));
    }

    fn draw_footer(&self, frame: &mut Frame<'_>, area: Rect, status: &str) {
        let footer = Paragraph::new(Line::from(vec![
            Span::styled(status.to_string(), Style::default().fg(self.theme.dim)),
            Span::raw("  "),
            Span::styled("Enter", Style::default().fg(self.theme.accent)),
            Span::raw(" 发送 · "),
            Span::styled("Esc", Style::default().fg(self.theme.accent)),
            Span::raw(" 清空输入 · "),
            Span::styled("^C", Style::default().fg(self.theme.danger)),
            Span::raw(" 退出"),
        ]));
        frame.render_widget(footer, area);
    }

    fn card_lines(&self, card: &CardModel, width: usize) -> Vec<Line<'static>> {
        if matches!(card.kind, CardKind::User) {
            return self.user_card_lines(card, width);
        }

        let mut header = vec![
            Span::styled(
                format!("{} ", icon(card)),
                Style::default().fg(self.card_color(card)),
            ),
            Span::styled(
                label(card),
                Style::default()
                    .fg(self.card_color(card))
                    .add_modifier(Modifier::BOLD),
            ),
        ];
        if card.title != label(card) {
            header.push(Span::styled("  ", Style::default().fg(self.theme.dim)));
            header.push(Span::styled(
                card.title.clone(),
                Style::default().fg(self.theme.dim),
            ));
        }
        let mut lines = vec![Line::from(header)];

        let body = if card.body.trim().is_empty() {
            "(empty)".to_string()
        } else {
            card.body.clone()
        };
        for source_line in body.lines() {
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(
                    source_line.to_string(),
                    Style::default().fg(self.body_color(card)),
                ),
            ]));
        }
        lines.push(Line::from(""));
        lines
    }

    fn user_card_lines(&self, card: &CardModel, width: usize) -> Vec<Line<'static>> {
        let max_width = width.saturating_sub(8).clamp(12, 72);
        let mut lines = Vec::new();
        for source_line in card.body.lines() {
            let text = compact_line(source_line, max_width);
            lines.push(
                Line::from(Span::styled(
                    format!(" {text} "),
                    Style::default().fg(Color::Black).bg(self.theme.user_bg),
                ))
                .alignment(Alignment::Right),
            );
        }
        if lines.is_empty() {
            lines.push(
                Line::from(Span::styled(
                    " (empty) ",
                    Style::default().fg(Color::Black).bg(self.theme.user_bg),
                ))
                .alignment(Alignment::Right),
            );
        }
        lines.push(Line::from(""));
        lines
    }

    fn render_plain_card(&self, card: &CardModel) -> String {
        let mut out = if card.title == label(card) {
            format!("{} {}\n", icon(card), label(card))
        } else {
            format!("{} {} · {}\n", icon(card), label(card), card.title)
        };
        if card.body.is_empty() {
            out.push_str("  (empty)\n");
        } else {
            for line in card.body.lines() {
                out.push_str(&format!("  {line}\n"));
            }
        }
        out.push('\n');
        out
    }

    fn render_plain_current_work(&self, current_work: &CurrentWorkModel) -> String {
        let mut out = String::from("Current Work\n");
        if let Some(activity) = &current_work.activity {
            out.push_str(&format!("  {activity}\n"));
        }
        if let Some(wait) = &current_work.wait {
            out.push_str(&format!("  {wait}\n"));
        }
        for segment in &current_work.segments {
            out.push_str(&format!("  {} · {}\n", segment.title, segment.summary));
            if let Some(attention) = &segment.attention {
                out.push_str(&format!("    {attention}\n"));
            }
            for operation in &segment.operations {
                out.push_str(&format!("    {} · {}", operation.title, operation.status));
                if let Some(detail) = &operation.detail {
                    out.push_str(&format!(" · {detail}"));
                }
                out.push('\n');
            }
        }
        out.push('\n');
        out
    }

    fn card_color(&self, card: &CardModel) -> Color {
        match card.kind {
            CardKind::User => self.theme.accent,
            CardKind::Assistant => Color::White,
            CardKind::CommandHelp => self.theme.accent,
            CardKind::Notice => self.theme.success,
            CardKind::Permission => self.theme.warning,
            CardKind::Plan => self.theme.accent,
            CardKind::Review => self.theme.success,
            CardKind::Error => self.theme.danger,
            CardKind::Final => self.theme.success,
            CardKind::AuditStatus => self.theme.warning,
        }
    }

    fn body_color(&self, card: &CardModel) -> Color {
        match card.kind {
            CardKind::Error => self.theme.danger,
            CardKind::Notice | CardKind::AuditStatus => Color::Gray,
            _ => Color::White,
        }
    }

    fn border_style(&self) -> Style {
        Style::default().fg(self.theme.border)
    }
}

fn icon(card: &CardModel) -> &'static str {
    match card.kind {
        CardKind::User => "›",
        CardKind::Assistant | CardKind::Final => "◆",
        CardKind::CommandHelp => "?",
        CardKind::Notice => "•",
        CardKind::Permission => "!",
        CardKind::Plan => "◇",
        CardKind::Review => "✓",
        CardKind::Error => "×",
        CardKind::AuditStatus => "◌",
    }
}

fn label(card: &CardModel) -> &'static str {
    match card.kind {
        CardKind::User => "你",
        CardKind::Assistant => "DeepCode",
        CardKind::CommandHelp => "命令",
        CardKind::Notice => "提示",
        CardKind::Permission => "权限",
        CardKind::Plan => "计划",
        CardKind::Review => "审查",
        CardKind::Error => "错误",
        CardKind::Final => "DeepCode",
        CardKind::AuditStatus => "审计",
    }
}

fn current_work_height(current_work: &CurrentWorkModel, available_height: u16) -> u16 {
    let expanded_operation_count = current_work
        .segments
        .iter()
        .map(|segment| segment.operations.len())
        .sum::<usize>();
    let attention_count = current_work
        .segments
        .iter()
        .filter(|segment| segment.attention.is_some())
        .count();
    let desired = 2usize
        + usize::from(current_work.activity.is_some())
        + usize::from(current_work.wait.is_some())
        + current_work.segments.len()
        + attention_count
        + expanded_operation_count;
    let maximum = available_height.saturating_sub(3).clamp(3, 14);
    u16::try_from(desired).unwrap_or(u16::MAX).clamp(3, maximum)
}

fn composer_cursor_position(area: Rect, input: &str) -> Position {
    let inner_width = area.width.saturating_sub(2).max(1);
    let inner_height = area.height.saturating_sub(2).max(1);
    let offset = if input.is_empty() {
        0
    } else {
        2 + terminal_text_width(input)
    };
    let line = (offset / inner_width).min(inner_height.saturating_sub(1));
    let column = if line == inner_height.saturating_sub(1) && offset / inner_width > line {
        inner_width.saturating_sub(1)
    } else {
        offset % inner_width
    };
    Position::new(
        area.x.saturating_add(1).saturating_add(column),
        area.y.saturating_add(1).saturating_add(line),
    )
}

fn terminal_text_width(value: &str) -> u16 {
    value
        .chars()
        .map(|ch| if ch.is_ascii() { 1 } else { 2 })
        .sum()
}

fn cover_plain_lines(app: &TuiApp) -> Vec<String> {
    vec![
        "          +----------------------+".to_string(),
        "          | D C  01  KERNEL      |".to_string(),
        "          | TERM -> AGENT        |".to_string(),
        "          +----------------------+".to_string(),
        "DeepCode".to_string(),
        "TUI host shell over the shared daemon Session Runtime".to_string(),
        app.workspace_status(),
        format!("session: {}", app.current_session_label()),
        app.runtime_status().to_string(),
        "Type a message to start. Use /workspace, /sessions, /help, /quit.".to_string(),
    ]
}

fn compact_line(input: &str, max_width: usize) -> String {
    let mut out = String::new();
    for (index, ch) in input.chars().enumerate() {
        if index >= max_width {
            out.push('…');
            return out;
        }
        out.push(ch);
    }
    out
}
