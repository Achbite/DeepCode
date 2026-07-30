use axum::http::{HeaderMap, Method};
use deepcode_kernel_abi::is_valid_host_shell_capability_v2;
pub(crate) use deepcode_kernel_abi::{
    HOST_SHELL_CAPABILITY_ENV_V2, HOST_SHELL_CAPABILITY_HEADER_V2,
};
use sha2::{Digest, Sha256};
use std::fmt;
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct HostShellAuthorityV2 {
    capability_digest: Arc<[u8; 32]>,
}

impl fmt::Debug for HostShellAuthorityV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HostShellAuthorityV2([REDACTED])")
    }
}

impl HostShellAuthorityV2 {
    pub(crate) fn from_environment() -> Result<Self, &'static str> {
        let capability = std::env::var(HOST_SHELL_CAPABILITY_ENV_V2)
            .map_err(|_| "Host shell capability is not configured")?;
        if !is_valid_host_shell_capability_v2(&capability) {
            return Err("Host shell capability must use the v2 format with 256 bits of entropy");
        }
        Ok(Self {
            capability_digest: Arc::new(Sha256::digest(capability.as_bytes()).into()),
        })
    }

    pub(crate) fn authorize(&self, headers: &HeaderMap) -> bool {
        let Some(submitted) = headers
            .get(HOST_SHELL_CAPABILITY_HEADER_V2)
            .and_then(|value| value.to_str().ok())
        else {
            return false;
        };
        let submitted_digest: [u8; 32] = Sha256::digest(submitted.as_bytes()).into();
        constant_time_eq(self.capability_digest.as_ref(), &submitted_digest)
    }
}

pub(crate) fn route_uses_specialized_transport(method: &Method, path: &str) -> bool {
    if method == Method::OPTIONS || path == "/api/host/identity" {
        return true;
    }
    if matches!(
        path,
        "/api/kernel/v2/commands" | "/api/kernel/v2/user-decisions" | "/api/llm/chat"
    ) {
        return true;
    }
    if path.starts_with("/api/session-store/") && path.contains("/kernel-v2/") {
        return true;
    }
    path.starts_with("/api/agent/sessions/")
        && (path.ends_with("/kernel-v2/projections") || path.ends_with("/kernel-v2/prior-events"))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let maximum = left.len().max(right.len());
    for index in 0..maximum {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}
