import { InteractionService } from "../../src/main/application/agents/interaction-service";
import type { A2aGatewayService } from "../../src/main/application/a2a/a2a-gateway-service";
import type { InteractionRecord, InvocationRecord } from "../../src/main/application/ports/a2a-ports";
import type { RuntimeStore } from "../../src/main/application/ports/runtime-store";
import type { EventService } from "../../src/main/application/events/event-service";

const pending: InteractionRecord = {
  createdAt: "2026-07-15T12:00:00.000Z",
  interactionId: "interaction_1",
  invocationId: "invocation_1",
  kind: "input-required",
  prompt: "请选择",
  status: "PENDING",
};

const invocation: InvocationRecord = {
  agentConnectionId: "agent_1",
  contextId: "context_1",
  createdAt: "2026-07-15T12:00:00.000Z",
  invocationId: "invocation_1",
  lastActivityAt: "2026-07-15T12:00:00.000Z",
  messageId: "message_1",
  request: { parts: [] },
  sendAttempts: 1,
  status: "INPUT_REQUIRED",
  updatedAt: "2026-07-15T12:00:00.000Z",
};

function make(interaction: InteractionRecord | null, invocationRecord: InvocationRecord | null = invocation) {
  const store = {
    getInteraction: vi.fn(() => Promise.resolve(interaction)),
    getInvocation: vi.fn(() => Promise.resolve(invocationRecord)),
    listPendingInteractions: vi.fn(() => Promise.resolve(interaction === null ? [] : [interaction])),
    resolveInteraction: vi.fn(() => Promise.resolve({ ...pending, status: "RESOLVED" as const })),
  } as unknown as RuntimeStore;
  const start = vi.fn(() => Promise.resolve(invocation));
  const recover = vi.fn<(invocationId: string) => Promise<InvocationRecord>>(
    () => Promise.resolve({ ...invocation, status: "WORKING" as const, taskId: "task_1" }),
  );
  const gateway = { recover, start } as unknown as A2aGatewayService;
  return { recover, service: new InteractionService({ gateway, store }), start };
}

describe("Interaction Service", () => {
  it("answers a pending input in its exact A2A context then resolves it", async () => {
    const fixture = make(pending);
    await expect(fixture.service.answer("interaction_1", "范围 A")).resolves.toMatchObject({ status: "RESOLVED" });
    expect(fixture.start).toHaveBeenCalledWith(expect.objectContaining({
      agentConnectionId: "agent_1", contextId: "context_1",
    }));
    await expect(fixture.service.listPending()).resolves.toEqual([pending]);
  });

  it("fences missing, stale, auth and contextless interactions", async () => {
    await expect(make(null).service.answer("missing", "x")).rejects.toMatchObject({ code: "interaction_not_found" });
    await expect(make({ ...pending, status: "RESOLVED" }).service.answer("interaction_1", "x"))
      .rejects.toMatchObject({ code: "interaction_stale" });
    await expect(make({ ...pending, kind: "auth-required" }).service.answer("interaction_1", "x"))
      .rejects.toMatchObject({ code: "auth_user_action_required" });
    await expect(make(pending, null).service.answer("interaction_1", "x")).rejects.toMatchObject({ code: "interaction_stale" });
    const contextless: InvocationRecord = { ...invocation };
    delete contextless.contextId;
    await expect(make(pending, contextless).service.answer("interaction_1", "x")).rejects.toMatchObject({ code: "interaction_stale" });
  });

  it("resumes the original Task after the user completes Agent-side authorization", async () => {
    const authInvocation = { ...invocation, status: "AUTH_REQUIRED" as const, taskId: "task_1" };
    const fixture = make({ ...pending, kind: "auth-required" }, authInvocation);
    await expect(fixture.service.resumeAuthorization("interaction_1")).resolves.toMatchObject({ status: "RESOLVED" });
    expect(fixture.recover).toHaveBeenCalledWith("invocation_1");
  });

  it("fences every stale authorization resume state", async () => {
    await expect(make(null).service.resumeAuthorization("missing")).rejects.toMatchObject({ code: "interaction_not_found" });
    await expect(make({ ...pending, kind: "auth-required", status: "RESOLVED" }).service.resumeAuthorization("interaction_1"))
      .rejects.toMatchObject({ code: "interaction_stale" });
    await expect(make(pending).service.resumeAuthorization("interaction_1")).rejects.toMatchObject({ code: "interaction_kind_invalid" });
    await expect(make({ ...pending, kind: "auth-required" }, null).service.resumeAuthorization("interaction_1"))
      .rejects.toMatchObject({ code: "interaction_stale" });
    const withoutTask = { ...invocation, status: "AUTH_REQUIRED" as const };
    await expect(make({ ...pending, kind: "auth-required" }, withoutTask).service.resumeAuthorization("interaction_1"))
      .rejects.toMatchObject({ code: "interaction_stale" });
    const stillRequired = make({ ...pending, kind: "auth-required" }, { ...withoutTask, taskId: "task_1" });
    stillRequired.recover.mockResolvedValueOnce({ ...withoutTask, status: "AUTH_REQUIRED", taskId: "task_1" });
    await expect(stillRequired.service.resumeAuthorization("interaction_1")).rejects.toMatchObject({ code: "auth_still_required" });
  });

  it("persists a scoped human resolution event and notifies the original Life", async () => {
    const authInvocation = { ...invocation, status: "AUTH_REQUIRED" as const, taskId: "task_1" };
    const getInteractionScope = vi.fn<(interactionId: string) => Promise<{ affairId: string; lifeId: string } | null>>(
      () => Promise.resolve({ affairId: "affair_1", lifeId: "life_1" }),
    );
    const store = {
      getInteraction: vi.fn(() => Promise.resolve({ ...pending, kind: "auth-required" as const })),
      getInteractionScope,
      getInvocation: vi.fn(() => Promise.resolve(authInvocation)),
      resolveInteraction: vi.fn(() => Promise.resolve({ ...pending, kind: "auth-required" as const, status: "RESOLVED" as const })),
    } as unknown as RuntimeStore;
    const recover = vi.fn(() => Promise.resolve({ ...authInvocation, status: "WORKING" as const }));
    const ingest = vi.fn(() => Promise.resolve({ eventId: "event_resolution" }));
    const notify = vi.fn();
    const service = new InteractionService({
      events: { ingest } as unknown as EventService,
      gateway: { recover } as unknown as A2aGatewayService,
      notify,
      store,
    });
    await service.resumeAuthorization("interaction_1");
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ affairId: "affair_1", lifeId: "life_1", type: "human.auth_resolved" }));
    expect(notify).toHaveBeenCalledWith("life_1");

    getInteractionScope.mockResolvedValueOnce(null);
    await service.resumeAuthorization("interaction_1");
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});
