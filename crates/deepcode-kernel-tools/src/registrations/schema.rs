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
                "startByte": { "type": "integer", "minimum": 0, "maximum": 9007199254740991u64, "description": "Resume at nextByte from the previous read, including within long lines. Takes precedence over startLine." },
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
                    "description": "Non-overlapping replacements matched against the original file and applied atomically.",
                    "items": {
                        "type": "object",
                        "required": ["oldText", "newText"],
                        "properties": {
                            "oldText": { "type": "string", "minLength": 1, "description": "Copy a small, exact, unique region from the original file. Preserve whitespace. Include only enough context to distinguish this occurrence; do not copy large unchanged regions." },
                            "newText": { "type": "string", "description": "Replacement for this region; use an empty string to delete it." }
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
            "required": ["command"],
            "properties": {
                "command": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 16384,
                    "description": "Bash script, including newlines. Use cd for a subdirectory. Preserve quoting and use a quoted heredoc for literal multiline input. Use set -e and set -o pipefail when each step must succeed."
                },
                "workspaceMode": {
                    "type": "string",
                    "enum": ["read", "write"],
                    "default": "read",
                    "description": "Defaults to read. In workspace scope, read denies workspace writes; write requires Plan mutation authority. Host scope has its separate external-effect authority."
                },
                "executionScope": {
                    "type": "string",
                    "enum": ["workspace", "host"],
                    "default": "workspace",
                    "description": "Defaults to workspace, which requires a registered platform workspace sandbox and fails explicitly when unavailable. Explicit host uses the host user environment and requires external-effect authority."
                },
                "timeout": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 600,
                    "description": "Optional wall-clock timeout in seconds. Defaults to 120."
                },
                "terminal": {
                    "type": "object",
                    "required": ["stdin"],
                    "properties": {
                        "stdin": {
                            "type": "string",
                            "maxLength": 65536,
                            "description": "Exact bounded input written once to a temporary PTY. Include commands that terminate the interactive program and shell."
                        }
                    },
                    "additionalProperties": false,
                    "description": "Optional one-call PTY. When omitted, stdin is closed. No persistent terminal session is created."
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
