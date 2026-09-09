//! Local Host transport discovery. This owns no Session or Kernel business state.
use deepcode_kernel_abi::{
    is_valid_host_instance_id, is_valid_host_shell_token, HostProcessIdentity,
    KERNEL_DAEMON_SERVICE,
};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const CONNECTION_FILE: &str = "runtime/agent-runtime/host-connection.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalHostConnection {
    pub identity: HostProcessIdentity,
    shell_token: String,
}

impl std::fmt::Debug for LocalHostConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalHostConnection")
            .field("identity", &self.identity)
            .field("shell_token", &"[REDACTED]")
            .finish()
    }
}

impl LocalHostConnection {
    pub fn new(identity: HostProcessIdentity, shell_token: String) -> io::Result<Self> {
        let connection = Self {
            identity,
            shell_token,
        };
        connection.validate()?;
        Ok(connection)
    }

    pub fn shell_token(&self) -> &str {
        &self.shell_token
    }

    pub fn address(&self) -> io::Result<SocketAddr> {
        self.identity
            .address
            .strip_prefix("http://")
            .and_then(|address| address.parse::<SocketAddr>().ok())
            .filter(|address| address.ip().is_loopback() && address.port() != 0)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Host connection requires a loopback HTTP address",
                )
            })
    }

    fn validate(&self) -> io::Result<()> {
        self.address()?;
        if self.identity.service != KERNEL_DAEMON_SERVICE
            || self.identity.pid == 0
            || !is_valid_host_instance_id(&self.identity.instance_id)
            || !is_valid_host_shell_token(&self.shell_token)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid local Host connection identity or credential",
            ));
        }
        Ok(())
    }

    /// The config-root lease holder publishes after binding its listener. The caller
    /// must keep that lease alive until this publication has been dropped.
    pub fn publish(&self, root: &Path) -> io::Result<PublishedHostConnection> {
        self.validate()?;
        let path = root.join(CONNECTION_FILE);
        std::fs::create_dir_all(path.parent().expect("connection parent"))?;
        let temporary = path.with_extension(format!("{}.tmp", self.identity.instance_id));
        let result = (|| {
            let mut file = private_file(&temporary)?;
            serde_json::to_writer(&mut file, self).map_err(io::Error::other)?;
            file.flush()?;
            drop(file);
            std::fs::rename(&temporary, &path)
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        Ok(PublishedHostConnection { path })
    }

    /// Refused connection means the recorded process no longer listens. A live
    /// listener must prove the exact instance; callers still authenticate health.
    pub fn discover(root: &Path) -> io::Result<Option<Self>> {
        let mut file = match File::open(root.join(CONNECTION_FILE)) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = file.metadata()?;
            if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Host connection file must be readable only by its current user",
                ));
            }
        }
        let connection: Self =
            serde_json::from_reader((&mut file).take(16 * 1024)).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "Invalid Host connection file")
            })?;
        connection.validate()?;
        let address = connection.address()?;
        let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(500)) {
            Ok(stream) => stream,
            Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => return Ok(None),
            Err(error) => return Err(error),
        };
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        write!(
            stream,
            "GET /api/host/identity HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
        )?;
        let mut response = String::new();
        stream.take(16 * 1024).read_to_string(&mut response)?;
        let body = response
            .split_once("\r\n\r\n")
            .filter(|(header, _)| header.starts_with("HTTP/1.1 200 "))
            .map(|(_, body)| body)
            .ok_or_else(|| {
                io::Error::other("Recorded Host did not provide its process identity")
            })?;
        let envelope: serde_json::Value = serde_json::from_str(body)
            .map_err(|_| io::Error::other("Invalid Host identity response"))?;
        let actual = envelope
            .get("data")
            .cloned()
            .and_then(|value| serde_json::from_value::<HostProcessIdentity>(value).ok());
        if envelope.get("ok").and_then(|ok| ok.as_bool()) != Some(true)
            || actual.as_ref() != Some(&connection.identity)
        {
            return Err(io::Error::other(
                "Recorded Host instance does not match the live process",
            ));
        }
        Ok(Some(connection))
    }
}

pub struct PublishedHostConnection {
    path: PathBuf,
}

impl Drop for PublishedHostConnection {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.path) {
            if error.kind() != io::ErrorKind::NotFound {
                eprintln!("Remove owned Host connection: {error}");
            }
        }
    }
}

/// Serializes shell startup for one config root, including port selection and
/// authenticated readiness. Kernel's existing config-root lease remains the owner.
pub struct HostStartGuard {
    _file: File,
}

