import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiNativeSessionStore } from "../../src/main/infrastructure/pi/pi-native-session-store.js";
import { ConversationHandoff } from "../../src/main/infrastructure/pi/conversation-handoff.js";
import { createJoiPiSession } from "../../src/main/infrastructure/pi/joi-pi-session.js";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { UsageContext, UsageRecorder } from "../../src/main/application/ports/usage.js";

it("PI-SESSION-15 resumes persisted usage progress without rewriting acknowledged historical entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"joi-pi-usage-cursor-"));
  const observed: UsageContext[] = [];
  const recorder: UsageRecorder = { begin(context,identity) {
    observed.push(context);
    return { id: identity?.id ?? "unexpected",record: () => undefined,finish: () => undefined,isRecorded: () => true };
  } };
  try {
    const native = await new PiNativeSessionStore(root).open({ identity: ["partner","wb","p","i"],cwd: root });
    native.manager.appendCustomEntry("joi.usage_context",{ engine: "pi",purpose: "partner",workbenchId: "wb",workId: "first" });
    const answer = fauxAssistantMessage("Answer");native.manager.appendMessage(answer);
    await new PiNativeSessionStore(root).reconcileUsage(recorder);
    expect(observed).toHaveLength(1);
    await new PiNativeSessionStore(root).reconcileUsage(recorder);
    expect(observed).toHaveLength(1);
    native.manager.appendCustomEntry("joi.usage_idle",{});
    native.manager.appendUsage("cache_warm",answer.provider,answer.model,answer.usage);
    await new PiNativeSessionStore(root).reconcileUsage(recorder);
    expect(observed).toHaveLength(2);
    expect(observed[1]).toMatchObject({ purpose: "cache_warming",workbenchId: "wb" });
    expect(observed[1]?.workId).toBeUndefined();
  } finally { await rm(root,{ recursive: true,force: true }); }
});

it("PI-SESSION-15 retries unacknowledged usage after restart before advancing its durable cursor", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"joi-pi-usage-retry-"));
  const attempts: string[] = [];let recorded = false;
  const recorder: UsageRecorder = { begin(_context,identity) {
    if (identity === undefined) throw new Error("Missing identity");attempts.push(identity.id);
    return { id: identity.id,record: () => undefined,finish: () => undefined,isRecorded: () => recorded };
  } };
  try {
    const native = await new PiNativeSessionStore(root).open({ identity: ["partner","wb","p","i"],cwd: root });
    native.manager.appendCustomEntry("joi.usage_context",{ engine: "pi",purpose: "partner",workId: "work" });
    native.manager.appendMessage(fauxAssistantMessage("First"));
    native.manager.appendMessage(fauxAssistantMessage("Second"));
    await new PiNativeSessionStore(root).reconcileUsage(recorder);expect(attempts).toHaveLength(1);
    recorded = true;
    await new PiNativeSessionStore(root).reconcileUsage(recorder);expect(attempts).toHaveLength(3);
    expect(attempts[1]).toBe(attempts[0]);expect(attempts[2]).not.toBe(attempts[0]);
    await new PiNativeSessionStore(root).reconcileUsage(recorder);expect(attempts).toHaveLength(3);
    await writeFile(path.join(root,native.reference().key,"usage-cursor.json"),"damaged");
    const degraded = vi.fn();await new PiNativeSessionStore(root).reconcileUsage(recorder,degraded);
    expect(degraded).toHaveBeenCalledOnce();expect(attempts.slice(3)).toEqual(attempts.slice(1,3));
  } finally { await rm(root,{ recursive: true,force: true }); }
});

