//! A shell owns this connection; the Host owns the resulting client lifetime.
use deepcode_kernel_abi::{is_valid_host_shell_token, HOST_SHELL_TOKEN_HEADER};
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

pub const HOST_LIFETIME_ENV: &str = "DEEPCODE_HOST_LIFETIME";

pub struct HostClientLease {
    stream: TcpStream,
}

impl HostClientLease {
    pub fn connect(base_url: &str, token: &str, persistent: bool) -> io::Result<Self> {
        if !is_valid_host_shell_token(token) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid Host shell token",
            ));
        }
        let authority = base_url.strip_prefix("http://").ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Host must use local HTTP")
        })?;
        let address: SocketAddr = authority
            .to_socket_addrs()?
            .next()
            .filter(|address| address.ip().is_loopback())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Host must use loopback"))?;
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.set_write_timeout(Some(Duration::from_secs(3)))?;
        let mode = if persistent { "persistent" } else { "client" };
        write!(stream, "GET /api/host/client?mode={mode} HTTP/1.1\r\nHost: {authority}\r\n{HOST_SHELL_TOKEN_HEADER}: {token}\r\nConnection: keep-alive\r\n\r\n")?;
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte)?;
            header.push(byte[0]);
            if header.len() > 16 * 1024 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Host client response header too large",
                ));
            }
        }
        if !header.starts_with(b"HTTP/1.1 200 ") {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                "Host rejected client lifetime registration",
            ));
        }
        stream.set_read_timeout(None)?;
        Ok(Self { stream })
    }
}

impl Drop for HostClientLease {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}
