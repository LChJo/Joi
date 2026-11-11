import { createRuntimeFixture } from "../support/runtime-fixture.js";
import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteGoalRequirementsRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-requirements-repository.js";
import { Type } from "typebox";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, } from "@earendil-works/pi-ai";
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import { withGoalRequirementsTools } from "../../src/main/infrastructure/pi/joi-requirements-tools.js";
import type { JoiReasoningSessionSnapshot } from "../../src/main/application/ports/primary-reasoning-runtime.js";

describe("effective goal requirements", () => {
  it("extracts and refreshes requirements through real Pi tool calls and keeps full contracts out of persisted tool receipts", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const wb = await fixture.workbenchRegistry.create({ name: "test", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const rule = "Only reply to the current day's conversations.";
      const body = `${"x".repeat(6000)}${rule}${"y".repeat(6000)}`;
      await inbox.create({ inputId: "goal", idempotencyKey: "goal", body, status: "PENDING", workbenchId: wb.workbenchId, createdAt: fixture.clock.now().toISOString(), updatedAt: fixture.clock.now().toISOString() });
      const requirements = new SqliteGoalRequirementsRepository(fixture.database);
      const faux = fauxProvider({ provider: "effective-requirement-flow" });
      const requests: string[] = [];
      const call = (name: string, args: Parameters<typeof fauxToolCall>[1], answer = "") => fauxAssistantMessage([...(answer === "" ? [] : [fauxText(answer)]), fauxToolCall(name, args)], { stopReason: "toolUse" });
      faux.setResponses([
        ...[0, 4000, 8000, 12000].map(offset => call("goal_read_inputs", { sourceRevision: 1, offset })),
        call("goal_update_requirements", { expectedRevision: 0, processedSourceRevision: 1, retirements: [], upserts: [{ id: "day", kind: "CONSTRAINT", scope: "GLOBAL", mandatory: true, text: rule, source: { sourceRevision: 1, quote: rule } }] }),
        call("turn_complete", { outcome: "DIRECT_ANSWER", requirementsRevision: 1 }, "Requirements established."),
        fauxAssistantMessage([fauxText("Requirements established.")]),
        call("goal_read_inputs", { sourceRevision: 2, offset: 0 }),
        call("goal_update_requirements", { expectedRevision: 1, processedSourceRevision: 2, upserts: [], retirements: [] }),
        call("turn_complete", { outcome: "DIRECT_ANSWER", requirementsRevision: 1 }, "Requirements retained."),
        fauxAssistantMessage([fauxText("Requirements retained.")]),
      ].map(message => context => { requests.push(JSON.stringify(context.messages)); return message; }));
      const models = createModels(); models.setProvider(faux.provider);
      const snapshots = new Map<string, JoiReasoningSessionSnapshot>();
      const runtime = new PiReasoningRuntime({ model: { ...faux.getModel(), contextWindow: 200000 }, models, thinkingLevel: "off",
        sessionStore: { load: id => Promise.resolve(snapshots.get(id) ?? null), save: next => { snapshots.set(next.sessionId, structuredClone(next)); return Promise.resolve(); } },
        tools: turn => withGoalRequirementsTools([{ name: "turn_complete", label: "Complete", description: "Complete", parameters: Type.Object({ outcome: Type.String() }),
          execute: (_id, raw) => Promise.resolve({ content: [{ type: "text", text: JSON.stringify({ outcome: (raw as { outcome: string }).outcome, status: "COMMITTED" }) }], details: {} }) }], {
          requirements, goalInputId: "goal", workbenchId: wb.workbenchId, turnId: turn.turnId,
          work: { listForGoal: () => Promise.resolve([]), readBrief: () => Promise.resolve(null), refreshBrief: () => Promise.resolve() },
        }),
      });
      const coordinator = new JoiCoordinator({ requirements, clock: fixture.clock, ids: fixture.ids, runtime, workbenches: fixture.workbenches,
        store: { loadInput: id => inbox.loadInput(id),
          createTurn: input => inbox.createTurn({ inputId: input.inputId, turnId: input.turnId, sessionId: input.sessionId, workbenchId: input.workbenchId, createdAt: input.createdAt,
            ...(input.requirementsRevision === undefined ? {} : { requirementsRevision: input.requirementsRevision }) }),
          completeInput: (id, turnId, completion) => inbox.completeInput(id, turnId, completion),
          requireClarification: (id, reason, prompt) => inbox.requireClarification(id, reason, prompt),
          failTurn: (id, turnId) => inbox.failTurn(id, turnId),
        },
        router: { decide: () => Promise.reject(new Error("bound goal")) },
        sources: { selectInitial: turnId => Promise.resolve({ turnId, modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake" }) },
      });
      await coordinator.handle("goal");
      await inbox.retry("goal", { text: "Add another greeting without changing the boundaries." });
      await coordinator.handle("goal");
      expect((await requirements.load("goal", wb.workbenchId))?.requirements[0]?.text).toBe(rule);
      expect(requests.at(-1)).toContain("requirementsRevision=1");
      expect(requests.at(-1)).toContain(rule);
      const snapshot = snapshots.get(`joi_session:${wb.workbenchId}:goal`);
      expect(JSON.stringify(snapshot)).not.toContain("Effective user requirements (user scope");
      const receipts = (snapshot?.messages ?? []).filter(message => (message as { role?: string; toolName?: string }).role === "toolResult" && (message as { toolName?: string }).toolName === "goal_update_requirements");
      expect(JSON.stringify(receipts)).toContain("requirementCount");
      expect(JSON.stringify(receipts)).not.toContain(rule);
    } finally { await fixture.close(); }
  });
  it("can checkpoint requirements from a source page while execution stays blocked until the entire source is read", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const wb = await fixture.workbenchRegistry.create({ name: "test", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const repo = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const text = `No external writes. ${"😀".repeat(6000)}`;
      await repo.create({ inputId: "long", idempotencyKey: "long", body: text, status: "PENDING", workbenchId: wb.workbenchId, createdAt: fixture.clock.now().toISOString(), updatedAt: fixture.clock.now().toISOString() });
      const store = new SqliteGoalRequirementsRepository(fixture.database);
      await store.ensure({ goalInputId: "long", workbenchId: wb.workbenchId });
      await store.readSource({ goalInputId: "long", workbenchId: wb.workbenchId, sourceRevision: 1, offset: 0 });
      const partial = await store.update({ goalInputId: "long", workbenchId: wb.workbenchId, expectedRevision: 0, processedSourceRevision: 0,
        upserts: [{ id: "writes", kind: "CONSTRAINT", scope: "GLOBAL", mandatory: true, text: "No external writes.", source: { sourceRevision: 1, start: 0, end: 19 } }], retirements: [] });
      expect(partial.status).toBe("DIRTY");
      await expect(store.assertReady("long", 1)).rejects.toMatchObject({ code: "goal_requirements_pending" });
      await expect(store.update({ goalInputId: "long", workbenchId: wb.workbenchId, expectedRevision: 1, processedSourceRevision: 1, upserts: [], retirements: [] })).rejects.toMatchObject({ code: "goal_requirements_sources_unread" });
      for (let offset = 4000; offset < text.length; offset += 4000) await store.readSource({ goalInputId: "long", workbenchId: wb.workbenchId, sourceRevision: 1, offset });
      expect((await store.update({ goalInputId: "long", workbenchId: wb.workbenchId, expectedRevision: 1, processedSourceRevision: 1, upserts: [], retirements: [] })).status).toBe("READY");
    } finally { await fixture.close(); }
  });
  it("reads the middle of long input, retains constraints across unrelated continuations and rejects stale versions", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const wb = await fixture.workbenchRegistry.create({ name: "test", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository: new SqliteJoiInboxRepository(fixture.database, fixture.clock) });
      const rule = "Only reply to conversations from the current day.";
      const text = `${"x".repeat(6000)}${rule}${"y".repeat(6000)}`;
      const goal = await inbox.accept({ text, idempotencyKey: "goal", workbenchId: wb.workbenchId });
      const store = new SqliteGoalRequirementsRepository(fixture.database);
      await store.ensure({ goalInputId: goal.inputId, workbenchId: wb.workbenchId });
      await expect(store.update({ goalInputId: goal.inputId, workbenchId: wb.workbenchId, expectedRevision: 0, processedSourceRevision: 1, upserts: [], retirements: [] })).rejects.toMatchObject({ code: "goal_requirements_sources_unread" });
      let all = "";
      let offset = 0;
      do {
        const page = await store.readSource({ goalInputId: goal.inputId, workbenchId: wb.workbenchId, sourceRevision: 1, offset });
        all += page.text;
        offset = page.nextOffset ?? text.length;
      } while (offset < text.length);
      expect(all).toBe(text);
      const source = { sourceRevision: 1, start: 6000, end: 6000 + rule.length };
      await store.update({ goalInputId: goal.inputId, workbenchId: wb.workbenchId, expectedRevision: 0, processedSourceRevision: 1, upserts: [{ id: "day", kind: "CONSTRAINT", scope: "GLOBAL", mandatory: true, text: rule, source }], retirements: [] });
      for (let index = 0; index < 10; index++) {
        fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(goal.inputId));
        await inbox.retry({ inputId: goal.inputId, text: `continue ${String(index)}` });
        const current = await store.load(goal.inputId, wb.workbenchId);
        expect(current?.status).toBe("DIRTY");
        await expect(store.assertReady(goal.inputId, 1)).rejects.toMatchObject({ code: "goal_requirements_pending" });
        await store.readSource({ goalInputId: goal.inputId, workbenchId: wb.workbenchId, sourceRevision: index + 2, offset: 0 });
        const next = await store.update({ goalInputId: goal.inputId, workbenchId: wb.workbenchId, expectedRevision: 1, processedSourceRevision: index + 2, upserts: [], retirements: [] });
        expect(next.revision).toBe(1);
        expect(next.requirements[0]?.text).toBe(rule);
      }
      await expect(store.assertReady(goal.inputId, 0)).rejects.toMatchObject({ code: "goal_requirements_stale" });
      expect((await store.load(goal.inputId, wb.workbenchId))?.requirements).toHaveLength(1);
      const scheduled = await store.ensure({ goalInputId: goal.inputId, workbenchId: wb.workbenchId, executionKey: "execution-1", executionPrompt: "Continue within the existing boundaries." });
      expect(scheduled.status).toBe("DIRTY");
      await store.ensure({ goalInputId: goal.inputId, workbenchId: wb.workbenchId, executionKey: "execution-1", executionPrompt: "Edited after execution began" });
      expect((await store.readSource({ goalInputId: goal.inputId, workbenchId: wb.workbenchId, sourceRevision: 12, offset: 0 })).text).toBe("Continue within the existing boundaries.");
      await store.update({ goalInputId: goal.inputId, workbenchId: wb.workbenchId, expectedRevision: 1, processedSourceRevision: 12, upserts: [], retirements: [] });
      const another = await store.ensure({ goalInputId: goal.inputId, workbenchId: wb.workbenchId, executionKey: "execution-2", executionPrompt: "Next scheduled continuation" });
      expect(another.sourceRevision).toBe(13);
      expect(another.requirements[0]?.text).toBe(rule);
    } finally { await fixture.close(); }
  });

  it("migrates legacy input only on ensure, respects goal isolation and freezes the actual Routine prompt", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const wb = await fixture.workbenchRegistry.create({ name: "test", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const repo = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      await repo.create({ inputId: "legacy", idempotencyKey: "legacy", body: "original [用户补充] literal text", status: "PENDING", workbenchId: wb.workbenchId, createdAt: fixture.clock.now().toISOString(), updatedAt: fixture.clock.now().toISOString() });
      fixture.database.transaction(db => db.prepare("DELETE FROM joi_goal_requirement_sources WHERE goal_input_id = 'legacy'").run());
      const store = new SqliteGoalRequirementsRepository(fixture.database);
      expect(await store.load("legacy", wb.workbenchId)).toBeNull();
      await store.ensure({ goalInputId: "legacy", workbenchId: wb.workbenchId });
      expect((await store.readSource({ goalInputId: "legacy", workbenchId: wb.workbenchId, sourceRevision: 1, offset: 0 })).text).toBe("original [用户补充] literal text");
      await expect(store.load("legacy", "other-workbench")).rejects.toMatchObject({ code: "goal_requirements_scope_invalid" });
      await repo.create({ inputId: "routine", idempotencyKey: "routine", body: "Execute Routine once", automationRoutineId: "routine-id", status: "PENDING", workbenchId: wb.workbenchId, createdAt: fixture.clock.now().toISOString(), updatedAt: fixture.clock.now().toISOString() });
      await store.ensure({ goalInputId: "routine", workbenchId: wb.workbenchId, executionPrompt: "actual scheduled requirements" });
      await store.ensure({ goalInputId: "routine", workbenchId: wb.workbenchId, executionPrompt: "later edit" });
      expect((await store.readSource({ goalInputId: "routine", workbenchId: wb.workbenchId, sourceRevision: 1, offset: 0 })).text).toBe("actual scheduled requirements");
    } finally { await fixture.close(); }
  });

  it("never ends a source page on half of a surrogate pair", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const wb = await fixture.workbenchRegistry.create({ name: "test", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const repo = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const now = fixture.clock.now().toISOString();
      // The emoji straddles the first page's 4,000-code-unit boundary exactly.
      const text = `${"a".repeat(3999)}😀${"b".repeat(100)}`;
      await repo.create({ inputId: "split", idempotencyKey: "split", body: text, status: "PENDING", workbenchId: wb.workbenchId, createdAt: now, updatedAt: now });
      const store = new SqliteGoalRequirementsRepository(fixture.database);
      await store.ensure({ goalInputId: "split", workbenchId: wb.workbenchId });
      const page = await store.readSource({ goalInputId: "split", workbenchId: wb.workbenchId, sourceRevision: 1, offset: 0 });
      expect(page.nextOffset).toBeDefined();
      // A page ending mid-pair hands the model a lone surrogate it can never quote back, so the
      // citation it returns fails to resolve against the source it was just shown.
      expect(/[\uD800-\uDBFF]$/u.test(page.text)).toBe(false);
    } finally { await fixture.close(); }
  });

  it("freezes the Routine prompt per execution instead of returning the newest one", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const wb = await fixture.workbenchRegistry.create({ name: "test", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const repo = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const now = fixture.clock.now().toISOString();
      await repo.create({ inputId: "routine", idempotencyKey: "routine", body: "Run the Routine.", status: "PENDING", workbenchId: wb.workbenchId, createdAt: now, updatedAt: now });
      const store = new SqliteGoalRequirementsRepository(fixture.database);
      const first = await store.ensure({ goalInputId: "routine", workbenchId: wb.workbenchId, executionPrompt: "first run prompt", executionKey: "exec-1" });
      expect(first.executionPrompt).toBe("first run prompt");
      await store.ensure({ goalInputId: "routine", workbenchId: wb.workbenchId, executionPrompt: "second run prompt", executionKey: "exec-2" });
      // Re-running the earlier execution has to use the prompt that execution froze; handing it the
      // newest one runs the goal under instructions it was never scheduled with.
      const replay = await store.ensure({ goalInputId: "routine", workbenchId: wb.workbenchId, executionPrompt: "first run prompt", executionKey: "exec-1" });
      expect(replay.executionPrompt).toBe("first run prompt");
    } finally { await fixture.close(); }
  });

  it("follows a goal to its new workbench instead of failing every later turn", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const first = await fixture.workbenchRegistry.create({ name: "first", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const second = await fixture.workbenchRegistry.create({ name: "second", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const now = fixture.clock.now().toISOString();
      await inbox.create({ inputId: "goal", idempotencyKey: "goal", body: "Track the incident.", status: "PENDING", workbenchId: first.workbenchId, createdAt: now, updatedAt: now });
      const requirements = new SqliteGoalRequirementsRepository(fixture.database);
      await requirements.ensure({ goalInputId: "goal", workbenchId: first.workbenchId });
      // Moving a goal to another workbench is a supported recovery — the clarify flow does exactly
      // this when the original workbench was archived — so its contract has to move with it.
      fixture.database.transaction((db) => db.prepare("UPDATE joi_inbox_messages SET workbench_id = ? WHERE input_id = 'goal'").run(second.workbenchId));
      const moved = await requirements.ensure({ goalInputId: "goal", workbenchId: second.workbenchId });
      expect(moved.workbenchId).toBe(second.workbenchId);
      expect((await requirements.load("goal", second.workbenchId))?.requirements).toEqual([]);
    } finally { await fixture.close(); }
  });

  it("keeps a legacy goal's completed outcome visible when its contract initializes", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const wb = await fixture.workbenchRegistry.create({ name: "test", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const now = fixture.clock.now().toISOString();
      await inbox.create({ inputId: "legacy", idempotencyKey: "legacy", body: "Old goal", status: "CONSUMED", workbenchId: wb.workbenchId, createdAt: now, updatedAt: now });
      // A goal that finished before requirements existed has no trusted-source row: the upgrade
      // back-fills one at its next turn. Drop the row accepting the input just created.
      fixture.database.transaction((db) => db.prepare("DELETE FROM joi_goal_requirement_sources WHERE goal_input_id = 'legacy'").run());
      // It carries an outcome from that earlier era, stamped with no requirements revision.
      fixture.database.transaction((db) => db.prepare(`INSERT INTO joi_goal_outcomes
        (input_id, result_revision, disposition, completion_summary, completed_at, updated_at, requirements_revision)
        VALUES ('legacy', 1, 'COMPLETED', 'Old answer', ?, ?, NULL)`).run(now, now));
      const visible = () => fixture.database.transaction((db) => db.prepare(
        "SELECT COUNT(*) AS n FROM joi_current_goal_outcomes WHERE input_id = 'legacy'").get()) as { n?: unknown } | undefined;
      expect(visible()?.n).toBe(1);
      // The goal's first turn after the upgrade initializes its contract. Initializing is bookkeeping,
      // not a requirement change, so the completed answer must stay visible rather than disappear.
      const requirements = new SqliteGoalRequirementsRepository(fixture.database);
      await requirements.ensure({ goalInputId: "legacy", workbenchId: wb.workbenchId });
      expect(visible()?.n).toBe(1);
    } finally { await fixture.close(); }
  });

  it("completes a settled goal turn that called no tool instead of failing its requirements check", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const wb = await fixture.workbenchRegistry.create({ name: "test", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const now = fixture.clock.now().toISOString();
      const body = "Summarize the incident.";
      await inbox.create({ inputId: "goal", idempotencyKey: "goal", body, status: "PENDING", workbenchId: wb.workbenchId, createdAt: now, updatedAt: now });
      const requirements = new SqliteGoalRequirementsRepository(fixture.database);
      // Settle the contract the way a model turn does, so the turn below opens on requirements that
      // already reflect every user input — nothing is pending against it.
      const contract = await requirements.ensure({ goalInputId: "goal", workbenchId: wb.workbenchId });
      await requirements.readSource({ goalInputId: "goal", workbenchId: wb.workbenchId, sourceRevision: 1, offset: 0 });
      const ready = await requirements.update({ goalInputId: "goal", workbenchId: wb.workbenchId, expectedRevision: contract.revision, processedSourceRevision: 1,
        upserts: [{ id: "objective", kind: "OBJECTIVE", scope: "GLOBAL", mandatory: true, text: body, source: { sourceRevision: 1, start: 0, end: body.length } }], retirements: [] });
      expect(ready.status).toBe("READY");
      const faux = fauxProvider({ provider: "tool-less-turn" });
      // The model answers in prose without calling a single tool — a supported ending that has no
      // versioned tool through which to checkpoint a requirements revision.
      faux.setResponses([fauxAssistantMessage([fauxText("A retry loop caused it.")])]);
      const models = createModels(); models.setProvider(faux.provider);
      const runtime = new PiReasoningRuntime({ model: { ...faux.getModel(), contextWindow: 200000 }, models, thinkingLevel: "off",
        sessionStore: { load: () => Promise.resolve(null), save: () => Promise.resolve() },
        tools: turn => withGoalRequirementsTools([], { requirements, goalInputId: "goal", workbenchId: wb.workbenchId, turnId: turn.turnId,
          work: { listForGoal: () => Promise.resolve([]), readBrief: () => Promise.resolve(null), refreshBrief: () => Promise.resolve() } }),
      });
      const coordinator = new JoiCoordinator({ requirements, clock: fixture.clock, ids: fixture.ids, runtime, workbenches: fixture.workbenches,
        store: { loadInput: id => inbox.loadInput(id),
          createTurn: input => inbox.createTurn({ inputId: input.inputId, turnId: input.turnId, sessionId: input.sessionId, workbenchId: input.workbenchId, createdAt: input.createdAt,
            ...(input.requirementsRevision === undefined ? {} : { requirementsRevision: input.requirementsRevision }) }),
          completeInput: (id, turnId, completion) => inbox.completeInput(id, turnId, completion),
          requireClarification: (id, reason, prompt) => inbox.requireClarification(id, reason, prompt),
          failTurn: (id, turnId) => inbox.failTurn(id, turnId),
        },
        router: { decide: () => Promise.reject(new Error("bound goal")) },
        sources: { selectInitial: turnId => Promise.resolve({ turnId, modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake" }) },
      });
      await coordinator.handle("goal");
      const turn = fixture.database.transaction((db) => db.prepare("SELECT status FROM joi_turns WHERE input_id = ?").get("goal")) as { status?: unknown } | undefined;
      expect(turn?.status).toBe("COMPLETED");
    } finally { await fixture.close(); }
  });
});
