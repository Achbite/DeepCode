use deepcode_kernel_abi::{KernelError, KernelResult};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewedHttpTarget {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) selected_address: SocketAddr,
    pub(crate) resolved_addresses: Vec<SocketAddr>,
    pub(crate) private: bool,
}

pub(crate) fn review_http_target(url: &str) -> KernelResult<ReviewedHttpTarget> {
    let parsed = validate_http_url_shape(url)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| KernelError::InvalidCommand("HTTP URL requires a host".to_string()))?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    reject_metadata_hostname(&host)?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| KernelError::InvalidCommand("HTTP URL requires a port".to_string()))?;
    let addresses = resolve_addresses(&host, port)?;
    if addresses
        .iter()
        .any(|address| is_metadata_address(address.ip()))
    {
        return Err(KernelError::PermissionDenied(
            "network tools reject cloud metadata endpoints".to_string(),
        ));
    }
    let private = addresses
        .iter()
        .any(|address| is_private_address(address.ip()));
    Ok(ReviewedHttpTarget {
        host,
        port,
        selected_address: addresses[0],
        resolved_addresses: addresses,
        private,
    })
}

pub(crate) fn verify_http_target(url: &str, reviewed: &ReviewedHttpTarget) -> KernelResult<()> {
    let current = review_http_target(url)?;
    if current.host != reviewed.host
        || current.port != reviewed.port
        || current.resolved_addresses != reviewed.resolved_addresses
        || current.private != reviewed.private
    {
        return Err(KernelError::PermissionDenied(
            "HTTP target DNS resolution changed after Kernel review".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_http_url_shape(url: &str) -> KernelResult<reqwest::Url> {
    let url = url.trim();
    if url.is_empty() {
        return Err(KernelError::InvalidCommand("url is required".to_string()));
    }
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| KernelError::InvalidCommand(format!("invalid HTTP URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(KernelError::PermissionDenied(
            "network tools only accept http/https URLs".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(KernelError::PermissionDenied(
            "network tools reject credential-bearing URLs".to_string(),
        ));
    }
    Ok(parsed)
}

fn resolve_addresses(host: &str, port: u16) -> KernelResult<Vec<SocketAddr>> {
    let mut addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| KernelError::Other(format!("resolve HTTP target {host}: {error}")))?
        .collect::<Vec<_>>();
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err(KernelError::Other(format!(
            "HTTP target {host} did not resolve to an address"
        )));
    }
    Ok(addresses)
}

fn reject_metadata_hostname(host: &str) -> KernelResult<()> {
    if matches!(host, "metadata" | "metadata.google.internal") {
        return Err(KernelError::PermissionDenied(
            "network tools reject cloud metadata endpoints".to_string(),
        ));
    }
    Ok(())
}

fn is_metadata_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address == Ipv4Addr::new(169, 254, 169, 254)
                || address == Ipv4Addr::new(100, 100, 100, 200)
        }
        IpAddr::V6(address) => {
            address
                == "fe80::a9fe:a9fe"
                    .parse::<Ipv6Addr>()
                    .expect("valid metadata IPv6")
        }
    }
}

fn is_private_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_unspecified()
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.is_unique_local()
                || address.is_unicast_link_local()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_credentials_and_metadata_addresses() {
        assert!(review_http_target("https://user:secret@example.com/").is_err());
        assert!(review_http_target("http://169.254.169.254/latest").is_err());
        assert!(review_http_target("http://100.100.100.200/latest").is_err());
    }

    #[test]
    fn classifies_loopback_as_private() {
        let target = review_http_target("http://127.0.0.1:8080/").unwrap();
        assert!(target.private);
        assert_eq!(target.selected_address, "127.0.0.1:8080".parse().unwrap());
    }
}
