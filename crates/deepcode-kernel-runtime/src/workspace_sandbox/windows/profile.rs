use super::os::*;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Security::{Authorization::ConvertSidToStringSidW, Isolation::*, *};
use windows_sys::Win32::System::SystemServices::SE_GROUP_ENABLED;

pub(super) struct Profile {
    name: Vec<u16>,
    sid: PSID,
    _capability_storage: Vec<Local>,
    capabilities: Vec<SID_AND_ATTRIBUTES>,
    active: bool,
}

impl Profile {
    pub(super) fn create(network: bool) -> Result<Self, String> {
        let mut storage = Vec::new();
        for name in super::windows_policy::capabilities(network) {
            storage.push(capability(name)?);
        }
        let capabilities: Vec<_> = storage
            .iter()
            .map(|sid| SID_AND_ATTRIBUTES {
                Sid: sid.0,
                Attributes: SE_GROUP_ENABLED as u32,
            })
            .collect();
        let name = wide(format!("DeepCode.Shell.{}", random_text()));
        let mut sid = null_mut();
        let result = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                name.as_ptr(),
                name.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if result < 0 {
            return Err(format!(
                "Create invocation AppContainer profile: HRESULT {result:#x}"
            ));
        }
        Ok(Self {
            name,
            sid,
            _capability_storage: storage,
            capabilities,
            active: true,
        })
    }

    pub(super) fn security(&self) -> SECURITY_CAPABILITIES {
        SECURITY_CAPABILITIES {
            AppContainerSid: self.sid,
            Capabilities: self.capabilities.as_ptr() as *mut _,
            CapabilityCount: self.capabilities.len() as u32,
            Reserved: 0,
        }
    }

    pub(super) fn sid_string(&self) -> Result<String, String> {
        let mut text = null_mut();
        if unsafe { ConvertSidToStringSidW(self.sid, &mut text) } == 0 {
            return Err(error("Format AppContainer SID"));
        }
        let _owner = Local(text.cast());
        let length = unsafe { (0..).take_while(|i| *text.add(*i) != 0).count() };
        Ok(String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(text, length)
        }))
    }

    pub(super) fn cleanup(&mut self) -> Result<(), String> {
        if self.active {
            let result = unsafe { DeleteAppContainerProfile(self.name.as_ptr()) };
            if result < 0 {
                return Err(format!(
                    "Delete invocation AppContainer profile: HRESULT {result:#x}"
                ));
            }
            self.active = false;
        }
        Ok(())
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            eprintln!("{error}");
        }
        unsafe {
            FreeSid(self.sid);
        }
    }
}

fn capability(name: &str) -> Result<Local, String> {
    let (mut groups, mut sids) = (null_mut(), null_mut());
    let (mut group_count, mut count) = (0, 0);
    if unsafe {
        DeriveCapabilitySidsFromName(
            wide(name).as_ptr(),
            &mut groups,
            &mut group_count,
            &mut sids,
            &mut count,
        )
    } == 0
    {
        return Err(error(&format!("Derive Windows capability {name}")));
    }
    let _groups = Local(groups.cast());
    let _sids = Local(sids.cast());
    for i in 0..group_count {
        drop(Local(unsafe { *groups.add(i as usize) }));
    }
    let mut capabilities = (0..count)
        .map(|i| Local(unsafe { *sids.add(i as usize) }))
        .collect::<Vec<_>>();
    if capabilities.len() != 1 {
        return Err(format!("Expected one SID for Windows capability {name}"));
    }
    Ok(capabilities.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invocation_profile_is_deleted_after_native_launch() {
        let mut profile = Profile::create(false).unwrap();
        let name = String::from_utf16(&profile.name[..profile.name.len() - 1]).unwrap();
        let directory = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap())
            .join("Packages")
            .join(name);
        assert!(directory.is_dir());
        super::super::runner::probe(&profile).unwrap();
        profile.cleanup().unwrap();
        assert!(
            !directory.exists(),
            "Invocation profile remained after cleanup"
        );
    }
}
