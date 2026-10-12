import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import type { JoiReasoningSessionSnapshot } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";
import { createJoiReasoningTools } from "../../src/main/infrastructure/pi/joi-reasoning-tools.js";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("dispatch acceptance recovery through the Pi SDK", () => {
  it.each([["corrected", "missing"], ["repeated", "missing"], ["corrected", "empty"], ["repeated", "empty"]] as const)("converges a %s %s-check dispatch without replaying the goal", async (scenario, checks) => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "Evidence", personaSummary: "Careful", projectLabel: "Test", scopeSummary: "Test" });
      const partner = await fixture.partners.add({ capabilities: ["read"], displayName: "Reader", kind: "local-pi", skills: [], tools: ["read"] });
      const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const harness = new SqliteJoiHarnessRepository(fixture.database);
      const now = fixture.clock.now().toISOString();
      await inbox.create({ inputId: "goal-acceptance", idempotencyKey: "goal-acceptance", body: "Read references and return evidence.",
        workbenchId: workbench.workbenchId, status: "PENDING", createdAt: now, updatedAt: now });
      const work = new WorkOrchestrationService({ clock: fixture.clock, ids: fixture.ids, partners: fixture.partners,
        repository: new SqliteWorkPlanRepository(fixture.database), policy: { evaluate: () => Promise.resolve({ allowed: true }) } });
      const request = { accessMode: "READ", key: "read", partnerId: partner.partnerId, title: "Read references", instructions: "Return evidence from references.",
        ...(checks === "empty" ? { acceptanceChecks: [] } : {}) };
      const valid = { ...request, acceptanceChecks: [{ kind: "BODY_PRESENT" }] };
      const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
      const faux = fauxProvider({ provider: `dispatch-acceptance-${scenario}` });
      let requests = 0;
      faux.setResponses([
        call("harness_name_destination", { destination: "Return reference evidence" }),
        call("harness_note_fog", { note: "Read references before selecting a date range." }),
        call("work_dispatch", { work: [request] }),
        call("work_dispatch", { work: [scenario === "corrected" ? valid : request] }),
        fauxAssistantMessage([fauxText("Queued.")]),
      ].map(response => () => { requests++; return response; }));
      const models = createModels(); models.setProvider(faux.provider);
      const snapshots = new Map<string, JoiReasoningSessionSnapshot>();
      const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, thinkingLevel: "off",
        sessionStore: { load: id => Promise.resolve(snapshots.get(id) ?? null),
          save: next => { snapshots.set(next.sessionId, structuredClone(next)); return Promise.resolve(); } },
        tools: turn => createJoiReasoningTools({
          workbenchId: workbench.workbenchId, inputId: turn.inputId, turnId: turn.turnId,
          work, harness, partners: fixture.partners, instances: fixture.instances, memory: fixture.memory,
          workbenches: fixture.workbenches, workbenchWorkspaces: fixture.workbenchWorkspaces,
          directoryPicker: () => Promise.resolve(null), skills: fixture.skills,
          models: { list: () => Promise.resolve([]) },
          results: { read: ({ resultId }) => Promise.resolve({ resultId, content: "unused" }) },
          workbenchChanges: { suggestArchive: () => Promise.reject(new Error("unused")), suggestMerge: () => Promise.reject(new Error("unused")) },
          clarifications: inbox,
        }),
      });
      const coordinator = new JoiCoordinator({ clock: fixture.clock, ids: fixture.ids, runtime, workbenches: fixture.workbenches,
        store: {
          loadInput: id => inbox.loadInput(id),
          createTurn: turn => inbox.createTurn({ inputId: turn.inputId, turnId: turn.turnId, workbenchId: turn.workbenchId,
            sessionId: turn.sessionId, createdAt: turn.createdAt }),
          recordTurnProgress: (id, progress) => inbox.recordTurnProgress(id, progress),
          completeInput: (id, turnId, completion) => inbox.completeInput(id, turnId, completion),
          failTurn: (...args) => inbox.failTurn(...args),
          requireClarification: (id, reason, prompt) => inbox.requireClarification(id, reason, prompt),
        },
        router: { decide: () => Promise.reject(new Error("bound goal")) },
        sources: { selectInitial: turnId => Promise.resolve({ turnId, modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake" }) },
      });
      const counts = () => fixture.database.transaction(connection => ({
        work: (connection.prepare("SELECT COUNT(*) AS n FROM work_items WHERE input_id = 'goal-acceptance'").get() as { n: number }).n,
        dispatch: (connection.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'partner.dispatch'").get() as { n: number }).n,
        fog: (connection.prepare("SELECT COUNT(*) AS n FROM joi_harness_fog WHERE goal_input_id = 'goal-acceptance'").get() as { n: number }).n,
      }));

      if (scenario === "corrected") {
        await coordinator.handle("goal-acceptance");
        expect(counts()).toEqual({ work: 1, dispatch: 1, fog: 1 });
        expect((await inbox.list()).find(row => row.inputId === "goal-acceptance")?.failureReasonCode).toBeUndefined();
      } else {
        await expect(coordinator.handle("goal-acceptance")).rejects.toMatchObject({ code: "work_acceptance_checks_required" });
        expect(requests).toBe(4);
        expect(counts()).toEqual({ work: 0, dispatch: 0, fog: 1 });
        expect(await inbox.loadInput("goal-acceptance")).toMatchObject({ status: "CONSUMED" });
        expect((await fixture.joiHomeFeed.load()).goals.find(goal => goal.goalId === "goal-acceptance"))
          .toMatchObject({ status: "FAILED", failure: { attempts: 1, executionStarted: false, reasonCode: "work_acceptance_checks_required" } });

        expect(await inbox.retry("goal-acceptance", {})).toMatchObject({ status: "PENDING" });
        faux.setResponses([call("work_dispatch", { work: [request] }), call("work_dispatch", { work: [valid] }), fauxAssistantMessage([fauxText("Queued.")])]);
        await coordinator.handle("goal-acceptance");
        expect(counts()).toEqual({ work: 1, dispatch: 1, fog: 1 });
        expect(await inbox.retry("goal-acceptance", {})).toBeNull();
      }
    } finally {
      await fixture.close();
    }
  });
});
