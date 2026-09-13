//! Native Windows workspace execution. Setup is explicit; ordinary invocations
//! run as the dedicated local account with a fresh write-restricted token.
use super::*;
use crate::shell_environment::ShellProgram;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ALL_ACCESS, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ,
};

mod os;
mod runner;
mod setup;

#[derive(Serialize, Deserialize)]
struct Installation {
    account: String,
    account_sid: String,
    protected_password: String,
    network_filters: Vec<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Request {
    executable: PathBuf,
    arguments: Vec<String>,
    cwd: PathBuf,
    write_sid: String,
    temporary: PathBuf,
    stdin: Option<String>,
    environment: BTreeMap<String, String>,
}

fn installation_path() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA")
        .map(|root| {
            PathBuf::from(root)
                .join("DeepCode")
                .join("workspace-sandbox.json")
        })
        .ok_or_else(|| "LOCALAPPDATA is unavailable.".into())
}

fn installation() -> Result<Installation, String> {
    serde_json::from_slice(&fs::read(installation_path()?).map_err(|error| format!("Windows workspace sandbox is not initialized: {error}. Initialize it in Execution environment settings."))?)
        .map_err(|error| format!("Read Windows sandbox configuration: {error}"))
}

pub fn probe() -> SandboxStatus {
    SandboxStatus::observed(
        "windows-restricted-token",
        (|| {
            let state = installation()?;
            setup::check(&state)
        })(),
    )
}

/// This is an operator action, never a Provider-callable tool.
pub fn request_setup() -> Result<(), String> {
    let path = installation_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let owner = os::current_user_sid()?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let args = [
        "--workspace-sandbox-setup".into(),
        path.to_string_lossy().into_owned(),
        owner,
    ];
    let command = format!("$p = Start-Process -FilePath '{}' -ArgumentList '{}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode", exe.to_string_lossy().replace('\'', "''"), args.iter().map(|s| os::quote(s)).collect::<Vec<_>>().join(" ").replace('\'', "''"));
    let shell = crate::shell_environment::discover("powershell").map_err(|e| e.to_string())?;
    let output = std::process::Command::new(&shell.executable)
        .args(crate::shell_environment::script_arguments(&shell, &command))
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Windows sandbox setup was not completed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    setup::check(&installation()?)
}

pub(crate) struct WorkspaceGrants {
    pub program: PathBuf,
    pub arguments: Vec<OsString>,
    paths: Vec<PathBuf>,
    sid: String,
    error_file: PathBuf,
}

impl WorkspaceGrants {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn prepare(
        shell: &ShellProgram,
        args: &[String],
        root: &Path,
        mode: &str,
        targets: Option<&[crate::executors::WorkspaceWriteTarget]>,
        temp: &Path,
        _scope: &str,
        stdin: Option<&str>,
    ) -> KernelResult<Self> {
        let state = installation().map_err(|e| unavailable(&shell.tool, e))?;
        let program =
            std::env::current_exe().map_err(|e| unavailable(&shell.tool, e.to_string()))?;
        let sid = os::new_capability_sid().map_err(|e| unavailable(&shell.tool, e))?;
        let mut grants = Self {
            program,
            arguments: Vec::new(),
            paths: Vec::new(),
            sid,
            error_file: temp.join("sandbox-error.txt"),
        };
        let result = (|| -> Result<(), String> {
            // The bootstrap account can traverse/read the toolchain. The user
            // command's restricting SID is granted writes only for this call.
            for path in [
                Some(root),
                std::env::var_os("USERPROFILE").as_deref().map(Path::new),
                shell.executable.parent(),
                grants.program.parent(),
            ]
            .into_iter()
            .flatten()
            {
                os::grant(
                    path,
                    &state.account_sid,
                    FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                )?;
            }
            os::grant(temp, &state.account_sid, FILE_ALL_ACCESS)?;
            let scratch = temp.join("scratch");
            fs::create_dir(&scratch).map_err(|e| e.to_string())?;
            let mut paths = writable_paths(root, mode, targets).map_err(|e| e.to_string())?;
            paths.push(scratch.clone());
            for path in paths {
                os::grant(&path, &state.account_sid, FILE_ALL_ACCESS)?;
                os::grant(&path, &grants.sid, FILE_ALL_ACCESS)?;
                grants.paths.push(path);
            }
            let request = Request {
                executable: shell.executable.clone(),
                arguments: args.to_vec(),
                cwd: root.into(),
                write_sid: grants.sid.clone(),
                temporary: scratch,
                stdin: stdin.map(Into::into),
                environment: BTreeMap::new(),
            };
            let request_path = temp.join("sandbox-request.json");
            fs::write(
                &request_path,
                serde_json::to_vec(&request).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            // A PowerShell script may have been materialized outside our temp root.
            if shell.tool == "powershell" {
                if let Some(script) = args.last() {
                    os::grant(Path::new(script), &state.account_sid, FILE_GENERIC_READ)?;
                }
            }
            grants.arguments = vec![
                "--workspace-sandbox-proxy".into(),
                request_path.into_os_string(),
            ];
            Ok(())
        })();
        result.map_err(|e| unavailable(&shell.tool, e))?;
        Ok(grants)
    }

    pub(crate) fn startup_result(&mut self) -> KernelResult<()> {
        let startup = match fs::read_to_string(&self.error_file) {
            Ok(message) => Err(KernelError::Structured {
                code: "workspace_shell_start_failed",
                stage: "execution",
                message,
                details: serde_json::json!({}),
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(KernelError::Other(format!(
                "Read Shell startup result: {error}"
            ))),
        };
        let cleanup = self.release().map_err(KernelError::Other);
        startup.and(cleanup)
    }
}

impl WorkspaceGrants {
    fn release(&mut self) -> Result<(), String> {
        let mut failure = None;
        for path in std::mem::take(&mut self.paths).into_iter().rev() {
            if path.exists() {
                if let Err(error) = os::revoke(&path, &self.sid) {
                    failure.get_or_insert(error);
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }
}
impl Drop for WorkspaceGrants {
    fn drop(&mut self) {
        if let Err(error) = self.release() {
            eprintln!("Release workspace Shell grant: {error}");
        }
    }
}

/// Reuse the packaged Kernel binary for short-lived platform helpers. These
/// entry points do not open a Session store, provider or listening Host service.
pub fn entrypoint() -> Option<Result<i32, String>> {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--workspace-sandbox-init") => Some(request_setup().map(|_| 0)),
        Some("--workspace-sandbox-setup") => Some((|| {
            setup::install(
                Path::new(args.get(2).ok_or("Setup path missing")?),
                args.get(3).ok_or("Owner SID missing")?,
            )?;
            Ok(0)
        })()),
        Some("--workspace-sandbox-proxy") => Some((|| {
            let path = Path::new(args.get(2).ok_or("Request path missing")?);
            match runner::proxy(path) {
                Ok(code) => Ok(code),
                Err(error) => {
                    fs::write(path.with_file_name("sandbox-error.txt"), &error)
                        .map_err(|e| e.to_string())?;
                    Err(error)
                }
            }
        })()),
        Some("--workspace-sandbox-worker") => Some((|| {
            runner::worker(
                Path::new(args.get(2).ok_or("Request path missing")?),
                args.get(3).ok_or("Pipe missing")?,
            )
        })()),
        _ => None,
    }
}
