import path from "node:path";
import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture.js";
import { SqliteGoalEvidenceRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-evidence-repository.js";
import { Type } from "typebox";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import { JoiHarnessComponent } from "../../src/main/application/actors/components/joi-harness-component.js";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import { PiNativeSessionStore } from "../../src/main/infrastructure/pi/pi-native-session-store.js";
import { SqlitePiReasoningSessionStore } from "../../src/main/infrastructure/persistence/sqlite-pi-reasoning-session-store.js";
import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository.js";

const handoff = { version: 1 as const, conclusion: "SEMANTIC_CONCLUSION", requirementIds: [], evidenceResultIds: [], artifactRefs: [],
  unresolved: ["MIDDLE_GAP"], conflicts: ["CONFLICT_REQUIRES_REVIEW"] };
const state = { version: 1 as const,
  claims: [{ statement: "The first finding is supported", requirementIds: [], resultIds: ["result-1"] },
    { statement: "A failed run is not accepted evidence", requirementIds: [], resultIds: ["result-2"] }],
  unresolved: [{ description: "MIDDLE_GAP", requirementIds: [], resultIds: ["result-2"] }],
  conflicts: [{ description: "CONFLICT_REQUIRES_REVIEW", resultIds: ["result-1", "result-2"] }] };

describe("semantic incremental synthesis state", () => {
  it.each([
    ["goal_synthesis_coverage_incomplete", false],
    ["goal_synthesis_reference_invalid", false],
    ["goal_synthesis_coverage_incomplete", true],
    ["goal_synthesis_reference_invalid", true],
  ] as const)("recovers from %s with restricted tools (fallback=%s)", async (reasonCode, useFallback) => {
    const fixture = await createGoalEvidenceFixture([{}]);
    const faux = fauxProvider({ provider: "synthesis-disposition-flow" });
    const models = createModels();
    models.setProvider(faux.provider);
    const normalCompletion = () => fauxAssistantMessage([fauxToolCall("turn_complete", { outcome: "RESULT_SYNTHESIZED" })], { stopReason: "toolUse" });
    const outcome = reasonCode === "goal_synthesis_coverage_incomplete" ? "RESULT_CONTINUE" : "RESULT_SYNTHESIZED";
    const summary = outcome === "RESULT_CONTINUE"
      ? "The existing report is useful. Verify the missing appendix next." : "The verified report is ready.";
    const finish: FauxResponseFactory = context => {
      expect(getCurrentTools(context.messages).map(tool => tool.name)).toEqual(["turn_complete"]);
      return fauxAssistantMessage([fauxText(summary), fauxToolCall("turn_complete", { outcome })], { stopReason: "toolUse" });
    };
    faux.setResponses([
      context => {
        expect(getCurrentTools(context.messages).map(tool => tool.name)).toContain("work_supplement");
        return normalCompletion();
      },
      normalCompletion,
      useFallback ? () => fauxAssistantMessage([fauxText("Draft without a conclusion.")]) : finish,
    ]);
    let rejected = 0;
    const sessionStore = new SqlitePiReasoningSessionStore(fixture.database);
    const tools: ConstructorParameters<typeof PiReasoningRuntime>[0]["tools"] = [
        { name: "turn_complete", label: "Complete", description: "Complete", parameters: Type.Object({ outcome: Type.String() }),
          execute: (_id, args) => {
            const { outcome: decision } = args as { outcome: string };
            if (rejected === 2) return Promise.resolve({ content: [{ type: "text" as const, text: JSON.stringify({ outcome: decision }) }],
              details: {}, terminate: true });
            const exhausted = ++rejected === 2;
            return Promise.resolve({ content: [{ type: "text" as const, text: JSON.stringify({ reasonCode, status: exhausted ? "FAILED" : "RETRY_REQUIRED" }) }],
              details: { reasonCode, correctionExhausted: exhausted, synthesisCoverageExhausted: reasonCode === "goal_synthesis_coverage_incomplete" },
              isError: true, terminate: exhausted });
          } },
        { name: "work_supplement", label: "Supplement", description: "Supplement", parameters: Type.Object({}),
          execute: () => Promise.reject(new Error("The disposition pass must never dispatch work.")) },
    ];
    const runtimeOptions = { thinkingLevel: "off" as const, sessionStore, tools,
      ...(useFallback ? { nativeSessions: new PiNativeSessionStore(path.join(fixture.root, "native")) } : {}) };
    const runtime = new PiReasoningRuntime({ ...runtimeOptions, model: faux.getModel(), models });
    const backup = fauxProvider({ provider: "synthesis-disposition-fallback" });
    const backupModels = createModels();
    backupModels.setProvider(backup.provider);
    backup.setResponses(useFallback ? [finish] : []);
    const backupRuntime = new PiReasoningRuntime({ ...runtimeOptions, model: backup.getModel(), models: backupModels });
    const start = runtime.startTurn.bind(runtime);
    vi.spyOn(runtime, "startTurn").mockImplementation(turn => turn.sourceId === "backup" ? backupRuntime.startTurn(turn) : start(turn));
    try {
      fixture.database.transaction(db => db.prepare("UPDATE joi_turns SET status='COMPLETED' WHERE turn_id='synthesis-turn'").run());
      const harness = new SqliteJoiHarnessRepository(fixture.database);
      const now = fixture.clock.now().toISOString();
      await harness.createMap({ goalInputId: "goal", workbenchId: fixture.workbenchId, now });
      await harness.synchronizeWorkPaths({ now });
      const coordinator = new JoiCoordinator({ clock: fixture.clock, ids: fixture.ids, runtime, workbenches: fixture.workbenches,
        router: { decide: () => Promise.reject(new Error("bound goal")) },
        sources: {
          selectInitial: turnId => Promise.resolve({ turnId, modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake" }),
          selectFallback: ({ currentSourceId, turnId }) => Promise.resolve(useFallback && currentSourceId === "fake"
            ? { turnId, modelId: "backup", modelRevisionId: "backup", sourceId: "backup", sourceRevisionId: "backup" } : null),
        },
        store: { loadInput: id => fixture.inbox.loadInput(id),
          createTurn: ({ inputId, turnId, sessionId, workbenchId, createdAt }) =>
            fixture.inbox.createTurn({ inputId, turnId, sessionId, workbenchId, createdAt }),
          completeInput: (id, turnId, completion) => fixture.inbox.completeInput(id, turnId, completion),
          requireClarification: (id, reason) => fixture.inbox.requireClarification(id, reason) } });
      await coordinator.handle(fixture.inputId);
      expect(rejected).toBe(2);
      expect(faux.getPendingResponseCount()).toBe(0);
      expect(backup.getPendingResponseCount()).toBe(0);
      const saved = fixture.database.transaction(db => db.prepare("SELECT disposition,completion_summary FROM joi_goal_outcomes WHERE input_id='goal'").get());
      expect(saved).toMatchObject({ disposition: outcome === "RESULT_CONTINUE" ? "CONTINUE" : "COMPLETED", completion_summary: summary });
      const traversal = new JoiHarnessComponent({ reviewEnabled: true, scan: harness, writer: harness, scanEveryMillis: 0 });
      await traversal.update({ clock: fixture.clock, now: fixture.clock.now(), tickId: 1 });
      const reviews = () => fixture.database.transaction(db => db.prepare(
        "SELECT input_id FROM joi_inbox_messages WHERE goal_input_id='goal' AND input_id LIKE 'joi_harness_review:goal:%'",
      ).all());
      expect(reviews()).toHaveLength(1);
      const reviewId = reviews()[0]?.input_id;
      assert(typeof reviewId === "string");
      if (outcome === "RESULT_SYNTHESIZED") {
        await fixture.inbox.createTurn({ inputId: reviewId, turnId: "review", workbenchId: fixture.workbenchId, sessionId: "review", createdAt: now });
        await fixture.inbox.completeInput(reviewId, "review");
        expect(fixture.database.transaction(db => db.prepare("SELECT status FROM joi_harness_maps WHERE goal_input_id='goal'").get())).toMatchObject({ status: "CLEARED" });
        expect((await fixture.joiHomeFeed.load()).goals[0]).toMatchObject({ status: "COMPLETED", completionSummary: summary });
      }
      await traversal.update({ clock: fixture.clock, now: fixture.clock.now(), tickId: 2 });
      expect(reviews()).toHaveLength(1);
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM dispatch_attempts").get())).toMatchObject({ n: 1 });
    } finally { await fixture.close(); }
  });

  it.each([false, true])("commits validated private state through real Pi without publishing it (correction=%s)", async correction => {
    const fixture = await createGoalEvidenceFixture([{ handoff }, { handoff }]);
    const faux = fauxProvider({ provider: "synthesis-state-flow" });
    const models = createModels(); models.setProvider(faux.provider);
    let modelCalls = 0;
    const observed: unknown[] = [];
    const response = () => {
      modelCalls++;
      return fauxAssistantMessage([fauxText("The deliverable preserves the unresolved conflict."),
        fauxToolCall("turn_complete", { outcome: "RESULT_CONTINUE" })], { stopReason: "toolUse" });
    };
    faux.setResponses([response, response]);
    const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, thinkingLevel: "off",
      sessionStore: new SqlitePiReasoningSessionStore(fixture.database),
      tools: () => [{ name: "turn_complete", label: "Complete", description: "Complete", parameters: Type.Object({ outcome: Type.String() }),
        execute: () => Promise.resolve({ content: [{ type: "text" as const, text: JSON.stringify({ outcome: "RESULT_CONTINUE", status: "COMMITTED" }) }],
          details: { synthesisState: correction && modelCalls === 1
            ? { ...state, claims: [{ statement: "PRIVATE_REJECTED_CLAIM", requirementIds: [], resultIds: ["invented-result"] }] } : state }, terminate: true }) }] });
    try {
      fixture.database.transaction(db => db.prepare("UPDATE joi_turns SET status='COMPLETED' WHERE turn_id='synthesis-turn'").run());
      const coordinator = new JoiCoordinator({ clock: fixture.clock, ids: fixture.ids, runtime, workbenches: fixture.workbenches,
        diagnostics: { emit: (event, fields) => { observed.push({ event, fields }); } },
        events: { emit: (_event, _id, payload) => { observed.push(payload); return Promise.resolve(); } },
        router: { decide: () => Promise.reject(new Error("bound goal")) },
        sources: { selectInitial: turnId => Promise.resolve({ turnId, modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake" }) },
        store: {
          loadInput: id => fixture.inbox.loadInput(id),
          createTurn: input => fixture.inbox.createTurn({ inputId: input.inputId, turnId: input.turnId, sessionId: input.sessionId,
            workbenchId: input.workbenchId, createdAt: input.createdAt }),
          completeInput: (id, turnId, completion) => fixture.inbox.completeInput(id, turnId, completion),
          validateSynthesisState: (id, draft) => fixture.inbox.validateSynthesisState(id, draft),
          requireClarification: (id, reason) => fixture.inbox.requireClarification(id, reason),
        } });
      await coordinator.handle(fixture.inputId);
      expect(modelCalls).toBe(correction ? 2 : 1);
      const saved = fixture.database.transaction(db => db.prepare("SELECT synthesis_state_json,completion_summary FROM joi_goal_outcomes WHERE input_id='goal'").get());
      expect(String(saved?.synthesis_state_json)).toContain("CONFLICT_REQUIRES_REVIEW");
      expect(String(saved?.synthesis_state_json)).toContain("MIDDLE_GAP");
      expect(saved?.completion_summary).toBe("The deliverable preserves the unresolved conflict.");
      expect(JSON.stringify(observed)).not.toMatch(/MIDDLE_GAP|CONFLICT_REQUIRES_REVIEW|SEMANTIC_CONCLUSION|PRIVATE_REJECTED_CLAIM/u);
    } finally { await fixture.close(); }
  });
  it("retrieves a revised private state when an explicit review preserves the visible conclusion", async () => {
    const fixture = await createGoalEvidenceFixture([{ handoff }]);
    try {
      const base = { version: 1, source: "MODEL", resultRevision: 1, requirementsRevision: 0, claims: [], conflicts: [], unresolved: [] };
      const revised = { ...base, unresolved: [{ description: "UPDATED_PRIVATE_GAP", requirementIds: [], resultIds: ["result-1"] }] };
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction(db => {
        db.prepare(`INSERT INTO joi_goal_outcome_history(goal_input_id,result_revision,requirements_revision,disposition,completion_summary,completed_at,synthesis_state_json)
          VALUES ('goal',1,0,'CONTINUE','Same visible conclusion',?,?)`).run(now, JSON.stringify(base));
        db.prepare(`INSERT INTO joi_goal_outcomes(input_id,result_revision,requirements_revision,disposition,completion_summary,completed_at,updated_at,synthesis_state_json)
          VALUES ('goal',1,0,'CONTINUE','Same visible conclusion',?,?,?)`).run(now, now, JSON.stringify(revised));
      });
      expect((await fixture.inbox.loadInput(fixture.inputId))?.synthesisContext?.previous?.stateRef).toBe("r1:q0:current");
      const repository = new SqliteGoalEvidenceRepository(fixture.database);
      const page = await repository.readState({ goalInputId: "goal", workbenchId: fixture.workbenchId, outcomeId: "r1:q0:current" });
      expect(page.content).toContain("UPDATED_PRIVATE_GAP");
      const metadata = await repository.index({ goalInputId: "goal", workbenchId: fixture.workbenchId });
      expect(metadata.content).not.toContain("UPDATED_PRIVATE_GAP");
    } finally { await fixture.close(); }
  });
  it("persists semantic handoff privately and commits evidence-linked state with authoritative verification", async () => {
    const fixture = await createGoalEvidenceFixture([{ handoff }, { handoff, status: "FAILED", verification: "FAILED" }]);
    try {
      const row = fixture.database.transaction(db => db.prepare("SELECT handoff_json,summary FROM work_results WHERE result_id='result-1'").get());
      expect(String(row?.handoff_json)).toContain("SEMANTIC_CONCLUSION");
      expect(String(row?.summary)).not.toContain("SEMANTIC_CONCLUSION");
      const loaded = await fixture.inbox.loadInput(fixture.inputId);
      expect(JSON.stringify(loaded?.synthesisContext)).not.toContain("SEMANTIC_CONCLUSION");
      const page = await new SqliteGoalEvidenceRepository(fixture.database).readHandoff({ goalInputId: "goal",workbenchId: fixture.workbenchId,resultId: "result-1" });
      expect(page.content).toContain("SEMANTIC_CONCLUSION");
      await fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", { completionSummary: "The deliverable preserves the unresolved conflict.",
        outcome: "RESULT_CONTINUE", synthesisState: state });
      const saved = fixture.database.transaction(db => db.prepare("SELECT synthesis_state_json FROM joi_goal_outcomes WHERE input_id='goal'").get());
      const parsed = JSON.parse(String(saved?.synthesis_state_json)) as { resultRevision: number; requirementsRevision: number; claims: { verification: string }[]; conflicts: unknown[]; unresolved: unknown[] };
      expect(parsed.resultRevision).toBe(2);
      expect(parsed.requirementsRevision).toBe(0);
      expect(parsed.claims.map(claim => claim.verification)).toEqual(["VERIFIED", "UNVERIFIED"]);
      expect(parsed.conflicts).toEqual(state.conflicts);
      expect(parsed.unresolved).toEqual(state.unresolved);
      const archived = fixture.database.transaction(db => db.prepare("SELECT synthesis_state_json FROM joi_goal_outcome_history WHERE goal_input_id='goal'").get());
      expect(archived?.synthesis_state_json).toBe(saved?.synthesis_state_json);
      await fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", { completionSummary: "DUPLICATE_OVERWRITE", outcome: "RESULT_CONTINUE", synthesisState: { ...state, claims: [] } });
      expect(fixture.database.transaction(db => db.prepare("SELECT completion_summary FROM joi_goal_outcomes WHERE input_id='goal'").get())?.completion_summary).not.toContain("DUPLICATE_OVERWRITE");
    } finally { await fixture.close(); }
  });

  it("rejects invented evidence before committing an outcome", async () => {
    const fixture = await createGoalEvidenceFixture([{ handoff }]);
    try {
      await expect(fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", { completionSummary: "Do not publish this", outcome: "RESULT_SYNTHESIZED",
        synthesisState: { ...state, claims: [{ statement: "Invented reference", requirementIds: [], resultIds: ["foreign-result"] }] } }))
        .rejects.toMatchObject({ code: "goal_synthesis_reference_invalid" });
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM joi_goal_outcomes").get())?.n).toBe(0);
    } finally { await fixture.close(); }
  });
});
