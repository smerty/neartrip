//! Dial one NTRIP caster and separate its response header from the RTCM body.
use std::time::Duration;

use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::config::Station;

const HEADER_LIMIT: usize = 8192;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct CasterLink {
    pub stream: TcpStream,
    pub pending: Vec<u8>,
}

pub async fn connect(station: &Station, user_agent: &str) -> Result<CasterLink, String> {
    if !header_safe(&station.mount_point)
        || !header_safe(&station.caster_host)
        || !header_safe(&station.username)
        || !header_safe(&station.password)
        || !header_safe(user_agent)
    {
        return Err("station fields contain a header break".into());
    }
    let connect = TcpStream::connect((station.caster_host.as_str(), station.caster_port));
    let mut stream = tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| "caster connect timed out".to_string())?
        .map_err(|err| err.to_string())?;
    let _ = stream.set_nodelay(true);
    let auth = base64::engine::general_purpose::STANDARD
        .encode(format!("{}:{}", station.username, station.password));
    let request = format!(
        "GET /{mount} HTTP/1.1\r\nHost: {host}:{port}\r\nNtrip-Version: Ntrip/2.0\r\nUser-Agent: {agent}\r\nConnection: keep-alive\r\nAuthorization: Basic {auth}\r\n\r\n",
        mount = station.mount_point,
        host = station.caster_host,
        port = station.caster_port,
        agent = user_agent,
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|err| err.to_string())?;

    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    let pending = loop {
        if buf.len() > HEADER_LIMIT {
            return Err("caster response header is too large".into());
        }
        let read = stream.read(&mut tmp);
        let n = tokio::time::timeout(CONNECT_TIMEOUT, read)
            .await
            .map_err(|_| "caster response timed out".to_string())?
            .map_err(|err| err.to_string())?;
        if n == 0 {
            return Err("caster closed before a response".into());
        }
        buf.extend_from_slice(&tmp[..n]);
        match split_caster_header(&buf) {
            None => continue,
            Some(Err(())) => return Err("caster rejected the mountpoint".into()),
            Some(Ok(body_at)) => break buf.split_off(body_at),
        }
    };
    Ok(CasterLink { stream, pending })
}

fn header_safe(value: &str) -> bool {
    !value.chars().any(|c| c == '\r' || c == '\n' || c == '\0')
}

/// `Ok(body_index)` when the status is 200. `Err` when the header block is complete and not 200.
pub fn split_caster_header(buf: &[u8]) -> Option<Result<usize, ()>> {
    if let Some(index) = find_subsequence(buf, b"\r\n\r\n") {
        let ok = status_ok(&buf[..index]);
        return Some(if ok { Ok(index + 4) } else { Err(()) });
    }
    const ICY: &[u8] = b"ICY 200 OK\r\n";
    if let Some(rest) = buf.strip_prefix(ICY) {
        if rest.is_empty() || rest[0].is_ascii_alphabetic() {
            return None;
        }
        return Some(Ok(ICY.len()));
    }
    if buf.len() > HEADER_LIMIT {
        return Some(Err(()));
    }
    None
}

fn status_ok(header: &[u8]) -> bool {
    let line_end = find_subsequence(header, b"\r\n").unwrap_or(header.len());
    let line = &header[..line_end];
    line.windows(3).any(|w| w == b"200")
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_an_http_200_header() {
        let raw = b"HTTP/1.1 200 OK\r\n\r\nRTCM";
        assert_eq!(split_caster_header(raw), Some(Ok(19)));
    }

    #[test]
    fn splits_icy_when_the_body_follows_the_status_line() {
        let raw = b"ICY 200 OK\r\n\xD3\x00";
        assert_eq!(split_caster_header(raw), Some(Ok(12)));
    }

    #[test]
    fn waits_for_the_rest_of_an_icy_header_block() {
        assert_eq!(split_caster_header(b"ICY 200 OK\r\n"), None);
        assert_eq!(split_caster_header(b"ICY 200 OK\r\nNtrip-Flags: \r\n"), None);
    }

    #[test]
    fn rejects_a_401_response() {
        let raw = b"HTTP/1.0 401 Unauthorized\r\n\r\n";
        assert_eq!(split_caster_header(raw), Some(Err(())));
    }
}
