use crate::{ContentBlock, KernelToolRegistry};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const ACTION_FIELDS: &[&str] = &["actionId", "toolId", "args", "description", "dependsOn"];
const CONTENT_BLOCK_FIELDS: &[&str] = &[
    "blockId",
    "targetPath",
    "language",
    "operation",
    "contentLines",
    "allowEmptyContent",
];
const CONTENT_BLOCK_OPERATIONS: &[&str] = &[
    "create",
    "createEmpty",
    "overwrite",
    "patch",
    "replaceBlock",
    "insertBefore",
    "insertAfter",
];

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum ToolInputValidationError {
    #[error("{path} must be an object")]
    ExpectedObject { path: String },
    #[error("{path} must be an array")]
    ExpectedArray { path: String },
    #[error("{path}.{field} is required")]
    MissingField { path: String, field: String },
    #[error("{path}.{field} is not part of the canonical contract")]
    UnknownField { path: String, field: String },
    #[error("{path} must be a non-empty string")]
    ExpectedString { path: String },
    #[error("{path} must be a boolean")]
    ExpectedBoolean { path: String },
    #[error("{path} must be a number")]
    ExpectedNumber { path: String },
    #[error("{path} must be an integer")]
    ExpectedInteger { path: String },
    #[error("{path} must be at least {minimum}")]
    BelowMinimum { path: String, minimum: String },
    #[error("{path} has a value outside the ToolContract enum")]
    InvalidEnumValue { path: String },
    #[error("contentBlocks contains duplicate blockId {block_id}")]
    DuplicateContentBlock { block_id: String },
    #[error("contentBlocks[{index}].operation is unsupported: {operation}")]
    UnsupportedContentOperation { index: usize, operation: String },
    #[error(
        "contentBlocks[{index}].contentLines may be empty only when operation=createEmpty and allowEmptyContent=true"
    )]
    EmptyContentBlock { index: usize },
}

pub(crate) fn validate_action(
    registry: &KernelToolRegistry,
    action: &Value,
    index: usize,
) -> Result<(), ToolInputValidationError> {
    let path = format!("actionBundle.actions[{index}]");
    let record = action
        .as_object()
        .ok_or_else(|| ToolInputValidationError::ExpectedObject { path: path.clone() })?;
    reject_unknown_fields(record.keys().map(String::as_str), ACTION_FIELDS, &path)?;
    require_non_empty_string(record.get("actionId"), &format!("{path}.actionId"))?;
    let tool_id = require_non_empty_string(record.get("toolId"), &format!("{path}.toolId"))?;
    require_non_empty_string(record.get("description"), &format!("{path}.description"))?;
    if let Some(depends_on) = record.get("dependsOn") {
        validate_string_array(depends_on, &format!("{path}.dependsOn"))?;
    }
    let args = record
        .get("args")
        .ok_or_else(|| ToolInputValidationError::MissingField {
            path: path.clone(),
            field: "args".to_string(),
        })?;
    let template =
        registry
            .template(tool_id)
            .ok_or_else(|| ToolInputValidationError::InvalidEnumValue {
                path: format!("{path}.toolId"),
            })?;
    validate_schema(args, &template.input.schema, &format!("{path}.args"))?;
    let args_record = args
        .as_object()
        .ok_or_else(|| ToolInputValidationError::ExpectedObject {
            path: format!("{path}.args"),
        })?;
    for field in &template.input.forbidden_fields {
        if args_record.contains_key(field) {
            return Err(ToolInputValidationError::UnknownField {
                path: format!("{path}.args"),
                field: field.clone(),
            });
        }
    }
    Ok(())
}

pub(crate) fn validate_content_blocks(
    batch: &Value,
) -> Result<BTreeMap<String, ContentBlock>, ToolInputValidationError> {
    let Some(raw_blocks) = batch.get("contentBlocks") else {
        return Ok(BTreeMap::new());
    };
    let blocks = raw_blocks
        .as_array()
        .ok_or_else(|| ToolInputValidationError::ExpectedArray {
            path: "contentBlocks".to_string(),
        })?;
    let mut output = BTreeMap::new();
    for (index, value) in blocks.iter().enumerate() {
        let path = format!("contentBlocks[{index}]");
        let record = value
            .as_object()
            .ok_or_else(|| ToolInputValidationError::ExpectedObject { path: path.clone() })?;
        reject_unknown_fields(
            record.keys().map(String::as_str),
            CONTENT_BLOCK_FIELDS,
            &path,
        )?;
        let block_id = require_non_empty_string(record.get("blockId"), &format!("{path}.blockId"))?
            .to_string();
        let target_path =
            require_non_empty_string(record.get("targetPath"), &format!("{path}.targetPath"))?
                .to_string();
        let operation =
            require_non_empty_string(record.get("operation"), &format!("{path}.operation"))?
                .to_string();
        if !CONTENT_BLOCK_OPERATIONS.contains(&operation.as_str()) {
            return Err(ToolInputValidationError::UnsupportedContentOperation { index, operation });
        }
        let content_lines =
            record
                .get("contentLines")
                .ok_or_else(|| ToolInputValidationError::MissingField {
                    path: path.clone(),
                    field: "contentLines".to_string(),
                })?;
        validate_string_array_allow_empty(content_lines, &format!("{path}.contentLines"))?;
        let content = content_lines
            .as_array()
            .expect("validated contentLines array")
            .iter()
            .map(|line| line.as_str().expect("validated content line"))
            .collect::<Vec<_>>()
            .join("\n");
        let allow_empty_content = match record.get("allowEmptyContent") {
            Some(value) => {
                value
                    .as_bool()
                    .ok_or_else(|| ToolInputValidationError::ExpectedBoolean {
                        path: format!("{path}.allowEmptyContent"),
                    })?
            }
            None => false,
        };
        if content.is_empty() && !(operation == "createEmpty" && allow_empty_content) {
            return Err(ToolInputValidationError::EmptyContentBlock { index });
        }
        let language = match record.get("language") {
            Some(value) => Some(
                require_non_empty_string(Some(value), &format!("{path}.language"))?.to_string(),
            ),
            None => None,
        };
        if output.contains_key(&block_id) {
            return Err(ToolInputValidationError::DuplicateContentBlock { block_id });
        }
        output.insert(
            block_id.clone(),
            ContentBlock {
                id: block_id,
                target_path: Some(target_path),
                language,
                operation: Some(operation),
                content: Some(content),
                allow_empty_content,
            },
        );
    }
    Ok(output)
}

