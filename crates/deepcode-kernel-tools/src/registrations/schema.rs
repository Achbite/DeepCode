use crate::invocation_types::KernelToolKind;
use serde_json::Value;

pub(super) fn provider_schema_for_tool(tool: KernelToolKind) -> Value {
    match tool {
        KernelToolKind::FsRead => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Workspace-relative UTF-8 text file path."
                },
                "startLine": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": u32::MAX,
                    "description": "First one-based line to return. Defaults to 1."
                },
                "maxLines": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 5000,
                    "description": "Maximum number of lines to return. Defaults to 2000."
                },
                "maxBytes": {
                    "type": "integer",
                    "minimum": 1024,
                    "maximum": 1048576,
                    "description": "Maximum UTF-8 output bytes. Defaults to 262144."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsWrite => serde_json::json!({
            "type": "object",
            "required": ["path", "content"],
            "properties": {
                "path": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Workspace-relative file path. Missing parent directories are created automatically."
                },
                "content": { "type": "string" },
                "executable": {
                    "type": "boolean",
                    "description": "Optional executable state. New files default to false; existing files preserve their mode when omitted."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsEdit => serde_json::json!({
            "type": "object",
            "required": ["path", "edits"],
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "edits": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 128,
                    "description": "Exact non-overlapping replacements applied atomically in array order.",
                    "items": {
                        "type": "object",
                        "required": ["oldText", "newText"],
                        "properties": {
                            "oldText": { "type": "string", "minLength": 1 },
                            "newText": { "type": "string" }
                        },
                        "additionalProperties": false
                    }
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsDelete => serde_json::json!({
            "type": "object",
            "required": ["path", "targetKind"],
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "targetKind": {
                    "type": "string",
                    "enum": ["file", "directoryTree"],
                    "description": "Required exact deletion target kind."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::ProcessShell => serde_json::json!({
            "type": "object",
            "required": ["command", "workspaceMode"],
            "properties": {
                "command": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 16384,
                    "description": "One bounded non-interactive Bash command. stdin is closed. Use cd within the command when a workspace subdirectory is required."
                },
                "workspaceMode": {
                    "type": "string",
                    "enum": ["read", "write"],
                    "description": "Required workspace access declaration. read denies workspace writes; write requires mutation authority."
                },
                "timeout": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 600,
                    "description": "Optional wall-clock timeout in seconds. Defaults to 120."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::WebSearch => serde_json::json!({
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": { "type": "string", "minLength": 1 },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 10,
                    "description": "Maximum result count. Defaults to 5."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::WebFetch => serde_json::json!({
            "type": "object",
            "required": ["url"],
            "properties": {
                "url": {
                    "type": "string",
                    "minLength": 1,
                    "description": "HTTP or HTTPS URL without user-info."
                },
                "maxBytes": {
                    "type": "integer",
                    "minimum": 1024,
                    "maximum": 262144,
                    "description": "Maximum response body bytes. Defaults to 98304."
                }
            },
            "additionalProperties": false
        }),
    }
}
