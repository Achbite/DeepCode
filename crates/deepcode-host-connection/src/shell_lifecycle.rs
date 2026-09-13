//! Shared shell ownership: private proxy, startup rollback and a live Host client lease.
use crate::process::{terminate_owned_process_tree, wait_for_child_exit, OwnedHostProcess};
use crate::{HostClientLease, HostStartGuard};
use deepcode_kernel_abi::{
    HostProcessIdentity, HostShutdownReceipt, HostShutdownRequest, HOST_SHELL_TOKEN_HEADER,
    HOST_SHUTDOWN_RECEIPT_TIMEOUT_MILLIS,
};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Deserialize)]
struct HostApiEnvelope<T> {
    ok: bool,
    data: Option<T>,
}

pub struct OwnedHostChildren {
    pub daemon: Option<OwnedHostProcess>,
    pub start_guard: Option<HostStartGuard>,
    pub proxy: OwnedHostProcess,
    pub daemon_host: String,
    pub daemon_port: String,
    pub daemon_token: String,
    pub daemon_identity: HostProcessIdentity,
    pub client_lease: Option<HostClientLease>,
}

impl OwnedHostChildren {
    pub fn attach_client(&mut self) -> io::Result<()> {
        self.client_lease = Some(HostClientLease::connect(
            &self.daemon_identity.address,
            &self.daemon_token,
            false,
        )?);
        #[cfg(windows)]
        if let Some(daemon) = self.daemon.as_ref() {
            daemon.job.release_on_close()?;
        }
        Ok(())
    }
    pub fn share_ready_daemon(&mut self) {
        // The Host now owns its lifetime; the shell retains its connection lease.
        drop(self.daemon.take());
        drop(self.start_guard.take());
    }
    pub fn shutdown(&mut self) {
        terminate_owned_process_tree(&mut self.proxy);
        shutdown_daemon_process(
            &mut self.daemon,
            &self.daemon_host,
            &self.daemon_port,
            &self.daemon_token,
            &self.daemon_identity,
        );
        drop(self.client_lease.take());
    }
}

pub fn request_daemon_shutdown(
    host: &str,
    port: &str,
    token: &str,
    expected_identity: &HostProcessIdentity,
) -> bool {
    let Ok(body) = serde_json::to_string(&HostShutdownRequest {
        expected_identity: expected_identity.clone(),
    }) else {
        return false;
    };
    let request = http_request_with_json_body(
        host,
        port,
        "POST",
        "/api/host/shutdown",
        &[(HOST_SHELL_TOKEN_HEADER, token)],
        &body,
    );
    let Some(envelope) = request_loopback_json::<HostApiEnvelope<HostShutdownReceipt>>(
        host,
        port,
        &request,
        HOST_SHUTDOWN_RECEIPT_TIMEOUT_MILLIS,
    ) else {
        return false;
    };
    let Some(receipt) = envelope.ok.then_some(envelope.data).flatten() else {
        return false;
    };
    receipt.confirms_shutdown_of(expected_identity)
}

pub fn shutdown_daemon_process(
    process: &mut Option<OwnedHostProcess>,
    host: &str,
    port: &str,
    token: &str,
    expected_identity: &HostProcessIdentity,
) {
    let Some(process) = process.as_mut() else {
        return;
    };
    if !request_daemon_shutdown(host, port, token, expected_identity)
        || !wait_for_child_exit(process, 80)
    {
        terminate_owned_process_tree(process);
    }
}

fn http_request_with_json_body(
    host: &str,
    port: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> String {
    let token = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {token}\r\n");
    for (name, value) in headers {
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str("Content-Type: application/json\r\n");
    request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    request.push_str("Connection: close\r\n\r\n");
    request.push_str(body);
    request
}

fn request_loopback_json<T: DeserializeOwned>(
    host: &str,
    port: &str,
    request: &str,
    read_timeout_millis: u64,
) -> Option<T> {
    let port_number = port.parse::<u16>().ok()?;
    let addrs = (host, port_number).to_socket_addrs().ok()?;
    addrs.into_iter().find_map(|addr| {
        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(180)).ok()?;
        stream
            .set_read_timeout(Some(Duration::from_millis(read_timeout_millis)))
            .ok()?;
        stream
            .set_write_timeout(Some(Duration::from_millis(300)))
            .ok()?;
        stream.write_all(request.as_bytes()).ok()?;
        let mut response = Vec::with_capacity(4096);
        stream.take(64 * 1024).read_to_end(&mut response).ok()?;
        if !response.starts_with(b"HTTP/1.1 200") {
            return None;
        }
        let body_offset = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|offset| offset + 4)?;
        serde_json::from_slice(&response[body_offset..]).ok()
    })
}
