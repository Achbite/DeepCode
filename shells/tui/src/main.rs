mod app;
mod model;
mod renderer;

use app::TuiApp;
use crossterm::{
    event::{self, Event as CrosstermEvent, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use deepcode_kernel_client::{HttpKernelClient, KernelClientConfig};
use renderer::Renderer;
use std::{
    env,
    io::{self, IsTerminal, Write},
    time::Duration,
};

#[tokio::main]
async fn main() {
    let args = Args::parse(env::args().skip(1).collect());
    if args.help {
        print_help();
        return;
    }

    let client = HttpKernelClient::new(
        args.api
            .map(KernelClientConfig::new)
            .unwrap_or_else(KernelClientConfig::from_env),
    );
    let renderer = Renderer::default();
    let mut app = TuiApp::new(client, renderer);
    app.bootstrap().await;

    if args.smoke {
        print!("{}", app.renderer().render_plain(app.cards()));
        return;
    }

    let result = if io::stdin().is_terminal() && io::stdout().is_terminal() {
        run_terminal(app).await
    } else {
        run_plain(app).await
    };

    if let Err(error) = result {
        eprintln!("deepcode-tui failed: {error}");
        std::process::exit(1);
    }
}

struct Args {
    api: Option<String>,
    help: bool,
    smoke: bool,
}

impl Args {
    fn parse(args: Vec<String>) -> Self {
        let mut parsed = Self {
            api: None,
            help: false,
            smoke: false,
        };
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--help" | "-h" => parsed.help = true,
                "--smoke" => parsed.smoke = true,
                "--api" => parsed.api = iter.next(),
                _ => {}
            }
        }
        parsed
    }
}

async fn run_terminal(mut app: TuiApp) -> io::Result<()> {
    let _guard = TerminalGuard::enter()?;
    let backend = ratatui::backend::CrosstermBackend::new(io::stdout());
    let mut terminal = ratatui::Terminal::new(backend)?;
    terminal.clear()?;

    loop {
        terminal.draw(|frame| app.renderer().draw(frame, &app))?;
        if event::poll(Duration::from_millis(180))? {
            let CrosstermEvent::Key(key) = event::read()? else {
                continue;
            };
            if key.kind != KeyEventKind::Press {
                continue;
            }
            match key.code {
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => break,
                KeyCode::Esc => app.clear_input(),
                KeyCode::Backspace => app.backspace_input(),
                KeyCode::Enter => {
                    let line = app.take_input();
                    if !app.submit_line(&line).await {
                        break;
                    }
                }
                KeyCode::Char(ch) => app.push_input(ch),
                _ => {}
            }
        }
    }
    Ok(())
}

async fn run_plain(mut app: TuiApp) -> io::Result<()> {
    print!("{}", app.renderer().render_plain(app.cards()));
    let mut line = String::new();
    loop {
        print!("DeepCode TUI> ");
        io::stdout().flush()?;
        line.clear();
        let bytes = io::stdin().read_line(&mut line)?;
        if bytes == 0 {
            break;
        }
        if !app.submit_line(line.trim()).await {
            break;
        }
        print!("{}", app.renderer().render_plain(app.cards()));
    }
    Ok(())
}

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        execute!(io::stdout(), EnterAlternateScreen)?;
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
    }
}

fn print_help() {
    println!(
        r#"DeepCode TUI Host Shell MVP

Usage:
  deepcode-tui
  deepcode-tui --smoke
  deepcode-tui --api <url>

Interactive commands:
  /help              Show all TUI commands
  /status            Check Kernel daemon connection
  /ask <prompt>      Send one prompt through KernelClient
  /audit             Show audit verify placeholder
  /clear             Clear the visible card buffer
  /quit              Exit TUI

Plain text without a slash is sent as a prompt.

This is the stage-10.0 Ratatui/Crossterm Host shell. Full TUI product behavior
remains stage 17."#
    );
}
