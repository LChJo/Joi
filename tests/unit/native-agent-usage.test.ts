/* Native SDK fixtures intentionally provide asynchronous streams without I/O. */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion, require-yield */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent } from "@openai/codex-sdk";

import type { UsageContext, UsageObservation, UsageRecorder, UsageSession } from "../../src/main/application/ports/usage.js";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import {
  ClaudeAgentSdkPartnerEngineRuntime,
  type ClaudeAgentSdkSurface,
} from "../../src/main/infrastructure/mana/claude-agent-sdk-partner-engine-runtime.js";
import {
  CodexAgentSdkPartnerEngineRuntime,
  type CodexAgentSdkSurface,
} from "../../src/main/infrastructure/mana/codex-agent-sdk-partner-engine-runtime.js";

class RecordingUsageRecorder implements UsageRecorder {
  readonly sessions: { context: UsageContext; observations: UsageObservation[]; statuses: string[] }[] = [];
  begin(context: UsageContext): UsageSession {
    const captured = { context, observations: [] as UsageObservation[], statuses: [] as string[] };
    this.sessions.push(captured);
    return { id: `native-${String(this.sessions.length)}`, record: (value) => { captured.observations.push(value); }, finish: (status) => { captured.statuses.push(status); } };
  }
}

const request = { actionId: "action-1", workbenchId: "wb-1", contextSnapshotId: "context-1", taskProjection: "fixture", workId: "work-1" };
const contexts = { loadForExecution: () => Promise.resolve({ promptSection: "", sanitized: {} }) };
const prompts = { read: async () => null };
const executable = () => ({ commandName: "test", executablePath: "test-cli", protocol: "codex" as const });

function revision(engine: "claude-code" | "codex") {
  return createPartnerRevision({
    capabilities: [], createdAt: "2026-09-22T00:00:00.000Z", displayName: engine, engine,
    engineModelId: engine === "codex" ? "gpt-test" : "claude-test", kind: "local-pi",
    partnerId: `partner-${engine}`, partnerRevisionId: `revision-${engine}`, registryRevision: 1,
    skills: [], toolPolicyMode: "CUSTOM", tools: [],
  });
}

function codexSdk(events: () => AsyncIterable<ThreadEvent>): CodexAgentSdkSurface {
  return { create: () => ({
    startThread: () => ({ id: "thread-1", runStreamed: async () => ({ events: events() }) }),
    resumeThread: () => { throw new Error("unexpected resume"); },
  }) };
}

function claudeUsage(inputTokens: number, outputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number) {
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests: 0, costUSD: 0, contextWindow: 1000, maxOutputTokens: 100 };
}

