use std::time::Duration;

use anyhow::{Context, Result};
use iroh::{Endpoint, RelayConfig, RelayMap, RelayMode, RelayUrl, Watcher, endpoint::presets};

const RELAY_SMOKE_ALPN: &[u8] = b"/joi/relay-smoke/1";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires JOI_RELAY_SMOKE_URL and a deployed public relay"]
async fn two_relay_only_endpoints_exchange_bytes() -> Result<()> {
    let relay_url: RelayUrl = std::env::var("JOI_RELAY_SMOKE_URL")
        .context("JOI_RELAY_SMOKE_URL is required")?
        .parse()
        .context("parse deployed relay URL")?;
    let relay_map = RelayMap::from(RelayConfig::new(relay_url, None));
    let host = Endpoint::builder(presets::Minimal)
        .alpns(vec![RELAY_SMOKE_ALPN.to_vec()])
        .relay_mode(RelayMode::Custom(relay_map.clone()))
        .clear_ip_transports()
        .bind()
        .await
        .context("bind relay-only host")?;
    if tokio::time::timeout(Duration::from_secs(15), host.online())
        .await
        .is_err()
    {
        anyhow::bail!(
            "relay-only host did not become online: {:?}",
            host.home_relay_status().get()
        );
    }
    let host_address = host.addr();
    let accepting_host = host.clone();
    let accept = async move {
        let incoming = accepting_host
            .accept()
            .await
            .context("relay-only host stopped before accept")?;
        let connection = incoming.await.context("accept relay-only connection")?;
        let (mut send, mut receive) = connection
            .accept_bi()
            .await
            .context("accept smoke stream")?;
        let message = receive
            .read_to_end(64)
            .await
            .context("read smoke request")?;
        anyhow::ensure!(message == b"joi-relay-smoke", "unexpected smoke request");
        send.write_all(b"joi-relay-ok")
            .await
            .context("write smoke response")?;
        send.finish().context("finish smoke response")?;
        connection.closed().await;
        Result::<()>::Ok(())
    };
    let connect = async move {
        let controller = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Custom(relay_map))
            .clear_ip_transports()
            .bind()
            .await
            .context("bind relay-only controller")?;
        if tokio::time::timeout(Duration::from_secs(15), controller.online())
            .await
            .is_err()
        {
            anyhow::bail!(
                "relay-only controller did not become online: {:?}",
                controller.home_relay_status().get()
            );
        }
        let connection = controller
            .connect(host_address, RELAY_SMOKE_ALPN)
            .await
            .context("connect through deployed relay")?;
        anyhow::ensure!(
            connection.paths().iter().any(|path| path.is_relay()),
            "connection did not select a relay path"
        );
        let (mut send, mut receive) = connection.open_bi().await.context("open smoke stream")?;
        send.write_all(b"joi-relay-smoke")
            .await
            .context("write smoke request")?;
        send.finish().context("finish smoke request")?;
        let response = receive
            .read_to_end(64)
            .await
            .context("read smoke response")?;
        anyhow::ensure!(response == b"joi-relay-ok", "unexpected smoke response");
        connection.close(0u32.into(), b"smoke complete");
        controller.close().await;
        Result::<()>::Ok(())
    };

    tokio::time::timeout(Duration::from_secs(30), async {
        tokio::try_join!(accept, connect)?;
        Result::<()>::Ok(())
    })
    .await
    .context("deployed relay smoke test timed out")??;
    host.close().await;
    Ok(())
}
