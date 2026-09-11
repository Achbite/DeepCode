use serde_json::{json, Value};

/// Host observations only. Session owns the lifetime of the saved snapshot.
pub(crate) fn capture(settings: &Value) -> Result<Value, String> {
    let locale = system_locale();
    let preference = response_language_setting(settings)?;
    Ok(json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "locale": locale,
        "responseLanguage": if preference == "auto" { locale.as_deref() } else { Some(preference) },
        "userShell": std::env::var(if cfg!(windows) { "COMSPEC" } else { "SHELL" }).ok(),
    }))
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
}
