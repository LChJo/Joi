/* Async engine doubles implement Promise-returning execution ports. */
/* eslint-disable @typescript-eslint/require-await */
import { createRuntimeFixture } from "../support/runtime-fixture";
import { ConversationService } from "../../src/main/application/joi/conversation-service";
import { SqliteConversationStore } from "../../src/main/infrastructure/persistence/sqlite-conversation-store";
import { SqliteConversationSubagentStore } from "../../src/main/infrastructure/persistence/sqlite-conversation-subagent-store";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository";
import { SqliteWorkbenchContextRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-context-repository";
import { SqliteWorkspaceLeaseManager } from "../../src/main/infrastructure/persistence/sqlite-workspace-lease-manager";
import type { PartnerInstanceManager } from "../../src/main/application/partners/partner-instance-manager";
import type { PartnerRunResult } from "../../src/main/application/ports/partner-execution";
import { DomainError } from "../../src/main/domain/errors";
import { wrapPartnerRunFailure } from "../../src/main/application/partners/partner-run-failure";

async function setup(run: PartnerInstanceManager["dispatch"]) {
  const f = await createRuntimeFixture();
  const wb = await f.workbenchRegistry.create({ name: "Chat",personaSummary: "Help",projectLabel: "Chat",scopeSummary: "Help" });
  await f.workbenchWorkspaces.bindExisting(wb.workbenchId,f.root);
  const partner = await f.partners.add({ capabilities: [],displayName: "Helper",kind: "local-pi",skills: [],tools: [] });
  const store = new SqliteConversationStore(f.database);
  const leases = new SqliteWorkspaceLeaseManager({ clock: f.clock,database: f.database });
  const dependencies: ConstructorParameters<typeof ConversationService>[0] = { clock: f.clock,ids: f.ids,store,workbenches: f.workbenches,
    workspaces: { getWorkspace: async () => ({ workspaceRef: `workbench_workspace:${wb.workbenchId}`,kind: "BOUND",status: "READY",displayName: "fixture" }) },
    contexts: new SqliteWorkbenchContextRepository(f.database),revisions: new SqlitePartnerRegistryRepository(f.database),instances: { dispatch: run },
    networks: { list: async () => [{ sourceId: "network",displayName: "Network",activeModel: { id: "model" },status: "READY" }] },
    skills: { validateRefs: () => undefined },inheritance: { read: async () => ({ memoryCount: 0,evolutionRevisionId: null,instructions: "" }) } };
  const service = new ConversationService(dependencies);
  const input = { conversationId: "chat",workbenchId: wb.workbenchId,partnerId: partner.partnerId,networkId: "network",skills: [],attachmentIds: [],requestId: "request",text: "Hello" };
  const accept = async () => {
    const result = await service.send(input);const turn = result.turns[0];if (turn === undefined) throw new Error("Missing turn");return turn;
  };
  return { f,service,store,leases,input,accept,dependencies };
}

describe("normal conversation execution", () => {
  it("CHAT-04/45 publishes safe committed prefixes and completion without coupling execution to observers",async () => {
    const paused = Promise.withResolvers<undefined>(),finish = Promise.withResolvers<PartnerRunResult>();
    const { f,service,accept } = await setup(async input => {
      await input.onConversation?.({ instanceId: "instance",conversation: () => [{ kind: "MARKDOWN",role: "AGENT",text: "First token=synthetic-secret" }] });
      paused.resolve(undefined);return finish.promise;
    });
    let delivery: Promise<void> | undefined;
    const receive = vi.fn();
    try {
      const turn = await accept();
      const unsubscribe = service.subscribe("chat",receive);
      service.subscribe("chat",() => { throw new Error("Synthetic observer failure"); });
      delivery = service.deliver(turn.turnId);await paused.promise;
      expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: "chat",turn: expect.objectContaining({ status: "RUNNING",entries: [expect.objectContaining({ text: "First token=[redacted]" })] }) as unknown }));
      expect(JSON.stringify(receive.mock.calls)).not.toContain("synthetic-secret");
      finish.resolve({ actionId: "turn",workId: "turn",externalRunId: "run",status: "COMPLETED",body: "First",artifacts: [] });await delivery;
      expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ turn: expect.objectContaining({ status: "COMPLETED" }) as unknown }));
      unsubscribe();const count = receive.mock.calls.length;await service.stop("chat");expect(receive).toHaveBeenCalledTimes(count);
    } finally {
      finish.resolve({ actionId: "turn",workId: "turn",externalRunId: "run",status: "COMPLETED",body: "First",artifacts: [] });
      await delivery;service.close();await f.close();
    }
  });
  it("CHAT-04 flushes the last buffered prefix while generation is paused",async () => {
    const paused = Promise.withResolvers<undefined>(),finish = Promise.withResolvers<PartnerRunResult>();
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async input => {
      await input.onConversation?.({ instanceId: "instance",conversation: () => [{ kind: "MARKDOWN",role: "AGENT",text: "First" }] });
      f.clock.advance(20);
      await input.onConversation?.({ instanceId: "instance",conversation: () => [{ kind: "MARKDOWN",role: "AGENT",text: "First and buffered tail" }] });
      paused.resolve(undefined);
      return finish.promise;
    });
    const { f,service,accept } = await setup(run);
    let delivery: Promise<void> | undefined;
    try {
      const turn = await accept();vi.useFakeTimers();delivery = service.deliver(turn.turnId);await paused.promise;
      await vi.advanceTimersByTimeAsync(150);
      expect((await service.get("chat")).turns[0]).toMatchObject({ status: "RUNNING",entries: [expect.objectContaining({ text: "First and buffered tail" })] });
    } finally {
      finish.resolve({ actionId: "turn",workId: "turn",externalRunId: "run",status: "COMPLETED",body: "First and buffered tail",artifacts: [] });
      await delivery;vi.useRealTimers();service.close();await f.close();
    }
  });
  it("CHAT-44 rejects invalid titles and identities without changing history",async () => {
    const { f,service,store,accept } = await setup(vi.fn());
    try {
      await accept();const original = await service.get("chat");
      for (const title of ["","  ","a".repeat(81),"one\ntwo","bad\u0000title",null,42]) {
        await expect(service.rename("chat",title as string)).rejects.toMatchObject({ code: "conversation_title_invalid" });
      }
      expect(await service.get("chat")).toEqual(original);
      await expect(service.rename("../chat","Title")).rejects.toMatchObject({ code: "conversation_identity_invalid" });
      await expect(service.rename("missing","Title")).rejects.toMatchObject({ code: "conversation_not_found" });
      await store.stop("chat");await service.archive("chat");
      await expect(service.rename("chat","a".repeat(80))).resolves.toMatchObject({ title: "a".repeat(80),archivedAt: f.clock.now().toISOString() });
      await service.delete("chat");
      await expect(service.rename("chat","Title")).rejects.toMatchObject({ code: "conversation_not_found" });
    } finally { await f.close(); }
  });
  it("CHAT-44 persists a renamed title during generation and keeps it across restoration and later turns",async () => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>();
    const { f,service,store,input,accept,dependencies } = await setup(run);
    try {
      const turn = await accept();
      const original = await service.get("chat");
      const renamed = await service.rename("chat","  项目讨论  ");
      expect(renamed).toMatchObject({ conversationId: "chat",title: "项目讨论" });
      expect((await service.list()).items[0]?.title).toBe("项目讨论");
      expect((await new ConversationService(dependencies).get("chat")).turns).toEqual(original.turns);
      expect((await new SqliteConversationStore(f.database).get("chat"))?.title).toBe("项目讨论");
      f.clock.advance(1000);
      expect(await service.rename("chat","项目讨论")).toEqual(renamed);
      await store.begin(turn.turnId);await store.update(turn.turnId,{ status: "COMPLETED",entries: [],artifacts: [] });
      expect((await service.send({ ...input,requestId: "follow-up",text: "Next question" })).title).toBe("项目讨论");
      expect(run).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it.each([[408,"timeout"],[429,"rate_limited"],[503,"server_error"]] as const)("REL-05 retains a safe category for provider HTTP %s",async (status,reasonCode) => {
    const { f,service,accept } = await setup(async () => { throw wrapPartnerRunFailure({ status },{ phase: "MODEL",sideEffectState: "NONE" }); });
    try {
      await service.deliver((await accept()).turnId);
      expect((await service.get("chat")).turns[0]).toMatchObject({ status: "FAILED",errorCode: reasonCode,failure: { reasonCode,phase: "MODEL" } });
    } finally { await f.close(); }
  });
  it("REL-10 reports a failed terminal write as persistence failure without claiming completion",async () => {
    const { f,service,store,accept } = await setup(async p => ({ actionId: p.request.actionId,workId: p.request.workId,externalRunId: "fixture",status: "COMPLETED",body: "Retained answer",artifacts: [] }));
    const update = store.update.bind(store);
    vi.spyOn(store,"update").mockImplementation(async (id,patch) => {
      if (patch.status === "COMPLETED") throw new Error("PRIVATE_STORAGE_SENTINEL");
      await update(id,patch);
    });
    try {
      await service.deliver((await accept()).turnId);
      const turn = (await service.get("chat")).turns[0];
      expect(turn).toMatchObject({ status: "FAILED",errorCode: "conversation_persistence_failed",failure: { phase: "RECOVERY",sideEffectState: "UNKNOWN",retryable: false } });
      expect(turn?.entries.some(entry => entry.kind === "MARKDOWN" && entry.text === "Retained answer")).toBe(true);
      expect(JSON.stringify(turn)).not.toContain("PRIVATE_STORAGE_SENTINEL");
    } finally { await f.close(); }
  });
  it("REL-09 preserves unknown cleanup facts when a user stop reaches its settlement deadline",async () => {
    const started = Promise.withResolvers<undefined>();
    const { f,service,accept } = await setup(async p => {
      started.resolve(undefined);return new Promise<never>((_resolve,reject) => p.signal?.addEventListener("abort",() => reject(wrapPartnerRunFailure({ code: "conversation_cleanup_timed_out" },{ phase: "RECOVERY",sideEffectState: "UNKNOWN" })),{ once: true }));
    });
    try {
      const delivery = service.deliver((await accept()).turnId);await started.promise;await service.stop("chat");await delivery;
      expect((await service.get("chat")).turns[0]).toMatchObject({ status: "STOPPED",errorCode: "conversation_cleanup_timed_out",failure: { phase: "RECOVERY",sideEffectState: "UNKNOWN",retryable: false } });
    } finally { await f.close(); }
  });
  it("REL-05 preserves safe model failure facts and partial artifacts across a cold read",async () => {
    const { f,service,accept,dependencies } = await setup(async () => {
      throw wrapPartnerRunFailure(Object.assign(new Error("PRIVATE_PROVIDER_SENTINEL"),{ code: "timeout",partialArtifacts: [{ name: "partial.md",size: 12 }] }),{ phase: "MODEL",sideEffectState: "OBSERVED" });
    });
    const receive = vi.fn();service.subscribe("chat",receive);
    try {
      await service.deliver((await accept()).turnId);
      const chat = await new ConversationService(dependencies).get("chat");
      expect(chat.turns[0]).toMatchObject({ status: "FAILED",errorCode: "timeout",failure: { phase: "MODEL",reasonCode: "timeout",retryable: false,sideEffectState: "OBSERVED" },artifacts: [{ name: "partial.md",size: 12 }] });
      expect(JSON.stringify(chat)).not.toContain("PRIVATE_PROVIDER_SENTINEL");
      expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ turn: expect.objectContaining({ status: "FAILED",failure: { phase: "MODEL",reasonCode: "timeout",retryable: false,sideEffectState: "OBSERVED" },artifacts: [{ name: "partial.md",size: 12 }] }) as unknown }));
    } finally { await f.close(); }
  });
  it("CHAT-31 rejects Pi extension selections for a native partner",async () => {
    const { f,service,input,dependencies } = await setup(async () => { throw new Error("No execution expected"); });
    try {
      const revision = await dependencies.revisions.getActive(input.partnerId);
      if (revision === null) throw new Error("Missing fixture partner");
      vi.spyOn(dependencies.revisions,"getActive").mockResolvedValue({ ...revision,engine: "codex" });
      await expect(service.send({ ...input,networkId: "native",piExtensions: ["agent-browser"] })).rejects.toMatchObject({ code: "conversation_selection_invalid" });
      expect((await service.send({ ...input,networkId: "native",piExtensions: [] })).turns[0]?.config.piExtensions).toEqual([]);
    } finally { await f.close(); }
  });
  it("CHAT-30/31 persists the selected Pi extensions, forwards them across write admission and rejects changed request identities",async () => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async p => ({ actionId: p.request.actionId,workId: p.request.workId,externalRunId: "fixture",status: p.request.workspaceExecution?.phase === "READ_RUNNING" ? "SUSPENDED" : "COMPLETED",body: "Done",artifacts: [],instanceId: "checkpoint",checkpointRef: "durable" }));
    const { f,service,input,dependencies } = await setup(run);
    const selected = { ...input,piExtensions: ["cc-safety-net","agent-browser"] as const };
    try {
      const accepted = await service.send({ ...selected,piExtensions: [...selected.piExtensions] });
      expect(accepted.turns[0]?.config.piExtensions).toEqual(["agent-browser","cc-safety-net"]);
      await expect(service.send({ ...input,piExtensions: ["agent-browser","cc-safety-net"] })).resolves.toMatchObject({ conversationId: "chat" });
      await expect(service.send({ ...input,piExtensions: [] })).rejects.toMatchObject({ code: "conversation_request_conflict" });
      await service.deliver(accepted.turns[0]?.turnId ?? "missing");
      expect(run).toHaveBeenCalledTimes(2);
      for (const [call] of run.mock.calls) expect(call.request.piExtensions).toEqual(["agent-browser","cc-safety-net"]);
      const restored = new ConversationService(dependencies);
      expect((await restored.get("chat")).turns[0]?.config.piExtensions).toEqual(["agent-browser","cc-safety-net"]);
      for (const piExtensions of ["agent-browser",["unknown"],["openwiki"],["agent-browser","agent-browser"],null]) {
        await expect(service.send({ ...input,requestId: "invalid",piExtensions } as never)).rejects.toMatchObject({ code: "conversation_selection_invalid" });
      }
      await restored.send({ ...input,conversationId: "other",requestId: "other" });
      expect((await restored.get("other")).turns[0]?.config.piExtensions).toEqual([]);
    } finally { await f.close(); }
  });
  it("CHAT-29 retries the final projection after an observational activity write fails",async () => {
    const { f,service,accept,store } = await setup(async p => {
      await p.onThinking?.({ phaseId: "phase",state: "COMPLETED" }).catch(() => undefined);
      return { actionId: p.request.actionId,workId: p.request.workId,externalRunId: "fixture",status: "COMPLETED",body: "Done",artifacts: [] };
    });
    vi.spyOn(store,"update").mockRejectedValueOnce(new Error("Synthetic transient projection failure"));
    try {
      await service.deliver((await accept()).turnId);const turn = (await service.get("chat")).turns[0];
      expect(turn?.status).toBe("COMPLETED");expect(turn?.entries.some(entry => entry.kind === "ACTIVITY")).toBe(true);
      expect(turn?.entries.some(entry => entry.kind === "MARKDOWN" && entry.text === "Done")).toBe(true);
    } finally { await f.close(); }
  });
  it("CHAT-29 retains distinct thinking observations when a turn resumes in its WRITE phase",async () => {
    const { f,service,accept } = await setup(async p => {
      await p.onThinking?.({ phaseId: "same-engine-phase",state: "COMPLETED",summary: p.request.workspaceExecution?.phase === "READ_RUNNING" ? "Read observation" : "Write observation" });
      return { actionId: p.request.actionId,workId: p.request.workId,externalRunId: "fixture",status: p.request.workspaceExecution?.phase === "READ_RUNNING" ? "SUSPENDED" : "COMPLETED",body: "Done",artifacts: [],instanceId: "checkpoint",checkpointRef: "durable" };
    });
    try {
      await service.deliver((await accept()).turnId);
      const thoughts = (await service.get("chat")).turns[0]?.entries.flatMap(entry => entry.kind === "ACTIVITY" && entry.activity.type === "THINKING" ? [entry.activity.thinking] : []) ?? [];
      expect(thoughts.map(value => value.summary)).toEqual(["Read observation","Write observation"]);
      expect(new Set(thoughts.map(value => value.phaseId)).size).toBe(2);
    } finally { await f.close(); }
  });
  it("CHAT-29 persists safe turn activity across streamed and final snapshots and restart",async () => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async p => {
      await p.onContext?.({ kind: "CHARACTERS",state: "COMPACTING" });
      await p.onThinking?.({ phaseId: "phase",state: "STARTED",startedAt: "2026-11-12T00:00:00Z" });
      await p.onConversation?.({ instanceId: "fixture",conversation: () => [{ kind: "MARKDOWN",role: "AGENT",text: "Partial" }] });
      await p.onThinking?.({ phaseId: "phase",state: "COMPLETED",durationMs: 42,summary: `token=synthetic-secret ${"公".repeat(2400)}` });
      return { actionId: p.request.actionId,workId: p.request.workId,externalRunId: "fixture",status: "COMPLETED",body: "Final",artifacts: [],conversation: [{ kind: "MARKDOWN",role: "AGENT",text: "Final" }] };
    });
    const { f,service,accept,dependencies } = await setup(run);
    try {
      await service.deliver((await accept()).turnId);
      const chat = await new ConversationService(dependencies).get("chat"),entries = chat.turns[0]?.entries ?? [];
      expect(entries.filter(entry => entry.kind === "ACTIVITY")).toHaveLength(2);
      const thinking = entries.find(entry => entry.kind === "ACTIVITY" && entry.activity.type === "THINKING");
      expect(thinking).toMatchObject({ activity: { type: "THINKING",thinking: { state: "COMPLETED",durationMs: 42,summaryTruncated: true } } });
      expect(JSON.stringify(chat)).not.toContain("synthetic-secret");expect(JSON.stringify(chat)).toContain("[redacted]");
      expect(entries.filter(entry => entry.kind === "MARKDOWN").map(entry => entry.text)).toEqual(["Final"]);
    } finally { await f.close(); }
  });

  it("CHAT-29 retains an interrupted thinking phase when execution fails",async () => {
    const { f,service,accept } = await setup(async p => { await p.onThinking?.({ phaseId: "phase",state: "STARTED" });throw new Error("Synthetic disconnect"); });
    try { await service.deliver((await accept()).turnId);expect((await service.get("chat")).turns[0]).toMatchObject({ status: "FAILED",entries: [{ activity: { type: "THINKING",thinking: { state: "INTERRUPTED" } } }] }); }
    finally { await f.close(); }
  });
  it("CHAT-19 cancels a turn admitted concurrently with stop before invoking its engine",async () => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async p => ({ actionId: p.request.actionId,workId: p.request.workId,externalRunId: "fixture",status: "COMPLETED",body: "Unexpected",artifacts: [] }));
    const { f,service,store,accept } = await setup(run);
    let stopping: Promise<void> | undefined;
    try {
      const turn = await accept(),begin = store.begin.bind(store);
      vi.spyOn(store,"begin").mockImplementationOnce(async id => {
        const admitted = await begin(id);stopping = service.stop("chat");await new Promise(resolve => setTimeout(resolve,0));return admitted;
      });
      await service.deliver(turn.turnId);await stopping;
      expect(run).not.toHaveBeenCalled();expect((await service.get("chat")).turns[0]?.status).toBe("STOPPED");
    } finally { await stopping;await f.close(); }
  });

  it("CHAT-19/22 preserves final private facts during cancellation and waits before accepting another turn",async () => {
    const started = Promise.withResolvers<undefined>(),cleanup = Promise.withResolvers<undefined>();
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async p => {
      started.resolve(undefined);
      await new Promise<undefined>(resolve => p.signal?.addEventListener("abort",() => resolve(undefined),{ once: true }));
      await cleanup.promise;
      await p.session?.save({ engine: "pi-core",messages: [{ role: "toolResult",toolCallId: "effect",content: "FINAL_EFFECT_FACT" }] });
      throw new Error("Canceled fixture");
    });
    const { f,service,store,input,accept } = await setup(run);
    let delivery: Promise<void> | undefined,stopping: Promise<void> | undefined;
    try {
      const turn = await accept();delivery = service.deliver(turn.turnId);await started.promise;
      let settled = false;stopping = service.stop("chat").then(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve,0));expect(settled).toBe(false);
      await expect(service.send({ ...input,requestId: "too-soon" })).rejects.toMatchObject({ code: "conversation_busy" });
      cleanup.resolve(undefined);await stopping;await delivery;
      expect((await store.session("chat"))?.messages).toEqual([{ role: "toolResult",toolCallId: "effect",content: "FINAL_EFFECT_FACT" }]);
      expect((await service.get("chat")).turns[0]?.status).toBe("STOPPED");
      await expect(service.send({ ...input,requestId: "after-cleanup" })).resolves.toMatchObject({ conversationId: "chat" });
    } finally { cleanup.resolve(undefined);await stopping;await delivery;await f.close(); }
  });

  it("CHAT-22/23 snapshots disabled delegation, persists safe activity and retains the request identity",async () => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async p => {
      expect(p.request.subagentsEnabled).toBe(false);
      await p.onContext?.({ kind: "CHARACTERS",state: "COMPRESSED",requestChars: 100,budgetChars: 200,savedChars: 80,compactions: 1 });
      await p.onConversation?.({ instanceId: "fixture",conversation: () => [{ kind: "MARKDOWN",role: "AGENT",text: "Progress" }] });
      return { actionId: p.request.actionId,workId: p.request.workId,externalRunId: "fixture",status: "COMPLETED",body: "Done",artifacts: [] };
    });
    const { f,service,input } = await setup(run);
    try {
      const selected = { ...input,subagentsEnabled: false };
      const accepted = await service.send(selected),turn = accepted.turns[0];if (turn === undefined) throw new Error("Missing turn");await service.deliver(turn.turnId);
      expect((await service.get("chat")).context).toEqual({ kind: "CHARACTERS",state: "COMPRESSED",requestChars: 100,budgetChars: 200,savedChars: 80,compactions: 1,activityAt: f.clock.now().toISOString() });
      await expect(service.send(selected)).resolves.toMatchObject({ conversationId: "chat" });
      await expect(service.send(input)).rejects.toMatchObject({ code: "conversation_request_conflict" });
      expect((await service.page("chat")).items).toHaveLength(1);
      expect((await service.events("chat")).cursor).toMatch(/^events:chat:/u);
      await expect(service.cancelChild("chat","foreign")).rejects.toMatchObject({ code: "subagent_not_found" });
      expect(run).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it("CHAT-22 scopes child cancellation to the latest turn of the selected conversation",async () => {
    const { f,service,store,dependencies,accept,input } = await setup(vi.fn<PartnerInstanceManager["dispatch"]>());
    try {
      const children = new SqliteConversationSubagentStore(f.database),cancel = vi.fn(children.cancel.bind(children));
      dependencies.subagents = { list: children.list.bind(children),cancel };
      const turn = await accept();await store.begin(turn.turnId);
      const record = await store.turn(turn.turnId);if (record?.revision === null || record === null) throw new Error("Missing revision");
      await children.enqueue({ childId: "child",parentTurnId: turn.turnId,callId: "call",task: "Inspect",revision: record.revision,at: f.clock.now().toISOString(),
        request: { actionId: turn.turnId,workId: turn.turnId,workbenchId: input.workbenchId,contextSnapshotId: "snapshot",taskProjection: "Help" },
        sourcePin: { turnId: turn.turnId,modelId: "model",modelRevisionId: "model-revision",sourceId: "network",sourceRevisionId: "source-revision" } });
      await expect(service.cancelChild("chat","foreign")).rejects.toMatchObject({ code: "subagent_not_found" });expect(cancel).not.toHaveBeenCalled();
      await service.cancelChild("chat","child");expect(cancel).toHaveBeenCalledWith(turn.turnId,"child");expect((await children.get("child"))?.status).toBe("CANCELED");
      await store.submit({ conversationId: "empty",workbenchId: input.workbenchId,turnId: "empty-turn",requestId: "empty-request",text: "Hello",config: turn.config,at: f.clock.now().toISOString() });
      await expect(service.cancelChild("empty","child")).rejects.toMatchObject({ code: "subagent_not_found" });
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it("CHAT-19 restores an isolated durable session and includes stopped history beyond 24 turns", async () => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async p => {
      await p.session?.save({ engine: "pi-core", messages: [{ role: "user", content: "PRIVATE_EXECUTION_FACT", timestamp: 0 }] });
      return { actionId: p.request.actionId, workId: p.request.workId, externalRunId: "fixture", status: "COMPLETED", body: "Done", artifacts: [] };
    });
    const { f,service,store,input,dependencies } = await setup(run);
    try {
      for (let index = 0; index < 30; index += 1) {
        await store.submit({ conversationId: "chat", workbenchId: input.workbenchId, turnId: `prior_${String(index)}`, requestId: `prior_req_${String(index)}`,
          text: index === 0 ? "FIRST_HISTORY_REQUIRED" : `history ${String(index)}`, at: f.clock.now().toISOString(),
          config: { partnerId: input.partnerId, partnerName: "Helper", networkId: "network", networkName: "Network", modelName: "model", skills: [], attachmentIds: ["attachment-ref"] } });
        await store.begin(`prior_${String(index)}`);
        await store.update(`prior_${String(index)}`, { entries: [{ entryId: `entry_${String(index)}`, sequence: 1,createdAt: f.clock.now().toISOString(), kind: "MARKDOWN", role: "AGENT", text: "PARTIAL_FACT" }], artifacts: [], status: index === 0 ? "STOPPED" : "COMPLETED" });
      }
      let submitted = await service.send(input);
      await service.deliver(submitted.turns.at(-1)?.turnId ?? "missing-turn");
      expect(JSON.stringify(run.mock.calls[0]?.[0].request.conversationHistory)).toContain("FIRST_HISTORY_REQUIRED");
      expect(JSON.stringify(run.mock.calls[0]?.[0].request.conversationHistory)).toContain("PARTIAL_FACT");
      expect(JSON.stringify(run.mock.calls[0]?.[0].request.conversationHistory)).toContain("attachment-ref");
      const restarted = new ConversationService(dependencies);
      submitted = await restarted.send({ ...input, requestId: "next", text: "Continue" });
      await restarted.deliver(submitted.turns.at(-1)?.turnId ?? "missing-turn");
      expect(run.mock.calls.at(-1)?.[0].session?.state?.messages).toEqual([{ role: "user", content: "PRIVATE_EXECUTION_FACT", timestamp: 0 }]);
      submitted = await restarted.send({ ...input, conversationId: "other", requestId: "other", text: "Independent" });
      await restarted.deliver(submitted.turns.at(-1)?.turnId ?? "missing-turn");
      expect(run.mock.calls.at(-1)?.[0].session?.state).toBeUndefined();
    } finally { await f.close(); }
  });
  it("CHAT-15 preserves accepted queued messages on close, while explicit emergency stop cancels them", async () => {
    const { f,service,accept,input } = await setup(vi.fn<PartnerInstanceManager["dispatch"]>());
    try {
      const turn = await accept();service.close();await service.deliver(turn.turnId);
      expect((await service.get("chat")).turns[0]?.status).toBe("QUEUED");
      await expect(service.send({ ...input,requestId: "after-close" })).rejects.toMatchObject({ code: "conversation_stopped" });
      await service.emergencyStop();expect((await service.get("chat")).turns[0]?.status).toBe("STOPPED");
    } finally { await f.close(); }
  });
  it("CHAT-15 starts and resumes a conversation while another task owns the workbench WRITE lease", async () => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async p => ({ actionId: p.request.actionId,workId: p.request.workId,externalRunId: "fixture",artifacts: [],body: "Done",status: p.request.workspaceExecution?.phase === "READ_RUNNING" ? "SUSPENDED" : "COMPLETED",instanceId: "checkpoint",checkpointRef: "durable" }));
    const { f,service,store,leases,accept,input } = await setup(run);
    try {
      const turn = await accept();
      await store.submit({ conversationId: "holder",workbenchId: input.workbenchId,turnId: "holder-work",requestId: "holder-request",text: "Fixture",at: f.clock.now().toISOString(),config: turn.config });
      const held = await leases.acquire({ accessMode: "WRITE",workId: "holder-work",workspaceRef: `workbench_workspace:${input.workbenchId}` });expect(held).not.toBeNull();
      await service.deliver(turn.turnId);
      expect((await service.get("chat")).turns[0]?.status).toBe("COMPLETED");expect(run.mock.calls.map(call => call[0].request.workspaceExecution?.phase)).toEqual(["READ_RUNNING","WRITE_RUNNING"]);
      expect(await leases.renew({ workId: "holder-work",workspaceRef: `workbench_workspace:${input.workbenchId}` })).not.toBeNull();
    } finally { await f.close(); }
  });
  it("CHAT-15 does not occupy the workbench while a conversation is running", async () => {
    const started = Promise.withResolvers<undefined>(),finish = Promise.withResolvers<undefined>();
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async p => { started.resolve(undefined);await finish.promise;return { actionId: p.request.actionId,workId: p.request.workId,externalRunId: "fixture",status: "COMPLETED",body: "Done",artifacts: [] }; });
    const { f,service,store,leases,accept,input } = await setup(run);
    let delivery: Promise<void> | undefined;
    try {
      const turn = await accept();await store.submit({ conversationId: "other",workbenchId: input.workbenchId,turnId: "other-work",requestId: "other-request",text: "Fixture",at: f.clock.now().toISOString(),config: turn.config });
      delivery = service.deliver(turn.turnId);await started.promise;
      expect(await leases.acquire({ accessMode: "WRITE",workId: "other-work",workspaceRef: `workbench_workspace:${input.workbenchId}` })).not.toBeNull();
    } finally { finish.resolve(undefined);await delivery;await f.close(); }
  });
  it("CHAT-04 pins source revisions, renders structured progress and includes completed answers in the next turn", async () => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async p => ({ actionId: p.request.actionId,workId: p.request.workId,externalRunId: "run",status: "COMPLETED",body: "Result",artifacts: [{ name: "report.md",size: 10 }],conversation: [
      { kind: "MARKDOWN",role: "USER",text: p.request.taskProjection },{ kind: "TOOL_CALL",role: "TOOL",toolName: "read",toolCallId: "read",text: "src/runtime.ts",toolState: "started" },
      { kind: "TOOL_RESULT",role: "TOOL",toolName: "read",toolCallId: "read",toolState: "failed",text: "执行失败" },
      { kind: "ARTIFACT",role: "AGENT",artifact: { name: "report.md",size: 10,mimeType: "text/markdown" } },{ kind: "MARKDOWN",role: "AGENT",text: "Prior answer" },
    ] }));
    const { f,service,input,dependencies,accept } = await setup(run);
    try {
      dependencies.networks.list = async () => [{ sourceId: "network",displayName: "Network",activeSourceRevisionId: "source-v1",activeModel: { id: "model",revisionId: "model-v1" },status: "READY" }];
      const first = await accept();await service.deliver(first.turnId);
      const next = await service.send({ ...input,requestId: "next",text: "Follow up" });const second = next.turns.at(-1);if (second === undefined) throw new Error("Missing follow-up");await service.deliver(second.turnId);
      expect(run.mock.calls[1]?.[0]).toMatchObject({ expectedSource: { sourceId: "network",sourceRevisionId: "source-v1",modelRevisionId: "model-v1" } });
      expect(JSON.stringify(run.mock.calls[1]?.[0].request.conversationHistory)).toContain("Prior answer");
      expect((await service.get("chat")).turns[0]?.entries.some(e => e.role === "USER")).toBe(false);
      expect((await service.get("chat")).turns[0]?.entries.filter(e => e.role === "TOOL")).toMatchObject([{ text: "src/runtime.ts",toolState: "started" },{ toolState: "failed" }]);
      await expect(service.send({ ...input,requestId: "next",text: "Different" })).rejects.toMatchObject({ code: "conversation_request_conflict" });
      await expect(service.send({ ...input,requestId: "foreign",workbenchId: "another" })).rejects.toMatchObject({ code: "conversation_workbench_locked" });
    } finally { await f.close(); }
  });
  it("CHAT-15 stops before a checkpoint resumes and abandons it without a write call", async () => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>();
    const { f,service,accept,dependencies,input } = await setup(run);
    const abandonStarted = Promise.withResolvers<undefined>(),abandoned = Promise.withResolvers<undefined>();
    let delivery: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      const abandon = vi.fn(async () => { abandonStarted.resolve(undefined);await abandoned.promise; });dependencies.instances.abandonSuspended = abandon;
      run.mockImplementation(async p => {
        stopping = service.stop("chat");
        await new Promise<undefined>(resolve => p.signal?.addEventListener("abort",() => resolve(undefined),{ once: true }));
        return { actionId: p.request.actionId,workId: p.request.workId,externalRunId: "run",status: "SUSPENDED",body: "",artifacts: [],instanceId: "checkpoint",checkpointRef: "durable" };
      });
      const turn = await accept();delivery = service.deliver(turn.turnId);await abandonStarted.promise;
      await expect(service.send({ ...input,requestId: "during-abandonment" })).rejects.toMatchObject({ code: "conversation_busy" });
      abandoned.resolve(undefined);await delivery;await stopping;
      expect(run).toHaveBeenCalledTimes(1);expect(abandon).toHaveBeenCalledWith({ workbenchId: (await service.get("chat")).workbenchId,instanceId: "checkpoint" });
      expect((await service.get("chat")).turns[0]?.status).toBe("STOPPED");
    } finally { abandoned.resolve(undefined);await delivery;await stopping;await f.close(); }
  });
  it("CHAT-03/09 rejects invalid selections before creating history or calling an engine", async () => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>();const { f,service,input,dependencies } = await setup(run);
    try {
      for (const change of [{ conversationId: "../escape" },{ requestId: "invalid/request" },{ text: " " },{ text: "x".repeat(64001) },{ skills: Array<string>(65).fill("skill") },{ attachmentIds: Array<string>(17).fill("file") }]) await expect(service.send({ ...input,...change })).rejects.toBeInstanceOf(DomainError);
      const getRevision = dependencies.revisions.getActive.bind(dependencies.revisions);
      dependencies.revisions.getActive = async () => null;await expect(service.send(input)).rejects.toMatchObject({ code: "conversation_partner_unavailable" });dependencies.revisions.getActive = getRevision;
      const list = dependencies.networks.list.bind(dependencies.networks);
      dependencies.networks.list = async () => [];await expect(service.send(input)).rejects.toMatchObject({ code: "model_source_not_ready" });dependencies.networks.list = list;
      const workspace = dependencies.workspaces.getWorkspace.bind(dependencies.workspaces);
      dependencies.workspaces.getWorkspace = async () => null;await expect(service.send(input)).rejects.toMatchObject({ code: "workbench_workspace_not_ready" });dependencies.workspaces.getWorkspace = workspace;
      await expect(service.send({ ...input,attachmentIds: ["attachment"] })).rejects.toMatchObject({ code: "conversation_attachments_unavailable" });
      dependencies.skills.validateRefs = () => { throw new DomainError("skill_invalid","Unavailable selected Skill"); };await expect(service.send({ ...input,skills: ["missing"] })).rejects.toMatchObject({ code: "skill_invalid" });
      await expect(service.get("missing")).rejects.toMatchObject({ code: "conversation_not_found" });await service.deliver("missing");
      expect((await service.list()).items).toEqual([]);expect(run).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it.each(["codex","claude-code"] as const)("CHAT-03 keeps %s engine model configuration and stages exact selected attachments", async engine => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async p => ({ actionId: p.request.actionId,workId: p.request.workId,externalRunId: "native",status: "WAITING_INPUT",pendingQuestion: "Which option?",body: "Question",artifacts: [{ name: "report.md",mimeType: "text/markdown",size: 10 }] }));
    const { f,service,input,dependencies,store } = await setup(run);
    try {
      const original = await dependencies.revisions.getActive(input.partnerId);if (original === null) throw new Error("Missing revision");
      dependencies.revisions.getActive = async () => ({ ...original,engine,...(engine === "codex" ? { engineModelId: "configured-native-model" } : {}) });
      const stage = vi.fn(async () => "ATTACHMENT_CONTEXT");const validate = vi.fn(async () => undefined);dependencies.attachments = { stage,validate };
      const submitted = await service.send({ ...input,networkId: "native",attachmentIds: ["attachment"] });const turn = submitted.turns[0];if (turn === undefined) throw new Error("Missing turn");
      expect(turn.config).toMatchObject({ networkId: "native",networkName: engine,modelName: engine === "codex" ? "configured-native-model" : engine });
      await service.deliver(turn.turnId);expect(validate).toHaveBeenCalledWith(["attachment"]);expect(stage).toHaveBeenCalledWith({ ids: ["attachment"],turnId: turn.turnId });
      expect(run.mock.calls[0]?.[0].request.requiredContext).toContain("ATTACHMENT_CONTEXT");expect((await store.get("chat"))?.turns[0]).toMatchObject({ status: "COMPLETED",artifacts: [{ name: "report.md",mimeType: "text/markdown",size: 10 }] });
    } finally { await f.close(); }
  });
  it.each(["domain","unknown","failed","checkpoint","revision","workbench"])("CHAT-04 settles %s execution failures as readable safe history", async failure => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async p => {
      if (failure === "domain") throw new DomainError("safe_failure","private-engine-sentinel");
      if (failure === "unknown") throw new Error("private-engine-sentinel");
      return { actionId: p.request.actionId,workId: p.request.workId,externalRunId: "fixture",artifacts: [],body: "",status: failure === "checkpoint" ? "SUSPENDED" : "FAILED" };
    });
    const { f,service,store,accept,dependencies } = await setup(run);
    try {
      const turn = await accept();
      if (failure === "revision") { const record = await store.turn(turn.turnId);if (record === null) throw new Error("Missing turn");vi.spyOn(store,"turn").mockResolvedValue({ ...record,revision: null }); }
      if (failure === "workbench") dependencies.workbenches.getWorkbench = async () => null;
      await service.deliver(turn.turnId);const result = await service.get("chat");expect(result.turns[0]?.status).toBe("FAILED");expect(JSON.stringify(result)).not.toContain("private-engine-sentinel");
    } finally { await f.close(); }
  });
  it("CHAT-15 stops a queued conversation without dispatching it", async () => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>();const { f,service,accept } = await setup(run);
    try {
      const turn = await accept();await service.stop("chat");await service.deliver(turn.turnId);
      expect((await service.get("chat")).turns[0]?.status).toBe("STOPPED");expect(run).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("CHAT-04 preserves partial stream output when the user stops and accepts a fresh next message", async () => {
    const running = Promise.withResolvers<undefined>();
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async input => {
      await input.onConversation?.({ instanceId: "instance",conversation: () => [{ kind: "MARKDOWN",role: "AGENT",text: "Partial answer" }] });
      running.resolve(undefined);
      return new Promise<PartnerRunResult>((_resolve,reject) => input.signal?.addEventListener("abort",() => reject(new Error("aborted")),{ once: true }));
    });
    const { f,service,accept,input } = await setup(run);
    try {
      const turn = await accept();const delivery = service.deliver(turn.turnId);await running.promise;
      await service.stop("chat");await delivery;
      expect((await service.get("chat")).turns[0]).toMatchObject({ status: "STOPPED",entries: [expect.objectContaining({ text: "Partial answer" })] });
      await expect(service.send({ ...input,requestId: "followup",text: "Continue" })).resolves.toMatchObject({ conversationId: "chat" });
    } finally { service.close();await f.close(); }
  });
  it("CHAT-15 resumes a checkpoint without workspace admission and never reruns the read phase", async () => {
    const phases: string[] = [];
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async input => {
      phases.push(input.request.workspaceExecution?.phase ?? "none");
      return { actionId: "action",externalRunId: "run",workId: input.request.workId,body: phases.length === 1 ? "" : "Done",artifacts: [],
        status: phases.length === 1 ? "SUSPENDED" : "COMPLETED",instanceId: "checkpoint-instance",checkpointRef: "durable-checkpoint" };
    });
    const { f,service,accept } = await setup(run);
    try {
      const turn = await accept();await service.deliver(turn.turnId);
      expect(phases).toEqual(["READ_RUNNING","WRITE_RUNNING"]);
      expect(run.mock.calls[1]?.[0]).toMatchObject({ instanceId: "checkpoint-instance",request: { workspaceExecution: { generation: 2 } } });
      expect((await service.get("chat")).turns[0]?.status).toBe("COMPLETED");
    } finally { await f.close(); }
  });
  it("CHAT-09 emergency stop cancels queued messages and prevents new execution", async () => {
    const run = vi.fn<PartnerInstanceManager["dispatch"]>();const { f,service,accept,input } = await setup(run);
    try {
      const turn = await accept();await service.emergencyStop();await service.deliver(turn.turnId);
      expect((await service.get("chat")).turns[0]?.status).toBe("STOPPED");
      await expect(service.send({ ...input,requestId: "after-stop" })).rejects.toMatchObject({ code: "conversation_stopped" });
      expect(run).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("CHAT-03/04/06 pins configured model, injects inherited context and never replays a completed turn", async () => {
    const f = await createRuntimeFixture();
    try {
      const wb = await f.workbenchRegistry.create({ name: "Chat", personaSummary: "Project assistant", projectLabel: "Chat", scopeSummary: "Help with project" });
      await f.workbenchWorkspaces.bindExisting(wb.workbenchId,f.root);
      const partner = await f.partners.add({ capabilities: [], displayName: "Helper", kind: "local-pi", skills: [], tools: [] });
      const store = new SqliteConversationStore(f.database);
      const run = vi.fn(async (input: { request: { requiredContext?: string }; revision: { modelIdOverride?: string; modelSourceId?: string } }) => {
        expect(input.request.requiredContext).toContain("Remember project conventions");
        expect(input.revision.modelSourceId).toBe("settings-network");
        expect(input.revision.modelIdOverride).toBeUndefined();
        return { actionId: "a", artifacts: [], body: "## Answer\n\nHello", externalRunId: "r", status: "COMPLETED" as const, workId: "w" };
      });
      const service = new ConversationService({ clock: f.clock, ids: f.ids, store, workbenches: f.workbenches,
        workspaces: { getWorkspace: async () => ({ workspaceRef: `workbench_workspace:${wb.workbenchId}`, kind: "BOUND", status: "READY", displayName: "fixture" }) },
        contexts: new SqliteWorkbenchContextRepository(f.database),
        revisions: new SqlitePartnerRegistryRepository(f.database), instances: { dispatch: run },
        networks: { list: async () => [{ sourceId: "settings-network", displayName: "Settings network", activeModel: { id: "configured-model" }, status: "READY" }] },
        skills: { validateRefs: () => undefined }, inheritance: { read: async () => ({ memoryCount: 1,evolutionRevisionId: null,instructions: "Remember project conventions" }) },
      });
      const accepted = await service.send({ conversationId: "chat", workbenchId: wb.workbenchId, partnerId: partner.partnerId, networkId: "settings-network", skills: [], attachmentIds: [], requestId: "send",text: "Hello" });
      const turn = accepted.turns[0];
      if (turn === undefined) throw new Error("Expected an accepted turn.");
      await service.deliver(turn.turnId);
      await service.deliver(turn.turnId);
      expect(run).toHaveBeenCalledTimes(1);
      expect((await service.get("chat")).turns[0]).toMatchObject({ status: "COMPLETED",config: { modelName: "configured-model" } });
      expect((await service.get("chat")).turns[0]?.entries.some(e => e.text?.includes("## Answer"))).toBe(true);
    } finally { await f.close(); }
  });
});