pub(crate) fn validate_schema(
    value: &Value,
    schema: &Value,
    path: &str,
) -> Result<(), ToolInputValidationError> {
    match schema.get("type").and_then(Value::as_str) {
        Some("object") => {
            let record =
                value
                    .as_object()
                    .ok_or_else(|| ToolInputValidationError::ExpectedObject {
                        path: path.to_string(),
                    })?;
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if schema.get("additionalProperties").and_then(Value::as_bool) == Some(false) {
                reject_unknown_fields(
                    record.keys().map(String::as_str),
                    &properties.keys().map(String::as_str).collect::<Vec<_>>(),
                    path,
                )?;
            }
            if let Some(required) = schema.get("required").and_then(Value::as_array) {
                for field in required.iter().filter_map(Value::as_str) {
                    if !record.contains_key(field) {
                        return Err(ToolInputValidationError::MissingField {
                            path: path.to_string(),
                            field: field.to_string(),
                        });
                    }
                }
            }
            for (field, field_schema) in properties {
                if let Some(field_value) = record.get(&field) {
                    validate_schema(field_value, &field_schema, &format!("{path}.{field}"))?;
                }
            }
        }
        Some("array") => {
            let items =
                value
                    .as_array()
                    .ok_or_else(|| ToolInputValidationError::ExpectedArray {
                        path: path.to_string(),
                    })?;
            if let Some(item_schema) = schema.get("items") {
                for (index, item) in items.iter().enumerate() {
                    validate_schema(item, item_schema, &format!("{path}[{index}]"))?;
                }
            }
        }
        Some("string") => {
            require_non_empty_string(Some(value), path)?;
        }
        Some("boolean") => {
            if !value.is_boolean() {
                return Err(ToolInputValidationError::ExpectedBoolean {
                    path: path.to_string(),
                });
            }
        }
        Some("integer") => {
            let number = value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
                .ok_or_else(|| ToolInputValidationError::ExpectedInteger {
                    path: path.to_string(),
                })?;
            validate_minimum(number as f64, schema, path)?;
        }
        Some("number") => {
            let number =
                value
                    .as_f64()
                    .ok_or_else(|| ToolInputValidationError::ExpectedNumber {
                        path: path.to_string(),
                    })?;
            validate_minimum(number, schema, path)?;
        }
        _ => {}
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if !values.iter().any(|candidate| candidate == value) {
            return Err(ToolInputValidationError::InvalidEnumValue {
                path: path.to_string(),
            });
        }
    }
    Ok(())
}

fn validate_minimum(
    number: f64,
    schema: &Value,
    path: &str,
) -> Result<(), ToolInputValidationError> {
    let Some(minimum) = schema.get("minimum").and_then(Value::as_f64) else {
        return Ok(());
    };
    if number < minimum {
        return Err(ToolInputValidationError::BelowMinimum {
            path: path.to_string(),
            minimum: minimum.to_string(),
        });
    }
    Ok(())
}

fn validate_string_array(value: &Value, path: &str) -> Result<(), ToolInputValidationError> {
    let items = value
        .as_array()
        .ok_or_else(|| ToolInputValidationError::ExpectedArray {
            path: path.to_string(),
        })?;
    for (index, item) in items.iter().enumerate() {
        require_non_empty_string(Some(item), &format!("{path}[{index}]"))?;
    }
    Ok(())
}

fn validate_string_array_allow_empty(
    value: &Value,
    path: &str,
) -> Result<(), ToolInputValidationError> {
    let items = value
        .as_array()
        .ok_or_else(|| ToolInputValidationError::ExpectedArray {
            path: path.to_string(),
        })?;
    for (index, item) in items.iter().enumerate() {
        if !item.is_string() {
            return Err(ToolInputValidationError::ExpectedString {
                path: format!("{path}[{index}]"),
            });
        }
    }
    Ok(())
}

fn require_non_empty_string<'a>(
    value: Option<&'a Value>,
    path: &str,
) -> Result<&'a str, ToolInputValidationError> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolInputValidationError::ExpectedString {
            path: path.to_string(),
        })
}

fn reject_unknown_fields<'a>(
    fields: impl Iterator<Item = &'a str>,
    allowed: &[&str],
    path: &str,
) -> Result<(), ToolInputValidationError> {
    let allowed = allowed.iter().copied().collect::<BTreeSet<_>>();
    for field in fields {
        if !allowed.contains(field) {
            return Err(ToolInputValidationError::UnknownField {
                path: path.to_string(),
                field: field.to_string(),
            });
        }
    }
    Ok(())
}
