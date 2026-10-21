import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { WorkbenchContextAssembler } from "../../src/main/application/joi/workbench-context-assembler.js";
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import type { JoiReasoningSessionSnapshot } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { SqlitePartnerDispatchDelivery } from "../../src/main/infrastructure/a2a/partner-dispatch-delivery-adapter.js";
import { SqliteDispatchPolicyGate } from "../../src/main/infrastructure/persistence/sqlite-dispatch-policy-gate.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqliteWorkbenchContextRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-context-repository.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";
import { SqliteWorkResultRepository } from "../../src/main/infrastructure/persistence/sqlite-work-result-repository.js";
import { SqliteWorkspaceLeaseManager } from "../../src/main/infrastructure/persistence/sqlite-workspace-lease-manager.js";
import { WorkRunDirectoryProvisioner } from "../../src/main/infrastructure/persistence/work-run-directory-provisioner.js";
import { createJoiReasoningTools } from "../../src/main/infrastructure/pi/joi-reasoning-tools.js";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import { WorkspaceWorkVerifier } from "../../src/main/infrastructure/workspace/workspace-work-verifier.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("first-use installation and managed dispatch", () => {
  it.each(["PROVISIONING", "FAILED", "UNWRITABLE"] as const)("runs the installed team through a newly created %s workbench", async state => {
    const fixture = await createRuntimeFixture();
    try {
      expect(await fixture.partners.list()).toEqual([]);
      const installation = await fixture.scenarioPacks.install("programming", {});
      const installed = await fixture.partners.list();
      expect(installed).toHaveLength(installation.installedRoleCount);
      expect((await fixture.scenarioPacks.install("programming", {})).outcomes.every(role => role.outcome === "REUSED")).toBe(true);
      const partner = installed[0];
      if (partner === undefined) throw new Error("missing installed partner");

      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const original = await inbox.accept({ text: "Read references and return a textual report.", idempotencyKey: "first-use" });
      const proposal = { name: "Engineering workshop", projectLabel: "Fixture", scopeSummary: "Engineering reference reports" };
      await repository.requireClarification(original.inputId, "workbench_selection_invalid", undefined, undefined, proposal);
      const question = (await inbox.list())[0];
      if (question?.questionId === undefined || question.questionVersion === undefined) throw new Error("missing choice question");
      const draft = { ...proposal, personaSummary: "Fixture", bindInputId: original.inputId, questionId: question.questionId,
        questionVersion: question.questionVersion, idempotencyKey: "first-use-choice" };
      const workbench = await fixture.workbenchRegistry.create(draft);
      expect(await fixture.workbenchRegistry.create(draft)).toEqual(workbench);
      expect(await fixture.workbenches.listSummaries()).toHaveLength(1);
      if (state === "FAILED") fixture.database.transaction(db => db.prepare(
        "UPDATE workbench_workspace_bindings SET status = 'FAILED' WHERE workbench_id = ?",
      ).run(workbench.workbenchId));
      const pending = (await repository.list()).find(input => input.status === "PENDING");
      if (pending === undefined) throw new Error("missing recovery input");
      const work = new WorkOrchestrationService({ clock: fixture.clock, ids: fixture.ids, partners: fixture.partners,
        repository: new SqliteWorkPlanRepository(fixture.database), policy: new SqliteDispatchPolicyGate({ clock: fixture.clock, database: fixture.database }) });
      const faux = fauxProvider({ provider: `first-use-${state.toLowerCase()}` });
      const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
      faux.setResponses([
        call("goal_resume", {}), call("workbench_bind_workspace", {}),
        call("work_dispatch", { work: [{ key: "report", partnerId: partner.partnerId, title: "Reference report",
          instructions: "Return a short textual reference report.", accessMode: "READ", executionNeeds: [], acceptanceChecks: [{ kind: "BODY_PRESENT" }] }] }),
        fauxAssistantMessage([fauxText("The report has been dispatched.")]),
      ]);
      const models = createModels(); models.setProvider(faux.provider);
      const sessions = new Map<string, JoiReasoningSessionSnapshot>();
      const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, thinkingLevel: "off",
        sessionStore: { load: id => Promise.resolve(sessions.get(id) ?? null), save: snapshot => { sessions.set(snapshot.sessionId, structuredClone(snapshot)); return Promise.resolve(); } },
        tools: turn => createJoiReasoningTools({
          workbenchId: workbench.workbenchId, inputId: turn.inputId, turnId: turn.turnId,
          goalInputId: original.inputId, work, partners: fixture.partners, instances: fixture.instances, memory: fixture.memory,
          workbenches: fixture.workbenches, workbenchWorkspaces: fixture.workbenchWorkspaces,
          directoryPicker: () => Promise.reject(new Error("no manual directory selection")), skills: fixture.skills,
          models: { list: () => Promise.resolve([]) }, results: { read: () => Promise.reject(new Error("unused")) },
          workbenchChanges: { suggestArchive: () => Promise.reject(new Error("unused")), suggestMerge: () => Promise.reject(new Error("unused")) },
          clarifications: repository,
        }),
      });
      const coordinator = new JoiCoordinator({ clock: fixture.clock, ids: fixture.ids, runtime,
        workbenches: fixture.workbenches, workspaces: fixture.workbenchWorkspaces,
        store: {
          loadInput: id => repository.loadInput(id),
          createTurn: turn => repository.createTurn({ inputId: turn.inputId, turnId: turn.turnId, workbenchId: turn.workbenchId, sessionId: turn.sessionId, createdAt: turn.createdAt }),
          recordTurnProgress: (id, progress) => repository.recordTurnProgress(id, progress),
          completeInput: (id, turnId, completion) => repository.completeInput(id, turnId, completion),
          failTurn: (...args) => repository.failTurn(...args),
          requireClarification: (...args) => repository.requireClarification(...args),
        },
        router: { decide: () => Promise.reject(new Error("already bound")) },
        sources: { selectInitial: turnId => Promise.resolve({ turnId, sourceId: "fake", sourceRevisionId: "fake", modelRevisionId: "fake", modelId: "fake" }) },
      });
      await coordinator.handle(pending.inputId);
      expect((await repository.list()).some(input => input.status === "CLARIFICATION_REQUIRED")).toBe(false);
      const claim = fixture.database.transaction(db => db.prepare(
        "SELECT outbox_id, payload_json FROM outbox WHERE kind = 'partner.dispatch'",
      ).get());
      if (typeof claim?.outbox_id !== "string" || typeof claim.payload_json !== "string") throw new Error("missing dispatch");
      const payload = JSON.parse(claim.payload_json) as { dispatchAttemptId: string; actionId: string; workId: string };
      const contexts = new SqliteWorkbenchContextRepository(fixture.database);
      const baseDirectory = path.join(fixture.root, "runs");
      if (state === "UNWRITABLE") await writeFile(baseDirectory, "blocked", "utf8");
      let executions = 0;
      const delivery = new SqlitePartnerDispatchDelivery({ clock: fixture.clock, database: fixture.database, contexts,
        contextAssembler: new WorkbenchContextAssembler({ workbenches: fixture.workbenches, clock: fixture.clock, ids: fixture.ids, projections: contexts, snapshots: contexts }),
        runDirectories: new WorkRunDirectoryProvisioner({ clock: fixture.clock, database: fixture.database, baseDirectory }),
        partners: new SqlitePartnerRegistryRepository(fixture.database), leases: new SqliteWorkspaceLeaseManager({ clock: fixture.clock, database: fixture.database }),
        results: new SqliteWorkResultRepository(fixture.database),
        verifier: new WorkspaceWorkVerifier({ contexts }),
        gateway: { recover: () => Promise.reject(new Error("unused")), startWithResult: () => Promise.reject(new Error("unused")) },
        instances: { dispatch: async ({ request }) => {
          executions++;
          const context = await contexts.loadForExecution(request.contextSnapshotId);
          expect(context?.workspacePath).toBeDefined();
          expect((await stat(context?.workspacePath ?? "")).isDirectory()).toBe(true);
          return { actionId: request.actionId, workId: request.workId, externalRunId: "fixture", status: "COMPLETED", artifacts: [], body: "Fixture reference report." };
        } },
      });
      const record = { outboxId: claim.outbox_id, kind: "partner.dispatch", payload, status: "PENDING" as const,
        attemptCount: 0, createdAt: fixture.clock.now().toISOString(), availableAt: fixture.clock.now().toISOString() };
      if (state === "UNWRITABLE") {
        await expect(delivery.handle(record)).rejects.toMatchObject({ code: "work_run_directory_unavailable" });
        expect(executions).toBe(0);
      } else {
        await delivery.handle(record);
        await delivery.handle(record);
        expect(executions).toBe(1);
        expect(fixture.database.transaction(db => db.prepare("SELECT status FROM work_items WHERE work_id = ?").get(payload.workId)))
          .toMatchObject({ status: "COMPLETED" });
      }
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'partner.dispatch'").get())).toEqual({ n: 1 });
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM joi_turns WHERE input_id = ?").get(original.inputId))).toEqual({ n: 0 });
    } finally { await fixture.close(); }
  });
});
