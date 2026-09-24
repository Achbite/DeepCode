//! Temporary invocation-specific ACEs. Remove only our SID, never restore a stale
//! copy of someone else's DACL. Handles retain ownership across file renames.
use super::os::*;
use super::windows_policy::{Access, Grant};
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{SystemServices::SECURITY_DESCRIPTOR_REVISION, Threading::*},
};

const READ: u32 = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
const TRAVERSE: u32 = FILE_TRAVERSE | FILE_READ_ATTRIBUTES;
// FILE_DELETE_CHILD would allow deletion of a protected .git through its parent.
const WRITE: u32 =
    FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | DELETE;
const DENY_WRITE: u32 = WRITE | FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER;

pub(super) struct Grants {
    sid: Local,
    paths: Vec<(PathBuf, Handle, bool)>,
}

impl Grants {
    pub(super) fn new(identity: &str) -> Result<Self, String> {
        Ok(Self {
            sid: sid(identity)?,
            paths: Vec::new(),
        })
    }

    pub(super) fn apply(&mut self, grants: &[Grant], token: HANDLE) -> Result<(), String> {
        let _lock = AclLock::acquire()?;
        let runtime = RuntimeAccess::new(token)?;
        for grant in grants {
            let metadata = match std::fs::metadata(&grant.path) {
                Ok(metadata) => metadata,
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        && grant.access == Access::Read =>
                {
                    continue
                }
                Err(error) => {
                    return Err(format!(
                        "Inspect sandbox path {}: {error}",
                        grant.path.display()
                    ))
                }
            };
            let mask = match grant.access {
                Access::Read => READ,
                Access::Traverse => TRAVERSE,
                Access::Write => READ | WRITE,
                Access::DenyWrite => DENY_WRITE,
            };
            // A normal user's Everyone/Users/AAP access is not proof of LPAC
            // access. Query the suspended child, including its package claims.
            if matches!(grant.access, Access::Read | Access::Traverse)
                && runtime.can_access(&grant.path, mask)?
            {
                continue;
            }
            let handle = unsafe {
                CreateFileW(
                    wide(&grant.path).as_ptr(),
                    READ_CONTROL | WRITE_DAC,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS,
                    null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(error(&format!(
                    "Open sandbox ACL {} (the current user must be able to grant this resource)",
                    grant.path.display()
                )));
            }
            let handle = Handle(handle);
            // Register before SetSecurityInfo: propagation can partially change
            // descendants before reporting an error, so cleanup must still run.
            self.paths
                .push((grant.path.clone(), handle, grant.access != Access::Traverse));
            let mode = if grant.access == Access::DenyWrite {
                DENY_ACCESS
            } else {
                GRANT_ACCESS
            };
            let inherit = if metadata.is_dir() && grant.access != Access::Traverse {
                SUB_CONTAINERS_AND_OBJECTS_INHERIT
            } else {
                NO_INHERITANCE
            };
            edit(
                self.paths.last().unwrap().1 .0,
                self.sid.0,
                mode,
                mask,
                inherit,
                grant.access != Access::Traverse,
            )
            .map_err(|error| format!("Grant sandbox path {}: {error}", grant.path.display()))?;
        }
        Ok(())
    }

    pub(super) fn cleanup(&mut self) -> Result<(), String> {
        if self.paths.is_empty() {
            return Ok(());
        }
        let _lock = AclLock::acquire()?;
        let mut failures = Vec::new();
        // Parent first: removal propagates inherited ACEs before child cleanup.
        self.paths
            .sort_by_key(|(path, _, _)| path.components().count());
        self.paths.retain(|(path, handle, propagate)| {
            match edit(
                handle.0,
                self.sid.0,
                REVOKE_ACCESS,
                0,
                NO_INHERITANCE,
                *propagate,
            ) {
                Ok(()) => false,
                Err(error) => {
                    failures.push(format!("{}: {error}", path.display()));
                    true
                }
            }
        });
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!("Remove invocation ACLs: {}", failures.join("; ")))
        }
    }
}
impl Drop for Grants {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            eprintln!("{error}");
        }
    }
}

fn trustee(sid: PSID) -> TRUSTEE_W {
    TRUSTEE_W {
        pMultipleTrustee: null_mut(),
        MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_UNKNOWN,
        ptstrName: sid.cast(),
    }
}

