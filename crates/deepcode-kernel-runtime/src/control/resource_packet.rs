use super::*;
use std::collections::BTreeMap;

#[derive(Debug, Default)]
pub(super) struct ResourceResolutionScope {
    pub(super) workspace_root: Option<PathBuf>,
    pub(super) external_leases: BTreeMap<String, ExternalResourceLease>,
}

pub(super) fn driver_request_kind_name(kind: &DriverRequestKind) -> &'static str {
    match kind {
        DriverRequestKind::NeedProposal => "need-proposal",
    }
}

pub(super) fn proposal_kind_name(kind: &ProposalEnvelopeKind) -> &'static str {
    match kind {
        ProposalEnvelopeKind::Answer => "answer",
        ProposalEnvelopeKind::ResourceRequest => "resourceRequest",
        ProposalEnvelopeKind::DecisionRequest => "decisionRequest",
        ProposalEnvelopeKind::ActionBundle => "actionBundle",
        ProposalEnvelopeKind::Diagnostic => "diagnostic",
    }
}

pub(super) const RESOURCE_PACKET_MAX_FILE_CHARS: usize = 12_000;
pub(super) const RESOURCE_PACKET_MAX_DIR_DEPTH: u32 = 2;
pub(super) const RESOURCE_PACKET_MAX_DIR_ENTRIES: usize = 200;

pub(super) fn resource_packet_from_manifest(
    request_id: &RequestId,
    manifest: &Value,
    scope: &ResourceResolutionScope,
) -> ResourcePacket {
    let manifest_id = manifest
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("resource-manifest");
    let workspace_scope_key = manifest
        .get("workspaceScopeKey")
        .and_then(Value::as_str)
        .unwrap_or("unbound-workspace");
    let entries = manifest
        .get("entries")
        .or_else(|| manifest.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let items = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let item = resolve_resource_manifest_entry(request_id, index, entry, scope);
            serde_json::from_value(item).unwrap_or_else(|error| ResourcePacketItem {
                request_item_id: format!("item-{index}"),
                manifest_entry_id: format!("entry-{index}"),
                status: ResourcePacketStatus::Error,
                read_policy: "explicit-manifest-readonly".to_string(),
                source_kind: "resource".to_string(),
                resolved_kind: None,
                path: None,
                absolute_path: None,
                content_kind: None,
                root_id: None,
                content: None,
                prompt_content: None,
                content_hash: None,
                metadata_hash: None,
                size_bytes: None,
                original_bytes: None,
                offset_bytes: None,
                limit_bytes: None,
                returned_bytes: None,
                returned_count: None,
                returned_matches: None,
                directory_depth: None,
                context_lines: None,
                max_results: None,
                visited_files: None,
                skipped_files: None,
                skipped_binary_files: None,
                skipped_executable_files: None,
                truncated: None,
                range_complete: None,
                query: None,
                strategy: None,
                include: Vec::new(),
                exclude: Vec::new(),
                nodes: Vec::new(),
                matches: Vec::new(),
                file_classification: None,
                content_summary: None,
                evidence_ref: None,
                evidence_refs: Vec::new(),
                reason: Some("resource_packet_encoding_failed".to_string()),
                message: Some(error.to_string()),
                skip_reason: None,
                skip_message: None,
            })
        })
        .collect::<Vec<_>>();
    let evidence_refs = items
        .iter()
        .filter_map(|item| item.evidence_ref.clone())
        .collect::<Vec<_>>();
    ResourcePacket {
        id: format!("resource-packet-{}", request_id.0),
        request_id: request_id.0.clone(),
        workspace_scope_key: workspace_scope_key.to_string(),
        manifest_id: manifest_id.to_string(),
        items,
        evidence_refs,
        summary: "Kernel ResourceResolve produced a ResourcePacket from explicit manifest entries."
            .to_string(),
    }
}

