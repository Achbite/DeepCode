//! Bounded HTTP exchange for synchronous Host startup and shutdown requests.
use serde::de::DeserializeOwned;
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub fn request_loopback_json<T: DeserializeOwned>(
    host: &str,
    port: &str,
    request: &str,
    read_timeout_millis: u64,
) -> io::Result<T> {
    let port = port
        .parse::<u16>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let mut last_error = io::Error::new(
        io::ErrorKind::AddrNotAvailable,
        "Host address did not resolve",
    );
    let mut connected = None;
    for address in (host, port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&address, Duration::from_millis(180)) {
            Ok(stream) => {
                connected = Some(stream);
                break;
            }
            Err(error) => last_error = error,
        }
    }
    let mut stream = connected.ok_or(last_error)?;
    stream.set_read_timeout(Some(Duration::from_millis(read_timeout_millis)))?;
    stream.set_write_timeout(Some(Duration::from_millis(300)))?;
    stream.write_all(request.as_bytes())?;
    let mut response = Vec::with_capacity(4096);
    stream.take(64 * 1024 + 1).read_to_end(&mut response)?;
    if response.len() > 64 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Host HTTP response exceeds 64 KiB",
        ));
    }
    let body_offset = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Host HTTP response has no header terminator",
            )
        })?
        + 4;
    if !response.starts_with(b"HTTP/1.1 200 ") {
        let status_end = response
            .windows(2)
            .position(|window| window == b"\r\n")
            .unwrap_or(body_offset - 4);
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Host HTTP request failed: {}",
                String::from_utf8_lossy(&response[..status_end])
            ),
        ));
    }
    serde_json::from_slice(&response[body_offset..])
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn shared_exchange_preserves_json_status_and_decode_failures() {
        for (response, expected) in [
            (
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"ok\":true}",
                None,
            ),
            (
                "HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n{}",
                Some("503 Unavailable"),
            ),
            ("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{", Some("EOF")),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port().to_string();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                stream.write_all(response.as_bytes()).unwrap();
            });
            let result = request_loopback_json::<serde_json::Value>(
                "127.0.0.1",
                &port,
                "GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
                2000,
            );
            server.join().unwrap();
            match expected {
                Some(message) => assert!(result.unwrap_err().to_string().contains(message)),
                None => assert_eq!(result.unwrap(), serde_json::json!({"ok": true})),
            }
        }
    }
}
