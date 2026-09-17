use deepcode_kernel_runtime::shell_environment::{self, ShellProgram};
use serde_json::{json, Value};
use std::path::PathBuf;

/// Recheck basic facts at each new run. A resumed run keeps its journaled snapshot.
pub(crate) fn prepare(
    settings: &Value,
    previous: Option<&Value>,
    restoring: bool,
) -> Result<Value, String> {
    validate_settings(settings)?;
    let configuration = json!({
        "executionTarget": settings.get("_executionTarget").cloned().unwrap_or_else(|| json!({"kind":"native"})),
        "responseLanguage": response_language_setting(settings)?,
        "windowsShell": settings.get("agent.windows.shell").and_then(Value::as_str).unwrap_or("auto"),
        "gitBashPath": settings.get("agent.windows.gitBashPath").and_then(Value::as_str).unwrap_or(""),
        "revision": settings.get("agent.environmentRevision").and_then(Value::as_u64).unwrap_or(0),
    });
    if let Some(saved) = previous {
        if restoring {
            validate_snapshot(saved)?;
            return Ok(saved.clone());
        }
    }
    if configuration["executionTarget"]["kind"] == "wsl" {
        let target = &configuration["executionTarget"];
        let wsl = deepcode_kernel_runtime::wsl_execution::WslExecution {
            distribution: target["distribution"]
                .as_str()
                .ok_or("WSL distribution missing")?
                .into(),
            worker: target["worker"]
                .as_str()
                .ok_or("WSL worker missing")?
                .into(),
        };
        let mut worker_settings = settings.clone();
        worker_settings
            .as_object_mut()
            .ok_or("Settings must be an object")?
            .remove("_executionTarget");
        let mut environment = wsl
            .describe(&worker_settings)
            .map_err(|error| error.to_string())?;
        validate_snapshot(&environment)?;
        environment["executionTarget"] = target.clone();
        environment["configuration"] = configuration;
        return Ok(environment);
    }
    let locale = system_locale();
    let preference = response_language_setting(settings)?;
    let shell = selected_shell(settings);
    let execution_path = shell_environment::resolved_agent_shell_path().map_err(|error| error.to_string())?;
    let path_directories = std::env::split_paths(&execution_path).collect::<Vec<_>>();
    let command_paths: serde_json::Map<String, Value> = [
        "git", "rg", "node", "npm", "pnpm", "python", "python3", "cargo", "rustc", "go", "java",
        "dotnet", "cmake", "make", "ninja", "gcc", "clang", "cl", "docker", "podman", "colima",
    ]
    .into_iter()
    .filter_map(|name| {
        shell_environment::find_command_in(name, &path_directories).map(|path| (name.to_string(), json!(path)))
    })
    .collect();
    let commands: Vec<_> = command_paths.keys().cloned().collect();
    let sandbox = deepcode_kernel_runtime::workspace_sandbox::probe();
    Ok(json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "locale": locale,
        "responseLanguage": if preference == "auto" { locale.as_deref() } else { Some(preference) },
        "userShell": std::env::var(if cfg!(windows) { "COMSPEC" } else { "SHELL" }).ok(),
        "configuration": configuration,
        "executionTarget": { "kind": "native" },
        "shellAvailable": shell.executable.is_file(),
        "shell": shell,
        "developerCommands": commands,
        "commandPaths": command_paths,
        "executionPath": execution_path.to_string_lossy(),
        "workspaceShellSupported": sandbox.available,
        "workspaceSandbox": sandbox,
    }))
}

fn validate_snapshot(snapshot: &Value) -> Result<(), String> {
    let shell: ShellProgram =
        serde_json::from_value(snapshot["shell"].clone()).map_err(|error| error.to_string())?;
    if !matches!(shell.tool.as_str(), "bash" | "powershell")
        || !snapshot["os"].is_string()
        || !snapshot["arch"].is_string()
        || !snapshot["shellAvailable"].is_boolean()
        || !snapshot["executionPath"].is_string()
        || !snapshot["workspaceShellSupported"].is_boolean()
        || !snapshot["developerCommands"]
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string))
    {
        return Err("Saved execution environment is invalid.".into());
    }
    Ok(())
}

#[cfg(test)]
fn capture(settings: &Value) -> Result<Value, String> {
    prepare(settings, None, false)
}

