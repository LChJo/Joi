use serde::{Deserialize, Serialize};

pub const JOI_REMOTE_ALPN: &[u8] = b"/joi/remote/1";
pub const PAIRING_TTL_MS: u64 = 10 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingOffer {
    pub expires_at_ms: u64,
    pub offer_id: String,
    pub secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequest {
    pub device_id: String,
    pub device_name: String,
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedDevice {
    pub created_at_ms: u64,
    pub device_id: String,
    pub device_name: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportTicket {
    pub direct_addresses: Vec<String>,
    pub endpoint_id: String,
    pub relay_urls: Vec<String>,
    pub version: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    Hello {
        device_id: String,
    },
    Request {
        kind: String,
        payload: serde_json::Value,
        request_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HostMessage {
    Ready,
    Response {
        payload: serde_json::Value,
        request_id: String,
    },
    Event {
        kind: String,
        payload: serde_json::Value,
    },
}
