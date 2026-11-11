/* Isolated runtime doubles satisfy asynchronous application ports. */
/* eslint-disable @typescript-eslint/require-await */
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import type { JoiReasoningSessionSnapshot } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { createWorkbench } from "../../src/main/domain/workbench/workbench.js";
import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { createJoiReasoningTools } from "../../src/main/infrastructure/pi/joi-reasoning-tools.js";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import { createRuntimeFixture, TestClock, TestIds } from "../support/runtime-fixture.js";

const NOW = "2026-11-10T00:00:00.000Z";

describe("schema-rejected review recovery with real SDK and SQLite", () => {
  it.each(["harness_record_decision", "work_dispatch"])("rechecks %s once without executing rejected calls, then pauses", async name => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.database.transaction(db => {
        db.prepare(`INSERT INTO workbenches
          (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at)
          VALUES ('review-wb','Synthetic','review-persona','Synthetic','Synthetic','Synthetic','review-memory','ACTIVE',?,?)`).run(NOW, NOW);
        db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
          VALUES ('review-goal','review-goal','Synthetic','CONSUMED','review-wb',?,?)`).run(NOW, NOW);
        db.prepare(`INSERT INTO joi_goal_result_sets (original_input_id,revision,synthesized_revision,updated_at)
          VALUES ('review-goal',1,1,?)`).run(NOW);
        db.prepare(`INSERT INTO joi_goal_outcomes (input_id,result_revision,completion_summary,completed_at,updated_at,disposition)
          VALUES ('review-goal',1,'Synthetic',?,?,'CONTINUE')`).run(NOW, NOW);
      });
      const clock = new TestClock(NOW);
      const inbox = new SqliteJoiInboxRepository(fixture.database, clock);
      const harness = new SqliteJoiHarnessRepository(fixture.database);
      await harness.createMap({ goalInputId: "review-goal", workbenchId: "review-wb", now: NOW });
      const [digest] = await harness.listReviewDigests();
      if (digest === undefined) throw new Error("Synthetic review digest missing");
      const inputId = await harness.enqueueReview({ digest, now: NOW });
      if (inputId === null) throw new Error("Synthetic review input missing");
      const workbench = createWorkbench({ workbenchId: "review-wb", createdAt: NOW, memoryNamespaceId: "review-memory", name: "Synthetic",
        personaRevisionId: "review-persona", personaSummary: "Synthetic", scopeSummary: "Synthetic", project: { label: "Synthetic" },
        taskContext: { activeWorkIds: [], summary: "" } });
      const recordDecision = vi.spyOn(harness, "recordDecision");
      const plan = vi.fn(async () => { throw new Error("Rejected calls must not execute"); });
      const faux = fauxProvider({ provider: `review-schema-${name}` });
      const responses = () => [
        fauxAssistantMessage([fauxToolCall(name, name === "harness_record_decision" ? { kind: "INVALID" } : {
          work: [{ key: "a", partnerId: "synthetic", title: "Synthetic", accessMode: "READ", executionNeeds: [],
            instructions: "Synthetic", acceptanceChecks: [{ type: "BODY_PRESENT", description: "Synthetic" }] }],
        })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("Synthetic unfinished review")]),
        fauxAssistantMessage([fauxText("Synthetic unfinished repair")]),
      ];
      const models = createModels(); models.setProvider(faux.provider);
      const snapshots = new Map<string, JoiReasoningSessionSnapshot>();
      const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, thinkingLevel: "off",
        sessionStore: { load: async id => snapshots.get(id) ?? null, save: async snapshot => { snapshots.set(snapshot.sessionId, structuredClone(snapshot)); } },
        tools: turn => createJoiReasoningTools({ inputId, goalInputId: "review-goal", workbenchId: "review-wb", turnId: turn.turnId,
          workbenchChanges: {} as never, workbenchWorkspaces: {} as never, directoryPicker: async () => null,
          workbenches: {} as never, clarifications: inbox, instances: {} as never, memory: {} as never, models: {} as never,
          partners: {} as never, results: {} as never, skills: {} as never, harness, work: { plan } as never,
        }),
      });
      const coordinator = new JoiCoordinator({ workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] },
        clock, ids: new TestIds(), router: { decide: async () => ({ action: "select", workbenchId: "review-wb" }) }, runtime,
        sources: { selectInitial: async turnId => ({ modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake", turnId }) },
        store: { loadInput: inbox.loadInput.bind(inbox), createTurn: input => inbox.createTurn({ inputId: input.inputId,
          turnId: input.turnId, sessionId: input.sessionId, workbenchId: input.workbenchId, createdAt: input.createdAt }),
          completeInput: inbox.completeInput.bind(inbox), requireClarification: inbox.requireClarification.bind(inbox),
          recordTurnProgress: inbox.recordTurnProgress.bind(inbox), failTurn: inbox.failTurn.bind(inbox) },
      });
      const failReview = async () => {
        faux.setResponses(responses());
        await expect(coordinator.handle(inputId)).rejects.toMatchObject({
          code: name === "work_dispatch" ? "tool_execution_error" : "joi_turn_outcome_uncommitted",
        });
      };
      await failReview();
      expect(fixture.database.transaction(db => db.prepare(`SELECT status,side_effect_started,review_replay_safe
        FROM joi_turns WHERE input_id=?`).all(inputId))).toEqual([{ status: "FAILED", side_effect_started: 1, review_replay_safe: 1 }]);
      expect((await inbox.loadInput(inputId))?.status).toBe("CONSUMED");
      const [first] = await harness.listReviewRecoveries();
      expect(first).toMatchObject({ action: "REQUEUE" });
      if (first === undefined) throw new Error("Synthetic first recovery missing");
      expect(await harness.reconcileReview({ candidate: first, now: NOW })).toEqual({ action: "REQUEUED", inputId });
      await failReview();
      const [second] = await harness.listReviewRecoveries();
      expect(second).toMatchObject({ action: "QUARANTINE", reasonCode: "review_retry_exhausted" });
      if (second === undefined) throw new Error("Synthetic second recovery missing");
      expect(await harness.reconcileReview({ candidate: second, now: NOW })).toEqual({ action: "QUARANTINED" });
      expect(await harness.listReviewRecoveries()).toEqual([]);
      expect(fixture.database.transaction(db => db.prepare(`SELECT status,clarification_reason_code
        FROM joi_inbox_messages WHERE input_id='review-goal'`).get())).toEqual({
        status: "CLARIFICATION_REQUIRED", clarification_reason_code: "harness_review_unrecoverable",
      });
      expect(recordDecision).not.toHaveBeenCalled();
      expect(plan).not.toHaveBeenCalled();
      expect(fixture.database.transaction(db => db.prepare("SELECT count(*) AS count FROM dispatch_plans").get())).toEqual({ count: 0 });
    } finally { await fixture.close(); }
  });
});