fn edit(
    handle: HANDLE,
    sid: PSID,
    mode: ACCESS_MODE,
    mask: u32,
    inheritance: u32,
    propagate: bool,
) -> Result<(), String> {
    let (mut descriptor, mut acl) = (null_mut(), null_mut());
    let result = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if result == ERROR_FILE_NOT_FOUND || result == ERROR_DELETE_PENDING {
        return Ok(());
    }
    code("Read path DACL", result)?;
    let _descriptor = Local(descriptor);
    // A null DACL grants unrestricted access and cannot express a read boundary.
    if acl.is_null() {
        return Err("The path has no discretionary access control list".into());
    }
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: mask,
        grfAccessMode: mode,
        grfInheritance: inheritance,
        Trustee: trustee(sid),
    };
    let mut updated = null_mut();
    code("Build invocation ACL", unsafe {
        SetEntriesInAclW(1, &entry, acl, &mut updated)
    })?;
    let _updated = Local(updated.cast());
    if !propagate {
        return set_directory_metadata_dacl(handle, updated);
    }
    code("Apply invocation ACL", unsafe {
        SetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            updated,
            null_mut(),
        )
    })
}

// SetSecurityInfo propagates every existing inheritable ACE, even when the new
// ACE is not inheritable. Set only this directory's DACL through the native
// handle API, preserving inherited entries and the current protection state.
// MAXIMUM_ALLOWED handles also suppress propagation, but request DELETE access
// and conflict with ordinary open working-directory handles.
fn set_directory_metadata_dacl(handle: HANDLE, acl: *mut ACL) -> Result<(), String> {
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtSetSecurityObject(
            handle: HANDLE,
            information: u32,
            descriptor: PSECURITY_DESCRIPTOR,
        ) -> i32;
    }
    let mut descriptor: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let pointer = (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast();
    if unsafe { InitializeSecurityDescriptor(pointer, SECURITY_DESCRIPTOR_REVISION) } == 0
        || unsafe { SetSecurityDescriptorDacl(pointer, 1, acl, 0) } == 0
    {
        return Err(error("Build ancestor metadata DACL"));
    }
    let status = unsafe { NtSetSecurityObject(handle, DACL_SECURITY_INFORMATION, pointer) };
    if status < 0 {
        Err(format!(
            "Apply ancestor metadata DACL: NTSTATUS {status:#x}"
        ))
    } else {
        Ok(())
    }
}

// Use the real child token: Store runtime access also depends on package claims.
// AccessCheck preserves LPAC restrictions and handles inherited deny ACEs that
// GetEffectiveRightsFromAcl rejects as ERROR_INVALID_ACL. Never impersonate the
// child on the worker thread while changing ACLs.
struct RuntimeAccess(Handle);

impl RuntimeAccess {
    fn new(token: HANDLE) -> Result<Self, String> {
        let mut impersonation = null_mut();
        if unsafe { DuplicateToken(token, SecurityIdentification, &mut impersonation) } == 0 {
            return Err(error("Duplicate LPAC token for runtime access checks"));
        }
        Ok(Self(Handle(impersonation)))
    }

    fn can_access(&self, path: &std::path::Path, mask: u32) -> Result<bool, String> {
        self.check(path, mask)
            .map_err(|error| format!("Check LPAC runtime read access {}: {error}", path.display()))
    }

    fn check(&self, path: &std::path::Path, mask: u32) -> Result<bool, String> {
        let (mut descriptor, mut acl) = (null_mut(), null_mut());
        code("Read runtime path DACL", unsafe {
            GetNamedSecurityInfoW(
                wide(path).as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut acl,
                null_mut(),
                &mut descriptor,
            )
        })?;
        let _descriptor = Local(descriptor);
        if acl.is_null() {
            return Err("The path has no discretionary access control list".into());
        }
        let mapping = GENERIC_MAPPING {
            GenericRead: FILE_GENERIC_READ,
            GenericWrite: FILE_GENERIC_WRITE,
            GenericExecute: FILE_GENERIC_EXECUTE,
            GenericAll: FILE_ALL_ACCESS,
        };
        let mut privileges: PRIVILEGE_SET = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of_val(&privileges) as u32;
        let (mut rights, mut allowed) = (0, 0);
        if unsafe {
            AccessCheck(
                descriptor,
                self.0 .0,
                mask,
                &mapping,
                &mut privileges,
                &mut length,
                &mut rights,
                &mut allowed,
            )
        } == 0
        {
            return Err(error("Evaluate runtime read access"));
        }
        Ok(allowed != 0 && rights & mask == mask)
    }
}

