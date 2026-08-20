/* Faux Agent SDK surface + injected executable resolver keep these tests binary-free. */
/* eslint-disable @typescript-eslint/require-await */
import type { QueryInput } from "@rd-efficiency/agentsdk";

import type { LocalCliSdkSurface } from "../../src/main/infrastructure/mana/local-cli-partner-engine-runtime.js";
import { LocalCliPartnerEngineRuntime } from "../../src/main/infrastructure/mana/local-cli-partner-engine-runtime.js";
import type { ResolvedLocalCliExecutable } from "../../src/main/infrastructure/mana/local-cli-executable-resolver.js";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";

function localRevision(overrides: Partial<Parameters<typeof createPartnerRevision>[0]> = {}) {
  return createPartnerRevision({
    capabilities: [], createdAt: "2026-07-30T10:00:00.000Z", displayName: "Local CLI partner",
    engine: "claude-code", engineModelId: "claude-sonnet", kind: "local-pi",
    partnerId: "partner_cli", partnerRevisionId: "revision_cli", registryRevision: 1,
    skills: [], tools: [],
    ...overrides,
  });
}

interface FakeConversation {
  close(): Promise<void>;
  id: string;
  messages(): Promise<{ id: string }[]>;
  send(text: string): AsyncIterable<{ subtype?: string; type: string }>;
}

function makeFakeSdk(options: { failResume?: boolean; resultSubtype?: string } = {}) {
  const createdOptions: unknown[] = [];
  const resumedIds: string[] = [];
  const sentTexts: string[] = [];
  let conversationCount = 0;
  const makeConversation = (id: string): FakeConversation => ({
    close: async () => undefined,
    id,
    messages: async () => [{ id: `message_${id}` }],
    send: function* (text: string) {
      sentTexts.push(text);
      yield { subtype: options.resultSubtype ?? "success", type: "result" };
    } as unknown as FakeConversation["send"],
  });
  const sdk: LocalCliSdkSurface = {
    createConversation: async (conversationOptions) => {
      createdOptions.push(conversationOptions);
      conversationCount += 1;
      return makeConversation(`conversation_${String(conversationCount)}`) as never;
    },
    query: function* (input: QueryInput) {
      createdOptions.push(input);
      yield { subtype: options.resultSubtype ?? "success", type: "result" };
    } as never,
    resumeConversation: async (conversationId, resumeOptions) => {
      resumedIds.push(conversationId);
      if (options.failResume === true) throw new Error("conversation_not_found");
      createdOptions.push(resumeOptions);
      conversationCount += 1;
      return makeConversation(conversationId) as never;
    },
  };
  return { createdOptions, resumedIds, sdk, sentTexts };
}

function resolved(available: boolean, protocol: "claude" | "codex"): ResolvedLocalCliExecutable {
  return { commandName: protocol === "codex" ? "codex" : "claude", protocol, ...(available ? { executablePath: protocol === "codex" ? "/fake/codex" : "/fake/claude.exe" } : {}) };
}

function makeRunner(sdk: LocalCliSdkSurface, options: { available?: boolean; protocol?: "claude" | "codex"; workspacePaths?: string[] } = {}) {
  const protocol = options.protocol ?? "claude";
  let contextRead = 0;
  return new LocalCliPartnerEngineRuntime({
    contexts: { loadForExecution: async () => {
      const workspacePath = options.workspacePaths?.[contextRead] ?? options.workspacePaths?.at(-1) ?? "workspace_cli";
      contextRead += 1;
      return { promptSection: "Workbench context", sanitized: {}, workspacePath };
    } },
    prompts: { read: async (promptRef) => (promptRef === "prompt_cli" ? "CLI_SYSTEM_SENTINEL" : null) },
    protocol,
    resolveExecutable: () => resolved(options.available ?? true, protocol),
    sdk,
    store: {
      appendTranscript: async () => ({}),
      create: async () => ({}),
      delete: async () => undefined,
      fork: async () => ({}),
      get: async () => null,
      listMessages: async () => [],
      update: async () => ({}),
    } as never,
  });
}

const request = { actionId: "action_cli_1", workbenchId: "workbench_1", contextSnapshotId: "context_1", taskProjection: "implement the change", workId: "work_1" };

