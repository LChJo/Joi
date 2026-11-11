/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/require-await */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";

import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import { ClaudeAgentSdkPartnerEngineRuntime, type ClaudeAgentSdkSurface } from "../../src/main/infrastructure/mana/claude-agent-sdk-partner-engine-runtime.js";
import { CodexAgentSdkPartnerEngineRuntime, nestedCodexEnvironment, type CodexAgentSdkSurface, type CodexThreadSurface } from "../../src/main/infrastructure/mana/codex-agent-sdk-partner-engine-runtime.js";
import type { PartnerSessionState } from "../../src/main/application/ports/partner-instances.js";
import type { ConversationThinkingDto } from "../../src/shared/conversations.js";

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
  it.each((["codex","claude-code"] as const).flatMap(engine => (["complete","interrupt","no-start"] as const).map(scenario => ({ engine,scenario }))))("CHAT-29 projects safe $engine thinking during $scenario",async ({ engine,scenario }) => {
    const thoughts: ConversationThinkingDto[] = [],events: unknown[] = [];
    const sdkCodex: CodexAgentSdkSurface = { create: () => {
      const thread: CodexThreadSurface = { id: "thinking-thread",runStreamed: async () => ({ events: (async function* () {
        if (scenario !== "no-start") yield { type: "item.started",item: { type: "reasoning",id: "reasoning",text: "" } } as ThreadEvent;
        if (scenario === "interrupt") throw new Error("Synthetic disconnect");
        yield { type: "item.completed",item: { type: "reasoning",id: "reasoning",text: `token=synthetic-secret ${"公".repeat(2300)}` } } as ThreadEvent;
        yield { type: "item.completed",item: { type: "agent_message",id: "answer",text: "Done" } } as ThreadEvent;
        yield { type: "turn.completed",usage: { input_tokens: 1,output_tokens: 1,cached_input_tokens: 0 } } as ThreadEvent;
      })() }) };return { startThread: () => thread,resumeThread: () => thread };
    } };
    const sdkClaude: ClaudeAgentSdkSurface = { query: () => (async function* () {
      if (scenario === "no-start") yield { type: "assistant",message: { content: [{ type: "thinking",thinking: "RAW_REASONING_PRIVATE",signature: "RAW_SIGNATURE_PRIVATE" }] } } as SDKMessage;
      else {
      yield { type: "stream_event",event: { type: "content_block_start",index: 0,content_block: { type: "thinking",thinking: "RAW_REASONING_PRIVATE",signature: "RAW_SIGNATURE_PRIVATE" } } } as SDKMessage;
      if (scenario === "interrupt") throw new Error("Synthetic disconnect");
      yield { type: "stream_event",event: { type: "content_block_delta",index: 0,delta: { type: "thinking_delta",thinking: "RAW_REASONING_PRIVATE" } } } as SDKMessage;
      yield { type: "stream_event",event: { type: "content_block_stop",index: 0 } } as SDKMessage;
      }
      yield { type: "result",subtype: "success",is_error: false,result: "Done",session_id: "thinking-session" } as SDKMessage;
    })() };
    const runtime = engine === "codex" ? new CodexAgentSdkPartnerEngineRuntime({ contexts: execution,prompts,resolveExecutable: resolvedCodex,sdk: sdkCodex })
      : new ClaudeAgentSdkPartnerEngineRuntime({ contexts: execution,prompts,resolveExecutable: resolvedClaude,sdk: sdkClaude });
    const run = runtime.runResidentTurn({ instanceId: "thinking",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision: revision(engine),restoredMessages: null,
      onThinking: async value => { thoughts.push(value); },onEvent: async value => { events.push(value); },request: { ...request,conversationId: "chat" } });
    if (scenario === "interrupt") await expect(run).rejects.toBeDefined();else await run;
    expect(thoughts.map(value => value.state)).toEqual(scenario === "no-start" ? ["COMPLETED"] : ["STARTED",scenario === "interrupt" ? "INTERRUPTED" : "COMPLETED"]);
    if (scenario === "no-start") expect(thoughts[0]?.durationMs).toBeUndefined();
    else expect(thoughts[1]).toMatchObject({ phaseId: thoughts[0]?.phaseId,durationMs: expect.any(Number) });
    if (engine === "codex" && scenario !== "interrupt") { expect(thoughts.at(-1)?.summary).toHaveLength(2048);expect(thoughts.at(-1)?.summaryTruncated).toBe(true); }
    else expect(thoughts.every(value => value.summary === undefined)).toBe(true);
    expect(JSON.stringify({ thoughts,events })).not.toMatch(/synthetic-secret|RAW_REASONING_PRIVATE|RAW_SIGNATURE_PRIVATE/u);
  });
  it.each(["codex","claude-code"] as const)("CHAT-19 retains %s tool facts and native identity after failure for an explicit next message",async engine => {
    let snapshot: PartnerSessionState | undefined;let resumed: string | undefined;let launches = 0;
    const events: unknown[] = [];
    const sdkCodex: CodexAgentSdkSurface = { create: () => {
      const thread: CodexThreadSurface = { id: "durable-thread",runStreamed: () => Promise.resolve({ events: (async function* () {
        launches++;
        yield { type: "thread.started",thread_id: "durable-thread" } as ThreadEvent;
        if (launches === 1) {
          yield { type: "item.started",item: { id: "tool",type: "command_execution",command: "read fixture",aggregated_output: "",status: "in_progress" } } as ThreadEvent;
          yield { type: "item.completed",item: { id: "tool",type: "command_execution",command: "read fixture",aggregated_output: "PRIVATE_COMPLETE_TOOL_RESULT",exit_code: 0,status: "completed" } } as ThreadEvent;
          yield { type: "turn.failed",error: { message: "synthetic_failure" } } as ThreadEvent;
        } else {
          yield { type: "item.completed",item: { id: "answer",type: "agent_message",text: "Continued" } } as ThreadEvent;
          yield { type: "turn.completed",usage: { input_tokens: 1,output_tokens: 1,cached_input_tokens: 0 } } as ThreadEvent;
        }
      })() }) };
      return { startThread: () => thread,resumeThread: id => { resumed = id;return thread; } };
    } };
    const sdkClaude: ClaudeAgentSdkSurface = { query: input => (async function* () {
      resumed = input.options?.resume;launches++;
      yield { type: "system",subtype: "init",session_id: "durable-session" } as SDKMessage;
      if (launches === 1) {
        yield { type: "assistant",session_id: "durable-session",message: { role: "assistant",content: [{ type: "text",text: "Checked fixture" },{ type: "tool_use",id: "tool",name: "Read",input: { path: "fixture" } }] } } as SDKMessage;
        yield { type: "user",session_id: "durable-session",message: { role: "user",content: [{ type: "tool_result",tool_use_id: "tool",content: "PRIVATE_COMPLETE_TOOL_RESULT",is_error: false }] } } as SDKMessage;
        yield { type: "result",subtype: "error_during_execution",is_error: true,session_id: "durable-session" } as SDKMessage;
      } else yield { type: "result",subtype: "success",is_error: false,result: "Continued",session_id: "durable-session" } as SDKMessage;
    })() };
    const make = () => engine === "codex" ? new CodexAgentSdkPartnerEngineRuntime({ contexts: execution,prompts,resolveExecutable: resolvedCodex,sdk: sdkCodex })
      : new ClaudeAgentSdkPartnerEngineRuntime({ contexts: execution,prompts,resolveExecutable: resolvedClaude,sdk: sdkClaude });
    const input = { instanceId: "first",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision: revision(engine),restoredMessages: null,
      saveSession: async (state: PartnerSessionState) => { snapshot = structuredClone(state); },onEvent: async (event: unknown) => { events.push(event); },
      request: { ...request,conversationId: "chat" } };
    await expect(make().runResidentTurn(input)).rejects.toHaveProperty("partnerRunFailure");
    expect(JSON.stringify(snapshot?.messages).includes("PRIVATE_COMPLETE_TOOL_RESULT")).toBe(true);
    expect(JSON.stringify(events).includes("PRIVATE_COMPLETE_TOOL_RESULT")).toBe(false);
    const stored = snapshot;if (stored?.externalSessionRef === undefined) throw new Error("Missing native session");
    await make().runResidentTurn({ ...input,instanceId: "second",sessionState: stored,externalSessionRef: stored.externalSessionRef,request: { ...request,actionId: "next",taskProjection: "Continue",conversationId: "chat" } });
    expect(resumed).toBe(engine === "codex" ? "durable-thread" : "durable-session");expect(launches).toBe(2);
  });
  it.each(["codex", "claude-code"] as const)("CHAT-18 delivers complete mandatory context to the %s SDK", async engine => {
    const requiredContext = `PERSONA\n${"中文历史要求".repeat(9000)}\nATTACHMENT_REFERENCE_END`;
    let actual: unknown;
    if (engine === "codex") {
      const thread: CodexThreadSurface = { id: "context-thread", runStreamed: async () => ({ events: (async function* () {
        yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "done" } } as ThreadEvent;
        yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } } as ThreadEvent;
      })() }) };
      const runtime = new CodexAgentSdkPartnerEngineRuntime({ contexts: execution, prompts, resolveExecutable: resolvedCodex,
        sdk: { create: options => { actual = options.config?.developer_instructions; return { startThread: () => thread, resumeThread: () => thread }; } } });
      await runtime.runEphemeral({ ...request, requiredContext }, revision(engine), { knowledgeSection: "", skillSection: "", skillEnvironmentKeys: [] });
    } else {
      const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts: execution, prompts, resolveExecutable: resolvedClaude,
        sdk: { query: input => { actual = input.options?.systemPrompt; return (async function* () {
          yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "context-session" } as SDKMessage;
        })(); } } });
      await runtime.runEphemeral({ ...request, requiredContext }, revision(engine), { knowledgeSection: "", skillSection: "", skillEnvironmentKeys: [] });
    }
    expect(actual).toEqual(expect.stringContaining(requiredContext));
  });
  it.each(["corrected", "invalid", "read-ceiling"])("AC-WR-04 bounds protocol correction and honors %s", async scenario => {
    let calls = 0;
    const thread: CodexThreadSurface = { id: "protocol-thread", runStreamed: async () => ({ events: (async function* () {
      calls += 1;
      const text = scenario === "read-ceiling" ? JSON.stringify({ disposition: "WRITE_REQUIRED", body: "" })
        : scenario === "corrected" && calls === 2 ? JSON.stringify({ disposition: "COMPLETED", body: "analysis" }) : "malformed private protocol";
      yield { type: "item.completed", item: { id: "answer", type: "agent_message", text } } as ThreadEvent;
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } } as ThreadEvent;
    })() }) };
    const runtime = new CodexAgentSdkPartnerEngineRuntime({ contexts: execution, prompts, resolveExecutable: resolvedCodex,
      sdk: { create: () => ({ startThread: () => thread, resumeThread: () => { throw new Error("unexpected_resume"); } }) } });
    const events: unknown[] = [];
    const turn = runtime.runResidentTurn({ instanceId: "instance", knowledgeSection: "", skillSection: "", skillEnvironmentKeys: [], restoredMessages: null,
      onEvent: async event => { events.push(event); },
      revision: createPartnerRevision({ ...revision("codex"), codexPermissions: { approvalPolicy: "never", sandboxMode: "workspace-write", networkAccessEnabled: false, webSearchMode: "disabled" } }),
      request: { ...request, workspaceExecution: { accessCeiling: scenario === "read-ceiling" ? "READ" : "WRITE", generation: 1, phase: "READ_RUNNING" } } });
    if (scenario === "corrected") await expect(turn).resolves.toMatchObject({ status: "COMPLETED", output: { body: "analysis", artifacts: [] } });
    else await expect(turn).rejects.toMatchObject({ code: scenario === "invalid" ? "workspace_write_protocol_invalid" : "workspace_write_forbidden" });
    expect(calls).toBe(scenario === "read-ceiling" ? 1 : 2);
    expect(JSON.stringify(events)).not.toContain("malformed private protocol");
    expect(JSON.stringify(events)).not.toContain("WRITE_REQUIRED");
  });
  it("AC-WR-07 Claude hides forbidden tools and rejects an attempted READ-ceiling write", async () => {
    const sdk: ClaudeAgentSdkSurface = { query: input => (async function* () {
      expect(input.options?.tools).not.toContain("Write");
      expect(input.options?.tools).not.toContain("Bash");
      expect(input.options?.systemPrompt).toContain("Work access ceiling: READ");
      const hook = input.options?.hooks?.PreToolUse?.[0]?.hooks[0];
      const decision = await hook?.({ hook_event_name: "PreToolUse",tool_use_id: "tool",tool_name: "Write",tool_input: {},session_id: "read-session",transcript_path: "fixture",cwd: "temporary" },"tool",{ signal: new AbortController().signal });
      expect(decision).toMatchObject({ continue: false,hookSpecificOutput: { permissionDecision: "deny",permissionDecisionReason: "workspace_write_forbidden" } });
      yield { type: "result",subtype: "success",is_error: false,result: "must not complete",session_id: "read-session" } as SDKMessage;
    })() };
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts: execution,prompts,resolveExecutable: resolvedClaude,sdk });
    await expect(runtime.runResidentTurn({ instanceId: "instance",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],restoredMessages: null,
      revision: createPartnerRevision({ ...revision("claude-code"),tools: ["Read","Write","Bash"] }),
      request: { ...request,workspaceExecution: { accessCeiling: "READ",generation: 1,phase: "READ_RUNNING" } } })).rejects.toMatchObject({ code: "workspace_write_forbidden" });
  });

  it("AC-WR-03 Claude gates automatically allowed writes with PreToolUse", async () => {
    let decision: unknown;
    const sdk: ClaudeAgentSdkSurface = { query: input => (async function* () {
      yield { type: "system", subtype: "init", session_id: "write-session" } as SDKMessage;
      const hook = input.options?.hooks?.PreToolUse?.[0]?.hooks[0];
      decision = await hook?.({ hook_event_name: "PreToolUse", tool_use_id: "tool", tool_name: "Write", tool_input: {}, session_id: "write-session", transcript_path: "private", cwd: "temporary" }, "tool", { signal: new AbortController().signal });
      yield { type: "result", subtype: "success", is_error: false, result: "blocked", session_id: "write-session" } as SDKMessage;
    })() };
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts: execution, prompts, resolveExecutable: resolvedClaude, sdk });
    const result = await runtime.runResidentTurn({ instanceId: "instance", knowledgeSection: "", skillSection: "", skillEnvironmentKeys: [], restoredMessages: null,
      revision: createPartnerRevision({ ...revision("claude-code"), tools: ["Read", "Write"] }),
      request: { ...request, workspaceExecution: { accessCeiling: "WRITE", generation: 1, phase: "READ_RUNNING" } } });
    expect(decision).toMatchObject({ continue: false, hookSpecificOutput: { permissionDecision: "deny" } });
    expect(result).toMatchObject({ status: "SUSPENDED", output: { body: "", artifacts: [] }, externalSessionRef: "native-agent:v1:claude:write-session" });
  });
  it("AC-WR-04 Codex uses read-only and retains a structured write request privately", async () => {
    let options: ThreadOptions | undefined;
    const thread: CodexThreadSurface = { id: "write-thread", runStreamed: async () => ({ events: (async function* () {
      yield { type: "thread.started", thread_id: "write-thread" } as ThreadEvent;
      yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: JSON.stringify({ disposition: "WRITE_REQUIRED", body: "" }) } } as ThreadEvent;
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } } as ThreadEvent;
    })() }) };
    const runtime = new CodexAgentSdkPartnerEngineRuntime({ contexts: execution, prompts, resolveExecutable: resolvedCodex,
      sdk: { create: () => ({ startThread: input => { options = input; return thread; }, resumeThread: () => thread }) } });
    const result = await runtime.runResidentTurn({ instanceId: "instance", knowledgeSection: "", skillSection: "", skillEnvironmentKeys: [], restoredMessages: null,
      revision: createPartnerRevision({ ...revision("codex"), codexPermissions: { approvalPolicy: "never", sandboxMode: "workspace-write", networkAccessEnabled: false, webSearchMode: "disabled" } }),
      request: { ...request, workspaceExecution: { accessCeiling: "WRITE", generation: 1, phase: "READ_RUNNING" } } });
    expect(options?.sandboxMode).toBe("read-only");
    expect(result).toMatchObject({ status: "SUSPENDED", output: { body: "", artifacts: [] }, externalSessionRef: "native-agent:v1:codex:write-thread" });
  });
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
    const traces: unknown[] = [];
    const first = await runtime.runResidentTurn({ instanceId: "instance", knowledgeSection: "", onEvent: async (event) => { events.push(event); }, onToolTrace: async (trace) => { traces.push(trace); }, request, restoredMessages: null, revision: revision("claude-code"), skillEnvironmentKeys: [], skillSection: "" });
    expect(first.externalSessionRef).toBe("native-agent:v1:claude:claude-session");
    // The private tool-body channel is pi-only this round; a half-wired adapter would be worse
    // than none, so pin the absence explicitly.
    expect(traces).toHaveLength(0);
    expect(first.messages).toBeUndefined();
    expect(calls[0]?.options).toMatchObject({ allowedTools: ["Read"], includePartialMessages: true, model: "claude-sonnet", pathToClaudeCodeExecutable: "user-claude", systemPrompt: expect.stringContaining("CUSTOM_SYSTEM"), tools: ["Read"] });
    expect(calls[0]?.options?.systemPrompt).toEqual(expect.stringContaining("Enabled tools: Read"));
    expect(calls[0]?.options?.systemPrompt).toEqual(expect.stringContaining("Disabled tools:"));
    expect(calls[0]?.options?.systemPrompt).toEqual(expect.stringContaining("keep code comments clean and clear"));
    expect((calls[0]?.options as { env?: Record<string, string> }).env?.ANTHROPIC_API_KEY).toBe("private-key");
    expect(events).toEqual(expect.arrayContaining([
      // The started frame names what kind of action it is. The label comes from the tool name, not
      // from the arguments: a CLI's arguments are what ADR 0014 keeps inside the infrastructure.
      { type: "tool_activity", toolCallId: "tool-1", toolName: "Read", state: "started", summary: "读取文件" },
      { type: "tool_activity", toolCallId: "tool-1", toolName: "Read", state: "completed" },
      { type: "message", role: "agent", parts: [{ type: "text", text: "done" }] },
    ]));
    // The fixture's arguments and its result are both sentinels; neither may cross, and the label
    // above is why the second assertion is not simply a weaker restatement of the first.
    expect(JSON.stringify(events)).not.toContain("private");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_RESULT");

    await runtime.runResidentTurn({ ...(first.externalSessionRef === undefined ? {} : { externalSessionRef: first.externalSessionRef }), instanceId: "instance", knowledgeSection: "", request, restoredMessages: null, revision: revision("claude-code"), skillEnvironmentKeys: [], skillSection: "" });
    expect(calls[1]?.options).toMatchObject({ resume: "claude-session" });
    await runtime.runResidentTurn({ externalSessionRef: "legacy-session", instanceId: "instance", knowledgeSection: "", request, restoredMessages: null, revision: revision("claude-code"), skillEnvironmentKeys: [], skillSection: "" });
    expect(calls[2]?.options).not.toHaveProperty("resume");
  });

  it("detects an installed Claude without requiring an environment API key or invoking it", async () => {
    const query = vi.fn() as never;
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts: execution, environment: {}, prompts, resolveExecutable: resolvedClaude, sdk: { query } });
    await expect(runtime.health()).resolves.toEqual({ available: true });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([{}, { ANTHROPIC_API_KEY: "" }, { ANTHROPIC_AUTH_TOKEN: "fake-native-token", CLAUDE_CONFIG_DIR: "fake-config" }])("uses native Claude authentication for probes and both run modes: %j", async (environment) => {
    const query = vi.fn((_input: Parameters<ClaudeAgentSdkSurface["query"]>[0]) => (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "OK", session_id: "native-auth" } as SDKMessage;
    })());
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts: execution, environment, prompts, resolveExecutable: resolvedClaude, sdk: { query } });
    await expect(runtime.probe()).resolves.toEqual({ available: true });
    await expect(runtime.runEphemeral(request, revision("claude-code"), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" })).resolves.toMatchObject({ status: "COMPLETED" });
    await expect(runtime.runResidentTurn({ instanceId: "native-auth", request, restoredMessages: null, revision: revision("claude-code"), knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" })).resolves.toMatchObject({ externalSessionRef: "native-agent:v1:claude:native-auth" });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]?.[0].options).toMatchObject({ allowedTools: [], tools: [], permissionMode: "plan", env: environment });
    // Omitted settingSources preserves the installed SDK's native CLI settings defaults.
    expect(query.mock.calls[0]?.[0].options?.settingSources).toBeUndefined();
  });

  it("reports native Claude authentication failures safely after actually probing", async () => {
    const query = vi.fn(() => (async function* () {
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["authentication_failed PRIVATE_CREDENTIAL"] } as SDKMessage;
    })());
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts: execution, environment: {}, prompts, resolveExecutable: resolvedClaude, sdk: { query } });
    await expect(runtime.probe()).resolves.toEqual({ available: false, reasonCode: "partner_cli_auth_required" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("still rejects a missing Claude executable without invoking the SDK", async () => {
    const query = vi.fn() as never;
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts: execution, environment: {}, prompts, resolveExecutable: () => ({ commandName: "claude", protocol: "claude" }), sdk: { query } });
    await expect(runtime.health()).resolves.toMatchObject({ available: false });
    await expect(runtime.probe()).resolves.toEqual({ available: false, reasonCode: "engine_unavailable" });
    expect(query).not.toHaveBeenCalled();
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
    const traces: unknown[] = [];
    const first = await runtime.runResidentTurn({ instanceId: "instance", knowledgeSection: "", onEvent: async (event) => { events.push(event); }, onToolTrace: async (trace) => { traces.push(trace); }, request, restoredMessages: null, revision: revision("codex"), skillEnvironmentKeys: [], skillSection: "" });
    expect(first.externalSessionRef).toBe("native-agent:v1:codex:thread-new");
    expect(starts[0]).toMatchObject({ approvalPolicy: "never", model: "gpt-5.6-sol", networkAccessEnabled: true, sandboxMode: "read-only", webSearchMode: "cached" });
    expect(clientOptions[0]).toMatchObject({ codexPathOverride: "user-codex", config: { developer_instructions: expect.stringContaining("CUSTOM_SYSTEM") }, env: { CODEX_SESSION_ID: "nested", PATH: "user-path" } });
    expect(clientOptions[0]?.config?.developer_instructions).toEqual(expect.stringContaining("Workspace access: read-only"));
    expect(clientOptions[0]?.config?.developer_instructions).toEqual(expect.stringContaining("Network access: enabled"));
    expect(clientOptions[0]?.config?.developer_instructions).toEqual(expect.stringContaining("Web search: cached"));
    expect(clientOptions[0]?.config?.developer_instructions).toEqual(expect.stringContaining("keep code comments clean and clear"));
    expect(JSON.stringify(events)).not.toContain("PRIVATE_COMMAND");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_RESULT");
    expect(traces).toHaveLength(0);

    await runtime.runResidentTurn({ ...(first.externalSessionRef === undefined ? {} : { externalSessionRef: first.externalSessionRef }), instanceId: "instance", knowledgeSection: "", request, restoredMessages: null, revision: revision("codex"), skillEnvironmentKeys: [], skillSection: "" });
    expect(resumes[0]?.id).toBe("thread-new");
    await runtime.runResidentTurn({ externalSessionRef: "legacy-thread", instanceId: "instance", knowledgeSection: "", request, restoredMessages: null, revision: revision("codex"), skillEnvironmentKeys: [], skillSection: "" });
    expect(starts).toHaveLength(2);
  });

  it("does not rewrite an ordinary Codex environment", () => {
    expect(nestedCodexEnvironment({ CODEX_HOME: "user-home", PATH: "user-path" })).toBeUndefined();
  });

  it("terminates a stalled Claude run at the total deadline with a safe timeout failure", async () => {
    const sdk: ClaudeAgentSdkSurface = { query: (input) => {
      const controller = (input.options as { abortController?: AbortController }).abortController;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "stalled" } as SDKMessage;
        await new Promise<void>((_resolve, reject) => {
          if (controller?.signal.aborted === true) reject(new Error("aborted"));
          else controller?.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      })();
    } };
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({
      contexts: execution,
      deadlines: { totalMillis: 40 },
      environment: { ANTHROPIC_API_KEY: "private-key" },
      prompts,
      resolveExecutable: resolvedClaude,
      sdk,
    });
    await expect(runtime.runEphemeral(request, revision("claude-code"), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" }))
      .rejects.toMatchObject({ partnerRunFailure: { phase: "ENGINE", reasonCode: "partner_run_timed_out" } });
  });

  it("terminates an idle Codex run that stops producing events and aborts the signaled thread", async () => {
    const seenSignals: (AbortSignal | undefined)[] = [];
    const sdk: CodexAgentSdkSurface = { create: () => ({
      startThread: () => ({
        id: "idle-thread",
        runStreamed: async (_input, options) => {
          seenSignals.push(options?.signal);
          return { events: (async function* () {
            yield { type: "thread.started", thread_id: "idle-thread" } as ThreadEvent;
            await new Promise<void>((_resolve, reject) => {
              const signal = options?.signal;
              if (signal?.aborted === true) reject(new Error("aborted"));
              else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          })() };
        },
      }),
      resumeThread: () => { throw new Error("unexpected resume"); },
    }) };
    const runtime = new CodexAgentSdkPartnerEngineRuntime({
      contexts: execution,
      deadlines: { idleMillis: 40, totalMillis: 60_000 },
      environment: { CODEX_API_KEY: "private-key" },
      prompts,
      resolveExecutable: resolvedCodex,
      sdk,
    });
    await expect(runtime.runEphemeral(request, revision("codex"), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" }))
      .rejects.toMatchObject({ partnerRunFailure: { phase: "ENGINE", reasonCode: "partner_run_idle_timed_out" } });
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
    expect(seenSignals[0]?.aborted).toBe(true);
  });

  it("propagates an external abort signal into the formal native run", async () => {
    const controller = new AbortController();
    const sdk: ClaudeAgentSdkSurface = { query: (input) => {
      const sdkController = (input.options as { abortController?: AbortController }).abortController;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "aborted" } as SDKMessage;
        await new Promise<void>((_resolve, reject) => {
          if (sdkController?.signal.aborted === true) reject(new Error("aborted"));
          else sdkController?.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      })();
    } };
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({
      contexts: execution,
      environment: { ANTHROPIC_API_KEY: "private-key" },
      prompts,
      resolveExecutable: resolvedClaude,
      sdk,
    });
    const pending = runtime.runEphemeral(request, revision("claude-code"), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});
