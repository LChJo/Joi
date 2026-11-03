import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import { PartnerInstanceManager } from "../../src/main/application/partners/partner-instance-manager.js";
import { SqliteDispatchPolicyGate } from "../../src/main/infrastructure/persistence/sqlite-dispatch-policy-gate.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqlitePartnerInstanceRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-instance-repository.js";
import { SqlitePartnerInstanceMessageStore } from "../../src/main/infrastructure/persistence/sqlite-partner-instance-message-store.js";
import { SqlitePartnerDispatchDelivery } from "../../src/main/infrastructure/a2a/partner-dispatch-delivery-adapter.js";
import { SqliteWorkspaceLeaseManager } from "../../src/main/infrastructure/persistence/sqlite-workspace-lease-manager.js";
import { SqliteWorkResultRepository } from "../../src/main/infrastructure/persistence/sqlite-work-result-repository.js";
import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime.js";
import { BuiltinPiCodingToolFactory } from "../../src/main/infrastructure/pi/pi-coding-tool-factory.js";
import { WorkspaceWorkVerifier } from "../../src/main/infrastructure/workspace/workspace-work-verifier.js";
import { workResultArtifactId } from "../../src/main/domain/work/workspace-artifact-reference.js";
import { WorkRunDirectoryProvisioner } from "../../src/main/infrastructure/persistence/work-run-directory-provisioner.js";
import { SqliteWorkbenchContextRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-context-repository.js";
import { WorkbenchContextAssembler } from "../../src/main/application/joi/workbench-context-assembler.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("per-run working directories", () => {
  it("dispatches text-intent Skill work through the real outbox, reads the Skill, runs bash and opens its generated artifact", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const skillsRoot = path.join(fixture.root, "skills");
      const skillFile = path.join(skillsRoot, "example", "SKILL.md");
      await mkdir(path.dirname(skillFile), { recursive: true });
      await writeFile(skillFile, "---\nname: example\ndescription: Disposable CLI skill\n---\nskill-fixture-ok\n");
      vi.stubEnv("JOI_AGENTS_SKILLS_DIR", skillsRoot);
      vi.stubEnv("JOI_CLAUDE_SKILLS_DIR", path.join(fixture.root, "empty-claude"));
      vi.stubEnv("JOI_CODEX_SKILLS_DIR", path.join(fixture.root, "empty-codex"));
      const workbench = await fixture.workbenchRegistry.create({ name: "CLI analysis", personaSummary: "fixture", projectLabel: "fixture", scopeSummary: "fixture" });
      const workbenchId = workbench.workbenchId;
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((db) => {
        db.prepare(`INSERT INTO joi_inbox_messages (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('cli-input', 'cli-key', 'Analyze using a CLI', 'ROUTED', ?, ?, ?)`).run(workbenchId, now, now);
        db.prepare(`INSERT INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('cli-turn', 'cli-input', ?, 'cli-session', 'RUNNING', ?, ?)`).run(workbenchId, now, now);
      });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "CLI partner", kind: "local-pi", skills: ["agents/example"], tools: ["read", "bash"] });
      const plans = new SqliteWorkPlanRepository(fixture.database);
      const service = new WorkOrchestrationService({ clock: fixture.clock, ids: fixture.ids, partners: fixture.partners,
        policy: new SqliteDispatchPolicyGate({ clock: fixture.clock, database: fixture.database }), repository: plans });
      await service.plan({ workbenchId, inputId: "cli-input", turnId: "cli-turn", dependencies: [], work: [{
        instructions: "Complete this scoped deliverable.", key: "cli", title: "Analyze", partnerId: partner.partnerId, accessMode: "NONE",
        acceptanceChecks: [{ kind: "FILE_CONTAINS_EXACT", relativePath: "report.txt", expectedText: "cli-fixture-ok" }],
      }] });
      const contexts = new SqliteWorkbenchContextRepository(fixture.database);
      const faux = fauxProvider({ provider: "run-directory-fixture" });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: skillFile })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("bash", { command: "printf cli-fixture-ok | tee report.txt" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("bash", { command: "printf cli-fixture-ok | tee report.txt" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("CLI analysis completed.")]),
      ]);
      const models = createModels(); models.setProvider(faux.provider);
      const observed: { name: string; text: string }[] = [];
      const builtin = new BuiltinPiCodingToolFactory();
      const engine = new PiPartnerEngineRuntime({ contexts, prompts: { read: () => Promise.resolve(null) },
        resolver: { resolve: () => Promise.resolve({ model: faux.getModel(), models, thinkingLevel: "off" as const }) },
        sources: { selectInitial: (turnId) => Promise.resolve({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
        tools: { names: builtin.names, create: (cwd, names, options) => builtin.create(cwd, names, options).map((tool) => ({ ...tool,
          execute: async (...args: Parameters<typeof tool.execute>) => {
            const result = await tool.execute(...args);
            observed.push({ name: tool.name, text: JSON.stringify(result.content) });
            return result;
          },
        })) },
      });
      const partnerRepository = new SqlitePartnerRegistryRepository(fixture.database);
      const instances = new PartnerInstanceManager({ clock: fixture.clock, ids: fixture.ids, knowledge: fixture.knowledge,
        engines: new Map([["pi-core", engine]]), registry: fixture.partners, revisions: partnerRepository, skills: fixture.skills,
        repository: new SqlitePartnerInstanceRepository(fixture.database), messages: new SqlitePartnerInstanceMessageStore(fixture.database) });
      const delivery = new SqlitePartnerDispatchDelivery({ clock: fixture.clock, database: fixture.database, contexts,
        contextAssembler: new WorkbenchContextAssembler({ clock: fixture.clock, ids: fixture.ids, workbenches: fixture.workbenches, projections: contexts, snapshots: contexts }),
        runDirectories: new WorkRunDirectoryProvisioner({ baseDirectory: path.join(fixture.root, "fake-user", "joi", "runs"), clock: fixture.clock, database: fixture.database }),
        gateway: { recover: () => Promise.reject(new Error("no A2A")), startWithResult: () => Promise.reject(new Error("no A2A")) },
        instances, partners: partnerRepository, leases: new SqliteWorkspaceLeaseManager({ clock: fixture.clock, database: fixture.database }),
        results: new SqliteWorkResultRepository(fixture.database), verifier: new WorkspaceWorkVerifier({ contexts }),
      });
      const row = fixture.database.transaction((db) => db.prepare("SELECT outbox_id, payload_json FROM outbox WHERE kind = 'partner.dispatch'").get()) as { outbox_id: string; payload_json: string };
      const record = { outboxId: row.outbox_id, payload: JSON.parse(row.payload_json) as Record<string, unknown>, kind: "partner.dispatch", status: "CLAIMED" as const, attemptCount: 0, availableAt: now, createdAt: now };
      await delivery.handle(record);
      await delivery.handle(record);
      expect(observed.map((item) => item.name)).toEqual(["read", "bash"]);
      expect(observed[0]?.text).toContain("skill-fixture-ok");
      expect(observed[1]?.text).toContain("cli-fixture-ok");
      const result = fixture.database.transaction((db) => db.prepare("SELECT r.result_id, r.status, r.artifacts_json, v.status AS verification FROM work_results r JOIN work_result_verifications v ON v.result_id = r.result_id").get()) as { result_id: string; status: string; artifacts_json: string; verification: string };
      expect(result).toMatchObject({ status: "COMPLETED", verification: "PASSED" });
      const artifacts = JSON.parse(result.artifacts_json) as { name: string }[];
      const index = artifacts.findIndex((item) => item.name === "report.txt");
      expect(index).toBeGreaterThanOrEqual(0);
      const opened = await new SqliteWorkbenchAgentRepository(fixture.database).resolveArtifact({ workbenchId, source: "GOAL", sourceId: "cli-input", artifactId: workResultArtifactId(result.result_id, index) });
      expect(opened.kind).toBe("FILE");
      expect(opened.targetPath).toContain(`${path.sep}runs${path.sep}`);
    } finally { vi.unstubAllEnvs(); await fixture.close(); }
  }, 30_000);

  it.each(["MANAGED", "BOUND"] as const)("provisions %s directories and reuses them on recovery", async (kind) => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "Run directories", personaSummary: "fixture", projectLabel: "fixture", scopeSummary: "fixture" });
      const workbenchId = workbench.workbenchId;
      const baseDirectory = path.join(fixture.root, "fake-user", "joi", "runs");
      const bound = path.join(fixture.root, "bound");
      if (kind === "BOUND") {
        await mkdir(bound);
        await fixture.workbenchWorkspaces.bindExisting(workbenchId, bound);
      }
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((db) => {
        db.prepare(`INSERT INTO joi_inbox_messages (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('directory-input', 'directory-key', 'fixture', 'ROUTED', ?, ?, ?)`).run(workbenchId, now, now);
        db.prepare(`INSERT INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('directory-turn', 'directory-input', ?, 'directory-session', 'RUNNING', ?, ?)`).run(workbenchId, now, now);
        for (const workId of ["work-a", "work-b"]) {
          db.prepare(`INSERT INTO work_items (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
            VALUES (?, ?, 'directory-input', 'fixture', '{}', 'WRITE', 'READY', ?, ?)`).run(workId, workbenchId, now, now);
          db.prepare("INSERT INTO work_access_policies (work_id, access_mode) VALUES (?, 'WRITE')").run(workId);
        }
      });
      const options = { baseDirectory, clock: fixture.clock, database: fixture.database };
      const provisioner = new WorkRunDirectoryProvisioner(options);
      await Promise.all([provisioner.ensureForWork({ workbenchId, workId: "work-a" }), provisioner.ensureForWork({ workbenchId, workId: "work-b" })]);
      await new WorkRunDirectoryProvisioner(options).ensureForWork({ workbenchId, workId: "work-a" });
      const contexts = new SqliteWorkbenchContextRepository(fixture.database);
      const assembler = new WorkbenchContextAssembler({ clock: fixture.clock, ids: fixture.ids, workbenches: fixture.workbenches, projections: contexts, snapshots: contexts });
      fixture.database.transaction((db) => {
        db.prepare(`UPDATE workbench_task_projections SET active_work_json = ?, recent_results_json = ? WHERE workbench_id = ?`).run(
          JSON.stringify([{ workId: "work-a", title: "current", status: "READY" }, { workId: "previous-goal-work", title: "OLD_GOAL", status: "RUNNING" }]),
          JSON.stringify([{ resultId: "own-result", workId: "work-b", summary: "own evidence", status: "COMPLETED" }, { resultId: "old-result", workId: "previous-goal-work", summary: "OLD_EVIDENCE", status: "COMPLETED" }]),
          workbenchId,
        );
      });
      const first = await assembler.assemble({ workbenchId, workId: "work-a" });
      expect(first.safeContext.activeWork.map((work) => work.workId)).toEqual(["work-a"]);
      expect(first.safeContext.recentResults.map((result) => result.resultId)).toEqual(["own-result"]);
      const second = await assembler.assemble({ workbenchId, workId: "work-b" });
      const firstPath = (await contexts.loadForExecution(first.contextSnapshotId))?.workspacePath;
      const secondPath = (await contexts.loadForExecution(second.contextSnapshotId))?.workspacePath;
      expect(firstPath).toBeDefined();
      expect(secondPath).toBeDefined();
      if (firstPath === undefined || secondPath === undefined) throw new Error("missing runtime directory");
      expect((await stat(firstPath)).isDirectory()).toBe(true);
      if (kind === "MANAGED") {
        expect(path.dirname(firstPath)).toBe(baseDirectory);
        expect(path.basename(firstPath)).toMatch(/^\d{4}-\d{2}-\d{2}T.+_[a-f0-9-]+$/u);
        expect(secondPath).not.toBe(firstPath);
      } else { expect(firstPath).toBe(bound); expect(secondPath).toBe(bound); }
      expect((await contexts.loadForExecution(first.contextSnapshotId))?.workspacePath).toBe(firstPath);
      expect(JSON.stringify(first)).not.toContain(fixture.root);
      await expect(provisioner.ensureForWork({ workbenchId: "other", workId: "work-a" })).rejects.toThrow();
    } finally { await fixture.close(); }
  });
});