pub(super) fn resolve_resource_manifest_entry(
    request_id: &RequestId,
    index: usize,
    entry: &Value,
    scope: &ResourceResolutionScope,
) -> Value {
    let manifest_entry_id = entry
        .get("id")
        .or_else(|| entry.get("manifestEntryId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("entry-{index}"));
    let source_kind = entry
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("resource");
    let request_item_id = format!("item-{index}");
    let evidence_ref = format!("evidence-{}-{index}", request_id.0);
    let path = match resource_entry_path(entry, scope) {
        Ok(path) => path,
        Err(error) => {
            return resource_packet_error_item(
                &request_item_id,
                &manifest_entry_id,
                source_kind,
                "outside_manifest_scope",
                &error.to_string(),
            );
        }
    };
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return resource_packet_not_found_item(
                &request_item_id,
                &manifest_entry_id,
                source_kind,
                &format!("stat {}: {error}", path.display()),
            );
        }
    };
    let actual_kind = if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    };
    if source_kind == "search" {
        if !metadata.is_dir() {
            return resource_packet_error_item(
                &request_item_id,
                &manifest_entry_id,
                source_kind,
                "not_directory",
                &format!(
                    "{} is {actual_kind}, not searchable directory",
                    path.display()
                ),
            );
        }
        return resource_packet_search_item(
            &request_item_id,
            &manifest_entry_id,
            entry,
            &path,
            &evidence_ref,
        );
    }
    if source_kind == "file" && !metadata.is_file() {
        return resource_packet_error_item(
            &request_item_id,
            &manifest_entry_id,
            source_kind,
            "not_file",
            &format!("{} is {actual_kind}, not file", path.display()),
        );
    }
    if source_kind == "directory" && !metadata.is_dir() {
        return resource_packet_error_item(
            &request_item_id,
            &manifest_entry_id,
            source_kind,
            "not_directory",
            &format!("{} is {actual_kind}, not directory", path.display()),
        );
    }

    if entry.get("readMode").and_then(Value::as_str) == Some("metadataOnly") {
        return resource_packet_metadata_item(
            &ResourcePacketItemContext {
                request_item_id: &request_item_id,
                manifest_entry_id: &manifest_entry_id,
                source_kind,
                path: &path,
                entry,
                evidence_ref: &evidence_ref,
            },
            &metadata,
            actual_kind,
        );
    }

    if metadata.is_dir() {
        let directory_options = entry.get("directoryOptions").and_then(Value::as_object);
        let max_depth = directory_options
            .and_then(|options| options.get("maxDepth"))
            .and_then(Value::as_u64)
            .map(|value| value.clamp(1, RESOURCE_PACKET_MAX_DIR_DEPTH as u64) as u32)
            .unwrap_or(RESOURCE_PACKET_MAX_DIR_DEPTH);
        let max_entries = directory_options
            .and_then(|options| options.get("maxEntries"))
            .and_then(Value::as_u64)
            .map(|value| value.clamp(1, RESOURCE_PACKET_MAX_DIR_ENTRIES as u64) as usize)
            .unwrap_or(RESOURCE_PACKET_MAX_DIR_ENTRIES);
        let listing = list_nodes_bounded(&path, &path, max_depth, max_entries);
        let (nodes, returned_count, truncated) = match listing {
            Ok(listing) => (listing.nodes, listing.returned_count, listing.truncated),
            Err(error) => (
                vec![serde_json::json!({
                    "type": "error",
                    "message": error.to_string()
                })],
                0,
                false,
            ),
        };
        return serde_json::json!({
            "requestItemId": request_item_id,
            "manifestEntryId": manifest_entry_id,
            "status": "resolved",
            "readPolicy": "explicit-manifest-readonly",
            "sourceKind": source_kind,
            "resolvedKind": "directory",
            "path": resource_entry_display_path(entry, &path),
            "absolutePath": path.to_string_lossy(),
            "contentKind": "directoryTree",
            "rootId": entry.get("rootId").cloned().unwrap_or(Value::Null),
            "nodes": nodes,
            "returnedCount": returned_count,
            "truncated": truncated,
            "directoryDepth": max_depth,
            "contentSummary": entry.get("summary").and_then(Value::as_str).unwrap_or("Directory tree resolved by Kernel ResourceResolve."),
            "evidenceRef": evidence_ref,
            "evidenceRefs": [evidence_ref]
        });
    }

    if metadata.is_file() {
        match deepcode_kernel_tools::file_content::read_text_file_for_llm(&path) {
            Ok(content) => {
                let classification = content.classification;
                let content = content.content;
                let offset_bytes = resource_entry_u64(entry, "offsetBytes");
                let limit_bytes = resource_entry_u64(entry, "limitBytes");
                if offset_bytes.is_some() || limit_bytes.is_some() {
                    return resource_packet_file_range_item(
                        &ResourcePacketItemContext {
                            request_item_id: &request_item_id,
                            manifest_entry_id: &manifest_entry_id,
                            source_kind,
                            path: &path,
                            entry,
                            evidence_ref: &evidence_ref,
                        },
                        &content,
                        offset_bytes,
                        limit_bytes,
                        &classification,
                    );
                }
                let truncated = content.chars().count() > RESOURCE_PACKET_MAX_FILE_CHARS;
                let clipped = clip_resource_text(&content, RESOURCE_PACKET_MAX_FILE_CHARS);
                return serde_json::json!({
                    "requestItemId": request_item_id,
                    "manifestEntryId": manifest_entry_id,
                    "status": "resolved",
                    "readPolicy": "explicit-manifest-readonly",
                    "sourceKind": source_kind,
                    "resolvedKind": "file",
                    "path": resource_entry_display_path(entry, &path),
                    "absolutePath": path.to_string_lossy(),
                    "contentKind": "fileText",
                    "content": clipped,
                    "contentHash": deepcode_kernel_tools::hash_bytes(content.as_bytes()),
                    "sizeBytes": content.len(),
                    "originalBytes": content.len(),
                    "returnedBytes": clipped.len(),
                    "truncated": truncated,
                    "rangeComplete": !truncated,
                    "fileClassification": classification,
                    "contentSummary": entry.get("summary").and_then(Value::as_str).unwrap_or("File text resolved by Kernel ResourceResolve."),
                    "evidenceRef": evidence_ref,
                    "evidenceRefs": [evidence_ref]
                });
            }
            Err(skip) => {
                return resource_packet_skipped_item(
                    &request_item_id,
                    &manifest_entry_id,
                    source_kind,
                    &path,
                    entry,
                    &skip,
                    &evidence_ref,
                );
            }
        }
    }

    resource_packet_error_item(
        &request_item_id,
        &manifest_entry_id,
        source_kind,
        "unsupported_resource_kind",
        &format!("{} is not a file or directory", path.display()),
    )
}

