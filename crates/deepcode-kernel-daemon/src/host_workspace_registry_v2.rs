use deepcode_kernel_abi::WorkspaceBindingRefV2;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

const WORKSPACE_BINDING_REF_PREFIX_V2: &str = "wsb_v2_";
const WORKSPACE_BINDING_REF_ENTROPY_BYTES_V2: usize = 32;
const MAX_WORKSPACE_BINDINGS_V2: usize = 65_536;
const MAX_WORKSPACE_REHYDRATE_BATCH_V2: usize = 16_384;
const MAX_REFERENCE_ISSUE_ATTEMPTS_V2: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostWorkspaceResolveErrorV2 {
    NotFound,
    Stale,
    Unavailable,
}

pub(crate) trait HostWorkspaceBindingResolverV2: Send + Sync {
    fn resolve_workspace_binding(
        &self,
        workspace_binding_ref: &WorkspaceBindingRefV2,
    ) -> Result<PathBuf, HostWorkspaceResolveErrorV2>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostWorkspaceRegistryReadinessV2 {
    Cold,
    Rehydrating,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostWorkspaceRegistryErrorV2 {
    RootNotAbsolute,
    RootNotFound,
    RootNotDirectory,
    RootInaccessible,
    InvalidBindingReference,
    BindingNotFound,
    BindingIdentityMismatch,
    CapacityExceeded,
    EntropyUnavailable,
    RegistryUnavailable,
    RehydrateBatchTooLarge,
}

impl fmt::Display for HostWorkspaceRegistryErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::RootNotAbsolute => "workspace root must be an absolute path",
            Self::RootNotFound => "workspace root does not exist",
            Self::RootNotDirectory => "workspace root is not a directory",
            Self::RootInaccessible => "workspace root is not accessible",
            Self::InvalidBindingReference => "workspace binding reference is invalid",
            Self::BindingNotFound => "workspace binding reference was not found",
            Self::BindingIdentityMismatch => {
                "workspace binding identity does not match the registered root"
            }
            Self::CapacityExceeded => "workspace binding registry capacity was exceeded",
            Self::EntropyUnavailable => "workspace binding reference entropy is unavailable",
            Self::RegistryUnavailable => "workspace binding registry is unavailable",
            Self::RehydrateBatchTooLarge => "workspace rehydrate batch is too large",
        })
    }
}

