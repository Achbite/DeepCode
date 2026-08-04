use crate::invocation_types::KernelToolKind;
use serde_json::Value;

pub(super) fn provider_schema_for_tool(operation_kind: KernelToolKind) -> Value {
    match operation_kind {
        KernelToolKind::FsRead => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" },
                "startLine": { "type": "integer", "minimum": 1 },
                "endLine": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsList => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" },
                "depth": { "type": "integer", "minimum": 1 },
                "includeHidden": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsGlob => serde_json::json!({
            "type": "object",
            "required": ["pattern"],
            "properties": {
                "pattern": { "type": "string" },
                "path": { "type": "string" },
                "maxResults": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsDiff => serde_json::json!({
            "type": "object",
            "required": ["path", "contentBlockId"],
            "properties": {
                "path": { "type": "string" },
                "contentBlockId": { "type": "string" }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsDelete => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" },
                "targetKind": { "type": "string", "enum": ["file", "directory"] },
                "recursive": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        KernelToolKind::CodeGrep => serde_json::json!({
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": { "type": "string" },
                "include": { "type": "array", "items": { "type": "string" } },
                "exclude": { "type": "array", "items": { "type": "string" } },
                "path": { "type": "string" },
                "strategy": { "type": "string", "enum": ["literal", "regex"] },
                "contextLines": { "type": "integer", "minimum": 0 },
                "maxResults": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsCreate => serde_json::json!({
            "type": "object",
            "required": ["path", "contentBlockId"],
            "properties": {
                "path": { "type": "string" },
                "contentBlockId": { "type": "string" },
                "temporary": { "type": "boolean" },
                "executable": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsWrite => serde_json::json!({
            "type": "object",
            "required": ["path", "contentBlockId"],
            "properties": {
                "path": { "type": "string" },
                "contentBlockId": { "type": "string" },
                "temporary": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsEnsureDirectory => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsEdit => serde_json::json!({
            "type": "object",
            "required": ["path", "matcher", "replacement"],
            "properties": {
                "path": { "type": "string" },
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
                                        "text": { "type": "string" }
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
                                        "target": { "type": "string" },
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
                                        "startLine": { "type": "integer", "minimum": 1 },
                                        "endLine": { "type": "integer", "minimum": 1 },
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
                                                                "digest": { "type": "string" }
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
                                                                "text": { "type": "string" }
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
            "required": ["path"],
            "properties": {
                "path": { "type": "string" },
                "startPage": { "type": "integer", "minimum": 1 },
                "endPage": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
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
                "query": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        KernelToolKind::WebFetch => serde_json::json!({
            "type": "object",
            "required": ["url"],
            "properties": {
                "url": { "type": "string" },
                "maxBytes": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
    }
}
