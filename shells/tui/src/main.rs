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
            plugin_uris: args.plugins,
        },
    );
    if let Err(error) = app.bootstrap().await {
        eprintln!("DeepCode TUI 初始化失败：{error}");
        std::process::exit(1);
    }

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
    plugins: Vec<String>,
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
            plugins: Vec::new(),
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
                "--plugin" => {
                    index += 1;
                    parsed
                        .plugins
                        .push(required_arg(&values, index, "--plugin")?.to_string());
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
    let mut input_task = spawn_terminal_event_task();
    let mut refresh = tokio::time::interval(Duration::from_millis(150));
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let loop_result = async {
        loop {
            terminal.draw(|frame| app.renderer().draw(frame, &app))?;
            let event_task_result = tokio::select! {
                result = &mut input_task => Some(result),
                _ = refresh.tick() => {
                    tokio::select! {
                        result = &mut input_task => Some(result),
                        _ = app.poll() => None,
                    }
                }
            };
            let Some(event_task_result) = event_task_result else {
                continue;
            };
            input_task = spawn_terminal_event_task();
            let Some(next_event) = terminal_event_result(event_task_result)? else {
                continue;
            };
            let keep_running = match next_event {
                CrosstermEvent::Key(key) if key.kind == KeyEventKind::Press => match key.code {
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        app.interrupt().await;
                        false
                    }
                    KeyCode::Esc => {
                        if app.plugin_picker_open() {
                            app.dismiss_plugin_picker();
                        } else {
                            app.clear_input();
                        }
                        true
                    }
                    KeyCode::Backspace => {
                        app.backspace_input();
                        true
                    }
                    KeyCode::Enter => {
                        if app.plugin_picker_open() && app.plugin_picker_select() {
                            true
                        } else {
                            let input = app.take_input();
                            app.submit_line(&input).await
                        }
                    }
                    KeyCode::Tab => {
                        if app.plugin_picker_open() {
                            app.plugin_picker_select();
                        } else {
                            app.push_input('\t');
                        }
                        true
                    }
                    KeyCode::Up if app.plugin_picker_open() => {
                        app.plugin_picker_move(-1);
                        true
                    }
                    KeyCode::Down if app.plugin_picker_open() => {
                        app.plugin_picker_move(1);
                        true
                    }
                    KeyCode::PageDown => {
                        app.scroll_content(true);
                        true
                    }
                    KeyCode::PageUp => {
                        app.scroll_content(false);
                        true
                    }
                    KeyCode::Char(value) => {
                        app.push_input(value);
                        true
                    }
                    _ => true,
                },
                CrosstermEvent::Paste(text) => {
                    app.push_input_text(&text);
                    true
                }
                _ => true,
            };
            if !keep_running {
                break Ok(());
            }
        }
    }
    .await;
    let pump_result = terminal_event_result(input_task.await).map(|_| ());
    match loop_result {
        Err(error) => Err(error),
        Ok(()) => pump_result,
    }
}

fn spawn_terminal_event_task() -> tokio::task::JoinHandle<io::Result<Option<CrosstermEvent>>> {
    tokio::task::spawn_blocking(|| {
        if event::poll(Duration::from_millis(150))? {
            event::read().map(Some)
        } else {
            Ok(None)
        }
    })
}

fn terminal_event_result(
    result: Result<io::Result<Option<CrosstermEvent>>, tokio::task::JoinError>,
) -> io::Result<Option<CrosstermEvent>> {
    result.map_err(|error| io::Error::other(format!("terminal event pump failed: {error}")))?
}

async fn run_plain(mut app: TuiApp) -> io::Result<Option<String>> {
    print!("{}", app.renderer().render_plain(&app));
    let (sender, mut lines) = tokio::sync::mpsc::channel(16);
    // This plain-shell process owns stdin; process exit releases a blocked reader.
    std::thread::Builder::new()
        .name("plain-stdin".into())
        .spawn(move || loop {
            let mut line = String::new();
            match io::stdin().read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if sender.blocking_send(Ok(line)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.blocking_send(Err(error));
                    break;
                }
            }
        })?;
    let mut refresh = tokio::time::interval(Duration::from_millis(150));
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut input_closed = false;
    let mut prompt_needed = true;
    loop {
        if input_closed && !app.is_run_pending() {
            print!("{}", app.renderer().render_plain(&app));
            return Ok(app.action_required());
        }
        if prompt_needed && !input_closed {
            print!("DeepCode TUI> ");
            io::stdout().flush()?;
            prompt_needed = false;
        }
        tokio::select! {
            line = lines.recv(), if !input_closed => {
                let Some(line) = line else { input_closed = true; continue; };
                if !app.submit_line(line?.trim_end_matches(['\r', '\n'])).await {
                    return Ok(None);
                }
                print!("{}", app.renderer().render_plain(&app));
                prompt_needed = true;
            }
            _ = refresh.tick() => {
                let was_pending = app.is_run_pending();
                app.poll().await;
                if was_pending && !app.is_run_pending() {
                    print!("{}", app.renderer().render_plain(&app));
                }
            }
            interrupted = tokio::signal::ctrl_c() => {
                interrupted?;
                app.interrupt().await;
                return Ok(None);
            }
        }
    }
}

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        if let Err(error) = execute!(io::stdout(), EnterAlternateScreen) {
            let _ = disable_raw_mode();
            return Err(error);
        }
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        let _ = disable_raw_mode();
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
  deepcode-tui [-C <workspace>] [--session <id>] [--plugin <plugin://uri>]...
  deepcode-tui --smoke

只有显式 -C/--workspace 会给新 Session 创建 workspace binding。
--plugin 可重复且只选择下一次请求的插件；交互输入 @ 打开同一插件目录。
普通文本随时发送，运行中按序排队；/reply 1 确认 Plan，/reply <说明> 修订 Plan 或回答交互；/reply 1/2 允许/拒绝 effect；/cancel-plan 取消 Plan，/cancel 或 Ctrl-C 取消运行；Esc 清空输入。
普通文本、/focus <task>、/attach <path>、/detach <workspace-id>、/cancel-plan、/model <profile>、/cancel 都通过 ConversationPort。
上下文视图：/context。"#,
    );
}

#[cfg(test)]
mod tests {
    use super::Args;

    #[test]
    fn repeatable_plugins_are_request_scoped_arguments() {
        let args = Args::parse(vec![
            "--plugin".into(),
            "plugin://github@builtin".into(),
            "--plugin".into(),
            "plugin://pdf@builtin".into(),
        ])
        .expect("plugins parse");
        assert_eq!(
            args.plugins,
            vec![
                "plugin://github@builtin".to_string(),
                "plugin://pdf@builtin".to_string()
            ]
        );
    }
}