impl std::error::Error for HostWorkspaceRegistryErrorV2 {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostWorkspaceBindingRegisteredV2 {
    pub(crate) workspace_binding_ref: WorkspaceBindingRefV2,
    pub(crate) workspace_identity: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HostWorkspaceRehydrateResultV2 {
    pub(crate) inserted_count: usize,
    pub(crate) already_bound_count: usize,
    pub(crate) conflict_count: usize,
}

#[derive(Clone)]
pub(crate) struct HostWorkspaceRehydrateRecordV2 {
    workspace_binding_ref: WorkspaceBindingRefV2,
    absolute_root: PathBuf,
    workspace_identity: Option<String>,
}

impl HostWorkspaceRehydrateRecordV2 {
    pub(crate) fn new(
        workspace_binding_ref: WorkspaceBindingRefV2,
        absolute_root: PathBuf,
        workspace_identity: Option<String>,
    ) -> Self {
        Self {
            workspace_binding_ref,
            absolute_root,
            workspace_identity,
        }
    }
}

impl fmt::Debug for HostWorkspaceRehydrateRecordV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostWorkspaceRehydrateRecordV2")
            .field("workspace_binding_ref", &self.workspace_binding_ref)
            .field("absolute_root", &"[REDACTED]")
            .field(
                "workspace_identity",
                &self.workspace_identity.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

#[derive(Clone)]
pub(crate) struct HostWorkspaceRegistryV2 {
    inner: Arc<HostWorkspaceRegistryInnerV2>,
}

#[derive(Clone)]
pub(crate) struct HostWorkspaceRegistryAdminV2 {
    inner: Arc<HostWorkspaceRegistryInnerV2>,
}

struct HostWorkspaceRegistryInnerV2 {
    state: RwLock<HostWorkspaceRegistryStateV2>,
}

enum HostWorkspaceRegistryStateV2 {
    Cold,
    Rehydrating,
    Operational {
        bindings: HashMap<WorkspaceBindingRefV2, WorkspaceBindingRecordV2>,
        conflicts: HashSet<WorkspaceBindingRefV2>,
        startup_error: Option<HostWorkspaceRegistryErrorV2>,
    },
}

#[derive(Clone, PartialEq, Eq)]
enum WorkspaceBindingRecordV2 {
    Ready {
        canonical_root: PathBuf,
        root_identity: WorkspaceRootIdentityV2,
    },
    Stale {
        configured_root: PathBuf,
    },
}

#[cfg(unix)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct WorkspaceRootIdentityV2 {
    device: u64,
    inode: u64,
}

#[cfg(not(unix))]
#[derive(Clone, Copy, PartialEq, Eq)]
struct WorkspaceRootIdentityV2;

struct ValidatedWorkspaceRootV2 {
    canonical_root: PathBuf,
    root_identity: WorkspaceRootIdentityV2,
}

impl HostWorkspaceRegistryV2 {
    pub(crate) fn new_pair() -> (HostWorkspaceRegistryAdminV2, Self) {
        let inner = Arc::new(HostWorkspaceRegistryInnerV2 {
            state: RwLock::new(HostWorkspaceRegistryStateV2::Cold),
        });
        (
            HostWorkspaceRegistryAdminV2 {
                inner: Arc::clone(&inner),
            },
            Self { inner },
        )
    }
}

impl HostWorkspaceRegistryAdminV2 {
    pub(crate) fn readiness(&self) -> HostWorkspaceRegistryReadinessV2 {
        self.inner.readiness()
    }

    pub(crate) fn register(
        &self,
        absolute_root: &Path,
    ) -> Result<HostWorkspaceBindingRegisteredV2, HostWorkspaceRegistryErrorV2> {
        self.require_operational()?;
        let validated = validate_workspace_root(absolute_root)?;
        for _ in 0..MAX_REFERENCE_ISSUE_ATTEMPTS_V2 {
            let workspace_binding_ref = issue_workspace_binding_ref()?;
            let mut state = self
                .inner
                .state
                .write()
                .map_err(|_| HostWorkspaceRegistryErrorV2::RegistryUnavailable)?;
            let HostWorkspaceRegistryStateV2::Operational {
                bindings,
                conflicts,
                startup_error,
            } = &mut *state
            else {
                return Err(HostWorkspaceRegistryErrorV2::RegistryUnavailable);
            };
            if bindings.len() + conflicts.len() >= MAX_WORKSPACE_BINDINGS_V2 {
                return Err(HostWorkspaceRegistryErrorV2::CapacityExceeded);
            }
            if bindings.contains_key(&workspace_binding_ref)
                || conflicts.contains(&workspace_binding_ref)
            {
                continue;
            }
            let workspace_identity = workspace_identity_token(&validated);
            bindings.insert(
                workspace_binding_ref.clone(),
                WorkspaceBindingRecordV2::ready(&validated),
            );
            *startup_error = None;
            return Ok(HostWorkspaceBindingRegisteredV2 {
                workspace_binding_ref,
                workspace_identity,
            });
        }
        Err(HostWorkspaceRegistryErrorV2::EntropyUnavailable)
    }

