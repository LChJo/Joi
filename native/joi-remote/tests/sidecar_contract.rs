use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use joi_remote::{
    network::{address_from_ticket, connect},
    protocol::{ClientMessage, HostMessage, TransportTicket},
};
use serde_json::{Value, json};

struct Sidecar {
    child: Child,
    events: Receiver<Value>,
}

impl Sidecar {
    fn start() -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_joi-remote-sidecar"));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start sidecar");
        let stdout = child.stdout.take().expect("stdout");
        let (tx, events) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(event) = serde_json::from_str(&line) else {
                    break;
                };
                if tx.send(event).is_err() {
                    break;
                }
            }
        });
        Self { child, events }
    }

    fn send(&mut self, value: Value) {
        writeln!(self.child.stdin.as_mut().expect("stdin"), "{value}").expect("send command");
    }

    fn event(&self, kind: &str) -> Value {
        let event = self
            .events
            .recv_timeout(Duration::from_secs(10))
            .expect("sidecar event timeout");
        // Assert only the event type: never print credentials or ticket contents.
        assert_eq!(event["type"].as_str(), Some(kind));
        event
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_camel_case_commands_and_peer_events_match_real_sidecar() {
    let mut sidecar = Sidecar::start();
    sidecar.send(
        json!({ "type": "start", "secretKey": STANDARD.encode([9u8; 32]),
        "relayUrl": null, "relayAuthentication": null }),
    );
    let ready = sidecar.event("ready");
    let ticket: TransportTicket =
        serde_json::from_value(ready["ticket"].clone()).expect("ticket schema");
    let address = address_from_ticket(&ticket).expect("ticket address");
    let mut phone = tokio::time::timeout(Duration::from_secs(10), connect(address, "phone-test"))
        .await
        .expect("connect timeout")
        .expect("connect phone");
    phone
        .send(ClientMessage::Request {
            kind: "frame".into(),
            payload: json!({ "probe": true }),
            request_id: "probe".into(),
        })
        .await
        .expect("request");
    let opened = sidecar.event("peerOpen");
    assert_eq!(opened["connectionId"], "phone-test");
    assert!(opened.get("connection_id").is_none());
    let frame = sidecar.event("peerFrame");
    assert_eq!(frame["connectionId"], "phone-test");
    assert_eq!(frame["frame"], json!({ "probe": true }));
    sidecar.send(json!({ "type": "send", "connectionId": "phone-test", "frame": { "ok": true } }));
    let response = tokio::time::timeout(Duration::from_secs(10), phone.recv())
        .await
        .expect("response timeout")
        .expect("response");
    assert!(
        matches!(response, HostMessage::Response { payload, .. } if payload == json!({ "ok": true }))
    );
    sidecar.send(json!({ "type": "close", "connectionId": "phone-test" }));
    assert_eq!(sidecar.event("peerClose")["connectionId"], "phone-test");
    phone.close().await;
    sidecar.send(json!({ "type": "shutdown" }));
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = sidecar.child.try_wait().expect("child status") {
            assert!(status.success());
            break;
        }
        assert!(std::time::Instant::now() < deadline, "shutdown timeout");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[test]
fn initial_ticket_keeps_configured_relay_before_it_is_online() {
    let mut sidecar = Sidecar::start();
    sidecar.send(
        json!({ "type": "start", "secretKey": STANDARD.encode([8u8; 32]),
        "relayUrl": "https://relay.example.invalid" }),
    );
    let ready = sidecar.event("ready");
    assert_eq!(
        ready["ticket"]["relayUrls"],
        json!(["https://relay.example.invalid/"])
    );
}
