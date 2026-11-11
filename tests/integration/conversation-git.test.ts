/* Async workspace doubles implement Promise-returning application ports. */
/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { simpleGit } from "simple-git";
import { GitWorkspaceAdapter } from "../../src/main/infrastructure/workspace/git-workspace-adapter";
import { createRuntimeFixture } from "../support/runtime-fixture";
import { SqliteGitCommandStore } from "../../src/main/infrastructure/persistence/sqlite-git-command-store";
import { ConversationWorkspaceService } from "../../src/main/application/joi/conversation-workspace-service";
import { SqliteWorkspaceLeaseManager } from "../../src/main/infrastructure/persistence/sqlite-workspace-lease-manager";
import { DomainError } from "../../src/main/domain/errors";
import type { WorkbenchWorkspaceRepository } from "../../src/main/application/ports/workbench-context";

describe("conversation Git workspace", () => {
  it("CHAT-07 queues Git mutations once and does not replay an interrupted write", async () => {
    const f = await createRuntimeFixture();
    try {
      const wb = await f.workbenchRegistry.create({ name: "Git",personaSummary: "Help",projectLabel: "Git",scopeSummary: "Git" });
      await f.workbenchWorkspaces.bindExisting(wb.workbenchId,f.root);
      const store = new SqliteGitCommandStore(f.database);
      const execute = vi.fn(() => Promise.resolve());
      const leases = new SqliteWorkspaceLeaseManager({ clock: f.clock,database: f.database });
      const workspace = vi.fn<WorkbenchWorkspaceRepository["getWorkspace"]>(async () => ({ workspaceRef: `workbench_workspace:${wb.workbenchId}`,kind: "BOUND",status: "READY",displayName: "fixture" }));
      const service = new ConversationWorkspaceService({ clock: f.clock,ids: f.ids,store,workspace: { execute },
        leases,workspaces: { getWorkspace: workspace } });
      const command = await service.submit(wb.workbenchId,{ action: "FETCH",requestId: "fetch" });
      expect(await service.submit(wb.workbenchId,{ action: "FETCH",requestId: "fetch" })).toEqual(command);
      await service.deliver(command.commandId); await service.deliver(command.commandId);
      expect(execute).toHaveBeenCalledTimes(1);
      const interrupted = await service.submit(wb.workbenchId,{ action: "PUSH",requestId: "push" });
      await store.begin(interrupted.commandId); await store.recoverInterrupted();
      await service.deliver(interrupted.commandId);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await service.get(interrupted.commandId)).toMatchObject({ status: "INTERRUPTED" });
      await expect(service.get("missing")).rejects.toMatchObject({ code: "git_command_not_found" });await service.deliver("missing");
      await expect(service.submit(wb.workbenchId,{ action: "FETCH",requestId: "bad/request" })).rejects.toMatchObject({ code: "git_request_invalid" });
      await expect(service.submit(wb.workbenchId,{ action: "STAGE",requestId: "too-many",paths: Array<string>(501).fill("file") })).rejects.toMatchObject({ code: "git_request_invalid" });
      await expect(service.submit(wb.workbenchId,{ action: "COMMIT",requestId: "too-long",message: "x".repeat(4001) })).rejects.toMatchObject({ code: "git_request_invalid" });
      for (const error of [new DomainError("git_nothing_staged","Nothing staged"),new Error("private-git-output")]) {
        const failed = await service.submit(wb.workbenchId,{ action: "COMMIT",message: "Commit",requestId: error instanceof DomainError ? "known-error" : "unknown-error" });execute.mockRejectedValueOnce(error);
        await service.deliver(failed.commandId);expect(await service.get(failed.commandId)).toMatchObject({ status: "FAILED",errorCode: error instanceof DomainError ? "git_nothing_staged" : "git_operation_failed" });
      }
      const queued = await service.submit(wb.workbenchId,{ action: "FETCH",requestId: "queued" });
      workspace.mockResolvedValueOnce(null);await expect(service.deliver(queued.commandId)).rejects.toMatchObject({ code: "workbench_workspace_not_ready" });
      workspace.mockResolvedValueOnce(null);await expect(service.submit(wb.workbenchId,{ action: "FETCH",requestId: "missing-workspace" })).rejects.toMatchObject({ code: "workbench_workspace_not_ready" });
      vi.spyOn(leases,"acquire").mockResolvedValueOnce(null);await expect(service.deliver(queued.commandId)).rejects.toMatchObject({ code: "workspace_busy" });
      await service.emergencyStop();expect(await service.get(queued.commandId)).toMatchObject({ status: "FAILED",errorCode: "git_stopped" });await service.deliver(queued.commandId);
      await expect(service.submit(wb.workbenchId,{ action: "FETCH",requestId: "after-stop" })).rejects.toMatchObject({ code: "git_stopped" });
    } finally { await f.close(); }
  });
  it("CHAT-07/08 stages only selected files, commits staged content, and rejects paths outside the workbench", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(),"joi-chat-git-"));
    try {
      const git = simpleGit(root);
      await git.init(); await git.addConfig("user.name","Fixture"); await git.addConfig("user.email","fixture@example.invalid");
      await writeFile(path.join(root,"one.txt"),"one\n"); await writeFile(path.join(root,"two.txt"),"two\n");
      const workspace = new GitWorkspaceAdapter({ root: async () => root });
      await workspace.execute("wb",{ action: "STAGE",paths: ["one.txt"],requestId: "stage" });
      expect((await workspace.status("wb")).files.find(f => f.path === "one.txt")?.index).toBe("A");
      await workspace.execute("wb",{ action: "COMMIT",message: "First",requestId: "commit" });
      const state = await workspace.status("wb");
      expect(state.history[0]?.message).toBe("First");
      expect(state.files.map(f => f.path)).toEqual(["two.txt"]);
      await writeFile(path.join(root,"one.txt"),"changed\n");
      expect((await workspace.diff("wb","one.txt",false)).patch).toContain("+changed");
      await expect(workspace.execute("wb",{ action: "STAGE",paths: ["../escape"],requestId: "bad" })).rejects.toMatchObject({ code: "workspace_path_invalid" });
      await expect(workspace.execute("wb",{ action: "BRANCH",branch: "--orphan",requestId: "bad-branch" })).rejects.toMatchObject({ code: "git_branch_invalid" });
      await workspace.execute("wb",{ action: "BRANCH",branch: "feature/chat",requestId: "branch" });
      expect((await workspace.status("wb")).branch).toBe("feature/chat");
      await writeFile(path.join(root,"config.json"),'{"apiKey":"private-fixture-secret", "normal":"visible"}\n');
      expect((await workspace.file("wb","config.json")).text).not.toContain("private-fixture-secret");
      expect((await workspace.diff("wb","config.json",false)).patch).not.toContain("private-fixture-secret");
    } finally { await rm(root,{ recursive: true,force: true }); }
  });
});