    pub(crate) fn rebind(
        &self,
        workspace_binding_ref: &WorkspaceBindingRefV2,
        absolute_root: &Path,
    ) -> Result<HostWorkspaceBindingRegisteredV2, HostWorkspaceRegistryErrorV2> {
        self.require_operational()?;
        validate_workspace_binding_ref(workspace_binding_ref)?;
        let validated = validate_workspace_root(absolute_root)?;
        let mut state = self
            .inner
            .state
            .write()
            .map_err(|_| HostWorkspaceRegistryErrorV2::RegistryUnavailable)?;
        let HostWorkspaceRegistryStateV2::Operational {
            bindings,
            conflicts,
            startup_error,
        } = &mut *state
        else {
            return Err(HostWorkspaceRegistryErrorV2::RegistryUnavailable);
        };
        if !bindings.contains_key(workspace_binding_ref)
            && !conflicts.contains(workspace_binding_ref)
        {
            return Err(HostWorkspaceRegistryErrorV2::BindingNotFound);
        }
        let workspace_identity = workspace_identity_token(&validated);
        bindings.insert(
            workspace_binding_ref.clone(),
            WorkspaceBindingRecordV2::ready(&validated),
        );
        conflicts.remove(workspace_binding_ref);
        *startup_error = None;
        Ok(HostWorkspaceBindingRegisteredV2 {
            workspace_binding_ref: workspace_binding_ref.clone(),
            workspace_identity,
        })
    }

    pub(crate) fn unregister(
        &self,
        workspace_binding_ref: &WorkspaceBindingRefV2,
    ) -> Result<(), HostWorkspaceRegistryErrorV2> {
        self.require_operational()?;
        validate_workspace_binding_ref(workspace_binding_ref)?;
        let mut state = self
            .inner
            .state
            .write()
            .map_err(|_| HostWorkspaceRegistryErrorV2::RegistryUnavailable)?;
        let HostWorkspaceRegistryStateV2::Operational {
            bindings,
            conflicts,
            ..
        } = &mut *state
        else {
            return Err(HostWorkspaceRegistryErrorV2::RegistryUnavailable);
        };
        let removed = bindings.remove(workspace_binding_ref).is_some()
            | conflicts.remove(workspace_binding_ref);
        if removed {
            Ok(())
        } else {
            Err(HostWorkspaceRegistryErrorV2::BindingNotFound)
        }
    }

    pub(crate) fn unregister_exact(
        &self,
        workspace_binding_ref: &WorkspaceBindingRefV2,
        expected_workspace_identity: &str,
    ) -> Result<(), HostWorkspaceRegistryErrorV2> {
        self.require_operational()?;
        validate_workspace_binding_ref(workspace_binding_ref)?;
        let mut state = self
            .inner
            .state
            .write()
            .map_err(|_| HostWorkspaceRegistryErrorV2::RegistryUnavailable)?;
        let HostWorkspaceRegistryStateV2::Operational {
            bindings,
            conflicts,
            ..
        } = &mut *state
        else {
            return Err(HostWorkspaceRegistryErrorV2::RegistryUnavailable);
        };
        if conflicts.contains(workspace_binding_ref) {
            return Err(HostWorkspaceRegistryErrorV2::BindingIdentityMismatch);
        }
        let record = bindings
            .get(workspace_binding_ref)
            .ok_or(HostWorkspaceRegistryErrorV2::BindingNotFound)?;
        let WorkspaceBindingRecordV2::Ready {
            canonical_root,
            root_identity,
        } = record
        else {
            return Err(HostWorkspaceRegistryErrorV2::BindingIdentityMismatch);
        };
        if workspace_identity_token_from_stored(canonical_root, root_identity)
            != expected_workspace_identity
        {
            return Err(HostWorkspaceRegistryErrorV2::BindingIdentityMismatch);
        }
        bindings.remove(workspace_binding_ref);
        Ok(())
    }

    pub(crate) fn rehydrate(
        &self,
        records: Vec<HostWorkspaceRehydrateRecordV2>,
    ) -> Result<HostWorkspaceRehydrateResultV2, HostWorkspaceRegistryErrorV2> {
        self.begin_rehydrate()?;
        match stage_rehydrate_snapshot(records) {
            Ok(staged) => {
                let result = HostWorkspaceRehydrateResultV2 {
                    inserted_count: staged.bindings.len(),
                    already_bound_count: staged.already_bound_count,
                    conflict_count: staged.conflicts.len(),
                };
                self.publish_operational(staged.bindings, staged.conflicts, None)?;
                Ok(HostWorkspaceRehydrateResultV2 {
                    inserted_count: result.inserted_count,
                    already_bound_count: result.already_bound_count,
                    conflict_count: result.conflict_count,
                })
            }
            Err(error) => {
                self.publish_operational(HashMap::new(), HashSet::new(), Some(error))?;
                Err(error)
            }
        }
    }