impl HostStartGuard {
    pub fn acquire(root: &Path) -> io::Result<Self> {
        let path = root.join("runtime/agent-runtime/host-start.lock");
        std::fs::create_dir_all(path.parent().expect("startup parent"))?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match lock_file(&file) {
                Ok(()) => return Ok(Self { _file: file }),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "Another shell is still starting the shared Host",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

pub fn config_root(distribution_root: &Path) -> io::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let requested = if let Some(path) = std::env::var_os("DEEPCODE_CONFIG_DIR") {
        PathBuf::from(path)
    } else if std::env::var("DEEPCODE_PORTABLE").is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    }) {
        distribution_root.join("config/user/local")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|root| root.join("DeepCode"))
            .or_else(|| home.map(|root| root.join("AppData/Roaming/DeepCode")))
            .unwrap_or_else(|| distribution_root.join(".deepcode-user"))
    } else if let Some(root) = std::env::var_os("XDG_CONFIG_HOME") {
        PathBuf::from(root).join("deepcode")
    } else {
        home.map(|root| root.join(".config/deepcode"))
            .unwrap_or_else(|| distribution_root.join(".deepcode-user"))
    };
    std::fs::create_dir_all(&requested)?;
    requested.canonicalize()
}

#[cfg(unix)]
fn private_file(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
}

#[cfg(unix)]
fn lock_file(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deepcode_kernel_abi::{HOST_INSTANCE_ID_PREFIX, HOST_SHELL_TOKEN_PREFIX};
    use std::net::TcpListener;

    fn temporary_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "deepcode-host-connection-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn published_connection_identifies_live_host_and_is_removed_by_owner() {
        let root = temporary_root();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let identity = HostProcessIdentity {
            service: KERNEL_DAEMON_SERVICE.into(),
            instance_id: format!("{HOST_INSTANCE_ID_PREFIX}{}", "01".repeat(32)),
            pid: std::process::id(),
            address: format!("http://{}", listener.local_addr().unwrap()),
        };
        let connection = LocalHostConnection::new(
            identity.clone(),
            format!("{HOST_SHELL_TOKEN_PREFIX}{}", "02".repeat(32)),
        )
        .unwrap();
        let publication = connection.publish(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.join(CONNECTION_FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut chunk = [0; 1024];
                let bytes = stream.read(&mut chunk).unwrap();
                assert!(bytes > 0, "request ended before its headers");
                request.extend_from_slice(&chunk[..bytes]);
                assert!(request.len() <= 4096);
            }
            assert!(std::str::from_utf8(&request)
                .unwrap()
                .starts_with("GET /api/host/identity "));
            let body = serde_json::json!({"ok": true, "data": identity}).to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let found = LocalHostConnection::discover(&root)
            .unwrap()
            .expect("live Host");
        assert_eq!(found.identity, connection.identity);
        assert_eq!(found.shell_token(), connection.shell_token());
        assert!(!format!("{found:?}").contains(connection.shell_token()));
        server.join().unwrap();
        drop(publication);
        assert!(LocalHostConnection::discover(&root).unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_is_exclusive_until_its_guard_is_released() {
        let root = temporary_root();
        let owner = HostStartGuard::acquire(&root).unwrap();
        let another = OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("runtime/agent-runtime/host-start.lock"))
            .unwrap();
        assert_eq!(
            lock_file(&another).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(owner);
        lock_file(&another).expect("released startup can be acquired");
        drop(another);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(windows)]
fn private_file(path: &Path) -> io::Result<File> {
    use std::os::windows::{ffi::OsStrExt, io::FromRawHandle};
    use windows_sys::Win32::{
        Foundation::{LocalFree, GENERIC_WRITE, INVALID_HANDLE_VALUE},
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::{CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ},
    };
    let sddl: Vec<u16> = "D:P(A;;FA;;;OW)\0".encode_utf16().collect();
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    let error = io::Error::last_os_error();
    unsafe {
        LocalFree(descriptor);
    }
    if handle == INVALID_HANDLE_VALUE {
        Err(error)
    } else {
        Ok(unsafe { File::from_raw_handle(handle) })
    }
}

#[cfg(windows)]
fn lock_file(file: &File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Foundation::ERROR_LOCK_VIOLATION,
        Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY},
        System::IO::OVERLAPPED,
    };
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    if unsafe {
        LockFileEx(
            file.as_raw_handle(),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlapped,
        )
    } != 0
    {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
        Err(io::ErrorKind::WouldBlock.into())
    } else {
        Err(error)
    }
}
