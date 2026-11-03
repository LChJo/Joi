/* Isolated runtime doubles satisfy asynchronous application ports. */
/* eslint-disable @typescript-eslint/require-await */
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import type { GoalRequirementsRepository } from "../../src/main/application/ports/goal-requirements.js";
import type { JoiReasoningSessionSnapshot, PrimaryReasoningEvent, PrimaryReasoningRuntime } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { DomainError } from "../../src/main/domain/errors.js";
import { createWorkbench } from "../../src/main/domain/workbench/workbench.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { createJoiReasoningTools } from "../../src/main/infrastructure/pi/joi-reasoning-tools.js";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import { createRuntimeFixture, TestClock, TestIds } from "../support/runtime-fixture.js";

const NOW = "2026-10-29T00:00:00.000Z";
const workbench = createWorkbench({ workbenchId: "proof-wb", createdAt: NOW, memoryNamespaceId: "proof-memory", name: "Synthetic",
  personaRevisionId: "proof-persona", personaSummary: "Synthetic", scopeSummary: "Synthetic", project: { label: "Synthetic" }, taskContext: { activeWorkIds: [], summary: "" } });
type Scenario = "rejected" | "checkpoint_failed" | "sdk_error" | "commit_failed";

async function scenario(kind: Scenario, historicalUnsafe = false) {
  const fixture = await createRuntimeFixture();
  const clock = new TestClock(NOW);
  const inputId = "proof-goal";
  try {
    fixture.database.transaction(db => {
      db.prepare(`INSERT INTO workbenches
        (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at)
        VALUES ('proof-wb','Synthetic','proof-persona','Synthetic','Synthetic','Synthetic','proof-memory','ACTIVE',?,?)`).run(NOW,NOW);
      db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
        VALUES (?,?,'Synthetic fixture','PENDING','proof-wb',?,?)`).run(inputId,inputId,NOW,NOW);
      if (historicalUnsafe) db.prepare(`INSERT INTO joi_turns (turn_id,input_id,workbench_id,session_id,status,side_effect_started,created_at,updated_at)
        VALUES ('unknown-history',?,'proof-wb','old-session','FAILED',1,?,?)`).run(inputId,NOW,NOW);
    });
    const repository = new SqliteJoiInboxRepository(fixture.database, clock);
    const snapshots = new Map<string, JoiReasoningSessionSnapshot>();
    let rollbacks = 0, checkpoints = 0;
    const finished: PrimaryReasoningEvent[] = [];
    const unused = async (): Promise<never> => { throw new Error("Unused synthetic port"); };
    const faux = fauxProvider({ provider: `proof-${kind}-${String(historicalUnsafe)}` });
    const args = { requirementsRevision: 1, work: [{ key: "a", partnerId: "synthetic-partner", title: "Synthetic", accessMode: "READ",
      executionNeeds: [], instructions: "Synthetic isolated task", acceptanceChecks: [{ kind: "BODY_PRESENT" }] }] };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("work_dispatch", kind === "sdk_error" ? {} : args)], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Synthetic completion")]),
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    const actual = new PiReasoningRuntime({ model: faux.getModel(), models, thinkingLevel: "off",
      sessionStore: { load: async id => snapshots.get(id) ?? null, save: async snapshot => { snapshots.set(snapshot.sessionId, structuredClone(snapshot)); } },
      tools: turn => createJoiReasoningTools({ workbenchId: "proof-wb", inputId, turnId: turn.turnId,
        workbenchChanges: {} as never, workbenchWorkspaces: {} as never, directoryPicker: async () => null, workbenches: {} as never,
        clarifications: {} as never, instances: {} as never, memory: {} as never, models: {} as never, partners: {} as never,
        results: {} as never, skills: {} as never,
        ...(kind === "checkpoint_failed" ? { requirements: {
          assertReady: async () => null,
          checkpointTurn: async () => { if (++checkpoints === 2) throw Object.assign(new Error("Synthetic I/O failure"), { code: "SQLITE_IOERR" }); },
        } as unknown as GoalRequirementsRepository } : {}),
        work: { cancel: unused, reassign: unused, resume: unused, supplement: unused, listForGoal: async () => [], plan: async input => {
          if (kind === "rejected") throw new DomainError("tool_execution_error", "Synthetic precommit rejection");
          input.onCommitStart?.();
          if (kind === "commit_failed") throw new DomainError("tool_execution_error", "Synthetic unknown commit failure");
          fixture.database.transaction(db => db.prepare(`INSERT INTO work_items
            (work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
            VALUES ('proof-work','proof-wb',?,'Synthetic','{}','READ','READY',?,?)`).run(inputId,NOW,NOW));
          return { dispatchPlanId: "proof-plan", denied: [], queued: [], waves: [["proof-work"]] };
        } },
      }),
    });
    const runtime: PrimaryReasoningRuntime = { abort: actual.abort.bind(actual), followUp: actual.followUp.bind(actual),
      isRunning: actual.isRunning.bind(actual), restore: actual.restore.bind(actual), steer: actual.steer.bind(actual), waitForIdle: actual.waitForIdle.bind(actual),
      rollbackTurn: async (sessionId, turnId) => { rollbacks++; return actual.rollbackTurn(sessionId, turnId); },
      startTurn: async turn => actual.startTurn({ ...turn, onEvent: event => { if (event.type === "tool_finished") finished.push(event); turn.onEvent?.(event); } }),
    };
    const coordinator = new JoiCoordinator({ workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] }, clock, ids: new TestIds(),
      router: { decide: async () => ({ action: "select", workbenchId: "proof-wb" }) }, runtime,
      sources: { selectInitial: async turnId => ({ modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake", turnId }) },
      store: { loadInput: repository.loadInput.bind(repository),
        createTurn: input => repository.createTurn({ inputId: input.inputId, turnId: input.turnId, sessionId: input.sessionId,
          workbenchId: input.workbenchId, createdAt: input.createdAt,
          ...(input.requirementsRevision === undefined ? {} : { requirementsRevision: input.requirementsRevision }) }),
        recordTurnProgress: repository.recordTurnProgress.bind(repository), failTurn: repository.failTurn.bind(repository),
        completeInput: repository.completeInput.bind(repository), requireClarification: repository.requireClarification.bind(repository) },
    });
    await expect(coordinator.handle(inputId)).rejects.toMatchObject({ code: "tool_execution_error" });
    return fixture.database.transaction(db => ({ rollbacks, finished, checkpoints,
      input: db.prepare("SELECT status FROM joi_inbox_messages WHERE input_id=?").get(inputId),
      turn: db.prepare("SELECT * FROM joi_turns WHERE input_id=? AND turn_id <> 'unknown-history'").get(inputId),
      workCount: Number(db.prepare("SELECT COUNT(*) AS count FROM work_items WHERE input_id=?").get(inputId)?.count),
    }));
  } finally { await fixture.close(); }
}

describe("dispatch failure replay proof with real SDK and SQLite", () => {
  it("requeues a proven precommit rejection while retaining the coarse crash marker", async () => {
    const value = await scenario("rejected");
    expect(value.input).toMatchObject({ status: "PENDING" });
    expect(value.turn).toMatchObject({ status: "FAILED", side_effect_started: 1, failure_replay_safe: 1 });
    expect(value.workCount).toBe(0);
    expect(value.rollbacks).toBe(1);
    expect(value.finished[0]).toMatchObject({ replaySafeRejection: true });
  });

  it("preserves a committed dispatch when its post-execution checkpoint fails", async () => {
    const value = await scenario("checkpoint_failed");
    expect(value.workCount).toBe(1);
    expect(value.checkpoints).toBe(2);
    expect(value.rollbacks).toBe(0);
    expect(value.input).toMatchObject({ status: "CONSUMED" });
    expect(value.finished[0]).toMatchObject({ isError: true });
    expect(value.finished[0]).not.toHaveProperty("replaySafeRejection");
  });

  it.each(["sdk_error", "commit_failed"] as const)("retains an unproven %s without rolling back", async kind => {
    const value = await scenario(kind);
    expect(value.workCount).toBe(0);
    expect(value.rollbacks).toBe(0);
    expect(value.input).toMatchObject({ status: "CONSUMED" });
    expect(value.turn).not.toMatchObject({ failure_replay_safe: 1 });
  });

  it("does not let a settled safe rejection erase older unknown effects", async () => {
    const value = await scenario("rejected", true);
    expect(value.input).toMatchObject({ status: "CONSUMED" });
    expect(value.turn).toMatchObject({ failure_replay_safe: 1 });
  });
});
