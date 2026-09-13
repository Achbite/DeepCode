use super::{os::*, *};
use base64::Engine;
use std::ptr::{null, null_mut};
use windows_sys::Win32::{
    NetworkManagement::NetManagement::*, NetworkManagement::WindowsFilteringPlatform::*,
    Security::Cryptography::*, Security::*, System::Rpc::RPC_C_AUTHN_WINNT,
};

fn crypt(input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    let source = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &source,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &source,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(error("Protect sandbox account credential"));
    }
    let _allocation = Local(output.pbData.cast());
    Ok(unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec())
}
pub(super) fn password(state: &Installation) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&state.protected_password)
        .map_err(|e| e.to_string())?;
    String::from_utf8(crypt(&bytes, false)?).map_err(|e| e.to_string())
}

fn account_sid(account: &str) -> Result<String, String> {
    let mut size = 0;
    let mut domain_size = 0;
    let mut usage = 0;
    unsafe {
        LookupAccountNameW(
            null(),
            wide(account).as_ptr(),
            null_mut(),
            &mut size,
            null_mut(),
            &mut domain_size,
            &mut usage,
        );
    }
    let mut sid = vec![0u8; size as usize];
    let mut domain = vec![0u16; domain_size as usize];
    if unsafe {
        LookupAccountNameW(
            null(),
            wide(account).as_ptr(),
            sid.as_mut_ptr().cast(),
            &mut size,
            domain.as_mut_ptr(),
            &mut domain_size,
            &mut usage,
        )
    } == 0
    {
        return Err(error("Resolve sandbox account"));
    }
    sid_string(sid.as_mut_ptr().cast())
}

struct EngineHandle(windows_sys::Win32::Foundation::HANDLE);
impl EngineHandle {
    fn open() -> Result<Self, String> {
        let mut handle = null_mut();
        code("Open Windows network policy", unsafe {
            FwpmEngineOpen0(
                null(),
                RPC_C_AUTHN_WINNT as u32,
                null(),
                null(),
                &mut handle,
            )
        })?;
        Ok(Self(handle))
    }
}
impl Drop for EngineHandle {
    fn drop(&mut self) {
        unsafe {
            FwpmEngineClose0(self.0);
        }
    }
}

pub(super) fn check(state: &Installation) -> Result<(), String> {
    if account_sid(&state.account)? != state.account_sid {
        return Err("The configured sandbox account is unavailable. Run sandbox setup from Execution environment settings.".into());
    }
    let engine = EngineHandle::open()?;
    if state.network_filters.len() != 4 {
        return Err("Windows workspace network policy is incomplete.".into());
    }
    for id in &state.network_filters {
        let mut filter = null_mut();
        code("Read Windows workspace network policy", unsafe {
            FwpmFilterGetById0(engine.0, *id, &mut filter)
        })?;
        unsafe {
            FwpmFreeMemory0((&mut filter as *mut *mut FWPM_FILTER0).cast());
        }
    }
    Ok(())
}

fn network_filters(account: &str) -> Result<Vec<u64>, String> {
    let engine = EngineHandle::open()?;
    let descriptor = descriptor(&format!("D:(A;;0x{FWP_ACTRL_MATCH_FILTER:x};;;{account})"))?;
    let mut blob = FWP_BYTE_BLOB {
        size: unsafe { GetSecurityDescriptorLength(descriptor.0) },
        data: descriptor.0.cast(),
    };
    let mut condition: FWPM_FILTER_CONDITION0 = unsafe { std::mem::zeroed() };
    condition.fieldKey = FWPM_CONDITION_ALE_USER_ID;
    condition.matchType = FWP_MATCH_EQUAL;
    condition.conditionValue.r#type = FWP_SECURITY_DESCRIPTOR_TYPE;
    condition.conditionValue.Anonymous.sd = &mut blob;
    let name = wide("DeepCode workspace Shell (offline)");
    let mut ids = Vec::new();
    let result = (|| {
        for layer in [
            FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
            FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
        ] {
            let mut filter: FWPM_FILTER0 = unsafe { std::mem::zeroed() };
            filter.filterKey = uuid();
            filter.displayData.name = name.as_ptr() as *mut u16;
            filter.flags = FWPM_FILTER_FLAG_PERSISTENT;
            filter.layerKey = layer;
            filter.subLayerKey = FWPM_SUBLAYER_UNIVERSAL;
            filter.weight.r#type = FWP_EMPTY;
            filter.action.r#type = FWP_ACTION_BLOCK;
            filter.numFilterConditions = 1;
            filter.filterCondition = &mut condition;
            let mut id = 0;
            code("Install workspace network policy", unsafe {
                FwpmFilterAdd0(engine.0, &filter, null_mut(), &mut id)
            })?;
            ids.push(id);
        }
        Ok::<_, String>(())
    })();
    if let Err(error) = result {
        for id in ids {
            unsafe {
                FwpmFilterDeleteById0(engine.0, id);
            }
        }
        return Err(error);
    }
    Ok(ids)
}

pub(super) fn install(path: &Path, owner: &str) -> Result<(), String> {
    if path.exists() {
        let state: Installation =
            serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        return check(&state);
    }
    let account = format!("DeepCode_{}", &random_text()[..10]);
    let secret = format!("Dc7!{}{}", random_text(), random_text());
    let name_w = wide(&account);
    let secret_w = wide(&secret);
    let comment = wide("DeepCode local workspace Shell execution");
    let mut info: USER_INFO_1 = unsafe { std::mem::zeroed() };
    info.usri1_name = name_w.as_ptr() as *mut u16;
    info.usri1_password = secret_w.as_ptr() as *mut u16;
    info.usri1_priv = USER_PRIV_USER;
    info.usri1_comment = comment.as_ptr() as *mut u16;
    info.usri1_flags = UF_SCRIPT | UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE;
    let mut parameter = 0;
    code(
        "Create local Shell account (administrator initialization required)",
        unsafe {
            NetUserAdd(
                null(),
                1,
                (&info as *const USER_INFO_1).cast(),
                &mut parameter,
            )
        },
    )?;
    let mut filters = Vec::new();
    let result = (|| {
        let account_sid = account_sid(&account)?;
        filters = network_filters(&account_sid)?;
        let protected_password =
            base64::engine::general_purpose::STANDARD.encode(crypt(secret.as_bytes(), true)?);
        let state = Installation {
            account: account.clone(),
            account_sid,
            protected_password,
            network_filters: filters.clone(),
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(
            path,
            serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        protect_file(path, owner)?;
        check(&state)
    })();
    if result.is_err() {
        if let Ok(engine) = EngineHandle::open() {
            for id in filters {
                unsafe {
                    FwpmFilterDeleteById0(engine.0, id);
                }
            }
        }
        unsafe {
            NetUserDel(null(), name_w.as_ptr());
        }
        let _ = fs::remove_file(path);
    }
    result
}
