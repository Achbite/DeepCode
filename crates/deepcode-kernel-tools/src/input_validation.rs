use crate::{ContentBlock, KernelToolRegistry};
use deepcode_kernel_abi::{KernelAction, KernelContentBlock};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

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
    #[error(
        "contentBlocks[{index}].contentLines may be empty only when operation=createEmpty and allowEmptyContent=true"
    )]
    EmptyContentBlock { index: usize },
}

pub(crate) fn validate_action(
    registry: &KernelToolRegistry,
    action: &KernelAction,
    index: usize,
) -> Result<(), ToolInputValidationError> {
    let path = format!("actionBundle.actions[{index}]");
    validate_non_empty_text(&action.action_id, &format!("{path}.actionId"))?;
    validate_non_empty_text(&action.tool_id, &format!("{path}.toolId"))?;
    validate_non_empty_text(&action.description, &format!("{path}.description"))?;
    for (dependency_index, dependency) in action.depends_on.iter().enumerate() {
        validate_non_empty_text(dependency, &format!("{path}.dependsOn[{dependency_index}]"))?;
    }
    let template = registry.contract(&action.tool_id).ok_or_else(|| {
        ToolInputValidationError::InvalidEnumValue {
            path: format!("{path}.toolId"),
        }
    })?;
    validate_schema(
        &action.args,
        &template.input.schema,
        &format!("{path}.args"),
    )?;
    let args_record =
        action
            .args
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
    blocks: &[KernelContentBlock],
) -> Result<BTreeMap<String, ContentBlock>, ToolInputValidationError> {
    let mut output = BTreeMap::new();
    for (index, block) in blocks.iter().enumerate() {
        let path = format!("contentBlocks[{index}]");
        validate_non_empty_text(&block.block_id, &format!("{path}.blockId"))?;
        validate_non_empty_text(&block.target_path, &format!("{path}.targetPath"))?;
        if let Some(language) = &block.language {
            validate_non_empty_text(language, &format!("{path}.language"))?;
        }
        let operation = block.operation.as_str();
        let content = block.content_lines.join("\n");
        if content.is_empty() && !(operation == "createEmpty" && block.allow_empty_content) {
            return Err(ToolInputValidationError::EmptyContentBlock { index });
        }
        if output.contains_key(&block.block_id) {
            return Err(ToolInputValidationError::DuplicateContentBlock {
                block_id: block.block_id.clone(),
            });
        }
        output.insert(
            block.block_id.clone(),
            ContentBlock {
                id: block.block_id.clone(),
                target_path: Some(block.target_path.clone()),
                language: block.language.clone(),
                operation: Some(operation.to_string()),
                content: Some(content),
                allow_empty_content: block.allow_empty_content,
            },
        );
    }
    Ok(output)
}

fn validate_non_empty_text(value: &str, path: &str) -> Result<(), ToolInputValidationError> {
    if value.trim().is_empty() {
        return Err(ToolInputValidationError::ExpectedString {
            path: path.to_string(),
        });
    }
    Ok(())
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