describe("native SDK usage capture", () => {
  it("replaces duplicate Codex cumulative snapshots without adding cached input or reasoning twice", async () => {
    const usage = new RecordingUsageRecorder();
    const sdk = codexSdk(() => (async function* () {
      yield { type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 5, cache_write_input_tokens: 1, output_tokens: 8, reasoning_output_tokens: 3 } } as ThreadEvent;
      yield { type: "turn.completed", usage: { input_tokens: 24, cached_input_tokens: 7, cache_write_input_tokens: 2, output_tokens: 10, reasoning_output_tokens: 4 } } as ThreadEvent;
    })());
    const runtime = new CodexAgentSdkPartnerEngineRuntime({ contexts, prompts, resolveExecutable: executable, sdk, usage });

    await expect(runtime.runEphemeral(request, revision("codex"), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" })).resolves.toMatchObject({ status: "COMPLETED" });

    expect(usage.sessions).toHaveLength(1);
    expect(usage.sessions[0]?.context).toMatchObject({ engine: "codex", purpose: "partner", workbenchId: "wb-1", workId: "work-1", partnerId: "partner-codex", modelId: "gpt-test" });
    expect(usage.sessions[0]?.observations.map((entry) => entry.key)).toEqual(["model:gpt-test", "model:gpt-test"]);
    expect(usage.sessions[0]?.observations.at(-1)?.tokens).toEqual({ input: 24, output: 10, cacheRead: 7, cacheWrite: 2, reasoning: 4 });
    expect(usage.sessions[0]?.statuses).toEqual(["completed"]);
  });

  it("records Codex measured usage before failure and finishes an aborted turn as canceled", async () => {
    const failureUsage = new RecordingUsageRecorder();
    const failed = new CodexAgentSdkPartnerEngineRuntime({
      contexts, prompts, resolveExecutable: executable, usage: failureUsage,
      sdk: codexSdk(() => (async function* () {
        yield { type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1 } } as ThreadEvent;
        yield { type: "turn.failed", error: { message: "fixture" } } as ThreadEvent;
      })()),
    });
    await expect(failed.runEphemeral(request, revision("codex"), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" })).rejects.toBeDefined();
    expect(failureUsage.sessions[0]?.observations).toHaveLength(1);
    expect(failureUsage.sessions[0]?.statuses).toEqual(["failed"]);

    const canceledUsage = new RecordingUsageRecorder();
    const canceled = new CodexAgentSdkPartnerEngineRuntime({
      contexts, prompts, resolveExecutable: executable, usage: canceledUsage,
      sdk: codexSdk(() => (async function* () { throw new DOMException("aborted", "AbortError"); })()),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(canceled.runEphemeral(request, revision("codex"), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" }, { signal: controller.signal })).rejects.toBeDefined();
    expect(canceledUsage.sessions[0]?.observations).toEqual([{ key: "model:gpt-test", modelId: "gpt-test", sourceName: "Codex", tokens: null }]);
    expect(canceledUsage.sessions[0]?.statuses).toEqual(["canceled"]);
  });

  it("replaces Claude cumulative result snapshots per model and keeps unknown reasoning null", async () => {
    const usage = new RecordingUsageRecorder();
    const sdk: ClaudeAgentSdkSurface = { query: () => (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "partial", session_id: "session-1", modelUsage: {
        "claude-a": claudeUsage(10, 4, 2, 1),
        "claude-b": claudeUsage(5, 3, 0, 2),
      } } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "session-1", modelUsage: {
        "claude-a": claudeUsage(14, 6, 3, 1),
        "claude-b": claudeUsage(8, 4, 1, 2),
      } } as unknown as SDKMessage;
    })() };
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts, prompts, resolveExecutable: executable, sdk, usage });

    await expect(runtime.runEphemeral(request, revision("claude-code"), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" })).resolves.toMatchObject({ status: "COMPLETED" });

    expect(usage.sessions).toHaveLength(1);
    expect(usage.sessions[0]?.observations.map((entry) => entry.key)).toEqual([
      "model:claude-a", "model:claude-b", "model:claude-a", "model:claude-b",
    ]);
    expect(usage.sessions[0]?.observations.at(-2)).toMatchObject({
      modelId: "claude-a", sourceName: "Claude Code", tokens: { input: 18, output: 6, cacheRead: 3, cacheWrite: 1, reasoning: null },
    });
    expect(usage.sessions[0]?.statuses).toEqual(["completed"]);
  });

  it("records Claude error results before throwing and leaves an unknown default model name absent", async () => {
    const usage = new RecordingUsageRecorder();
    const sdk: ClaudeAgentSdkSurface = { query: () => (async function* () {
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["fixture"], modelUsage: {} } as SDKMessage;
    })() };
    const noModel = revision("claude-code");
    delete noModel.engineModelId;
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts, prompts, resolveExecutable: executable, sdk, usage });

    await expect(runtime.runEphemeral(request, noModel, { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" })).rejects.toBeDefined();

    expect(usage.sessions[0]?.context.modelId).toBeUndefined();
    expect(usage.sessions[0]?.observations).toEqual([{ key: "result", sourceName: "Claude Code", tokens: null }]);
    expect(usage.sessions[0]?.statuses).toEqual(["failed"]);
  });

  it("captures native probes as separate probe sessions", async () => {
    const codexUsage = new RecordingUsageRecorder();
    const codex = new CodexAgentSdkPartnerEngineRuntime({
      contexts, prompts, resolveExecutable: executable, usage: codexUsage,
      sdk: codexSdk(() => (async function* () {
        yield { type: "turn.completed", usage: { input_tokens: 2, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } } as ThreadEvent;
      })()),
    });
    await expect(codex.probe()).resolves.toEqual({ available: true });
    expect(codexUsage.sessions[0]?.context).toEqual({ engine: "codex", purpose: "probe", sourceName: "Codex" });
  });

  it.each(["codex", "claude-code"] as const)("records %s internal deadlines as failed instead of user cancellation", async (engine) => {
    for (const probe of [false, true]) {
      const usage = new RecordingUsageRecorder();
      const stalled = async function* (signal: AbortSignal | undefined) {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new DOMException("aborted", "AbortError");
      };
      const dependencies = { contexts, prompts, resolveExecutable: executable, usage, deadlines: { totalMillis: 5 }, probeTimeoutMillis: 5 };
      const runtime = engine === "codex"
        ? new CodexAgentSdkPartnerEngineRuntime({ ...dependencies, sdk: { create: () => ({ startThread: () => ({ id: null, runStreamed: (_prompt, options) => Promise.resolve({ events: stalled(options?.signal) }) }), resumeThread: () => { throw new Error("unused"); } }) } })
        : new ClaudeAgentSdkPartnerEngineRuntime({ ...dependencies, sdk: { query: (input) => stalled(input.options?.abortController?.signal) } });
      if (probe) await expect(runtime.probe()).resolves.toMatchObject({ available: false });
      else await expect(runtime.runEphemeral(request, revision(engine), { knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "" })).rejects.toBeDefined();
      expect(usage.sessions[0]?.statuses).toEqual(["failed"]);
    }
  });
});
