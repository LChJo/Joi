/* Composition doubles provide only the ports this feature consumes. */
/* eslint-disable @typescript-eslint/require-await */
import path from "node:path";
import { createRuntimeFixture } from "../support/runtime-fixture";
import { wireConversations } from "../../src/main/composition/wire-conversations";
import { wirePersistence } from "../../src/main/composition/wire-persistence";
import { wireWorkbenches } from "../../src/main/composition/wire-workbenches";
import { MethodLearningService } from "../../src/main/application/evolution/method-learning-service";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";
import { SqliteMethodLearningStore } from "../../src/main/infrastructure/persistence/sqlite-method-learning-store";
import type { PartnerBundle } from "../../src/main/composition/wire-partners";
import type { ModelSourceBundle } from "../../src/main/composition/wire-model-sources";
import type { PartnerInstanceManager } from "../../src/main/application/partners/partner-instance-manager";

it("CHAT-02/06 wires path-only creation, default Joi partner, scoped memory inheritance and durable conversation delivery", async () => {
  const f = await createRuntimeFixture();
  let stack: ReturnType<typeof wireConversations> | undefined;
  try {
    const persistence = wirePersistence({ clock: f.clock,database: f.database,pid: "fixture",userDataDirectory: f.root });
    const run = vi.fn<PartnerInstanceManager["dispatch"]>(async input => {
      expect(input.request.requiredContext).toContain("PROJECT_MEMORY_SENTINEL");
      expect(input.request.requiredContext).not.toContain("OTHER_WORKBENCH_SENTINEL");
      return { actionId: input.request.actionId,workId: input.request.workId,externalRunId: "fixture",status: "COMPLETED",artifacts: [],body: "Scoped answer" };
    });
    const partnerStack = { piRuntime: { setSubagents: () => undefined },partnerInstances: { dispatch: run },partnerSkillCatalog: { validateRefs: () => undefined } } as unknown as PartnerBundle;
    const networks = [{ sourceId: "network",displayName: "Settings network",activeModel: { id: "configured",revisionId: "model-revision" },activeSourceRevisionId: "source-revision",status: "READY" }];
    const modelSourceStack = { modelSources: { list: async () => networks } } as unknown as ModelSourceBundle;
    const workbenchStack = wireWorkbenches({ clock: f.clock,ids: f.ids,diagnostics: { emit: () => undefined },persistence,partnerStack,artifactOpener: { open: async () => undefined } });
    const evolutionCall = vi.fn();
    const evolution = new MethodLearningService({ store: new SqliteMethodLearningStore(f.database),legacyStore: new SqliteEvolutionStore(f.database),
      model: { pin: async () => { throw new Error("No model call is permitted"); },call: evolutionCall },now: () => f.clock.now().toISOString(),id: () => f.ids.next("evolution") });
    stack = wireConversations({ clock: f.clock,ids: f.ids,database: f.database,persistence,partnerStack,modelSourceStack,workbenchStack,evolution,userDataDirectory: f.root,
      attachments: { read: async () => { throw new Error("No attachment selected"); },upload: async () => { throw new Error("No upload"); },importPath: async () => { throw new Error("No import"); } } });
    await expect(stack.quickWorkbench("relative/path")).rejects.toMatchObject({ code: "workspace_path_invalid" });
    const wb = await stack.quickWorkbench(f.root);
    expect(wb.name).toBe(path.basename(f.root));expect(wb).not.toHaveProperty("rootPath");
    const other = await f.workbenchRegistry.create({ name: "Other",personaSummary: "Other",projectLabel: "Other",scopeSummary: "Other" });
    f.database.transaction(db => {
      db.prepare("UPDATE workbenches SET task_summary=? WHERE workbench_id=?").run("PROJECT_MEMORY_SENTINEL",wb.workbenchId);
      db.prepare("UPDATE workbenches SET task_summary=? WHERE workbench_id=?").run("OTHER_WORKBENCH_SENTINEL",other.workbenchId);
    });
    expect(await stack.conversations.inheritance(wb.workbenchId,"joi-chat","network")).toEqual({ memoryCount: 1,evolutionRevisionId: null });
    const input = { conversationId: "chat",workbenchId: wb.workbenchId,partnerId: "joi-chat",networkId: "network",skills: [],attachmentIds: [],requestId: "send",text: "Explain the project" };
    const accepted = await stack.conversations.send(input);expect(accepted.turns[0]?.status).toBe("QUEUED");
    const configuredNetwork = networks[0];if (configuredNetwork === undefined) throw new Error("Missing fixture network");configuredNetwork.status = "DRAFT";
    expect(await stack.conversations.send(input)).toEqual(accepted);
    configuredNetwork.status = "READY";
    await stack.dispatcher.dispatchOnce();
    expect((await stack.conversations.get("chat")).turns[0]).toMatchObject({ status: "COMPLETED",entries: [expect.objectContaining({ text: "Scoped answer" })] });
    expect(run).toHaveBeenCalledTimes(1);expect(evolutionCall).not.toHaveBeenCalled();
    expect(JSON.stringify(await stack.conversations.get("chat"))).not.toContain("PROJECT_MEMORY_SENTINEL");
    await stack.conversations.send({ ...input,requestId: "accepted-before-close",text: "Queued fixture" });
    await f.partners.disable("joi-chat");
    await expect(stack.conversations.send({ ...input,requestId: "disabled",text: "Another request" })).rejects.toMatchObject({ code: "conversation_partner_unavailable" });
    await stack.close();expect((await stack.conversations.get("chat")).turns.at(-1)?.status).toBe("QUEUED");
  } finally { await stack?.close();await f.close(); }
});