describe("local CLI partner engine", () => {
  it("runs ephemeral turns through one-shot query with the detected executable, protocol and edit permissions, no injected provider", async () => {
    const fake = makeFakeSdk();
    const runner = makeRunner(fake.sdk);
    await expect(runner.runEphemeral(request, localRevision(), { knowledgeSection: "KB_SECTION", skillEnvironmentKeys: [], skillSection: "" }))
      .resolves.toMatchObject({ externalRunId: "local_cli:action_cli_1", status: "COMPLETED" });
    const input = fake.createdOptions[0] as { options: { cwd?: string; model?: string; pathToAgentExecutable?: string; pathToClaudeCodeExecutable?: string; permissionMode?: string; protocol?: string; provider?: unknown; systemPrompt?: string }; prompt: string };
    expect(input.prompt).toBe("implement the change");
    expect(input.options).toMatchObject({ cwd: "workspace_cli", model: "claude-sonnet", pathToAgentExecutable: "/fake/claude.exe", pathToClaudeCodeExecutable: "/fake/claude.exe", permissionMode: "acceptEdits", protocol: "claude" });
    expect(input.options.provider).toBeUndefined();
    expect(input.options.systemPrompt).toContain("KB_SECTION");
  });

  it("passes a tool whitelist through allowedTools only when tools are selected", async () => {
    const fake = makeFakeSdk();
    const runner = makeRunner(fake.sdk);
    await runner.runEphemeral(request, localRevision({ tools: ["Bash", "Read"] }), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" });
    const withTools = (fake.createdOptions[0] as { options: { allowedTools?: string[] } }).options;
    expect(withTools.allowedTools).toEqual(["Bash", "Read"]);

    const fake2 = makeFakeSdk();
    const runner2 = makeRunner(fake2.sdk);
    await runner2.runEphemeral(request, localRevision({ tools: [] }), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" });
    expect((fake2.createdOptions[0] as { options: { allowedTools?: string[] } }).options.allowedTools).toBeUndefined();
  });

  it("injects selected skill instructions into the system prompt", async () => {
    const fake = makeFakeSdk();
    const runner = makeRunner(fake.sdk);
    await runner.runEphemeral(request, localRevision(), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "# Selected skills\n## Skill: x" });
    const systemPrompt = (fake.createdOptions[0] as { options: { systemPrompt?: string } }).options.systemPrompt ?? "";
    expect(systemPrompt).toContain("# Selected skills");
  });

  it("reports FAILED when the result message is not a success", async () => {
    const fake = makeFakeSdk({ resultSubtype: "error_during_execution" });
    const runner = makeRunner(fake.sdk);
    await expect(runner.runEphemeral(request, localRevision(), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" }))
      .resolves.toMatchObject({ status: "FAILED" });
  });

  it("keeps one warm resident conversation per instance and resumes by stored conversation id", async () => {
    const fake = makeFakeSdk();
    const runner = makeRunner(fake.sdk);
    const first = await runner.runResidentTurn({ instanceId: "instance_cli", knowledgeSection: "", request, restoredMessages: null, revision: localRevision(), skillEnvironmentKeys: [], skillSection: "" });
    expect(first).toMatchObject({ externalSessionRef: "conversation_1", status: "COMPLETED" });
    expect(first.messages).toHaveLength(1);

    const second = await runner.runResidentTurn({ ...(first.externalSessionRef === undefined ? {} : { externalSessionRef: first.externalSessionRef }), instanceId: "instance_cli", knowledgeSection: "", request: { ...request, actionId: "action_cli_2" }, restoredMessages: first.messages, revision: localRevision(), skillEnvironmentKeys: [], skillSection: "" });
    expect(second.externalSessionRef).toBe("conversation_1");
    expect(fake.sentTexts).toHaveLength(2);
    expect(fake.sentTexts.every((text) => text.includes("Workbench context") && text.includes("implement the change"))).toBe(true);
    const created = fake.createdOptions.filter((option) => (option as { turns?: string }).turns === "resident");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ backend: "claude", projectKey: "joi:partner_cli", turns: "resident" });
  });

  it("rebuilds through resumeConversation after eviction and falls back to a fresh conversation", async () => {
    const fake = makeFakeSdk();
    const runner = makeRunner(fake.sdk);
    const first = await runner.runResidentTurn({ instanceId: "instance_cli", knowledgeSection: "", request, restoredMessages: null, revision: localRevision(), skillEnvironmentKeys: [], skillSection: "" });
    runner.evictFromMemory("instance_cli");
    const resumed = await runner.runResidentTurn({ ...(first.externalSessionRef === undefined ? {} : { externalSessionRef: first.externalSessionRef }), instanceId: "instance_cli", knowledgeSection: "", request, restoredMessages: first.messages, revision: localRevision(), skillEnvironmentKeys: [], skillSection: "" });
    expect(fake.resumedIds).toEqual(["conversation_1"]);
    expect(resumed.externalSessionRef).toBe("conversation_1");

    const failing = makeFakeSdk({ failResume: true });
    const runner2 = makeRunner(failing.sdk);
    const fresh = await runner2.runResidentTurn({ externalSessionRef: "conversation_gone", instanceId: "instance_other", knowledgeSection: "", request, restoredMessages: null, revision: localRevision(), skillEnvironmentKeys: [], skillSection: "" });
    expect(fresh.externalSessionRef).toBe("conversation_1");
    expect(failing.resumedIds).toEqual(["conversation_gone"]);
  });

  it("rebuilds a warm resident conversation when the Workbench workspace changes", async () => {
    const fake = makeFakeSdk();
    const runner = makeRunner(fake.sdk, { workspacePaths: ["workspace_one", "workspace_two"] });
    await runner.runResidentTurn({ instanceId: "instance_cli", knowledgeSection: "", request, restoredMessages: null, revision: localRevision(), skillEnvironmentKeys: [], skillSection: "" });
    await runner.runResidentTurn({ instanceId: "instance_cli", knowledgeSection: "", request: { ...request, actionId: "action_cli_2" }, restoredMessages: null, revision: localRevision(), skillEnvironmentKeys: [], skillSection: "" });
    const created = fake.createdOptions.filter((option) => (option as { turns?: string }).turns === "resident") as { cwd?: string }[];
    expect(created.map((option) => option.cwd)).toEqual(["workspace_one", "workspace_two"]);
  });

  it("fails closed when the CLI is not detected and exposes the protocol as engine id", async () => {
    const unavailable = makeRunner(makeFakeSdk().sdk, { available: false });
    expect(unavailable.engineOf()).toBe("claude-code");
    await expect(unavailable.runEphemeral(request, localRevision(), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" })).rejects.toMatchObject({ code: "engine_unavailable" });
    await expect(unavailable.runResidentTurn({ instanceId: "i", knowledgeSection: "", request, restoredMessages: null, revision: localRevision(), skillEnvironmentKeys: [], skillSection: "" })).rejects.toMatchObject({ code: "engine_unavailable" });
    await expect(unavailable.health()).resolves.toMatchObject({ available: false });

    const codex = makeRunner(makeFakeSdk().sdk, { protocol: "codex" });
    expect(codex.engineOf()).toBe("codex");
    expect(codex.toolOptions()).toContain("apply_patch");
  });
});