it("PI-SESSION-21 preserves the official parent session relationship on a successor", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"joi-pi-parent-")),store = new PiNativeSessionStore(root);
  try {
    const first = await store.open({ identity: ["conversation","wb","chat","A1"],cwd: root,state: { engine: "pi-core",messages: [{ role: "user",content: "Source fact",timestamp: 1 }] } });
    const second = await store.open({ identity: ["conversation","wb","chat","B1"],cwd: root,state: { engine: "pi-core",messages: [],handoff: { sourceSegmentId: "A1",sourcePiSession: first.reference() } } });
    expect(second.manager.getHeader()?.parentSession).toBe(first.manager.getSessionFile());
    expect(second.manager.getSessionId()).not.toBe(first.manager.getSessionId());
    const restored = await store.open({ identity: ["conversation","wb","chat","B1"],cwd: root,state: { engine: "pi-core",messages: [],piNativeSession: second.reference() } });
    expect(restored.manager.getSessionId()).toBe(second.manager.getSessionId());
  } finally { await rm(root,{ recursive: true,force: true }); }
});

it("CHAT-48 serializes the exact Pi turn from a segment with later private messages", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"joi-pi-fork-")),store = new PiNativeSessionStore(root);
  try {
    const identity = ["conversation","wb","chat","segment"];
    const source = await store.open({ identity,cwd: root });
    source.manager.appendMessage({ role: "user",content: "Selected private context",timestamp: 1 });
    source.manager.appendMessage(fauxAssistantMessage("Selected answer"));
    source.manager.appendCustomEntry("joi.work_result",{ actionId: "selected" });
    source.manager.appendMessage({ role: "user",content: "Later private context",timestamp: 2 });
    source.manager.appendMessage(fauxAssistantMessage("Later answer"));
    source.manager.appendCustomEntry("joi.work_result",{ actionId: "later" });
    const exact = await new ConversationHandoff(store).build({ conversationId: "chat",workbenchId: "wb",history: [],fork: { turnId: "selected" },
      source: { segmentId: "segment",engine: "pi-core",partnerId: "p",capabilityKey: "p",state: { engine: "pi-core",messages: [],piNativeSession: source.reference() } },
    });
    expect(JSON.stringify(exact.messages)).toContain("Selected private context");
    expect(JSON.stringify(exact.messages)).toContain("Selected answer");
    expect(JSON.stringify(exact.messages)).not.toContain("Later private context");
    expect(exact).not.toHaveProperty("piNativeSession");
    expect((await store.readContext(identity))?.manager.getLeafId()).toBe(source.manager.getLeafId());
  } finally { await rm(root,{ recursive: true,force: true }); }
});

it("PI-SESSION-05/16 reads the imported selected branch when its projection is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"joi-pi-source-branch-")),store = new PiNativeSessionStore(root),identity = ["conversation","wb","chat","source"];
  const manager = SessionManager.inMemory(root);
  const task = manager.appendMessage({ role: "user",content: "Task",timestamp: 1 });
  const selected = manager.appendMessage(fauxAssistantMessage([fauxText("SELECTED_SOURCE_FACT")]));
  manager.branch(task);manager.appendMessage(fauxAssistantMessage([fauxText("ABANDONED_SOURCE_BRANCH")]));manager.branch(selected);
  try {
    await store.open({ identity,cwd: root,state: { engine: "pi-core",messages: [],piSession: { version: 1,header: manager.getHeader(),entries: manager.getEntries(),leafId: selected } } });
    const source = await store.readContext(identity);
    expect(source?.manager.getLeafId()).toBe(selected);
    const context = JSON.stringify(source?.manager.buildSessionContext().messages);
    expect(context).toContain("SELECTED_SOURCE_FACT");expect(context).not.toContain("ABANDONED_SOURCE_BRANCH");
  } finally { await rm(root,{ recursive: true,force: true }); }
});

