use crate::ToolOperationKind;
use serde_json::Value;

pub(super) fn provider_schema_for_operation(operation_kind: ToolOperationKind) -> Value {
    match operation_kind {
        ToolOperationKind::FsRead => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" },
                "startLine": { "type": "integer", "minimum": 1 },
                "endLine": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::FsList => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" },
                "depth": { "type": "integer", "minimum": 1 },
                "includeHidden": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::FsGlob => serde_json::json!({
            "type": "object",
            "required": ["pattern"],
            "properties": {
                "pattern": { "type": "string" },
                "path": { "type": "string" },
                "maxResults": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::FsDiff => serde_json::json!({
            "type": "object",
            "required": ["path", "contentBlockId"],
            "properties": {
                "path": { "type": "string" },
                "contentBlockId": { "type": "string" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::FsDelete => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" },
                "targetKind": { "type": "string", "enum": ["file", "directory"] },
                "recursive": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::CodeGrep => serde_json::json!({
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
        ToolOperationKind::FsCreate => serde_json::json!({
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
        ToolOperationKind::FsWrite => serde_json::json!({
            "type": "object",
            "required": ["path", "contentBlockId"],
            "properties": {
                "path": { "type": "string" },
                "contentBlockId": { "type": "string" },
                "temporary": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::FsEnsureDirectory => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::FsEdit => serde_json::json!({
            "type": "object",
            "required": ["path", "patchSpec", "replacementBlockId"],
            "properties": {
                "path": { "type": "string" },
                "patchSpec": { "type": "object" },
                "replacementBlockId": { "type": "string" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::FsRename => serde_json::json!({
            "type": "object",
            "required": ["path", "destinationPath"],
            "properties": {
                "path": { "type": "string" },
                "destinationPath": { "type": "string" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::DocumentRead => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string" },
                "startPage": { "type": "integer", "minimum": 1 },
                "endPage": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::GitStatus => {
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false })
        }
        ToolOperationKind::GitDiff => serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "staged": { "type": "boolean" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::GitStage | ToolOperationKind::GitUnstage => serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "paths": { "type": "array", "items": { "type": "string" } }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::GitCommit => serde_json::json!({
            "type": "object",
            "required": ["message"],
            "properties": {
                "message": { "type": "string" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::GitPush => serde_json::json!({
            "type": "object",
            "properties": {
                "remote": { "type": "string" },
                "branch": { "type": "string" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::ProcessExec => serde_json::json!({
            "type": "object",
            "required": ["argv"],
            "properties": {
                "argv": { "type": "array", "items": { "type": "string" } },
                "cwd": { "type": "string" },
                "timeoutMs": { "type": "integer", "minimum": 1 },
                "envPolicy": { "type": "string" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::WebSearch => serde_json::json!({
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::WebFetch => serde_json::json!({
            "type": "object",
            "required": ["url"],
            "properties": {
                "url": { "type": "string" },
                "maxBytes": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::BrowserOpen => serde_json::json!({
            "type": "object",
            "required": ["url"],
            "properties": {
                "url": { "type": "string" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::BrowserClick => serde_json::json!({
            "type": "object",
            "required": ["selector"],
            "properties": {
                "selector": { "type": "string" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::BrowserSnapshot => serde_json::json!({
            "type": "object",
            "properties": {
                "selector": { "type": "string" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::BrowserInspect => serde_json::json!({
            "type": "object",
            "properties": {
                "inspectState": { "type": "string" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::BrowserType => serde_json::json!({
            "type": "object",
            "required": ["selector", "text"],
            "properties": {
                "selector": { "type": "string" },
                "text": { "type": "string" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::BrowserScroll => serde_json::json!({
            "type": "object",
            "properties": {
                "deltaY": { "type": "integer" }
            },
            "additionalProperties": false
        }),
        ToolOperationKind::BrowserReload => serde_json::json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
        ToolOperationKind::ProviderCall => serde_json::json!({
            "type": "object",
            "properties": {
                "profileRef": { "type": "string" },
                "budgetRef": { "type": "string" }
            },
            "additionalProperties": false
        }),
    }
}
