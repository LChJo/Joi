use crate::protocol::{AuthorizedDevice, PairingOffer, PairingRequest};
use std::collections::HashMap;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug)]
struct OfferState {
    consumed: bool,
    expires_at_ms: u64,
    secret_mac: [u8; 32],
}

#[derive(Debug)]
struct PendingRequest {
    device_id: String,
    device_name: String,
}

#[derive(Debug)]
struct DeviceState {
    token_mac: [u8; 32],
}

#[derive(Debug)]
pub struct PairingAuthority {
    devices: HashMap<String, DeviceState>,
    offers: HashMap<String, OfferState>,
    pending: HashMap<String, PendingRequest>,
    signing_key: [u8; 32],
}

impl PairingAuthority {
    pub fn new() -> Self {
        let mut signing_key = [0_u8; 32];
        rand::rng().fill_bytes(&mut signing_key);
        Self {
            devices: HashMap::new(),
            offers: HashMap::new(),
            pending: HashMap::new(),
            signing_key,
        }
    }

    pub fn create_offer(&mut self, now_ms: u64, ttl_ms: u64) -> PairingOffer {
        let offer_id = format!("pair_{}", Uuid::new_v4());
        let secret = random_secret();
        let expires_at_ms = now_ms.saturating_add(ttl_ms);
        self.offers.insert(
            offer_id.clone(),
            OfferState {
                consumed: false,
                expires_at_ms,
                secret_mac: self.mac(secret.as_bytes()),
            },
        );
        PairingOffer {
            expires_at_ms,
            offer_id,
            secret,
        }
    }

    pub fn request_pairing(
        &mut self,
        now_ms: u64,
        offer_id: &str,
        secret: &str,
        device_id: &str,
        device_name: &str,
    ) -> Result<PairingRequest, AuthorizationError> {
        let supplied_mac = self.mac(secret.as_bytes());
        let offer = self
            .offers
            .get_mut(offer_id)
            .ok_or(AuthorizationError::OfferInvalid)?;
        if offer.expires_at_ms < now_ms {
            return Err(AuthorizationError::OfferExpired);
        }
        if offer.consumed {
            return Err(AuthorizationError::OfferConsumed);
        }
        if !constant_time_eq(&offer.secret_mac, &supplied_mac) {
            return Err(AuthorizationError::OfferInvalid);
        }
        offer.consumed = true;
        let request_id = format!("request_{}", Uuid::new_v4());
        let request = PairingRequest {
            device_id: device_id.to_owned(),
            device_name: normalized_name(device_name),
            request_id: request_id.clone(),
        };
        self.pending.insert(
            request_id,
            PendingRequest {
                device_id: request.device_id.clone(),
                device_name: request.device_name.clone(),
            },
        );
        Ok(request)
    }

    pub fn approve(
        &mut self,
        now_ms: u64,
        request_id: &str,
    ) -> Result<AuthorizedDevice, AuthorizationError> {
        let pending = self
            .pending
            .remove(request_id)
            .ok_or(AuthorizationError::RequestNotFound)?;
        let token = random_secret();
        self.devices.insert(
            pending.device_id.clone(),
            DeviceState {
                token_mac: self.mac(token.as_bytes()),
            },
        );
        Ok(AuthorizedDevice {
            created_at_ms: now_ms,
            device_id: pending.device_id,
            device_name: pending.device_name,
            token,
        })
    }

    pub fn authorize(&self, device_id: &str, token: &str) -> bool {
        self.devices
            .get(device_id)
            .is_some_and(|device| constant_time_eq(&device.token_mac, &self.mac(token.as_bytes())))
    }

    pub fn revoke(&mut self, device_id: &str) -> Result<(), AuthorizationError> {
        self.devices
            .remove(device_id)
            .map(|_| ())
            .ok_or(AuthorizationError::DeviceNotFound)
    }

    fn mac(&self, value: &[u8]) -> [u8; 32] {
        let mut mac =
            HmacSha256::new_from_slice(&self.signing_key).expect("HMAC accepts a 32-byte key");
        mac.update(value);
        mac.finalize().into_bytes().into()
    }
}

impl Default for PairingAuthority {
    fn default() -> Self {
        Self::new()
    }
}

fn random_secret() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn normalized_name(value: &str) -> String {
    let name = value.trim();
    if name.is_empty() {
        "Android device".to_owned()
    } else {
        name.chars().take(80).collect()
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthorizationError {
    #[error("pairing offer expired")]
    OfferExpired,
    #[error("pairing offer is invalid")]
    OfferInvalid,
    #[error("pairing offer was already consumed")]
    OfferConsumed,
    #[error("pairing request was not found")]
    RequestNotFound,
    #[error("device was not found")]
    DeviceNotFound,
}
