use std::{
    ffi::{CStr, CString},
    time::Duration,
};

use iroh::{Endpoint, endpoint::presets};
use joi_remote::{
    ffi::{
        joi_remote_controller_close, joi_remote_controller_poll, joi_remote_controller_send,
        joi_remote_controller_start, joi_remote_string_free,
    },
    network::{RemoteHostTransport, ticket_from_address},
    protocol::{ClientMessage, HostMessage, JOI_REMOTE_ALPN},
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::time::{sleep, timeout};

fn frame(value: &impl Serialize) -> Vec<u8> {
    let body = serde_json::to_vec(value).unwrap();
    let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
    bytes.extend(body);
    bytes
}

// Test-only uninterrupted reader; production readers must survive cancellation.
async fn read<T: DeserializeOwned>(recv: &mut iroh::endpoint::RecvStream) -> T {
    let mut header = [0; 4];
    recv.read_exact(&mut header).await.unwrap();
    let size = u32::from_be_bytes(header) as usize;
    assert!(size > 0 && size <= 256 * 1024);
    let mut body = vec![0; size];
    recv.read_exact(&mut body).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

struct Controller(u64);
impl Drop for Controller {
    fn drop(&mut self) {
        joi_remote_controller_close(self.0);
    }
}

async fn next_frame(controller: &Controller) -> Value {
    loop {
        let pointer = joi_remote_controller_poll(controller.0);
        if !pointer.is_null() {
            // SAFETY: poll transfers a NUL-terminated allocation, freed exactly once.
            let value: Value = unsafe {
                let result = serde_json::from_slice(CStr::from_ptr(pointer).to_bytes());
                joi_remote_string_free(pointer);
                result.unwrap()
            };
            match value["type"].as_str() {
                Some("frame") => return value["frame"].clone(),
                Some("error" | "disconnected") => panic!("controller lost fragmented frame"),
                _ => {}
            }
        }
        sleep(Duration::from_millis(10)).await;
    }
}

async fn ffi_fragment(split: usize, interrupt_by_send: bool) {
    timeout(Duration::from_secs(15), async {
        let host = Endpoint::builder(presets::Minimal)
            .alpns(vec![JOI_REMOTE_ALPN.to_vec()])
            .bind()
            .await
            .unwrap();
        let config = CString::new(
            json!({
                "connectionId": "fragment-test",
                "ticket": ticket_from_address(&host.addr()),
            })
            .to_string(),
        )
        .unwrap();
        // SAFETY: config remains alive for the synchronous start call.
        let controller = Controller(unsafe { joi_remote_controller_start(config.as_ptr()) });
        assert_ne!(controller.0, 0);
        let connection = host.accept().await.unwrap().await.unwrap();
        let (mut send, mut recv) = connection.accept_bi().await.unwrap();
        assert!(matches!(
            read::<ClientMessage>(&mut recv).await,
            ClientMessage::Hello { .. }
        ));
        // Let the immediate interval tick pass, then cross the next 2-second tick.
        sleep(Duration::from_millis(200)).await;
        let response = frame(&HostMessage::Response {
            request_id: "fragment-test".into(),
            payload: json!({"probe": 1}),
        });
        send.write_all(&response[..split]).await.unwrap();
        if interrupt_by_send {
            sleep(Duration::from_millis(200)).await;
            let command = CString::new("{}").unwrap();
            // SAFETY: the command is alive throughout the synchronous call.
            assert!(unsafe { joi_remote_controller_send(controller.0, command.as_ptr()) });
            assert!(matches!(
                read::<ClientMessage>(&mut recv).await,
                ClientMessage::Request { .. }
            ));
        } else {
            sleep(Duration::from_millis(2200)).await;
        }
        send.write_all(&response[split..]).await.unwrap();
        assert_eq!(next_frame(&controller).await, json!({"probe": 1}));
        // A second complete frame verifies state reset and framing alignment.
        send.write_all(&response).await.unwrap();
        assert_eq!(next_frame(&controller).await, json!({"probe": 1}));
        // Closing must remain responsive even with another incomplete frame.
        send.write_all(&response[..split]).await.unwrap();
        sleep(Duration::from_millis(100)).await;
        drop(controller);
        timeout(Duration::from_secs(2), connection.closed())
            .await
            .expect("FFI close blocked by partial frame");
        host.close().await;
    })
    .await
    .expect("fragmented FFI exchange timed out");
}

#[tokio::test]
async fn ffi_timer_preserves_partial_header() {
    ffi_fragment(2, false).await;
}

#[tokio::test]
async fn ffi_timer_preserves_partial_body() {
    ffi_fragment(12, false).await;
}

#[tokio::test]
async fn ffi_send_preserves_partial_header() {
    ffi_fragment(2, true).await;
}

#[tokio::test]
async fn ffi_send_preserves_partial_body() {
    ffi_fragment(12, true).await;
}

async fn host_fragment(split: usize) {
    timeout(Duration::from_secs(10), async {
        let host = RemoteHostTransport::bind().await.unwrap();
        let endpoint = Endpoint::builder(presets::Minimal).bind().await.unwrap();
        let connection = endpoint
            .connect(host.address(), JOI_REMOTE_ALPN)
            .await
            .unwrap();
        let (mut send, mut recv) = connection.open_bi().await.unwrap();
        send.write_all(&frame(&ClientMessage::Hello {
            device_id: "fragment-test".into(),
        }))
        .await
        .unwrap();
        let request = frame(&ClientMessage::Request {
            kind: "probe".into(),
            request_id: "fragment-test".into(),
            payload: Value::Null,
        });
        send.write_all(&request).await.unwrap();
        assert_eq!(host.next_request().await.unwrap().kind, "probe");
        send.write_all(&request[..split]).await.unwrap();
        sleep(Duration::from_millis(200)).await;
        host.send_to("fragment-test", HostMessage::Ready)
            .await
            .unwrap();
        // Receiving outbound is a barrier: the host's inbound future was cancelled.
        assert_eq!(read::<HostMessage>(&mut recv).await, HostMessage::Ready);
        send.write_all(&request[split..]).await.unwrap();
        assert_eq!(host.next_request().await.unwrap().kind, "probe");
        send.write_all(&request).await.unwrap();
        assert_eq!(host.next_request().await.unwrap().kind, "probe");
        endpoint.close().await;
        host.close().await;
    })
    .await
    .expect("fragmented host exchange timed out");
}

#[tokio::test]
async fn host_outbound_preserves_partial_header() {
    host_fragment(2).await;
}

#[tokio::test]
async fn host_outbound_preserves_partial_body() {
    host_fragment(12).await;
}

#[tokio::test]
async fn invalid_and_truncated_frames_close_the_host_stream() {
    timeout(Duration::from_secs(15), async {
        for bytes in [
            0_u32.to_be_bytes().to_vec(),
            (256_u32 * 1024 + 1).to_be_bytes().to_vec(),
            vec![0, 0],
            vec![0, 0, 0, 10, b'{'],
            vec![0, 0, 0, 1, b'!'],
        ] {
            let host = RemoteHostTransport::bind().await.unwrap();
            let endpoint = Endpoint::builder(presets::Minimal).bind().await.unwrap();
            let connection = endpoint
                .connect(host.address(), JOI_REMOTE_ALPN)
                .await
                .unwrap();
            let (mut send, _recv) = connection.open_bi().await.unwrap();
            send.write_all(&frame(&ClientMessage::Hello {
                device_id: "invalid-frame-test".into(),
            }))
            .await
            .unwrap();
            send.write_all(&bytes).await.unwrap();
            send.finish().unwrap();
            assert_eq!(host.next_request().await.unwrap().kind, "transport.close");
            endpoint.close().await;
            host.close().await;
        }
    })
    .await
    .expect("invalid frame did not close stream");
}
