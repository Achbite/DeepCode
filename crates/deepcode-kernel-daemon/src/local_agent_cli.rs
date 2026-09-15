//! Direct CLI execution, pinned to the prepared contribution and owned by one attempt.
use crate::local_agent_mcp::{McpRuntimeError, McpToolCallFailure, McpToolCallResult};
use deepcode_kernel_runtime::executors::KernelToolExecutionContext;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, Debug)]
pub(crate) struct CliClient {
    pub command: String,
    pub args: Vec<String>,
    /// Local single-file bundle bytes are captured at preparation, before authorization waits.
    pub entry: Option<(String, Vec<u8>)>,
}
impl CliClient {
    pub(crate) fn call(
        &self,
        name: &str,
        arguments: Value,
        metadata: Option<Value>,
        context: &KernelToolExecutionContext,
    ) -> Result<McpToolCallResult, McpRuntimeError> {
        let fail = |code, message| McpRuntimeError::new(code, message);
        if context.cancellation.is_cancelled() {
            return Err(fail(
                "tool_cancelled",
                "CLI call cancelled before spawn".into(),
            ));
        }
        let mut command = Command::new(&self.command);
        if let Some((filename, bytes)) = &self.entry {
            let archive = context.output_directory.as_ref().ok_or_else(|| {
                fail(
                    "cli_archive_missing",
                    "CLI bundle requires an attempt archive".into(),
                )
            })?;
            std::fs::create_dir_all(archive)
                .map_err(|error| fail("cli_bundle_write_failed", error.to_string()))?;
            let path = archive.join(format!("plugin-{filename}"));
            std::fs::write(&path, bytes)
                .map_err(|error| fail("cli_bundle_write_failed", error.to_string()))?;
            command.arg(path);
        }
        command
            .args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(directory) = &context.workspace_root {
            command.current_dir(directory);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command
            .spawn()
            .map_err(|error| fail("cli_spawn_failed", format!("{}: {error}", self.command)))?;
        let mut owned = OwnedCli(child, false);
        let mut stdin = owned
            .0
            .stdin
            .take()
            .ok_or_else(|| fail("cli_pipe_failed", "stdin is unavailable".into()))?;
        let stdout = owned
            .0
            .stdout
            .take()
            .ok_or_else(|| fail("cli_pipe_failed", "stdout is unavailable".into()))?;
        let stderr = owned
            .0
            .stderr
            .take()
            .ok_or_else(|| fail("cli_pipe_failed", "stderr is unavailable".into()))?;
        let output = std::thread::spawn(move || bounded_output(stdout, 4 * 1024 * 1024));
        let errors = std::thread::spawn(move || bounded_output(stderr, 64 * 1024));
        // Writing also runs on a pipe worker so cancellation can stop a non-reading process.
        let request = json!({"name":name,"arguments":arguments,"context":metadata});
        let input = std::thread::spawn(move || {
            serde_json::to_writer(&mut stdin, &request)
                .map_err(|error| error.to_string())
                .and_then(|_| stdin.flush().map_err(|error| error.to_string()))
        });
        let start = Instant::now();
        let status = loop {
            if context.cancellation.is_cancelled() {
                break Err(fail("tool_cancelled", "CLI call cancelled".into()));
            }
            if start.elapsed() >= Duration::from_secs(60) {
                break Err(fail("cli_timeout", "CLI call exceeded 60 seconds".into()));
            }
            match owned.0.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(error) => break Err(fail("cli_wait_failed", error.to_string())),
            }
        };
        owned.stop(); // Reap this attempt's process group, including pipe-holding children.
        let input = input
            .join()
            .map_err(|_| fail("cli_input_failed", "CLI stdin worker failed".into()))?;
        let output = output
            .join()
            .map_err(|_| fail("cli_output_failed", "CLI stdout worker failed".into()))?
            .map_err(|message| fail("cli_output_failed", message))?;
        let errors = errors
            .join()
            .map_err(|_| fail("cli_output_failed", "CLI stderr worker failed".into()))?
            .map_err(|message| fail("cli_output_failed", message))?;
        let status = status?;
        if !status.success() {
            return Err(fail(
                "cli_process_failed",
                format!(
                    "{} exited {status}: {}",
                    self.command,
                    String::from_utf8_lossy(&errors)
                ),
            ));
        }
        input.map_err(|message| fail("cli_input_failed", message))?;
        let value: Value = serde_json::from_slice(&output).map_err(|error| {
            fail(
                "cli_output_invalid",
                format!("CLI must return one JSON result: {error}"),
            )
        })?;
        let failure = value
            .get("error")
            .filter(|error| !error.is_null())
            .map(|error| McpToolCallFailure {
                code: error["code"]
                    .as_str()
                    .unwrap_or("cli_tool_failed")
                    .to_string(),
                message: error["message"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| error.to_string()),
            });
        Ok(McpToolCallResult {
            output: value,
            failure,
        })
    }
}
fn bounded_output(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    let mut buffer = [0; 8192];
    let mut overflow = false;
    loop {
        let size = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if size == 0 {
            break;
        }
        let keep = size.min(limit.saturating_sub(result.len()));
        result.extend_from_slice(&buffer[..keep]);
        overflow |= keep < size;
    }
    if overflow {
        Err(format!("CLI output exceeds {limit} bytes"))
    } else {
        Ok(result)
    }
}
struct OwnedCli(Child, bool);
impl OwnedCli {
    fn stop(&mut self) {
        if self.1 {
            return;
        }
        self.1 = true;
        #[cfg(unix)]
        unsafe {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            kill(-(self.0.id() as i32), 9);
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &self.0.id().to_string(), "/T", "/F"])
                .output();
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Drop for OwnedCli {
    fn drop(&mut self) {
        self.stop();
    }
}
