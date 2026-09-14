use super::os::*;
use std::ptr::{null, null_mut};
use windows_sys::Win32::{
    Foundation::GENERIC_ALL, Security::SECURITY_ATTRIBUTES, System::StationsAndDesktops::*,
    System::Threading::GetCurrentThreadId,
};

const CWF_CREATE_ONLY: u32 = 0x00000001;

/// Win32/.NET startup needs writable desktop objects. Keep them private to this
/// worker logon and invocation instead of granting access to the user's desktop.
pub(super) struct PrivateDesktop {
    station: HWINSTA,
    desktop: HDESK,
    previous_station: HWINSTA,
    previous_desktop: HDESK,
    pub path: Vec<u16>,
}

impl PrivateDesktop {
    pub fn new(write_sid: &str) -> Result<Self, String> {
        let mut guard = Self {
            station: null_mut(),
            desktop: null_mut(),
            previous_station: unsafe { GetProcessWindowStation() },
            previous_desktop: unsafe { GetThreadDesktop(GetCurrentThreadId()) },
            path: Vec::new(),
        };
        if guard.previous_station.is_null() || guard.previous_desktop.is_null() {
            return Err(error("Read worker desktop"));
        }
        let security = descriptor(&format!(
            "D:(A;;GA;;;{})(A;;GA;;;{write_sid})(A;;GA;;;SY)",
            current_user_sid()?
        ))?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: security.0,
            bInheritHandle: 0,
        };
        // Windows assigns a name from this worker's fresh logon identifier;
        // naming a window station explicitly would require administrator rights.
        guard.station =
            unsafe { CreateWindowStationW(null(), CWF_CREATE_ONLY, GENERIC_ALL, &attributes) };
        if guard.station.is_null() {
            return Err(error("Create workspace window station"));
        }
        if unsafe { SetProcessWindowStation(guard.station) } == 0 {
            return Err(error("Select workspace window station"));
        }
        guard.desktop = unsafe {
            CreateDesktopW(
                wide("shell").as_ptr(),
                null(),
                null(),
                0,
                GENERIC_ALL,
                &attributes,
            )
        };
        if guard.desktop.is_null() {
            return Err(error("Create workspace desktop"));
        }
        if unsafe { SetThreadDesktop(guard.desktop) } == 0 {
            return Err(error("Select workspace desktop"));
        }
        let mut size = 0;
        unsafe { GetUserObjectInformationW(guard.station, UOI_NAME, null_mut(), 0, &mut size) };
        let mut name = vec![0u16; (size as usize).div_ceil(2)];
        if unsafe {
            GetUserObjectInformationW(
                guard.station,
                UOI_NAME,
                name.as_mut_ptr().cast(),
                size,
                &mut size,
            )
        } == 0
        {
            return Err(error("Read workspace window station name"));
        }
        let name = String::from_utf16_lossy(
            &name[..name.iter().position(|c| *c == 0).unwrap_or(name.len())],
        );
        guard.path = wide(format!("{name}\\shell"));
        Ok(guard)
    }
}

impl Drop for PrivateDesktop {
    fn drop(&mut self) {
        unsafe {
            if !self.desktop.is_null() {
                SetThreadDesktop(self.previous_desktop);
                CloseDesktop(self.desktop);
            }
            if !self.station.is_null() {
                SetProcessWindowStation(self.previous_station);
                CloseWindowStation(self.station);
            }
        }
    }
}