fn selected_shell(settings: &Value) -> ShellProgram {
    let choice = settings
        .get("agent.windows.shell")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    if cfg!(windows) && choice == "gitBash" {
        if let Some(path) = settings
            .get("agent.windows.gitBashPath")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return ShellProgram {
                tool: "bash".into(),
                executable: PathBuf::from(path),
                dialect: "bash".into(),
            };
        }
    }
    let tool = if cfg!(windows) && choice != "gitBash" {
        "powershell"
    } else {
        "bash"
    };
    let selected = if cfg!(windows) && choice == "powershell7" {
        shell_environment::find_powershell7().map(|executable| ShellProgram {
            tool: tool.into(),
            executable,
            dialect: "powershell7".into(),
        })
    } else if cfg!(windows) && choice == "windowsPowerShell" {
        shell_environment::find_windows_powershell().map(|executable| ShellProgram {
            tool: tool.into(),
            executable,
            dialect: "windowsPowerShell".into(),
        })
    } else {
        shell_environment::discover(tool).ok()
    };
    selected.unwrap_or_else(|| ShellProgram {
        tool: tool.into(),
        executable: PathBuf::new(),
        dialect: choice.into(),
    })
}

pub(crate) fn validate_settings(settings: &Value) -> Result<(), String> {
    project_environments(settings)?;
    if settings.get("agent.windows.shell").is_some_and(|value| {
        !matches!(
            value.as_str(),
            Some("auto" | "powershell7" | "windowsPowerShell" | "gitBash")
        )
    }) {
        return Err(
            "agent.windows.shell 必须为 auto、powershell7、windowsPowerShell 或 gitBash。".into(),
        );
    }
    if settings
        .get("agent.windows.gitBashPath")
        .is_some_and(|value| value.as_str().is_none_or(|s| s.contains('\0')))
    {
        return Err("Git Bash 路径必须是有效字符串。".into());
    }
    if settings
        .get("agent.environmentRevision")
        .is_some_and(|value| value.as_u64().is_none())
    {
        return Err("环境刷新版本必须是非负整数。".into());
    }
    Ok(())
}

pub(crate) fn project_environments(settings: &Value) -> Result<Value, String> {
    let value: Value = serde_json::from_str(
        settings
            .get("agent.projectEnvironments")
            .and_then(Value::as_str)
            .unwrap_or("{}"),
    )
    .map_err(|error| format!("Invalid project execution settings: {error}"))?;
    let projects = value
        .as_object()
        .ok_or("Project execution settings must be an object")?;
    for target in projects.values() {
        let object = target
            .as_object()
            .ok_or("Project execution environment must be an object")?;
        match target["kind"].as_str() {
            Some("native") if object.len() == 1 => {}
            Some("wsl")
                if object.len() == 3
                    && ["distribution", "worker"].iter().all(|key| {
                        target[key]
                            .as_str()
                            .is_some_and(|value| !value.trim().is_empty() && !value.contains('\0'))
                    }) => {}
            _ => {
                return Err(
                    "Choose native, or WSL with a distribution and Linux Kernel worker path."
                        .into(),
                )
            }
        }
    }
    Ok(value)
}

pub(crate) fn response_language_setting(settings: &Value) -> Result<&str, String> {
    match settings.get("agent.responseLanguage") {
        None => Ok("auto"),
        Some(Value::String(value)) if matches!(value.as_str(), "auto" | "zh-CN" | "en-US") => {
            Ok(value)
        }
        Some(_) => Err("agent.responseLanguage 必须为 auto、zh-CN 或 en-US。".into()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_locale() -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
        .and_then(|value| posix_locale(&value))
}

#[cfg(any(test, not(any(target_os = "macos", target_os = "windows"))))]
fn posix_locale(value: &str) -> Option<String> {
    let language = value.split(['.', '@']).next()?.trim();
    if language.is_empty() || matches!(language, "C" | "POSIX") {
        None
    } else {
        Some(language.replace('_', "-"))
    }
}

#[cfg(target_os = "windows")]
fn system_locale() -> Option<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserDefaultLocaleName(locale_name: *mut u16, locale_name_size: i32) -> i32;
    }
    let mut buffer = [0u16; 85]; // LOCALE_NAME_MAX_LENGTH, including the NUL.
    let length = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), buffer.len() as i32) };
    (length > 1)
        .then(|| String::from_utf16(&buffer[..length as usize - 1]).ok())
        .flatten()
}

