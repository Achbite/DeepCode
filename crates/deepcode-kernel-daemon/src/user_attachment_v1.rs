use crate::host_v2_storage::{
    atomic_write_private_json, canonical_sha256, create_private_directory, read_json,
    validate_bounded_identity, validate_safe_session_identity, HostV2StorageError,
};
use deepcode_kernel_abi::{
    validate_agent_input_attachments_v3, AgentInputAttachmentKindV3, AgentInputAttachmentScopeV3,
    AgentInputAttachmentV3,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const USER_ATTACHMENT_GRANT_SCHEMA_V1: &str = "deepcode.host.user-attachment-grant.v1";
const USER_ATTACHMENT_REQUEST_SCHEMA_V1: &str = "deepcode.host.user-attachment-request.v1";
const MAX_ATTACHMENT_FILES_V1: u64 = 2_000;
const MAX_ATTACHMENT_TOTAL_BYTES_V1: u64 = 64 * 1024 * 1024;
const MAX_ATTACHMENT_FILE_BYTES_V1: u64 = 16 * 1024 * 1024;
const MAX_ATTACHMENT_DEPTH_V1: usize = 32;
const MAX_ATTACHMENT_CONTEXT_FILES_V1: usize = 512;
const MAX_ATTACHMENT_CONTEXT_BYTES_V1: usize = 512 * 1024;
const MAX_ATTACHMENT_OMITTED_PATHS_V1: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UserAttachmentSnapshotV1 {
    pub(crate) file_count: u64,
    pub(crate) total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UserAttachmentContextFileV1 {
    pub(crate) path: String,
    pub(crate) content: String,
    pub(crate) size_bytes: usize,
    pub(crate) content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UserAttachmentContextOmissionV1 {
    pub(crate) path: String,
    pub(crate) reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UserAttachmentContextV1 {
    pub(crate) schema_version: String,
    pub(crate) attachment_id: String,
    pub(crate) resource_id: String,
    pub(crate) display_name: String,
    pub(crate) kind: AgentInputAttachmentKindV3,
    pub(crate) files: Vec<UserAttachmentContextFileV1>,
    pub(crate) omitted: Vec<UserAttachmentContextOmissionV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UserAttachmentGrantV1 {
    pub(crate) schema_version: String,
    pub(crate) caller_request_id: String,
    pub(crate) request_digest: String,
    pub(crate) attachment: AgentInputAttachmentV3,
    pub(crate) snapshot: UserAttachmentSnapshotV1,
    pub(crate) created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) bound_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) consumed_by_caller_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) revoked_at: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct UserAttachmentAdmissionV1 {
    pub(crate) attachments: Vec<AgentInputAttachmentV3>,
    pub(crate) contexts: Vec<UserAttachmentContextV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserAttachmentRequestRecordV1 {
    schema_version: String,
    caller_request_id: String,
    request_digest: String,
    attachment_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct UserAttachmentStoreV1 {
    root: Arc<PathBuf>,
    lock: Arc<Mutex<()>>,
}

pub(crate) fn validate_user_attachment_contexts_v1(
    attachments: &[AgentInputAttachmentV3],
    contexts: &[UserAttachmentContextV1],
) -> Result<(), HostV2StorageError> {
    validate_agent_input_attachments_v3(attachments)
        .map_err(|error| HostV2StorageError::invalid(error.code, error.message))?;
    if attachments.len() != contexts.len() {
        return Err(current_schema_required("User attachment context set"));
    }
    let mut total_bytes = 0_usize;
    for (attachment, context) in attachments.iter().zip(contexts) {
        if context.schema_version != "deepcode.host.user-attachment-context.v1"
            || context.attachment_id != attachment.attachment_id
            || context.resource_id != attachment.resource_id
            || context.display_name != attachment.display_name
            || context.kind != attachment.kind
            || context.files.len() > MAX_ATTACHMENT_CONTEXT_FILES_V1
            || context.omitted.len() > MAX_ATTACHMENT_OMITTED_PATHS_V1
        {
            return Err(current_schema_required("User attachment context"));
        }
        for file in &context.files {
            validate_context_relative_path(&file.path)?;
            if file.size_bytes != file.content.len()
                || deepcode_kernel_tools::hash_bytes(file.content.as_bytes()) != file.content_hash
            {
                return Err(current_schema_required("User attachment context file"));
            }
            total_bytes = total_bytes.checked_add(file.content.len()).ok_or_else(|| {
                HostV2StorageError::invalid(
                    "user_attachment_context_too_large",
                    "Combined user attachment context size overflowed",
                )
            })?;
        }
        for omission in &context.omitted {
            validate_context_relative_path(&omission.path)?;
            validate_bounded_identity(&omission.reason, "attachmentOmissionReason", 256)?;
        }
    }
    if total_bytes > MAX_ATTACHMENT_CONTEXT_BYTES_V1 {
        return Err(HostV2StorageError::invalid(
            "user_attachment_context_too_large",
            "Combined user attachments exceed the Agent context limit",
        ));
    }
    Ok(())
}

impl UserAttachmentStoreV1 {
    pub(crate) fn new(config_root: PathBuf) -> Self {
        Self {
            root: Arc::new(config_root.join("user-attachments").join("v1")),
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub(crate) fn create_grant(
        &self,
        absolute_path: &str,
        scope: AgentInputAttachmentScopeV3,
        caller_request_id: &str,
    ) -> Result<UserAttachmentGrantV1, HostV2StorageError> {
        validate_bounded_identity(caller_request_id, "callerRequestId", 512)?;
        let requested = PathBuf::from(absolute_path);
        if !requested.is_absolute() {
            return Err(HostV2StorageError::invalid(
                "user_attachment_path_invalid",
                "User attachment selection requires an absolute Host path",
            ));
        }
        let request_digest = canonical_sha256(&json!({
            "schemaVersion": USER_ATTACHMENT_REQUEST_SCHEMA_V1,
            "absolutePath": absolute_path,
            "scope": scope,
            "callerRequestId": caller_request_id,
        }))?;
        let _guard = self.lock.lock().map_err(|_| store_unavailable())?;
        self.ensure_layout()?;
        let request_path = self.request_path(caller_request_id);
        if request_path.exists() {
            let record: UserAttachmentRequestRecordV1 = serde_json::from_value(read_required_json(
                &request_path,
                "User attachment request record",
            )?)
            .map_err(|_| current_schema_required("User attachment request record"))?;
            if record.schema_version != USER_ATTACHMENT_REQUEST_SCHEMA_V1
                || record.caller_request_id != caller_request_id
                || record.request_digest != request_digest
            {
                return Err(HostV2StorageError::conflict(
                    "user_attachment_request_conflict",
                    "callerRequestId is already bound to different attachment material",
                ));
            }
            let grant = self.read_grant(&record.attachment_id)?;
            if grant.revoked_at.is_some() {
                return Err(HostV2StorageError::conflict(
                    "user_attachment_grant_revoked",
                    "The idempotent user attachment grant was revoked",
                ));
            }
            return Ok(grant);
        }

        let source_metadata = fs::symlink_metadata(&requested).map_err(|error| {
            HostV2StorageError::not_found(
                "user_attachment_source_unavailable",
                format!(
                    "inspect selected attachment {}: {error}",
                    requested.display()
                ),
            )
        })?;
        if source_metadata.file_type().is_symlink()
            || (!source_metadata.is_file() && !source_metadata.is_dir())
        {
            return Err(HostV2StorageError::invalid(
                "user_attachment_source_unsupported",
                "User attachments must be regular files or directories and cannot be symbolic links",
            ));
        }
        let canonical = fs::canonicalize(&requested).map_err(|error| {
            HostV2StorageError::not_found(
                "user_attachment_source_unavailable",
                format!(
                    "canonicalize selected attachment {}: {error}",
                    requested.display()
                ),
            )
        })?;
        let display_name = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                HostV2StorageError::invalid(
                    "user_attachment_display_name_invalid",
                    "Selected attachment has no portable display name",
                )
            })?
            .to_string();
        deepcode_kernel_abi::validate_agent_attachment_display_name_v3(&display_name)
            .map_err(|error| HostV2StorageError::invalid(error.code, error.message))?;

        let attachment_id = random_id("attachment")?;
        let resource_id = random_id("resource")?;
        let attachment = AgentInputAttachmentV3 {
            kind: if source_metadata.is_dir() {
                AgentInputAttachmentKindV3::Directory
            } else {
                AgentInputAttachmentKindV3::File
            },
            attachment_id: attachment_id.clone(),
            resource_id: resource_id.clone(),
            display_name: display_name.clone(),
            scope,
        };
        validate_agent_input_attachments_v3(std::slice::from_ref(&attachment))
            .map_err(|error| HostV2StorageError::invalid(error.code, error.message))?;

        let object_path = self.object_path(&resource_id);
        let staging_path = self
            .objects_dir()
            .join(format!(".pending-{}", random_id("snapshot")?));
        create_private_directory(&staging_path)?;
        let snapshot_result = snapshot_selected_resource(
            &canonical,
            &staging_path.join(&display_name),
            source_metadata.is_dir(),
        );
        let snapshot = match snapshot_result {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging_path);
                return Err(error);
            }
        };
        let context =
            match build_attachment_context_v1(&attachment, &staging_path.join(&display_name)) {
                Ok(context) => context,
                Err(error) => {
                    let _ = fs::remove_dir_all(&staging_path);
                    return Err(error);
                }
            };
        validate_user_attachment_contexts_v1(
            std::slice::from_ref(&attachment),
            std::slice::from_ref(&context),
        )?;
        if let Err(error) = fs::rename(&staging_path, &object_path) {
            let _ = fs::remove_dir_all(&staging_path);
            return Err(HostV2StorageError::io(
                "user_attachment_snapshot_commit_failed",
                format!("commit user attachment snapshot: {error}"),
            ));
        }
        if let Err(error) = atomic_write_private_json(
            &self.context_path(&resource_id),
            &serde_json::to_value(&context).map_err(|_| store_unavailable())?,
        ) {
            let _ = fs::remove_dir_all(&object_path);
            return Err(error);
        }

        let grant = UserAttachmentGrantV1 {
            schema_version: USER_ATTACHMENT_GRANT_SCHEMA_V1.to_string(),
            caller_request_id: caller_request_id.to_string(),
            request_digest: request_digest.clone(),
            attachment,
            snapshot,
            created_at: crate::utils::now_rfc3339_text(),
            bound_session_id: None,
            consumed_by_caller_request_id: None,
            revoked_at: None,
        };
        if let Err(error) = atomic_write_private_json(
            &self.grant_path(&attachment_id),
            &serde_json::to_value(&grant).map_err(|_| store_unavailable())?,
        ) {
            let _ = fs::remove_dir_all(&object_path);
            let _ = fs::remove_file(self.context_path(&resource_id));
            return Err(error);
        }
        let request_record = UserAttachmentRequestRecordV1 {
            schema_version: USER_ATTACHMENT_REQUEST_SCHEMA_V1.to_string(),
            caller_request_id: caller_request_id.to_string(),
            request_digest,
            attachment_id,
        };
        if let Err(error) = atomic_write_private_json(
            &request_path,
            &serde_json::to_value(request_record).map_err(|_| store_unavailable())?,
        ) {
            let _ = fs::remove_file(self.grant_path(&grant.attachment.attachment_id));
            let _ = fs::remove_file(self.context_path(&grant.attachment.resource_id));
            let _ = fs::remove_dir_all(self.object_path(&grant.attachment.resource_id));
            return Err(error);
        }
        Ok(grant)
    }

    pub(crate) fn admit_input(
        &self,
        session_id: &str,
        caller_request_id: &str,
        requested: &[AgentInputAttachmentV3],
    ) -> Result<UserAttachmentAdmissionV1, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(caller_request_id, "callerRequestId", 512)?;
        validate_agent_input_attachments_v3(requested)
            .map_err(|error| HostV2StorageError::invalid(error.code, error.message))?;
        let _guard = self.lock.lock().map_err(|_| store_unavailable())?;
        self.ensure_layout()?;

        let mut requested_grants = Vec::with_capacity(requested.len());
        for attachment in requested {
            let grant = self.read_active_exact_grant(attachment)?;
            match grant.bound_session_id.as_deref() {
                Some(bound) if bound != session_id => {
                    return Err(HostV2StorageError::unauthorized(
                        "user_attachment_session_mismatch",
                        "User attachment grant is already bound to a different Session",
                    ));
                }
                _ => {}
            }
            if attachment.scope == AgentInputAttachmentScopeV3::Message {
                match grant.consumed_by_caller_request_id.as_deref() {
                    Some(bound) if bound != caller_request_id => {
                        return Err(HostV2StorageError::conflict(
                            "user_attachment_message_already_consumed",
                            "Message-scoped user attachment was already consumed by another input",
                        ));
                    }
                    _ => {}
                }
            }
            requested_grants.push(grant);
        }

        let mut session_attachments = BTreeMap::<String, AgentInputAttachmentV3>::new();
        for grant in self.read_session_grants(session_id)? {
            session_attachments.insert(grant.attachment.attachment_id.clone(), grant.attachment);
        }
        for grant in &requested_grants {
            if grant.attachment.scope == AgentInputAttachmentScopeV3::Session {
                session_attachments.insert(
                    grant.attachment.attachment_id.clone(),
                    grant.attachment.clone(),
                );
            }
        }
        let mut attachments = session_attachments.into_values().collect::<Vec<_>>();
        attachments.extend(
            requested_grants
                .iter()
                .filter(|grant| grant.attachment.scope == AgentInputAttachmentScopeV3::Message)
                .map(|grant| grant.attachment.clone()),
        );
        validate_agent_input_attachments_v3(&attachments)
            .map_err(|error| HostV2StorageError::invalid(error.code, error.message))?;

        let contexts = attachments
            .iter()
            .map(|attachment| self.read_context(attachment))
            .collect::<Result<Vec<_>, HostV2StorageError>>()?;
        let total_context_bytes = contexts
            .iter()
            .flat_map(|context| context.files.iter())
            .try_fold(0_usize, |total, file| total.checked_add(file.content.len()))
            .ok_or_else(|| {
                HostV2StorageError::invalid(
                    "user_attachment_context_too_large",
                    "Combined user attachment context size overflowed",
                )
            })?;
        if total_context_bytes > MAX_ATTACHMENT_CONTEXT_BYTES_V1 {
            return Err(HostV2StorageError::invalid(
                "user_attachment_context_too_large",
                "Combined user attachments exceed the Agent context limit",
            ));
        }
        validate_user_attachment_contexts_v1(&attachments, &contexts)?;

        let mut updates = Vec::new();
        for grant in requested_grants {
            let mut updated = grant.clone();
            if updated.bound_session_id.is_none() {
                updated.bound_session_id = Some(session_id.to_string());
            }
            if updated.attachment.scope == AgentInputAttachmentScopeV3::Message
                && updated.consumed_by_caller_request_id.is_none()
            {
                updated.consumed_by_caller_request_id = Some(caller_request_id.to_string());
            }
            if updated.bound_session_id != grant.bound_session_id
                || updated.consumed_by_caller_request_id != grant.consumed_by_caller_request_id
            {
                updates.push((grant, updated));
            }
        }
        self.commit_grant_bindings(updates)?;

        Ok(UserAttachmentAdmissionV1 {
            attachments,
            contexts,
        })
    }

    pub(crate) fn validate_bound_handles(
        &self,
        session_id: &str,
        caller_request_id: &str,
        attachments: &[AgentInputAttachmentV3],
    ) -> Result<(), HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(caller_request_id, "callerRequestId", 512)?;
        validate_agent_input_attachments_v3(attachments)
            .map_err(|error| HostV2StorageError::invalid(error.code, error.message))?;
        let _guard = self.lock.lock().map_err(|_| store_unavailable())?;
        for attachment in attachments {
            let grant = self.read_active_exact_grant(attachment)?;
            if grant.bound_session_id.as_deref() != Some(session_id) {
                return Err(HostV2StorageError::unauthorized(
                    "user_attachment_session_mismatch",
                    "Durable input attachment is not bound to the active Session",
                ));
            }
            if attachment.scope == AgentInputAttachmentScopeV3::Message
                && grant.consumed_by_caller_request_id.as_deref() != Some(caller_request_id)
            {
                return Err(HostV2StorageError::conflict(
                    "user_attachment_message_consumption_mismatch",
                    "Message-scoped user attachment is not bound to this exact input",
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn revoke(
        &self,
        attachment_id: &str,
    ) -> Result<UserAttachmentGrantV1, HostV2StorageError> {
        deepcode_kernel_abi::validate_agent_attachment_id_v3(attachment_id, "attachmentId")
            .map_err(|error| HostV2StorageError::invalid(error.code, error.message))?;
        let _guard = self.lock.lock().map_err(|_| store_unavailable())?;
        let mut grant = self.read_grant(attachment_id)?;
        if grant.revoked_at.is_none() {
            grant.revoked_at = Some(crate::utils::now_rfc3339_text());
            atomic_write_private_json(
                &self.grant_path(attachment_id),
                &serde_json::to_value(&grant).map_err(|_| store_unavailable())?,
            )?;
        }
        let object = self.object_path(&grant.attachment.resource_id);
        if object.exists() {
            fs::remove_dir_all(&object).map_err(|error| {
                HostV2StorageError::io(
                    "user_attachment_revoke_failed",
                    format!("remove user attachment snapshot: {error}"),
                )
            })?;
        }
        let context = self.context_path(&grant.attachment.resource_id);
        if context.exists() {
            fs::remove_file(&context).map_err(|error| {
                HostV2StorageError::io(
                    "user_attachment_revoke_failed",
                    format!("remove user attachment context: {error}"),
                )
            })?;
        }
        Ok(grant)
    }

    fn ensure_layout(&self) -> Result<(), HostV2StorageError> {
        create_private_directory(self.root.as_ref())?;
        create_private_directory(&self.grants_dir())?;
        create_private_directory(&self.requests_dir())?;
        create_private_directory(&self.objects_dir())?;
        create_private_directory(&self.contexts_dir())?;
        Ok(())
    }

    fn read_grant(&self, attachment_id: &str) -> Result<UserAttachmentGrantV1, HostV2StorageError> {
        let value = read_required_json(&self.grant_path(attachment_id), "User attachment grant")?;
        let grant: UserAttachmentGrantV1 = serde_json::from_value(value)
            .map_err(|_| current_schema_required("User attachment grant"))?;
        if grant.schema_version != USER_ATTACHMENT_GRANT_SCHEMA_V1
            || grant.attachment.attachment_id != attachment_id
            || validate_agent_input_attachments_v3(std::slice::from_ref(&grant.attachment)).is_err()
            || validate_bounded_identity(&grant.caller_request_id, "callerRequestId", 512).is_err()
            || grant
                .bound_session_id
                .as_deref()
                .is_some_and(|session_id| validate_safe_session_identity(session_id).is_err())
            || grant
                .consumed_by_caller_request_id
                .as_deref()
                .is_some_and(|request_id| {
                    validate_bounded_identity(request_id, "callerRequestId", 512).is_err()
                })
            || (grant.attachment.scope == AgentInputAttachmentScopeV3::Session
                && grant.consumed_by_caller_request_id.is_some())
            || (grant.consumed_by_caller_request_id.is_some() && grant.bound_session_id.is_none())
        {
            return Err(current_schema_required("User attachment grant"));
        }
        Ok(grant)
    }

    fn read_active_exact_grant(
        &self,
        attachment: &AgentInputAttachmentV3,
    ) -> Result<UserAttachmentGrantV1, HostV2StorageError> {
        let grant = self.read_grant(&attachment.attachment_id)?;
        if grant.attachment != *attachment {
            return Err(HostV2StorageError::conflict(
                "user_attachment_grant_mismatch",
                "Input attachment does not match its exact Host grant",
            ));
        }
        if grant.revoked_at.is_some() || !self.object_path(&attachment.resource_id).is_dir() {
            return Err(HostV2StorageError::conflict(
                "user_attachment_grant_revoked",
                "Input attachment grant is revoked or its snapshot is unavailable",
            ));
        }
        Ok(grant)
    }

    fn read_session_grants(
        &self,
        session_id: &str,
    ) -> Result<Vec<UserAttachmentGrantV1>, HostV2StorageError> {
        let mut paths = fs::read_dir(self.grants_dir())
            .map_err(|error| {
                HostV2StorageError::io(
                    "user_attachment_store_unavailable",
                    format!("read user attachment grants: {error}"),
                )
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                HostV2StorageError::io(
                    "user_attachment_store_unavailable",
                    format!("read user attachment grant entry: {error}"),
                )
            })?;
        paths.sort_by_key(|entry| entry.file_name());
        let mut grants = Vec::new();
        for entry in paths {
            let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
                HostV2StorageError::io(
                    "user_attachment_store_unavailable",
                    format!("inspect user attachment grant entry: {error}"),
                )
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(current_schema_required("User attachment grant store"));
            }
            let value = read_required_json(&entry.path(), "User attachment grant")?;
            let grant: UserAttachmentGrantV1 = serde_json::from_value(value)
                .map_err(|_| current_schema_required("User attachment grant"))?;
            if entry.path() != self.grant_path(&grant.attachment.attachment_id) {
                return Err(current_schema_required("User attachment grant store"));
            }
            let grant = self.read_grant(&grant.attachment.attachment_id)?;
            if grant.bound_session_id.as_deref() == Some(session_id)
                && grant.attachment.scope == AgentInputAttachmentScopeV3::Session
                && grant.revoked_at.is_none()
            {
                self.read_active_exact_grant(&grant.attachment)?;
                grants.push(grant);
            }
        }
        Ok(grants)
    }

    fn read_context(
        &self,
        attachment: &AgentInputAttachmentV3,
    ) -> Result<UserAttachmentContextV1, HostV2StorageError> {
        let context: UserAttachmentContextV1 = serde_json::from_value(read_required_json(
            &self.context_path(&attachment.resource_id),
            "User attachment context",
        )?)
        .map_err(|_| current_schema_required("User attachment context"))?;
        if context.schema_version != "deepcode.host.user-attachment-context.v1"
            || context.attachment_id != attachment.attachment_id
            || context.resource_id != attachment.resource_id
            || context.display_name != attachment.display_name
            || context.kind != attachment.kind
        {
            return Err(current_schema_required("User attachment context"));
        }
        Ok(context)
    }

    fn commit_grant_bindings(
        &self,
        updates: Vec<(UserAttachmentGrantV1, UserAttachmentGrantV1)>,
    ) -> Result<(), HostV2StorageError> {
        let mut committed: Vec<UserAttachmentGrantV1> = Vec::new();
        for (original, updated) in updates {
            let path = self.grant_path(&updated.attachment.attachment_id);
            if let Err(error) = atomic_write_private_json(
                &path,
                &serde_json::to_value(&updated).map_err(|_| store_unavailable())?,
            ) {
                let mut rollback_failed = false;
                for prior in committed.iter().rev() {
                    let prior_path = self.grant_path(&prior.attachment.attachment_id);
                    rollback_failed |= atomic_write_private_json(
                        &prior_path,
                        &serde_json::to_value(prior).map_err(|_| store_unavailable())?,
                    )
                    .is_err();
                }
                if rollback_failed {
                    return Err(HostV2StorageError::io(
                        "user_attachment_binding_indeterminate",
                        "User attachment binding failed and rollback could not be confirmed",
                    ));
                }
                return Err(error);
            }
            committed.push(original);
        }
        Ok(())
    }

    fn grants_dir(&self) -> PathBuf {
        self.root.join("grants")
    }

    fn requests_dir(&self) -> PathBuf {
        self.root.join("requests")
    }

    fn objects_dir(&self) -> PathBuf {
        self.root.join("objects")
    }

    fn contexts_dir(&self) -> PathBuf {
        self.root.join("contexts")
    }

    fn grant_path(&self, attachment_id: &str) -> PathBuf {
        self.grants_dir()
            .join(format!("{}.json", stable_path_component(attachment_id)))
    }

    fn request_path(&self, caller_request_id: &str) -> PathBuf {
        self.requests_dir()
            .join(format!("{}.json", stable_path_component(caller_request_id)))
    }

    fn object_path(&self, resource_id: &str) -> PathBuf {
        self.objects_dir().join(resource_id)
    }

    fn context_path(&self, resource_id: &str) -> PathBuf {
        self.contexts_dir()
            .join(format!("{}.json", stable_path_component(resource_id)))
    }
}

fn snapshot_selected_resource(
    source: &Path,
    target: &Path,
    directory: bool,
) -> Result<UserAttachmentSnapshotV1, HostV2StorageError> {
    let mut snapshot = UserAttachmentSnapshotV1 {
        file_count: 0,
        total_bytes: 0,
    };
    if directory {
        copy_selected_tree(source, target, 0, &mut snapshot)?;
    } else {
        copy_selected_file(source, target, &mut snapshot)?;
    }
    Ok(snapshot)
}

fn build_attachment_context_v1(
    attachment: &AgentInputAttachmentV3,
    selected_root: &Path,
) -> Result<UserAttachmentContextV1, HostV2StorageError> {
    let mut files = Vec::new();
    let mut omitted = Vec::new();
    let mut total_bytes = 0_usize;
    match attachment.kind {
        AgentInputAttachmentKindV3::File => {
            let read = deepcode_kernel_tools::file_content::read_text_file_for_llm(selected_root)
                .map_err(|skip| {
                HostV2StorageError::invalid(
                    "user_attachment_content_unsupported",
                    format!(
                        "Selected file cannot be used as Agent context: {} ({})",
                        skip.message, skip.reason
                    ),
                )
            })?;
            total_bytes = read.content.len();
            files.push(UserAttachmentContextFileV1 {
                path: attachment.display_name.clone(),
                size_bytes: read.content.len(),
                content_hash: deepcode_kernel_tools::hash_bytes(read.content.as_bytes()),
                content: read.content,
            });
        }
        AgentInputAttachmentKindV3::Directory => collect_attachment_context_files(
            selected_root,
            selected_root,
            0,
            &mut total_bytes,
            &mut files,
            &mut omitted,
        )?,
    }
    if total_bytes > MAX_ATTACHMENT_CONTEXT_BYTES_V1 {
        return Err(HostV2StorageError::invalid(
            "user_attachment_context_too_large",
            "Selected attachment contains more readable text than the Agent context limit",
        ));
    }
    Ok(UserAttachmentContextV1 {
        schema_version: "deepcode.host.user-attachment-context.v1".to_string(),
        attachment_id: attachment.attachment_id.clone(),
        resource_id: attachment.resource_id.clone(),
        display_name: attachment.display_name.clone(),
        kind: attachment.kind,
        files,
        omitted,
    })
}

#[allow(clippy::too_many_arguments)]
fn collect_attachment_context_files(
    root: &Path,
    directory: &Path,
    depth: usize,
    total_bytes: &mut usize,
    files: &mut Vec<UserAttachmentContextFileV1>,
    omitted: &mut Vec<UserAttachmentContextOmissionV1>,
) -> Result<(), HostV2StorageError> {
    if depth > MAX_ATTACHMENT_DEPTH_V1 {
        return Err(HostV2StorageError::invalid(
            "user_attachment_depth_exceeded",
            "Selected directory exceeds the attachment depth limit",
        ));
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|error| {
            HostV2StorageError::io(
                "user_attachment_context_read_failed",
                format!("read attachment snapshot directory: {error}"),
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            HostV2StorageError::io(
                "user_attachment_context_read_failed",
                format!("read attachment snapshot entry: {error}"),
            )
        })?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
            HostV2StorageError::io(
                "user_attachment_context_read_failed",
                format!("inspect attachment snapshot entry: {error}"),
            )
        })?;
        if metadata.is_dir() {
            collect_attachment_context_files(
                root,
                &entry.path(),
                depth + 1,
                total_bytes,
                files,
                omitted,
            )?;
            continue;
        }
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(current_schema_required("User attachment snapshot"));
        }
        if files.len() >= MAX_ATTACHMENT_CONTEXT_FILES_V1 {
            return Err(HostV2StorageError::invalid(
                "user_attachment_context_file_limit_exceeded",
                "Selected directory contains too many readable context files",
            ));
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| current_schema_required("User attachment snapshot"))?
            .to_string_lossy()
            .replace('\\', "/");
        match deepcode_kernel_tools::file_content::read_text_file_for_llm(&entry.path()) {
            Ok(read) => {
                *total_bytes = total_bytes.checked_add(read.content.len()).ok_or_else(|| {
                    HostV2StorageError::invalid(
                        "user_attachment_context_too_large",
                        "Selected attachment context size overflowed",
                    )
                })?;
                if *total_bytes > MAX_ATTACHMENT_CONTEXT_BYTES_V1 {
                    return Err(HostV2StorageError::invalid(
                        "user_attachment_context_too_large",
                        "Selected attachment contains more readable text than the Agent context limit",
                    ));
                }
                files.push(UserAttachmentContextFileV1 {
                    path: relative,
                    size_bytes: read.content.len(),
                    content_hash: deepcode_kernel_tools::hash_bytes(read.content.as_bytes()),
                    content: read.content,
                });
            }
            Err(skip) => {
                if omitted.len() >= MAX_ATTACHMENT_OMITTED_PATHS_V1 {
                    return Err(HostV2StorageError::invalid(
                        "user_attachment_context_omission_limit_exceeded",
                        "Selected directory contains too many unsupported context files",
                    ));
                }
                omitted.push(UserAttachmentContextOmissionV1 {
                    path: relative,
                    reason: skip.reason,
                });
            }
        }
    }
    Ok(())
}

fn copy_selected_tree(
    source: &Path,
    target: &Path,
    depth: usize,
    snapshot: &mut UserAttachmentSnapshotV1,
) -> Result<(), HostV2StorageError> {
    if depth > MAX_ATTACHMENT_DEPTH_V1 {
        return Err(HostV2StorageError::invalid(
            "user_attachment_depth_exceeded",
            "Selected directory exceeds the attachment depth limit",
        ));
    }
    create_private_directory(target)?;
    let entries = fs::read_dir(source).map_err(|error| {
        HostV2StorageError::io(
            "user_attachment_snapshot_failed",
            format!("read selected directory {}: {error}", source.display()),
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            HostV2StorageError::io(
                "user_attachment_snapshot_failed",
                format!("read selected directory entry: {error}"),
            )
        })?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
            HostV2StorageError::io(
                "user_attachment_snapshot_failed",
                format!("inspect selected directory entry: {error}"),
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(HostV2StorageError::invalid(
                "user_attachment_symlink_unsupported",
                "Selected directories cannot contain symbolic links",
            ));
        }
        let name = entry.file_name();
        let child_target = target.join(name);
        if metadata.is_dir() {
            copy_selected_tree(&entry.path(), &child_target, depth + 1, snapshot)?;
        } else if metadata.is_file() {
            copy_selected_file(&entry.path(), &child_target, snapshot)?;
        } else {
            return Err(HostV2StorageError::invalid(
                "user_attachment_source_unsupported",
                "Selected directories may contain only regular files and directories",
            ));
        }
    }
    Ok(())
}

fn copy_selected_file(
    source: &Path,
    target: &Path,
    snapshot: &mut UserAttachmentSnapshotV1,
) -> Result<(), HostV2StorageError> {
    let metadata = fs::symlink_metadata(source).map_err(|error| {
        HostV2StorageError::io(
            "user_attachment_snapshot_failed",
            format!("inspect selected file {}: {error}", source.display()),
        )
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(HostV2StorageError::invalid(
            "user_attachment_source_unsupported",
            "User attachment snapshot accepts regular files only",
        ));
    }
    if metadata.len() > MAX_ATTACHMENT_FILE_BYTES_V1 {
        return Err(HostV2StorageError::invalid(
            "user_attachment_file_too_large",
            "One selected file exceeds the attachment size limit",
        ));
    }
    let next_files = snapshot
        .file_count
        .checked_add(1)
        .ok_or_else(limit_exceeded)?;
    let next_bytes = snapshot
        .total_bytes
        .checked_add(metadata.len())
        .ok_or_else(limit_exceeded)?;
    if next_files > MAX_ATTACHMENT_FILES_V1 || next_bytes > MAX_ATTACHMENT_TOTAL_BYTES_V1 {
        return Err(limit_exceeded());
    }
    if let Some(parent) = target.parent() {
        create_private_directory(parent)?;
    }
    fs::copy(source, target).map_err(|error| {
        HostV2StorageError::io(
            "user_attachment_snapshot_failed",
            format!("copy selected file {}: {error}", source.display()),
        )
    })?;
    secure_snapshot_file(target)?;
    snapshot.file_count = next_files;
    snapshot.total_bytes = next_bytes;
    Ok(())
}

#[cfg(unix)]
fn secure_snapshot_file(path: &Path) -> Result<(), HostV2StorageError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
        HostV2StorageError::io(
            "user_attachment_snapshot_permissions_failed",
            format!("secure attachment snapshot {}: {error}", path.display()),
        )
    })?;
    Ok(())
}

