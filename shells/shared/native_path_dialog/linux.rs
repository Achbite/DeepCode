use super::PathOptions;
use gtk::prelude::*;
use gtk::{FileChooserAction, FileChooserDialog, FileFilter, ResponseType};
use std::path::PathBuf;

pub(super) fn pick(
    parent: &tauri::Window,
    options: &PathOptions,
) -> Result<Option<PathBuf>, String> {
    let parent = parent.gtk_window().map_err(|error| error.to_string())?;
    // A custom response accepts the highlighted item, including a directory.
    // GTK's built-in Accept response instead navigates into a selected folder.
    let select = ResponseType::Other(1);
    let dialog =
        FileChooserDialog::new(Some(&options.title), Some(&parent), FileChooserAction::Open);
    dialog.add_buttons(&[
        (&options.cancel_label, ResponseType::Cancel),
        (&options.select_label, select),
    ]);
    dialog.set_modal(true);
    dialog.set_select_multiple(false);
    dialog.set_local_only(true);
    dialog.set_default_response(select);
    dialog.set_response_sensitive(select, false);
    dialog.connect_selection_changed(move |dialog| {
        dialog.set_response_sensitive(select, dialog.filename().is_some());
    });
    if let Some(path) = &options.default_path {
        dialog.set_current_folder(path);
    }
    for filter in &options.filters {
        let native_filter = FileFilter::new();
        native_filter.set_name(Some(&filter.name));
        for extension in &filter.extensions {
            native_filter.add_pattern(&format!("*.{extension}"));
        }
        dialog.add_filter(native_filter);
    }
    let response = dialog.run();
    let result = if response == select {
        dialog
            .filename()
            .map(Some)
            .ok_or_else(|| "native_dialog_selected_path_missing".into())
    } else {
        Ok(None)
    };
    unsafe { dialog.destroy() };
    result
}
