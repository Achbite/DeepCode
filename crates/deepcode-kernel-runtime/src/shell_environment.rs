//! Shell discovery shared by runtime preparation and the process executor.
//! No command is translated or retried in a different shell.
use deepcode_kernel_abi::{KernelError, KernelResult};
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellProgram {
    pub tool: String,
    pub executable: PathBuf,
    pub dialect: String,
}

pub fn discover(tool: &str) -> KernelResult<ShellProgram> {
    let program = match tool {
        "powershell" => find_powershell7()
            .map(|p| (p, "powershell7"))
            .or_else(|| find_windows_powershell().map(|p| (p, "windowsPowerShell"))),
        "bash" if cfg!(windows) => git_bash().map(|p| (p, "bash")),
        "bash" => find_command("bash").map(|p| (p, "bash")),
        _ => None,
    };
    program
        .map(|(executable, dialect)| ShellProgram {
            tool: tool.into(),
            executable,
            dialect: dialect.into(),
        })
        .ok_or_else(|| KernelError::Structured {
            code: if tool == "powershell" {
                "powershell_unavailable"
            } else {
                "bash_unavailable"
            },
            stage: "execution",
            message: format!(
                "No {tool} executable is available in the selected native environment."
            ),
            details: serde_json::json!({"toolId": tool}),
        })
}

pub fn find_command(name: &str) -> Option<PathBuf> {
    command_candidates(name).find(|path| executable_file(path))
}

pub fn find_command_in(name: &str, directories: &[PathBuf]) -> Option<PathBuf> {
    command_candidates_in(name, directories.iter()).find(|path| executable_file(path))
}

fn command_candidates(name: &str) -> impl Iterator<Item = PathBuf> + '_ {
    let directories = std::env::split_paths(
        std::env::var_os("PATH")
            .as_deref()
            .unwrap_or(OsStr::new("")),
    )
    .collect::<Vec<_>>();
    command_candidates_in(name, directories.into_iter())
}

fn command_candidates_in<'a>(
    name: &'a str,
    directories: impl Iterator<Item = impl AsRef<Path>> + 'a,
) -> impl Iterator<Item = PathBuf> + 'a {
    directories.flat_map(move |directory| {
        let directory = directory.as_ref();
        if cfg!(windows) {
            ["exe", "cmd", "bat", "com"]
                .into_iter()
                .map(|extension| directory.join(format!("{name}.{extension}")))
                .collect::<Vec<_>>()
        } else {
            vec![directory.join(name)]
        }
    })
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn find_powershell7() -> Option<PathBuf> {
    command_candidates("pwsh")
        .find(|path| executable_file(path) && powershell_path_is_compatible(path))
        .or_else(|| {
            if !cfg!(windows) {
                return None;
            }
            let path =
                PathBuf::from(std::env::var_os("ProgramFiles")?).join("PowerShell/7/pwsh.exe");
            executable_file(&path).then_some(path)
        })
}

/// Store app execution aliases belong to the interactive user and cannot be
/// launched by the dedicated workspace account. Other WindowsApps packages may
/// contain ordinary executables, so only exclude PowerShell aliases/packages.
pub fn powershell_path_is_compatible(path: &Path) -> bool {
    if !cfg!(windows) {
        return true;
    }
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        && !is_store_powershell_path(path)
        && !path
            .canonicalize()
            .ok()
            .is_some_and(|path| is_store_powershell_path(&path))
}

fn is_store_powershell_path(path: &Path) -> bool {
    path.as_os_str()
        .to_string_lossy()
        .split(['\\', '/'])
        .skip_while(|part| !part.eq_ignore_ascii_case("WindowsApps"))
        .nth(1)
        .is_some_and(|part| {
            part.eq_ignore_ascii_case("pwsh.exe")
                || part.eq_ignore_ascii_case("powershell.exe")
                || part
                    .to_ascii_lowercase()
                    .starts_with("microsoft.powershell")
        })
}

pub fn find_windows_powershell() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    command_candidates("powershell")
        .find(|path| executable_file(path) && powershell_path_is_compatible(path))
        .or_else(|| {
            let path = PathBuf::from(std::env::var_os("SystemRoot")?)
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            executable_file(&path).then_some(path)
        })
}

