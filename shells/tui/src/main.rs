mod app;
mod renderer;

use app::{TuiApp, TuiHostOptions};
use crossterm::{
    event::{self, Event as CrosstermEvent, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use deepcode_kernel_client::{KernelBootstrap, KernelBootstrapOptions};
use renderer::Renderer;
use std::{
    env,
    io::{self, IsTerminal, Write},
    path::PathBuf,
    time::Duration,
};

const EXIT_ACTION_REQUIRED: i32 = 5;

#[tokio::main]
async fn main() {
    let args = match Args::parse(env::args().skip(1).collect()) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("{error}");
            print_help();
            std::process::exit(2);
        }
    };
    if args.help {
        print_help();
        return;
    }
    let bootstrap = match KernelBootstrap::connect(
        KernelBootstrapOptions::new(args.api).auto_start(!args.no_auto_start_kernel),
    )
    .await
    {
        Ok(bootstrap) => bootstrap,
        Err(error) => {
            eprintln!("DeepCode TUI 无法连接 Daemon：{error}");
            std::process::exit(1);
        }
    };
    let mut app = TuiApp::new(
        bootstrap.client().clone(),
        Renderer,
        TuiHostOptions {
            workspace_path: args.workspace,
            session_id: args.session_id,
        },
    );
    app.bootstrap().await;

    if args.smoke {
        print!("{}", app.renderer().render_plain(&app));
        return;
    }

    let result = if io::stdin().is_terminal() && io::stdout().is_terminal() {
        run_terminal(app).await.map(|_| None)
    } else {
        run_plain(app).await
    };
    match result {
        Ok(Some(message)) => {
            eprintln!("{message}");
            std::process::exit(EXIT_ACTION_REQUIRED);
        }
        Ok(None) => {}
        Err(error) => {
            eprintln!("DeepCode TUI 失败：{error}");
            std::process::exit(1);
        }
    }
}

struct Args {
    api: Option<String>,
    help: bool,
    smoke: bool,
    workspace: Option<PathBuf>,
    session_id: Option<String>,
    no_auto_start_kernel: bool,
}

impl Args {
    fn parse(values: Vec<String>) -> Result<Self, String> {
        let mut parsed = Self {
            api: None,
            help: false,
            smoke: false,
            workspace: None,
            session_id: None,
            no_auto_start_kernel: false,
        };
        let mut index = 0;
        while index < values.len() {
            match values[index].as_str() {
                "--help" | "-h" => parsed.help = true,
                "--smoke" => parsed.smoke = true,
                "--api" => {
                    index += 1;
                    parsed.api = Some(required_arg(&values, index, "--api")?.to_string());
                }
                "--no-auto-start-kernel" => parsed.no_auto_start_kernel = true,
                "--workspace" | "-C" => {
                    index += 1;
                    parsed.workspace =
                        Some(PathBuf::from(required_arg(&values, index, "--workspace")?));
                }
                "--session" => {
                    index += 1;
                    parsed.session_id =
                        Some(required_arg(&values, index, "--session")?.to_string());
                }
                value => return Err(format!("未知选项：{value}")),
            }
            index += 1;
        }
        if parsed.session_id.is_some() && parsed.workspace.is_some() {
            return Err(
                "--session 指向已有 creation snapshot，不能同时使用 -C/--workspace。".to_string(),
            );
        }
        Ok(parsed)
    }
}

async fn run_terminal(mut app: TuiApp) -> io::Result<()> {
    let _guard = TerminalGuard::enter()?;
    let backend = ratatui::backend::CrosstermBackend::new(io::stdout());
    let mut terminal = ratatui::Terminal::new(backend)?;
    terminal.clear()?;
    loop {
        app.poll().await;
        terminal.draw(|frame| app.renderer().draw(frame, &app))?;
        if event::poll(Duration::from_millis(150))? {
            match event::read()? {
                CrosstermEvent::Key(key) if key.kind == KeyEventKind::Press => match key.code {
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        app.interrupt().await;
                        break;
                    }
                    KeyCode::Esc => {
                        if app.has_pending_plan() {
                            app.ignore_plan().await;
                        } else {
                            app.clear_input();
                        }
                    }
                    KeyCode::Backspace => app.backspace_input(),
                    KeyCode::Enter => {
                        let input = app.take_input();
                        if !app.submit_line(&input).await {
                            break;
                        }
                    }
                    KeyCode::Tab => app.push_input('\t'),
                    KeyCode::Char(value) => app.push_input(value),
                    _ => {}
                },
                CrosstermEvent::Paste(text) => app.push_input_text(&text),
                _ => {}
            }
        }
    }
    Ok(())
}

async fn run_plain(mut app: TuiApp) -> io::Result<Option<String>> {
    print!("{}", app.renderer().render_plain(&app));
    let mut line = String::new();
    loop {
        print!("DeepCode TUI> ");
        io::stdout().flush()?;
        line.clear();
        if io::stdin().read_line(&mut line)? == 0 {
            return Ok(app.take_action_required());
        }
        if !app.submit_line(line.trim()).await {
            return Ok(None);
        }
        while app.is_run_pending() {
            tokio::time::sleep(Duration::from_millis(150)).await;
            app.poll().await;
        }
        print!("{}", app.renderer().render_plain(&app));
        if let Some(message) = app.take_action_required() {
            return Ok(Some(message));
        }
    }
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

fn required_arg<'a>(values: &'a [String], index: usize, option: &str) -> Result<&'a str, String> {
    values
        .get(index)
        .map(String::as_str)
        .ok_or_else(|| format!("{option} 缺少参数。"))
}

fn print_help() {
    println!(
        r#"DeepCode TUI

用法：
  deepcode-tui [-C <workspace>] [--session <id>]
  deepcode-tui --smoke

只有显式 -C/--workspace 会给新 Session 创建 workspace binding。
Plan 可输入 1..N 或调整文本；Esc 明确忽略当前 Plan，空输入、EOF 与 Ctrl-C 不会忽略。
普通文本、/attach <path>、/detach <workspace-id>、/ignore、/model <profile>、/cancel 都通过 ConversationPort。
TUI 只渲染共享 SessionProjection，不拥有独立状态机或工具事实。"#,
    );
}
