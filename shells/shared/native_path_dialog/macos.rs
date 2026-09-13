use super::PathOptions;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSModalResponseCancel, NSModalResponseOK, NSOpenPanel};
use objc2_foundation::{NSArray, NSString, NSURL};
use std::path::PathBuf;

pub(super) fn pick(
    parent: &tauri::Window,
    options: &PathOptions,
) -> Result<Option<PathBuf>, String> {
    let main = MainThreadMarker::new().ok_or("native_dialog_requires_main_thread")?;
    parent.set_focus().map_err(|error| error.to_string())?;
    // NSOpenPanel natively supports files and directories in the same view.
    let panel = NSOpenPanel::openPanel(main);
    panel.setTitle(Some(&NSString::from_str(&options.title)));
    panel.setPrompt(Some(&NSString::from_str(&options.select_label)));
    panel.setCanChooseFiles(true);
    panel.setCanChooseDirectories(true);
    panel.setAllowsMultipleSelection(false);
    panel.setCanCreateDirectories(false);
    if let Some(path) = &options.default_path {
        panel.setDirectoryURL(Some(&NSURL::fileURLWithPath(&NSString::from_str(path))));
    }
    if !options.filters.is_empty() {
        let extensions: Vec<_> = options
            .filters
            .iter()
            .flat_map(|filter| &filter.extensions)
            .map(|extension| NSString::from_str(extension))
            .collect();
        #[allow(deprecated)]
        panel.setAllowedFileTypes(Some(&NSArray::from_retained_slice(&extensions)));
    }
    match panel.runModal() {
        response if response == NSModalResponseCancel => Ok(None),
        response if response == NSModalResponseOK => panel
            .URL()
            .and_then(|url| url.path())
            .map(|path| Some(PathBuf::from(path.to_string())))
            .ok_or_else(|| "native_dialog_selected_path_missing".into()),
        response => Err(format!("native_dialog_unexpected_response:{response}")),
    }
}
