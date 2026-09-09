use std::{collections::HashMap, sync::Arc};

use anyhow::{Context, Result, anyhow};
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayConfig, RelayMap, RelayMode, RelayUrl, SecretKey,
    endpoint::{ConnectingError, ConnectionError, presets},
};
use serde::{Serialize, de::DeserializeOwned};
use tokio::sync::{Mutex, mpsc};

use crate::protocol::{ClientMessage, HostMessage, JOI_REMOTE_ALPN, TransportTicket};

const MAX_FRAME_BYTES: usize = 256 * 1024;

// Inspect typed sources only. Never format errors: peer close reasons can contain
// arbitrary bytes, and local errors may include addresses or private paths.
pub(crate) fn network_error_code(error: &(dyn std::error::Error + 'static)) -> &'static str {
    let mut current = Some(error);
    for _ in 0..16 {
        let Some(error) = current else { break };
        if let Some(error) = error.downcast_ref::<ConnectionError>() {
            return match error {
                ConnectionError::TimedOut => "quicTimedOut",
                ConnectionError::Reset => "quicReset",
                ConnectionError::LocallyClosed => "quicLocallyClosed",
                ConnectionError::VersionMismatch => "quicVersionMismatch",
                ConnectionError::CidsExhausted => "quicCidsExhausted",
                ConnectionError::ApplicationClosed(_) => "quicPeerApplicationClosed",
                ConnectionError::ConnectionClosed(close) => {
                    transport_error_code(u64::from(close.error_code), true)
                }
                ConnectionError::TransportError(error) => {
                    transport_error_code(u64::from(error.code), false)
                }
            };
        }
        if let Some(error) = error.downcast_ref::<ConnectingError>() {
            match error {
                ConnectingError::HandshakeFailure { .. } => return "quicAuthenticationFailed",
                ConnectingError::LocallyRejected { .. } => return "quicLocallyRejected",
                _ => {}
            }
        }
        current = error.source();
    }
    "quicUnknownError"
}

fn transport_error_code(code: u64, peer: bool) -> &'static str {
    match code {
        0x178 => "quicTlsNoApplicationProtocol",
        0x128 => "quicTlsHandshakeFailure",
        0x146 => "quicTlsProtocolVersion",
        0x12a..=0x12e | 0x130 | 0x174 => "quicTlsCertificateRejected",
        0x100..=0x1ff => "quicTlsAlert",
        _ if peer => "quicPeerTransportClosed",
        _ => "quicTransportError",
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HostRequest {
    pub device_id: String,
    pub kind: String,
    pub payload: serde_json::Value,
    pub request_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct HostTransportOptions {
    pub relay_authentication: Option<String>,
    pub relay_url: Option<String>,
    pub secret_key: Option<[u8; 32]>,
}

pub struct RemoteHostTransport {
    endpoint: Endpoint,
    configured_relay: Option<RelayUrl>,
    peers: Arc<Mutex<HashMap<String, mpsc::Sender<HostMessage>>>>,
    requests: Mutex<mpsc::Receiver<HostRequest>>,
    diagnostics: Mutex<mpsc::Receiver<&'static str>>,
}

impl RemoteHostTransport {
    pub async fn bind() -> Result<Self> {
        Self::bind_with(HostTransportOptions::default()).await
    }

    pub async fn bind_with(options: HostTransportOptions) -> Result<Self> {
        let mut builder = Endpoint::builder(presets::Minimal).alpns(vec![JOI_REMOTE_ALPN.to_vec()]);
        if let Some(secret_key) = options.secret_key {
            builder = builder.secret_key(SecretKey::from_bytes(&secret_key));
        }
        let configured_relay = options
            .relay_url
            .as_deref()
            .map(str::parse::<RelayUrl>)
            .transpose()
            .context("parse Joi relay URL")?;
        if let Some(relay_url) = configured_relay.clone() {
            let mut relay = RelayConfig::new(relay_url, None);
            if let Some(authentication) = options
                .relay_authentication
                .filter(|value| !value.is_empty())
            {
                relay = relay.with_auth_token(authentication);
            }
            builder = builder.relay_mode(RelayMode::Custom(RelayMap::from(relay)));
        }
        let endpoint = builder.bind().await.context("bind Joi host endpoint")?;
        let peers = Arc::new(Mutex::new(HashMap::new()));
        let (request_tx, request_rx) = mpsc::channel(64);
        let (diagnostic_tx, diagnostic_rx) = mpsc::channel(64);
        spawn_accept_loop(endpoint.clone(), peers.clone(), request_tx, diagnostic_tx);
        Ok(Self {
            endpoint,
            configured_relay,
            peers,
            requests: Mutex::new(request_rx),
            diagnostics: Mutex::new(diagnostic_rx),
        })
    }

    pub fn address(&self) -> EndpointAddr {
        // bind() precedes relay registration. The first ticket must retain the
        // configured route even while offline; this is not an online indicator.
        let address = self.endpoint.addr();
        match &self.configured_relay {
            Some(relay) => address.with_relay_url(relay.clone()),
            None => address,
        }
    }

    pub fn ticket(&self) -> TransportTicket {
        ticket_from_address(&self.address())
    }

    pub async fn next_request(&self) -> Option<HostRequest> {
        self.requests.lock().await.recv().await
    }

    pub async fn next_diagnostic(&self) -> Option<&'static str> {
        self.diagnostics.lock().await.recv().await
    }

    pub async fn send_to(&self, device_id: &str, message: HostMessage) -> Result<()> {
        let sender = self
            .peers
            .lock()
            .await
            .get(device_id)
            .cloned()
            .ok_or_else(|| anyhow!("device is not connected"))?;
        sender.send(message).await.context("send host message")
    }

    pub async fn disconnect(&self, device_id: &str) {
        self.peers.lock().await.remove(device_id);
    }

    pub async fn close(self) {
        self.endpoint.close().await;
    }
}

pub struct RemoteControllerTransport {
    connection: iroh::endpoint::Connection,
    _endpoint: Endpoint,
    recv: iroh::endpoint::RecvStream,
    reader: FrameReader,
    send: iroh::endpoint::SendStream,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteConnectionPath {
    Direct,
    Relay,
    Mixed,
}

impl RemoteControllerTransport {
    pub async fn send(&mut self, message: ClientMessage) -> Result<()> {
        write_frame(&mut self.send, &message).await
    }

    pub async fn recv(&mut self) -> Result<HostMessage> {
        self.reader.read(&mut self.recv).await
    }

    pub fn path(&self) -> RemoteConnectionPath {
        let paths = self.connection.paths();
        if let Some(path) = paths.iter().find(|path| path.is_selected()) {
            return if path.is_ip() {
                RemoteConnectionPath::Direct
            } else if path.is_relay() {
                RemoteConnectionPath::Relay
            } else {
                RemoteConnectionPath::Mixed
            };
        }
        let has_direct = paths.iter().any(|path| path.is_ip());
        let has_relay = paths.iter().any(|path| path.is_relay());
        match (has_direct, has_relay) {
            (true, false) => RemoteConnectionPath::Direct,
            (false, true) => RemoteConnectionPath::Relay,
            _ => RemoteConnectionPath::Mixed,
        }
    }

    pub async fn close(self) {
        self.connection.close(0u32.into(), b"controller closed");
    }
}

pub async fn connect(
    address: EndpointAddr,
    connection_id: &str,
) -> Result<RemoteControllerTransport> {
    ControllerConnector::default()
        .connect(address, connection_id, |_| {})
        .await
}

// Owned by the FFI runtime, not by individual Dart attempts. One cached relay
// configuration bounds idle resources; active connections retain their own clone.
#[derive(Default)]
pub(crate) struct ControllerConnector {
    cached: Mutex<Option<(Vec<RelayUrl>, Endpoint)>>,
}

impl ControllerConnector {
    async fn endpoint(&self, address: &EndpointAddr) -> Result<Endpoint> {
        let mut urls: Vec<_> = address.relay_urls().cloned().collect();
        urls.sort();
        let mut cached = self.cached.lock().await;
        if let Some((key, endpoint)) = cached.as_ref() {
            if key == &urls {
                return Ok(endpoint.clone());
            }
        }
        let relay_map: RelayMap = urls
            .iter()
            .cloned()
            .map(|url| RelayConfig::new(url, None))
            .collect();
        let mut builder = Endpoint::builder(presets::Minimal);
        if !relay_map.is_empty() {
            builder = builder.relay_mode(RelayMode::Custom(relay_map));
        }
        let endpoint = builder
            .bind()
            .await
            .context("bind Joi controller endpoint")?;
        *cached = Some((urls, endpoint.clone()));
        Ok(endpoint)
    }

    pub(crate) async fn connect(
        &self,
        address: EndpointAddr,
        connection_id: &str,
        progress: impl Fn(&'static str),
    ) -> Result<RemoteControllerTransport> {
        progress("endpointBind");
        let endpoint = self.endpoint(&address).await?;
        progress("endpointAvailable");
        let mut last_error = anyhow!("controller dial exhausted");
        let mut connected = None;
        // Try LAN immediately, even if the configured relay is offline. A stalled
        // cold dial gets bounded relay preparation and redials on this same identity.
        for seconds in [6, 6, 8] {
            progress("endpointDial");
            match tokio::time::timeout(
                std::time::Duration::from_secs(seconds),
                endpoint.connect(address.clone(), JOI_REMOTE_ALPN),
            )
            .await
            {
                Ok(Ok(connection)) => {
                    connected = Some(connection);
                    break;
                }
                Ok(Err(error)) => last_error = error.into(),
                Err(_) => last_error = ConnectionError::TimedOut.into(),
            }
            progress(network_error_code(last_error.as_ref()));
            if seconds == 8 {
                break;
            }
            progress("endpointRetry");
            if address.relay_urls().next().is_some() {
                progress("endpointRelayWait");
                let ready =
                    tokio::time::timeout(std::time::Duration::from_secs(4), endpoint.online())
                        .await
                        .is_ok();
                progress(if ready {
                    "relayReady"
                } else {
                    "relayReadyTimeout"
                });
            }
        }
        let Some(connection) = connected else {
            let mut cached = self.cached.lock().await;
            if cached
                .as_ref()
                .is_some_and(|(_, value)| value.id() == endpoint.id())
            {
                cached.take();
            }
            return Err(last_error);
        };
        progress("streamOpen");
        let (mut send, recv) = connection
            .open_bi()
            .await
            .context("open Joi control stream")?;
        progress("transportHello");
        write_frame(
            &mut send,
            &ClientMessage::Hello {
                device_id: connection_id.to_owned(),
            },
        )
        .await?;
        Ok(RemoteControllerTransport {
            connection,
            _endpoint: endpoint,
            recv,
            reader: FrameReader::default(),
            send,
        })
    }
}

impl Drop for RemoteControllerTransport {
    fn drop(&mut self) {
        // Includes task abort: do not leave a live QUIC session on the cached endpoint.
        self.connection.close(0u32.into(), b"controller closed");
    }
}

pub async fn connect_for_test(
    address: EndpointAddr,
    device_id: &str,
) -> Result<RemoteControllerTransport> {
    connect(address, device_id).await
}

pub type TestHost = RemoteHostTransport;

pub fn ticket_from_address(address: &EndpointAddr) -> TransportTicket {
    TransportTicket {
        direct_addresses: address.ip_addrs().map(ToString::to_string).collect(),
        endpoint_id: address.id.to_string(),
        relay_urls: address.relay_urls().map(ToString::to_string).collect(),
        version: 1,
    }
}

pub fn address_from_ticket(ticket: &TransportTicket) -> Result<EndpointAddr> {
    if ticket.version != 1 {
        return Err(anyhow!("unsupported Joi transport ticket version"));
    }
    let endpoint_id: EndpointId = ticket
        .endpoint_id
        .parse()
        .context("parse Joi endpoint ID")?;
    let mut address = EndpointAddr::new(endpoint_id);
    for relay_url in &ticket.relay_urls {
        address = address.with_relay_url(
            relay_url
                .parse::<RelayUrl>()
                .context("parse Joi ticket relay URL")?,
        );
    }
    for direct_address in &ticket.direct_addresses {
        address = address.with_ip_addr(
            direct_address
                .parse()
                .context("parse Joi ticket direct address")?,
        );
    }
    Ok(address)
}

fn spawn_accept_loop(
    endpoint: Endpoint,
    peers: Arc<Mutex<HashMap<String, mpsc::Sender<HostMessage>>>>,
    requests: mpsc::Sender<HostRequest>,
    diagnostics: mpsc::Sender<&'static str>,
) {
    tokio::spawn(async move {
        while let Some(incoming) = endpoint.accept().await {
            let _ = diagnostics.try_send("quicIncoming");
            let peers = peers.clone();
            let requests = requests.clone();
            let diagnostics = diagnostics.clone();
            tokio::spawn(async move {
                let connection = match incoming.await {
                    Ok(connection) => connection,
                    Err(error) => {
                        let _ = diagnostics.try_send("quicFailed");
                        let _ = diagnostics.try_send(network_error_code(&error));
                        return;
                    }
                };
                let _ = diagnostics.try_send("quicAccepted");
                let (send, mut recv) = match connection.accept_bi().await {
                    Ok(streams) => streams,
                    Err(error) => {
                        let _ = diagnostics.try_send("streamFailed");
                        let _ = diagnostics.try_send(network_error_code(&error));
                        return;
                    }
                };
                let _ = diagnostics.try_send("streamAccepted");
                let mut reader = FrameReader::default();
                let Ok(ClientMessage::Hello { device_id }) = reader.read(&mut recv).await else {
                    let _ = diagnostics.try_send("helloInvalid");
                    return;
                };
                if device_id.is_empty() || device_id.len() > 160 {
                    let _ = diagnostics.try_send("helloInvalid");
                    return;
                }
                let _ = diagnostics.try_send("helloAccepted");
                let (outbound_tx, mut outbound_rx) = mpsc::channel(32);
                peers.lock().await.insert(device_id.clone(), outbound_tx);
                let mut send = send;
                loop {
                    tokio::select! {
                        inbound = reader.read::<ClientMessage>(&mut recv) => {
                            let Ok(ClientMessage::Request { kind, payload, request_id }) = inbound else {
                                break;
                            };
                            if requests.send(HostRequest {
                                device_id: device_id.clone(),
                                kind,
                                payload,
                                request_id,
                            }).await.is_err() {
                                break;
                            }
                        }
                        outbound = outbound_rx.recv() => {
                            let Some(message) = outbound else {
                                break;
                            };
                            if write_frame(&mut send, &message).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                peers.lock().await.remove(&device_id);
                let _ = diagnostics.try_send("streamClosed");
                let _ = requests
                    .send(HostRequest {
                        device_id,
                        kind: "transport.close".to_owned(),
                        payload: serde_json::Value::Null,
                        request_id: "transport".to_owned(),
                    })
                    .await;
            });
        }
    });
}

async fn write_frame<T: Serialize>(send: &mut iroh::endpoint::SendStream, value: &T) -> Result<()> {
    let payload = serde_json::to_vec(value).context("serialize Joi remote frame")?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(anyhow!("remote frame exceeds size limit"));
    }
    send.write_all(&(payload.len() as u32).to_be_bytes())
        .await
        .context("write Joi remote frame length")?;
    send.write_all(&payload)
        .await
        .context("write Joi remote frame")?;
    Ok(())
}

// select! may drop read() when an outbound message or path tick wins. Keep all
// consumed bytes on the connection, not in the future. RecvStream::read is
// cancellation-safe; read_exact is not. Update progress before the next await.
#[derive(Default)]
struct FrameReader {
    header: [u8; 4],
    header_read: usize,
    payload: Vec<u8>,
    payload_read: usize,
}

impl FrameReader {
    async fn read<T: DeserializeOwned>(
        &mut self,
        recv: &mut iroh::endpoint::RecvStream,
    ) -> Result<T> {
        while self.header_read < self.header.len() {
            let count = recv
                .read(&mut self.header[self.header_read..])
                .await
                .context("read Joi remote frame length")?
                .filter(|count| *count > 0)
                .ok_or_else(|| anyhow!("incomplete Joi remote frame length"))?;
            self.header_read += count;
        }
        let length = u32::from_be_bytes(self.header) as usize;
        if length == 0 || length > MAX_FRAME_BYTES {
            return Err(anyhow!("remote frame length is invalid"));
        }
        if self.payload.is_empty() {
            self.payload.resize(length, 0);
        }
        while self.payload_read < length {
            let count = recv
                .read(&mut self.payload[self.payload_read..])
                .await
                .context("read Joi remote frame")?
                .filter(|count| *count > 0)
                .ok_or_else(|| anyhow!("incomplete Joi remote frame"))?;
            self.payload_read += count;
        }
        let result = serde_json::from_slice(&self.payload).context("decode Joi remote frame");
        self.header_read = 0;
        self.payload.clear();
        self.payload_read = 0;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn controller_endpoint_is_reused_and_close_is_connection_scoped() {
        let connector = ControllerConnector::default();
        let host = RemoteHostTransport::bind().await.unwrap();
        let first = connector
            .connect(host.address(), "first", |_| {})
            .await
            .unwrap();
        let id = first._endpoint.id();
        let mut concurrent = connector
            .connect(host.address(), "concurrent", |_| {})
            .await
            .unwrap();
        first.close().await;
        concurrent
            .send(ClientMessage::Request {
                kind: "probe".into(),
                payload: serde_json::json!({}),
                request_id: "probe".into(),
            })
            .await
            .unwrap();
        let request = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let request = host.next_request().await.unwrap();
                if request.kind == "probe" {
                    break request;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(request.device_id, "concurrent");
        let second = connector
            .connect(host.address(), "second", |_| {})
            .await
            .unwrap();
        assert_eq!(second._endpoint.id(), id);
        assert!(second.connection.close_reason().is_none());
        second.close().await;
        concurrent.close().await;
        host.close().await;
    }

    #[tokio::test]
    async fn offline_relay_does_not_delay_reachable_lan() {
        let host = RemoteHostTransport::bind().await.unwrap();
        let address = host
            .address()
            .with_relay_url("https://127.0.0.1:9".parse().unwrap());
        let connector = ControllerConnector::default();
        let client = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            connector.connect(address, "lan", |_| {}),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(client.path(), RemoteConnectionPath::Direct);
        client.close().await;
        host.close().await;
    }

    #[tokio::test]
    async fn stalled_first_dial_redials_on_the_same_endpoint() {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let host = Endpoint::builder(presets::Minimal)
                .alpns(vec![JOI_REMOTE_ALPN.to_vec()])
                .bind()
                .await
                .unwrap();
            let connector = ControllerConnector::default();
            let address = host.addr();
            let original = connector.endpoint(&address).await.unwrap().id();
            let server = async {
                let stalled = host.accept().await.unwrap();
                tokio::time::sleep(std::time::Duration::from_millis(6300)).await;
                stalled.ignore();
                let connection = host.accept().await.unwrap().await.unwrap();
                let (_send, mut recv) = connection.accept_bi().await.unwrap();
                let message: ClientMessage = FrameReader::default().read(&mut recv).await.unwrap();
                assert!(matches!(message, ClientMessage::Hello { .. }));
                connection
            };
            let stages = std::sync::Mutex::new(Vec::new());
            let (client, server) = tokio::join!(
                connector.connect(address, "retry", |stage| stages.lock().unwrap().push(stage)),
                server
            );
            let client = client.unwrap();
            assert_eq!(client._endpoint.id(), original);
            assert!(stages.lock().unwrap().contains(&"endpointRetry"));
            client.close().await;
            drop(server);
            host.close().await;
        })
        .await
        .expect("bounded warm redial");
    }

    #[test]
    fn error_diagnostics_discard_private_reasons_and_classify_typed_sources() {
        use iroh::endpoint::{ApplicationClose, TransportError, TransportErrorCode};
        let timeout = anyhow::Error::new(ConnectionError::TimedOut).context("private path");
        assert_eq!(network_error_code(timeout.as_ref()), "quicTimedOut");
        let incoming: ConnectingError = ConnectionError::TimedOut.into();
        assert_eq!(network_error_code(&incoming), "quicTimedOut");
        let close = ConnectionError::ApplicationClosed(ApplicationClose {
            error_code: 7u32.into(),
            reason: b"secret peer payload".to_vec().into(),
        });
        assert_eq!(network_error_code(&close), "quicPeerApplicationClosed");
        for (alert, expected) in [
            (120, "quicTlsNoApplicationProtocol"),
            (42, "quicTlsCertificateRejected"),
            (40, "quicTlsHandshakeFailure"),
            (70, "quicTlsProtocolVersion"),
            (80, "quicTlsAlert"),
        ] {
            let error = ConnectionError::TransportError(TransportError::new(
                TransportErrorCode::crypto(alert),
                "secret certificate/path".into(),
            ));
            assert_eq!(network_error_code(&error), expected);
        }
        assert_eq!(
            network_error_code(anyhow!("secret=private").as_ref()),
            "quicUnknownError"
        );
    }

    #[tokio::test]
    async fn exhausted_dial_is_bounded_and_evicts_only_its_endpoint() {
        let connector = ControllerConnector::default();
        let address = EndpointAddr::new(SecretKey::generate().public())
            .with_ip_addr("127.0.0.1:9".parse().unwrap());
        let stages = std::sync::Mutex::new(Vec::new());
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(23),
            connector.connect(address, "timeout", |stage| {
                stages.lock().unwrap().push(stage)
            }),
        )
        .await
        .unwrap();
        assert!(result.is_err());
        assert_eq!(
            stages
                .lock()
                .unwrap()
                .iter()
                .filter(|&&stage| stage == "endpointDial")
                .count(),
            3
        );
        assert!(connector.cached.lock().await.is_none());
    }

    #[tokio::test]
    #[ignore = "requires JOI_RELAY_SMOKE_URL and a deployed public relay"]
    async fn production_connector_exchanges_frames_with_relay_only_host() {
        let relay: RelayUrl = std::env::var("JOI_RELAY_SMOKE_URL")
            .unwrap()
            .parse()
            .unwrap();
        let host = Endpoint::builder(presets::Minimal)
            .alpns(vec![JOI_REMOTE_ALPN.to_vec()])
            .relay_mode(RelayMode::Custom(RelayMap::from(RelayConfig::new(
                relay, None,
            ))))
            .clear_ip_transports()
            .bind()
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(15), host.online())
            .await
            .unwrap();
        let connector = ControllerConnector::default();
        tokio::time::timeout(std::time::Duration::from_secs(40), async {
            let server = async {
                let connection = host.accept().await.unwrap().await.unwrap();
                let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                let hello: ClientMessage = FrameReader::default().read(&mut recv).await.unwrap();
                assert!(matches!(hello, ClientMessage::Hello { .. }));
                write_frame(&mut send, &HostMessage::Ready).await.unwrap();
                connection.closed().await;
            };
            let client = async {
                let mut client = connector
                    .connect(host.addr(), "relay-smoke", |_| {})
                    .await
                    .unwrap();
                assert_eq!(client.path(), RemoteConnectionPath::Relay);
                assert!(matches!(client.recv().await.unwrap(), HostMessage::Ready));
                client.close().await;
            };
            tokio::join!(server, client);
        })
        .await
        .unwrap();
        host.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn real_peer_close_has_a_safe_reason() {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let host = RemoteHostTransport::bind().await.unwrap();
            let client = Endpoint::builder(presets::Minimal).bind().await.unwrap();
            let connection = client
                .connect(host.address(), JOI_REMOTE_ALPN)
                .await
                .unwrap();
            assert_eq!(host.next_diagnostic().await, Some("quicIncoming"));
            assert_eq!(host.next_diagnostic().await, Some("quicAccepted"));
            connection.close(7u32.into(), b"private peer close reason");
            assert_eq!(host.next_diagnostic().await, Some("streamFailed"));
            assert_eq!(
                host.next_diagnostic().await,
                Some("quicPeerApplicationClosed")
            );
            client.close().await;
            host.close().await;
        })
        .await
        .expect("diagnostic test timeout");
    }

    #[tokio::test]
    async fn public_tls_prefers_hybrid_key_exchange_and_keeps_classical_fallback() {
        let host = RemoteHostTransport::bind().await.expect("bind host");
        let groups = &host.endpoint.tls_config().crypto_provider().kx_groups;
        assert_eq!(groups[0].name(), rustls::NamedGroup::X25519MLKEM768);
        assert!(
            groups
                .iter()
                .any(|group| group.name() == rustls::NamedGroup::X25519)
        );
        assert!(host.endpoint.tls_config().enable_sni);
        host.close().await;
    }
}
