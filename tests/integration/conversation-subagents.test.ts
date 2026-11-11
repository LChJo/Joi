import { createRuntimeFixture } from "../support/runtime-fixture.js";
import { SqliteConversationStore } from "../../src/main/infrastructure/persistence/sqlite-conversation-store.js";
import { SqliteConversationSubagentStore } from "../../src/main/infrastructure/persistence/sqlite-conversation-subagent-store.js";
import { ConversationSubagentService } from "../../src/main/application/joi/conversation-subagent-service.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import type { ConversationChild } from "../../src/main/application/ports/conversation-subagents.js";

it("CHAT-22 persists idempotent child intent, inherits the frozen parent and waits for settlement",async () => {
  const f = await createRuntimeFixture();
  try {
    const wb = await f.workbenchRegistry.create({ name: "Children",personaSummary: "Help",projectLabel: "Children",scopeSummary: "Help" });
    const parent = new SqliteConversationStore(f.database);
    const added = await f.partners.add({ displayName: "Helper",capabilities: [],kind: "local-pi",tools: [],skills: [] });
    const revision = await new SqlitePartnerRegistryRepository(f.database).getActive(added.partnerId);
    if (revision === null) throw new Error("Missing revision");
    await parent.submit({ conversationId: "chat",workbenchId: wb.workbenchId,turnId: "parent",requestId: "parent",text: "Help",at: f.clock.now().toISOString(),revision,
      config: { partnerId: revision.partnerId,partnerName: "Helper",networkId: "s",networkName: "Network",modelName: "m",skills: [],attachmentIds: [] } });
    await parent.begin("parent");
    const finish = Promise.withResolvers<undefined>();
    const execute = vi.fn(async (_child: ConversationChild) => { await finish.promise;return "CHILD_RESULT"; });
    const store = new SqliteConversationSubagentStore(f.database);
    const service = new ConversationSubagentService({ clock: f.clock,ids: f.ids,store,execute });
    const input = { parentTurnId: "parent",callId: "call",task: "Inspect",revision,
      request: { actionId: "parent",workId: "parent",workbenchId: wb.workbenchId,contextSnapshotId: "snapshot",taskProjection: "Help",conversationId: "chat",workspaceExecution: { accessCeiling: "READ" as const,phase: "READ_RUNNING" as const,generation: 1 } },
      sourcePin: { turnId: "parent",modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" } };
    const child = await service.start(input);expect(await service.start(input)).toEqual(child);
    expect(f.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='conversation.subagent'").get()?.n)).toBe(1);
    const delivery = service.deliver(child.childId);
    let settled = false;const wait = service.settle("parent").then(() => { settled = true; });
    await Promise.resolve();expect(settled).toBe(false);
    finish.resolve(undefined);await delivery;await wait;
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ ...input,childId: child.childId });
    expect(await service.list("parent")).toMatchObject([{ childId: child.childId,status: "COMPLETED",body: "CHILD_RESULT" }]);
    await service.deliver(child.childId);expect(execute).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

it("CHAT-22 cancels queued children, waits for running cleanup and never replays interrupted children",async () => {
  const f = await createRuntimeFixture();
  const cleanup = Promise.withResolvers<undefined>(),started = Promise.withResolvers<undefined>();
  let service: ConversationSubagentService | undefined;
  try {
    const wb = await f.workbenchRegistry.create({ name: "Cancel",personaSummary: "Help",projectLabel: "Cancel",scopeSummary: "Help" });
    const parent = new SqliteConversationStore(f.database),store = new SqliteConversationSubagentStore(f.database);
    const added = await f.partners.add({ displayName: "Helper",capabilities: [],kind: "local-pi",tools: [],skills: [] });
    const revision = await new SqlitePartnerRegistryRepository(f.database).getActive(added.partnerId);if (revision === null) throw new Error("Missing revision");
    await parent.submit({ conversationId: "chat",workbenchId: wb.workbenchId,turnId: "parent",requestId: "parent",text: "Help",at: f.clock.now().toISOString(),revision,
      config: { partnerId: revision.partnerId,partnerName: "Helper",networkId: "s",networkName: "Network",modelName: "m",skills: [],attachmentIds: [] } });await parent.begin("parent");
    const execute = vi.fn(async (_child: ConversationChild,signal: AbortSignal) => { started.resolve(undefined);await cleanup.promise;expect(signal.aborted).toBe(true);return "Partial result"; });
    service = new ConversationSubagentService({ clock: f.clock,ids: f.ids,store,execute });
    const input = { parentTurnId: "parent",callId: "queued",task: "Inspect",revision,request: { actionId: "parent",workId: "parent",workbenchId: wb.workbenchId,contextSnapshotId: "snapshot",taskProjection: "Help" },sourcePin: { turnId: "parent",modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" } };
    await expect(service.start({ ...input,task: " " })).rejects.toMatchObject({ code: "subagent_task_invalid" });
    const queued = await service.start(input);await service.cancel("parent",queued.childId);await service.deliver(queued.childId);expect(execute).not.toHaveBeenCalled();
    await expect(service.start({ ...input,task: "Conflicting request" })).rejects.toMatchObject({ code: "subagent_request_conflict" });
    const running = await service.start({ ...input,callId: "running" });const delivery = service.deliver(running.childId);await started.promise;
    await service.cancel("foreign",running.childId);expect((await store.get(running.childId))?.status).toBe("RUNNING");
    await service.cancel("parent",running.childId);expect((await store.get(running.childId))?.status).toBe("RUNNING");
    let settled = false;const settling = service.settle("parent").then(() => { settled = true; });await Promise.resolve();expect(settled).toBe(false);
    cleanup.resolve(undefined);await delivery;await settling;expect((await store.get(running.childId))?.status).toBe("CANCELED");
    const claim = store.claim.bind(store);
    vi.spyOn(store,"claim").mockImplementationOnce(async id => {
      const admitted = await claim(id);await service?.cancel("parent",id);return admitted;
    });
    const canceledDuringAdmission = await service.start({ ...input,callId: "cancel-on-admission" });
    await service.deliver(canceledDuringAdmission.childId);
    expect((await store.get(canceledDuringAdmission.childId))?.status).toBe("CANCELED");expect(execute).toHaveBeenCalledTimes(1);
    await service.deliver("missing");
    const interrupted = await service.start({ ...input,callId: "interrupted" });await store.claim(interrupted.childId);await store.recover();
    await service.deliver(interrupted.childId);expect((await store.get(interrupted.childId))?.status).toBe("INTERRUPTED");expect(execute).toHaveBeenCalledTimes(1);
    await service.close();await expect(service.start({ ...input,callId: "closed" })).rejects.toMatchObject({ code: "conversation_stopped" });
    await service.deliver(canceledDuringAdmission.childId);expect(execute).toHaveBeenCalledTimes(1);
  } finally { cleanup.resolve(undefined);await service?.close();await f.close(); }
});
