use joi_remote::{
    network::{TestHost, connect_for_test},
    protocol::{ClientMessage, HostMessage},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_controllers_use_independent_streams_on_one_host() {
    let host = TestHost::bind().await.expect("bind host");
    let address = host.address();

    let mut first = connect_for_test(address.clone(), "phone-a")
        .await
        .expect("connect first controller");
    let mut second = connect_for_test(address, "phone-b")
        .await
        .expect("connect second controller");

    first
        .send(ClientMessage::Request {
            kind: "feed.get".to_owned(),
            payload: serde_json::json!({}),
            request_id: "request-a".to_owned(),
        })
        .await
        .expect("send first request");
    second
        .send(ClientMessage::Request {
            kind: "feed.get".to_owned(),
            payload: serde_json::json!({}),
            request_id: "request-b".to_owned(),
        })
        .await
        .expect("send second request");

    let first_event = host.next_request().await.expect("first host request");
    let second_event = host.next_request().await.expect("second host request");
    assert_ne!(first_event.device_id, second_event.device_id);

    host.send_to(
        &first_event.device_id,
        HostMessage::Response {
            payload: serde_json::json!({"device": first_event.device_id}),
            request_id: first_event.request_id,
        },
    )
    .await
    .expect("respond to first");
    host.send_to(
        &second_event.device_id,
        HostMessage::Response {
            payload: serde_json::json!({"device": second_event.device_id}),
            request_id: second_event.request_id,
        },
    )
    .await
    .expect("respond to second");

    let first_response = first.recv().await.expect("first response");
    let second_response = second.recv().await.expect("second response");
    assert!(
        matches!(first_response, HostMessage::Response { ref request_id, .. } if request_id == "request-a")
    );
    assert!(
        matches!(second_response, HostMessage::Response { ref request_id, .. } if request_id == "request-b")
    );

    first.close().await;
    second.close().await;
    host.close().await;
}
