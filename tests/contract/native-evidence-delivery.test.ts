/* eslint-disable @typescript-eslint/require-await */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent } from "@openai/codex-sdk";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import { ClaudeAgentSdkPartnerEngineRuntime } from "../../src/main/infrastructure/mana/claude-agent-sdk-partner-engine-runtime.js";
import { CodexAgentSdkPartnerEngineRuntime } from "../../src/main/infrastructure/mana/codex-agent-sdk-partner-engine-runtime.js";
import { prepareNativeEvidenceContext, stageWorkEvidence } from "../../src/main/infrastructure/workspace/work-evidence-stager.js";
import { captureWorkspaceSnapshot, collectChangedWorkspaceArtifacts } from "../../src/main/infrastructure/workspace/workspace-output-artifacts.js";

const evidence = { index: "result-1: result-1.md (FAILED; NOT_ACCEPTED)\nresult-2: result-2.md (COMPLETED; PASSED)", files: [
  { name: "result-1.md", body: "conflicting failed evidence" }, { name: "result-2.md", body: "complete original evidence with conclusion tail" },
], inline: "selected evidence body" };
const request = { actionId: "action_evidence", contextSnapshotId: "snapshot_evidence", taskProjection: "complete work", workbenchId: "bench", workId: "work" };
const context = { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" };

describe("AC-43/48/53 native evidence delivery", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "joi-evidence-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("atomically stages immutable snapshot input once, outside deliverables", async () => {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const before = await captureWorkspaceSnapshot(workspace);
    const input = { contextSnapshotId: request.contextSnapshotId, evidence, taskDirectory: path.join(root, "inputs") };
    const first = await stageWorkEvidence(input);
    const initial = await stat(first.indexPath);
    const second = await stageWorkEvidence(input);
    expect(second).toEqual(first);
    expect((await stat(first.indexPath)).mtimeMs).toBe(initial.mtimeMs);
    expect(await readFile(first.indexPath, "utf8")).toContain("FAILED; NOT_ACCEPTED");
    expect(await readFile(path.join(path.dirname(first.indexPath), "result-2.md"), "utf8")).toContain("conclusion tail");
    expect((await stat(first.indexPath)).mode & 0o222).toBe(0);
    expect(await readdir(path.join(root, "inputs", "evidence"))).toHaveLength(1);
    expect(await collectChangedWorkspaceArtifacts(workspace, before)).toEqual([]);
    const changed = await stageWorkEvidence({ ...input, evidence: { ...evidence, index: `${evidence.index}\nnew version` } });
    expect(changed.indexPath).not.toBe(first.indexPath);
  });

  it("makes long single-line evidence accessible in exact 8000-character pages", async () => {
    const body = `${"m".repeat(16_000)}MIDDLE_AND_TAIL`;
    const staged = await stageWorkEvidence({ contextSnapshotId: "paged", evidence: { index: JSON.stringify({ result: "result-0.txt" }), inline: "bounded", files: [{ name: "result-0.txt", body }] }, taskDirectory: root });
    const manifest = JSON.parse(await readFile(staged.indexPath, "utf8")) as { nativeFilePages: { file: string; pages: { name: string; offset: number; characters: number }[] }[] };
    const pages = manifest.nativeFilePages[0]?.pages ?? [];
    expect(pages.map(page => page.offset)).toEqual([0, 8000, 16_000]);
    let recovered = "";
    for (const page of pages) {
      const content = await readFile(path.join(path.dirname(staged.indexPath), page.name), "utf8");
      expect(content.length).toBeLessThanOrEqual(8000);
      recovered += content;
    }
    expect(recovered).toBe(body);
  });

  it("preserves Unicode evidence across native page boundaries", async () => {
    const body = `${"m".repeat(7999)}😀尾部`;
    const staged = await stageWorkEvidence({ contextSnapshotId: "unicode", evidence: { index: "result-0.txt", inline: "bounded", files: [{ name: "result-0.txt", body }] }, taskDirectory: root });
    const manifest = JSON.parse(await readFile(staged.indexPath, "utf8")) as { nativeFilePages: { pages: { name: string }[] }[] };
    const pages = manifest.nativeFilePages[0]?.pages ?? [];
    let recovered = "";
    for (const page of pages) recovered += await readFile(path.join(path.dirname(staged.indexPath), page.name), "utf8");
    expect(recovered).toBe(body);
  });

  it("preserves complete inline evidence if reads or staging are unavailable", async () => {
    const completeEvidence = { ...evidence, selfContainedInline: "FULL_EXPLICIT_EVIDENCE_MIDDLE_AND_CONCLUSION_TAIL" };
    const execution = { promptSection: `requirements\n${evidence.inline}`, sanitized: {}, evidence: completeEvidence };
    const events: unknown[] = [];
    const diagnostics = { emit: (event: string, fields: unknown) => { events.push({ event, fields }); } };
    const unreadable = await prepareNativeEvidenceContext({ execution, request, canRead: false, diagnostics, engine: "claude-code", taskDirectory: root });
    expect(unreadable).toBe(`requirements\n${completeEvidence.selfContainedInline}`);
    const blocked = path.join(root, "blocked");
    await writeFile(blocked, "not a directory");
    expect(await prepareNativeEvidenceContext({ execution, request, canRead: true, diagnostics, engine: "codex", taskDirectory: blocked })).toBe(unreadable);
    expect(events).toEqual([
      { event: "joi.context.delivery", fields: { budgetFallbacks: 1, contextChars: unreadable.length, engine: "claude-code", evidenceChars: completeEvidence.selfContainedInline.length, evidenceCount: 2, reasonCode: "evidence_reader_unavailable" } },
      { event: "joi.context.delivery", fields: { budgetFallbacks: 1, contextChars: unreadable.length, engine: "codex", evidenceChars: completeEvidence.selfContainedInline.length, evidenceCount: 2, reasonCode: "evidence_staging_failed" } },
    ]);
    expect(JSON.stringify(events)).not.toContain(root);
    expect(JSON.stringify(events)).not.toContain(evidence.inline);
    await expect(stageWorkEvidence({ contextSnapshotId: "snapshot", evidence: { ...evidence, files: [{ name: "../escape", body: "bad" }] }, taskDirectory: root })).rejects.toThrow();
  });

  it.each(["claude-code", "codex"] as const)("%s sends a readable index without repeating bodies and preserves requirements", async engine => {
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    const required = `authoritative requirements ${"r".repeat(140_000)} END_OF_REQUIREMENTS`;
    const contexts = { loadForExecution: async () => ({ promptSection: `${required}\n${evidence.inline}`, sanitized: {}, workspacePath, evidence }) };
    const revision = createPartnerRevision({ capabilities: [], createdAt: "2026-10-19T00:00:00Z", displayName: engine, engine, kind: "local-pi", partnerId: engine, partnerRevisionId: engine, registryRevision: 1, skills: [], tools: ["Read"], toolPolicyMode: "CUSTOM" });
    let systemPrompt = "";
    const runtime = engine === "claude-code"
      ? new ClaudeAgentSdkPartnerEngineRuntime({ contexts, evidenceDirectory: path.join(root, "inputs"), prompts: { read: async () => null }, resolveExecutable: () => ({ commandName: "claude", executablePath: "fake", protocol: "claude" }), sdk: { query: input => {
        systemPrompt = typeof input.options?.systemPrompt === "string" ? input.options.systemPrompt : "";
        return (async function* () { yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "session" } as SDKMessage; })();
      } } })
      : new CodexAgentSdkPartnerEngineRuntime({ contexts, evidenceDirectory: path.join(root, "inputs"), prompts: { read: async () => null }, resolveExecutable: () => ({ commandName: "codex", executablePath: "fake", protocol: "codex" }), sdk: { create: input => {
        systemPrompt = typeof input.config?.developer_instructions === "string" ? input.config.developer_instructions : "";
        const thread = { id: "thread", runStreamed: async () => ({ events: (async function* () {
          yield { type: "item.completed", item: { type: "agent_message", id: "answer", text: "done" } } as ThreadEvent;
          yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } } as ThreadEvent;
        })() }) };
        return { startThread: () => thread, resumeThread: () => thread };
      } } });
    const output = await runtime.runEphemeral(request, revision, context);
    expect(systemPrompt).toContain("END_OF_REQUIREMENTS");
    expect(systemPrompt).not.toContain(evidence.inline);
    expect(systemPrompt).not.toContain(evidence.files[0]?.body);
    const index = /Evidence index \(read-only input\): (.+)/u.exec(systemPrompt)?.[1];
    expect(index).toBeDefined();
    if (index === undefined) throw new Error("evidence_index_missing");
    expect(await readFile(index, "utf8")).toContain("result-2.md");
    expect(output.output.artifacts).toEqual([]);
  });
});
