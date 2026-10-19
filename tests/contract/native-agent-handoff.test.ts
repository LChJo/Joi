/* SDK fixtures use asynchronous protocol streams without external I/O. */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent } from "@openai/codex-sdk";

import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import { ClaudeAgentSdkPartnerEngineRuntime, type ClaudeAgentSdkSurface } from "../../src/main/infrastructure/mana/claude-agent-sdk-partner-engine-runtime.js";
import { CodexAgentSdkPartnerEngineRuntime, type CodexThreadSurface } from "../../src/main/infrastructure/mana/codex-agent-sdk-partner-engine-runtime.js";

const request = { actionId: "action_handoff", workbenchId: "workbench_handoff", contextSnapshotId: "snapshot_handoff", taskProjection: "perform assigned work", workId: "work_handoff" };
const contexts = { loadForExecution: async () => ({ promptSection: "scope", sanitized: {} }) };
const prompts = { read: async () => null };
const context = { instanceId: "instance_handoff", knowledgeSection: "", skillSection: "", skillEnvironmentKeys: [], restoredMessages: null };
const handoff = { version: 1, conclusion: "PRIVATE_HANDOFF_CONCLUSION", requirementIds: ["requirement_1"], evidenceResultIds: ["result_1"], artifactRefs: [], unresolved: ["PRIVATE_UNRESOLVED"], conflicts: [] };

function revision(engine: "claude-code" | "codex") {
  return createPartnerRevision({ capabilities: [], createdAt: "2026-10-19T10:00:00.000Z", displayName: engine, engine, kind: "local-pi", partnerId: `partner_${engine}`,
    partnerRevisionId: `revision_${engine}`, registryRevision: 1, skills: [], toolPolicyMode: "CUSTOM", tools: [],
    codexPermissions: { approvalPolicy: "never", networkAccessEnabled: false, sandboxMode: "read-only", webSearchMode: "disabled" } });
}

