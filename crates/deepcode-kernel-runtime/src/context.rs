use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn context_attach_reference(
        &self,
        request_id: RequestId,
        source_path: String,
        import_copy: bool,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            if source_path.trim().is_empty() {
                return Err(KernelError::InvalidCommand(
                    "reference source path is required".to_string(),
                ));
            }
            if import_copy {
                return Err(KernelError::NotImplemented("context.reference.import"));
            }
            Ok(serde_json::json!({
                "reference": {
                    "sourcePath": source_path,
                    "mode": "externalReadOnly"
                }
            }))
        })();
        self.context_result(request_id, "context.attachReference", result)
    }

    pub(crate) fn context_list_references(
        &self,
        request_id: RequestId,
    ) -> KernelResult<Vec<KernelEvent>> {
        self.context_result(
            request_id,
            "context.listReferences",
            Ok(serde_json::json!({ "references": [] })),
        )
    }

    pub(crate) fn context_result(
        &self,
        request_id: RequestId,
        operation: &str,
        result: KernelResult<Value>,
    ) -> KernelResult<Vec<KernelEvent>> {
        Ok(vec![KernelEvent::ContextResult {
            request_id,
            operation: operation.to_string(),
            ok: result.is_ok(),
            output: result.as_ref().ok().cloned(),
            error: result.as_ref().err().map(Into::into),
            sequence: None,
        }])
    }
}
