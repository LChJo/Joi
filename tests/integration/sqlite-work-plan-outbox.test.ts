import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import { WorkbenchContextAssembler } from "../../src/main/application/joi/workbench-context-assembler.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";
import { SqliteWorkspaceLeaseManager } from "../../src/main/infrastructure/persistence/sqlite-workspace-lease-manager.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { SqlitePartnerDispatchDelivery } from "../../src/main/infrastructure/a2a/partner-dispatch-delivery-adapter.js";
import { SqliteWorkbenchAgentScan } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-scan.js";
import { SqliteWorkbenchContextRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-context-repository.js";
import { SqliteWorkResultRepository } from "../../src/main/infrastructure/persistence/sqlite-work-result-repository.js";
import { LegacyLifeStoreAdapter } from "../../src/main/infrastructure/persistence/legacy-life-store-adapter.js";
import { createRuntimeFixture, TestClock, TestIds } from "../support/runtime-fixture.js";

describe("SQLite work plan outbox", () => {
  it("AC-WR-07 supplements a legacy READ failure once across concurrent requests and replay", async () => {
    const fixture = await createRuntimeFixture();
    let database = fixture.database;
    try {
      const wb = await fixture.workbenchRegistry.create({ name: "Recovery", personaSummary: "fixture", projectLabel: "Report", scopeSummary: "Save a report" });
      const now = fixture.clock.now().toISOString();
      database.transaction(db => {
        db.prepare("INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES ('recovery-goal','recovery-key','fixture','CONSUMED',?,?,?)").run(wb.workbenchId,now,now);
        db.prepare("INSERT INTO joi_turns (turn_id,input_id,workbench_id,session_id,status,created_at,updated_at) VALUES ('recovery-turn','recovery-goal',?,'fixture-session','RUNNING',?,?)").run(wb.workbenchId,now,now);
        db.prepare("INSERT INTO work_items (work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at) VALUES ('legacy-read',?,'recovery-goal','Report',?,'READ','FAILED',?,?)").run(wb.workbenchId,JSON.stringify({ instructions: "Save a report", acceptanceChecks: [{ kind: "FILE_EXISTS", relativePath: "report.md" }] }),now,now);
        db.prepare("INSERT INTO work_access_policies VALUES ('legacy-read','READ')").run();
      });
      const partners = new PartnerRegistryService({ clock: fixture.clock, ids: fixture.ids, repository: new SqlitePartnerRegistryRepository(database) });
      const partner = await partners.add({ capabilities: [], displayName: "Writer", kind: "local-pi", skills: [], tools: [] });
      const makeService = () => {
        const repository = new SqliteWorkPlanRepository(database);
        return new WorkOrchestrationService({ clock: fixture.clock, ids: fixture.ids, partners: new PartnerRegistryService({ clock: fixture.clock, ids: fixture.ids, repository: new SqlitePartnerRegistryRepository(database) }), recovery: repository, repository, policy: { evaluate: () => Promise.resolve({ allowed: true }) } });
      };
      const request = { sourceWorkId: "legacy-read", turnId: "recovery-turn", workbenchId: wb.workbenchId, partnerId: partner.partnerId, title: "Missing report", accessMode: "WRITE" as const, executionNeeds: ["FILE_WRITE" as const], instructions: "Create only the missing report; do not repeat external actions." };
      const results = await Promise.all([makeService().supplement(request),makeService().supplement(request)]);
      expect(results[0]).toEqual(results[1]);
      await expect(makeService().supplement({ ...request, turnId: "another-turn" })).resolves.toEqual(results[0]);
      expect(database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM work_recovery_attempts WHERE source_work_id='legacy-read'").get()?.n)).toBe(1);
      expect(database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE input_id='recovery-goal'").get()?.n)).toBe(2);
      const replacement = results[0].waves[0]?.[0];
      const brief = await new SqliteWorkPlanRepository(database).readBrief("recovery-goal",wb.workbenchId,replacement ?? "");
      expect(brief).toMatchObject({ accessMode: "WRITE", executionNeeds: ["FILE_WRITE"] });
      const originalAttempt = database.transaction(db => db.prepare("SELECT * FROM dispatch_attempts WHERE work_id=?").get(replacement ?? ""));
      database.transaction(db => {
        db.prepare("INSERT INTO joi_turns (turn_id,input_id,workbench_id,session_id,status,created_at,updated_at) VALUES ('resumed-turn','recovery-goal',?,'fixture-session','RUNNING',?,?)")
          .run(wb.workbenchId, now, now);
        db.prepare("INSERT INTO dispatch_plans(dispatch_plan_id,turn_id,candidate_json,policy_result_json,created_at) VALUES ('resumed-plan','resumed-turn',?, '[]',?)")
          .run(JSON.stringify({ reassignWorkId: replacement }), now);
        db.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id,dispatch_plan_id,work_id,partner_revision_id,registry_revision,action_id,status,created_at,updated_at)
          VALUES ('resumed-attempt','resumed-plan',?,?,1,'resumed-action','PENDING',?,?)`)
          .run(replacement ?? "", partner.partnerRevisionId, now, now);
      });
      expect(originalAttempt?.dispatch_plan_id).toBe(results[0].dispatchPlanId);
      await expect(makeService().supplement({ ...request, turnId: "resumed-turn" })).resolves.toEqual(results[0]);
      database.transaction(db => db.prepare("UPDATE work_items SET status='COMPLETED' WHERE work_id=?").run(replacement ?? ""));
      database.close();
      database = await openRuntimeDatabase({ databasePath: path.join(fixture.root,"runtime.sqlite"),migrationsDirectory: path.resolve("resources/migrations") });
      await expect(makeService().supplement(request)).resolves.toEqual(results[0]);
      await expect(makeService().supplement({ ...request, turnId: "resumed-turn" })).resolves.toEqual(results[0]);
      expect(database.transaction(db => db.prepare("SELECT access_mode FROM work_access_policies WHERE work_id='legacy-read'").get()?.access_mode)).toBe("READ");
      database.transaction(db => {
        db.prepare("UPDATE work_items SET status='FAILED' WHERE work_id=?").run(replacement ?? "");
        db.prepare("INSERT INTO joi_turns (turn_id,input_id,workbench_id,session_id,status,created_at,updated_at) VALUES ('second-recovery','recovery-goal',?,'fixture-session','RUNNING',?,?)").run(wb.workbenchId,now,now);
      });
      const second = await makeService().supplement({ ...request,turnId: "second-recovery" });
      expect(second.attemptNo).toBe(2);
      database.transaction(db => db.prepare("UPDATE work_items SET status='FAILED' WHERE work_id=?").run(second.waves[0]?.[0] ?? ""));
      await expect(makeService().supplement({ ...request,turnId: "third-recovery" })).rejects.toMatchObject({ code: "work_recovery_exhausted" });
      expect(database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM work_recovery_attempts WHERE source_work_id='legacy-read'").get()?.n)).toBe(2);
    } finally { database.close(); await rm(fixture.root,{ recursive: true,force: true }); }
  });
  it("loads the failed source Work contract for supplemental recovery and fails closed on malformed legacy briefs", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "恢复", personaSummary: "persona", projectLabel: "HTML", scopeSummary: "输出文件" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-contract', 'key-contract', '生成 HTML', 'CONSUMED', ?, ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-contract', 'goal-contract', ?, 'session-contract', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-contract', ?, 'goal-contract', '生成报告', ?, 'READ', 'FAILED', ?, ?)`).run(
          workbench.workbenchId,
          JSON.stringify({ acceptanceChecks: [
            { kind: "ARTIFACT_PRESENT", name: "report.html" },
            { kind: "FILE_EXISTS", relativePath: "report.html" },
          ] }),
          now,
          now,
        );
        connection.prepare("INSERT INTO work_access_policies (work_id, access_mode) VALUES ('work-contract', 'WRITE')").run();
      });
      const repository = new SqliteWorkPlanRepository(fixture.database);
      await expect(repository.loadForSupplement("work-contract")).resolves.toMatchObject({
        item: { accessMode: "WRITE" },
        sourceAcceptanceChecks: [
          { kind: "ARTIFACT_PRESENT", name: "report.html" },
          { kind: "FILE_EXISTS", relativePath: "report.html" },
        ],
      });

      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE work_items SET intent_json = '{}' WHERE work_id = 'work-contract'",
      ).run());
      await expect(repository.loadForSupplement("work-contract")).rejects.toMatchObject({ code: "work_recovery_contract_invalid" });
    } finally {
      await fixture.close();
    }
  });

  it("commits work, partner revision pins and side-effect outbox atomically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-work-plan-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      const ids = new TestIds();
      database.transaction((connection) => {
        connection.prepare(`INSERT INTO workbenches
          (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
          VALUES ('workbench-1', '研究', 'persona-1', '人格', '范围', '工程', 'memory-1', '', 'ACTIVE', ?, ?)`).run(clock.now().toISOString(), clock.now().toISOString());
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, created_at, updated_at) VALUES ('input-1', 'key-1', 'body', 'ROUTED', ?, ?)`).run(clock.now().toISOString(), clock.now().toISOString());
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at) VALUES ('turn-1', 'input-1', 'workbench-1', 'session-1', 'RUNNING', ?, ?)`).run(clock.now().toISOString(), clock.now().toISOString());
        connection.prepare(`UPDATE workbench_workspace_bindings SET kind = 'BOUND', status = 'READY', display_name = '工程', updated_at = ?
          WHERE workbench_id = 'workbench-1'`).run(clock.now().toISOString());
        connection.prepare(`INSERT INTO workbench_workspace_roots (workspace_ref, root_path, created_at, updated_at)
          VALUES ('workbench_workspace:workbench-1', ?, ?, ?)`).run(root, clock.now().toISOString(), clock.now().toISOString());
      });
      const partnerRepository = new SqlitePartnerRegistryRepository(database);
      const partners = new PartnerRegistryService({ clock, ids, repository: partnerRepository });
      const partner = await partners.add({ capabilities: ["write"], displayName: "Local", kind: "local-pi", skills: [], tools: ["edit"] });
      const repository = new SqliteWorkPlanRepository(database);
      const service = new WorkOrchestrationService({
        clock, ids, partners, policy: { evaluate: () => Promise.resolve({ allowed: true }) }, repository,
      });
      await service.plan({ workbenchId: "workbench-1", dependencies: [], inputId: "input-1", turnId: "turn-1", work: [{
        acceptanceChecks: [{ expectedText: "hellow", kind: "FILE_CONTAINS_EXACT", relativePath: "hello.txt" }],
        accessMode: "WRITE", instructions: "写入精确文本", key: "write", partnerId: partner.partnerId, title: "写入",
      }] });
      const facts = database.transaction((connection) => ({
        attempts: connection.prepare("SELECT action_id, outbox_id, partner_revision_id, registry_revision FROM dispatch_attempts").all(),
        outbox: connection.prepare("SELECT kind, payload_json, status FROM outbox WHERE kind = 'partner.dispatch'").all(),
        work: connection.prepare("SELECT workbench_id, input_id, intent_json, status FROM work_items").all(),
      }));
      expect(facts.work).toEqual([{
        workbench_id: "workbench-1", input_id: "input-1",
        intent_json: JSON.stringify({
          acceptanceChecks: [{ expectedText: "hellow", kind: "FILE_CONTAINS_EXACT", relativePath: "hello.txt" }],
          briefVersion: 2,
          instructions: "写入精确文本",
        }),
        status: "PLANNED",
      }]);
      expect(() => database.transaction((connection) => connection.prepare(`INSERT INTO work_items
        (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('work-invalid', 'workbench-1', NULL, 'invalid', '{}', 'READ', 'PLANNED', ?, ?)`)
        .run(clock.now().toISOString(), clock.now().toISOString()))).toThrow();
      expect(facts.attempts).toEqual([expect.objectContaining({ partner_revision_id: partner.partnerRevisionId, registry_revision: 1 })]);
      expect(facts.outbox).toEqual([expect.objectContaining({ kind: "partner.dispatch", status: "PENDING" })]);
      const attempt = facts.attempts[0] as { action_id: string };
      const outbox = facts.outbox[0] as { payload_json: string };
      expect(JSON.parse(outbox.payload_json)).toMatchObject({ actionId: attempt.action_id });
      const payload = JSON.parse(outbox.payload_json) as { actionId: string; dispatchAttemptId: string };
      const inbox = new SqliteJoiInboxRepository(database);
      const contexts = new SqliteWorkbenchContextRepository(database);
      const resultRepository = new SqliteWorkResultRepository(database);
      const privateResultBody = `bounded summary ${"x".repeat(2_000_000)} PRIVATE_RESULT_DETAIL`;
      const dispatchRequests: { taskProjection: string }[] = [];
      let resultInputId: string | null | undefined;
      const handler = new SqlitePartnerDispatchDelivery({
        clock,
        contextAssembler: new WorkbenchContextAssembler({ workbenches: new LegacyLifeStoreAdapter(database), clock, ids, projections: contexts, snapshots: contexts }),
        contexts,
        database,
        gateway: { recover: () => Promise.reject(new Error("must not recover")), startWithResult: () => Promise.reject(new Error("must not dispatch")) },
        instances: {
          dispatch: (input) => {
            dispatchRequests.push({ taskProjection: input.request.taskProjection });
            return Promise.resolve({
              actionId: input.request.actionId,
              artifacts: [],
              body: privateResultBody,
              externalRunId: `local:${input.request.actionId}`,
              status: "COMPLETED" as const,
              workId: input.request.workId,
            });
          },
        },
        leases: new SqliteWorkspaceLeaseManager({ clock, database }),
        partners: partnerRepository,
        publish: () => Promise.resolve(undefined),
        results: resultRepository,
        verifier: { verify: () => Promise.resolve({ status: "PASSED" }) },
      });
      await handler.handle({
        attemptCount: 0,
        availableAt: clock.now().toISOString(),
        createdAt: clock.now().toISOString(),
        kind: "partner.dispatch",
        outboxId: "outbox-test",
        payload,
        status: "CLAIMED",
      });
      expect(dispatchRequests[0]?.taskProjection).not.toContain("Original user request");
      expect(dispatchRequests[0]?.taskProjection).not.toContain("\nbody");
      expect(dispatchRequests[0]?.taskProjection).toContain("Task instructions:\n写入精确文本");
      expect(dispatchRequests[0]?.taskProjection).toContain("FILE_CONTAINS_EXACT hello.txt = hellow");
      await handler.handle({
        attemptCount: 1,
        availableAt: clock.now().toISOString(),
        createdAt: clock.now().toISOString(),
        kind: "partner.dispatch",
        outboxId: "outbox-test",
        payload,
        status: "CLAIMED",
      });
      // The workbench agent component traversal folds authoritative results into goal synthesis.
      const scan = new SqliteWorkbenchAgentScan(database);
      for (const unsynthesized of await scan.listUnsynthesizedResults("workbench-1")) {
        resultInputId = await inbox.enqueuePartnerResult({
          workbenchId: unsynthesized.workbenchId,
          eventId: unsynthesized.eventId,
          resultId: unsynthesized.resultId,
          status: unsynthesized.status,
          summary: unsynthesized.summary,
          workId: unsynthesized.workId,
        });
      }
      expect(await repository.listActive()).toEqual([]);
      expect(database.transaction((connection) => connection.prepare("SELECT status FROM dispatch_attempts").get()))
        .toEqual({ status: "COMPLETED" });
      const resultEvents = database.transaction((connection) => connection.prepare(
        "SELECT workbench_id, work_id, status FROM partner_result_events",
      ).all()) as { workbench_id: string; status: string; work_id: string }[];
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0]).toMatchObject({ workbench_id: "workbench-1", status: "COMPLETED" });
      expect(resultEvents[0]?.work_id).toMatch(/^work_/u);
      expect(resultInputId).toMatch(/^joi_result_input:/u);
      const resultInput = await inbox.loadInput(resultInputId ?? "missing");
      expect(resultInput).toMatchObject({ workbenchId: "workbench-1", status: "PENDING" });
      expect(resultInput?.body).not.toContain("resultId=work_result:");
      expect(resultInput?.body).toContain("work_read_evidence");
      expect(resultInput?.synthesisContext).toMatchObject({ totalResults: 1, changedResults: [{ status: "COMPLETED",handoffStatus: "MISSING" }] });
      expect(resultInput?.body).not.toContain("PRIVATE_RESULT_DETAIL");
      const projection = database.transaction((connection) => connection.prepare(
        "SELECT active_work_json, recent_results_json FROM workbench_task_projections WHERE workbench_id = 'workbench-1'",
      ).get()) as { active_work_json: string; recent_results_json: string };
      expect(JSON.parse(projection.active_work_json)).toEqual([]);
      const recent: unknown = JSON.parse(projection.recent_results_json);
      expect(Array.isArray(recent)).toBe(true);
      const firstRecent = (recent as Record<string, unknown>[])[0];
      expect(firstRecent).toMatchObject({ status: "COMPLETED" });
      expect(firstRecent?.workId).toMatch(/^work_/u);
      const storedResult = database.transaction((connection) => connection.prepare(
        "SELECT artifacts_json, body_ref, result_id FROM work_results",
      ).get()) as { artifacts_json: string; body_ref: string; result_id: string };
      expect(storedResult.body_ref).toBe(`work_result_artifact:${storedResult.result_id}`);
      expect(JSON.parse(storedResult.artifacts_json)).toEqual([
        expect.objectContaining({ artifactRef: storedResult.body_ref, name: "partner-result.txt", size: Buffer.byteLength(privateResultBody) }),
      ]);
      await expect(resultRepository.readBody({ workbenchId: "workbench-1", limit: 16, offset: 0, resultId: storedResult.result_id }))
        .resolves.toEqual({ body: privateResultBody.slice(0, 16), total: privateResultBody.length });
      expect(database.transaction((connection) => connection.prepare(
        "SELECT input_id FROM partner_result_events",
      ).get())).toEqual({ input_id: null });
      const signalInputId = await inbox.enqueueSystemSignal({ workbenchId: "workbench-1", signalId: "alarm-1", type: "schedule.alarm_due" });
      expect(await inbox.loadInput(signalInputId)).toMatchObject({ workbenchId: "workbench-1", status: "PENDING" });
      expect(database.transaction((connection) => connection.prepare("SELECT COUNT(*) AS count FROM workspace_leases").get()))
        .toEqual({ count: 0 });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("lets a harness review turn dispatch on behalf of the original goal but rejects unrelated turns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-work-plan-review-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      const ids = new TestIds();
      const now = clock.now().toISOString();
      database.transaction((connection) => {
        connection.prepare(`INSERT INTO workbenches
          (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
          VALUES ('workbench-r', '研究', 'persona-r', '人格', '范围', '工程', 'memory-r', '', 'ACTIVE', ?, ?)`).run(now, now);
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-r', 'key-goal-r', 'goal body', 'ROUTED', 'workbench-r', ?, ?)`).run(now, now);
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, goal_input_id, created_at, updated_at)
          VALUES ('joi_harness_review:goal:goal-r:r1', 'key-review-r', 'review', 'ROUTED', 'workbench-r', 'goal-r', ?, ?)`).run(now, now);
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('input-stranger', 'key-stranger', 'unrelated', 'ROUTED', 'workbench-r', ?, ?)`).run(now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-goal', 'goal-r', 'workbench-r', 'session-r', 'COMPLETED', ?, ?),
                 ('turn-review', 'joi_harness_review:goal:goal-r:r1', 'workbench-r', 'session-r', 'RUNNING', ?, ?),
                 ('turn-stranger', 'input-stranger', 'workbench-r', 'session-r', 'RUNNING', ?, ?)`)
          .run(now, now, now, now, now, now);
        connection.prepare(`UPDATE workbench_workspace_bindings SET kind = 'BOUND', status = 'READY', display_name = '工程', updated_at = ?
          WHERE workbench_id = 'workbench-r'`).run(now);
        connection.prepare(`INSERT INTO workbench_workspace_roots (workspace_ref, root_path, created_at, updated_at)
          VALUES ('workbench_workspace:workbench-r', ?, ?, ?)`).run(root, now, now);
      });
      const partners = new PartnerRegistryService({
        clock, ids, repository: new SqlitePartnerRegistryRepository(database),
      });
      const partner = await partners.add({ capabilities: ["write"], displayName: "Local", kind: "local-pi", skills: [], tools: ["edit"] });
      const service = new WorkOrchestrationService({
        clock, ids, partners, policy: { evaluate: () => Promise.resolve({ allowed: true }) }, repository: new SqliteWorkPlanRepository(database),
      });
      // Review turn dispatch binds back to the original goal.
      await service.plan({
        workbenchId: "workbench-r", dependencies: [], inputId: "goal-r", turnId: "turn-review",
        work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "READ", instructions: "下一层工作", key: "next", partnerId: partner.partnerId, title: "下一层" }],
      });
      expect(database.transaction((connection) => connection.prepare(
        "SELECT input_id, status FROM work_items",
      ).get())).toEqual({ input_id: "goal-r", status: "PLANNED" });
      // A turn with no goal relationship to the plan input stays rejected.
      await expect(service.plan({
        workbenchId: "workbench-r", dependencies: [], inputId: "goal-r", turnId: "turn-stranger",
        work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "READ", instructions: "Complete this scoped deliverable.", key: "forged", partnerId: partner.partnerId, title: "冒充" }],
      })).rejects.toThrow("work_plan_goal_binding_invalid");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