#[cfg(not(unix))]
fn secure_snapshot_file(_path: &Path) -> Result<(), HostV2StorageError> {
    Ok(())
}

fn random_id(prefix: &str) -> Result<String, HostV2StorageError> {
    let mut entropy = [0_u8; 24];
    getrandom::fill(&mut entropy).map_err(|_| {
        HostV2StorageError::io(
            "user_attachment_entropy_unavailable",
            "Operating-system entropy is unavailable for user attachment identity",
        )
    })?;
    let mut encoded = String::with_capacity(prefix.len() + 1 + entropy.len() * 2);
    encoded.push_str(prefix);
    encoded.push('-');
    for byte in entropy {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    Ok(encoded)
}

fn stable_path_component(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn validate_context_relative_path(path: &str) -> Result<(), HostV2StorageError> {
    if path.is_empty()
        || path.trim() != path
        || path.len() > 4096
        || path.chars().any(char::is_control)
        || path.contains('\\')
        || path.starts_with('/')
        || path
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(current_schema_required("User attachment context path"));
    }
    Ok(())
}

fn current_schema_required(subject: &str) -> HostV2StorageError {
    HostV2StorageError::conflict(
        "user_attachment_schema_unsupported",
        format!("{subject} does not use the current schema"),
    )
}

fn read_required_json(path: &Path, subject: &str) -> Result<serde_json::Value, HostV2StorageError> {
    read_json(path)?.ok_or_else(|| {
        HostV2StorageError::not_found(
            "user_attachment_record_unavailable",
            format!("{subject} is unavailable"),
        )
    })
}

fn limit_exceeded() -> HostV2StorageError {
    HostV2StorageError::invalid(
        "user_attachment_snapshot_limit_exceeded",
        "Selected attachment exceeds the bounded file-count or total-size limit",
    )
}

fn store_unavailable() -> HostV2StorageError {
    HostV2StorageError::io(
        "user_attachment_store_unavailable",
        "User attachment store is unavailable",
    )
}