fn git_bash() -> Option<PathBuf> {
    // Only a Git installation is eligible. System32/bash.exe belongs to WSL
    // and must never silently select a different filesystem/toolchain.
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        let Some(base) = std::env::var_os(variable) else {
            continue;
        };
        for suffix in ["Git/bin/bash.exe", "Programs/Git/bin/bash.exe"] {
            let path = PathBuf::from(&base).join(suffix);
            if executable_file(&path) {
                return Some(path);
            }
        }
    }
    let git = find_command("git")?;
    let installation = git.parent()?.parent()?;
    ["bin/bash.exe", "usr/bin/bash.exe"]
        .iter()
        .map(|p| installation.join(p))
        .find(|p| executable_file(p))
}

pub fn script_arguments(program: &ShellProgram, script: &str) -> Vec<String> {
    if program.tool == "powershell" {
        use base64::Engine;
        let script = format!("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n{script}");
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-EncodedCommand".into(),
            base64::engine::general_purpose::STANDARD.encode(bytes),
        ]
    } else {
        vec!["-c".into(), script.into()]
    }
}

/// Windows has a short process command-line limit. User scripts are passed as a
/// UTF-8 BOM file so long scripts, Unicode and multiline quoting remain intact.
pub(crate) struct ShellScript {
    pub arguments: Vec<String>,
    file: Option<PathBuf>,
}

impl ShellScript {
    pub fn prepare(program: &ShellProgram, script: &str) -> KernelResult<Self> {
        if program.tool != "powershell" {
            return Ok(Self {
                arguments: script_arguments(program, script),
                file: None,
            });
        }
        use std::io::Write;
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "deepcode-powershell-{}-{nonce}-{id}.ps1",
            std::process::id()
        ));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| KernelError::Other(format!("create PowerShell script: {error}")))?;
        let prepared = Self {
            arguments: vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                path.to_string_lossy().into_owned(),
            ],
            file: Some(path),
        };
        file.write_all(b"\xef\xbb\xbf[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n")
            .and_then(|_| file.write_all(script.as_bytes()))
            .map_err(|error| KernelError::Other(format!("write PowerShell script: {error}")))?;
        Ok(prepared)
    }
}

