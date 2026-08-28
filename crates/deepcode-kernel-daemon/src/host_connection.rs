use axum::http::{HeaderMap, Method};
use deepcode_kernel_abi::is_valid_host_shell_token;
pub(crate) use deepcode_kernel_abi::{HOST_SHELL_TOKEN_ENV, HOST_SHELL_TOKEN_HEADER};
use sha2::{Digest, Sha256};
use std::fmt;
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct HostConnection {
    token_digest: Arc<[u8; 32]>,
}

impl fmt::Debug for HostConnection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HostConnection([REDACTED])")
    }
}

impl HostConnection {
    pub(crate) fn from_environment() -> Result<Self, &'static str> {
        let token = std::env::var(HOST_SHELL_TOKEN_ENV)
            .map_err(|_| "Host shell connection token is not configured")?;
        if !is_valid_host_shell_token(&token) {
            return Err("Host shell connection token must contain 256 bits of entropy");
        }
        Ok(Self {
            token_digest: Arc::new(Sha256::digest(token.as_bytes()).into()),
        })
    }

    pub(crate) fn authorize(&self, headers: &HeaderMap) -> bool {
        let Some(submitted) = headers
            .get(HOST_SHELL_TOKEN_HEADER)
            .and_then(|value| value.to_str().ok())
        else {
            return false;
        };
        let submitted_digest: [u8; 32] = Sha256::digest(submitted.as_bytes()).into();
        constant_time_eq(self.token_digest.as_ref(), &submitted_digest)
    }
}

pub(crate) fn route_uses_specialized_transport(method: &Method, path: &str) -> bool {
    if method == Method::OPTIONS || path == "/api/host/identity" {
        return true;
    }
    path.starts_with("/api/local-agent/")
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