struct ResourcePacketItemContext<'a> {
    request_item_id: &'a str,
    manifest_entry_id: &'a str,
    source_kind: &'a str,
    path: &'a Path,
    entry: &'a Value,
    evidence_ref: &'a str,
}

fn resource_packet_metadata_item(
    context: &ResourcePacketItemContext<'_>,
    metadata: &fs::Metadata,
    actual_kind: &str,
) -> Value {
    let modified_millis = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let metadata_hash = deepcode_kernel_tools::hash_bytes(
        format!("{actual_kind}:{}:{modified_millis}", metadata.len()).as_bytes(),
    );
    let classification = metadata.is_file().then(|| {
        deepcode_kernel_tools::file_content::lightweight_file_classification(context.path, metadata)
    });
    serde_json::json!({
        "requestItemId": context.request_item_id,
        "manifestEntryId": context.manifest_entry_id,
        "status": "resolved",
        "readPolicy": "explicit-manifest-readonly",
        "sourceKind": context.source_kind,
        "resolvedKind": actual_kind,
        "path": resource_entry_display_path(context.entry, context.path),
        "absolutePath": context.path.to_string_lossy(),
        "rootId": context.entry.get("rootId").cloned().unwrap_or(Value::Null),
        "contentKind": "metadata",
        "sizeBytes": metadata.len(),
        "metadataHash": metadata_hash,
        "fileClassification": classification,
        "contentSummary": "Metadata resolved by Kernel without reading file content.",
        "evidenceRef": context.evidence_ref,
        "evidenceRefs": [context.evidence_ref]
    })
}

pub(super) fn resource_packet_skipped_item(
    request_item_id: &str,
    manifest_entry_id: &str,
    source_kind: &str,
    path: &Path,
    entry: &Value,
    skip: &deepcode_kernel_tools::file_content::FileContentSkip,
    evidence_ref: &str,
) -> Value {
    serde_json::json!({
        "requestItemId": request_item_id,
        "manifestEntryId": manifest_entry_id,
        "status": "skipped",
        "readPolicy": "explicit-manifest-readonly",
        "sourceKind": source_kind,
        "resolvedKind": "file",
        "path": resource_entry_display_path(entry, path),
        "absolutePath": path.to_string_lossy(),
        "contentKind": "fileSkipped",
        "skipReason": &skip.reason,
        "skipMessage": &skip.message,
        "fileClassification": &skip.classification,
        "sizeBytes": skip.classification.size_bytes,
        "contentSummary": entry.get("summary").and_then(Value::as_str).unwrap_or("File was skipped by Kernel content policy before LLM context assembly."),
        "evidenceRef": evidence_ref,
        "evidenceRefs": [evidence_ref]
    })
}