it("PI-SESSION-16 preserves audit checkpoints and incomplete calls without sending or replaying them", async () => {
  const models = createModels(), faux = fauxProvider({ provider: "audit-history" }); models.setProvider(faux.provider);
  const manager = SessionManager.inMemory();
  const checkpoint = manager.appendMessage({ role: "user", content: "The conversation history before this point was compacted into the following summary:\n\n<summary>\n[joi session checkpoint]\nOBSOLETE_JOI_SUMMARY\n</summary>", timestamp: 1 });
  manager.appendMessage({ role: "user", content: "Explain the literal [joi session checkpoint] marker.", timestamp: 2 });
  manager.appendMessage(fauxAssistantMessage([fauxToolCall("write", { path: "unknown" })], { stopReason: "toolUse" }));
  let sent = "";
  faux.setResponses([context => { sent = JSON.stringify(context); return fauxAssistantMessage([fauxText("Inspected independently")]); }]);
  const session = await createJoiPiSession({ state: { model: faux.getModel(), systemPrompt: "Policy", thinkingLevel: "off", tools: [], messages: [] } }, models, process.cwd(), { sessionManager: manager });
  try {
    await session.prompt("New authorized task"); await session.waitForIdle();
    expect(sent).not.toContain("OBSOLETE_JOI_SUMMARY");
    expect(sent).toContain("Explain the literal [joi session checkpoint] marker.");
    expect(sent).toContain("effect unknown");
    expect(manager.getEntry(checkpoint)).toMatchObject({ type: "message", message: { content: expect.stringContaining("OBSOLETE_JOI_SUMMARY") as unknown } });
    expect(faux.state.callCount).toBe(1);
  } finally { session.dispose(); }
});

it("PI-SESSION-16 refuses changed migration input after an interrupted import", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "joi-pi-import-conflict-"));
  const identity = ["partner", "wb", "p", "i"];
  const directory = path.join(root, createHash("sha256").update(JSON.stringify(identity)).digest("hex"));
  try {
    await mkdir(directory); await writeFile(path.join(directory, "legacy-source.json"), JSON.stringify({ original: true }));
    await expect(new PiNativeSessionStore(root).open({ identity, cwd: root, state: { engine: "pi-core", messages: [] } })).rejects.toMatchObject({ code: "pi_session_migration_conflict" });
    expect(await readFile(path.join(directory, "legacy-source.json"), "utf8")).toBe(JSON.stringify({ original: true }));
  } finally { await rm(root, { force: true, recursive: true }); }
});

it("PI-SESSION-16 imports messages atomically with a completed fingerprinted migration record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "joi-pi-message-import-"));
  try {
    const identity = ["primary", "wb", "legacy"], store = new PiNativeSessionStore(root);
    const state = { engine: "pi-core" as const, messages: [{ role: "user", content: "Original task", timestamp: 1 }, fauxAssistantMessage("Original answer")] };
    const imported = await store.open({ identity, cwd: root, state });
    const metadata = JSON.parse(await readFile(path.join(root, imported.reference().key, "migration.json"), "utf8")) as unknown;
    expect(metadata).toMatchObject({ status: "completed", targetSessionId: imported.manager.getSessionId(), sourceHash: createHash("sha256").update(JSON.stringify(state)).digest("hex") });
    const restored = await store.open({ identity, cwd: root, state });
    expect(restored.manager.getEntries()).toEqual(imported.manager.getEntries());
  } finally { await rm(root, { force: true, recursive: true }); }
});

it("PI-SESSION-05/17 isolates same-cwd identities and fails closed on missing or corrupt native history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "joi-pi-isolation-"));
  try {
    const store = new PiNativeSessionStore(root), identity = ["conversation", "first", "chat"];
    const first = await store.open({ identity, cwd: root });
    first.manager.appendMessage({ role: "user", content: "FIRST_PRIVATE_SCOPE", timestamp: 1 });
    first.manager.appendMessage(fauxAssistantMessage("answer"));
    const state = { engine: "pi-core" as const, messages: [], piNativeSession: first.reference() };
    const second = await store.open({ identity: ["conversation", "second", "chat"], cwd: root });
    expect(JSON.stringify(second.manager.buildSessionContext())).not.toContain("FIRST_PRIVATE_SCOPE");
    await expect(store.open({ identity: ["conversation", "second", "chat"], cwd: root, state })).rejects.toMatchObject({ code: "pi_session_identity_mismatch" });
    const file = first.manager.getSessionFile(); if (file === undefined) throw new Error("Expected native file");
    await writeFile(file, "damaged");
    await expect(store.open({ identity, cwd: root, state })).rejects.toMatchObject({ code: "pi_session_restore_failed" });
    await rm(file);
    await expect(store.open({ identity, cwd: root, state })).rejects.toMatchObject({ code: "pi_session_missing" });
  } finally { await rm(root, { force: true, recursive: true }); }
});
