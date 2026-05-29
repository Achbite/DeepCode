use crate::model::{command_summary, CardModel};
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
        let status = format!("api={} | stage=10.0 | renderer=ratatui", client.base_url());
        Self {
            client,
            renderer,
            cards: Vec::new(),
            input: String::new(),
            status,
        }
    }

    pub async fn bootstrap(&mut self) {
        self.cards
            .push(CardModel::audit_status("audit-status", "reserved"));
        self.cards.push(CardModel::assistant(command_summary()));
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
                self.cards.push(CardModel::assistant(command_summary()));
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
                "unknown command: {command}\nType /help to list available commands."
            ))),
            prompt => self.send_prompt(prompt).await,
        }
        true
    }

    async fn refresh_daemon_status(&mut self) {
        match self.client.daemon_status().await {
            Ok(status) => {
                self.status = format!(
                    "api={} | daemon={} | status={}",
                    self.client.base_url(),
                    status.service,
                    if status.ok { "ok" } else { "degraded" }
                );
                self.cards.push(CardModel::stage(
                    "connected",
                    format!(
                        "{} at {}\nstatus: {}",
                        status.service,
                        self.client.base_url(),
                        if status.ok { "ok" } else { "degraded" }
                    ),
                ));
            }
            Err(error) => {
                self.status = format!("api={} | daemon=unavailable", self.client.base_url());
                self.cards.push(CardModel::error(format!(
                    "daemon unavailable: {error}\nUse /status to retry after starting the Kernel daemon."
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
                .push(CardModel::error(format!("audit verify failed: {error}"))),
        }
    }

    async fn send_prompt(&mut self, prompt: &str) {
        if prompt.trim().is_empty() {
            self.cards
                .push(CardModel::error("prompt is empty; type /help for usage"));
            return;
        }
        self.cards.push(CardModel::user(prompt));
        self.status = "run=pending | waiting for daemon response".to_string();
        match self.client.send_prompt(prompt, PromptMode::Ask).await {
            Ok(result) => {
                self.status = format!("session={} | run=completed", result.session_id);
                self.cards
                    .push(CardModel::stage("session", result.session_id.clone()));
                for event in result.events {
                    self.cards.push(CardModel::from_event(&event));
                }
                if let Some(answer) = result.final_answer {
                    self.cards.push(CardModel::final_answer(answer));
                }
            }
            Err(error) => {
                self.status = "run=failed".to_string();
                self.cards
                    .push(CardModel::error(format!("run failed: {error}")));
            }
        }
    }
}
