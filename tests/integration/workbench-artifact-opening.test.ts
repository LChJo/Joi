import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeAgentConversationEntries } from "../../src/main/application/partners/agent-conversation-presentation.js";
import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("Workbench artifact opening", () => {
  it("keeps workspace paths private while resolving an Agent artifact for open and reveal", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "交付", personaSummary: "persona", projectLabel: "joi", scopeSummary: "产物" });
      const workspacePath = path.join(fixture.root, "workspace");
      await mkdir(path.join(workspacePath, "reports"), { recursive: true });
      const reportPath = path.join(workspacePath, "reports", "report.md");
      await writeFile(reportPath, "# report", "utf8");
      await fixture.workbenchWorkspaces.bindExisting(workbench.workbenchId, workspacePath);
      const partner = await fixture.partners.add({ capabilities: [], displayName: "交付搭档", kind: "local-pi", skills: [], tools: [] });
      const instance = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "RESIDENT" });
      const repository = new SqliteWorkbenchAgentRepository(fixture.database);
      await repository.append(instance.instanceId, normalizeAgentConversationEntries({
        agentId: instance.instanceId, runId: "run-artifact", startedAt: fixture.clock.now().toISOString(),
      }, [
        {
          artifact: { artifactRef: "workspace:reports/report.md", mimeType: "text/markdown", name: "report.md", size: 8 },
          kind: "ARTIFACT", role: "AGENT",
        },
        {
          artifact: { artifactRef: "workspace:reports", mimeType: "inode/directory", name: "reports", size: 0 },
          kind: "ARTIFACT", role: "AGENT",
        },
        {
          artifact: { artifactRef: "workspace:notes.md", mimeType: "text/plain", name: "notes.md", size: 4 },
          kind: "ARTIFACT", role: "AGENT",
        },
        {
          artifact: { mimeType: "application/octet-stream", name: "legacy.bin", size: 2 },
          kind: "ARTIFACT", role: "AGENT",
        },
      ]));

      const page = await repository.conversation({ agentId: instance.instanceId, workbenchId: workbench.workbenchId, limit: 50 });
      expect(page.items[0]?.artifact).toEqual({
        artifactId: page.items[0]?.entryId, directory: "reports", kind: "FILE", mimeType: "text/markdown", name: "report.md", size: 8,
      });
      expect(page.items[1]?.artifact).toEqual({
        artifactId: page.items[1]?.entryId, directory: "reports", kind: "DIRECTORY", mimeType: "inode/directory", name: "reports", size: 0,
      });
      expect(page.items[2]?.artifact).toEqual({
        artifactId: page.items[2]?.entryId, kind: "FILE", mimeType: "text/plain", name: "notes.md", size: 4,
      });
      expect(page.items[3]?.artifact).toEqual({
        kind: "FILE", mimeType: "application/octet-stream", name: "legacy.bin", size: 2,
      });
      expect(JSON.stringify(page)).not.toContain(workspacePath);
      expect(JSON.stringify(page)).not.toContain("reports/report.md");

      const artifactId = page.items[0]?.artifact?.artifactId;
      if (artifactId === undefined) throw new Error("missing artifact id");
      await expect(fixture.workbenchAgents.openArtifact({
        artifactId, mode: "OPEN", source: "AGENT", sourceId: instance.instanceId, workbenchId: workbench.workbenchId,
      })).resolves.toEqual({ opened: true });
      await expect(fixture.workbenchAgents.openArtifact({
        artifactId, mode: "REVEAL", source: "AGENT", sourceId: instance.instanceId, workbenchId: workbench.workbenchId,
      })).resolves.toEqual({ opened: true });
      const directoryArtifactId = page.items[1]?.artifact?.artifactId;
      if (directoryArtifactId === undefined) throw new Error("missing directory artifact id");
      await expect(fixture.workbenchAgents.openArtifact({
        artifactId: directoryArtifactId, mode: "OPEN", source: "AGENT", sourceId: instance.instanceId, workbenchId: workbench.workbenchId,
      })).resolves.toEqual({ opened: true });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-artifact', 'key-artifact', '生成报告', 'CONSUMED', ?, ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-artifact', 'goal-artifact', ?, 'session-artifact', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO dispatch_plans
          (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
          VALUES ('plan-artifact', 'turn-artifact', '{}', '{}', ?)`).run(now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-artifact', ?, 'goal-artifact', '生成报告', '{}', 'WRITE', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, instance_id, status, created_at, updated_at)
          VALUES ('attempt-artifact', 'plan-artifact', 'work-artifact', ?, 1, 'action-artifact', ?, 'COMPLETED', ?, ?)`)
          .run(partner.partnerRevisionId, instance.instanceId, now, now);
        connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at)
          VALUES ('run-goal-artifact', 'attempt-artifact', 'action-artifact', ?, 'work-artifact', ?, 'LOCAL_PI', 'local:artifact', 'COMPLETED', ?, ?)`)
          .run(workbench.workbenchId, partner.partnerRevisionId, now, now);
        connection.prepare(`INSERT INTO work_result_bodies (body_ref, body, created_at)
          VALUES ('body-artifact', '完成', ?)`).run(now);
        connection.prepare(`INSERT INTO work_results
          (result_id, run_id, action_id, workbench_id, work_id, partner_revision_id, instance_id, status, summary, body_ref,
           artifacts_json, is_late, is_authoritative, created_at)
          VALUES ('result-artifact', 'run-goal-artifact', 'action-artifact', ?, 'work-artifact', ?, ?, 'COMPLETED', '完成', 'body-artifact', ?, 0, 1, ?)`)
          .run(workbench.workbenchId, partner.partnerRevisionId, instance.instanceId, JSON.stringify([
            { artifactRef: "workspace:reports/report.md", mimeType: "text/markdown", name: "report.md", size: 8 },
            { artifactRef: "workspace:reports", mimeType: "inode/directory", name: "reports", size: 0 },
            { artifactRef: "workspace:../outside.txt", mimeType: "text/plain", name: "outside.txt", size: 1 },
          ]), now);
        connection.prepare(`INSERT INTO work_result_verifications (result_id, status, created_at)
          VALUES ('result-artifact', 'NOT_REQUIRED', ?)`).run(now);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES ('goal-artifact', 1, 1, ?)`).run(now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, disposition, completion_summary, completed_at, updated_at)
          VALUES ('goal-artifact', 1, 'COMPLETED', '报告已经生成。', ?, ?)`).run(now, now);
      });
      const goal = (await fixture.joiHomeFeed.load()).goals.find((candidate) => candidate.goalId === "goal-artifact");
      expect(goal?.artifacts).toEqual([
        { artifactId: "work_result_artifact:result-artifact:0", directory: "reports", kind: "FILE", mimeType: "text/markdown", name: "report.md", size: 8 },
        { artifactId: "work_result_artifact:result-artifact:1", directory: "reports", kind: "DIRECTORY", mimeType: "inode/directory", name: "reports", size: 0 },
      ]);
      expect(JSON.stringify(goal)).not.toContain(workspacePath);
      await expect(fixture.workbenchAgents.openArtifact({
        artifactId: "work_result_artifact:result-artifact:0", mode: "OPEN", source: "GOAL", sourceId: "goal-artifact", workbenchId: workbench.workbenchId,
      })).resolves.toEqual({ opened: true });
      expect(fixture.artifactOpenCalls).toEqual([
        { kind: "FILE", mode: "OPEN", targetPath: reportPath },
        { kind: "FILE", mode: "REVEAL", targetPath: reportPath },
        { kind: "DIRECTORY", mode: "OPEN", targetPath: path.join(workspacePath, "reports") },
        { kind: "FILE", mode: "OPEN", targetPath: reportPath },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects traversal and missing workspace artifacts before calling the desktop opener", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "安全", personaSummary: "persona", projectLabel: "joi", scopeSummary: "产物" });
      const workspacePath = path.join(fixture.root, "workspace");
      await mkdir(workspacePath, { recursive: true });
      const outsidePath = path.join(fixture.root, "outside");
      await mkdir(outsidePath, { recursive: true });
      await writeFile(path.join(outsidePath, "secret.txt"), "secret", "utf8");
      await symlink(outsidePath, path.join(workspacePath, "linked-outside"), "junction");
      await fixture.workbenchWorkspaces.bindExisting(workbench.workbenchId, workspacePath);
      const partner = await fixture.partners.add({ capabilities: [], displayName: "安全搭档", kind: "local-pi", skills: [], tools: [] });
      const instance = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "RESIDENT" });
      const repository = new SqliteWorkbenchAgentRepository(fixture.database);
      await repository.append(instance.instanceId, normalizeAgentConversationEntries({
        agentId: instance.instanceId, runId: "run-invalid-artifacts", startedAt: fixture.clock.now().toISOString(),
      }, [
        { artifact: { artifactRef: "workspace:../outside.txt", mimeType: "text/plain", name: "outside.txt", size: 1 }, kind: "ARTIFACT", role: "AGENT" },
        { artifact: { artifactRef: "workspace:missing.txt", mimeType: "text/plain", name: "missing.txt", size: 1 }, kind: "ARTIFACT", role: "AGENT" },
        { artifact: { artifactRef: "workspace:linked-outside/secret.txt", mimeType: "text/plain", name: "secret.txt", size: 6 }, kind: "ARTIFACT", role: "AGENT" },
      ]));
      const page = await repository.conversation({ agentId: instance.instanceId, workbenchId: workbench.workbenchId, limit: 50 });
      const artifactEntries = page.items.filter((item) => item.artifact !== undefined);

      for (const entry of artifactEntries) {
        await expect(fixture.workbenchAgents.openArtifact({
          artifactId: entry.artifact?.artifactId ?? entry.entryId,
          mode: "OPEN", source: "AGENT", sourceId: instance.instanceId, workbenchId: workbench.workbenchId,
        })).rejects.toMatchObject({ code: "workbench_artifact_unavailable" });
      }
      expect(fixture.artifactOpenCalls).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
