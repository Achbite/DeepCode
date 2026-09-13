use super::{os::*, *};
use crate::executors::windows_job as job;
use std::io::{Read, Write};
use std::os::windows::io::FromRawHandle;
use std::ptr::{null, null_mut};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows_sys::Win32::{
    Foundation::*, Security::SECURITY_ATTRIBUTES, Storage::FileSystem::*, System::Console::*,
    System::Pipes::*, System::Threading::*,
};

struct Child {
    process: Handle,
    _job: job::ProcessJob,
    active: bool,
}
impl Child {
    fn from_info(info: PROCESS_INFORMATION) -> Result<Self, String> {
        let process = Handle(info.hProcess);
        let thread = Handle(info.hThread);
        let job = match job::ProcessJob::attach_handle(process.0) {
            Ok(job) => job,
            Err(error) => {
                unsafe {
                    TerminateProcess(process.0, 1);
                    WaitForSingleObject(process.0, INFINITE);
                }
                return Err(error.to_string());
            }
        };
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            unsafe {
                TerminateProcess(process.0, 1);
                WaitForSingleObject(process.0, INFINITE);
            }
            return Err(error("Resume sandbox process"));
        }
        Ok(Self {
            process,
            _job: job,
            active: true,
        })
    }
    fn poll(&self) -> Result<Option<i32>, String> {
        let wait = unsafe { WaitForSingleObject(self.process.0, 0) };
        if wait == WAIT_TIMEOUT {
            return Ok(None);
        }
        if wait != WAIT_OBJECT_0 {
            return Err(error("Wait for sandbox process"));
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(self.process.0, &mut code) } == 0 {
            return Err(error("Read process exit code"));
        }
        Ok(Some(code as i32))
    }
    fn wait(&mut self) -> Result<i32, String> {
        loop {
            if let Some(code) = self.poll()? {
                self.active = false;
                return Ok(code);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        if self.active {
            unsafe {
                TerminateProcess(self.process.0, 1);
                WaitForSingleObject(self.process.0, INFINITE);
            }
        }
    }
}

fn as_file(handle: Handle) -> fs::File {
    let raw = handle.0;
    std::mem::forget(handle);
    unsafe { fs::File::from_raw_handle(raw) }
}

/// The ordinary user starts a fixed bootstrap under the initialized account.
/// It exchanges only this invocation's output over an account-scoped local pipe.
pub(super) fn proxy(path: &Path) -> Result<i32, String> {
    let state = installation()?;
    let mut request: Request = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    request.environment = std::env::vars().collect();
    for name in ["TEMP", "TMP", "TMPDIR"] {
        request.environment.insert(
            name.into(),
            request.temporary.to_string_lossy().into_owned(),
        );
    }
    fs::write(
        path,
        serde_json::to_vec(&request).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let pipe_name = format!(r"\\.\pipe\deepcode-shell-{}", random_text());
    let security = descriptor(&format!(
        "D:(A;;GA;;;{})(A;;GA;;;{})",
        current_user_sid()?,
        state.account_sid
    ))?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: security.0,
        bInheritHandle: 0,
    };
    let raw = unsafe {
        CreateNamedPipeW(
            wide(&pipe_name).as_ptr(),
            PIPE_ACCESS_INBOUND,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT,
            1,
            65536,
            65536,
            0,
            &attributes,
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(error("Create Shell output pipe"));
    }
    let pipe = Handle(raw);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let command = [
        exe.to_string_lossy().into_owned(),
        "--workspace-sandbox-worker".into(),
        path.to_string_lossy().into_owned(),
        pipe_name,
    ]
    .iter()
    .map(|s| quote(s))
    .collect::<Vec<_>>()
    .join(" ");
    let mut command = wide(command);
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of_val(&startup) as u32;
    let password = setup::password(&state)?;
    if unsafe {
        CreateProcessWithLogonW(
            wide(&state.account).as_ptr(),
            wide(".").as_ptr(),
            wide(&password).as_ptr(),
            0,
            wide(&exe).as_ptr(),
            command.as_mut_ptr(),
            CREATE_NO_WINDOW | CREATE_SUSPENDED,
            null(),
            wide(&request.cwd).as_ptr(),
            &startup,
            &mut info,
        )
    } == 0
    {
        return Err(error("Start sandbox account worker"));
    }
    let mut child = Child::from_info(info)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if unsafe { ConnectNamedPipe(pipe.0, null_mut()) } != 0
            || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED
        {
            break;
        }
        if let Some(code) = child.poll()? {
            return Err(format!(
                "Sandbox worker exited before connecting (exit {code})."
            ));
        }
        if Instant::now() >= deadline {
            return Err("Sandbox worker connection timed out.".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let mode = PIPE_READMODE_BYTE | PIPE_WAIT;
    if unsafe { SetNamedPipeHandleState(pipe.0, &mode, null(), null()) } == 0 {
        return Err(error("Configure Shell output pipe"));
    }
    let mut reader = as_file(pipe);
    loop {
        let mut header = [0u8; 5];
        reader
            .read_exact(&mut header)
            .map_err(|e| format!("Read sandbox output: {e}"))?;
        let len = u32::from_le_bytes(header[1..].try_into().unwrap()) as usize;
        let mut payload = vec![0u8; len];
        reader.read_exact(&mut payload).map_err(|e| e.to_string())?;
        match header[0] {
            1 => {
                std::io::stdout()
                    .write_all(&payload)
                    .and_then(|_| std::io::stdout().flush())
                    .map_err(|e| e.to_string())?;
            }
            2 => {
                std::io::stderr()
                    .write_all(&payload)
                    .and_then(|_| std::io::stderr().flush())
                    .map_err(|e| e.to_string())?;
            }
            3 => return Err(String::from_utf8_lossy(&payload).into_owned()),
            4 => {
                let code = i32::from_le_bytes(
                    payload
                        .as_slice()
                        .try_into()
                        .map_err(|_| "Invalid sandbox exit result")?,
                );
                child.wait()?;
                return Ok(code);
            }
            _ => return Err("Invalid sandbox output frame.".into()),
        }
    }
}

type Output = Arc<Mutex<fs::File>>;
fn send(output: &Output, kind: u8, bytes: &[u8]) -> Result<(), String> {
    let mut writer = output.lock().map_err(|_| "Shell output lock failed")?;
    writer
        .write_all(&[kind])
        .and_then(|_| writer.write_all(&(bytes.len() as u32).to_le_bytes()))
        .and_then(|_| writer.write_all(bytes))
        .and_then(|_| writer.flush())
        .map_err(|e| e.to_string())
}
fn pump(
    mut reader: fs::File,
    output: Output,
    kind: u8,
) -> std::thread::JoinHandle<Result<(), String>> {
    std::thread::spawn(move || {
        let mut bytes = [0u8; 8192];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) => return Ok(()),
                Ok(count) => send(&output, kind, &bytes[..count])?,
                Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => return Ok(()),
                Err(error) => return Err(error.to_string()),
            }
        }
    })
}

pub(super) fn worker(path: &Path, pipe: &str) -> Result<i32, String> {
    let raw = unsafe {
        CreateFileW(
            wide(pipe).as_ptr(),
            GENERIC_WRITE,
            0,
            null(),
            OPEN_EXISTING,
            0,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(error("Connect Shell output pipe"));
    }
    let output = Arc::new(Mutex::new(as_file(Handle(raw))));
    let result = (|| {
        let request: Request = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        run(request, output.clone())
    })();
    match result {
        Ok(code) => {
            send(&output, 4, &code.to_le_bytes())?;
            Ok(code)
        }
        Err(error) => {
            send(&output, 3, error.as_bytes())?;
            Err(error)
        }
    }
}

fn pipe() -> Result<(Handle, Handle), String> {
    let mut read = null_mut();
    let mut write = null_mut();
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(error("Create process pipe"));
    }
    Ok((Handle(read), Handle(write)))
}
struct Console(HPCON);
impl Drop for Console {
    fn drop(&mut self) {
        unsafe {
            ClosePseudoConsole(self.0);
        }
    }
}
struct Attributes {
    _storage: Vec<usize>,
    pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    fn console(console: HPCON) -> Result<Self, String> {
        let mut size = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
        }
        let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        let pointer = storage.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut size) } == 0 {
            return Err(error("Initialize console process attributes"));
        }
        let attributes = Self {
            _storage: storage,
            pointer,
        };
        if unsafe {
            UpdateProcThreadAttribute(
                pointer,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                console as *const _,
                std::mem::size_of::<HPCON>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(error("Attach Shell console"));
        }
        Ok(attributes)
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer);
        }
    }
}