#[cfg(target_os = "macos")]
fn system_locale() -> Option<String> {
    use std::ffi::{c_char, c_void, CStr};
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFLocaleCopyPreferredLanguages() -> *const c_void;
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        fn CFStringGetCString(
            string: *const c_void,
            buffer: *mut c_char,
            size: isize,
            encoding: u32,
        ) -> u8;
        fn CFRelease(value: *const c_void);
    }
    // Desktop launches may inherit C.UTF-8; use the user's macOS preference.
    unsafe {
        let languages = CFLocaleCopyPreferredLanguages();
        if languages.is_null() {
            return None;
        }
        let mut buffer = [0 as c_char; 256];
        let language = if CFArrayGetCount(languages) > 0 {
            let first = CFArrayGetValueAtIndex(languages, 0);
            if !first.is_null()
                && CFStringGetCString(
                    first,
                    buffer.as_mut_ptr(),
                    buffer.len() as isize,
                    0x08000100,
                ) != 0
            {
                CStr::from_ptr(buffer.as_ptr())
                    .to_str()
                    .ok()
                    .map(str::to_owned)
            } else {
                None
            }
        } else {
            None
        };
        CFRelease(languages);
        language
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn store_shell_snapshot_refreshes_for_new_runs_but_not_during_restore() {
        let settings = json!({});
        let mut saved = capture(&settings).unwrap();
        saved["shell"] = json!({"tool":"powershell", "dialect":"powershell7",
            "executable":r"C:\Users\user\AppData\Local\Microsoft\WindowsApps\pwsh.exe"});
        let refreshed = prepare(&settings, Some(&saved), false).unwrap();
        assert_ne!(refreshed["shell"], saved["shell"]);
        assert_eq!(refreshed["configuration"], saved["configuration"]);
        assert_eq!(prepare(&settings, Some(&saved), true).unwrap(), saved);
    }

    #[test]
    fn locale_without_a_human_language_is_not_invented() {
        assert_eq!(posix_locale("C.UTF-8"), None);
        assert_eq!(posix_locale("POSIX"), None);
        assert_eq!(posix_locale("zh_CN.UTF-8"), Some("zh-CN".into()));
        assert_eq!(posix_locale("fr_FR@euro"), Some("fr-FR".into()));
    }

    #[test]
    fn response_preference_does_not_rewrite_observed_environment() {
        let automatic = capture(&json!({})).unwrap();
        assert_eq!(automatic["responseLanguage"], automatic["locale"]);
        assert_eq!(automatic["os"], std::env::consts::OS);
        let explicit = capture(&json!({"agent.responseLanguage": "zh-CN"})).unwrap();
        assert_eq!(explicit["responseLanguage"], "zh-CN");
        assert_eq!(explicit["locale"], automatic["locale"]);
        assert!(capture(&json!({"agent.responseLanguage": false})).is_err());
    }

    #[test]
    fn saved_environment_changes_only_at_an_explicit_run_boundary() {
        let mut saved = capture(&json!({})).unwrap();
        saved["developerCommands"] = json!(["previously-observed-command"]);
        let rechecked = prepare(&json!({}), Some(&saved), false).unwrap();
        assert_ne!(rechecked["developerCommands"], saved["developerCommands"]);
        assert_eq!(rechecked["configuration"], saved["configuration"]);
        for (name, path) in rechecked["commandPaths"].as_object().unwrap() {
            assert_eq!(
                Some(PathBuf::from(path.as_str().unwrap())),
                shell_environment::find_command(name)
            );
        }
        assert_eq!(
            prepare(&json!({}), Some(&rechecked), false).unwrap(),
            rechecked
        );
        let settings = json!({"agent.environmentRevision":1});
        let refreshed = prepare(&settings, Some(&saved), false).unwrap();
        assert_ne!(refreshed["developerCommands"], saved["developerCommands"]);
        assert_eq!(refreshed["configuration"]["revision"], 1);
        assert_eq!(prepare(&settings, Some(&saved), true).unwrap(), saved);
        let changed_language = prepare(
            &json!({"agent.responseLanguage":"en-US"}),
            Some(&saved),
            false,
        )
        .unwrap();
        assert_eq!(changed_language["responseLanguage"], "en-US");
    }

    #[test]
    fn project_environment_requires_an_explicit_distribution_and_worker() {
        assert!(project_environments(&json!({"agent.projectEnvironments":r#"{"p":{"kind":"wsl","distribution":"Ubuntu","worker":"/opt/deepcode/kernel"}}"#})).is_ok());
        assert!(project_environments(
            &json!({"agent.projectEnvironments":r#"{"p":{"kind":"wsl","distribution":""}}"#})
        )
        .is_err());
    }
}
