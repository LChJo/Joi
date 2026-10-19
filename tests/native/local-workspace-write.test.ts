/* Native CLIs use a loopback model fixture and disposable homes, never user credentials. */
/* eslint-disable @typescript-eslint/require-await */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { zstdDecompressSync, gunzipSync } from "node:zlib";
import { Codex } from "@openai/codex-sdk";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import { ClaudeAgentSdkPartnerEngineRuntime } from "../../src/main/infrastructure/mana/claude-agent-sdk-partner-engine-runtime.js";
import { CodexAgentSdkPartnerEngineRuntime } from "../../src/main/infrastructure/mana/codex-agent-sdk-partner-engine-runtime.js";
import { resolveLocalCliExecutable } from "../../src/main/infrastructure/mana/local-cli-executable-resolver.js";
import { assertCodexWorkspaceProtocol } from "../../src/main/infrastructure/mana/codex-workspace-capabilities.js";
import { stageWorkEvidence } from "../../src/main/infrastructure/workspace/work-evidence-stager.js";

const enabled = process.env.JOI_NATIVE_WRITE_TESTS === "1";
const nativeToolSmoke = process.env.JOI_NATIVE_TOOL_SMOKE === "1";
const request = { actionId: "native-action", workbenchId: "native-wb", contextSnapshotId: "snapshot", taskProjection: "Analyze input.txt, then produce marker.txt.", workId: "native-work" };
const context = { instanceId: "native-instance", knowledgeSection: "", skillSection: "", skillEnvironmentKeys: [], restoredMessages: null };
const completionHandoff = { version: 1, conclusion: "PRIVATE_NATIVE_HANDOFF", requirementIds: [], evidenceResultIds: [], artifactRefs: [], unresolved: [], conflicts: [] };

