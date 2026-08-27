use serde_json::{json, Value};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: &str = "deepcode.local-agent.v2";
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_STDERR_RECEIPT_BYTES: usize = 16 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone)]
pub(crate) struct SessionServiceError {
    pub(crate) code: String,
    pub(crate) message: String,
}

impl SessionServiceError {
    pub(crate) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct SessionServiceProcess {
    process: Arc<Mutex<OwnedSessionService>>,
    next_request: Arc<AtomicU64>,
}

impl std::fmt::Debug for SessionServiceProcess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SessionServiceProcess")
    }
}

impl SessionServiceProcess {
    pub(crate) fn spawn(
        api_base: &str,
        service_token: &str,
        profile_id: Option<&str>,
        plugin_config: &Value,
    ) -> Result<Self, SessionServiceError> {
        let bridge = resolve_bridge()?;
        let node = resolve_node()?;
        let mut command = Command::new(node);
        command
            .arg(bridge)
            .env("DEEPCODE_LOCAL_AGENT_API_BASE", api_base)
            .env("DEEPCODE_LOCAL_AGENT_TOKEN", service_token)
            .env(
                "DEEPCODE_LOCAL_AGENT_PLUGIN_CONFIG",
                serde_json::to_string(plugin_config).map_err(|error| {
                    SessionServiceError::new(
                        "session_service_plugin_config_failed",
                        format!("编码 Session 插件配置失败：{error}"),
                    )
                })?,
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(profile_id) = profile_id.filter(|value| !value.trim().is_empty()) {
            command.env("DEEPCODE_LOCAL_AGENT_PROFILE_ID", profile_id);
        }
        let mut child = command.spawn().map_err(|error| {
            SessionServiceError::new(
                "session_service_spawn_failed",
                format!("启动 Node Session Service 失败：{error}"),
            )
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            SessionServiceError::new(
                "session_service_pipe_failed",
                "Node Session Service 缺少标准输入管道。",
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            SessionServiceError::new(
                "session_service_pipe_failed",
                "Node Session Service 缺少标准输出管道。",
            )
        })?;
        let stderr_receipt = Arc::new(Mutex::new(Vec::new()));
        let stderr_reader = child.stderr.take().map(|mut stderr| {
            let receipt = Arc::clone(&stderr_receipt);
            std::thread::spawn(move || {
                let mut buffer = [0_u8; 8192];
                while let Ok(read) = stderr.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    append_stderr_receipt(&receipt, &buffer[..read]);
                }
            })
        });
        let mut owned = OwnedSessionService {
            child,
            stdin: Some(BufWriter::new(stdin)),
            stdout: BufReader::new(stdout),
            stderr_receipt,
            stderr_reader,
            stopped: false,
        };
        let ready =
            owned.exchange_with_timeout("host:startup", "health", json!({}), STARTUP_TIMEOUT)?;
        if ready.get("state").and_then(Value::as_str) != Some("ready") {
            return Err(owned.fail_and_stop(
                "session_service_not_ready",
                "Session Service 启动握手没有返回 ready。",
            ));
        }
        Ok(Self {
            process: Arc::new(Mutex::new(owned)),
            next_request: Arc::new(AtomicU64::new(1)),
        })
    }

    pub(crate) fn request(
        &self,
        operation: &str,
        data: Value,
    ) -> Result<Value, SessionServiceError> {
        let request_id = format!("host:{}", self.next_request.fetch_add(1, Ordering::Relaxed));
        let mut process = self.process.lock().map_err(|_| {
            SessionServiceError::new(
                "session_service_lock_failed",
                "Session Service transport 锁已损坏。",
            )
        })?;
        process.exchange_with_timeout(&request_id, operation, data, REQUEST_TIMEOUT)
    }

    pub(crate) fn is_ready(&self) -> bool {
        self.process
            .lock()
            .ok()
            .is_some_and(|mut process| process.is_running().unwrap_or(false))
    }

    pub(crate) fn shutdown(&self) -> Result<(), SessionServiceError> {
        let mut process = self.process.lock().map_err(|_| {
            SessionServiceError::new(
                "session_service_lock_failed",
                "Session Service transport 锁已损坏。",
            )
        })?;
        process.shutdown()
    }
}

struct OwnedSessionService {
    child: Child,
    stdin: Option<BufWriter<ChildStdin>>,
    stdout: BufReader<ChildStdout>,
    stderr_receipt: Arc<Mutex<Vec<u8>>>,
    stderr_reader: Option<std::thread::JoinHandle<()>>,
    stopped: bool,
}

impl OwnedSessionService {
    fn exchange_with_timeout(
        &mut self,
        request_id: &str,
        operation: &str,
        data: Value,
        timeout: Duration,
    ) -> Result<Value, SessionServiceError> {
        if self.stopped {
            return Err(SessionServiceError::new(
                "session_service_stopped",
                "Session Service 已停止。",
            ));
        }
        if self.child.try_wait().map_err(process_wait_error)?.is_some() {
            self.stopped = true;
            self.join_stderr_reader();
            return Err(SessionServiceError::new(
                "session_service_unavailable",
                message_with_stderr("Session Service 已退出。", &self.stderr_receipt),
            ));
        }
        let request = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "operation": operation,
            "data": data,
        });
        let mut encoded = serde_json::to_vec(&request).map_err(|error| {
            SessionServiceError::new(
                "session_service_request_encode_failed",
                format!("编码 Session Service 请求失败：{error}"),
            )
        })?;
        if encoded.len() > MAX_FRAME_BYTES {
            return Err(SessionServiceError::new(
                "session_service_request_too_large",
                "Session Service 请求超过本地 transport 上限。",
            ));
        }
        encoded.push(b'\n');
        let stdin = self.stdin.as_mut().ok_or_else(|| {
            SessionServiceError::new("session_service_stopped", "Session Service 输入已经关闭。")
        })?;
        stdin.write_all(&encoded).map_err(process_write_error)?;
        stdin.flush().map_err(process_write_error)?;
        let response = match read_frame_with_timeout(
            &mut self.child,
            &mut self.stdin,
            &mut self.stdout,
            &mut self.stopped,
            &self.stderr_receipt,
            timeout,
        ) {
            Ok(response) => response,
            Err(error) => {
                if !self.stopped {
                    self.stdin.take();
                    if self.child.try_wait().ok().flatten().is_none() {
                        let _ = self.child.kill();
                        let _ = self.child.wait();
                    }
                    self.stopped = true;
                }
                self.join_stderr_reader();
                return Err(error);
            }
        };
        decode_response(response, request_id)
    }

    fn is_running(&mut self) -> Result<bool, SessionServiceError> {
        if self.stopped {
            return Ok(false);
        }
        if self.child.try_wait().map_err(process_wait_error)?.is_some() {
            self.stopped = true;
            self.join_stderr_reader();
            return Ok(false);
        }
        Ok(true)
    }

    fn join_stderr_reader(&mut self) {
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }

    fn fail_and_stop(&mut self, code: &str, message: &str) -> SessionServiceError {
        self.stdin.take();
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        self.stopped = true;
        self.join_stderr_reader();
        SessionServiceError::new(code, message_with_stderr(message, &self.stderr_receipt))
    }

    fn shutdown(&mut self) -> Result<(), SessionServiceError> {
        if self.stopped {
            self.join_stderr_reader();
            return Ok(());
        }
        let result = self.exchange_with_timeout(
            "host:shutdown",
            "shutdown",
            json!({}),
            Duration::from_secs(3),
        );
        if self.stopped {
            self.join_stderr_reader();
            return result.map(|_| ());
        }
        self.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if self.child.try_wait().map_err(process_wait_error)?.is_some() {
                self.stopped = true;
                self.join_stderr_reader();
                return result.map(|_| ());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.child.kill().map_err(|error| {
            SessionServiceError::new(
                "session_service_kill_failed",
                format!("终止未退出的 Session Service 失败：{error}"),
            )
        })?;
        let _ = self.child.wait();
        self.stopped = true;
        self.join_stderr_reader();
        result.map(|_| ())
    }
}

