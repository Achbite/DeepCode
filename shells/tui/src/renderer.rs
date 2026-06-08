use crate::{
    app::TuiApp,
    model::{CardKind, CardModel},
};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
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
        self.draw_timeline(frame, vertical[1], app.cards());
        self.draw_composer(frame, vertical[2], app.input());
        self.draw_footer(frame, vertical[3], app.status());
    }

    pub fn render_plain(&self, cards: &[CardModel]) -> String {
        let mut output = String::new();
        output.push_str("DeepCode TUI · pi-style session shell\n");
        output.push_str("────────────────────────────────────────\n");
        if cards.is_empty() {
            output.push_str("我们应该在 DeepCode 中做些什么？\n\n");
        } else {
            for card in cards {
                output.push_str(&self.render_plain_card(card));
            }
        }
        output.push_str("────────────────────────────────────────\n");
        output.push_str("输入消息，或使用 /help /status /audit /clear /quit\n");
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
                "KernelClient Host Shell · timeline display only",
                Style::default().fg(self.theme.dim),
            )]),
        ]);
        frame.render_widget(header, area);
    }

    fn draw_timeline(&self, frame: &mut Frame<'_>, area: Rect, cards: &[CardModel]) {
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(2),
                Constraint::Min(20),
                Constraint::Length(2),
            ])
            .split(area);
        let area = columns[1];

        if cards.is_empty() {
            let empty = Paragraph::new(vec![
                Line::from(""),
                Line::from(Span::styled(
                    "我们应该在 DeepCode 中做些什么？",
                    Style::default()
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "输入消息后会生成 timeline；TUI 只负责显示，不接管会话编排。",
                    Style::default().fg(self.theme.dim),
                )),
            ])
            .alignment(Alignment::Center)
            .wrap(Wrap { trim: true });
            frame.render_widget(empty, area);
            return;
        }

        let visible_cards = usize::from(area.height.saturating_sub(1)).max(1);
        let content_width = usize::from(area.width.saturating_sub(4));
        let items = cards
            .iter()
            .rev()
            .take(visible_cards)
            .rev()
            .map(|card| ListItem::new(self.card_lines(card, content_width)))
            .collect::<Vec<_>>();
        let list = List::new(items).block(Block::default().borders(Borders::NONE));
        frame.render_widget(list, area);
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
        let composer = Paragraph::new(content).wrap(Wrap { trim: true }).block(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(self.border_style())
                .title(" 消息 "),
        );
        frame.render_widget(composer, columns[1]);
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

    fn card_color(&self, card: &CardModel) -> Color {
        match card.kind {
            CardKind::User => self.theme.accent,
            CardKind::Assistant => Color::White,
            CardKind::Thinking => self.theme.dim,
            CardKind::CommandHelp => self.theme.accent,
            CardKind::Stage => self.theme.success,
            CardKind::Tool => self.theme.warning,
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
            CardKind::Thinking | CardKind::Stage | CardKind::AuditStatus => Color::Gray,
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
        CardKind::Thinking => "·",
        CardKind::CommandHelp => "?",
        CardKind::Stage => "•",
        CardKind::Tool => "⌁",
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
        CardKind::Thinking => "思考",
        CardKind::CommandHelp => "命令",
        CardKind::Stage => "状态",
        CardKind::Tool => "工具",
        CardKind::Permission => "权限",
        CardKind::Plan => "计划",
        CardKind::Review => "审查",
        CardKind::Error => "错误",
        CardKind::Final => "DeepCode",
        CardKind::AuditStatus => "审计",
    }
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
