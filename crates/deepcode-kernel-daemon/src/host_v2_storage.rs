use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

const STORAGE_LOCK_SHARDS: usize = 64;
const ATOMIC_WRITE_ATTEMPTS: u64 = 8;
const STABLE_JSON_MAX_DEPTH: usize = 128;
static ATOMIC_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostV2StorageErrorKind {
    Invalid,
    Unauthorized,
    Conflict,
    NotFound,
    Io,
}

#[derive(Debug, Clone)]
pub(crate) struct HostV2StorageError {
    pub(crate) kind: HostV2StorageErrorKind,
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl HostV2StorageError {
    pub(crate) fn invalid(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind: HostV2StorageErrorKind::Invalid,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind: HostV2StorageErrorKind::Conflict,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn unauthorized(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind: HostV2StorageErrorKind::Unauthorized,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind: HostV2StorageErrorKind::NotFound,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn io(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind: HostV2StorageErrorKind::Io,
            code,
            message: message.into(),
        }
    }
}

pub(crate) fn validate_bounded_identity(
    value: &str,
    field: &'static str,
    maximum_bytes: usize,
) -> Result<(), HostV2StorageError> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > maximum_bytes
        || value.chars().any(|character| character.is_control())
    {
        return Err(HostV2StorageError::invalid(
            "host_v2_identity_invalid",
            format!("{field} is not a valid bounded identity"),
        ));
    }
    Ok(())
}

pub(crate) fn validate_safe_session_identity(value: &str) -> Result<(), HostV2StorageError> {
    validate_bounded_identity(value, "sessionId", 512)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(HostV2StorageError::invalid(
            "host_v2_session_identity_invalid",
            "sessionId must be a path-safe opaque identity",
        ));
    }
    Ok(())
}

