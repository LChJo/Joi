/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/require-await */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";

import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import { ClaudeAgentSdkPartnerEngineRuntime, type ClaudeAgentSdkSurface } from "../../src/main/infrastructure/mana/claude-agent-sdk-partner-engine-runtime.js";
import { CodexAgentSdkPartnerEngineRuntime, nestedCodexEnvironment, type CodexAgentSdkSurface, type CodexThreadSurface } from "../../src/main/infrastructure/mana/codex-agent-sdk-partner-engine-runtime.js";

const request = { actionId: "action_native", workbenchId: "workbench", contextSnapshotId: "snapshot", taskProjection: "do work", workId: "work" };
const execution = { loadForExecution: async () => ({ promptSection: "scope", sanitized: {}, workspacePath: "missing-test-workspace" }) };
const prompts = { read: async () => "CUSTOM_SYSTEM" };
const resolvedClaude = () => ({ commandName: "claude", executablePath: "user-claude", protocol: "claude" as const });
const resolvedCodex = () => ({ commandName: "codex", executablePath: "user-codex", protocol: "codex" as const });

function revision(engine: "claude-code" | "codex") {
  return createPartnerRevision({
    capabilities: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    displayName: engine,
    engine,
    engineModelId: engine === "codex" ? "gpt-5.6-sol" : "claude-sonnet",
    kind: "local-pi",
    partnerId: `partner_${engine}`,
    partnerRevisionId: `revision_${engine}`,
    promptRef: "prompt",
    registryRevision: 1,
    skills: [],
    ...(engine === "claude-code" ? { toolPolicyMode: "CUSTOM" as const } : {}),
    tools: engine === "claude-code" ? ["Read"] : [],
    ...(engine === "codex" ? { codexPermissions: { approvalPolicy: "never" as const, networkAccessEnabled: true, sandboxMode: "read-only" as const, webSearchMode: "cached" as const } } : {}),
  });
}

