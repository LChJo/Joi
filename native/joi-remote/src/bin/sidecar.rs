use std::{
    collections::HashSet,
    io::{self, BufRead},
    sync::Arc,
};

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use joi_remote::{
    network::{HostTransportOptions, RemoteHostTransport},
    protocol::HostMessage,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc};

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum SidecarCommand {
    Start {
        relay_authentication: Option<String>,
        relay_url: Option<String>,
        secret_key: String,
    },
    Send {
        connection_id: String,
        frame: serde_json::Value,
    },
    Close {
        connection_id: String,
    },
    Shutdown,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum SidecarEvent<'a> {
    Ready {
        ticket: joi_remote::protocol::TransportTicket,
    },
    PeerOpen {
        connection_id: &'a str,
    },
    PeerFrame {
        connection_id: &'a str,
        frame: serde_json::Value,
    },
    PeerClose {
        connection_id: &'a str,
    },
    Error {
        code: &'a str,
    },
}

#[tokio::main]
async fn main() {
    if run().await.is_err() {
        emit(&SidecarEvent::Error {
            code: "sidecar_failed",
        });
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let (commands_tx, mut commands_rx) = mpsc::channel(64);
    spawn_stdin_reader(commands_tx);
    let start = commands_rx
        .recv()
        .await
        .context("sidecar start command missing")?;
    let SidecarCommand::Start {
        relay_authentication,
        relay_url,
        secret_key,
    } = start
    else {
        anyhow::bail!("first sidecar command must be start");
    };
    let secret_key = decode_secret_key(&secret_key)?;
    let host = Arc::new(
        RemoteHostTransport::bind_with(HostTransportOptions {
            relay_authentication,
            relay_url,
            secret_key: Some(secret_key),
        })
        .await?,
    );
    emit(&SidecarEvent::Ready {
        ticket: host.ticket(),
    });

    let seen = Arc::new(Mutex::new(HashSet::<String>::new()));
    loop {
        tokio::select! {
            command = commands_rx.recv() => {
                match command {
                    Some(SidecarCommand::Send { connection_id, frame }) => {
                        let result = host.send_to(&connection_id, HostMessage::Response {
                            payload: frame,
                            request_id: "transport".to_owned(),
                        }).await;
                        if result.is_err() {
                            seen.lock().await.remove(&connection_id);
                            emit(&SidecarEvent::PeerClose { connection_id: &connection_id });
                        }
                    }
                    Some(SidecarCommand::Close { connection_id }) => {
                        host.disconnect(&connection_id).await;
                        seen.lock().await.remove(&connection_id);
                        emit(&SidecarEvent::PeerClose { connection_id: &connection_id });
                    }
                    Some(SidecarCommand::Shutdown) | None => break,
                    Some(SidecarCommand::Start { .. }) => anyhow::bail!("sidecar already started"),
                }
            }
            request = host.next_request() => {
                let Some(request) = request else { break; };
                if request.kind == "transport.close" {
                    seen.lock().await.remove(&request.device_id);
                    emit(&SidecarEvent::PeerClose { connection_id: &request.device_id });
                    continue;
                }
                if request.kind != "frame" {
                    continue;
                }
                let mut seen = seen.lock().await;
                if seen.insert(request.device_id.clone()) {
                    emit(&SidecarEvent::PeerOpen { connection_id: &request.device_id });
                }
                drop(seen);
                emit(&SidecarEvent::PeerFrame {
                    connection_id: &request.device_id,
                    frame: request.payload,
                });
            }
        }
    }
    Ok(())
}

fn spawn_stdin_reader(commands: mpsc::Sender<SidecarCommand>) {
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else {
                break;
            };
            if line.len() > 512 * 1024 {
                break;
            }
            let Ok(command) = serde_json::from_str(&line) else {
                emit(&SidecarEvent::Error {
                    code: "sidecar_command_invalid",
                });
                continue;
            };
            if commands.blocking_send(command).is_err() {
                break;
            }
        }
    });
}

fn decode_secret_key(value: &str) -> Result<[u8; 32]> {
    let bytes = STANDARD
        .decode(value)
        .context("decode sidecar secret key")?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("sidecar secret key length invalid"))
}

fn emit(event: &SidecarEvent<'_>) {
    if let Ok(line) = serde_json::to_string(event) {
        println!("{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn desktop_start_preserves_optional_relay_fields() {
        let decoded = serde_json::from_value::<SidecarCommand>(json!({
            "type": "start", "secretKey": "test-key", "relayUrl": "https://relay.example.test",
            "relayAuthentication": "test-auth"
        }))
        .expect("desktop start schema");
        let SidecarCommand::Start {
            secret_key,
            relay_url,
            relay_authentication,
        } = decoded
        else {
            panic!("expected start");
        };
        assert_eq!(secret_key, "test-key");
        assert_eq!(relay_url.as_deref(), Some("https://relay.example.test"));
        assert_eq!(relay_authentication.as_deref(), Some("test-auth"));
    }
}
