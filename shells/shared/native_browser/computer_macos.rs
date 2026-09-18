//! Physical macOS I/O only. Kernel must authorize every invocation before this driver runs.
use objc2::{class, msg_send, runtime::AnyObject};
use objc2_foundation::NSString;
use serde_json::{json, Value};
use std::{
    ffi::{c_char, c_void},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

type Ref = *const c_void;
#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Size {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Rect {
    origin: Point,
    size: Size,
}
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> Ref;
    fn AXUIElementCopyAttributeValue(element: Ref, name: Ref, result: *mut Ref) -> i32;
    fn AXUIElementSetMessagingTimeout(element: Ref, timeout: f32) -> i32;
    fn AXValueGetValue(value: Ref, kind: u32, result: *mut c_void) -> bool;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> Rect;
    fn CGEventCreateMouseEvent(source: Ref, kind: u32, position: Point, button: u32) -> Ref;
    fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: bool) -> Ref;
    fn CGEventKeyboardSetUnicodeString(event: Ref, length: usize, text: *const u16);
    fn CGEventSetFlags(event: Ref, flags: u64);
    fn CGEventCreateScrollWheelEvent(source: Ref, units: u32, count: u32, ...) -> Ref;
    fn CGEventPost(tap: u32, event: Ref);
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: Ref);
    fn CFGetTypeID(value: Ref) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFStringGetCString(value: Ref, buffer: *mut c_char, size: isize, encoding: u32) -> bool;
    fn CFArrayGetCount(value: Ref) -> isize;
    fn CFArrayGetValueAtIndex(value: Ref, index: isize) -> Ref;
}
struct Owned(Ref);
impl Owned {
    fn new(value: Ref) -> Result<Self, String> {
        if value.is_null() {
            Err("macOS returned an empty native object".into())
        } else {
            Ok(Self(value))
        }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}
struct Observation {
    id: String,
    app: String,
    pid: i32,
    at: Instant,
    bounds: Rect,
}
static OBSERVATION: Mutex<Option<Observation>> = Mutex::new(None);

unsafe fn string(value: *mut NSString) -> String {
    if value.is_null() {
        String::new()
    } else {
        (&*value).to_string()
    }
}
unsafe fn applications() -> *mut AnyObject {
    let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
    msg_send![workspace, runningApplications]
}
unsafe fn target(bundle: &str) -> Result<*mut AnyObject, String> {
    let apps = applications();
    let count: usize = msg_send![apps, count];
    for index in 0..count {
        let app: *mut AnyObject = msg_send![apps, objectAtIndex:index];
        let id: *mut NSString = msg_send![app, bundleIdentifier];
        if string(id) == bundle {
            return Ok(app);
        }
    }
    Err(format!(
        "Application is not running: {bundle}. Use listApps to choose a running app."
    ))
}
unsafe fn attribute(element: Ref, key: &str) -> Option<Owned> {
    let name = NSString::from_str(key);
    let mut result = std::ptr::null();
    (AXUIElementCopyAttributeValue(element, (&*name as *const NSString).cast(), &mut result) == 0)
        .then(|| Owned::new(result).ok())
        .flatten()
}
unsafe fn text_attribute(element: Ref, key: &str) -> Option<String> {
    let value = attribute(element, key)?;
    if CFGetTypeID(value.0) != CFStringGetTypeID() {
        return None;
    }
    let mut bytes = vec![0u8; 4096];
    if !CFStringGetCString(
        value.0,
        bytes.as_mut_ptr().cast(),
        bytes.len() as isize,
        0x08000100,
    ) {
        return None;
    }
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    Some(String::from_utf8_lossy(&bytes[..end]).into_owned())
}
unsafe fn tree(element: Ref, depth: usize, items: &mut Vec<Value>, started: Instant) {
    if depth > 12 || items.len() >= 250 || started.elapsed() > Duration::from_secs(4) {
        return;
    }
    let mut item = json!({"depth":depth});
    for (key, name) in [
        ("AXRole", "role"),
        ("AXTitle", "title"),
        ("AXDescription", "description"),
        ("AXValue", "value"),
    ] {
        if let Some(text) = text_attribute(element, key) {
            if !text.is_empty() {
                item[name] = json!(text);
            }
        }
    }
    let mut position = Point { x: 0.0, y: 0.0 };
    let mut size = Size {
        width: 0.0,
        height: 0.0,
    };
    if let (Some(p), Some(s)) = (
        attribute(element, "AXPosition"),
        attribute(element, "AXSize"),
    ) {
        if AXValueGetValue(p.0, 1, (&mut position as *mut Point).cast())
            && AXValueGetValue(s.0, 2, (&mut size as *mut Size).cast())
        {
            item["bounds"] =
                json!({"x":position.x,"y":position.y,"width":size.width,"height":size.height});
        }
    }
    items.push(item);
    if let Some(children) = attribute(element, "AXChildren") {
        for index in 0..CFArrayGetCount(children.0) {
            if items.len() >= 250 || started.elapsed() > Duration::from_secs(4) {
                break;
            }
            tree(
                CFArrayGetValueAtIndex(children.0, index),
                depth + 1,
                items,
                started,
            );
        }
    }
}
fn point(input: &Value, x: &str, y: &str, bounds: Rect) -> Result<Point, String> {
    let value = Point {
        x: input[x].as_f64().ok_or("Missing x coordinate")?,
        y: input[y].as_f64().ok_or("Missing y coordinate")?,
    };
    if !value.x.is_finite()
        || !value.y.is_finite()
        || value.x < bounds.origin.x
        || value.y < bounds.origin.y
        || value.x >= bounds.origin.x + bounds.size.width
        || value.y >= bounds.origin.y + bounds.size.height
    {
        return Err(
            "Coordinates must be inside the observed primary display (logical points).".into(),
        );
    }
    Ok(value)
}
fn key(value: &str) -> Result<(u16, u64), String> {
    let mut parts: Vec<_> = value.split('+').collect();
    let name = parts.pop().ok_or("Missing key")?.to_ascii_lowercase();
    let mut flags = 0;
    for part in parts {
        flags |= match part.to_ascii_lowercase().as_str() {
            "cmd" | "super" => 1 << 20,
            "shift" => 1 << 17,
            "ctrl" | "control" => 1 << 18,
            "alt" | "option" => 1 << 19,
            _ => return Err(format!("Unsupported modifier: {part}")),
        };
    }
    let code = match name.as_str() {
        "return" | "enter" => 36,
        "tab" => 48,
        "space" => 49,
        "escape" | "esc" => 53,
        "backspace" => 51,
        "delete" => 117,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        "home" => 115,
        "end" => 119,
        "pageup" => 116,
        "pagedown" => 121,
        "a" => 0,
        "s" => 1,
        "d" => 2,
        "f" => 3,
        "h" => 4,
        "g" => 5,
        "z" => 6,
        "x" => 7,
        "c" => 8,
        "v" => 9,
        "b" => 11,
        "q" => 12,
        "w" => 13,
        "e" => 14,
        "r" => 15,
        "y" => 16,
        "t" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "9" => 25,
        "7" => 26,
        "8" => 28,
        "0" => 29,
        "o" => 31,
        "u" => 32,
        "i" => 34,
        "p" => 35,
        "l" => 37,
        "j" => 38,
        "k" => 40,
        "n" => 45,
        "m" => 46,
        _ => return Err(format!("Unsupported key: {name}; use type for text")),
    };
    Ok((code, flags))
}

pub fn execute(input: &Value) -> Result<Value, String> {
    // One physical desktop observation at a time, across all bound sessions.
    let mut observation = OBSERVATION
        .lock()
        .map_err(|_| "Computer state unavailable")?;
    objc2::rc::autoreleasepool(|_| unsafe {
        let action = input["action"]
            .as_str()
            .ok_or("Missing action")?
            .trim_start_matches("computer:");
        if action == "listApps" {
            let apps = applications();
            let count: usize = msg_send![apps, count];
            let mut result = vec![];
            for index in 0..count {
                let app: *mut AnyObject = msg_send![apps, objectAtIndex:index];
                let id: *mut NSString = msg_send![app, bundleIdentifier];
                let name: *mut NSString = msg_send![app, localizedName];
                let id = string(id);
                if !id.is_empty() {
                    result.push(json!({"app":id,"name":string(name)}));
                }
            }
            return Ok(json!({"applications":result}));
        }
        if !AXIsProcessTrusted() {
            return Err("macOS 辅助功能权限未授予 DeepCode-GUI。请在系统设置 → 隐私与安全性 → 辅助功能中授权。".into());
        }
        let bundle = input["app"].as_str().ok_or("Missing app")?;
        let app = target(bundle)?;
        let pid: i32 = msg_send![app, processIdentifier];
        if action == "observe" {
            *observation = None;
            if !CGPreflightScreenCaptureAccess() {
                return Err("macOS 屏幕录制权限未授予 DeepCode-GUI。请在系统设置 → 隐私与安全性 → 屏幕录制中授权。".into());
            }
            let activated: bool = msg_send![app, activateWithOptions:2usize];
            if !activated {
                return Err("Could not activate the target application".into());
            }
            let started = Instant::now();
            loop {
                let active: bool = msg_send![app, isActive];
                if active {
                    break;
                }
                if started.elapsed() > Duration::from_secs(2) {
                    return Err("Application did not become frontmost".into());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let root = Owned::new(AXUIElementCreateApplication(pid))?;
            AXUIElementSetMessagingTimeout(root.0, 0.3);
            let mut items = vec![];
            tree(root.0, 0, &mut items, Instant::now());
            let bounds = CGDisplayBounds(CGMainDisplayID());
            let directory = Path::new(
                input["captureDirectory"]
                    .as_str()
                    .ok_or("Missing archive directory")?,
            );
            std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
            let id = format!(
                "computer-{}",
                super::PAGE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            );
            let path = directory.join(format!("{id}.png"));
            let output = std::process::Command::new("/usr/sbin/screencapture")
                .args(["-x", "-D", "1"])
                .arg(&path)
                .output()
                .map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err(format!(
                    "Screen capture failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            *observation = Some(Observation {
                id: id.clone(),
                app: bundle.into(),
                pid,
                at: Instant::now(),
                bounds,
            });
            return Ok(
                json!({"observationId":id,"app":bundle,"elements":items,"elementLimit":250,"contentRef":path,"contentType":"image/png","coordinateSpace":"logical desktop points","display":{"x":bounds.origin.x,"y":bounds.origin.y,"width":bounds.size.width,"height":bounds.size.height}}),
            );
        }
        let saved = observation
            .take()
            .ok_or("Observe the application before acting")?;
        if input["observationId"] != saved.id
            || saved.app != bundle
            || saved.pid != pid
            || saved.at.elapsed() > Duration::from_secs(120)
        {
            return Err("Observation is stale; observe again before acting".into());
        }
        let active: bool = msg_send![app, isActive];
        if !active {
            return Err("Target application is no longer frontmost; observe again".into());
        }
        let null = std::ptr::null();
        let mut events = vec![];
        match action {
            "click" => {
                let p = point(input, "x", "y", saved.bounds)?;
                events.push(Owned::new(CGEventCreateMouseEvent(null, 1, p, 0))?);
                events.push(Owned::new(CGEventCreateMouseEvent(null, 2, p, 0))?);
            }
            "drag" => {
                let from = point(input, "x", "y", saved.bounds)?;
                let to = point(input, "toX", "toY", saved.bounds)?;
                events.push(Owned::new(CGEventCreateMouseEvent(null, 1, from, 0))?);
                for step in 1..=12 {
                    let amount = step as f64 / 12.0;
                    events.push(Owned::new(CGEventCreateMouseEvent(
                        null,
                        6,
                        Point {
                            x: from.x + (to.x - from.x) * amount,
                            y: from.y + (to.y - from.y) * amount,
                        },
                        0,
                    ))?);
                }
                events.push(Owned::new(CGEventCreateMouseEvent(null, 2, to, 0))?);
            }
            "key" => {
                let (code, flags) = key(input["key"].as_str().ok_or("Missing key")?)?;
                for down in [true, false] {
                    let event = Owned::new(CGEventCreateKeyboardEvent(null, code, down))?;
                    CGEventSetFlags(event.0, flags);
                    events.push(event);
                }
            }
            "type" => {
                let text = input["text"].as_str().ok_or("Missing text")?;
                if text.len() > 8192 {
                    return Err("Text exceeds 8192 bytes".into());
                }
                let text: Vec<_> = text.encode_utf16().collect();
                for down in [true, false] {
                    let event = Owned::new(CGEventCreateKeyboardEvent(null, 0, down))?;
                    CGEventKeyboardSetUnicodeString(event.0, text.len(), text.as_ptr());
                    events.push(event);
                }
            }
            "scroll" => {
                let dx = i32::try_from(input["deltaX"].as_i64().ok_or("Missing deltaX")?)
                    .map_err(|_| "deltaX too large")?;
                let dy = i32::try_from(input["deltaY"].as_i64().ok_or("Missing deltaY")?)
                    .map_err(|_| "deltaY too large")?;
                events.push(Owned::new(CGEventCreateScrollWheelEvent(
                    null, 0, 2, dy, dx,
                ))?);
            }
            _ => return Err("Unsupported computer action".into()),
        }
        for event in events {
            CGEventPost(0, event.0);
        }
        Ok(
            json!({"app":bundle,"action":action,"dispatched":true,"next":"Observe again to verify the actual result."}),
        )
    })
}