    fn require_operational(&self) -> Result<(), HostWorkspaceRegistryErrorV2> {
        match self.readiness() {
            HostWorkspaceRegistryReadinessV2::Ready | HostWorkspaceRegistryReadinessV2::Failed => {
                Ok(())
            }
            HostWorkspaceRegistryReadinessV2::Cold
            | HostWorkspaceRegistryReadinessV2::Rehydrating => {
                Err(HostWorkspaceRegistryErrorV2::RegistryUnavailable)
            }
        }
    }

    fn begin_rehydrate(&self) -> Result<(), HostWorkspaceRegistryErrorV2> {
        let mut state = self
            .inner
            .state
            .write()
            .map_err(|_| HostWorkspaceRegistryErrorV2::RegistryUnavailable)?;
        if !matches!(*state, HostWorkspaceRegistryStateV2::Cold) {
            return Err(HostWorkspaceRegistryErrorV2::RegistryUnavailable);
        }
        *state = HostWorkspaceRegistryStateV2::Rehydrating;
        Ok(())
    }

    fn publish_operational(
        &self,
        bindings: HashMap<WorkspaceBindingRefV2, WorkspaceBindingRecordV2>,
        conflicts: HashSet<WorkspaceBindingRefV2>,
        startup_error: Option<HostWorkspaceRegistryErrorV2>,
    ) -> Result<(), HostWorkspaceRegistryErrorV2> {
        let mut state = self
            .inner
            .state
            .write()
            .map_err(|_| HostWorkspaceRegistryErrorV2::RegistryUnavailable)?;
        if !matches!(*state, HostWorkspaceRegistryStateV2::Rehydrating) {
            return Err(HostWorkspaceRegistryErrorV2::RegistryUnavailable);
        }
        *state = HostWorkspaceRegistryStateV2::Operational {
            bindings,
            conflicts,
            startup_error,
        };
        Ok(())
    }
}

impl HostWorkspaceBindingResolverV2 for HostWorkspaceRegistryV2 {
    fn resolve_workspace_binding(
        &self,
        workspace_binding_ref: &WorkspaceBindingRefV2,
    ) -> Result<PathBuf, HostWorkspaceResolveErrorV2> {
        let stored = {
            let state = self
                .inner
                .state
                .read()
                .map_err(|_| HostWorkspaceResolveErrorV2::Unavailable)?;
            let HostWorkspaceRegistryStateV2::Operational {
                bindings,
                conflicts,
                ..
            } = &*state
            else {
                return Err(HostWorkspaceResolveErrorV2::Unavailable);
            };
            if validate_workspace_binding_ref(workspace_binding_ref).is_err() {
                return Err(HostWorkspaceResolveErrorV2::NotFound);
            }
            if conflicts.contains(workspace_binding_ref) {
                return Err(HostWorkspaceResolveErrorV2::Stale);
            }
            bindings
                .get(workspace_binding_ref)
                .cloned()
                .ok_or(HostWorkspaceResolveErrorV2::NotFound)?
        };
        let WorkspaceBindingRecordV2::Ready {
            canonical_root,
            root_identity,
        } = stored
        else {
            return Err(HostWorkspaceResolveErrorV2::Stale);
        };
        let current = validate_workspace_root(&canonical_root).map_err(|error| match error {
            HostWorkspaceRegistryErrorV2::RootNotAbsolute
            | HostWorkspaceRegistryErrorV2::RootNotFound
            | HostWorkspaceRegistryErrorV2::RootNotDirectory => HostWorkspaceResolveErrorV2::Stale,
            _ => HostWorkspaceResolveErrorV2::Unavailable,
        })?;
        if current.canonical_root != canonical_root || current.root_identity != root_identity {
            return Err(HostWorkspaceResolveErrorV2::Stale);
        }
        Ok(current.canonical_root)
    }
}

impl HostWorkspaceRegistryInnerV2 {
    fn readiness(&self) -> HostWorkspaceRegistryReadinessV2 {
        let Ok(state) = self.state.read() else {
            return HostWorkspaceRegistryReadinessV2::Failed;
        };
        match &*state {
            HostWorkspaceRegistryStateV2::Cold => HostWorkspaceRegistryReadinessV2::Cold,
            HostWorkspaceRegistryStateV2::Rehydrating => {
                HostWorkspaceRegistryReadinessV2::Rehydrating
            }
            HostWorkspaceRegistryStateV2::Operational {
                conflicts,
                startup_error,
                ..
            } if conflicts.is_empty() && startup_error.is_none() => {
                HostWorkspaceRegistryReadinessV2::Ready
            }
            HostWorkspaceRegistryStateV2::Operational { .. } => {
                HostWorkspaceRegistryReadinessV2::Failed
            }
        }
    }
}

struct StagedWorkspaceBindingsV2 {
    bindings: HashMap<WorkspaceBindingRefV2, WorkspaceBindingRecordV2>,
    conflicts: HashSet<WorkspaceBindingRefV2>,
    already_bound_count: usize,
}

fn stage_rehydrate_snapshot(
    records: Vec<HostWorkspaceRehydrateRecordV2>,
) -> Result<StagedWorkspaceBindingsV2, HostWorkspaceRegistryErrorV2> {
    if records.len() > MAX_WORKSPACE_REHYDRATE_BATCH_V2 {
        return Err(HostWorkspaceRegistryErrorV2::RehydrateBatchTooLarge);
    }
    let mut candidates = HashMap::with_capacity(records.len());
    let mut conflicts = HashSet::new();
    let mut already_bound_count = 0;
    for record in records {
        validate_workspace_binding_ref(&record.workspace_binding_ref)?;
        if !record.absolute_root.is_absolute() {
            return Err(HostWorkspaceRegistryErrorV2::RootNotAbsolute);
        }
        let candidate = (record.absolute_root, record.workspace_identity);
        match candidates.get(&record.workspace_binding_ref) {
            Some(existing) if existing != &candidate => {
                candidates.remove(&record.workspace_binding_ref);
                conflicts.insert(record.workspace_binding_ref);
            }
            Some(_) => already_bound_count += 1,
            None => {
                if !conflicts.contains(&record.workspace_binding_ref) {
                    candidates.insert(record.workspace_binding_ref, candidate);
                }
            }
        }
    }
    if candidates.len() + conflicts.len() > MAX_WORKSPACE_BINDINGS_V2 {
        return Err(HostWorkspaceRegistryErrorV2::CapacityExceeded);
    }
    let bindings = candidates
        .into_iter()
        .map(
            |(workspace_binding_ref, (absolute_root, expected_identity))| {
                let binding = match validate_workspace_root(&absolute_root) {
                    Ok(validated)
                        if validated.canonical_root == absolute_root
                            && expected_identity.as_deref()
                                == Some(workspace_identity_token(&validated).as_str()) =>
                    {
                        WorkspaceBindingRecordV2::ready(&validated)
                    }
                    _ => WorkspaceBindingRecordV2::Stale {
                        configured_root: absolute_root,
                    },
                };
                (workspace_binding_ref, binding)
            },
        )
        .collect();
    Ok(StagedWorkspaceBindingsV2 {
        bindings,
        conflicts,
        already_bound_count,
    })
}

impl WorkspaceBindingRecordV2 {
    fn ready(value: &ValidatedWorkspaceRootV2) -> Self {
        Self::Ready {
            canonical_root: value.canonical_root.clone(),
            root_identity: value.root_identity,
        }
    }
}

fn validate_workspace_root(
    absolute_root: &Path,
) -> Result<ValidatedWorkspaceRootV2, HostWorkspaceRegistryErrorV2> {
    if !absolute_root.is_absolute() {
        return Err(HostWorkspaceRegistryErrorV2::RootNotAbsolute);
    }
    let canonical_root = fs::canonicalize(absolute_root).map_err(classify_root_io_error)?;
    if !canonical_root.is_absolute() {
        return Err(HostWorkspaceRegistryErrorV2::RootNotAbsolute);
    }
    let metadata = fs::metadata(&canonical_root).map_err(classify_root_io_error)?;
    if !metadata.is_dir() {
        return Err(HostWorkspaceRegistryErrorV2::RootNotDirectory);
    }
    fs::read_dir(&canonical_root).map_err(classify_root_io_error)?;

    #[cfg(unix)]
    let root_identity = {
        use std::os::unix::fs::MetadataExt;
        WorkspaceRootIdentityV2 {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    };
    #[cfg(not(unix))]
    let root_identity = WorkspaceRootIdentityV2;

    Ok(ValidatedWorkspaceRootV2 {
        canonical_root,
        root_identity,
    })
}

#[cfg(unix)]
fn workspace_identity_token(root: &ValidatedWorkspaceRootV2) -> String {
    format!(
        "deepcode.workspace-root.v2:unix:{:016x}:{:016x}",
        root.root_identity.device, root.root_identity.inode
    )
}

#[cfg(unix)]
fn workspace_identity_token_from_stored(
    _canonical_root: &Path,
    root_identity: &WorkspaceRootIdentityV2,
) -> String {
    format!(
        "deepcode.workspace-root.v2:unix:{:016x}:{:016x}",
        root_identity.device, root_identity.inode
    )
}

#[cfg(not(unix))]
fn workspace_identity_token(root: &ValidatedWorkspaceRootV2) -> String {
    format!(
        "deepcode.workspace-root.v2:path:{}",
        deepcode_kernel_tools::hash_bytes(root.canonical_root.to_string_lossy().as_bytes())
    )
}

#[cfg(not(unix))]
fn workspace_identity_token_from_stored(
    canonical_root: &Path,
    _root_identity: &WorkspaceRootIdentityV2,
) -> String {
    format!(
        "deepcode.workspace-root.v2:path:{}",
        deepcode_kernel_tools::hash_bytes(canonical_root.to_string_lossy().as_bytes())
    )
}

fn classify_root_io_error(error: std::io::Error) -> HostWorkspaceRegistryErrorV2 {
    match error.kind() {
        std::io::ErrorKind::NotFound => HostWorkspaceRegistryErrorV2::RootNotFound,
        _ => HostWorkspaceRegistryErrorV2::RootInaccessible,
    }
}

fn validate_workspace_binding_ref(
    workspace_binding_ref: &WorkspaceBindingRefV2,
) -> Result<(), HostWorkspaceRegistryErrorV2> {
    let Some(encoded) = workspace_binding_ref
        .as_str()
        .strip_prefix(WORKSPACE_BINDING_REF_PREFIX_V2)
    else {
        return Err(HostWorkspaceRegistryErrorV2::InvalidBindingReference);
    };
    if encoded.len() != WORKSPACE_BINDING_REF_ENTROPY_BYTES_V2 * 2
        || !encoded
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(HostWorkspaceRegistryErrorV2::InvalidBindingReference);
    }
    Ok(())
}

fn issue_workspace_binding_ref() -> Result<WorkspaceBindingRefV2, HostWorkspaceRegistryErrorV2> {
    let mut entropy = [0_u8; WORKSPACE_BINDING_REF_ENTROPY_BYTES_V2];
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut entropy))
        .map_err(|_| HostWorkspaceRegistryErrorV2::EntropyUnavailable)?;
    WorkspaceBindingRefV2::new(format!(
        "{WORKSPACE_BINDING_REF_PREFIX_V2}{}",
        encode_hex(&entropy)
    ))
    .map_err(|_| HostWorkspaceRegistryErrorV2::EntropyUnavailable)
}

fn encode_hex(value: &[u8]) -> String {
    let mut output = String::with_capacity(value.len() * 2);
    for byte in value {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    output
}
