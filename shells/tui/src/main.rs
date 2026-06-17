mod app;
mod model;
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
    time::Duration,
};

#[tokio::main]
async fn main() {
    let args = Args::parse(env::args().skip(1).collect());
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
            eprintln!("deepcode-tui failed to connect Kernel: {error}");
            std::process::exit(1);
        }
    };
    let client = bootstrap.client().clone();
    let renderer = Renderer::default();
    let mut app = TuiApp::new(
        client,
        renderer,
        TuiHostOptions {
            workspace_path: args.workspace,
            no_workspace: args.no_workspace,
        },
    );
    app.bootstrap().await;

    if args.smoke {
        print!("{}", app.renderer().render_plain(app.cards()));
        drop(bootstrap);
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
    workspace: Option<String>,
    no_workspace: bool,
    no_auto_start_kernel: bool,
}

impl Args {
    fn parse(args: Vec<String>) -> Self {
        let mut parsed = Self {
            api: None,
            help: false,
            smoke: false,
            workspace: None,
            no_workspace: false,
            no_auto_start_kernel: false,
        };
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--help" | "-h" => parsed.help = true,
                "--smoke" => parsed.smoke = true,
                "--api" => parsed.api = iter.next(),
                "--no-auto-start-kernel" => parsed.no_auto_start_kernel = true,
                "--workspace" | "-C" => parsed.workspace = iter.next(),
                "--no-workspace" => parsed.no_workspace = true,
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
        r#"DeepCode TUI

Usage:
  deepcode-tui
  deepcode-tui --smoke
  deepcode-tui --api <url>
  deepcode-tui --no-auto-start-kernel
  deepcode-tui --workspace <path>
  deepcode-tui --no-workspace

Kernel:
  默认先连接 --api / DEEPCODE_API_URL / DEEPCODE_HOST:DEEPCODE_PORT。
  本地 API 不可达时会后台启动同目录或开发产物中的 deepcode-kernel。
  设置 DEEPCODE_KERNEL_AUTO_START=0 或传 --no-auto-start-kernel 可禁用。

Interactive commands:
  /help              显示 TUI 命令
  /status            检查 Kernel daemon 连接
  /audit             显示审计占位状态
  /sessions          列出 Agent 会话
  /new [title]       新建 Agent 会话
  /use <id>          激活会话
  /timeline [id]     读取 timeline
  /allow <id>        允许权限请求
  /deny <id>         拒绝权限请求
  /decision <requirement|plan|review> <accept|reject|revise> [run-id] [target-id] [guidance]
  /clear             清理当前可见卡片
  /quit              退出 TUI

普通文本会直接通过共享 SessionDriverLoop 发送到当前会话；TUI 只负责展示、
输入和命令入口，不持有 workflow、permission 或 tool execution 事实。"#
    );
}