impl Drop for OwnedSessionService {
    fn drop(&mut self) {
        if self.stopped {
            self.join_stderr_reader();
            return;
        }
        self.stdin.take();
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        self.stopped = true;
        self.join_stderr_reader();
    }
}

fn read_frame(reader: &mut impl BufRead) -> Result<Vec<u8>, SessionServiceError> {
    let mut encoded = Vec::new();
    loop {
        let (consumed, terminated) = {
            let available = reader.fill_buf().map_err(|error| {
                SessionServiceError::new(
                    "session_service_response_read_failed",
                    format!("读取 Session Service 回复失败：{error}"),
                )
            })?;
            if available.is_empty() {
                return Err(SessionServiceError::new(
                    if encoded.is_empty() {
                        "session_service_response_missing"
                    } else {
                        "session_service_response_invalid"
                    },
                    if encoded.is_empty() {
                        "Session Service 未返回回复。"
                    } else {
                        "Session Service 回复未按本地行协议结束。"
                    },
                ));
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let consumed = newline.map_or(available.len(), |index| index + 1);
            if encoded.len().saturating_add(consumed) > MAX_FRAME_BYTES + 1 {
                return Err(SessionServiceError::new(
                    "session_service_response_invalid",
                    "Session Service 回复超过本地 transport 上限。",
                ));
            }
            encoded.extend_from_slice(&available[..consumed]);
            (consumed, newline.is_some())
        };
        reader.consume(consumed);
        if terminated {
            break;
        }
    }
    encoded.pop();
    if encoded.last() == Some(&b'\r') {
        encoded.pop();
    }
    Ok(encoded)
}

fn read_frame_with_timeout(
    child: &mut Child,
    stdin: &mut Option<BufWriter<ChildStdin>>,
    reader: &mut BufReader<ChildStdout>,
    stopped: &mut bool,
    stderr_receipt: &Arc<Mutex<Vec<u8>>>,
    timeout: Duration,
) -> Result<Vec<u8>, SessionServiceError> {
    std::thread::scope(|scope| {
        let (sender, receiver) = mpsc::sync_channel(1);
        scope.spawn(move || {
            let _ = sender.send(read_frame(reader));
        });
        match receiver.recv_timeout(timeout) {
            Ok(result) => result.map_err(|error| {
                SessionServiceError::new(
                    error.code,
                    message_with_stderr(&error.message, stderr_receipt),
                )
            }),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                stdin.take();
                let _ = child.kill();
                let _ = child.wait();
                *stopped = true;
                Err(SessionServiceError::new(
                    "session_service_response_timeout",
                    message_with_stderr(
                        "Session Service 在本地 transport 截止时间内没有回复。",
                        stderr_receipt,
                    ),
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(SessionServiceError::new(
                "session_service_response_reader_failed",
                message_with_stderr("Session Service 回复读取线程异常结束。", stderr_receipt),
            )),
        }
    })
}

fn append_stderr_receipt(receipt: &Arc<Mutex<Vec<u8>>>, chunk: &[u8]) {
    let Ok(mut buffer) = receipt.lock() else {
        return;
    };
    buffer.extend_from_slice(chunk);
    if buffer.len() > MAX_STDERR_RECEIPT_BYTES {
        let remove = buffer.len() - MAX_STDERR_RECEIPT_BYTES;
        buffer.drain(..remove);
    }
}

fn message_with_stderr(message: &str, receipt: &Arc<Mutex<Vec<u8>>>) -> String {
    let stderr = receipt
        .lock()
        .ok()
        .map(|value| String::from_utf8_lossy(&value).trim().to_string())
        .unwrap_or_default();
    if stderr.is_empty() {
        message.to_string()
    } else {
        format!("{message} Session stderr：{stderr}")
    }
}

fn decode_response(encoded: Vec<u8>, request_id: &str) -> Result<Value, SessionServiceError> {
    let value: Value = serde_json::from_slice(&encoded).map_err(|error| {
        SessionServiceError::new(
            "session_service_response_json_invalid",
            format!("Session Service 回复不是有效 JSON：{error}"),
        )
    })?;
    if value.get("protocolVersion").and_then(Value::as_str) != Some(PROTOCOL_VERSION)
        || value.get("requestId").and_then(Value::as_str) != Some(request_id)
    {
        return Err(SessionServiceError::new(
            "session_service_response_identity_mismatch",
            "Session Service 回复身份不匹配。",
        ));
    }
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(value.get("data").cloned().unwrap_or(Value::Null));
    }
    let error = value.get("error").and_then(Value::as_object);
    Err(SessionServiceError::new(
        error
            .and_then(|value| value.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("session_service_request_failed"),
        error
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Session Service 请求失败。"),
    ))
}

fn resolve_bridge() -> Result<PathBuf, SessionServiceError> {
    if let Some(path) = environment_file("DEEPCODE_SESSION_BRIDGE") {
        return Ok(path);
    }
    let executable = std::env::current_exe().map_err(|error| {
        SessionServiceError::new(
            "session_service_asset_root_unavailable",
            format!("无法定位 Daemon 可执行文件：{error}"),
        )
    })?;
    executable
        .parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .flat_map(|ancestor| {
            [
                ancestor.join("session-core/dist/sessionServiceBridge.js"),
                ancestor.join("userspace/session-core/dist/sessionServiceBridge.js"),
            ]
        })
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            SessionServiceError::new(
                "session_service_bridge_unavailable",
                "未找到构建后的 sessionServiceBridge.js。",
            )
        })
}

fn resolve_node() -> Result<PathBuf, SessionServiceError> {
    if let Some(path) = environment_file("DEEPCODE_NODE") {
        return Ok(path);
    }
    let executable = std::env::current_exe().map_err(|error| {
        SessionServiceError::new(
            "session_service_asset_root_unavailable",
            format!("无法定位 Daemon 可执行文件：{error}"),
        )
    })?;
    let executable_name = if cfg!(windows) { "node.exe" } else { "node" };
    let mut candidates = executable
        .parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .flat_map(|ancestor| {
            [
                ancestor.join("node/bin").join(executable_name),
                ancestor.join("bin").join(executable_name),
            ]
        })
        .collect::<Vec<_>>();
    if !cfg!(windows) {
        candidates.extend(
            [
                "/opt/homebrew/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node",
            ]
            .into_iter()
            .map(PathBuf::from),
        );
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            SessionServiceError::new(
                "session_service_node_unavailable",
                "未找到 Node 20+ runtime。",
            )
        })
}

