use neartrip::{registry::Registry, server::serve_with_hub, tls::ReloadingAcceptor, Config};
use rustls::pki_types::{ServerName, UnixTime};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    ClientConfig, DigitallySignedStruct, Error as TlsError, SignatureScheme,
};
use std::sync::Arc;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    time::timeout,
};
use tokio_rustls::TlsConnector;

fn write_self_signed(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec!["localhost".into()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");
    std::fs::write(&cert_path, cert.pem()).unwrap();
    std::fs::write(&key_path, key.serialize_pem()).unwrap();
    (cert_path, key_path)
}

#[derive(Debug)]
struct NoVerifier;

impl ServerCertVerifier for NoVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

async fn read_header(stream: &mut (impl AsyncReadExt + Unpin)) -> String {
    let mut response = Vec::new();
    while !response.windows(4).any(|w| w == b"\r\n\r\n") {
        let byte = timeout(Duration::from_secs(2), stream.read_u8())
            .await
            .unwrap()
            .unwrap();
        response.push(byte);
    }
    String::from_utf8(response).unwrap()
}

#[tokio::test]
async fn tls_source_publisher_and_plain_port_both_work() {
    let dir = std::env::temp_dir().join(format!("neartrip-tls-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let (cert_path, key_path) = write_self_signed(&dir);

    let config = Config::parse(&format!(
        r#"{{"username":"r","password":"p","sources":[{{"mountPoint":"BASE","username":"b","password":"s","settlingSeconds":0}}],"tls":{{"port":1,"certFile":"{}","keyFile":"{}"}}}}"#,
        cert_path.display(),
        key_path.display()
    ))
    .unwrap();
    let (_cfg, configs) = watch::channel(config);
    let (stop, shutdown) = watch::channel(false);
    let plain = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tls_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let plain_addr = plain.local_addr().unwrap();
    let tls_addr = tls_listener.local_addr().unwrap();
    let acceptor = Arc::new(ReloadingAcceptor::load(&cert_path, &key_path).unwrap());
    let path = dir.join("sessions.json");
    let registry = Arc::new(Registry::new(&path));
    let hub = Arc::new(neartrip::caster::Hub::default());
    let task = tokio::spawn(serve_with_hub(
        plain,
        Some((tls_listener, acceptor)),
        configs,
        registry,
        shutdown,
        hub,
    ));

    // Plain SOURCE still works on the original listener.
    let mut plain_source = TcpStream::connect(plain_addr).await.unwrap();
    plain_source
        .write_all(b"SOURCE s /BASE\r\nSource-Agent: test\r\n\r\n")
        .await
        .unwrap();
    let plain_response = read_header(&mut plain_source).await;
    assert!(plain_response.contains("200"), "{plain_response}");
    drop(plain_source);
    tokio::time::sleep(Duration::from_millis(50)).await;

    // TLS SOURCE on the NTRIPS listener.
    let tcp = TcpStream::connect(tls_addr).await.unwrap();
    let connector = TlsConnector::from(Arc::new(
        ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerifier))
            .with_no_client_auth(),
    ));
    let name = ServerName::try_from("localhost").unwrap();
    let mut tls = connector.connect(name, tcp).await.unwrap();
    tls.write_all(b"SOURCE s /BASE\r\nSource-Agent: test\r\n\r\n")
        .await
        .unwrap();
    let tls_response = read_header(&mut tls).await;
    assert!(tls_response.contains("200"), "{tls_response}");
    tls.write_all(b"\xd3\x00\x03abc").await.unwrap();

    stop.send(true).unwrap();
    task.await.unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}