// Kernel tool workers are separate processes. Serialize DACL read/modify/write
// across them; the mutex is held only during grant/revoke, never shell execution.
struct AclLock(Handle);
impl AclLock {
    fn acquire() -> Result<Self, String> {
        let handle = unsafe {
            CreateMutexW(
                null(),
                0,
                wide(r"Local\DeepCode.WorkspaceSandbox.Acl").as_ptr(),
            )
        };
        if handle.is_null() {
            return Err(error("Create sandbox ACL mutex"));
        }
        let handle = Handle(handle);
        let result = unsafe { WaitForSingleObject(handle.0, 30_000) };
        if result != WAIT_OBJECT_0 && result != WAIT_ABANDONED {
            return Err(format!("Acquire sandbox ACL mutex: wait result {result}"));
        }
        Ok(Self(handle))
    }
}
impl Drop for AclLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0 .0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            if let Err(error) = std::fs::remove_dir_all(&self.0) {
                eprintln!(
                    "Remove owned ACL test directory {}: {error}",
                    self.0.display()
                );
            }
        }
    }
    #[test]
    fn invocation_aces_are_removed_without_replacing_other_grants() {
        let root = std::env::temp_dir().join(format!("deepcode-acl-{}", random_text()));
        std::fs::create_dir(&root).unwrap();
        let _directory = Directory(root.clone());
        let first_profile = super::super::profile::Profile::create(false).unwrap();
        let second_profile = super::super::profile::Profile::create(false).unwrap();
        let identity = first_profile.sid_string().unwrap();
        let other = second_profile.sid_string().unwrap();
        let mut first = Grants::new(&identity).unwrap();
        let mut second = Grants::new(&other).unwrap();
        let path = root.canonicalize().unwrap();
        apply(&mut first, &first_profile, &path, Access::Write);
        apply(&mut second, &second_profile, &path, Access::Read);
        assert!(contains_sid(&path, first.sid.0));
        first.cleanup().unwrap();
        assert!(!contains_sid(&path, first.sid.0));
        assert!(contains_sid(&path, second.sid.0));
        second.cleanup().unwrap();
        assert!(!contains_sid(&path, second.sid.0));
    }
    fn apply(
        grants: &mut Grants,
        profile: &super::super::profile::Profile,
        path: &std::path::Path,
        access: Access,
    ) {
        let system = std::env::var_os("SystemRoot").unwrap();
        let directory = PathBuf::from(&system).join("System32");
        let mut command = std::process::Command::new(directory.join("cmd.exe"));
        command
            .args(["/d", "/c", "exit", "0"])
            .current_dir(directory)
            .env_clear()
            .env("SystemRoot", system)
            .env("LOCALAPPDATA", std::env::var_os("LOCALAPPDATA").unwrap());
        let mut child = super::super::runner::spawn(&command, false, profile, |token| {
            grants.apply(
                &[Grant {
                    path: path.to_path_buf(),
                    access,
                }],
                token,
            )
        })
        .unwrap();
        child.stop().unwrap();
    }

    fn contains_sid(path: &std::path::Path, sid: PSID) -> bool {
        let (mut descriptor, mut acl) = (null_mut(), null_mut());
        code("Read test DACL", unsafe {
            GetNamedSecurityInfoW(
                wide(path).as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut acl,
                null_mut(),
                &mut descriptor,
            )
        })
        .unwrap();
        let _owner = Local(descriptor);
        for index in 0..unsafe { (*acl).AceCount } {
            let mut ace = null_mut();
            assert_ne!(unsafe { GetAce(acl, u32::from(index), &mut ace) }, 0);
            let ace = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
            // These test directories use ordinary allow/deny ACE layouts.
            if matches!(ace.Header.AceType, 0 | 1)
                && unsafe { EqualSid((&ace.SidStart as *const u32).cast_mut().cast(), sid) } != 0
            {
                return true;
            }
        }
        false
    }
}
