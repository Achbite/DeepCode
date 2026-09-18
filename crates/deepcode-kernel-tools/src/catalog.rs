use crate::invocation_adapter::canonicalize_invocation;
use crate::invocation_types::{KernelCanonicalInvocation, KernelToolKind};
use crate::registrations::{builtin_tool_registrations, KernelToolRegistration};
use crate::types::{ToolAvailability, ToolDescriptor};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum KernelToolCatalogError {
    #[error("tool `{0}` is not registered")]
    ToolNotRegistered(String),
    #[error("tool `{0}` is blocked")]
    ToolBlocked(String),
    #[error("tool `{tool_name}` arguments are invalid: {reason}")]
    InvalidArguments {
        tool_name: String,
        reason: String,
        issues: Vec<ToolInputIssue>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInputIssue {
    pub path: String,
    pub rule: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<Value>,
}

impl ToolInputIssue {
    pub fn new(
        path: impl Into<String>,
        rule: impl Into<String>,
        message: impl Into<String>,
        expected: Option<Value>,
    ) -> Self {
        Self {
            path: path.into(),
            rule: rule.into(),
            message: message.into(),
            expected,
        }
    }
}

#[derive(Debug, Clone)]
pub struct KernelToolRegistry {
    registrations: BTreeMap<&'static str, KernelToolRegistration>,
}

impl Default for KernelToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl KernelToolRegistry {
    pub fn new() -> Self {
        let mut registrations = BTreeMap::new();
        for registration in builtin_tool_registrations() {
            let tool_id = registration.tool_id();
            assert!(
                registrations.insert(tool_id, registration).is_none(),
                "duplicate Kernel tool registration: {tool_id}"
            );
        }
        Self { registrations }
    }

    pub fn descriptor(&self, tool_name: &str) -> Option<&ToolDescriptor> {
        self.registrations
            .get(tool_name)
            .map(|registration| &registration.descriptor)
    }

    pub fn descriptors(&self) -> impl Iterator<Item = &ToolDescriptor> {
        self.registrations
            .values()
            .map(|registration| &registration.descriptor)
    }

    #[doc(hidden)]
    pub fn prompt_guidance(
        &self,
    ) -> impl Iterator<Item = (&ToolDescriptor, &'static [&'static str])> {
        self.registrations
            .values()
            .filter(|registration| !registration.usage_guidelines.is_empty())
            .map(|registration| (&registration.descriptor, registration.usage_guidelines))
    }

    #[doc(hidden)]
    pub fn executor_bindings(&self) -> impl Iterator<Item = (&'static str, KernelToolKind)> + '_ {
        self.registrations
            .values()
            .map(|registration| (registration.tool_id(), registration.kind))
    }

    pub fn canonicalize(
        &self,
        tool_name: &str,
        raw_arguments: Value,
    ) -> Result<KernelCanonicalInvocation, KernelToolCatalogError> {
        let registration = self
            .registrations
            .get(tool_name)
            .ok_or_else(|| KernelToolCatalogError::ToolNotRegistered(tool_name.to_owned()))?;
        if registration.descriptor.availability == ToolAvailability::Blocked {
            return Err(KernelToolCatalogError::ToolBlocked(tool_name.to_owned()));
        }
        canonicalize_invocation(registration.kind, raw_arguments.clone()).map_err(|error| {
            let reason = error.to_string();
            // Explain a canonicalizer rejection using its published descriptor. This
            // is diagnostic only: admission remains owned by the canonicalizer.
            let mut issues = Vec::new();
            describe_input_issues(
                &registration.descriptor.input_schema,
                &raw_arguments,
                "$",
                &mut issues,
            );
            if issues.is_empty() {
                issues.push(ToolInputIssue::new("$", "canonicalInput", &reason, None));
            }
            KernelToolCatalogError::InvalidArguments {
                tool_name: tool_name.to_owned(),
                reason,
                issues,
            }
        })
    }
}

fn describe_input_issues(
    schema: &Value,
    input: &Value,
    path: &str,
    issues: &mut Vec<ToolInputIssue>,
) {
    let matches_type = match schema["type"].as_str() {
        Some("object") => input.is_object(),
        Some("array") => input.is_array(),
        Some("string") => input.is_string(),
        Some("boolean") => input.is_boolean(),
        Some("integer") => input.is_i64() || input.is_u64(),
        _ => true,
    };
    if !matches_type {
        issues.push(ToolInputIssue::new(
            path,
            "type",
            "Use the declared input type.",
            Some(schema["type"].clone()),
        ));
        return;
    }
    if let Some(values) = schema["enum"].as_array() {
        if !values.contains(input) {
            issues.push(ToolInputIssue::new(
                path,
                "enum",
                "Choose one of the allowed values.",
                Some(schema["enum"].clone()),
            ));
        }
    }
    if let Some(fields) = input.as_object() {
        if let Some(required) = schema["required"].as_array() {
            for name in required.iter().filter_map(Value::as_str) {
                if !fields.contains_key(name) {
                    issues.push(ToolInputIssue::new(
                        format!("{path}.{name}"),
                        "required",
                        "Supply this required field.",
                        schema["properties"].get(name).cloned(),
                    ));
                }
            }
        }
        for (name, value) in fields {
            let child_path = format!("{path}.{name}");
            if let Some(child_schema) = schema["properties"].get(name) {
                describe_input_issues(child_schema, value, &child_path, issues);
            } else if schema["additionalProperties"] == false {
                issues.push(ToolInputIssue::new(
                    child_path,
                    "additionalProperties",
                    "Remove this undeclared field.",
                    None,
                ));
            }
        }
    }
    if let Some(items) = input.as_array() {
        for (index, value) in items.iter().enumerate() {
            describe_input_issues(&schema["items"], value, &format!("{path}[{index}]"), issues);
        }
    }
    for (rule, measured, below) in [
        ("minimum", input.as_f64(), true),
        ("maximum", input.as_f64(), false),
        (
            "minLength",
            input.as_str().map(|v| v.chars().count() as f64),
            true,
        ),
        (
            "maxLength",
            input.as_str().map(|v| v.chars().count() as f64),
            false,
        ),
        ("minItems", input.as_array().map(|v| v.len() as f64), true),
        ("maxItems", input.as_array().map(|v| v.len() as f64), false),
    ] {
        if let (Some(limit), Some(measured)) = (schema[rule].as_f64(), measured) {
            if (below && measured < limit) || (!below && measured > limit) {
                issues.push(ToolInputIssue::new(
                    path,
                    rule,
                    "Use a value within the declared bound.",
                    Some(schema[rule].clone()),
                ));
            }
        }
    }
}
