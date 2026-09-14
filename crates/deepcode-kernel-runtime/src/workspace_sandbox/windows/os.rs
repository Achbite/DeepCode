use std::ffi::c_void;
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::core::GUID;
use windows_sys::Win32::{
    Foundation::*, Security::Authorization::*, Security::*, System::Threading::*,
};

pub(super) fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

/// Shells treat a verbatim DOS cwd as a UNC location and may start at C:\ instead.
/// Keep canonical paths for ACLs, but pass the equivalent Win32 path to processes.
pub(super) fn process_path(path: &Path) -> Vec<u16> {
    let value = wide(path);
    match path.components().next() {
        Some(std::path::Component::Prefix(prefix)) => match prefix.kind() {
            std::path::Prefix::VerbatimDisk(_) => value[4..].to_vec(),
            std::path::Prefix::VerbatimUNC(_, _) => {
                [wide(r"\\")[..2].to_vec(), value[8..].to_vec()].concat()
            }
            _ => value,
        },
        _ => value,
    }
}
pub(super) fn error(operation: &str) -> String {
    format!("{operation}: {}", std::io::Error::last_os_error())
}
pub(super) fn code(operation: &str, result: u32) -> Result<(), String> {
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "{operation}: {}",
            std::io::Error::from_raw_os_error(result as i32)
        ))
    }
}
pub(super) struct Handle(pub HANDLE);
unsafe impl Send for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                CloseHandle(self.0);
            }
        }
    }
}
pub(super) struct Local(pub *mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                LocalFree(self.0);
            }
        }
    }
}

pub(super) fn sid(value: &str) -> Result<Local, String> {
    let mut pointer = null_mut();
    if unsafe { ConvertStringSidToSidW(wide(value).as_ptr(), &mut pointer) } == 0 {
        return Err(error("Parse SID"));
    }
    Ok(Local(pointer))
}
pub(super) fn sid_string(pointer: PSID) -> Result<String, String> {
    let mut value = null_mut();
    if unsafe { ConvertSidToStringSidW(pointer, &mut value) } == 0 {
        return Err(error("Format SID"));
    }
    let _owner = Local(value.cast());
    let len = unsafe { (0..).take_while(|i| *value.add(*i) != 0).count() };
    Ok(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(value, len)
    }))
}
pub(super) fn current_token() -> Result<Handle, String> {
    let mut token = null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
            &mut token,
        )
    } == 0
    {
        return Err(error("Open process token"));
    }
    Ok(Handle(token))
}
pub(super) fn current_user_sid() -> Result<String, String> {
    let token = current_token()?;
    let mut length = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut length);
    }
    let mut data = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            data.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(error("Read token user"));
    }
    sid_string(unsafe { (*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid })
}
pub(super) fn uuid() -> GUID {
    let mut guid: GUID = unsafe { std::mem::zeroed() };
    unsafe {
        windows_sys::Win32::System::Rpc::UuidCreate(&mut guid);
    }
    guid
}
pub(super) fn random_text() -> String {
    let id = uuid();
    format!(
        "{:08x}{:04x}{:04x}{}",
        id.data1,
        id.data2,
        id.data3,
        id.data4
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<String>()
    )
}
pub(super) fn new_capability_sid() -> Result<String, String> {
    let id = uuid();
    Ok(format!(
        "S-1-5-21-{}-{}-{}-{}",
        id.data1,
        (u32::from(id.data2) << 16) | u32::from(id.data3),
        u32::from_ne_bytes(id.data4[..4].try_into().unwrap()),
        u32::from_ne_bytes(id.data4[4..].try_into().unwrap())
    ))
}

pub(super) fn grant(path: &Path, account: &str, permissions: u32) -> Result<(), String> {
    update_acl(path, account, permissions, GRANT_ACCESS)
}

