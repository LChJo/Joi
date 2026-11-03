import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RemotePeerTransportEvent } from "../../src/main/application/ports/remote-access.js";
import { IrohSidecarTransport } from "../../src/main/infrastructure/remote/iroh-sidecar-transport.js";

describe("IrohSidecarTransport", () => {
  it("exchanges bounded targeted frames over the private stdio bridge", async () => {
    const transport = new IrohSidecarTransport(process.execPath, [path.resolve("tests/fixtures/fake-iroh-sidecar.mjs")]);
    const events: RemotePeerTransportEvent[] = [];
    transport.subscribe((event) => events.push(event));

    await expect(transport.start({
      nodeSecret: Buffer.alloc(32, 9).toString("base64"),
      relayUrl: "https://relay.example.com",
    })).resolves.toEqual({
      directAddresses: ["192.0.2.20:49152"],
      endpointId: "fixture-endpoint",
      relayUrls: ["https://relay.example.com/"],
      version: 1,
    });
    await transport.send("phone-a", { kind: "encrypted", seq: 1 });
    await vi.waitFor(() => expect(events).toContainEqual({ connectionId: "phone-a", type: "peerOpen" }));
    expect(events).toContainEqual({
      connectionId: "phone-a",
      frame: { kind: "encrypted", seq: 1 },
      type: "peerFrame",
    });
    await transport.disconnect("phone-a");
    await vi.waitFor(() => expect(events).toContainEqual({ connectionId: "phone-a", type: "peerClose" }));
    await transport.close();
  });
});
