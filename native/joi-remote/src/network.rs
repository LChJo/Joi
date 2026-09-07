use std::{collections::HashMap, sync::Arc};

use anyhow::{Context, Result, anyhow};
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayConfig, RelayMap, RelayMode, RelayUrl, SecretKey,
    endpoint::presets,
};
use serde::{Serialize, de::DeserializeOwned};
use tokio::sync::{Mutex, mpsc};

use crate::protocol::{ClientMessage, HostMessage, JOI_REMOTE_ALPN, TransportTicket};

const MAX_FRAME_BYTES: usize = 256 * 1024;

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
        spawn_accept_loop(endpoint.clone(), peers.clone(), request_tx);
        Ok(Self {
            endpoint,
            configured_relay,
            peers,
            requests: Mutex::new(request_rx),
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
    endpoint: Endpoint,
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
        self.endpoint.close().await;
    }
}

pub async fn connect(
    address: EndpointAddr,
    connection_id: &str,
) -> Result<RemoteControllerTransport> {
    let relay_map: RelayMap = address
        .relay_urls()
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
        .context("bind Joi test controller endpoint")?;
    let connection = endpoint
        .connect(address, JOI_REMOTE_ALPN)
        .await
        .context("connect Joi test controller")?;
    let (mut send, recv) = connection
        .open_bi()
        .await
        .context("open Joi control stream")?;
    write_frame(
        &mut send,
        &ClientMessage::Hello {
            device_id: connection_id.to_owned(),
        },
    )
    .await?;
    Ok(RemoteControllerTransport {
        connection,
        endpoint,
        recv,
        reader: FrameReader::default(),
        send,
    })
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
) {
    tokio::spawn(async move {
        while let Some(incoming) = endpoint.accept().await {
            let peers = peers.clone();
            let requests = requests.clone();
            tokio::spawn(async move {
                let Ok(connection) = incoming.await else {
                    return;
                };
                let Ok((send, mut recv)) = connection.accept_bi().await else {
                    return;
                };
                let mut reader = FrameReader::default();
                let Ok(ClientMessage::Hello { device_id }) = reader.read(&mut recv).await else {
                    return;
                };
                if device_id.is_empty() || device_id.len() > 160 {
                    return;
                }
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
    async fn read<T: DeserializeOwned>(&mut self, recv: &mut iroh::endpoint::RecvStream) -> Result<T> {
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
