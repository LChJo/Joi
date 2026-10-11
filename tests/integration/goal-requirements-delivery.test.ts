/* Deterministic fakes fulfill async application ports without external effects. */
/* eslint-disable @typescript-eslint/require-await */
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { appendGoalRequirementSource, SqliteGoalRequirementsRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-requirements-repository.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import { WorkbenchContextAssembler } from "../../src/main/application/joi/workbench-context-assembler.js";
import { SqliteWorkbenchContextRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-context-repository.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqliteWorkspaceLeaseManager } from "../../src/main/infrastructure/persistence/sqlite-workspace-lease-manager.js";
import { SqliteWorkResultRepository } from "../../src/main/infrastructure/persistence/sqlite-work-result-repository.js";
import { SqlitePartnerDispatchDelivery } from "../../src/main/infrastructure/a2a/partner-dispatch-delivery-adapter.js";
import type { PartnerRunRequest } from "../../src/main/application/ports/partner-execution.js";
import { enqueueGoalResultSynthesis } from "../../src/main/infrastructure/persistence/sqlite-goal-result-synthesis.js";
import { AgentDispatchComponent } from "../../src/main/application/actors/components/agent-dispatch-component.js";

async function setup(fixture: RuntimeFixture, kind: "local-pi" | "a2a" = "local-pi") {
  const wb = await fixture.workbenchRegistry.create({ name: "test", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
  await fixture.workbenchWorkspaces.bindExisting(wb.workbenchId, fixture.root);
  const partner = await fixture.partners.add({ kind, displayName: "test", capabilities: [], skills: [], tools: [] });
  if (kind === "a2a") {
    const connection = await fixture.agents.createShell({ name: "fake remote", cardUrl: "https://fixture.invalid/card" });
    fixture.database.transaction(db => {
      db.prepare("UPDATE partners SET legacy_agent_connection_id = NULL WHERE legacy_agent_connection_id = ?").run(connection.agentConnectionId);
      db.prepare("UPDATE partners SET legacy_agent_connection_id = ? WHERE partner_id = ?").run(connection.agentConnectionId, partner.partnerId);
    });
  }
  const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
  const now = fixture.clock.now().toISOString();
  await inbox.create({ inputId: "goal", idempotencyKey: "goal", body: "Only reply to today's conversations. Unrelated personal background.", status: "PENDING", workbenchId: wb.workbenchId, createdAt: now, updatedAt: now });
  const requirements = new SqliteGoalRequirementsRepository(fixture.database);
  await requirements.ensure({ goalInputId: "goal", workbenchId: wb.workbenchId });
  await requirements.readSource({ goalInputId: "goal", workbenchId: wb.workbenchId, sourceRevision: 1, offset: 0 });
  await requirements.update({ goalInputId: "goal", workbenchId: wb.workbenchId, expectedRevision: 0, processedSourceRevision: 1, upserts: [
    { id: "day", text: "Only reply to today's conversations.", kind: "CONSTRAINT", mandatory: true, scope: "GLOBAL", source: { sourceRevision: 1, start: 0, end: 36 } },
    { id: "local", text: "Unrelated personal background.", kind: "PREFERENCE", mandatory: false, scope: "SCOPED", source: { sourceRevision: 1, start: 37, end: 65 } },
  ], retirements: [] });
  await inbox.createTurn({ inputId: "goal", turnId: "turn", sessionId: "session", workbenchId: wb.workbenchId, createdAt: now });
  const repo = new SqliteWorkPlanRepository(fixture.database);
  const work = new WorkOrchestrationService({ clock: fixture.clock, ids: fixture.ids, requirements, repository: repo, reassignment: repo, recovery: repo, goalGate: repo,
    partners: fixture.partners, policy: { evaluate: async () => ({ allowed: true }) } });
  const plan = await work.plan({ requirementsRevision: 1, inputId: "goal", turnId: "turn", workbenchId: wb.workbenchId, dependencies: [],
    work: [{ key: "run", title: "reply", partnerId: partner.partnerId, accessMode: kind === "a2a" ? "NONE" : "READ", instructions: "Reply to the assigned conversation.", acceptanceChecks: [{ kind: "BODY_PRESENT" }] }] });
  const workId = plan.waves[0]?.[0];
  if (workId === undefined) throw new Error("fixture work missing");
  const outbox = fixture.database.transaction(db => db.prepare("SELECT outbox_id, payload_json FROM outbox WHERE kind = 'partner.dispatch' ORDER BY created_at LIMIT 1").get());
  if (outbox === undefined) throw new Error("fixture outbox missing");
  const claim = { outboxId: String(outbox.outbox_id), payload: JSON.parse(String(outbox.payload_json)) as { actionId: string; dispatchAttemptId: string; workId: string },
    kind: "partner.dispatch", status: "CLAIMED" as const, attemptCount: 0, availableAt: now, createdAt: now };
  return { wb, inbox, requirements, work, repo, workId, claim };
}

function delivery(fixture: RuntimeFixture, capture: (text: string, request?: PartnerRunRequest) => void, afterContext?: () => Promise<void>) {
  const contexts = new SqliteWorkbenchContextRepository(fixture.database);
  const assembler = new WorkbenchContextAssembler({ workbenches: fixture.workbenches, clock: fixture.clock, ids: fixture.ids, projections: contexts, snapshots: contexts });
  return new SqlitePartnerDispatchDelivery({ clock: fixture.clock, database: fixture.database, contexts,
    contextAssembler: { assemble: async input => { const result = await assembler.assemble(input); await afterContext?.(); return result; } },
    partners: new SqlitePartnerRegistryRepository(fixture.database), leases: new SqliteWorkspaceLeaseManager({ clock: fixture.clock, database: fixture.database }),
    results: new SqliteWorkResultRepository(fixture.database), verifier: { verify: async () => ({ status: "PASSED" }) },
    instances: { dispatch: async input => { capture(input.request.taskProjection, input.request); return { actionId: input.request.actionId, workId: input.request.workId, status: "COMPLETED", body: "Done", artifacts: [], externalRunId: "fake" }; } },
    gateway: { recover: async () => { throw new Error("fixture must not recover"); }, startWithResult: async input => { capture(input.parts.filter(p => p.kind === "text").map(p => "text" in p ? p.text : "").join("\n")); throw new Error("fixture remote capture"); } },
  });
}

describe("requirements dispatch and start gates", () => {
  it("wakes the same pending dispatch when its brief is refreshed, without replaying a duplicate update", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const ctx = await setup(fixture);
      const deferred = new Date(fixture.clock.now().getTime() + 60 * 60_000).toISOString();
      fixture.database.transaction(db => db.prepare("UPDATE outbox SET available_at = ? WHERE outbox_id = ?").run(deferred, ctx.claim.outboxId));
      const update = { goalInputId: "goal", workbenchId: ctx.wb.workbenchId, workId: ctx.workId, turnId: "turn", actionId: "wake-brief",
        instructions: "Apply the current requirements.", requirementsRevision: 1 };
      await ctx.work.refreshBrief(update);
      const refreshed = fixture.database.transaction(db => db.prepare("SELECT status, available_at FROM outbox WHERE outbox_id = ?").get(ctx.claim.outboxId));
      expect(refreshed).toMatchObject({ status: "PENDING", available_at: fixture.clock.now().toISOString() });
      fixture.database.transaction(db => db.prepare("UPDATE outbox SET available_at = ? WHERE outbox_id = ?").run(deferred, ctx.claim.outboxId));
      await ctx.work.refreshBrief({ ...update, instructions: "Duplicate update" });
      expect(fixture.database.transaction(db => db.prepare("SELECT available_at FROM outbox WHERE outbox_id = ?").get(ctx.claim.outboxId))?.available_at).toBe(deferred);
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'partner.dispatch'").get())?.n).toBe(1);
    } finally { await fixture.close(); }
  });

  it("keeps requirement waits outside the persisted preparation attempt budget", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const ctx = await setup(fixture);
      fixture.database.transaction(db => appendGoalRequirementSource(db, "goal", "New user restriction"));
      const handler = delivery(fixture, () => { throw new Error("must not execute"); });
      const component = new AgentDispatchComponent({ workbenchId: ctx.wb.workbenchId, partnerId: "fixture", owner: "requirements-test",
        claims: { listClaimable: async () => [{ attemptCount: 0, dispatchAttemptId: ctx.claim.payload.dispatchAttemptId, outboxId: ctx.claim.outboxId,
          kind: "LOCAL_PI", payloadJson: JSON.stringify(ctx.claim.payload) }], listOrphanRuns: async () => [] },
        delivery: handler, outbox: fixture.database.store });
      await component.update({ now: fixture.clock.now(), clock: fixture.clock, tickId: 1 });
      const row = fixture.database.transaction(db => db.prepare("SELECT status, attempt_count, available_at FROM outbox WHERE outbox_id = ?").get(ctx.claim.outboxId));
      expect(row).toMatchObject({ status: "PENDING", attempt_count: 0,
        available_at: new Date(fixture.clock.now().getTime() + 5000).toISOString() });
    } finally { await fixture.close(); }
  });

  it.each(["complete", "fail", "no-disposition"] as const)("retires a routed synthesis superseded by new results when its turn ends with %s", async ending => {
    const fixture = await createRuntimeFixture();
    try {
      const ctx = await setup(fixture);
      await delivery(fixture, () => undefined).handle(ctx.claim);
      const event = fixture.database.transaction(db => db.prepare("SELECT e.event_id, r.result_id FROM partner_result_events e JOIN work_results r ON r.run_id = e.run_id LIMIT 1").get());
      const first = await ctx.inbox.enqueuePartnerResult({ workbenchId: ctx.wb.workbenchId, workId: ctx.workId, eventId: String(event?.event_id), status: "COMPLETED", resultId: String(event?.result_id), summary: "Done" });
      if (first === null) throw new Error("fixture synthesis missing");
      await ctx.inbox.createTurn({ inputId: first, turnId: "synthesis-old", sessionId: "synth", workbenchId: ctx.wb.workbenchId,
        createdAt: fixture.clock.now().toISOString(), requirementsRevision: 1 });
      const second = fixture.database.transaction(db => {
        db.prepare("UPDATE joi_goal_result_sets SET revision = revision + 1 WHERE original_input_id = 'goal'").run();
        return enqueueGoalResultSynthesis(db, "goal", ctx.wb.workbenchId, fixture.clock.now().toISOString());
      });
      if (second === null) throw new Error("fixture replacement synthesis missing");
      if (ending === "fail") await ctx.inbox.failTurn(first, "synthesis-old");
      else await ctx.inbox.completeInput(first, "synthesis-old", ending === "no-disposition" ? undefined
        : { outcome: "RESULT_SYNTHESIZED", completionSummary: "Outdated answer", committedByTool: true });
      expect(fixture.database.transaction(db => db.prepare("SELECT status FROM joi_inbox_messages WHERE input_id = ?").get(first))?.status).toBe("CONSUMED");
      expect(fixture.database.transaction(db => db.prepare("SELECT status FROM joi_inbox_messages WHERE input_id = ?").get(second))?.status).toBe("PENDING");
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM joi_goal_outcomes WHERE input_id = 'goal'").get())?.n).toBe(0);
    } finally { await fixture.close(); }
  });

  it("pins current requirements through reassignment, idempotent resume and supplemental recovery", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const ctx = await setup(fixture);
      const partner = await fixture.partners.add({ kind: "local-pi", displayName: "alternative", capabilities: [], skills: [], tools: [] });
      fixture.database.transaction(db => db.prepare("UPDATE work_items SET status = 'READY' WHERE work_id = ?").run(ctx.workId));
      const reassign = { workbenchId: ctx.wb.workbenchId, workId: ctx.workId, turnId: "turn", partnerId: partner.partnerId, requirementsRevision: 1, instructions: "Continue only the assigned Work.", requirementIds: ["local"], allRequirements: true };
      await expect(ctx.work.reassign({ ...reassign, requirementsRevision: 0 })).rejects.toMatchObject({ code: "goal_requirements_stale" });
      await ctx.work.reassign(reassign);
      fixture.database.transaction(db => db.prepare("UPDATE work_items SET status = 'WAITING' WHERE work_id = ?").run(ctx.workId));
      const resume = { workbenchId: ctx.wb.workbenchId, workId: ctx.workId, turnId: "turn-resume", actionId: "stable-resume", requirementsRevision: 1, instructions: "Apply the relevant user answer." };
      await ctx.inbox.createTurn({ inputId: "goal", turnId: "turn-resume", workbenchId: ctx.wb.workbenchId, sessionId: "resume", createdAt: fixture.clock.now().toISOString() });
      const first = await ctx.work.resume(resume);
      expect(await ctx.work.resume({ ...resume, instructions: "Duplicate must not replace" })).toEqual(first);
      expect((await ctx.work.readBrief("goal", ctx.wb.workbenchId, ctx.workId))?.instructions).toBe(resume.instructions);
      fixture.database.transaction(db => db.prepare("UPDATE work_items SET status = 'FAILED' WHERE work_id = ?").run(ctx.workId));
      await ctx.work.supplement({ sourceWorkId: ctx.workId, workbenchId: ctx.wb.workbenchId, turnId: "turn-resume", partnerId: partner.partnerId, accessMode: "READ", requirementsRevision: 1, title: "Close the remaining gap", instructions: "Close the remaining evidence gap.", requirementIds: ["local"] });
      expect((await ctx.work.listForGoal("goal", ctx.wb.workbenchId)).every(work => work.requirementsRevision === 1)).toBe(true);
      expect(await ctx.work.readBrief("different-goal", ctx.wb.workbenchId, ctx.workId)).toBeNull();
    } finally { await fixture.close(); }
  });
  it.each(["local-pi", "a2a"] as const)("automatically carries global mandatory requirements in the actual %s request", async kind => {
    const fixture = await createRuntimeFixture();
    try {
      const ctx = await setup(fixture, kind);
      let text = "";
      let required = "";
      await delivery(fixture, (value, request) => { text = value; required = request?.requiredContext ?? ""; }).handle(ctx.claim);
      expect(text).toContain("Only reply to today's conversations.");
      expect(text).toContain("Reply to the assigned conversation.");
      expect(text).not.toContain("Unrelated personal background.");
      expect(text).not.toContain("Original user request");
      if (kind === "local-pi") expect(required).toContain("Only reply to today's conversations.");
    } finally { await fixture.close(); }
  });

  it("holds stale queued Work, refreshes it without replacing its outbox and keeps running snapshots immutable", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const ctx = await setup(fixture);
      const text = "Only reply to yesterday's conversations.";
      fixture.database.transaction(db => appendGoalRequirementSource(db, "goal", text));
      const handler = delivery(fixture, () => undefined);
      await expect(handler.prepare({ ...ctx.claim, kind: "LOCAL_PI", payloadJson: JSON.stringify(ctx.claim.payload), dispatchAttemptId: ctx.claim.payload.dispatchAttemptId })).rejects.toMatchObject({ code: "goal_requirements_pending" });
      await ctx.requirements.readSource({ goalInputId: "goal", workbenchId: ctx.wb.workbenchId, sourceRevision: 2, offset: 0 });
      await ctx.requirements.update({ goalInputId: "goal", workbenchId: ctx.wb.workbenchId, expectedRevision: 1, processedSourceRevision: 2, retirements: [],
        upserts: [{ id: "day", kind: "CONSTRAINT", scope: "GLOBAL", mandatory: true, text, explicitUserCorrection: true, source: { sourceRevision: 2, start: 0, end: text.length } }] });
      await expect(handler.handle(ctx.claim)).rejects.toMatchObject({ code: "goal_requirements_stale" });
      const update = { goalInputId: "goal", workbenchId: ctx.wb.workbenchId, workId: ctx.workId, turnId: "turn", actionId: "refresh", instructions: "Perform the bounded reply.", requirementsRevision: 2 };
      await ctx.work.refreshBrief(update);
      await ctx.work.refreshBrief({ ...update, instructions: "Duplicate must not overwrite" });
      expect((await ctx.work.listForGoal("goal", ctx.wb.workbenchId))[0]).toMatchObject({ requirementsRevision: 2 });
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'partner.dispatch'").get())?.n).toBe(1);
      let actual = "";
      await delivery(fixture, value => { actual = value; }).handle(ctx.claim);
      expect(actual).toContain("yesterday");
      expect(actual).not.toContain("Duplicate must not overwrite");
      await expect(ctx.work.refreshBrief({ ...update, actionId: "late" })).rejects.toMatchObject({ code: "work_brief_update_not_allowed" });
    } finally { await fixture.close(); }
  });

  it("rechecks freshness after asynchronous context preparation before persisting a start", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const ctx = await setup(fixture);
      const handler = delivery(fixture, () => { throw new Error("must not execute"); }, async () => {
        fixture.database.transaction(db => appendGoalRequirementSource(db, "goal", "Additional user restriction"));
      });
      await expect(handler.handle(ctx.claim)).rejects.toMatchObject({ code: "goal_requirements_pending" });
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM partner_runs").get())?.n).toBe(0);
    } finally { await fixture.close(); }
  });

  it("refreshes an unstarted continuation while preserving the historical run's requirements snapshot", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const ctx = await setup(fixture);
      fixture.database.transaction(db => {
        db.prepare(`INSERT INTO partner_runs (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id,
          kind, external_run_id, status, created_at, updated_at, requirements_revision, requirements_context)
          SELECT 'historical', a.dispatch_attempt_id, a.action_id, w.workbench_id, w.work_id, a.partner_revision_id,
            'LOCAL_PI', 'fake-old', 'WAITING_INPUT', w.created_at, w.updated_at, 1, 'IMMUTABLE_OLD_REQUIREMENTS'
          FROM dispatch_attempts a JOIN work_items w ON w.work_id = a.work_id WHERE w.work_id = ?`).run(ctx.workId);
        db.prepare("UPDATE work_items SET status = 'WAITING' WHERE work_id = ?").run(ctx.workId);
      });
      await ctx.inbox.createTurn({ inputId: "goal", turnId: "continuation", workbenchId: ctx.wb.workbenchId, sessionId: "continue", createdAt: fixture.clock.now().toISOString() });
      await ctx.work.resume({ workbenchId: ctx.wb.workbenchId, workId: ctx.workId, turnId: "continuation", instructions: "Continue the existing Work.", requirementsRevision: 1 });
      await ctx.work.refreshBrief({ goalInputId: "goal", workbenchId: ctx.wb.workbenchId, workId: ctx.workId, turnId: "continuation", actionId: "refresh-continuation", instructions: "Refined instructions for the unstarted continuation.", requirementsRevision: 1 });
      expect((await ctx.work.readBrief("goal", ctx.wb.workbenchId, ctx.workId))?.instructions).toContain("Refined instructions");
      expect(fixture.database.transaction(db => db.prepare("SELECT requirements_context FROM partner_runs WHERE run_id = 'historical'").get())?.requirements_context).toBe("IMMUTABLE_OLD_REQUIREMENTS");
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM partner_runs").get())?.n).toBe(1);
    } finally { await fixture.close(); }
  });

  it("invalidates old outcomes and schedules synthesis when only requirements change", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const ctx = await setup(fixture);
      await delivery(fixture, () => undefined).handle(ctx.claim);
      const event = fixture.database.transaction(db => db.prepare("SELECT e.event_id, r.result_id FROM partner_result_events e JOIN work_results r ON r.run_id = e.run_id LIMIT 1").get());
      const first = await ctx.inbox.enqueuePartnerResult({ workbenchId: ctx.wb.workbenchId, workId: ctx.workId, eventId: String(event?.event_id), status: "COMPLETED", resultId: String(event?.result_id), summary: "Done" });
      expect(first).toContain(":r1:q1");
      await ctx.inbox.createTurn({ inputId: String(first), turnId: "synthesis-1", sessionId: "synth", workbenchId: ctx.wb.workbenchId, createdAt: fixture.clock.now().toISOString() });
      await ctx.requirements.checkpointTurn("goal", "synthesis-1", 1);
      await ctx.inbox.completeInput(String(first), "synthesis-1", { outcome: "RESULT_SYNTHESIZED", completionSummary: "First answer", committedByTool: true });
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM joi_current_goal_outcomes").get())?.n).toBe(1);
      const text = "Use a different delivery format.";
      fixture.database.transaction(db => appendGoalRequirementSource(db, "goal", text));
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM joi_current_goal_outcomes").get())?.n).toBe(0);
      await ctx.requirements.readSource({ goalInputId: "goal", workbenchId: ctx.wb.workbenchId, sourceRevision: 2, offset: 0 });
      await ctx.requirements.update({ goalInputId: "goal", workbenchId: ctx.wb.workbenchId, expectedRevision: 1, processedSourceRevision: 2, retirements: [],
        upserts: [{ id: "format", text, kind: "DELIVERABLE", mandatory: true, scope: "GLOBAL", source: { sourceRevision: 2, start: 0, end: text.length } }] });
      const queued = fixture.database.transaction(db => db.prepare("SELECT input_id, status FROM joi_inbox_messages WHERE goal_input_id = 'goal' AND result_revision = 1 AND requirements_revision = 2").get());
      expect(queued).toMatchObject({ input_id: "joi_result_input:goal:goal:r1:q2", status: "PENDING" });
      await ctx.inbox.createTurn({ inputId: String(first), turnId: "stale-synthesis", sessionId: "synth", workbenchId: ctx.wb.workbenchId, createdAt: fixture.clock.now().toISOString() });
      fixture.database.transaction(db => db.prepare("UPDATE joi_turns SET requirements_revision = 1 WHERE turn_id = 'stale-synthesis'").run());
      await expect(ctx.inbox.completeInput(String(first), "stale-synthesis", { outcome: "RESULT_SYNTHESIZED", completionSummary: "Stale answer", committedByTool: true })).resolves.toMatchObject({ goalOutcomePersisted: false });
      expect(fixture.database.transaction(db => db.prepare("SELECT requirements_revision, completion_summary FROM joi_goal_outcomes WHERE input_id = 'goal'").get()))
        .toMatchObject({ requirements_revision: 1, completion_summary: "First answer" });
    } finally { await fixture.close(); }
  });

  it("retires a superseded synthesis input so only the current requirements run", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const ctx = await setup(fixture);
      await delivery(fixture, () => undefined).handle(ctx.claim);
      const event = fixture.database.transaction(db => db.prepare("SELECT e.event_id, r.result_id FROM partner_result_events e JOIN work_results r ON r.run_id = e.run_id LIMIT 1").get());
      const first = await ctx.inbox.enqueuePartnerResult({ workbenchId: ctx.wb.workbenchId, workId: ctx.workId, eventId: String(event?.event_id), status: "COMPLETED", resultId: String(event?.result_id), summary: "Done" });
      expect(first).toContain(":r1:q1");
      const text = "Use a different delivery format.";
      fixture.database.transaction(db => appendGoalRequirementSource(db, "goal", text));
      await ctx.requirements.readSource({ goalInputId: "goal", workbenchId: ctx.wb.workbenchId, sourceRevision: 2, offset: 0 });
      await ctx.requirements.update({ goalInputId: "goal", workbenchId: ctx.wb.workbenchId, expectedRevision: 1, processedSourceRevision: 2, retirements: [],
        upserts: [{ id: "format", text, kind: "DELIVERABLE", mandatory: true, scope: "GLOBAL", source: { sourceRevision: 2, start: 0, end: text.length } }] });
      // The superseded input carries requirements the goal no longer runs under. Left PENDING, the
      // scheduler picks it up and runs a second synthesis against the stale contract.
      const superseded = fixture.database.transaction(db => db.prepare("SELECT status FROM joi_inbox_messages WHERE input_id = ?").get(String(first))) as { status?: unknown } | undefined;
      expect(superseded?.status).not.toBe("PENDING");
      const current = fixture.database.transaction(db => db.prepare("SELECT status FROM joi_inbox_messages WHERE input_id = ?").get("joi_result_input:goal:goal:r1:q2")) as { status?: unknown } | undefined;
      expect(current?.status).toBe("PENDING");
    } finally { await fixture.close(); }
  });
});
