import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { DomainError } from "../../src/main/domain/errors.js";
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import type { JoiReasoningSessionSnapshot } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository.js";
import { appendGoalRequirementSource, SqliteGoalRequirementsRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-requirements-repository.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";
import { createJoiReasoningTools } from "../../src/main/infrastructure/pi/joi-reasoning-tools.js";
import { withGoalRequirementsTools } from "../../src/main/infrastructure/pi/joi-requirements-tools.js";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture.js";

async function seedCanceledHistory(fixture: RuntimeFixture, runStatus?: "RUNNING" | "FAILED") {
  const wb = await fixture.workbenchRegistry.create({ name: "Evidence", personaSummary: "Careful", projectLabel: "Test", scopeSummary: "Test" });
  const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
  const now = fixture.clock.now().toISOString();
  await inbox.create({ inputId: "goal", idempotencyKey: "goal", body: "Return evidence.", status: "CONSUMED", workbenchId: wb.workbenchId, createdAt: now, updatedAt: now });
  await inbox.createTurn({ inputId: "goal", turnId: "history", sessionId: "history", workbenchId: wb.workbenchId, createdAt: now });
  await inbox.completeInput("goal", "history");
  fixture.database.transaction(db => {
    const insert = db.prepare(`INSERT INTO work_items
      (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
      VALUES (?, ?, 'goal', 'Read evidence', '{}', 'READ', 'CANCELED', ?, ?)`);
    for (const id of ["old-read", "old-write"]) insert.run(id, wb.workbenchId, now, now);
  });
  if (runStatus !== undefined) {
    const partner = await fixture.partners.add({ displayName: "Historical reader", kind: "local-pi", capabilities: [], skills: [], tools: [] });
    fixture.database.transaction(db => {
      db.prepare("INSERT INTO dispatch_plans(dispatch_plan_id,turn_id,candidate_json,policy_result_json,created_at) VALUES ('old-plan','history','{}','{}',?)").run(now);
      db.prepare(`INSERT INTO dispatch_attempts(dispatch_attempt_id,dispatch_plan_id,work_id,partner_revision_id,registry_revision,action_id,status,created_at,updated_at)
        VALUES ('old-attempt','old-plan','old-read',?,1,'old-action',?,?,?)`).run(partner.partnerRevisionId, runStatus, now, now);
      db.prepare(`INSERT INTO partner_runs(run_id,dispatch_attempt_id,action_id,workbench_id,work_id,partner_revision_id,kind,external_run_id,status,created_at,updated_at)
        VALUES ('old-run','old-attempt','old-action',?,'old-read',?,'LOCAL_PI','old-external',?,?,?)`).run(wb.workbenchId, partner.partnerRevisionId, runStatus, now, now);
      db.prepare(`INSERT INTO workbench_agent_sessions(agent_id,workbench_id,partner_id,partner_revision_id,backing_kind,backing_id,session_policy,created_at)
        VALUES ('old-agent',?,?,?,'A2A_RUN','old-run','EPHEMERAL',?)`).run(wb.workbenchId, partner.partnerId, partner.partnerRevisionId, now);
    });
  }
  return { wb, inbox };
}

describe("goal finalizing recovery", () => {
  it("shares the parameter budget across error reasons but isolates prerequisites and tools", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { wb } = await seedCanceledHistory(fixture);
      const requirements = new SqliteGoalRequirementsRepository(fixture.database);
      await requirements.ensure({ goalInputId: "goal", workbenchId: wb.workbenchId });
      const assertReady = vi.spyOn(requirements, "assertReady");
      const execute = vi.fn(() => Promise.resolve({ content: [], details: {} }));
      const tools = withGoalRequirementsTools(["work_dispatch", "work_supplement"].map(name => ({ name, label: name,
        description: name, parameters: Type.Object({}), execute })), { requirements, goalInputId: "goal", workbenchId: wb.workbenchId, turnId: "history",
        work: { listForGoal: () => Promise.resolve([]), readBrief: () => Promise.resolve(null), refreshBrief: () => Promise.resolve() } });
      const attempt = async (name: string, reason: string) => {
        assertReady.mockRejectedValueOnce(new DomainError(reason, "Rejected"));
        const tool = tools.find(candidate => candidate.name === name);
        if (tool === undefined) throw new Error("fixture tool missing");
        return tool.execute("call", {});
      };
      expect(await attempt("work_dispatch", "goal_requirements_pending")).not.toHaveProperty("terminate");
      expect(await attempt("work_dispatch", "goal_requirements_stale")).not.toHaveProperty("terminate");
      expect(await attempt("work_dispatch", "work_instructions_invalid")).toMatchObject({ terminate: true });
      expect(await attempt("work_supplement", "goal_requirements_stale")).not.toHaveProperty("terminate");
      expect(await attempt("work_supplement", "goal_requirements_pending")).not.toHaveProperty("terminate");
      expect(await attempt("work_supplement", "goal_requirements_pending")).toMatchObject({ terminate: true });
      expect(execute).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it.each(["corrected", "repeated-version", "repeated-pending"] as const)("handles %s requirements through real Pi tools with canceled history", async scenario => {
    const fixture = await createRuntimeFixture();
    try {
      const { wb, inbox } = await seedCanceledHistory(fixture);
      const requirements = new SqliteGoalRequirementsRepository(fixture.database);
      await requirements.ensure({ goalInputId: "goal", workbenchId: wb.workbenchId });
      await requirements.readSource({ goalInputId: "goal", workbenchId: wb.workbenchId, sourceRevision: 1, offset: 0 });
      await requirements.update({ goalInputId: "goal", workbenchId: wb.workbenchId, expectedRevision: 0, processedSourceRevision: 1,
        upserts: [{ id: "objective", text: "Return evidence.", kind: "OBJECTIVE", scope: "GLOBAL", mandatory: true, source: { sourceRevision: 1, start: 0, end: 16 } }], retirements: [] });
      fixture.database.transaction(db => appendGoalRequirementSource(db, "goal", "Keep statements factual."));
      await requirements.readSource({ goalInputId: "goal", workbenchId: wb.workbenchId, sourceRevision: 2, offset: 0 });
      await requirements.update({ goalInputId: "goal", workbenchId: wb.workbenchId, expectedRevision: 1, processedSourceRevision: 2,
        upserts: [{ id: "factual", text: "Keep statements factual.", kind: "CONSTRAINT", scope: "GLOBAL", mandatory: true, source: { sourceRevision: 2, start: 0, end: 24 } }], retirements: [] });
      fixture.clock.advance(1_000);
      await inbox.retry("goal", { text: "Continue." });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "Reader", kind: "local-pi", skills: [], tools: [] });
      const repo = new SqliteWorkPlanRepository(fixture.database);
      const work = new WorkOrchestrationService({ clock: fixture.clock, ids: fixture.ids, requirements, repository: repo,
        partners: fixture.partners, goalGate: repo, policy: { evaluate: () => Promise.resolve({ allowed: true }) } });
      const dispatch = (requirementsRevision: number) => ({ requirementsRevision, work: [{ executionNeeds: [], accessMode: "NONE", key: "evidence",
        partnerId: partner.partnerId, title: "Return evidence", instructions: "Return the remaining factual evidence.", acceptanceChecks: [{ kind: "BODY_PRESENT" }] }] });
      const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
      const faux = fauxProvider({ provider: `finalizing-recovery-${scenario}` });
      const responses = [call("work_dispatch", dispatch(2)),
        ...(scenario === "repeated-pending" ? [call("work_dispatch", dispatch(2))] : [
          call("goal_read_inputs", { sourceRevision: 3, offset: 0 }),
          call("goal_update_requirements", { expectedRevision: 2, processedSourceRevision: 3, upserts: [], retirements: [] }),
          call("work_dispatch", dispatch(3)),
          call("work_dispatch", dispatch(scenario === "corrected" ? 2 : 3)),
        ]), fauxAssistantMessage([fauxText("Queued.")])];
      faux.setResponses(responses);
      const models = createModels(); models.setProvider(faux.provider);
      const snapshots = new Map<string, JoiReasoningSessionSnapshot>();
      const runtime = new PiReasoningRuntime({ model: { ...faux.getModel(), contextWindow: 200_000 }, models, thinkingLevel: "off",
        sessionStore: { load: id => Promise.resolve(snapshots.get(id) ?? null), save: next => { snapshots.set(next.sessionId, structuredClone(next)); return Promise.resolve(); } },
        tools: turn => withGoalRequirementsTools(createJoiReasoningTools({
          workbenchId: wb.workbenchId, inputId: turn.inputId, turnId: turn.turnId, work,
          harness: new SqliteJoiHarnessRepository(fixture.database), partners: fixture.partners, instances: fixture.instances,
          memory: fixture.memory, workbenches: fixture.workbenches, workbenchWorkspaces: fixture.workbenchWorkspaces,
          directoryPicker: () => Promise.resolve(null), skills: fixture.skills, models: { list: () => Promise.resolve([]) },
          results: { read: ({ resultId }) => Promise.resolve({ resultId, content: "unused" }) },
          workbenchChanges: { suggestArchive: () => Promise.reject(new Error("unused")), suggestMerge: () => Promise.reject(new Error("unused")) },
          clarifications: inbox,
        }), { requirements, goalInputId: "goal", workbenchId: wb.workbenchId, turnId: turn.turnId, work }),
      });
      const coordinator = new JoiCoordinator({ requirements, clock: fixture.clock, ids: fixture.ids, runtime, workbenches: fixture.workbenches,
        store: { loadInput: id => inbox.loadInput(id), createTurn: turn => inbox.createTurn({ inputId: turn.inputId, turnId: turn.turnId, sessionId: turn.sessionId, workbenchId: turn.workbenchId, createdAt: turn.createdAt }),
          recordTurnProgress: (id, progress) => inbox.recordTurnProgress(id, progress), completeInput: (...args) => inbox.completeInput(...args),
          failTurn: (...args) => inbox.failTurn(...args), requireClarification: (...args) => inbox.requireClarification(...args) },
        router: { decide: () => Promise.reject(new Error("bound goal")) },
        sources: { selectInitial: turnId => Promise.resolve({ turnId, modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake" }) },
      });
      if (scenario === "corrected") await coordinator.handle("goal");
      else await expect(coordinator.handle("goal")).rejects.toMatchObject({ code: scenario === "repeated-pending" ? "goal_requirements_pending" : "goal_requirements_stale" });
      if (scenario !== "repeated-pending") expect(await requirements.load("goal", wb.workbenchId)).toMatchObject({ revision: 2, processedSourceRevision: 3, status: "READY" });
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE input_id='goal' AND status<>'CANCELED'").get())?.n)
        .toBe(scenario === "corrected" ? 1 : 0);
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='partner.dispatch'").get())?.n)
        .toBe(scenario === "corrected" ? 1 : 0);
      const goal = (await fixture.joiHomeFeed.load()).goals.find(g => g.goalId === "goal");
      if (scenario === "corrected") {
        expect(goal).toMatchObject({ status: "ARRANGED", work: { total: 3, active: 1 } });
        expect(goal?.failure).toBeUndefined();
      } else {
        expect(goal).toMatchObject({ status: "FAILED", failure: { attempts: 1, executionStarted: false,
          reasonCode: scenario === "repeated-pending" ? "goal_requirements_pending" : "goal_requirements_stale" } });
        expect(await inbox.loadInput("goal")).toMatchObject({ status: "CONSUMED" });
        expect(await inbox.retry("goal", {})).toMatchObject({ status: "PENDING" });
        faux.setResponses([call("work_dispatch", dispatch(3)), call("work_dispatch", dispatch(2)), fauxAssistantMessage([fauxText("Queued.")])]);
        if (scenario !== "repeated-pending") {
          await coordinator.handle("goal");
          expect((await fixture.joiHomeFeed.load()).goals.find(g => g.goalId === "goal")).toMatchObject({ status: "ARRANGED" });
        }
      }
    } finally { await fixture.close(); }
  });

  it("projects a historical stopped goal as failed without mutating its canceled work or automatically retrying", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { wb, inbox } = await seedCanceledHistory(fixture, "FAILED");
      await inbox.createTurn({ inputId: "goal", turnId: "stopped", sessionId: "stopped-session", workbenchId: wb.workbenchId, createdAt: fixture.clock.now().toISOString() });
      fixture.database.transaction(db => db.prepare("UPDATE joi_turns SET status='FAILED', side_effect_started=1 WHERE turn_id='stopped'").run());
      const before = fixture.database.transaction(db => db.prepare("SELECT status,failed_at FROM joi_inbox_messages WHERE input_id='goal'").get());
      for (let i = 0; i < 2; i++) {
        const goal = (await fixture.joiHomeFeed.load()).goals.find(g => g.goalId === "goal");
        expect(goal).toMatchObject({ status: "FAILED", canArchive: true, canDelete: false, agentCount: 1, work: { total: 2, active: 0 },
          failure: { reasonCode: "joi_task_turn_failed", attempts: 1, executionStarted: true, suggestedAction: "RETRY_OR_EXPORT_DIAGNOSTICS" } });
        expect(fixture.database.transaction(db => db.prepare("SELECT status,failed_at FROM joi_inbox_messages WHERE input_id='goal'").get())).toEqual(before);
      }
      expect(await inbox.retry("goal", {})).toMatchObject({ status: "PENDING" });
      expect((await fixture.joiHomeFeed.load()).goals.find(g => g.goalId === "goal")).toMatchObject({ status: "ARRANGING" });
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE status='CANCELED'").get())?.n).toBe(2);
    } finally { await fixture.close(); }
  });

  it.each(["none", "live-turn", "live-run", "child", "result", "answer", "completed-work", "failed-work", "question", "canceled-goal"] as const)("preserves %s lifecycle when a dispatch fails with canceled history", async state => {
    const fixture = await createRuntimeFixture();
    try {
      const { wb, inbox } = await seedCanceledHistory(fixture, state === "live-run" ? "RUNNING" : undefined);
      fixture.clock.advance(1_000);
      await inbox.retry("goal", {});
      const now = fixture.clock.now().toISOString();
      await inbox.createTurn({ inputId: "goal", turnId: "rejected", sessionId: "session", workbenchId: wb.workbenchId, createdAt: now });
      await inbox.recordTurnProgress("rejected", { sideEffectStarted: true, formalOutputStarted: false });
      if (state === "live-turn") await inbox.createTurn({ inputId: "goal", turnId: "live", sessionId: "live", workbenchId: wb.workbenchId, createdAt: now });
      if (state === "child") fixture.database.transaction(db => db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,goal_input_id,workbench_id,created_at,updated_at)
        VALUES ('child','child','Review','PENDING','goal',?,?,?)`).run(wb.workbenchId, now, now));
      if (state === "result") fixture.database.transaction(db => db.prepare("INSERT INTO joi_goal_result_sets(original_input_id,revision,synthesized_revision,updated_at) VALUES ('goal',1,0,?)").run(now));
      if (state === "answer") await inbox.completeInput("goal", "rejected", { outcome: "DIRECT_ANSWER", completionSummary: "Evidence returned.", committedByTool: true });
      if (state === "completed-work" || state === "failed-work") fixture.database.transaction(db => db.prepare("UPDATE work_items SET status=? WHERE work_id='old-read'").run(state === "completed-work" ? "COMPLETED" : "FAILED"));
      if (state === "question") await inbox.requireClarification("goal", "question_required", "Which date?");
      if (state === "canceled-goal") await inbox.cancel("goal");
      await inbox.failTurn("goal", "rejected", { reasonCode: "goal_requirements_stale" });
      const saved = (await inbox.list()).find(row => row.inputId === "goal");
      if (state === "none") {
        expect(saved).toMatchObject({ status: "CONSUMED", failedAt: now, failureReasonCode: "goal_requirements_stale", failureCount: 1 });
        fixture.clock.advance(1_000);
        await inbox.failTurn("goal", "rejected", { reasonCode: "goal_requirements_stale" });
        expect((await inbox.list()).find(row => row.inputId === "goal")).toMatchObject({ failedAt: now, failureCount: 1 });
      } else expect(saved?.failedAt).toBeUndefined();
      const goal = (await fixture.joiHomeFeed.load()).goals.find(g => g.goalId === "goal");
      if (state === "live-turn" || state === "child") expect(goal?.status).toBe("ARRANGING");
      if (state === "live-run") expect(goal?.status).toBe("RUNNING");
      if (state === "result" || state === "completed-work" || state === "failed-work") expect(goal?.status).toBe("FINALIZING");
      if (state === "answer") expect(goal?.status).toBe("COMPLETED");
      if (state === "question") expect(goal?.status).toBe("NEEDS_ATTENTION");
      if (state === "canceled-goal") expect(goal?.status).toBe("CANCELED");
    } finally { await fixture.close(); }
  });
});
