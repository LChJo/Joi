import { once } from "node:events";

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { createRemoteRelayServer, type RunningRemoteRelayServer } from "../../src/relay/remote-relay-server.js";

function event(socket: WebSocket, name: "close" | "message" | "open", label: string) {
  return Promise.race([
    once(socket, name),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`timeout:${label}`)), 1_000)),
  ]);
}

describe("browser remote relay", () => {
  let running: RunningRemoteRelayServer | undefined;
  afterEach(async () => running?.close());

  it("authenticates hosts and forwards opaque browser frames without inspecting payloads", async () => {
    const relayToken = "relay-secret-at-least-32-characters";
    running = await createRemoteRelayServer({ hostToken: relayToken, maxFrameBytes: 4_096 }).listen(0, "127.0.0.1");
    const host = new WebSocket(`${running.webSocketOrigin}/host`, { headers: { authorization: `Bearer ${relayToken}` } });
    await event(host, "open", "host.open");
    host.send(JSON.stringify({ hostId: "host-0001", kind: "host.register" }));
    expect(JSON.parse(String((await event(host, "message", "host.registered"))[0]))).toEqual({ hostId: "host-0001", kind: "host.registered" });

    const browserOpenNotice = event(host, "message", "host.browser-open");
    const browser = new WebSocket(`${running.webSocketOrigin}/connect?host=host-0001`);
    const connectedMessage = event(browser, "message", "browser.connected");
    await event(browser, "open", "browser.open");
    const connected = JSON.parse(String((await connectedMessage)[0])) as { connectionId: string; kind: string };
    expect(connected.kind).toBe("relay.connected");
    expect(JSON.parse(String((await browserOpenNotice)[0]))).toMatchObject({ connectionId: connected.connectionId, kind: "browser.open" });

    const forwardedMessage = event(host, "message", "host.forwarded");
    browser.send(JSON.stringify({ ciphertext: "opaque-secret", kind: "frame", seq: 1 }));
    const forwarded = JSON.parse(String((await forwardedMessage)[0])) as Record<string, unknown>;
    expect(forwarded).toMatchObject({ connectionId: connected.connectionId, kind: "browser.frame" });
    expect(forwarded.frame).toEqual({ ciphertext: "opaque-secret", kind: "frame", seq: 1 });

    const unauthorized = new WebSocket(`${running.webSocketOrigin}/host`, { headers: { authorization: "Bearer wrong" } });
    const [code] = await event(unauthorized, "close", "unauthorized.close");
    expect(code).toBe(4401);
  });
});
