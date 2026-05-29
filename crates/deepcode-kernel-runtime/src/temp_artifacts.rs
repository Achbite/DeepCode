use super::*;

pub(crate) fn is_kernel_owned_temp_cleanup(tool_name: &str, arguments: &Value) -> bool {
    tool_name == "fs.delete"
        && arguments
            .get("path")
            .and_then(Value::as_str)
            .map(is_temp_file_path)
            .unwrap_or(false)
}

pub(crate) fn is_temp_file_path(value: &str) -> bool {
    value.contains("_agent_tmp_")
}
