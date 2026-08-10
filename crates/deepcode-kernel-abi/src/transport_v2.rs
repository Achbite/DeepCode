use crate::v2::CommandRequestId;
use serde::{Deserialize, Serialize};

pub const KERNEL_V2_HTTP_ERROR_FORMAT: &str = "deepcode.kernel.http-error.v2";
pub const KERNEL_V2_IPC_ERROR_FORMAT: &str = "deepcode.kernel.ipc-error.v2";
pub const HOST_SHELL_CAPABILITY_ENV_V2: &str = "DEEPCODE_HOST_SHELL_CAPABILITY_V2";
pub const HOST_UI_CAPABILITY_ENV_V2: &str = "DEEPCODE_HOST_UI_CAPABILITY_V2";
pub const HOST_INSTANCE_ID_ENV_V2: &str = "DEEPCODE_HOST_INSTANCE_ID_V2";
pub const HOST_SHELL_CAPABILITY_HEADER_V2: &str = "x-deepcode-host-shell-capability";
pub const HOST_UI_CAPABILITY_HEADER_V2: &str = "x-deepcode-host-ui-capability";
pub const HOST_SHELL_CAPABILITY_PREFIX_V2: &str = "dchostv2_";
pub const HOST_UI_CAPABILITY_PREFIX_V2: &str = "dchostuiv2_";
pub const HOST_INSTANCE_ID_PREFIX_V2: &str = "dcinstancev2_";
pub const HOST_AUTHORITY_ENTROPY_BYTES_V2: usize = 32;
pub const HOST_KERNEL_DAEMON_SERVICE_V2: &str = "deepcode-kernel-daemon";
pub const HOST_SHUTDOWN_OWNER_HOST_SHELL_V2: &str = "hostShell";
pub const HOST_SHUTDOWN_IDENTITY_CONFLICT_V2: &str = "host_shutdown_identity_conflict";

pub fn is_valid_host_shell_capability_v2(value: &str) -> bool {
    is_valid_host_authority_value_v2(value, HOST_SHELL_CAPABILITY_PREFIX_V2)
}

pub fn is_valid_host_ui_capability_v2(value: &str) -> bool {
    is_valid_host_authority_value_v2(value, HOST_UI_CAPABILITY_PREFIX_V2)
}

pub fn is_valid_host_instance_id_v2(value: &str) -> bool {
    is_valid_host_authority_value_v2(value, HOST_INSTANCE_ID_PREFIX_V2)
}

fn is_valid_host_authority_value_v2(value: &str, prefix: &str) -> bool {
    let Some(encoded) = value.strip_prefix(prefix) else {
        return false;
    };
    encoded.len() == HOST_AUTHORITY_ENTROPY_BYTES_V2 * 2
        && encoded
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostProcessIdentityV2 {
    pub service: String,
    pub instance_id: String,
    pub pid: u32,
    pub address: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostShutdownRequestV2 {
    pub expected_identity: HostProcessIdentityV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostShutdownReceiptV2 {
    pub accepted: bool,
    pub owner: String,
    pub identity: HostProcessIdentityV2,
    pub cleanup_complete: bool,
}

impl HostShutdownReceiptV2 {
    pub fn confirms_shutdown_of(&self, expected_identity: &HostProcessIdentityV2) -> bool {
        self.accepted
            && self.owner == HOST_SHUTDOWN_OWNER_HOST_SHELL_V2
            && self.cleanup_complete
            && &self.identity == expected_identity
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KernelV2HttpErrorCode {
    PayloadTooLarge,
    InvalidJson,
    DuplicateJsonKey,
    MissingAbiVersion,
    InvalidAbiVersion,
    UnsupportedAbiVersion,
    InvalidPayload,
    HostAuthorityRequired,
    RunCapabilityRequired,
    RunCapabilityInvalid,
    DecisionCapabilityRequired,
    DecisionCapabilityInvalid,
    DecisionCapabilityExpired,
    DecisionCapabilityBindingMismatch,
    DecisionCapabilityRequestConflict,
    DecisionCapabilityInUse,
    ResponseTooLarge,
    ServiceUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelV2HttpErrorEnvelope {
    pub format: String,
    pub code: KernelV2HttpErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<CommandRequestId>,
}

impl KernelV2HttpErrorEnvelope {
    pub fn new(code: KernelV2HttpErrorCode, request_id: Option<CommandRequestId>) -> Self {
        Self {
            format: KERNEL_V2_HTTP_ERROR_FORMAT.to_owned(),
            code,
            request_id,
        }
    }

    pub fn has_supported_format(&self) -> bool {
        self.format == KERNEL_V2_HTTP_ERROR_FORMAT
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelV2IpcErrorEnvelope {
    pub format: String,
    pub code: KernelV2HttpErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<CommandRequestId>,
}

impl KernelV2IpcErrorEnvelope {
    pub fn new(code: KernelV2HttpErrorCode, request_id: Option<CommandRequestId>) -> Self {
        Self {
            format: KERNEL_V2_IPC_ERROR_FORMAT.to_owned(),
            code,
            request_id,
        }
    }

    pub fn has_supported_format(&self) -> bool {
        self.format == KERNEL_V2_IPC_ERROR_FORMAT
    }
}
