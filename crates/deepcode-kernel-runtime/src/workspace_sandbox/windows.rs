//! Native Windows workspace execution. Setup is explicit; ordinary invocations
//! run as the dedicated local account with a fresh write-restricted token.
use super::*;
use std::collections::BTreeMap;
use std::fs;

mod desktop;
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
    std::env::var_os("DEEPCODE_SANDBOX_STATE_PATH")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Host did not supply the Windows sandbox state path.".into())
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
    let command = format!("$p = Start-Process -FilePath '{}' -ArgumentList '{}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode", exe.to_string_lossy().replace('\'', "''"), args.iter().map(|s| os::quote(s)).collect::<Vec<_>>().join(" ").replace('\'', "''"));
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

/// Reuse the packaged Kernel binary for short-lived platform helpers. These
/// entry points do not open a Session store, provider or listening Host service.
pub fn entrypoint() -> Option<Result<i32, String>> {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
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
                Err(error) => match fs::write(path.with_file_name("sandbox-error.txt"), &error) {
                    Ok(()) => Err(error),
                    Err(write_error) => Err(format!(
                        "{error}; write Shell startup result: {write_error}"
                    )),
                },
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