fn environment_file(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
}

fn process_write_error(error: std::io::Error) -> SessionServiceError {
    SessionServiceError::new(
        "session_service_request_write_failed",
        format!("写入 Session Service 请求失败：{error}"),
    )
}

fn process_wait_error(error: std::io::Error) -> SessionServiceError {
    SessionServiceError::new(
        "session_service_wait_failed",
        format!("检查 Session Service 状态失败：{error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn local_frame_reader_accepts_payload_at_transport_limit() {
        let mut encoded = vec![b'x'; MAX_FRAME_BYTES];
        encoded.push(b'\n');
        let mut reader = BufReader::new(Cursor::new(encoded));

        let frame = read_frame(&mut reader).expect("frame at limit");

        assert_eq!(frame.len(), MAX_FRAME_BYTES);
        assert!(frame.iter().all(|byte| *byte == b'x'));
    }

    #[test]
    fn local_frame_reader_rejects_oversized_payload_before_line_completion() {
        let mut encoded = vec![b'x'; MAX_FRAME_BYTES + 1];
        encoded.push(b'\n');
        let mut reader = BufReader::new(Cursor::new(encoded));

        let error = read_frame(&mut reader).expect_err("oversized frame rejected");

        assert_eq!(error.code, "session_service_response_invalid");
        assert!(error.message.contains("transport 上限"));
    }

    #[test]
    fn local_frame_reader_distinguishes_missing_and_unterminated_responses() {
        let mut empty = BufReader::new(Cursor::new(Vec::<u8>::new()));
        assert_eq!(
            read_frame(&mut empty).expect_err("missing frame").code,
            "session_service_response_missing"
        );

        let mut unterminated = BufReader::new(Cursor::new(b"{}".to_vec()));
        assert_eq!(
            read_frame(&mut unterminated)
                .expect_err("unterminated frame")
                .code,
            "session_service_response_invalid"
        );
    }

    #[test]
    fn stderr_receipt_is_bounded_to_the_latest_bytes() {
        let receipt = Arc::new(Mutex::new(Vec::new()));
        let input = vec![b'e'; MAX_STDERR_RECEIPT_BYTES + 7];

        append_stderr_receipt(&receipt, &input);

        let stored = receipt.lock().expect("stderr receipt");
        assert_eq!(stored.len(), MAX_STDERR_RECEIPT_BYTES);
        assert_eq!(stored.as_slice(), &input[7..]);
    }
}