pub(crate) fn reject_transport_capabilities(value: &Value) -> Result<(), HostV2StorageError> {
    match value {
        Value::Array(items) => {
            for item in items {
                reject_transport_capabilities(item)?;
            }
        }
        Value::Object(fields) => {
            for (key, nested) in fields {
                let normalized_key = key
                    .bytes()
                    .filter(u8::is_ascii_alphanumeric)
                    .map(|byte| byte.to_ascii_lowercase())
                    .collect::<Vec<_>>();
                if matches!(
                    normalized_key.as_slice(),
                    b"runcapability"
                        | b"decisioncapability"
                        | b"authorization"
                        | b"cookie"
                        | b"apikey"
                        | b"accesstoken"
                        | b"refreshtoken"
                        | b"bearertoken"
                        | b"clientsecret"
                        | b"password"
                        | b"token"
                ) {
                    return Err(HostV2StorageError::invalid(
                        "host_v2_transport_secret_forbidden",
                        "Transport capabilities or secret material cannot enter Host v2 persistence",
                    ));
                }
                reject_transport_capabilities(nested)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, HostV2StorageError> {
    deepcode_kernel_abi::v2::canonical_json_bytes_v2(value).map_err(|error| {
        HostV2StorageError::invalid(
            "host_v2_canonical_json_failed",
            format!("encode canonical JSON: {error}"),
        )
    })
}

pub(crate) fn canonical_sha256(value: &Value) -> Result<String, HostV2StorageError> {
    Ok(sha256_prefixed(&canonical_json_bytes(value)?))
}

/// Produces a deterministic Kernel-local digest for configuration JSON.
///
/// ABI canonical JSON intentionally rejects fractional numbers, while provider
/// configuration legitimately contains values such as `temperature: 0.2`.
/// Keep that ABI boundary strict and use this full-JSON encoding only for
/// Kernel-owned configuration identity and revision checks.
pub(crate) fn stable_json_sha256(value: &Value) -> Result<String, HostV2StorageError> {
    let mut output = Vec::new();
    write_stable_json(value, &mut output, 0)?;
    Ok(sha256_prefixed(&output))
}

fn write_stable_json(
    value: &Value,
    output: &mut Vec<u8>,
    depth: usize,
) -> Result<(), HostV2StorageError> {
    if depth > STABLE_JSON_MAX_DEPTH {
        return Err(HostV2StorageError::invalid(
            "host_v2_stable_json_depth_exceeded",
            "Stable configuration JSON exceeds the maximum nesting depth",
        ));
    }
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(value) => output.extend_from_slice(if *value { b"true" } else { b"false" }),
        Value::Number(number) => {
            if let Ok(canonical) = canonical_json_bytes(value) {
                output.extend_from_slice(&canonical);
            } else {
                output.extend_from_slice(number.to_string().as_bytes());
            }
        }
        Value::String(_) => write_json_scalar(value, output)?,
        Value::Array(values) => {
            output.push(b'[');
            for (index, nested) in values.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                write_stable_json(nested, output, depth + 1)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            output.push(b'{');
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                write_json_scalar(&Value::String((*key).clone()), output)?;
                output.push(b':');
                write_stable_json(&values[*key], output, depth + 1)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

fn write_json_scalar(value: &Value, output: &mut Vec<u8>) -> Result<(), HostV2StorageError> {
    serde_json::to_writer(output, value).map_err(|error| {
        HostV2StorageError::invalid(
            "host_v2_stable_json_failed",
            format!("Encode stable configuration JSON: {error}"),
        )
    })
}

pub(crate) fn sha256_prefixed(value: &[u8]) -> String {
    format!("sha256:{}", lower_hex(&Sha256::digest(value)))
}

pub(crate) fn sha256_path_component(value: &str) -> String {
    lower_hex(&Sha256::digest(value.as_bytes()))
}

pub(crate) fn validate_sha256_digest(
    value: &str,
    field: &'static str,
) -> Result<(), HostV2StorageError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(HostV2StorageError::invalid(
            "host_v2_digest_invalid",
            format!("{field} must be a sha256 digest"),
        ));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(HostV2StorageError::invalid(
            "host_v2_digest_invalid",
            format!("{field} must be a lowercase sha256 digest"),
        ));
    }
    Ok(())
}

fn lower_hex(value: &[u8]) -> String {
    let mut output = String::with_capacity(value.len() * 2);
    for byte in value {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

pub(crate) fn with_storage_path_lock<T>(
    path: &Path,
    operation: impl FnOnce() -> Result<T, HostV2StorageError>,
) -> Result<T, HostV2StorageError> {
    with_storage_path_locks(&[path], operation)
}

pub(crate) fn with_storage_path_locks<T>(
    paths: &[&Path],
    operation: impl FnOnce() -> Result<T, HostV2StorageError>,
) -> Result<T, HostV2StorageError> {
    use std::hash::{Hash, Hasher};

    static LOCKS: OnceLock<Vec<Mutex<()>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| (0..STORAGE_LOCK_SHARDS).map(|_| Mutex::new(())).collect());
    let mut shard_indices = paths
        .iter()
        .map(|path| {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            path.hash(&mut hasher);
            (hasher.finish() as usize) % STORAGE_LOCK_SHARDS
        })
        .collect::<Vec<_>>();
    shard_indices.sort_unstable();
    shard_indices.dedup();
    let mut guards = Vec::with_capacity(shard_indices.len());
    for shard_index in shard_indices {
        guards.push(locks[shard_index].lock().map_err(|_| {
            HostV2StorageError::io(
                "host_v2_storage_lock_unavailable",
                "Host v2 storage lock is unavailable",
            )
        })?);
    }
    let result = operation();
    drop(guards);
    result
}

pub(crate) fn create_private_directory(path: &Path) -> Result<bool, HostV2StorageError> {
    let existed = path.exists();
    fs::create_dir_all(path).map_err(|error| {
        HostV2StorageError::io(
            "host_v2_storage_directory_failed",
            format!("create Host v2 storage directory: {error}"),
        )
    })?;
    secure_directory(path)?;
    Ok(!existed)
}

pub(crate) fn append_json_line_durable(
    path: &Path,
    value: &Value,
) -> Result<(), HostV2StorageError> {
    let parent = path.parent().ok_or_else(|| {
        HostV2StorageError::io(
            "host_v2_storage_path_invalid",
            "Host v2 JSONL path has no parent",
        )
    })?;
    let created_directory = create_private_directory(parent)?;
    let file_existed = path.exists();
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| {
        HostV2StorageError::io(
            "host_v2_storage_open_failed",
            format!("open Host v2 JSONL stream: {error}"),
        )
    })?;
    secure_file(path)?;
    let mut encoded = serde_json::to_vec(value).map_err(|error| {
        HostV2StorageError::invalid(
            "host_v2_storage_encode_failed",
            format!("encode Host v2 JSONL record: {error}"),
        )
    })?;
    encoded.push(b'\n');
    file.write_all(&encoded).map_err(|error| {
        HostV2StorageError::io(
            "host_v2_storage_write_failed",
            format!("append Host v2 JSONL record: {error}"),
        )
    })?;
    file.flush().map_err(|error| {
        HostV2StorageError::io(
            "host_v2_storage_flush_failed",
            format!("flush Host v2 JSONL record: {error}"),
        )
    })?;
    file.sync_all().map_err(|error| {
        HostV2StorageError::io(
            "host_v2_storage_sync_failed",
            format!("sync Host v2 JSONL record: {error}"),
        )
    })?;
    if !file_existed || created_directory {
        sync_directory(parent)?;
        if let Some(grandparent) = parent.parent() {
            sync_directory(grandparent)?;
        }
    }
    Ok(())
}

pub(crate) fn atomic_write_private_json(
    path: &Path,
    value: &Value,
) -> Result<(), HostV2StorageError> {
    let parent = path.parent().ok_or_else(|| {
        HostV2StorageError::io(
            "host_v2_storage_path_invalid",
            "Host v2 JSON path has no parent",
        )
    })?;
    let created_directory = create_private_directory(parent)?;
    let encoded = serde_json::to_vec(value).map_err(|error| {
        HostV2StorageError::invalid(
            "host_v2_storage_encode_failed",
            format!("encode Host v2 JSON record: {error}"),
        )
    })?;
    let mut last_error = None;
    for _ in 0..ATOMIC_WRITE_ATTEMPTS {
        let sequence = ATOMIC_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!(
            ".deepcode-v2-{}-{sequence}.tmp",
            std::process::id()
        ));
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(&temp) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
                continue;
            }
            Err(error) => {
                return Err(HostV2StorageError::io(
                    "host_v2_storage_open_failed",
                    format!("create Host v2 atomic file: {error}"),
                ))
            }
        };
        let cleanup = TemporaryFile::new(temp.clone());
        file.write_all(&encoded).map_err(|error| {
            HostV2StorageError::io(
                "host_v2_storage_write_failed",
                format!("write Host v2 atomic file: {error}"),
            )
        })?;
        file.flush().map_err(|error| {
            HostV2StorageError::io(
                "host_v2_storage_flush_failed",
                format!("flush Host v2 atomic file: {error}"),
            )
        })?;
        file.sync_all().map_err(|error| {
            HostV2StorageError::io(
                "host_v2_storage_sync_failed",
                format!("sync Host v2 atomic file: {error}"),
            )
        })?;
        drop(file);
        fs::rename(&temp, path).map_err(|error| {
            HostV2StorageError::io(
                "host_v2_storage_rename_failed",
                format!("publish Host v2 atomic file: {error}"),
            )
        })?;
        cleanup.disarm();
        secure_file(path)?;
        sync_directory(parent)?;
        if created_directory {
            if let Some(grandparent) = parent.parent() {
                sync_directory(grandparent)?;
            }
        }
        return Ok(());
    }
    Err(HostV2StorageError::io(
        "host_v2_storage_temp_collision",
        format!(
            "could not allocate Host v2 atomic file: {}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "temporary name collision".to_string())
        ),
    ))
}

pub(crate) fn read_json(path: &Path) -> Result<Option<Value>, HostV2StorageError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|error| {
            HostV2StorageError::conflict(
                "host_v2_storage_corrupt",
                format!("decode Host v2 JSON record: {error}"),
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(HostV2StorageError::io(
            "host_v2_storage_read_failed",
            format!("read Host v2 JSON record: {error}"),
        )),
    }
}

pub(crate) fn value_without_field(value: &Value, field: &str) -> Result<Value, HostV2StorageError> {
    let mut object = value.as_object().cloned().ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_v2_record_invalid",
            "Host v2 record must be a JSON object",
        )
    })?;
    object.remove(field).ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_v2_record_invalid",
            format!("Host v2 record is missing {field}"),
        )
    })?;
    Ok(Value::Object(object))
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), HostV2StorageError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
        HostV2StorageError::io(
            "host_v2_storage_permissions_failed",
            format!("secure Host v2 directory: {error}"),
        )
    })
}

#[cfg(not(unix))]
fn secure_directory(_path: &Path) -> Result<(), HostV2StorageError> {
    Ok(())
}

#[cfg(unix)]
fn secure_file(path: &Path) -> Result<(), HostV2StorageError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
        HostV2StorageError::io(
            "host_v2_storage_permissions_failed",
            format!("secure Host v2 file: {error}"),
        )
    })
}

#[cfg(not(unix))]
fn secure_file(_path: &Path) -> Result<(), HostV2StorageError> {
    Ok(())
}

#[cfg(unix)]
pub(crate) fn sync_directory(path: &Path) -> Result<(), HostV2StorageError> {
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| {
            HostV2StorageError::io(
                "host_v2_storage_directory_sync_failed",
                format!("sync Host v2 storage directory: {error}"),
            )
        })
}

#[cfg(not(unix))]
pub(crate) fn sync_directory(_path: &Path) -> Result<(), HostV2StorageError> {
    Ok(())
}

struct TemporaryFile {
    path: PathBuf,
    armed: bool,
}

impl TemporaryFile {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}