fn resource_packet_file_range_item(
    context: &ResourcePacketItemContext<'_>,
    content: &str,
    offset_bytes: Option<u64>,
    limit_bytes: Option<u64>,
    classification: &deepcode_kernel_tools::file_content::FileContentClassification,
) -> Value {
    let total_bytes = content.len();
    let requested_offset = offset_bytes.unwrap_or(0) as usize;
    if requested_offset > total_bytes {
        return resource_packet_error_item(
            context.request_item_id,
            context.manifest_entry_id,
            context.source_kind,
            "range_out_of_bounds",
            &format!(
                "offsetBytes {requested_offset} is beyond file size {total_bytes} for {}",
                context.path.display()
            ),
        );
    }
    let requested_limit = limit_bytes
        .map(|value| value as usize)
        .unwrap_or(RESOURCE_PACKET_MAX_FILE_CHARS)
        .min(RESOURCE_PACKET_MAX_FILE_CHARS);
    if requested_limit == 0 {
        return resource_packet_error_item(
            context.request_item_id,
            context.manifest_entry_id,
            context.source_kind,
            "invalid_range",
            "limitBytes must be greater than zero",
        );
    }
    let requested_end = requested_offset
        .saturating_add(requested_limit)
        .min(total_bytes);
    let start = ceil_char_boundary(content, requested_offset);
    let end = floor_char_boundary(content, requested_end);
    if start > end {
        return resource_packet_error_item(
            context.request_item_id,
            context.manifest_entry_id,
            context.source_kind,
            "invalid_utf8_range",
            "requested byte range does not include a valid UTF-8 text segment",
        );
    }
    let segment = &content[start..end];
    serde_json::json!({
        "requestItemId": context.request_item_id,
        "manifestEntryId": context.manifest_entry_id,
        "status": "resolved",
        "readPolicy": "explicit-manifest-readonly",
        "sourceKind": context.source_kind,
        "resolvedKind": "file",
        "path": resource_entry_display_path(context.entry, context.path),
        "absolutePath": context.path.to_string_lossy(),
        "contentKind": "fileText",
        "content": segment,
        "contentHash": deepcode_kernel_tools::hash_bytes(content.as_bytes()),
        "sizeBytes": total_bytes,
        "originalBytes": total_bytes,
        "offsetBytes": start,
        "limitBytes": requested_limit,
        "returnedBytes": segment.len(),
        "truncated": start > 0 || end < total_bytes,
        "rangeComplete": end >= total_bytes,
        "fileClassification": classification,
        "contentSummary": context.entry.get("summary").and_then(Value::as_str).unwrap_or("File text range resolved by Kernel ResourceResolve."),
        "evidenceRef": context.evidence_ref,
        "evidenceRefs": [context.evidence_ref]
    })
}

pub(super) fn resource_packet_search_item(
    request_item_id: &str,
    manifest_entry_id: &str,
    entry: &Value,
    path: &Path,
    evidence_ref: &str,
) -> Value {
    let Some(query) = entry
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return resource_packet_error_item(
            request_item_id,
            manifest_entry_id,
            "search",
            "missing_query",
            "search manifest entry requires a non-empty query",
        );
    };
    let includes = resource_entry_string_array(entry, "include");
    let excludes = resource_entry_string_array(entry, "exclude");
    let strategy = if entry.get("isRegex").and_then(Value::as_bool) == Some(true) {
        "regex"
    } else {
        entry
            .get("strategy")
            .and_then(Value::as_str)
            .unwrap_or("literal")
    };
    let context_lines = resource_entry_u64(entry, "contextLines").unwrap_or(0) as u32;
    let max_results = resource_entry_u64(entry, "maxResults")
        .unwrap_or(crate::executors::CODE_SEARCH_DEFAULT_MAX_RESULTS as u64)
        as u32;
    match crate::executors::grep_workspace_with_options(
        path,
        path,
        crate::executors::CodeGrepOptions {
            query,
            strategy,
            includes: &includes,
            excludes: &excludes,
            context_lines,
            max_results,
        },
    ) {
        Ok(result) => {
            let returned_matches = result.matches.len();
            let prompt_content = serde_json::to_string_pretty(&serde_json::json!({
                "query": query,
                "strategy": strategy,
                "include": &includes,
                "exclude": &excludes,
                "contextLines": result.context_lines,
                "maxResults": result.max_results,
                "returnedMatches": returned_matches,
                "truncated": result.truncated,
                "visitedFiles": result.visited_files,
                "skippedFiles": result.skipped_files,
                "skippedBinaryFiles": result.skipped_binary_files,
                "skippedExecutableFiles": result.skipped_executable_files,
                "matches": &result.matches
            }))
            .unwrap_or_else(|_| "[]".to_string());
            serde_json::json!({
                "requestItemId": request_item_id,
                "manifestEntryId": manifest_entry_id,
                "status": "resolved",
                "readPolicy": "explicit-manifest-readonly",
                "sourceKind": "search",
                "resolvedKind": "search",
                "path": resource_entry_display_path(entry, path),
                "absolutePath": path.to_string_lossy(),
                "contentKind": "searchResults",
                "query": query,
                "strategy": strategy,
                "include": includes,
                "exclude": excludes,
                "matches": result.matches,
                "returnedMatches": returned_matches,
                "truncated": result.truncated,
                "visitedFiles": result.visited_files,
                "skippedFiles": result.skipped_files,
                "skippedBinaryFiles": result.skipped_binary_files,
                "skippedExecutableFiles": result.skipped_executable_files,
                "promptContent": prompt_content,
                "contentSummary": entry.get("summary").and_then(Value::as_str).unwrap_or("Search results resolved by Kernel ResourceResolve."),
                "evidenceRef": evidence_ref,
                "evidenceRefs": [evidence_ref]
            })
        }
        Err(error) => resource_packet_error_item(
            request_item_id,
            manifest_entry_id,
            "search",
            "search_failed",
            &error.to_string(),
        ),
    }
}

