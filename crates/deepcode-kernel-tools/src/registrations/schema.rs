use crate::invocation_types::KernelToolKind;
use serde_json::Value;

pub(super) fn provider_schema_for_tool(operation_kind: KernelToolKind) -> Value {
    match operation_kind {
        KernelToolKind::FsRead => serde_json::json!({
            "type": "object",
            "oneOf": [
                {
                    "type": "object",
                    "required": ["path"],
                    "properties": {
                        "path": { "type": "string", "minLength": 1 }
                    },
                    "additionalProperties": false
                },
                {
                    "type": "object",
                    "required": ["path", "startLine", "endLine"],
                    "properties": {
                        "path": { "type": "string", "minLength": 1 },
                        "startLine": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": u32::MAX
                        },
                        "endLine": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": u32::MAX
                        }
                    },
                    "additionalProperties": false
                }
            ]
        }),
        KernelToolKind::FsStat => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Normalized workspace-relative path. Use '.' for the workspace root."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsList => serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Optional normalized workspace-relative directory. Omit it for the workspace root; if explicitly provided for the root, use '.' and never an empty string."
                },
                "depth": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 16,
                    "description": "Maximum directory depth to enumerate. Defaults to 2."
                },
                "includeHidden": {
                    "type": "boolean",
                    "description": "Whether names beginning with '.' are included. Defaults to false."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsGlob => serde_json::json!({
            "type": "object",
            "required": ["pattern"],
            "properties": {
                "pattern": { "type": "string", "minLength": 1 },
                "path": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Optional normalized workspace-relative directory. Omit it for the workspace root; if explicitly provided for the root, use '.' and never an empty string."
                },
                "maxResults": { "type": "integer", "minimum": 1, "maximum": 5000 }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsDiff => serde_json::json!({
            "type": "object",
            "required": ["path", "proposedContent"],
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "proposedContent": { "type": "string" }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsDelete => serde_json::json!({
            "type": "object",
            "oneOf": [
                {
                    "type": "object",
                    "required": ["path", "targetKind"],
                    "properties": {
                        "path": { "type": "string", "minLength": 1 },
                        "targetKind": { "const": "file" }
                    },
                    "additionalProperties": false
                },
                {
                    "type": "object",
                    "required": ["path", "targetKind"],
                    "properties": {
                        "path": { "type": "string", "minLength": 1 },
                        "targetKind": { "const": "directoryTree" }
                    },
                    "additionalProperties": false
                }
            ]
        }),
        KernelToolKind::CodeGrep => serde_json::json!({
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": { "type": "string", "minLength": 1 },
                "include": {
                    "type": "array",
                    "maxItems": 256,
                    "items": { "type": "string", "minLength": 1 }
                },
                "exclude": {
                    "type": "array",
                    "maxItems": 256,
                    "items": { "type": "string", "minLength": 1 }
                },
                "path": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Optional normalized workspace-relative directory. Omit it for the workspace root; if explicitly provided for the root, use '.' and never an empty string."
                },
                "strategy": { "type": "string", "enum": ["literal", "regex"] },
                "contextLines": { "type": "integer", "minimum": 0, "maximum": 5 },
                "maxResults": { "type": "integer", "minimum": 1, "maximum": 500 }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsCreate => serde_json::json!({
            "type": "object",
            "required": ["path", "content"],
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "content": { "type": "string" },
                "executable": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsWrite => serde_json::json!({
            "type": "object",
            "required": ["path", "content"],
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "content": { "type": "string" }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsEnsureDirectory => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string", "minLength": 1 }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsEdit => serde_json::json!({
            "type": "object",
            "required": ["path", "matcher", "replacement"],
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "matcher": {
                    "oneOf": [
                        {
                            "type": "object",
                            "required": ["kind", "data"],
                            "properties": {
                                "kind": { "const": "exactBlock" },
                                "data": {
                                    "type": "object",
                                    "required": ["text"],
                                    "properties": {
                                        "text": {
                                            "type": "string",
                                            "minLength": 1,
                                            "description": "Exact existing file content to match. JSON line breaks are escaped once as \\n; the two literal characters backslash+n only match those characters in the file."
                                        }
                                    },
                                    "additionalProperties": false
                                }
                            },
                            "additionalProperties": false
                        },
                        {
                            "type": "object",
                            "required": ["kind", "data"],
                            "properties": {
                                "kind": { "const": "contextBlock" },
                                "data": {
                                    "type": "object",
                                    "required": ["before", "target", "after"],
                                    "properties": {
                                        "before": { "type": "string" },
                                        "target": {
                                            "type": "string",
                                            "minLength": 1,
                                            "description": "Exact existing file content to replace. JSON line breaks are escaped once as \\n; the two literal characters backslash+n only match those characters in the file."
                                        },
                                        "after": { "type": "string" }
                                    },
                                    "additionalProperties": false
                                }
                            },
                            "additionalProperties": false
                        },
                        {
                            "type": "object",
                            "required": ["kind", "data"],
                            "properties": {
                                "kind": { "const": "lineRange" },
                                "data": {
                                    "type": "object",
                                    "required": ["startLine", "endLine", "precondition"],
                                    "properties": {
                                        "startLine": {
                                            "type": "integer",
                                            "minimum": 1,
                                            "maximum": u32::MAX
                                        },
                                        "endLine": {
                                            "type": "integer",
                                            "minimum": 1,
                                            "maximum": u32::MAX
                                        },
                                        "precondition": {
                                            "oneOf": [
                                                {
                                                    "type": "object",
                                                    "required": ["kind", "data"],
                                                    "properties": {
                                                        "kind": { "const": "expectedFileDigest" },
                                                        "data": {
                                                            "type": "object",
                                                            "required": ["digest"],
                                                            "properties": {
                                                                "digest": {
                                                                    "type": "string",
                                                                    "minLength": 71,
                                                                    "maxLength": 71,
                                                                    "pattern": "^sha256:[0-9a-f]{64}$",
                                                                    "description": "Exact full digest returned by fs.read, including the sha256: prefix."
                                                                }
                                                            },
                                                            "additionalProperties": false
                                                        }
                                                    },
                                                    "additionalProperties": false
                                                },
                                                {
                                                    "type": "object",
                                                    "required": ["kind", "data"],
                                                    "properties": {
                                                        "kind": { "const": "expectedBeforeBlock" },
                                                        "data": {
                                                            "type": "object",
                                                            "required": ["text"],
                                                            "properties": {
                                                                "text": { "type": "string", "minLength": 1 }
                                                            },
                                                            "additionalProperties": false
                                                        }
                                                    },
                                                    "additionalProperties": false
                                                }
                                            ]
                                        }
                                    },
                                    "additionalProperties": false
                                }
                            },
                            "additionalProperties": false
                        }
                    ]
                },
                "replacement": {
                    "type": "string",
                    "description": "Exact literal content to write. Encode real line breaks once as \\n in JSON; use \\\\n only when the file should contain the two characters backslash+n."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::DocumentRead => serde_json::json!({
            "type": "object",
            "oneOf": [
                {
                    "type": "object",
                    "required": ["path"],
                    "properties": {
                        "path": { "type": "string", "minLength": 1 }
                    },
                    "additionalProperties": false
                },
                {
                    "type": "object",
                    "required": ["path", "startPage", "endPage"],
                    "properties": {
                        "path": { "type": "string", "minLength": 1 },
                        "startPage": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": u32::MAX
                        },
                        "endPage": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": u32::MAX
                        }
                    },
                    "additionalProperties": false
                }
            ]
        }),
        KernelToolKind::ProcessShell => serde_json::json!({
            "type": "object",
            "required": ["command"],
            "properties": {
                "command": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 16384,
                    "description": "One bounded non-interactive /bin/sh command. stdin is closed, and success is the final shell exit status."
                },
                "cwd": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Normalized workspace-relative existing directory. Defaults to '.'."
                },
                "timeoutMs": {
                    "type": "integer",
                    "minimum": 100,
                    "maximum": 600000,
                    "description": "Wall-clock execution timeout. Defaults to 120000."
                },
                "maxOutputBytes": {
                    "type": "integer",
                    "minimum": 1024,
                    "maximum": 1048576,
                    "description": "Combined stdout/stderr capture limit. Defaults to 262144."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::GithubSearch => serde_json::json!({
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": { "type": "string", "minLength": 1 },
                "kind": {
                    "type": "string",
                    "enum": ["repositories", "code", "issues"],
                    "description": "GitHub Search API object kind. Defaults to repositories. Code search requires DEEPCODE_GITHUB_TOKEN when the daemon starts."
                },
                "page": { "type": "integer", "minimum": 1, "maximum": 100 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 30 }
            },
            "additionalProperties": false
        }),
        KernelToolKind::GithubRead => serde_json::json!({
            "type": "object",
            "required": ["repository"],
            "properties": {
                "repository": {
                    "type": "string",
                    "minLength": 3,
                    "description": "Repository identity in owner/name form."
                },
                "path": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Repository-relative content path. Defaults to '.'."
                },
                "ref": { "type": "string", "minLength": 1 },
                "maxBytes": { "type": "integer", "minimum": 1024, "maximum": 262144 }
            },
            "additionalProperties": false
        }),
        KernelToolKind::ArxivSearch => serde_json::json!({
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": { "type": "string", "minLength": 1 },
                "field": {
                    "type": "string",
                    "enum": ["all", "title", "author", "abstract", "category", "id"]
                },
                "start": { "type": "integer", "minimum": 0, "maximum": 10000 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 30 },
                "sortBy": {
                    "type": "string",
                    "enum": ["relevance", "lastUpdatedDate", "submittedDate"]
                },
                "sortOrder": {
                    "type": "string",
                    "enum": ["ascending", "descending"]
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::ArxivRead => serde_json::json!({
            "type": "object",
            "required": ["id"],
            "properties": {
                "id": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Canonical arXiv identifier, optionally including a version."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::WebSearch => serde_json::json!({
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": { "type": "string", "minLength": 1 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 10 }
            },
            "additionalProperties": false
        }),
        KernelToolKind::WebFetch => serde_json::json!({
            "type": "object",
            "required": ["url"],
            "properties": {
                "url": { "type": "string", "minLength": 1 },
                "maxBytes": { "type": "integer", "minimum": 1024, "maximum": 262144 }
            },
            "additionalProperties": false
        }),
    }
}