/// System-installed executables already grant the sandbox account read/execute
/// access. Check that access before attempting to edit a protected file's DACL.
pub(super) fn grant_program_read(path: &Path, account: &str, token: &Handle) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ALL_ACCESS, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    };
    let mut descriptor = null_mut();
    code("Read program security descriptor", unsafe {
        GetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    })?;
    let descriptor = Local(descriptor);
    let mut impersonation = null_mut();
    if unsafe { DuplicateToken(token.0, SecurityImpersonation, &mut impersonation) } == 0 {
        return Err(error("Duplicate workspace access-check token"));
    }
    let impersonation = Handle(impersonation);
    let mapping = GENERIC_MAPPING {
        GenericRead: FILE_GENERIC_READ,
        GenericWrite: FILE_GENERIC_WRITE,
        GenericExecute: FILE_GENERIC_EXECUTE,
        GenericAll: FILE_ALL_ACCESS,
    };
    let access = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    let mut privileges: PRIVILEGE_SET = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<PRIVILEGE_SET>() as u32;
    let mut granted = 0;
    let mut allowed = 0;
    if unsafe {
        AccessCheck(
            descriptor.0,
            impersonation.0,
            access,
            &mapping,
            &mut privileges,
            &mut length,
            &mut granted,
            &mut allowed,
        )
    } == 0
    {
        return Err(error("Check workspace program access"));
    }
    if allowed != 0 {
        return Ok(());
    }
    grant(path, account, access)
}
pub(super) fn revoke(path: &Path, account: &str) -> Result<(), String> {
    update_acl(path, account, 0, REVOKE_ACCESS)
}
fn update_acl(
    path: &Path,
    account: &str,
    permissions: u32,
    mode: ACCESS_MODE,
) -> Result<(), String> {
    let name = wide(path);
    let sid = sid(account)?;
    let mut old_acl = null_mut();
    let mut descriptor = null_mut();
    code("Read workspace ACL", unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_acl,
            null_mut(),
            &mut descriptor,
        )
    })?;
    let _descriptor = Local(descriptor);
    let mut entry: EXPLICIT_ACCESS_W = unsafe { std::mem::zeroed() };
    entry.grfAccessPermissions = permissions;
    entry.grfAccessMode = mode;
    entry.grfInheritance = if path.is_dir() {
        SUB_CONTAINERS_AND_OBJECTS_INHERIT
    } else {
        0
    };
    entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    entry.Trustee.ptstrName = sid.0.cast();
    let mut new_acl = null_mut();
    code("Prepare workspace ACL", unsafe {
        SetEntriesInAclW(1, &entry, old_acl, &mut new_acl)
    })?;
    let _new_acl = Local(new_acl.cast());
    code("Apply workspace ACL", unsafe {
        SetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            new_acl,
            null_mut(),
        )
    })
}

pub(super) fn descriptor(sddl: &str) -> Result<Local, String> {
    let mut result = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(sddl).as_ptr(),
            SDDL_REVISION_1,
            &mut result,
            null_mut(),
        )
    } == 0
    {
        return Err(error("Create access descriptor"));
    }
    Ok(Local(result))
}
pub(super) fn protect_file(path: &Path, owner: &str) -> Result<(), String> {
    let descriptor = descriptor(&format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{owner})"))?;
    let mut acl = null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut acl, &mut defaulted) }
        == 0
    {
        return Err(error("Read credential ACL"));
    }
    code("Protect sandbox credentials", unsafe {
        SetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            acl,
            null_mut(),
        )
    })
}

pub(super) fn restricted_token(write_sid: &str) -> Result<Handle, String> {
    let base = current_token()?;
    let capability = sid(write_sid)?;
    let everyone = sid("S-1-1-0")?;
    let mut length = 0;
    unsafe { GetTokenInformation(base.0, TokenLogonSid, null_mut(), 0, &mut length) };
    let mut group_data = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            base.0,
            TokenLogonSid,
            group_data.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(error("Read workspace logon SID"));
    }
    let groups = unsafe { &*group_data.as_ptr().cast::<TOKEN_GROUPS>() };
    if groups.GroupCount != 1 {
        return Err("Workspace worker must have one logon SID.".into());
    }
    let logon_sid = sid_string(groups.Groups[0].Sid)?;
    let restricting = [
        SID_AND_ATTRIBUTES {
            Sid: capability.0,
            Attributes: 0,
        },
        // Windows runtime objects belong to this invocation's fresh logon.
        SID_AND_ATTRIBUTES {
            Sid: groups.Groups[0].Sid,
            Attributes: 0,
        },
        // Windows runtime devices (including CNG) require Everyone access.
        SID_AND_ATTRIBUTES {
            Sid: everyone.0,
            Attributes: 0,
        },
    ];
    let mut token = null_mut();
    // Restrict writes; retain ordinary toolchain reads. The account is not an administrator.
    if unsafe {
        CreateRestrictedToken(
            base.0,
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN | 0x08,
            0,
            null(),
            0,
            null(),
            restricting.len() as u32,
            restricting.as_ptr(),
            &mut token,
        )
    } == 0
    {
        return Err(error("Create workspace token"));
    }
    let token = Handle(token);
    let user = current_user_sid()?;
    let dacl = descriptor(&format!(
        "D:(A;;GA;;;{user})(A;;GA;;;{write_sid})(A;;GA;;;{logon_sid})(A;;GA;;;SY)"
    ))?;
    let mut acl = null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorDacl(dacl.0, &mut present, &mut acl, &mut defaulted) } == 0 {
        return Err(error("Read process object ACL"));
    }
    let default_dacl = TOKEN_DEFAULT_DACL { DefaultDacl: acl };
    if unsafe {
        SetTokenInformation(
            token.0,
            TokenDefaultDacl,
            (&default_dacl as *const TOKEN_DEFAULT_DACL).cast(),
            std::mem::size_of_val(&default_dacl) as u32,
        )
    } == 0
    {
        return Err(error("Set process object ACL"));
    }
    Ok(token)
}

/// Windows command-line encoding for native argv. User scripts remain files or
/// individual Bash arguments, rather than being reinterpreted by cmd.exe.
pub(super) fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            result.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
        } else {
            result.extend(std::iter::repeat_n('\\', slashes));
        }
        slashes = 0;
        result.push(ch);
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}