pub(super) fn resource_entry_path(
    entry: &Value,
    scope: &ResourceResolutionScope,
) -> KernelResult<PathBuf> {
    let raw = entry
        .get("resourceRef")
        .or_else(|| entry.get("resource_ref"))
        .or_else(|| entry.get("path"))
        .or_else(|| entry.get("absolutePath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand("resource manifest entry requires a path".to_string())
        })?;
    let path = Path::new(raw);
    if path.is_absolute() {
        return Err(KernelError::PermissionDenied(
            "resource manifest entries must use root-relative paths".to_string(),
        ));
    }
    if let Some(resource_id) = entry
        .get("resourceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let lease = scope.external_leases.get(resource_id).ok_or_else(|| {
            KernelError::PermissionDenied(format!(
                "external resource lease {resource_id} is not active for this run"
            ))
        })?;
        let root = PathBuf::from(&lease.canonical_path);
        return match lease.target_kind {
            ExternalResourceKind::Directory => WorkspaceBoundary::new(root).resolve_read(raw),
            ExternalResourceKind::File if matches!(raw, "." | "./") => Ok(root),
            ExternalResourceKind::File => Err(KernelError::PermissionDenied(format!(
                "external file lease {resource_id} does not allow child paths"
            ))),
        };
    }
    let root = scope
        .workspace_root
        .as_deref()
        .ok_or(KernelError::MissingWorkspaceBinding)?;
    WorkspaceBoundary::new(root).resolve_read(raw)
}

pub(super) fn resource_entry_display_path(entry: &Value, path: &Path) -> String {
    entry
        .get("path")
        .or_else(|| entry.get("resourceRef"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

pub(super) fn resource_entry_u64(entry: &Value, key: &str) -> Option<u64> {
    entry.get(key).and_then(Value::as_u64)
}

pub(super) fn resource_entry_string_array(entry: &Value, key: &str) -> Vec<String> {
    entry
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .filter(|item| !item.trim().is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(super) fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

pub(super) fn ceil_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index < value.len() && !value.is_char_boundary(index) {
        index += 1;
    }
    index
}

pub(super) fn resource_packet_error_item(
    request_item_id: &str,
    manifest_entry_id: &str,
    source_kind: &str,
    reason: &str,
    message: &str,
) -> Value {
    serde_json::json!({
        "requestItemId": request_item_id,
        "manifestEntryId": manifest_entry_id,
        "status": "error",
        "readPolicy": "explicit-manifest-readonly",
        "sourceKind": source_kind,
        "reason": reason,
        "message": message,
        "evidenceRefs": []
    })
}

pub(super) fn resource_packet_not_found_item(
    request_item_id: &str,
    manifest_entry_id: &str,
    source_kind: &str,
    message: &str,
) -> Value {
    serde_json::json!({
        "requestItemId": request_item_id,
        "manifestEntryId": manifest_entry_id,
        "status": "notFound",
        "readPolicy": "explicit-manifest-readonly",
        "sourceKind": source_kind,
        "reason": "not_found",
        "message": message,
        "evidenceRefs": []
    })
}

pub(super) fn clip_resource_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head_len = max_chars / 2;
    let tail_len = max_chars.saturating_sub(head_len + 24);
    let head = text.chars().take(head_len).collect::<String>();
    let tail = text
        .chars()
        .rev()
        .take(tail_len)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}\n\n[... truncated ...]\n\n{tail}")
}
