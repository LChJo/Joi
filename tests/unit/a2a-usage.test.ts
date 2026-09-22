/* Deterministic asynchronous transport fixtures perform no network I/O. */
/* eslint-disable @typescript-eslint/require-await */
import type { UsageContext, UsageObservation, UsageRecorder, UsageSession } from "../../src/main/application/ports/usage.js";

const transportFixture = vi.hoisted(() => ({ fail: false, remoteFailed: false }));

vi.mock("@a2a-js/sdk/client", () => {
  class FakeTransport {
    async *sendMessageStream() {
      if (transportFixture.fail) throw new Error("remote failed");
      if (transportFixture.remoteFailed) { yield { kind: "status-update", contextId: "ctx", taskId: "task", final: true, status: { state: "failed" } }; return; }
      yield { kind: "message", messageId: "reply", role: "agent", parts: [{ kind: "text", text: "done" }] };
    }
    async getTask() { throw new Error("not used"); }
    async cancelTask() { throw new Error("not used"); }
    async *resubscribeTask() { /* not used */ }
  }
  return { JsonRpcTransport: FakeTransport, RestTransport: FakeTransport };
});

import { SdkA2aInvocationTransport } from "../../src/main/infrastructure/a2a/sdk-a2a-invocation-transport.js";

class RecordingUsageRecorder implements UsageRecorder {
  readonly sessions: { context: UsageContext; observations: UsageObservation[]; statuses: string[] }[] = [];
  begin(context: UsageContext): UsageSession {
    const captured = { context, observations: [] as UsageObservation[], statuses: [] as string[] };
    this.sessions.push(captured);
    return { id: `a2a-${String(this.sessions.length)}`, record: (value) => { captured.observations.push(value); }, finish: (status) => { captured.statuses.push(status); } };
  }
}

const config = { agentConnectionId: "agent-1", credentialVersion: 1, origin: "https://agent.test", rpcUrl: "https://agent.test/rpc", token: "fixture", transport: "JSONRPC" as const };
const request = { invocationId: "invocation-1", messageId: "message-1", parts: [{ kind: "text" as const, text: "fixture" }] };
const policy = {
  validate: async (url: string) => ({ origin: "https://agent.test", url }),
  validateRedirect: async ({ location }: { location: string }) => ({ origin: "https://agent.test", url: location }),
};

describe("A2A usage capture", () => {
  afterEach(() => { transportFixture.fail = false; transportFixture.remoteFailed = false; });

  it("records an explicit unknown observation without inventing remote usage fields", async () => {
    const usage = new RecordingUsageRecorder();
    const transport = new SdkA2aInvocationTransport({ policy: policy as never, usage });

    for await (const event of transport.sendStream({ config, request, token: "fixture" })) { void event; }

    expect(usage.sessions).toEqual([{
      context: { engine: "a2a", purpose: "partner", sourceId: "agent-1", sourceName: "A2A" },
      observations: [{ key: "result", sourceId: "agent-1", sourceName: "A2A", tokens: null }],
      statuses: ["completed"],
    }]);
  });

  it("finishes failed A2A streams while retaining the unknown record", async () => {
    transportFixture.fail = true;
    const usage = new RecordingUsageRecorder();
    const transport = new SdkA2aInvocationTransport({ policy: policy as never, usage });

    await expect(async () => {
      for await (const event of transport.sendStream({ config, request, token: "fixture" })) { void event; }
    }).rejects.toThrow("remote failed");

    expect(usage.sessions[0]?.observations[0]?.tokens).toBeNull();
    expect(usage.sessions[0]?.statuses).toEqual(["failed"]);
  });

  it("attributes trusted work metadata and finishes an early consumer stop", async () => {
    const usage = new RecordingUsageRecorder();
    const transport = new SdkA2aInvocationTransport({ policy: policy as never, usage });
    const scoped = { ...request, parts: [{ kind: "data" as const, data: { sourceBoundary: "joi-work", workbenchId: "wb", workId: "work" } }] };
    for await (const event of transport.sendStream({ config, request: scoped, token: "fixture" })) { void event; break; }
    expect(usage.sessions[0]?.context).toMatchObject({ workbenchId: "wb", workId: "work" });
    expect(usage.sessions[0]?.statuses).toEqual(["interrupted"]);
  });
  it("records a reported remote failure even if the HTTP stream itself succeeded", async () => {
    transportFixture.remoteFailed = true;
    const usage = new RecordingUsageRecorder();
    const transport = new SdkA2aInvocationTransport({ policy: policy as never, usage });
    for await (const event of transport.sendStream({ config, request, token: "fixture" })) { void event; }
    expect(usage.sessions[0]?.statuses).toEqual(["failed"]);
  });
});
