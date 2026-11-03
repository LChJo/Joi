import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import type { AuthService } from "../../src/main/application/auth/auth-service.js";
import type { RemoteAccessControl } from "../../src/main/application/ports/remote-access.js";
import { createApiHandler, type ApiDependencies } from "../../src/main/interfaces/http/api-handler.js";

async function withApi(kind: "desktop" | "lan", run: (origin: string, remote: RemoteAccessControl) => Promise<void>) {
  const status = {
    devices: [], enabled: true, hostId: "host-0001", relayAuthenticationConfigured: true,
    relayUrl: "https://remote.example.com", status: "connected" as const,
  };
  const remote: RemoteAccessControl = {
    close: () => Promise.resolve(), createPairing: vi.fn().mockResolvedValue({ expiresAt: "2026-08-26T00:10:00.000Z", pairingId: "pair-1", qrUrl: "https://remote.example.com/remote/#secret=hidden" }),
    revokeDevice: vi.fn().mockResolvedValue(undefined), start: () => Promise.resolve(), status: vi.fn().mockResolvedValue(status),
    update: vi.fn().mockResolvedValue(status),
  };
  const auth = {
    authenticate: vi.fn().mockResolvedValue({ kind }),
    verifyWrite: vi.fn().mockResolvedValue({ kind }),
  } as unknown as AuthService;
  const handler = createApiHandler({ auth, remoteAccess: remote } as unknown as ApiDependencies);
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try { await run(`http://127.0.0.1:${String(address.port)}`, remote); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
}

describe("browser remote access HTTP", () => {
  it("allows desktop management without returning relay or pairing secrets", async () => {
    await withApi("desktop", async (origin, remote) => {
      const headers = { cookie: "digital_life_session=session", origin, "x-csrf-token": "csrf" };
      const current = await fetch(`${origin}/api/v1/remote`, { headers });
      expect(current.status).toBe(200);
      expect(await current.text()).not.toContain("secret");

      const updated = await fetch(`${origin}/api/v1/remote`, {
        body: JSON.stringify({ enabled: true, relayAuthentication: "relay-secret-at-least-32-characters", relayUrl: "https://remote.example.com" }),
        headers: { ...headers, "content-type": "application/json" }, method: "POST",
      });
      expect(updated.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(remote.update).toHaveBeenCalledWith(expect.objectContaining({ relayAuthentication: "relay-secret-at-least-32-characters" }));
      expect(await updated.text()).not.toContain("relay-secret-at-least-32-characters");

      expect((await fetch(`${origin}/api/v1/remote/pairings`, { headers, method: "POST" })).status).toBe(201);
      expect((await fetch(`${origin}/api/v1/remote/devices/device-1`, { headers, method: "DELETE" })).status).toBe(200);
    });
  });

  it("rejects remote management from an authenticated LAN browser", async () => {
    await withApi("lan", async (origin) => {
      const response = await fetch(`${origin}/api/v1/remote`, { headers: { cookie: "digital_life_session=session" } });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "desktop_required" });
    });
  });
});
