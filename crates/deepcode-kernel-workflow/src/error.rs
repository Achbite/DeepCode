use std::fmt;

pub type WorkflowDescriptorResult<T> = Result<T, WorkflowDescriptorError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowDescriptorError {
    pub code: String,
    pub message: String,
}

impl WorkflowDescriptorError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn parse(message: impl Into<String>) -> Self {
        Self::new("descriptor_parse_error", message)
    }

    pub fn validation(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, message)
    }
}

impl fmt::Display for WorkflowDescriptorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkflowDescriptorError {}