describe("official native Agent SDK adapters", () => {
  it("treats an interrupted tool-capable native run as side-effect unknown", async () => {
    const runtime = new CodexAgentSdkPartnerEngineRuntime({
      contexts: execution,
      environment: { CODEX_API_KEY: "private-key" },
      prompts,
      resolveExecutable: resolvedCodex,
      sdk: {
        create: () => ({
          startThread: () => ({
            id: "interrupted",
            runStreamed: async () => ({ events: (async function* () {
              yield { type: "thread.started", thread_id: "interrupted" } as ThreadEvent;
              throw new Error("connection dropped after remote execution began");
            })() }),
          }),
          resumeThread: () => { throw new Error("unexpected resume"); },
        }),
      },
    });
    const writable = createPartnerRevision({
      ...revision("codex"),
      codexPermissions: { approvalPolicy: "never", networkAccessEnabled: true, sandboxMode: "workspace-write", webSearchMode: "live" },
    });

    await expect(runtime.runEphemeral(request, writable, { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" }))
      .rejects.toMatchObject({ partnerRunFailure: { sideEffectState: "UNKNOWN" } });
  });

  it("maps Claude streaming, tool lifecycle, API-key auth, executable and tagged resume", async () => {
    const calls: { options?: Record<string, unknown>; prompt: string }[] = [];
    const sdk: ClaudeAgentSdkSurface = { query: (input) => {
      calls.push(input as never);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "claude-session" } as SDKMessage;
        yield { type: "stream_event", session_id: "claude-session", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "Read", input: { private: true } } } } as SDKMessage;
        yield { type: "user", session_id: "claude-session", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "PRIVATE_RESULT", is_error: false }] } } as SDKMessage;
        yield { type: "stream_event", session_id: "claude-session", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } } } as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "claude-session" } as SDKMessage;
      })();
    } };
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts: execution, environment: { ANTHROPIC_API_KEY: "private-key" }, prompts, resolveExecutable: resolvedClaude, sdk });
    const events: unknown[] = [];
    const first = await runtime.runResidentTurn({ instanceId: "instance", knowledgeSection: "", onEvent: async (event) => { events.push(event); }, request, restoredMessages: null, revision: revision("claude-code"), skillEnvironmentKeys: [], skillSection: "" });
    expect(first.externalSessionRef).toBe("native-agent:v1:claude:claude-session");
    expect(first.messages).toBeUndefined();
    expect(calls[0]?.options).toMatchObject({ allowedTools: ["Read"], includePartialMessages: true, model: "claude-sonnet", pathToClaudeCodeExecutable: "user-claude", systemPrompt: expect.stringContaining("CUSTOM_SYSTEM"), tools: ["Read"] });
    expect(calls[0]?.options?.systemPrompt).toEqual(expect.stringContaining("Enabled tools: Read"));
    expect(calls[0]?.options?.systemPrompt).toEqual(expect.stringContaining("Disabled tools:"));
    expect((calls[0]?.options as { env?: Record<string, string> }).env?.ANTHROPIC_API_KEY).toBe("private-key");
    expect(events).toEqual(expect.arrayContaining([
      { type: "tool_activity", toolName: "Read", state: "started" },
      { type: "tool_activity", toolName: "Read", state: "completed" },
      { type: "message", role: "agent", parts: [{ type: "text", text: "done" }] },
    ]));
    expect(JSON.stringify(events)).not.toContain("private");

    await runtime.runResidentTurn({ ...(first.externalSessionRef === undefined ? {} : { externalSessionRef: first.externalSessionRef }), instanceId: "instance", knowledgeSection: "", request, restoredMessages: null, revision: revision("claude-code"), skillEnvironmentKeys: [], skillSection: "" });
    expect(calls[1]?.options).toMatchObject({ resume: "claude-session" });
    await runtime.runResidentTurn({ externalSessionRef: "legacy-session", instanceId: "instance", knowledgeSection: "", request, restoredMessages: null, revision: revision("claude-code"), skillEnvironmentKeys: [], skillSection: "" });
    expect(calls[2]?.options).not.toHaveProperty("resume");
  });

  it("requires ANTHROPIC_API_KEY instead of falling back to claude.ai login", async () => {
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts: execution, environment: {}, prompts, resolveExecutable: resolvedClaude, sdk: { query: vi.fn() as never } });
    await expect(runtime.probe()).resolves.toEqual({ available: false, reasonCode: "partner_cli_auth_required" });
  });

  it("passes Codex model and permissions unchanged, starts/resumes threads and strips only nested launcher variables", async () => {
    const clientOptions: CodexOptions[] = [];
    const starts: ThreadOptions[] = [];
    const resumes: { id: string; options?: ThreadOptions }[] = [];
    const makeThread = (id: string): CodexThreadSurface => ({
      id,
      runStreamed: async () => ({ events: (async function* () {
        yield { type: "thread.started", thread_id: id } as ThreadEvent;
        yield { type: "item.started", item: { id: "cmd", type: "command_execution", command: "PRIVATE_COMMAND", aggregated_output: "PRIVATE_RESULT", status: "in_progress" } } as ThreadEvent;
        yield { type: "item.completed", item: { id: "cmd", type: "command_execution", command: "PRIVATE_COMMAND", aggregated_output: "PRIVATE_RESULT", status: "completed", exit_code: 0 } } as ThreadEvent;
        yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "done" } } as ThreadEvent;
        yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } } as ThreadEvent;
      })() }),
    });
    const sdk: CodexAgentSdkSurface = { create: (options) => {
      clientOptions.push(options);
      return {
        startThread: (options) => { starts.push(options ?? {}); return makeThread("thread-new"); },
        resumeThread: (id, options) => { resumes.push({ id, ...(options === undefined ? {} : { options }) }); return makeThread(id); },
      };
    } };
    const runtime = new CodexAgentSdkPartnerEngineRuntime({
      contexts: execution,
      environment: { CODEX_API_KEY: "private-key", CODEX_HOME: "private-home", CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: "private-root", CODEX_SESSION_ID: "nested", PATH: "user-path" },
      prompts, resolveExecutable: resolvedCodex, sdk,
    });
    const events: unknown[] = [];
    const first = await runtime.runResidentTurn({ instanceId: "instance", knowledgeSection: "", onEvent: async (event) => { events.push(event); }, request, restoredMessages: null, revision: revision("codex"), skillEnvironmentKeys: [], skillSection: "" });
    expect(first.externalSessionRef).toBe("native-agent:v1:codex:thread-new");
    expect(starts[0]).toMatchObject({ approvalPolicy: "never", model: "gpt-5.6-sol", networkAccessEnabled: true, sandboxMode: "read-only", webSearchMode: "cached" });
    expect(clientOptions[0]).toMatchObject({ codexPathOverride: "user-codex", config: { developer_instructions: expect.stringContaining("CUSTOM_SYSTEM") }, env: { CODEX_SESSION_ID: "nested", PATH: "user-path" } });
    expect(clientOptions[0]?.config?.developer_instructions).toEqual(expect.stringContaining("Workspace access: read-only"));
    expect(clientOptions[0]?.config?.developer_instructions).toEqual(expect.stringContaining("Network access: enabled"));
    expect(clientOptions[0]?.config?.developer_instructions).toEqual(expect.stringContaining("Web search: cached"));
    expect(JSON.stringify(events)).not.toContain("PRIVATE_COMMAND");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_RESULT");

    await runtime.runResidentTurn({ ...(first.externalSessionRef === undefined ? {} : { externalSessionRef: first.externalSessionRef }), instanceId: "instance", knowledgeSection: "", request, restoredMessages: null, revision: revision("codex"), skillEnvironmentKeys: [], skillSection: "" });
    expect(resumes[0]?.id).toBe("thread-new");
    await runtime.runResidentTurn({ externalSessionRef: "legacy-thread", instanceId: "instance", knowledgeSection: "", request, restoredMessages: null, revision: revision("codex"), skillEnvironmentKeys: [], skillSection: "" });
    expect(starts).toHaveLength(2);
  });

  it("does not rewrite an ordinary Codex environment", () => {
    expect(nestedCodexEnvironment({ CODEX_HOME: "user-home", PATH: "user-path" })).toBeUndefined();
  });
});