describe("native partner completion handoff", () => {
  it.each(["claude-code", "codex"] as const)("preserves %s SDK fallback when a structured completion body is empty", async (engine) => {
    const fallback = "Complete SDK fallback deliverable.\nThe conclusion and limitations remain available.";
    for (const body of ["", "   \n\t"]) {
      const events: unknown[] = [];
      let calls = 0;
      const dependencies = { contexts, prompts, resolveExecutable: () => ({ commandName: engine, executablePath: "test-cli", protocol: engine === "codex" ? "codex" as const : "claude" as const }) };
      const runtime = engine === "claude-code" ? new ClaudeAgentSdkPartnerEngineRuntime({ ...dependencies, sdk: { query: () => {
        calls += 1;
        return (async function* () {
          yield { type: "result", subtype: "success", is_error: false, result: fallback, structured_output: { body, handoff }, session_id: "fallback_session" } as SDKMessage;
        })();
      } } }) : new CodexAgentSdkPartnerEngineRuntime({ ...dependencies, sdk: { create: () => ({ startThread: () => ({ id: "fallback_thread", runStreamed: async () => {
        calls += 1;
        return { events: (async function* () {
          yield { type: "item.completed", item: { id: "deliverable", type: "agent_message", text: fallback } } as ThreadEvent;
          yield { type: "item.completed", item: { id: "completion", type: "agent_message", text: JSON.stringify({ body, handoff }) } } as ThreadEvent;
          yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } } as ThreadEvent;
        })() };
      } }), resumeThread: () => { throw new Error("unexpected_resume"); } }) } });
      const result = await runtime.runResidentTurn({ ...context, request, revision: revision(engine), onEvent: async (event) => { events.push(event); } });
      expect(result.output).toMatchObject({ body: fallback, handoffStatus: "INVALID" });
      expect(result.output.handoff).toBeUndefined();
      expect(calls).toBe(1);
      expect(JSON.stringify({ events, conversation: result.conversation })).not.toMatch(/PRIVATE_HANDOFF_CONCLUSION|PRIVATE_UNRESOLVED/u);
    }
  });

  it.each(["claude-code", "codex"] as const)("keeps the %s health probe outside the completion protocol", async (engine) => {
    let calls = 0;
    const dependencies = { contexts, prompts, resolveExecutable: () => ({ commandName: engine, executablePath: "test-cli", protocol: engine === "codex" ? "codex" as const : "claude" as const }) };
    const runtime = engine === "claude-code" ? new ClaudeAgentSdkPartnerEngineRuntime({ ...dependencies, sdk: { query: (input) => {
      calls += 1;
      expect(input.options?.outputFormat).toBeUndefined();
      return (async function* () { yield { type: "result", subtype: "success", is_error: false, result: "OK", session_id: "probe" } as SDKMessage; })();
    } } }) : new CodexAgentSdkPartnerEngineRuntime({ ...dependencies, sdk: { create: () => ({ startThread: () => ({ id: "probe", runStreamed: async (_prompt, options) => {
      calls += 1;
      expect(options?.outputSchema).toBeUndefined();
      return { events: (async function* () {
        yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "OK" } } as ThreadEvent;
        yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } } as ThreadEvent;
      })() };
    } }), resumeThread: () => { throw new Error("unexpected_resume"); } }) } });
    await expect(runtime.probe()).resolves.toEqual({ available: true });
    expect(calls).toBe(1);
  });

  it.each(["claude-code", "codex"] as const)("preserves %s legacy text and rejects invalid handoffs without rerunning the task", async (engine) => {
    for (const sample of [
      { reply: "Legacy complete deliverable", body: "Legacy complete deliverable", status: "MISSING" },
      { reply: { body: "Full deliverable with an unresolved requirement", handoff: { ...handoff, acceptance: "PASSED" } }, body: "Full deliverable with an unresolved requirement", status: "INVALID" },
      { reply: { handoff }, body: "", status: "INVALID" },
      { reply: '{"handoff":{"conclusion":"PRIVATE_HANDOFF_CONCLUSION"', body: "", status: "INVALID" },
    ]) {
      const reply = sample.reply;
      let calls = 0;
      const events: unknown[] = [];
      const dependencies = { contexts, prompts, resolveExecutable: () => ({ commandName: engine, executablePath: "test-cli", protocol: engine === "codex" ? "codex" as const : "claude" as const }) };
      const text = typeof reply === "string" ? reply : JSON.stringify(reply);
      const runtime = engine === "claude-code" ? new ClaudeAgentSdkPartnerEngineRuntime({ ...dependencies, sdk: { query: () => {
        calls += 1;
        return (async function* () {
          yield { type: "result", subtype: "success", is_error: false, result: text, ...(typeof reply === "string" ? {} : { structured_output: reply }), session_id: "compat_session" } as SDKMessage;
        })();
      } } }) : new CodexAgentSdkPartnerEngineRuntime({ ...dependencies, sdk: { create: () => ({
        startThread: () => ({ id: "compat_thread", runStreamed: async () => {
          calls += 1;
          return { events: (async function* () {
            yield { type: "item.completed", item: { id: "answer", type: "agent_message", text } } as ThreadEvent;
            yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } } as ThreadEvent;
          })() };
        } }), resumeThread: () => { throw new Error("unexpected_resume"); },
      }) } });
      const result = await runtime.runResidentTurn({ ...context, request, revision: revision(engine), onEvent: async (event) => { events.push(event); } });
      expect(calls).toBe(1);
      expect(result.output.body).toBe(sample.body);
      expect(result.output.handoffStatus).toBe(sample.status);
      expect(result.output.handoff).toBeUndefined();
      expect(JSON.stringify(events)).not.toContain("PRIVATE_HANDOFF_CONCLUSION");
      expect(JSON.stringify(events)).not.toContain("PASSED");
    }
  });

  it("allows Claude's intrinsic StructuredOutput completion through the workspace gate", async () => {
    let decision: unknown;
    const sdk: ClaudeAgentSdkSurface = { query: (input) => (async function* () {
      const hook = input.options?.hooks?.PreToolUse?.[0]?.hooks[0];
      decision = await hook?.({ hook_event_name: "PreToolUse", tool_use_id: "completion", tool_name: "StructuredOutput", tool_input: { body: "read-only answer", handoff },
        session_id: "structured_session", transcript_path: "fixture", cwd: "fixture" }, "completion", { signal: new AbortController().signal });
      yield { type: "result", subtype: "success", is_error: false, result: "fallback", structured_output: { body: "read-only answer", handoff }, session_id: "structured_session" } as SDKMessage;
    })() };
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts, prompts, resolveExecutable: () => ({ commandName: "claude", executablePath: "test-claude", protocol: "claude" }), sdk });
    await expect(runtime.runResidentTurn({ ...context, request: { ...request, workspaceExecution: { accessCeiling: "READ", generation: 1, phase: "READ_RUNNING" } }, revision: revision("claude-code") }))
      .resolves.toMatchObject({ output: { body: "read-only answer", handoffStatus: "PROVIDED" } });
    expect(decision).toEqual({ continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
  });

  it("preserves Codex's read-only write protocol while completing a handoff in the same turn", async () => {
    let calls = 0;
    const thread: CodexThreadSurface = { id: "read_only_thread", runStreamed: async (_prompt, options) => {
      calls += 1;
      expect(options?.outputSchema).toMatchObject({ required: ["disposition", "body", "handoff"] });
      return { events: (async function* () {
        yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: JSON.stringify({ disposition: "COMPLETED", body: "Read-only complete output", handoff }) } } as ThreadEvent;
        yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } } as ThreadEvent;
      })() };
    } };
    const runtime = new CodexAgentSdkPartnerEngineRuntime({ contexts, prompts, resolveExecutable: () => ({ commandName: "codex", executablePath: "test-codex", protocol: "codex" }),
      sdk: { create: () => ({ startThread: () => thread, resumeThread: () => thread }) } });
    const result = await runtime.runResidentTurn({ ...context, request: { ...request, workspaceExecution: { accessCeiling: "READ", generation: 1, phase: "READ_RUNNING" } }, revision: revision("codex") });
    expect(result.output).toMatchObject({ body: "Read-only complete output", handoffStatus: "PROVIDED", handoff });
    expect(JSON.stringify(result.conversation)).not.toContain("PRIVATE_HANDOFF_CONCLUSION");
    expect(calls).toBe(1);
  });

  it("captures Claude structured output in the original run while keeping the handoff private", async () => {
    const calls: Parameters<ClaudeAgentSdkSurface["query"]>[0][] = [];
    const body = "COMPLETE_USER_DELIVERABLE ".repeat(600);
    const sdk: ClaudeAgentSdkSurface = { query: (input) => {
      calls.push(input);
      return (async function* () {
        yield { type: "stream_event", session_id: "claude_handoff", event: { type: "content_block_delta", index: 0,
          delta: { type: "text_delta", text: JSON.stringify({ body, handoff }) } } } as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "SDK fallback", structured_output: { body, handoff }, session_id: "claude_handoff" } as SDKMessage;
      })();
    } };
    const events: unknown[] = [];
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts, prompts, resolveExecutable: () => ({ commandName: "claude", executablePath: "test-claude", protocol: "claude" }), sdk });
    const result = await runtime.runResidentTurn({ ...context, request, revision: revision("claude-code"), onEvent: async (event) => { events.push(event); } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.outputFormat).toMatchObject({ type: "json_schema", schema: { required: ["body", "handoff"] } });
    expect(result.output).toMatchObject({ body, handoff, handoffStatus: "PROVIDED" });
    expect(result.externalSessionRef).toBe("native-agent:v1:claude:claude_handoff");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_HANDOFF_CONCLUSION");
    expect(JSON.stringify(result.conversation)).not.toContain("PRIVATE_UNRESOLVED");
    expect(events).toContainEqual({ type: "message", role: "agent", parts: [{ type: "text", text: body }] });
    if (result.externalSessionRef === undefined) throw new Error("native_checkpoint_missing");
    const resumed = await runtime.runResidentTurn({ ...context, externalSessionRef: result.externalSessionRef, request, revision: revision("claude-code") });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.options?.resume).toBe("claude_handoff");
    expect(resumed.output).toMatchObject({ body, handoffStatus: "PROVIDED" });
  });

  it("captures Codex completion body and handoff once without exposing the private JSON envelope", async () => {
    const inputs: { prompt: string; options?: { signal?: AbortSignal; outputSchema?: unknown } }[] = [];
    const resumes: string[] = [];
    const thread: CodexThreadSurface = { id: "codex_handoff", runStreamed: async (prompt, options) => {
      inputs.push({ prompt, ...(options === undefined ? {} : { options }) });
      return { events: (async function* () {
        yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: JSON.stringify({ body: "Full deliverable", handoff }) } } as ThreadEvent;
        yield { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 10, cached_input_tokens: 0 } } as ThreadEvent;
      })() };
    } };
    const events: unknown[] = [];
    const runtime = new CodexAgentSdkPartnerEngineRuntime({ contexts, prompts, resolveExecutable: () => ({ commandName: "codex", executablePath: "test-codex", protocol: "codex" }),
      sdk: { create: () => ({ startThread: () => thread, resumeThread: (id) => { resumes.push(id); return thread; } }) } });
    const result = await runtime.runResidentTurn({ ...context, request, revision: revision("codex"), onEvent: async (event) => { events.push(event); } });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.options?.outputSchema).toMatchObject({ required: ["body", "handoff"] });
    expect(result.output).toMatchObject({ body: "Full deliverable", handoff, handoffStatus: "PROVIDED" });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_HANDOFF_CONCLUSION");
    expect(JSON.stringify(result.conversation)).not.toContain("PRIVATE_UNRESOLVED");
    expect(events).toContainEqual({ type: "message", role: "agent", parts: [{ type: "text", text: "Full deliverable" }] });
    if (result.externalSessionRef === undefined) throw new Error("native_checkpoint_missing");
    const resumed = await runtime.runResidentTurn({ ...context, externalSessionRef: result.externalSessionRef, request, revision: revision("codex") });
    expect(inputs).toHaveLength(2);
    expect(resumes).toEqual(["codex_handoff"]);
    expect(resumed.output).toMatchObject({ body: "Full deliverable", handoffStatus: "PROVIDED" });
  });
});