impl Drop for ShellScript {
    fn drop(&mut self) {
        if let Some(path) = &self.file {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_powershell_is_distinguished_from_portable_windows_apps_executables() {
        for path in [
            r"C:\Users\user\AppData\Local\Microsoft\WindowsApps\pwsh.exe",
            r"\\?\C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6_x64__example\pwsh.exe",
            r"C:/Program Files/WindowsApps/Microsoft.PowerShellPreview_7_x64__example/pwsh.exe",
        ] {
            assert!(is_store_powershell_path(Path::new(path)), "{path}");
        }
        for path in [
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Program Files\WindowsApps\OpenAI.CodexPrimaryRuntime\dependencies\native\powershell\pwsh.exe",
            r"C:\portable\NotWindowsApps\pwsh.exe",
        ] {
            assert!(!is_store_powershell_path(Path::new(path)), "{path}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn powershell_path_candidates_continue_after_store_aliases() {
        let candidates = [
            PathBuf::from(r"C:\Users\user\AppData\Local\Microsoft\WindowsApps\pwsh.exe"),
            PathBuf::from(r"C:\tools\pwsh.cmd"),
            PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe"),
        ];
        assert_eq!(
            candidates
                .iter()
                .find(|path| powershell_path_is_compatible(path)),
            Some(&candidates[2])
        );
    }
    #[test]
    fn long_powershell_scripts_use_a_scoped_file_without_changing_user_text() {
        let program = ShellProgram {
            tool: "powershell".into(),
            executable: "pwsh.exe".into(),
            dialect: "powershell7".into(),
        };
        let text = format!(
            "{}\nWrite-Output 'Unicode: 中文'; exit 7",
            "# A long script\n".repeat(5000)
        );
        let script = ShellScript::prepare(&program, &text).unwrap();
        let path = script.file.clone().unwrap();
        let contents = std::fs::read(&path).unwrap();
        assert!(contents.starts_with(b"\xef\xbb\xbf"));
        assert!(contents.ends_with(text.as_bytes()));
        assert!(script.arguments.iter().map(String::len).sum::<usize>() < 1024);
        assert_eq!(script.arguments[5], "-File");
        drop(script);
        assert!(!path.exists());
    }
    #[test]
    fn powershell_transports_multiline_unicode_without_windows_argument_requoting() {
        use base64::Engine;
        let script = "$p = 'C:\\资料 文件\\a.txt'\nWrite-Output \"$p `\"quoted`\"\"\nexit 7";
        let program = ShellProgram {
            tool: "powershell".into(),
            executable: "pwsh.exe".into(),
            dialect: "powershell7".into(),
        };
        let arguments = script_arguments(&program, script);
        assert_eq!(
            &arguments[..4],
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand"
            ]
        );
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&arguments[4])
            .unwrap();
        let text = String::from_utf16(
            &bytes
                .chunks_exact(2)
                .map(|v| u16::from_le_bytes([v[0], v[1]]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(text.ends_with(script));
        assert!(text.starts_with("[Console]::OutputEncoding"));
    }
}

pub fn resolved_agent_shell_path() -> KernelResult<OsString> {
    let host_path = std::env::var_os("PATH");
    resolved_agent_shell_path_from(host_path.as_deref())
}

pub fn resolved_agent_shell_path_from(host_path: Option<&OsStr>) -> KernelResult<OsString> {
    let mut configured_tool_paths = Vec::new();
    for key in ["PNPM_HOME"] {
        if let Some(path) = std::env::var_os(key) {
            configured_tool_paths.push(PathBuf::from(path));
        }
    }
    for key in ["CARGO_HOME", "GOPATH", "JAVA_HOME", "VOLTA_HOME"] {
        if let Some(path) = std::env::var_os(key) {
            configured_tool_paths.push(PathBuf::from(path).join("bin"));
        }
    }
    if let Some(path) = std::env::var_os("PYENV_ROOT") {
        let root = PathBuf::from(path);
        configured_tool_paths.push(root.join("shims"));
        configured_tool_paths.push(root.join("bin"));
    }
    compose_agent_shell_path(host_path, &configured_tool_paths)
}

/// Host startup/refresh probe. Tool invocations keep using the prepared PATH;
/// they do not source a user profile or change scope on failure.
#[cfg(unix)]
pub fn login_shell_path(shell: &Path) -> KernelResult<OsString> {
    use std::io::Read;
    use std::os::unix::{ffi::OsStringExt, process::CommandExt};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let failure = |message: String| {
        KernelError::InvalidCommand(format!("host_shell_environment_failed: {message}"))
    };
    let mut child = Command::new(shell)
        .args(["-ilc", "/usr/bin/printf '\\0DEEPCODE_HOST_PATH\\0' && /usr/bin/printenv PATH && /usr/bin/printf '\\0'"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::inherit())
        .process_group(0).spawn().map_err(|error| failure(error.to_string()))?;
    let pid = child.id();
    let stdout = child.stdout.take().expect("piped shell stdout");
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        stdout
            .take(64 * 1024)
            .read_to_end(&mut output)
            .map(|_| output)
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if start.elapsed() < Duration::from_secs(5) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Ok(None) => break Err(failure("login shell timed out after 5 seconds".into())),
            Err(error) => break Err(failure(error.to_string())),
        }
    };
    // Only the process group created by this probe is owned here.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    let _ = child.wait();
    let output = reader
        .join()
        .map_err(|_| failure("PATH reader failed".into()))?
        .map_err(|error| failure(error.to_string()))?;
    let status = status?;
    if !status.success() {
        return Err(failure(format!("login shell exited with {status}")));
    }
    let marker = b"\0DEEPCODE_HOST_PATH\0";
    let offset = output
        .windows(marker.len())
        .rposition(|part| part == marker)
        .ok_or_else(|| failure("login shell did not report PATH".into()))?
        + marker.len();
    let end = output[offset..]
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| failure("login shell PATH output is incomplete".into()))?
        + offset;
    let path = output[offset..end]
        .strip_suffix(b"\n")
        .unwrap_or(&output[offset..end]);
    if path.is_empty() || output.len() == 64 * 1024 {
        return Err(failure(
            "login shell reported an empty, invalid or truncated PATH".into(),
        ));
    }
    Ok(OsString::from_vec(path.to_vec()))
}

pub(crate) fn compose_agent_shell_path(
    host_path: Option<&OsStr>,
    configured_tool_paths: &[PathBuf],
) -> KernelResult<OsString> {
    let mut paths = Vec::new();
    for path in configured_tool_paths {
        push_existing_unique_path(&mut paths, path.clone());
    }
    if let Some(host_path) = host_path {
        for path in std::env::split_paths(host_path) {
            push_unique_path(&mut paths, path);
        }
    }
    std::env::join_paths(paths)
        .map_err(|error| KernelError::InvalidCommand(format!("Invalid execution PATH: {error}")))
}

fn push_existing_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_dir() {
        push_unique_path(paths, path);
    }
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}