function nativeEnvironment(root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    ANTHROPIC_API_KEY: "fixture", JOI_FIXTURE_KEY: "fixture", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
  for (const name of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERNAME", "USERDOMAIN", "COMPUTERNAME"]) if (process.env[name] !== undefined) environment[name] = process.env[name];
  return environment;
}

async function fixture(handler: (body: Record<string, unknown>, response: ServerResponse) => void) {
  // Codex refuses to install writable-sandbox helpers underneath the OS temporary directory.
  const testHomes = path.join(process.env.LOCALAPPDATA ?? path.resolve("test-results"), "joi-native-disposable-tests");
  await mkdir(testHomes, { recursive: true });
  const root = await mkdtemp(path.join(testHomes, "joi-native-write-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace); await mkdir(path.join(root, "codex")); await mkdir(path.join(root, "claude"));
  await writeFile(path.join(workspace, "input.txt"), "initial");
  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on("data", chunk => chunks.push(Buffer.from(chunk as Uint8Array)));
    incoming.on("end", () => {
      let body: Record<string, unknown>;
      try {
        const bytes = Buffer.concat(chunks);
        const encoding = incoming.headers["content-encoding"];
        const decoded = encoding === "zstd" ? zstdDecompressSync(bytes) : encoding === "gzip" ? gunzipSync(bytes) : bytes;
        body = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
      } catch { response.writeHead(404); response.end(); return; }
      handler(body, response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture_server_missing");
  return { root, workspace, url: `http://127.0.0.1:${String(address.port)}`, close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (!path.resolve(root).startsWith(`${testHomes}${path.sep}joi-native-write-`)) throw new Error("native_fixture_cleanup_path_invalid");
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } };
}

function sendSse(response: ServerResponse, events: Record<string, unknown>[]) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of events) response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

function claudeTool(response: ServerResponse, name: string, input: Record<string, unknown>, id = "fixture-tool") {
  sendSse(response, [
    { type: "message_start", message: { id: `fixture-message-${id}`, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

function claudeText(response: ServerResponse) {
  claudeTool(response, "StructuredOutput", { body: "Native continuation complete", handoff: completionHandoff }, "fixture-completion");
}

function codexResponse(response: ServerResponse, item: Record<string, unknown>) {
  const result = { id: `fixture-response-${typeof item.id === "string" ? item.id : "response"}`, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } };
  const events: Record<string, unknown>[] = [
    { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
  ];
  if (item.type === "message") events.push(
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: (item.content as { text: string }[])[0]?.text ?? "" },
  );
  events.push(
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: result },
  );
  sendSse(response, events);
}

describe.skipIf(!enabled)("AC-WR native workspace enforcement", () => {
  it.each(["claude-code", "codex"] as const)("%s CLI delivers a private handoff in the original model turn", async (engine) => {
    let calls = 0;
    let schemaDelivered = false;
    const local = await fixture((body, response) => {
      calls += 1;
      if (engine === "claude-code") {
        const tools = Array.isArray(body.tools) ? body.tools as { name?: string; input_schema?: { required?: string[] } }[] : [];
        const completion = tools.find((tool) => tool.name === "StructuredOutput");
        schemaDelivered ||= completion?.input_schema?.required?.includes("handoff") === true;
        claudeText(response);
      } else {
        const text = body.text as { format?: { schema?: { required?: string[] } } } | undefined;
        schemaDelivered ||= text?.format?.schema?.required?.includes("handoff") === true;
        codexResponse(response, { id: "native-handoff-answer", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: JSON.stringify({ body: "Native continuation complete", handoff: completionHandoff }), annotations: [] }] });
      }
    });
    const environment = { ...nativeEnvironment(local.root), APPDATA: local.root, LOCALAPPDATA: local.root };
    const dependencies = { contexts: { loadForExecution: async () => ({ promptSection: "", sanitized: {}, workspacePath: local.workspace }) },
      prompts: { read: async () => null }, deadlines: { totalMillis: 30_000 } };
    const runtime = engine === "claude-code" ? new ClaudeAgentSdkPartnerEngineRuntime({ ...dependencies, environment: { ...environment, ANTHROPIC_BASE_URL: local.url } })
      : new CodexAgentSdkPartnerEngineRuntime({ ...dependencies, environment, sdk: { create: options => {
        const client = new Codex({ ...options, env: environment, config: { ...options.config, model_provider: "fixture", model_providers: {
          fixture: { name: "Fixture", base_url: `${local.url}/v1`, wire_api: "responses", env_key: "JOI_FIXTURE_KEY", supports_websockets: false },
        } } });
        return { startThread: input => client.startThread(input), resumeThread: (id, input) => client.resumeThread(id, input) };
      } } });
    const revision = createPartnerRevision({ capabilities: [], createdAt: "2026-10-19T00:00:00Z", displayName: "Native handoff", engine,
      engineModelId: engine === "claude-code" ? "claude-sonnet-4-6" : "gpt-5.4", kind: "local-pi", partnerId: "partner", partnerRevisionId: "revision", registryRevision: 1,
      skills: [], tools: [], toolPolicyMode: "CUSTOM", codexPermissions: { approvalPolicy: "never", sandboxMode: "read-only", networkAccessEnabled: false, webSearchMode: "disabled" } });
    const events: unknown[] = [];
    try {
      const result = await runtime.runResidentTurn({ ...context, request, revision, onEvent: async event => { events.push(event); } });
      expect(result.output).toMatchObject({ body: "Native continuation complete", handoffStatus: "PROVIDED", handoff: completionHandoff });
      expect(schemaDelivered).toBe(true);
      expect(calls).toBe(1);
      expect(JSON.stringify(events)).not.toContain("PRIVATE_NATIVE_HANDOFF");
      expect(JSON.stringify(result.conversation)).not.toContain("StructuredOutput");
    } finally { await local.close(); }
  }, 60_000);

  it.for(["claude-code", "codex"] as const)("AC-53 %s reads immutable evidence outside the execution workspace", { timeout: 60_000 }, async (engine, test) => {
    if (engine === "codex" && !nativeToolSmoke) test.skip();
    let calls = 0;
    let indexDelivered = false;
    let observedEvidence = false;
    let cwdReadObserved = false;
    let cwdReadRequested = false;
    let indexReadRequested = false;
    const readIssues = new Set<string>();
    const strings = (value: unknown): string[] => typeof value === "string" ? [value]
      : Array.isArray(value) ? value.flatMap(strings)
        : value !== null && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
    const local = await fixture((body, response) => {
      calls += 1;
      const text = strings(body).join("\n");
      indexDelivered ||= text.includes(indexPath) || text.includes(indexPath.replaceAll("\\", "\\\\"));
      const complete = text.includes("NATIVE_EXTERNAL_EVIDENCE_TAIL");
      const rows = engine === "codex" ? body.input : body.messages;
      const toolOutputs = Array.isArray(rows) ? (rows as unknown[]).flatMap((row: unknown): unknown[] => {
        if (row === null || typeof row !== "object") return [];
        const item = row as Record<string, unknown>;
        if (item.type === "function_call_output") return [item.output];
        return Array.isArray(item.content) ? (item.content as unknown[]).filter(part => part !== null && typeof part === "object" && "type" in part && part.type === "tool_result") : [];
      }) : [];
      const toolText = strings(toolOutputs).join("\n");
      cwdReadObserved ||= toolText.includes("initial");
      for (const marker of ["Permission denied", "permission denied", "does not exist", "No such file", "Unknown tool", "not allowed", "Access is denied", "File has not been read", "outside allowed", "sandbox_unavailable", "CreateProcessAsUserW", "failed", "Error", "sandbox", "sandbox setup", "1314", "failed to initialize"]) {
        if (toolText.includes(marker)) readIssues.add(marker);
      }
      observedEvidence ||= complete;
      if (engine === "claude-code") {
        if (complete || calls > 8) { claudeText(response); return; }
        claudeTool(response, "Read", { file_path: calls === 1 ? indexPath : path.join(path.dirname(indexPath), "result-0.txt") }, `fixture-tool-${String(calls)}`);
        return;
      }
      if (complete || calls > 8 || readIssues.size > 0) {
        codexResponse(response, { id: `answer-${String(calls)}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ body: "Native evidence read", handoff: completionHandoff }), annotations: [] }] });
        return;
      }
      const input = body.input as { type: string; output?: unknown }[];
      const output = input.filter(item => item.type === "function_call_output").at(-1)?.output;
      const last = output === undefined ? "" : typeof output === "string" ? output : JSON.stringify(output);
      const session = /session(?:_id| ID)[^0-9]*(\d+)/iu.exec(last)?.[1];
      if (session !== undefined && !last.includes("Process exited")) {
        codexResponse(response, { type: "function_call", id: `poll-${String(calls)}`, call_id: `poll-${String(calls)}`, name: "write_stdin", arguments: JSON.stringify({ session_id: Number(session), chars: "", yield_time_ms: 1000, max_output_tokens: 500 }) });
        return;
      }
      const target = !cwdReadRequested ? path.join(local.workspace, "input.txt")
        : indexReadRequested ? path.join(path.dirname(indexPath), "result-0.txt") : indexPath;
      if (cwdReadRequested) indexReadRequested = true;
      else cwdReadRequested = true;
      const quoted = process.platform === "win32" ? `'${target.replaceAll("'", "''")}'` : `'${target.replaceAll("'", "'\\''")}'`;
      codexResponse(response, { type: "function_call", id: `read-${String(calls)}`, call_id: `read-${String(calls)}`, name: "exec_command",
        arguments: JSON.stringify({ cmd: process.platform === "win32" ? `Get-Content -LiteralPath ${quoted} -Raw` : `cat ${quoted}`, yield_time_ms: 1000, max_output_tokens: 1000 }) });
    });
    const evidence = { index: "result-0.txt: COMPLETED; PASSED", files: [{ name: "result-0.txt", body: "NATIVE_EXTERNAL_EVIDENCE_TAIL" }], inline: "bounded evidence" };
    const indexPath = (await stageWorkEvidence({ contextSnapshotId: request.contextSnapshotId, evidence, taskDirectory: path.join(local.root, "task-inputs") })).indexPath;
    const dependencies = { contexts: { loadForExecution: async () => ({ evidence, promptSection: `scope\n${evidence.inline}`, sanitized: {}, workspacePath: local.workspace }) },
      evidenceDirectory: path.join(local.root, "task-inputs"), prompts: { read: async () => null }, deadlines: { totalMillis: 30_000 } };
    const environment = { ...nativeEnvironment(local.root), APPDATA: local.root, LOCALAPPDATA: local.root };
    const runtime = engine === "claude-code" ? new ClaudeAgentSdkPartnerEngineRuntime({ ...dependencies, environment: { ...environment, ANTHROPIC_BASE_URL: local.url } })
      : new CodexAgentSdkPartnerEngineRuntime({ ...dependencies, environment, sdk: { create: options => {
        const client = new Codex({ ...options, env: environment, config: { ...options.config, model_provider: "fixture", model_providers: {
          fixture: { name: "Fixture", base_url: `${local.url}/v1`, wire_api: "responses", env_key: "JOI_FIXTURE_KEY", supports_websockets: false },
        } } });
        return { startThread: input => client.startThread(input), resumeThread: (id, input) => client.resumeThread(id, input) };
      } } });
    const revision = createPartnerRevision({ capabilities: [], createdAt: "2026-10-19T00:00:00Z", displayName: "Native evidence", engine,
      engineModelId: engine === "claude-code" ? "claude-sonnet-4-6" : "gpt-5.4", kind: "local-pi", partnerId: "partner", partnerRevisionId: "revision", registryRevision: 1, skills: [], tools: ["Read"], toolPolicyMode: "CUSTOM",
      codexPermissions: { approvalPolicy: "never", sandboxMode: "read-only", networkAccessEnabled: false, webSearchMode: "disabled" } });
    try {
      const result = await runtime.runEphemeral({ ...request, taskProjection: "Read the task's evidence index and result-0.txt, then finish." }, revision, context);
      expect([...readIssues]).toEqual([]);
      if (engine === "codex") expect(cwdReadObserved).toBe(true);
      expect(observedEvidence).toBe(true);
      expect(indexDelivered).toBe(true);
      expect(indexPath.startsWith(local.workspace)).toBe(false);
      expect(result.output.artifacts).toEqual([]);
      expect(calls).toBeGreaterThanOrEqual(3);
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "unknown";
      throw new Error(`native_evidence_${engine}_${code}_requests_${String(calls)}_cwd_${String(cwdReadObserved)}_evidence_${String(observedEvidence)}`, { cause: error });
    } finally { await local.close(); }
  });

  it("Codex CLI advertises schema/resume and actually rejects sandbox writes", async () => {
    const executable = resolveLocalCliExecutable("codex").executablePath;
    if (executable === undefined) throw new Error("native_codex_missing");
    await assertCodexWorkspaceProtocol(executable);
  }, 60_000);

  it.each(["Write", "Bash"])("Claude CLI stops an automatically allowed %s before it writes", async tool => {
    let apiCalls = 0;
    let writing = false;
    let writeTurn = 0;
    const local = await fixture((_body, response) => {
      apiCalls += 1;
      if (writing && writeTurn++ === 0) { claudeTool(response, "Read", { file_path: path.join(local.workspace, "input.txt") }); return; }
      if (writing && writeTurn > 2) { claudeText(response); return; }
      claudeTool(response, tool, tool === "Write" ? { file_path: path.join(local.workspace, "marker.txt"), content: writing ? "fresh" : "blocked" }
        : { command: `echo ${writing ? "fresh" : "blocked"} > marker.txt`, description: "Write fixture" });
    });
    const runtime = new ClaudeAgentSdkPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "", sanitized: {}, workspacePath: local.workspace }) },
      prompts: { read: async () => null }, environment: { ...nativeEnvironment(local.root), ANTHROPIC_BASE_URL: local.url }, deadlines: { totalMillis: 30_000 } });
    const revision = createPartnerRevision({ capabilities: [], createdAt: "2026-10-13T00:00:00Z", displayName: "Native", engine: "claude-code", engineModelId: "claude-sonnet-4-6",
      kind: "local-pi", partnerId: "partner", partnerRevisionId: "revision", registryRevision: 1, skills: [], tools: [tool, "Read"], toolPolicyMode: "CUSTOM" });
    try {
      const result = await runtime.runResidentTurn({ ...context, revision, request: { ...request, workspaceExecution: { accessCeiling: "WRITE", generation: 1, phase: "READ_RUNNING" } } });
      expect(apiCalls).toBeGreaterThan(0);
      expect(result).toMatchObject({ status: "SUSPENDED", output: { body: "", artifacts: [] } });
      expect(result.externalSessionRef).toMatch(/^native-agent:v1:claude:/u);
      await expect(readFile(path.join(local.workspace, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      if (result.externalSessionRef === undefined) throw new Error("native_checkpoint_missing");
      expect(await runtime.checkpointAvailable(result.externalSessionRef)).toBe(true);
      writing = true;
      await writeFile(path.join(local.workspace, "input.txt"), "changed while waiting");
      const resumed = await runtime.runResidentTurn({ ...context, revision, externalSessionRef: result.externalSessionRef,
        request: { ...request, workspaceExecution: { accessCeiling: "WRITE", generation: 2, phase: "WRITE_RUNNING" } } });
      expect(resumed).toMatchObject({ status: "COMPLETED", externalSessionRef: result.externalSessionRef, output: { handoffStatus: "PROVIDED" } });
      expect((await readFile(path.join(local.workspace, "marker.txt"), "utf8")).trim()).toBe("fresh");
      expect(resumed.output.artifacts.map(artifact => artifact.name)).toEqual(["marker.txt"]);
    } finally { await local.close(); }
  }, 60_000);

  it.for([false, true])("Codex CLI retains its thread across the protocol with real write tools %s", { timeout: 60_000 }, async (writeTools, test) => {
    if (writeTools && !nativeToolSmoke) test.skip();
    let calls = 0;
    let writing = false;
    let toolSent = false;
    const local = await fixture((body, response) => {
      calls += 1;
      if (writing && writeTools && !toolSent) {
        toolSent = true;
        const top = body.tools as { type: string; name?: string; tools?: { type: string; name?: string }[] }[];
        const tools = top.flatMap(tool => tool.tools ?? [tool]);
        const tool = tools.find(tool => tool.name === "exec_command");
        if (tool === undefined) { response.writeHead(400); response.end("native_patch_tool_missing"); return; }
        codexResponse(response, { type: "function_call", id: "native-shell", call_id: "native-shell", name: tool.name,
          arguments: JSON.stringify({ cmd: process.platform === "win32" ? "Get-Content input.txt; Set-Content marker.txt fresh" : "cat input.txt; printf fresh > marker.txt", yield_time_ms: 1000, max_output_tokens: 500 }) });
        return;
      }
      if (writing && writeTools) {
        const input = body.input as { type: string; output?: unknown }[];
        const last = input.filter(item => item.type === "function_call_output").at(-1)?.output;
        const output = last === undefined ? "" : typeof last === "string" ? last : JSON.stringify(last);
        const session = /session(?:_id| ID)[^0-9]*(\d+)/iu.exec(output)?.[1];
        if (session !== undefined && !output.includes("Process exited")) {
          codexResponse(response, { type: "function_call", id: `poll-${String(calls)}`, call_id: `poll-${String(calls)}`, name: "write_stdin", arguments: JSON.stringify({ session_id: Number(session), chars: "", yield_time_ms: 1000, max_output_tokens: 500 }) });
          return;
        }
      }
      const text = writing ? JSON.stringify({ body: "Native continuation complete", handoff: completionHandoff }) : JSON.stringify({ disposition: "WRITE_REQUIRED", body: "", handoff: null });
      codexResponse(response, { id: `message-${String(calls)}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
    });
    const environment = { ...nativeEnvironment(local.root), APPDATA: local.root, LOCALAPPDATA: local.root };
    const runtime = new CodexAgentSdkPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "", sanitized: {}, workspacePath: local.workspace }) },
      prompts: { read: async () => null }, environment, deadlines: { totalMillis: 30_000 },
      sdk: { create: options => {
        const client = new Codex({ ...options, env: environment,
          config: { ...options.config, model_provider: "fixture", model_providers: { fixture: { name: "Fixture", base_url: `${local.url}/v1`, wire_api: "responses", env_key: "JOI_FIXTURE_KEY", supports_websockets: false } } } });
        const wrap = (thread: ReturnType<Codex["startThread"]>) => ({ get id() { return thread.id; }, runStreamed: async (prompt: string, turnOptions?: Parameters<typeof thread.runStreamed>[1]) => {
          const streamed = await thread.runStreamed(prompt, turnOptions);
          return streamed;
        } });
        return { startThread: input => wrap(client.startThread(input)), resumeThread: (id, input) => wrap(client.resumeThread(id, input)) };
      } },
    });
    const revision = createPartnerRevision({ capabilities: [], createdAt: "2026-10-13T00:00:00Z", displayName: "Native", engine: "codex", engineModelId: "gpt-5.4",
      kind: "local-pi", partnerId: "partner", partnerRevisionId: "revision", registryRevision: 1, skills: [], tools: [],
      codexPermissions: { approvalPolicy: "never", sandboxMode: "workspace-write", networkAccessEnabled: false, webSearchMode: "disabled" } });
    try {
      const first = await runtime.runResidentTurn({ ...context, revision, request: { ...request, workspaceExecution: { accessCeiling: "WRITE", generation: 1, phase: "READ_RUNNING" } } });
      expect(first.status).toBe("SUSPENDED");
      if (first.externalSessionRef === undefined) throw new Error("native_checkpoint_missing");
      expect(await runtime.checkpointAvailable(first.externalSessionRef)).toBe(true);
      writing = true;
      await writeFile(path.join(local.workspace, "input.txt"), "changed while waiting");
      const next = await runtime.runResidentTurn({ ...context, externalSessionRef: first.externalSessionRef, revision,
        request: { ...request, workspaceExecution: { accessCeiling: "WRITE", generation: 2, phase: "WRITE_RUNNING" } } });
      expect(next).toMatchObject({ status: "COMPLETED", externalSessionRef: first.externalSessionRef, output: { body: "Native continuation complete", handoffStatus: "PROVIDED" } });
      if (writeTools) {
        expect(await readFile(path.join(local.workspace, "marker.txt"), "utf8")).toContain("fresh");
        expect(next.output.artifacts.map(artifact => artifact.name)).toEqual(["marker.txt"]);
        expect(calls).toBeGreaterThanOrEqual(3);
      } else { expect(next.output.artifacts).toEqual([]); expect(calls).toBe(2); }
    } finally { await local.close(); }
  });
});
