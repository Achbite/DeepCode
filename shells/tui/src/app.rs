use crate::model::CardModel;
use crate::renderer::Renderer;
use deepcode_kernel_client::{HttpKernelClient, PromptMode};

pub struct TuiApp {
    client: HttpKernelClient,
    renderer: Renderer,
    cards: Vec<CardModel>,
    input: String,
    status: String,
}

impl TuiApp {
    pub fn new(client: HttpKernelClient, renderer: Renderer) -> Self {
        let status = format!("API {} · 等待连接", client.base_url());
        Self {
            client,
            renderer,
            cards: Vec::new(),
            input: String::new(),
            status,
        }
    }

    pub async fn bootstrap(&mut self) {
        self.refresh_daemon_status().await;
    }

    pub fn renderer(&self) -> &Renderer {
        &self.renderer
    }

    pub fn cards(&self) -> &[CardModel] {
        &self.cards
    }

    pub fn input(&self) -> &str {
        &self.input
    }

    pub fn status(&self) -> &str {
        &self.status
    }

    pub fn push_input(&mut self, ch: char) {
        self.input.push(ch);
    }

    pub fn backspace_input(&mut self) {
        self.input.pop();
    }

    pub fn clear_input(&mut self) {
        self.input.clear();
    }

    pub fn take_input(&mut self) -> String {
        let input = self.input.trim().to_string();
        self.input.clear();
        input
    }

    pub async fn submit_line(&mut self, line: &str) -> bool {
        let line = line.trim();
        if line.is_empty() {
            return true;
        }
        match line {
            "/help" | "help" => self.cards.push(CardModel::command_help()),
            "/status" | "status" => self.refresh_daemon_status().await,
            "/audit" | "audit" => self.refresh_audit_status().await,
            "/clear" | "clear" => {
                self.cards.clear();
                self.cards.push(CardModel::stage(
                    "显示已清理",
                    "只清理当前 TUI 视图，不修改会话事实。",
                ));
            }
            "/quit" | "/exit" | "quit" | "exit" | "q" => return false,
            command if command.starts_with("/ask ") => {
                self.send_prompt(command.trim_start_matches("/ask ").trim())
                    .await;
            }
            command if command.starts_with("ask ") => {
                self.send_prompt(command.trim_start_matches("ask ").trim())
                    .await;
            }
            command if command.starts_with('/') => self.cards.push(CardModel::error(format!(
                "未知命令：{command}\n输入 /help 查看可用命令。"
            ))),
            prompt => self.send_prompt(prompt).await,
        }
        true
    }

    async fn refresh_daemon_status(&mut self) {
        match self.client.daemon_status().await {
            Ok(status) => {
                self.status = format!(
                    "API {} · {} · {}",
                    self.client.base_url(),
                    status.service,
                    if status.ok { "已连接" } else { "降级" }
                );
                self.cards.push(CardModel::stage(
                    "API 已连接",
                    format!(
                        "{}\n{}\n{}",
                        status.service,
                        self.client.base_url(),
                        if status.ok {
                            "状态正常"
                        } else {
                            "状态降级"
                        }
                    ),
                ));
            }
            Err(error) => {
                self.status = format!("API {} · 不可用", self.client.base_url());
                self.cards.push(CardModel::error(format!(
                    "Kernel daemon 不可用：{error}\n启动 daemon 后输入 /status 重试。"
                )));
            }
        }
    }

    async fn refresh_audit_status(&mut self) {
        match self.client.audit_verify().await {
            Ok(report) => self.cards.push(CardModel::audit_status(
                report.status,
                format!("degraded: {}\n{}", report.degraded, report.message),
            )),
            Err(error) => self
                .cards
                .push(CardModel::error(format!("审计检查失败：{error}"))),
        }
    }

    async fn send_prompt(&mut self, prompt: &str) {
        if prompt.trim().is_empty() {
            self.cards
                .push(CardModel::error("输入为空；可输入 /help 查看用法。"));
            return;
        }
        self.cards.push(CardModel::user(prompt));
        self.status = "运行中 · 等待 daemon 响应".to_string();
        match self.client.send_prompt(prompt, PromptMode::Ask).await {
            Ok(result) => {
                self.status = format!("会话 {} · 已完成", result.session_id);
                self.cards
                    .push(CardModel::stage("会话", result.session_id.clone()));
                match self.client.agent_timeline(&result.session_id).await {
                    Ok(timeline) => self.cards.extend(CardModel::from_timeline(&timeline)),
                    Err(_) => {
                        for event in result.events {
                            self.cards.push(CardModel::from_event(&event));
                        }
                        if let Some(answer) = result.final_answer {
                            self.cards.push(CardModel::final_answer(answer));
                        }
                    }
                }
            }
            Err(error) => {
                self.status = "运行失败".to_string();
                self.cards
                    .push(CardModel::error(format!("运行失败：{error}")));
            }
        }
    }
}
