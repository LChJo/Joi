import { DelegationService } from "../../src/main/application/agents/delegation-service";
import type { A2aGatewayService } from "../../src/main/application/a2a/a2a-gateway-service";
import type { ArtifactReadPort } from "../../src/main/application/ports/managed-file-ports";
import type { EventService } from "../../src/main/application/events/event-service";
import type { DelegationRecord } from "../../src/main/application/ports/continuity-ports";
import type { InvocationRecord, InvocationStatus } from "../../src/main/application/ports/a2a-ports";
import type { RuntimeStore } from "../../src/main/application/ports/runtime-store";

const delegation: DelegationRecord = {
  affairId: "affair_1",
  agentConnectionId: "agent_2",
  createdAt: "2026-07-15T12:00:00.000Z",
  delegationId: "delegation_1",
  lifeId: "life_1",
  sourceWakeId: "wake_1",
  status: "PENDING",
  task: "调研",
  title: "方案调研",
  updatedAt: "2026-07-15T12:00:00.000Z",
};

function invocation(status: InvocationStatus): InvocationRecord {
  return {
    agentConnectionId: "agent_2",
    createdAt: "2026-07-15T12:00:00.000Z",
    invocationId: "invocation_1",
    lastActivityAt: "2026-07-15T12:00:00.000Z",
    messageId: "message_1",
    request: { parts: [] },
    sendAttempts: 1,
    status,
    updatedAt: "2026-07-15T12:00:00.000Z",
  };
}

function service(status: InvocationStatus, initial: DelegationRecord | null = delegation, artifacts?: ArtifactReadPort) {
  const updateDelegation = vi.fn((input: { invocationId?: string; status: DelegationRecord["status"] }) => Promise.resolve({
    ...delegation,
    ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId }),
    status: input.status,
  }));
  const store = {
    getDelegation: vi.fn(() => Promise.resolve(initial)),
    listInvocationArtifacts: vi.fn(() => Promise.resolve([])),
    updateDelegation,
  } as unknown as RuntimeStore;
  const ingest = vi.fn((input: { affairId?: string; payload: Record<string, unknown>; type: string }) =>
    Promise.resolve({ eventId: "event_result", input }));
  const events = { ingest } as unknown as EventService;
  const startWithResult = vi.fn(() => Promise.resolve({
      invocation: invocation(status),
      output: {
        artifacts: [{ name: "report.txt", text: "artifact summary" }],
        parts: [{ data: "text summary", kind: "text" }, { data: { ignored: true }, kind: "data" }],
      },
    }));
  const gateway = { startWithResult } as unknown as A2aGatewayService;
  const notify = vi.fn();
  return { ingest, notify, service: new DelegationService({
    ...(artifacts === undefined ? {} : { artifacts }),
    clock: { now: () => new Date("2026-07-15T12:00:00.000Z") }, events, gateway, notify, store,
  }), startWithResult, updateDelegation };
}

describe("Delegation Service", () => {
  it.each([
    ["COMPLETED", "COMPLETED", "agent.completed"],
    ["INPUT_REQUIRED", "WAITING_INPUT", "agent.input_required"],
    ["AUTH_REQUIRED", "WAITING_AUTH", "agent.auth_required"],
    ["FAILED", "FAILED", "agent.failed"],
    ["CANCELED", "FAILED", "agent.failed"],
    ["UNKNOWN_REQUIRES_REVIEW", "FAILED", "agent.failed"],
  ] as const)("normalizes %s into %s and a LifeEvent", async (invocationStatus, delegationStatus, eventType) => {
    const fixture = service(invocationStatus);
    await expect(fixture.service.dispatch("delegation_1")).resolves.toMatchObject({ status: delegationStatus });
    expect(fixture.ingest).toHaveBeenCalledWith(expect.objectContaining({ affairId: "affair_1", type: eventType }));
    expect(fixture.ingest.mock.calls[0]?.[0].payload).toMatchObject({ summary: expect.stringContaining("artifact summary") as unknown });
    expect(fixture.notify).toHaveBeenCalledWith("life_1");
  });

  it("retries nonterminal results, rejects missing ids and no-ops terminal delegations", async () => {
    await expect(service("WAITING_RETRY").service.dispatch("delegation_1")).rejects.toMatchObject({ code: "delegation_retry" });
    await expect(service("COMPLETED", null).service.dispatch("missing")).rejects.toMatchObject({ code: "delegation_not_found" });
    const terminal = service("COMPLETED", { ...delegation, status: "COMPLETED" });
    await expect(terminal.service.dispatch("delegation_1")).resolves.toMatchObject({ status: "COMPLETED" });
    expect(terminal.startWithResult).not.toHaveBeenCalled();
  });

  it("forwards only explicitly referenced and revalidated Artifacts", async () => {
    const read = vi.fn(() => Promise.resolve({
      bytes: new TextEncoder().encode("trusted"), filename: "report.txt", mimeType: "text/plain",
    }));
    const artifacts = { read } as unknown as ArtifactReadPort;
    const fixture = service("COMPLETED", { ...delegation, artifactIds: ["artifact_1"] }, artifacts);
    await fixture.service.dispatch("delegation_1");
    expect(read).toHaveBeenCalledWith({ artifactId: "artifact_1", lifeId: "life_1", preview: false });
    expect(fixture.startWithResult).toHaveBeenCalledWith(expect.objectContaining({
      parts: expect.arrayContaining([
        expect.objectContaining({ bytes: Buffer.from("trusted").toString("base64"), kind: "file", name: "report.txt" }),
      ]) as unknown,
    }));
  });
});
