import { A2aAgentDiscovery } from "../../src/main/infrastructure/a2a/a2a-agent-discovery";
import { OutboundNetworkPolicy } from "../../src/main/infrastructure/a2a/outbound-network-policy";
import { RUNTIME_EXTENSION_URI } from "../../src/shared/product";

function agentCard(overrides: Record<string, unknown> = {}) {
  return {
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    description: "AI Mana Agent",
    name: "主 Agent",
    preferredTransport: "JSONRPC",
    protocolVersion: "0.3.0",
    security: [{ bearerAuth: [] }],
    securitySchemes: { bearerAuth: { scheme: "bearer", type: "http" } },
    skills: [{ description: "计划", id: "planning", name: "planning", tags: ["planning"] }],
    url: "http://agent.lan/rpc",
    version: "1.0.0",
    ...overrides,
  };
}

function discovery(fetchImpl: typeof fetch) {
  return new A2aAgentDiscovery({
    fetchImpl,
    policy: new OutboundNetworkPolicy({
      resolve: (hostname) => Promise.resolve(hostname === "agent.lan" ? ["192.168.1.20"] : ["192.168.1.21"]),
    }),
  });
}

describe("A2A 0.3 Card and readiness discovery", () => {
  it("uses anonymous Card fetch then SDK streaming readiness with Bearer confined to the RPC Origin", async () => {
    const requests: { authorization: string | null; method: string; url: string }[] = [];
    const fakeFetch: typeof fetch = (resource, init) => {
      const url = resource instanceof Request ? resource.url : resource.toString();
      const headers = new Headers(init?.headers);
      requests.push({ authorization: headers.get("authorization"), method: init?.method ?? "GET", url });
      if (url.endsWith("card.json")) {
        return Promise.resolve(new Response(JSON.stringify(agentCard()), { headers: { "content-type": "application/json" } }));
      }
      const message = {
        contextId: "readiness-context",
        extensions: [RUNTIME_EXTENSION_URI],
        kind: "message",
        messageId: "readiness-response",
        parts: [{
          data: {
            actionId: "ready_1",
            kind: "readiness_ack",
            noSideEffects: true,
            supportedActions: [
              "express", "memory.append", "memory.revise", "affair.upsert", "todo.upsert",
              "alarm.schedule", "alarm.cancel", "delegate", "interaction.answer", "sleep",
            ],
            version: 1,
          },
          kind: "data",
        }],
        role: "agent",
      };
      const rpc = { id: 1, jsonrpc: "2.0", result: message };
      return Promise.resolve(new Response(`data: ${JSON.stringify(rpc)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    };
    const fetchImpl = vi.fn(fakeFetch);
    const result = await discovery(fetchImpl).validate({
      cardUrl: "http://agent.lan/card.json",
      expectedActionId: "ready_1",
      token: "secret-token",
    });
    expect(result).toMatchObject({ card: { protocolVersion: "0.3.0", transport: "JSONRPC" }, readiness: { supported: true } });
    expect(requests[0]).toMatchObject({ authorization: null, url: "http://agent.lan/card.json" });
    expect(requests[1]).toMatchObject({ authorization: "Bearer secret-token", url: "http://agent.lan/rpc" });
  });

  it("detects sensitive Card drift before any Bearer request", async () => {
    const authorizations: (string | null)[] = [];
    const fakeFetch: typeof fetch = (_resource, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Promise.resolve(new Response(JSON.stringify(agentCard({ url: "http://other.lan/rpc" })), { headers: { "content-type": "application/json" } }));
    };
    const fetchImpl = vi.fn(fakeFetch);
    const previous = (await discovery(() => Promise.resolve(new Response(JSON.stringify(agentCard()), { headers: { "content-type": "application/json" } }))).validate({
      cardUrl: "http://agent.lan/card.json",
      expectedActionId: "ignored",
      token: "ignored",
    })).card;
    const result = await discovery(fetchImpl).validate({
      cardUrl: "http://agent.lan/card.json",
      confirmedCard: previous,
      expectedActionId: "ready_2",
      token: "must-not-leave",
    });
    expect(result.readiness.supported).toBe(false);
    expect(result.card.origin).toBe("http://other.lan");
    expect(authorizations).toEqual([null]);
  });

  it("rejects unsupported protocol and missing Bearer declaration", async () => {
    await expect(discovery(() => Promise.resolve(new Response(JSON.stringify(agentCard({ protocolVersion: "1.0.0" }))))).validate({
      cardUrl: "http://agent.lan/card.json", expectedActionId: "ready", token: "secret",
    })).rejects.toMatchObject({ code: "agent_protocol_unsupported" });
    await expect(discovery(() => Promise.resolve(new Response(JSON.stringify(agentCard({ securitySchemes: {} }))))).validate({
      cardUrl: "http://agent.lan/card.json", expectedActionId: "ready", token: "secret",
    })).rejects.toMatchObject({ code: "agent_auth_failed" });
  });
});
