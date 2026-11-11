import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture.js";
import { SqliteGoalEvidenceRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-evidence-repository.js";
import { Type } from "typebox";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import { SqlitePiReasoningSessionStore } from "../../src/main/infrastructure/persistence/sqlite-pi-reasoning-session-store.js";

const handoff = { version: 1 as const, conclusion: "SEMANTIC_CONCLUSION", requirementIds: [], evidenceResultIds: [], artifactRefs: [],
  unresolved: ["MIDDLE_GAP"], conflicts: ["CONFLICT_REQUIRES_REVIEW"] };
const state = { version: 1 as const,
  claims: [{ statement: "The first finding is supported", requirementIds: [], resultIds: ["result-1"] },
    { statement: "A failed run is not accepted evidence", requirementIds: [], resultIds: ["result-2"] }],
  unresolved: [{ description: "MIDDLE_GAP", requirementIds: [], resultIds: ["result-2"] }],
  conflicts: [{ description: "CONFLICT_REQUIRES_REVIEW", resultIds: ["result-1", "result-2"] }] };

describe("semantic incremental synthesis state", () => {
  it("commits private state from one real Pi completion through the coordinator without publishing it", async () => {
    const fixture = await createGoalEvidenceFixture([{ handoff }, { handoff }]);
    const faux = fauxProvider({ provider: "synthesis-state-flow" });
    const models = createModels(); models.setProvider(faux.provider);
    let modelCalls = 0;
    const observed: unknown[] = [];
    faux.setResponses([() => {
      modelCalls++;
      return fauxAssistantMessage([fauxText("The deliverable preserves the unresolved conflict."),
        fauxToolCall("turn_complete", { outcome: "RESULT_CONTINUE" })], { stopReason: "toolUse" });
    }]);
    const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, thinkingLevel: "off",
      sessionStore: new SqlitePiReasoningSessionStore(fixture.database),
      tools: () => [{ name: "turn_complete", label: "Complete", description: "Complete", parameters: Type.Object({ outcome: Type.String() }),
        execute: () => Promise.resolve({ content: [{ type: "text" as const, text: JSON.stringify({ outcome: "RESULT_CONTINUE", status: "COMMITTED" }) }],
          details: { synthesisState: state }, terminate: true }) }] });
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
          requireClarification: (id, reason) => fixture.inbox.requireClarification(id, reason),
        } });
      await coordinator.handle(fixture.inputId);
      expect(modelCalls).toBe(1);
      const saved = fixture.database.transaction(db => db.prepare("SELECT synthesis_state_json,completion_summary FROM joi_goal_outcomes WHERE input_id='goal'").get());
      expect(String(saved?.synthesis_state_json)).toContain("CONFLICT_REQUIRES_REVIEW");
      expect(String(saved?.synthesis_state_json)).toContain("MIDDLE_GAP");
      expect(saved?.completion_summary).toBe("The deliverable preserves the unresolved conflict.");
      expect(JSON.stringify(observed)).not.toMatch(/MIDDLE_GAP|CONFLICT_REQUIRES_REVIEW|SEMANTIC_CONCLUSION/u);
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
      expect(JSON.stringify(loaded?.synthesisContext)).toContain("SEMANTIC_CONCLUSION");
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
