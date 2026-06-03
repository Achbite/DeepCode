use crate::{SkillInvocation, SkillResult, SkillRuntime};
use deepcode_kernel_abi::{KernelError, KernelResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInvocation {
    pub invocation_id: String,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub skill_id: Option<String>,
    pub connector_id: Option<String>,
    pub command: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub stdin_payload: Option<String>,
    pub policy: ProcessExecutionPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessExecutionPolicy {
    pub timeout_ms: u64,
    pub max_stdout_bytes: usize,
    pub max_stderr_bytes: usize,
    pub env_allowlist: Vec<String>,
    pub cwd_scope: CwdScope,
    pub network_policy: NetworkPolicy,
}

impl Default for ProcessExecutionPolicy {
    fn default() -> Self {
        Self {
            timeout_ms: 3_000,
            max_stdout_bytes: 16 * 1024,
            max_stderr_bytes: 16 * 1024,
            env_allowlist: Vec::new(),
            cwd_scope: CwdScope::ProcessDefault,
            network_policy: NetworkPolicy::Deny,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CwdScope {
    ProcessDefault,
    Fixed { path: String },
    UnderRoot { root: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NetworkPolicy {
    Deny,
    Allowlist { hosts: Vec<String> },
}

impl NetworkPolicy {
    pub fn permits_network(&self) -> bool {
        matches!(self, Self::Allowlist { hosts } if !hosts.is_empty())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessExecutionResult {
    pub invocation_id: String,
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout_preview: String,
    pub stderr_preview: String,
    pub truncated_stdout: bool,
    pub truncated_stderr: bool,
    pub error: Option<String>,
    pub lifecycle_events: Vec<ProcessLifecycleEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLifecycleEvent {
    pub kind: ProcessLifecycleEventKind,
    pub invocation_id: String,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub skill_id: Option<String>,
    pub connector_id: Option<String>,
    pub redacted_summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessLifecycleEventKind {
    Started,
    Completed,
    Rejected,
    TimedOut,
    CircuitOpen,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CircuitBreakerPolicy {
    pub failure_threshold: u32,
}

impl Default for CircuitBreakerPolicy {
    fn default() -> Self {
        Self {
            failure_threshold: 3,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProcessCircuitBreaker {
    policy: CircuitBreakerPolicy,
    failures_by_key: BTreeMap<String, u32>,
}

impl ProcessCircuitBreaker {
    pub fn new(policy: CircuitBreakerPolicy) -> Self {
        Self {
            policy,
            failures_by_key: BTreeMap::new(),
        }
    }

    pub fn assert_can_invoke(&self, key: &str) -> KernelResult<()> {
        let failures = self.failures_by_key.get(key).copied().unwrap_or(0);
        if failures >= self.policy.failure_threshold {
            return Err(KernelError::PermissionDenied(format!(
                "process invocation circuit breaker is open for {key}"
            )));
        }
        Ok(())
    }

    pub fn record_result(&mut self, key: &str, ok: bool) {
        if ok {
            self.failures_by_key.remove(key);
            return;
        }
        *self.failures_by_key.entry(key.to_string()).or_default() += 1;
    }

    pub fn failures_for(&self, key: &str) -> u32 {
        self.failures_by_key.get(key).copied().unwrap_or(0)
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProcessSupervisor {
    circuit_breaker: ProcessCircuitBreaker,
}

impl ProcessSupervisor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_circuit_breaker(circuit_breaker: ProcessCircuitBreaker) -> Self {
        Self { circuit_breaker }
    }

    pub fn invoke(
        &mut self,
        invocation: ProcessInvocation,
    ) -> KernelResult<ProcessExecutionResult> {
        let breaker_key = invocation_breaker_key(&invocation);
        if let Err(error) = self.circuit_breaker.assert_can_invoke(&breaker_key) {
            return Ok(rejected_result(
                invocation,
                ProcessLifecycleEventKind::CircuitOpen,
                error.to_string(),
            ));
        }

        match self.invoke_inner(invocation) {
            Ok(result) => {
                self.circuit_breaker
                    .record_result(&breaker_key, result.ok && !result.timed_out);
                Ok(result)
            }
            Err(error) => {
                self.circuit_breaker.record_result(&breaker_key, false);
                Err(error)
            }
        }
    }

    fn invoke_inner(&self, invocation: ProcessInvocation) -> KernelResult<ProcessExecutionResult> {
        if invocation.command.is_empty() {
            return Ok(rejected_result(
                invocation,
                ProcessLifecycleEventKind::Rejected,
                "process invocation command is required".to_string(),
            ));
        }
        validate_env(&invocation)?;
        let cwd = resolve_cwd(&invocation.policy.cwd_scope, invocation.cwd.as_deref())?;

        let mut command = Command::new(&invocation.command[0]);
        command.args(invocation.command.iter().skip(1));
        command.env_clear();
        for (key, value) in &invocation.env {
            command.env(key, value);
        }
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        if invocation.stdin_payload.is_some() {
            command.stdin(Stdio::piped());
        } else {
            command.stdin(Stdio::null());
        }
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|error| {
            KernelError::Other(format!(
                "spawn supervised process {}: {error}",
                invocation.command[0]
            ))
        })?;

        if let Some(payload) = &invocation.stdin_payload {
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(payload.as_bytes()).map_err(|error| {
                    KernelError::Other(format!("write supervised process stdin: {error}"))
                })?;
            }
        }

        let deadline = Instant::now() + Duration::from_millis(invocation.policy.timeout_ms.max(1));
        let mut timed_out = false;
        loop {
            if child
                .try_wait()
                .map_err(|error| KernelError::Other(format!("poll supervised process: {error}")))?
                .is_some()
            {
                break;
            }
            if Instant::now() >= deadline {
                timed_out = true;
                child.kill().map_err(|error| {
                    KernelError::Other(format!("kill supervised process: {error}"))
                })?;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }

        let output = child.wait_with_output().map_err(|error| {
            KernelError::Other(format!("collect supervised process output: {error}"))
        })?;
        let exit_code = output.status.code();
        let ok = output.status.success() && !timed_out;
        let stdout_preview = truncate_utf8(&output.stdout, invocation.policy.max_stdout_bytes);
        let stderr_preview = truncate_utf8(&output.stderr, invocation.policy.max_stderr_bytes);
        let mut lifecycle_events = vec![lifecycle(
            &invocation,
            ProcessLifecycleEventKind::Started,
            "process invocation started",
        )];
        lifecycle_events.push(lifecycle(
            &invocation,
            if timed_out {
                ProcessLifecycleEventKind::TimedOut
            } else {
                ProcessLifecycleEventKind::Completed
            },
            if ok {
                "process invocation completed"
            } else if timed_out {
                "process invocation timed out"
            } else {
                "process invocation exited with error"
            },
        ));

        let error = (!ok).then(|| {
            if timed_out {
                "supervised process timed out".to_string()
            } else {
                format!("supervised process exited with {exit_code:?}")
            }
        });

        Ok(ProcessExecutionResult {
            invocation_id: invocation.invocation_id,
            ok,
            exit_code,
            timed_out,
            stdout_preview,
            stderr_preview,
            truncated_stdout: output.stdout.len() > invocation.policy.max_stdout_bytes,
            truncated_stderr: output.stderr.len() > invocation.policy.max_stderr_bytes,
            error,
            lifecycle_events,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProcessSkillSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env_allowlist: Vec<String>,
    pub timeout_ms: u64,
    pub stdout_limit_bytes: usize,
    pub stderr_limit_bytes: usize,
}

impl ExternalProcessSkillSpec {
    pub fn python_inline(code: impl Into<String>) -> Self {
        Self {
            command: "python3".to_string(),
            args: vec!["-c".to_string(), code.into()],
            cwd: None,
            env_allowlist: Vec::new(),
            timeout_ms: 3_000,
            stdout_limit_bytes: 16 * 1024,
            stderr_limit_bytes: 16 * 1024,
        }
    }

    fn policy(&self) -> ProcessExecutionPolicy {
        ProcessExecutionPolicy {
            timeout_ms: self.timeout_ms,
            max_stdout_bytes: self.stdout_limit_bytes,
            max_stderr_bytes: self.stderr_limit_bytes,
            env_allowlist: self.env_allowlist.clone(),
            cwd_scope: self
                .cwd
                .as_ref()
                .map(|path| CwdScope::Fixed { path: path.clone() })
                .unwrap_or(CwdScope::ProcessDefault),
            network_policy: NetworkPolicy::Deny,
        }
    }
}

#[derive(Debug)]
pub struct ExternalProcessSkillRuntime {
    spec: ExternalProcessSkillSpec,
    supervisor: Mutex<ProcessSupervisor>,
}

impl ExternalProcessSkillRuntime {
    pub fn new(spec: ExternalProcessSkillSpec) -> Self {
        Self {
            spec,
            supervisor: Mutex::new(ProcessSupervisor::new()),
        }
    }
}

impl SkillRuntime for ExternalProcessSkillRuntime {
    fn invoke(&self, invocation: SkillInvocation) -> KernelResult<SkillResult> {
        let mut command = Vec::with_capacity(1 + self.spec.args.len());
        command.push(self.spec.command.clone());
        command.extend(self.spec.args.clone());
        if let Some(extra_args) = invocation
            .input
            .get("args")
            .and_then(serde_json::Value::as_array)
        {
            for arg in extra_args {
                let value = arg.as_str().ok_or_else(|| {
                    KernelError::InvalidCommand(
                        "external process skill args must be strings".to_string(),
                    )
                })?;
                command.push(value.to_string());
            }
        }
        let stdin_payload = invocation
            .input
            .get("stdin")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let env = self
            .spec
            .env_allowlist
            .iter()
            .filter_map(|key| std::env::var(key).ok().map(|value| (key.clone(), value)))
            .collect::<Vec<_>>();
        let process_invocation = ProcessInvocation {
            invocation_id: invocation.id.clone(),
            run_id: invocation.run_id.clone(),
            session_id: invocation.session_id.clone(),
            skill_id: Some(invocation.skill_id),
            connector_id: None,
            command,
            cwd: self.spec.cwd.clone(),
            env,
            stdin_payload,
            policy: self.spec.policy(),
        };
        let result = self
            .supervisor
            .lock()
            .expect("external process supervisor lock")
            .invoke(process_invocation)?;
        Ok(SkillResult {
            invocation_id: invocation.id,
            ok: result.ok,
            output: serde_json::json!({
                "exitCode": result.exit_code,
                "timedOut": result.timed_out,
                "stdout": result.stdout_preview,
                "stderr": result.stderr_preview,
                "stdoutTruncated": result.truncated_stdout,
                "stderrTruncated": result.truncated_stderr,
                "lifecycleEvents": result.lifecycle_events
            }),
            error: result.error,
        })
    }
}

fn invocation_breaker_key(invocation: &ProcessInvocation) -> String {
    invocation
        .skill_id
        .as_ref()
        .or(invocation.connector_id.as_ref())
        .cloned()
        .unwrap_or_else(|| invocation.command.first().cloned().unwrap_or_default())
}

fn validate_env(invocation: &ProcessInvocation) -> KernelResult<()> {
    for (key, _) in &invocation.env {
        if !invocation.policy.env_allowlist.contains(key) {
            return Err(KernelError::PermissionDenied(format!(
                "environment variable {key} is not in the process env allowlist"
            )));
        }
    }
    Ok(())
}

fn resolve_cwd(scope: &CwdScope, requested: Option<&str>) -> KernelResult<Option<PathBuf>> {
    match scope {
        CwdScope::ProcessDefault => Ok(None),
        CwdScope::Fixed { path } => {
            if let Some(requested) = requested {
                if normalize_path(requested) != normalize_path(path) {
                    return Err(KernelError::PermissionDenied(
                        "process cwd does not match fixed cwd scope".to_string(),
                    ));
                }
            }
            Ok(Some(PathBuf::from(path)))
        }
        CwdScope::UnderRoot { root } => {
            let Some(requested) = requested else {
                return Ok(Some(PathBuf::from(root)));
            };
            let root = PathBuf::from(root);
            let requested = PathBuf::from(requested);
            if requested
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
            {
                return Err(KernelError::PermissionDenied(
                    "process cwd escapes allowed root".to_string(),
                ));
            }
            if requested.is_absolute() {
                if path_within(&requested, &root) {
                    return Ok(Some(requested));
                }
                return Err(KernelError::PermissionDenied(
                    "process cwd escapes allowed root".to_string(),
                ));
            }
            let combined = root.join(requested);
            if !path_within(&combined, &root) {
                return Err(KernelError::PermissionDenied(
                    "process cwd escapes allowed root".to_string(),
                ));
            }
            Ok(Some(combined))
        }
    }
}

fn rejected_result(
    invocation: ProcessInvocation,
    kind: ProcessLifecycleEventKind,
    error: String,
) -> ProcessExecutionResult {
    ProcessExecutionResult {
        invocation_id: invocation.invocation_id.clone(),
        ok: false,
        exit_code: None,
        timed_out: false,
        stdout_preview: String::new(),
        stderr_preview: String::new(),
        truncated_stdout: false,
        truncated_stderr: false,
        error: Some(error.clone()),
        lifecycle_events: vec![lifecycle(&invocation, kind, &error)],
    }
}

fn lifecycle(
    invocation: &ProcessInvocation,
    kind: ProcessLifecycleEventKind,
    redacted_summary: impl Into<String>,
) -> ProcessLifecycleEvent {
    ProcessLifecycleEvent {
        kind,
        invocation_id: invocation.invocation_id.clone(),
        run_id: invocation.run_id.clone(),
        session_id: invocation.session_id.clone(),
        skill_id: invocation.skill_id.clone(),
        connector_id: invocation.connector_id.clone(),
        redacted_summary: redacted_summary.into(),
    }
}

fn truncate_utf8(bytes: &[u8], limit: usize) -> String {
    let limit = limit.min(bytes.len());
    String::from_utf8_lossy(&bytes[..limit]).to_string()
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn path_within(path: &Path, root: &Path) -> bool {
    let mut depth = 0usize;
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
            }
            std::path::Component::Normal(_) => depth += 1,
            _ => {}
        }
    }
    path.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SkillInvocation;

    fn python_invocation(code: &str) -> ProcessInvocation {
        ProcessInvocation {
            invocation_id: "invoke-python".to_string(),
            run_id: Some("run-1".to_string()),
            session_id: Some("session-1".to_string()),
            skill_id: Some("fixture.text.transform".to_string()),
            connector_id: None,
            command: vec!["python3".to_string(), "-c".to_string(), code.to_string()],
            cwd: None,
            env: Vec::new(),
            stdin_payload: None,
            policy: ProcessExecutionPolicy::default(),
        }
    }

    #[test]
    fn supervisor_runs_process_and_records_lifecycle() {
        let mut supervisor = ProcessSupervisor::new();
        let result = supervisor
            .invoke(python_invocation("print('skill-ok')"))
            .unwrap();
        assert!(result.ok);
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout_preview, "skill-ok\n");
        assert_eq!(result.lifecycle_events.len(), 2);
        assert_eq!(
            result.lifecycle_events[0].kind,
            ProcessLifecycleEventKind::Started
        );
    }

    #[test]
    fn supervisor_times_out_process() {
        let mut invocation = python_invocation("import time; time.sleep(3); print('late')");
        invocation.policy.timeout_ms = 50;
        let mut supervisor = ProcessSupervisor::new();
        let result = supervisor.invoke(invocation).unwrap();
        assert!(!result.ok);
        assert!(result.timed_out);
        assert!(result.error.unwrap().contains("timed out"));
        assert_eq!(
            result.lifecycle_events[1].kind,
            ProcessLifecycleEventKind::TimedOut
        );
    }

    #[test]
    fn supervisor_truncates_stdout_and_stderr() {
        let mut invocation =
            python_invocation("import sys; print('abcdef'); print('ghijkl', file=sys.stderr)");
        invocation.policy.max_stdout_bytes = 3;
        invocation.policy.max_stderr_bytes = 2;
        let mut supervisor = ProcessSupervisor::new();
        let result = supervisor.invoke(invocation).unwrap();
        assert!(result.ok);
        assert_eq!(result.stdout_preview, "abc");
        assert_eq!(result.stderr_preview, "gh");
        assert!(result.truncated_stdout);
        assert!(result.truncated_stderr);
    }

    #[test]
    fn supervisor_rejects_env_outside_allowlist() {
        let mut invocation = python_invocation("print('env')");
        invocation.env = vec![("SECRET_TOKEN".to_string(), "secret".to_string())];
        let mut supervisor = ProcessSupervisor::new();
        let error = supervisor.invoke(invocation).unwrap_err();
        assert!(matches!(error, KernelError::PermissionDenied(_)));
    }

    #[test]
    fn supervisor_rejects_cwd_escape() {
        let mut invocation = python_invocation("print('cwd')");
        invocation.cwd = Some("../outside".to_string());
        invocation.policy.cwd_scope = CwdScope::UnderRoot {
            root: "/workspace/project".to_string(),
        };
        let mut supervisor = ProcessSupervisor::new();
        let error = supervisor.invoke(invocation).unwrap_err();
        assert!(matches!(error, KernelError::PermissionDenied(_)));
    }

    #[test]
    fn supervisor_opens_circuit_after_threshold() {
        let breaker = ProcessCircuitBreaker::new(CircuitBreakerPolicy {
            failure_threshold: 1,
        });
        let mut supervisor = ProcessSupervisor::with_circuit_breaker(breaker);
        let first = supervisor
            .invoke(python_invocation("import sys; sys.exit(7)"))
            .unwrap();
        assert!(!first.ok);
        let second = supervisor
            .invoke(python_invocation("print('blocked')"))
            .unwrap();
        assert!(!second.ok);
        assert_eq!(
            second.lifecycle_events[0].kind,
            ProcessLifecycleEventKind::CircuitOpen
        );
    }

    #[test]
    fn external_process_skill_runtime_uses_supervisor() {
        let runtime = ExternalProcessSkillRuntime::new(ExternalProcessSkillSpec::python_inline(
            "print('skill-ok')",
        ));
        let result = runtime
            .invoke(SkillInvocation {
                id: "invoke-python".to_string(),
                run_id: Some("run-1".to_string()),
                session_id: Some("session-1".to_string()),
                skill_id: "external.python.echo".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({}),
            })
            .unwrap();
        assert!(result.ok);
        assert_eq!(result.output["exitCode"], 0);
        assert_eq!(result.output["stdout"], "skill-ok\n");
        assert!(result.output["lifecycleEvents"].is_array());
    }

    #[test]
    fn external_process_skill_accepts_stdin_payload() {
        let runtime = ExternalProcessSkillRuntime::new(ExternalProcessSkillSpec::python_inline(
            "import json,sys; payload=json.load(sys.stdin); print(payload['text'].upper())",
        ));
        let result = runtime
            .invoke(SkillInvocation {
                id: "invoke-stdin".to_string(),
                run_id: Some("run-1".to_string()),
                session_id: Some("session-1".to_string()),
                skill_id: "external.python.stdin".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({ "stdin": "{\"text\":\"hello\"}" }),
            })
            .unwrap();
        assert!(result.ok);
        assert_eq!(result.output["stdout"], "HELLO\n");
    }
}