fn run(request: Request, output: Output) -> Result<i32, String> {
    let token = restricted_token(&request.write_sid)?;
    let (input_read, input_write) = pipe()?;
    let (output_read, output_write) = pipe()?;
    let terminal = request.stdin.is_some();
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut console = None;
    let mut attributes = None;
    let mut stderr = None;
    let mut stderr_child = None;
    let mut flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
    if terminal {
        let mut hpc = 0;
        let result = unsafe {
            CreatePseudoConsole(
                COORD { X: 120, Y: 30 },
                input_read.0,
                output_write.0,
                0,
                &mut hpc,
            )
        };
        if result < 0 {
            return Err(format!("Create Shell console: HRESULT {result:#x}"));
        }
        console = Some(Console(hpc));
        attributes = Some(Attributes::console(hpc)?);
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.lpAttributeList = attributes.as_ref().unwrap().pointer;
        flags |= EXTENDED_STARTUPINFO_PRESENT;
    } else {
        let (read, write) = pipe()?;
        stderr = Some(read);
        stderr_child = Some(write);
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = input_read.0;
        startup.StartupInfo.hStdOutput = output_write.0;
        startup.StartupInfo.hStdError = stderr_child.as_ref().unwrap().0;
        flags |= CREATE_NO_WINDOW;
    }
    // Parent pipe ends must not keep the child's stream alive after exit.
    for handle in [Some(&input_write), Some(&output_read), stderr.as_ref()]
        .into_iter()
        .flatten()
    {
        if unsafe { SetHandleInformation(handle.0, HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err(error("Configure process pipe inheritance"));
        }
    }
    let mut command = wide(
        std::iter::once(request.executable.to_string_lossy().into_owned())
            .chain(request.arguments.clone())
            .map(|s| quote(&s))
            .collect::<Vec<_>>()
            .join(" "),
    );
    let mut environment = request.environment.iter().collect::<Vec<_>>();
    environment.sort_by_key(|(key, _)| key.to_ascii_uppercase());
    let mut environment: Vec<u16> = environment
        .into_iter()
        .flat_map(|(key, value)| wide(format!("{key}={value}")))
        .collect();
    environment.push(0);
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe {
        CreateProcessAsUserW(
            token.0,
            wide(&request.executable).as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            i32::from(!terminal),
            flags,
            environment.as_ptr().cast(),
            wide(&request.cwd).as_ptr(),
            &startup.StartupInfo,
            &mut info,
        )
    } == 0
    {
        return Err(error("Start restricted Shell"));
    }
    let mut child = Child::from_info(info)?;
    drop(input_read);
    drop(output_write);
    drop(stderr_child);
    drop(attributes);
    let stdout_thread = pump(as_file(output_read), output.clone(), 1);
    let stderr_thread = stderr.map(|read| pump(as_file(read), output, 2));
    let mut input = as_file(input_write);
    let input_thread = std::thread::spawn(move || {
        if let Some(text) = request.stdin {
            let _ = input.write_all(text.as_bytes());
            let _ = input.flush();
        }
    });
    let status = child.wait();
    // Closing the job stops remaining descendants before joining pipe readers.
    drop(child);
    drop(console);
    let _ = input_thread.join();
    stdout_thread
        .join()
        .map_err(|_| "Shell stdout reader failed")??;
    if let Some(reader) = stderr_thread {
        reader.join().map_err(|_| "Shell stderr reader failed")??;
    }
    status
}
