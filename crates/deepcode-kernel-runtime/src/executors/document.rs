use super::*;
use std::fmt::Write as _;

pub(super) struct DocumentReadExecutor;

impl KernelToolExecutor for DocumentReadExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        invoke_document_read(invocation, context)
    }
}

fn invoke_document_read(
    invocation: KernelToolInvocation,
    context: KernelToolExecutionContext,
) -> KernelResult<KernelToolExecutionResult> {
    const MAX_PDF_BYTES: u64 = 16 * 1024 * 1024;
    const MAX_PDF_PAGES: usize = 50;
    const MAX_OUTPUT_BYTES: usize = 128 * 1024;

    let path = required_string(&invocation.input, "path")?;
    let target = prepared_workspace_target(&context)?;
    let metadata = fs::metadata(&target)
        .map_err(|error| KernelError::Other(format!("document.read metadata: {error}")))?;
    if !metadata.is_file() {
        return Err(KernelError::InvalidCommand(format!(
            "document.read target is not a file: {path}"
        )));
    }
    if metadata.len() > MAX_PDF_BYTES {
        return Err(KernelError::InvalidCommand(format!(
            "document.read PDF exceeds 16 MiB: {} bytes",
            metadata.len()
        )));
    }
    if target.extension().and_then(OsStr::to_str) != Some("pdf") {
        return Err(KernelError::InvalidCommand(
            "document.read currently supports PDF files only".to_string(),
        ));
    }
    let pages = pdf_extract::extract_text_by_pages(&target)
        .map_err(|error| KernelError::Other(format!("document.read PDF: {error}")))?;
    let requested_start = invocation
        .input
        .get("startPage")
        .and_then(Value::as_u64)
        .unwrap_or(1) as usize;
    let requested_end = invocation
        .input
        .get("endPage")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(pages.len());
    if requested_start == 0 || requested_end < requested_start {
        return Err(KernelError::InvalidCommand(
            "document.read requires 1-based startPage <= endPage".to_string(),
        ));
    }
    let start = requested_start.saturating_sub(1).min(pages.len());
    let end = requested_end.min(pages.len()).min(start + MAX_PDF_PAGES);
    let mut joined = String::new();
    for (index, content) in pages[start..end].iter().enumerate() {
        write!(joined, "\n--- page {} ---\n{}", start + index + 1, content)
            .expect("writing to a String cannot fail");
    }
    let text = limit_text(&joined, MAX_OUTPUT_BYTES);
    Ok(ok(
        invocation.id,
        serde_json::json!({
            "workspaceId": workspace_id(&context)?,
            "path": normalize_relative_path(&path),
            "adapter": "pdf_extract",
            "startPage": start + 1,
            "endPage": end,
            "totalPages": pages.len(),
            "text": text,
            "truncatedPages": requested_end > end || pages.len() > end,
            "truncatedOutput": joined.len() > MAX_OUTPUT_BYTES,
            "sizeBytes": metadata.len()
        }),
    ))
}
