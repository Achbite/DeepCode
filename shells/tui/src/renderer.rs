use crate::{
    app::TuiApp,
    model::{CardKind, CardModel},
};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    prelude::Frame,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph, Wrap},
};

#[derive(Clone)]
pub struct Theme {
    pub accent: Color,
    pub success: Color,
    pub warning: Color,
    pub danger: Color,
    pub dim: Color,
    pub border: Color,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            accent: Color::Blue,
            success: Color::Green,
            warning: Color::Yellow,
            danger: Color::Red,
            dim: Color::DarkGray,
            border: Color::DarkGray,
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
        let vertical = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Min(10),
                Constraint::Length(8),
                Constraint::Length(3),
                Constraint::Length(1),
            ])
            .split(area);

        self.draw_header(frame, vertical[0]);
        self.draw_body(frame, vertical[1], app.cards());
        self.draw_command_panel(frame, vertical[2]);
        self.draw_input(frame, vertical[3], app.input());
        self.draw_status(frame, vertical[4], app.status());
    }

    pub fn render_plain(&self, cards: &[CardModel]) -> String {
        let mut output = String::new();
        output.push_str("╭ DeepCode TUI ─────────────────────────────────────────────────────╮\n");
        output.push_str("│ KernelClient Host Shell | stage 10.0 | type /help for commands    │\n");
        output.push_str("╰───────────────────────────────────────────────────────────────────╯\n");
        output.push_str("── Conversation ─────────────────────────────────────────────────────\n");
        for card in cards {
            output.push_str(&self.render_plain_card(card));
        }
        output.push_str("── Input ────────────────────────────────────────────────────────────\n");
        output.push_str("Type a message, or use /help /status /ask <prompt> /audit /clear /quit\n");
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
                Span::raw("  TUI Host Shell MVP"),
            ]),
            Line::from(vec![Span::styled(
                "KernelClient only · no runtime ownership · stage 10.0",
                Style::default().fg(self.theme.dim),
            )]),
        ])
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(self.border_style()),
        );
        frame.render_widget(header, area);
    }

    fn draw_body(&self, frame: &mut Frame<'_>, area: Rect, cards: &[CardModel]) {
        let body = if area.width >= 96 {
            Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(72), Constraint::Percentage(28)])
                .split(area)
        } else {
            Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Percentage(100), Constraint::Length(0)])
                .split(area)
        };

        let items = cards
            .iter()
            .rev()
            .take(18)
            .rev()
            .map(|card| ListItem::new(self.card_lines(card)).style(self.card_style(card)))
            .collect::<Vec<_>>();
        let list = List::new(items)
            .block(
                Block::default()
                    .title("Conversation")
                    .borders(Borders::ALL)
                    .border_style(self.border_style()),
            )
            .highlight_style(Style::default().add_modifier(Modifier::BOLD));
        frame.render_widget(list, body[0]);

        if body.len() > 1 && body[1].height > 0 {
            let side = Paragraph::new(vec![
                Line::from(Span::styled(
                    "Stage 10.0 boundaries",
                    Style::default().fg(self.theme.accent),
                )),
                Line::from(""),
                Line::from("• Host shell only"),
                Line::from("• KernelClient HTTP adapter"),
                Line::from("• No workflow ownership"),
                Line::from("• No tool execution"),
                Line::from(""),
                Line::from(Span::styled(
                    "Full TUI stays stage 17",
                    Style::default().fg(self.theme.warning),
                )),
            ])
            .wrap(Wrap { trim: true })
            .block(
                Block::default()
                    .title("Guide")
                    .borders(Borders::ALL)
                    .border_style(self.border_style()),
            );
            frame.render_widget(side, body[1]);
        }
    }

    fn draw_command_panel(&self, frame: &mut Frame<'_>, area: Rect) {
        let commands = Paragraph::new(vec![
            Line::from(vec![
                Span::styled("/help", Style::default().fg(self.theme.accent)),
                Span::raw(" commands  "),
                Span::styled("/status", Style::default().fg(self.theme.success)),
                Span::raw(" daemon  "),
                Span::styled("/ask <prompt>", Style::default().fg(self.theme.accent)),
                Span::raw(" prompt"),
            ]),
            Line::from(vec![
                Span::styled("/audit", Style::default().fg(self.theme.warning)),
                Span::raw(" audit placeholder  "),
                Span::styled("/clear", Style::default().fg(self.theme.dim)),
                Span::raw(" clear cards  "),
                Span::styled("/quit", Style::default().fg(self.theme.danger)),
                Span::raw(" exit"),
            ]),
            Line::from(""),
            Line::from("Plain text is sent as one prompt through KernelClient."),
        ])
        .wrap(Wrap { trim: true })
        .block(
            Block::default()
                .title("Commands")
                .borders(Borders::ALL)
                .border_style(self.border_style()),
        );
        frame.render_widget(commands, area);
    }

    fn draw_input(&self, frame: &mut Frame<'_>, area: Rect, input: &str) {
        let input = Paragraph::new(Line::from(vec![
            Span::styled("> ", Style::default().fg(self.theme.accent)),
            Span::raw(input),
        ]))
        .block(
            Block::default()
                .title("Input")
                .borders(Borders::ALL)
                .border_style(self.border_style()),
        );
        frame.render_widget(input, area);
    }

    fn draw_status(&self, frame: &mut Frame<'_>, area: Rect, status: &str) {
        let status = Paragraph::new(Line::from(vec![
            Span::styled("status ", Style::default().fg(self.theme.dim)),
            Span::raw(status),
        ]));
        frame.render_widget(status, area);
    }

    fn card_lines(&self, card: &CardModel) -> Vec<Line<'static>> {
        let mut lines = vec![Line::from(vec![
            Span::styled("┃ ", Style::default().fg(self.card_color(card))),
            Span::styled(
                label(card),
                Style::default()
                    .fg(self.card_color(card))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("  "),
            Span::styled(card.title.clone(), Style::default().fg(Color::White)),
        ])];
        for source_line in card.body.lines() {
            lines.push(Line::from(vec![
                Span::styled("┃ ", Style::default().fg(self.card_color(card))),
                Span::raw(source_line.to_string()),
            ]));
        }
        if card.body.is_empty() {
            lines.push(Line::from(vec![
                Span::styled("┃ ", Style::default().fg(self.card_color(card))),
                Span::styled("(empty)", Style::default().fg(self.theme.dim)),
            ]));
        }
        lines.push(Line::from(""));
        lines
    }

    fn render_plain_card(&self, card: &CardModel) -> String {
        let mut out = format!("┃ {} · {}\n", label(card), card.title);
        if card.body.is_empty() {
            out.push_str("┃ (empty)\n");
        } else {
            for line in card.body.lines() {
                out.push_str(&format!("┃ {line}\n"));
            }
        }
        out.push('\n');
        out
    }

    fn card_style(&self, card: &CardModel) -> Style {
        Style::default().fg(match card.kind {
            CardKind::Error => self.theme.danger,
            CardKind::AuditStatus => self.theme.warning,
            CardKind::Final => self.theme.success,
            _ => Color::Gray,
        })
    }

    fn card_color(&self, card: &CardModel) -> Color {
        match card.kind {
            CardKind::User => self.theme.accent,
            CardKind::Assistant => Color::White,
            CardKind::CommandHelp => self.theme.accent,
            CardKind::Stage => self.theme.success,
            CardKind::Tool => self.theme.warning,
            CardKind::Permission => self.theme.warning,
            CardKind::Error => self.theme.danger,
            CardKind::Final => self.theme.success,
            CardKind::AuditStatus => self.theme.warning,
        }
    }

    fn border_style(&self) -> Style {
        Style::default().fg(self.theme.border)
    }
}

fn label(card: &CardModel) -> &'static str {
    match card.kind {
        CardKind::User => "USER",
        CardKind::Assistant => "ASSISTANT",
        CardKind::CommandHelp => "COMMANDS",
        CardKind::Stage => "STAGE",
        CardKind::Tool => "TOOL",
        CardKind::Permission => "PERMISSION",
        CardKind::Error => "ERROR",
        CardKind::Final => "FINAL",
        CardKind::AuditStatus => "AUDIT",
    }
}
