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
        KernelToolKind::FsList => serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "depth": { "type": "integer", "minimum": 1, "maximum": 16 },
                "includeHidden": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsGlob => serde_json::json!({
            "type": "object",
            "required": ["pattern"],
            "properties": {
                "pattern": { "type": "string", "minLength": 1 },
                "path": { "type": "string", "minLength": 1 },
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
                    "required": ["path", "targetKind", "recursive"],
                    "properties": {
                        "path": { "type": "string", "minLength": 1 },
                        "targetKind": { "const": "directory" },
                        "recursive": { "const": true }
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
                "path": { "type": "string", "minLength": 1 },
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
                                        "text": { "type": "string", "minLength": 1 }
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
                                        "target": { "type": "string", "minLength": 1 },
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
                                                                "digest": { "type": "string", "minLength": 1 }
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
                "replacement": { "type": "string" }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsRename => serde_json::json!({
            "type": "object",
            "required": ["path", "destinationPath"],
            "properties": {
                "path": { "type": "string" },
                "destinationPath": { "type": "string" }
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
        KernelToolKind::GitStatus => {
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false })
        }
        KernelToolKind::GitDiff => serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "staged": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        KernelToolKind::GitStage | KernelToolKind::GitUnstage => serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "paths": { "type": "array", "items": { "type": "string" } }
            },
            "additionalProperties": false
        }),
        KernelToolKind::GitCommit => serde_json::json!({
            "type": "object",
            "required": ["message"],
            "properties": {
                "message": { "type": "string" }
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
