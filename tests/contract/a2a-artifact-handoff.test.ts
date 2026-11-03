/* The official transport consumes deterministic HTTP responses without network I/O. */
/* eslint-disable @typescript-eslint/require-await */
import { SdkA2aInvocationTransport } from "../../src/main/infrastructure/a2a/sdk-a2a-invocation-transport.js";
import { OutboundNetworkPolicy } from "../../src/main/infrastructure/a2a/outbound-network-policy.js";
import type { A2aRemoteEvent } from "../../src/main/application/ports/a2a-ports.js";
import type { Artifact, Part } from "@a2a-js/sdk";

const config = { agentConnectionId: "artifact_agent", credentialVersion: 1, origin: "http://agent.lan", rpcUrl: "http://agent.lan/rpc", token: "fixture-token", transport: "JSONRPC" as const };
const handoff = { version: 1, conclusion: "PRIVATE_ARTIFACT_HANDOFF", requirementIds: [], evidenceResultIds: [], artifactRefs: [], unresolved: [], conflicts: [] };
const artifact: Artifact = { artifactId: "remote_report", name: "report.md", parts: [
  { kind: "text", text: "First section. " }, { kind: "data", data: { joiWorkHandoff: handoff } }, { kind: "text", text: "Last section." },
  { kind: "file", file: { name: "report.txt", mimeType: "text/plain", uri: "http://agent.lan/files/report" } },
] };
const artifactEvent = { kind: "artifact-update", artifact, contextId: "artifact_context", taskId: "artifact_task" };
const finalEvent = { kind: "status-update", contextId: "artifact_context", taskId: "artifact_task", final: true, status: { state: "completed" } };

function transportFixture(parts: Part[] = artifact.parts) {
  const selectedArtifact = { ...artifact, parts };
  const methods: string[] = [];
  const fetchImpl: typeof fetch = async (_resource, init) => {
    if (typeof init?.body !== "string") throw new Error("a2a_fixture_request_invalid");
    const request = JSON.parse(init.body) as { id: unknown; method: string };
    methods.push(request.method);
    if (request.method === "message/stream" || request.method === "tasks/resubscribe") {
      return new Response([{ ...artifactEvent, artifact: selectedArtifact }, finalEvent].map(result => `data: ${JSON.stringify({ id: request.id, jsonrpc: "2.0", result })}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ id: request.id, jsonrpc: "2.0", result: { kind: "task", id: "artifact_task", contextId: "artifact_context",
      status: { state: request.method === "tasks/cancel" ? "canceled" : "completed" }, artifacts: [selectedArtifact] } }), { headers: { "content-type": "application/json" } });
  };
  return { methods, transport: new SdkA2aInvocationTransport({ fetchImpl, policy: new OutboundNetworkPolicy({ resolve: async () => ["127.0.0.1"] }) }) };
}

describe("A2A artifact semantic handoff transport", () => {
  it("preserves private artifact data alongside unchanged text and file references", async () => {
    const { transport } = transportFixture();
    const events: A2aRemoteEvent[] = [];
    for await (const event of transport.sendStream({ config, request: { invocationId: "artifact_invocation", messageId: "artifact_message", parts: [] }, token: "fixture-token" })) events.push(event);
    expect(events[0]).toMatchObject({ kind: "artifact", artifactId: "remote_report", filename: "report.txt", mimeType: "text/plain", url: "http://agent.lan/files/report",
      output: { artifacts: [{ name: "report.md", text: "First section. Last section." }], parts: [{ kind: "data", data: { joiWorkHandoff: handoff } }] } });
    expect(JSON.stringify(events[0]?.output?.artifacts)).not.toContain("PRIVATE_ARTIFACT_HANDOFF");
  });

  it("does not fabricate a text artifact for a metadata-only completion", async () => {
    const { transport } = transportFixture([{ kind: "data", data: { joiWorkHandoff: handoff } }]);
    const recovered = await transport.getTask({ config, taskId: "artifact_task" });
    expect(recovered.output).toEqual({ artifacts: [], parts: [{ kind: "data", data: { joiWorkHandoff: handoff } }] });
  });

  it("retains the existing inline-file size calculation beside private data", async () => {
    const { transport } = transportFixture([{ kind: "data", data: { joiWorkHandoff: handoff } },
      { kind: "file", file: { name: "payload.bin", mimeType: "application/octet-stream", bytes: Buffer.from("file").toString("base64") } }]);
    const events: A2aRemoteEvent[] = [];
    for await (const event of transport.sendStream({ config, request: { invocationId: "bytes_invocation", messageId: "bytes_message", parts: [] }, token: "fixture-token" })) events.push(event);
    expect(events[0]).toMatchObject({ kind: "artifact", filename: "payload.bin", mimeType: "application/octet-stream", size: 4,
      output: { artifacts: [], parts: [{ kind: "data", data: { joiWorkHandoff: handoff } }] } });
    expect(events[0] !== undefined && "url" in events[0]).toBe(false);
  });

  it("preserves the same metadata on task recovery, cancellation and resubscription", async () => {
    const { methods, transport } = transportFixture();
    const recovered = await transport.getTask({ config, taskId: "artifact_task" });
    const canceled = await transport.cancelTask({ config, taskId: "artifact_task" });
    const subscribed: A2aRemoteEvent[] = [];
    for await (const event of transport.resubscribe({ config, taskId: "artifact_task" })) subscribed.push(event);
    const expected = { artifacts: [{ name: "report.md", text: "First section. Last section." }], parts: [{ kind: "data", data: { joiWorkHandoff: handoff } }] };
    expect(recovered).toMatchObject({ kind: "task", state: "completed", output: expected });
    expect(canceled).toMatchObject({ kind: "task", state: "canceled", output: expected });
    expect(subscribed[0]?.output).toEqual(expected);
    expect(methods).toEqual(["tasks/get", "tasks/cancel", "tasks/resubscribe"]);
  });
});
