/* Synthetic provider exercises the real Pi session and persisted question service. */
/* eslint-disable @typescript-eslint/require-await */
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import { Type } from "typebox";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import * as sessions from "../../src/main/infrastructure/pi/joi-pi-session.js";
import { UserQuestionService } from "../../src/main/application/joi/user-question-service.js";
import { SqliteUserQuestionStore } from "../../src/main/infrastructure/persistence/sqlite-user-question-store.js";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime.js";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import { DomainError } from "../../src/main/domain/errors.js";
import { ConversationSubagentService } from "../../src/main/application/joi/conversation-subagent-service.js";
import { SqliteConversationStore } from "../../src/main/infrastructure/persistence/sqlite-conversation-store.js";
import { SqliteConversationSubagentStore } from "../../src/main/infrastructure/persistence/sqlite-conversation-subagent-store.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { createJoiSubagentTools } from "../../src/main/infrastructure/pi/joi-subagent-tools.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

const scope = { kind: "CONVERSATION" as const, id: "synthetic-chat" };
const revision = createPartnerRevision({ capabilities: [], createdAt: "2026-11-19T00:00:00Z", displayName: "Synthetic partner", kind: "local-pi", partnerId: "p", partnerRevisionId: "r", registryRevision: 1, skills: [], tools: [] });
const prompt = { question: "Which synthetic route?", options: [{ id: "a", label: "Route A", recommended: true }, { id: "b", label: "Route B" }], multiSelect: false, defaultAnswer: "Route A" };
const request = { actionId: "action", workbenchId: "wb", workId: "turn", contextSnapshotId: "snapshot", taskProjection: "Ask then continue", conversationId: scope.id };
const execution = { knowledgeSection: "", skillSection: "", skillEnvironmentKeys: [] };

function setupRuntime() {
  const faux = fauxProvider({ provider: "pi-durable-question" });
  const models = createModels(); models.setProvider(faux.provider);
  const runtime = new PiPartnerEngineRuntime({
    contexts: { loadForExecution: async () => ({ promptSection: "Synthetic context", sanitized: {} }) }, prompts: { read: async () => null },
    resolver: { resolve: async () => ({ model: faux.getModel(), models, thinkingLevel: "off" }) },
    sources: { selectInitial: async turnId => ({ turnId, modelId: "faux", modelRevisionId: "mr", sourceId: "s", sourceRevisionId: "sr" }) },
    tools: { names: [], create: () => [] },
  });
  return { faux, runtime };
}

describe("Pi durable questions", () => {
  it.each([false, true])("waits for a persisted answer and continues the same tool call (child=%s)", async subagentChild => {
    const fixture = await createRuntimeFixture();
    const service = new UserQuestionService({ store: new SqliteUserQuestionStore(fixture.database), clock: fixture.clock });
    const { faux, runtime } = setupRuntime();
    runtime.setUserQuestions(service);
    const ask = vi.spyOn(service, "ask");
    let completed = false;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("ask_user", prompt, { id: "choose-route" })], { stopReason: "toolUse" }),
      context => {
        expect(context.messages.find(message => message.role === "toolResult" && message.toolCallId === "choose-route")).toMatchObject({
          role: "toolResult", toolCallId: "choose-route", toolName: "ask_user", isError: false,
          content: [{ type: "text", text: "Route B" }], details: { text: "Route B", selectedOptionIds: ["b"], source: "USER" },
        });
        return fauxAssistantMessage([fauxText("Continued using the actual Route B answer")]);
      },
    ]);
    const controller = new AbortController();
    const running = runtime.runEphemeral({ ...request, subagentChild }, revision, execution, { signal: controller.signal });
    void running.then(() => { completed = true; }, () => { completed = true; });
    try {
      await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
      await vi.waitFor(async () => expect((await service.list(scope))[0]?.status).toBe("ACTIVE"));
      expect(completed).toBe(false);
      expect(faux.state.callCount).toBe(1);
      expect(ask.mock.calls[0]?.[0]).toMatchObject({ ...prompt, questionId: "pi-question:turn:choose-route", scope, ownerId: "turn", toolCallId: "choose-route", sourceName: revision.displayName });
      await service.answer(scope, "pi-question:turn:choose-route", { version: 1, selectedOptionIds: ["b"] });
      await expect(running).resolves.toMatchObject({ status: "COMPLETED", output: { body: "Continued using the actual Route B answer" } });
      expect(faux.state.callCount).toBe(2);
      expect((await service.list(scope))[0]?.delivery).toBe("DELIVERED");
    } finally { controller.abort(); await running.catch(() => undefined); service.close(); await fixture.close(); }
  });

  it.each(["signal", "shutdown", "owner", "evict"] as const)("preserves shutdown interruption but cancels explicit %s without recommending an answer", async cancellation => {
    const fixture = await createRuntimeFixture();
    const service = new UserQuestionService({ store: new SqliteUserQuestionStore(fixture.database), clock: fixture.clock });
    const { faux, runtime } = setupRuntime(); runtime.setUserQuestions(service);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_user", prompt, { id: "cancel-me" })], { stopReason: "toolUse" })]);
    const controller = new AbortController();
    const shutdown = new DomainError("conversation_shutdown", "Synthetic application shutdown");
    const ask = vi.spyOn(service, "ask"), cancelQuestion = vi.spyOn(service, "cancelQuestion"), cancelOwner = vi.spyOn(service, "cancelOwner");
    const interrupted = vi.spyOn(service, "interruptOwner");
    const running = runtime.runEphemeral(request, revision, execution, { signal: controller.signal });
    const failed = expect(running).rejects.toBeInstanceOf(Error);
    try {
      await vi.waitFor(async () => expect((await service.list(scope))[0]?.status).toBe("ACTIVE"));
      if (cancellation === "owner") await service.cancelOwner(request.workId);
      else if (cancellation === "evict") runtime.evictFromMemory(`local_pi_ephemeral:${request.actionId}`);
      else if (cancellation === "shutdown") controller.abort(shutdown);
      else controller.abort();
      await failed;
      if (cancellation === "shutdown") {
        expect(ask.mock.calls[0]?.[1]?.reason).toBe(shutdown);
        expect(cancelQuestion).not.toHaveBeenCalled(); expect(cancelOwner).not.toHaveBeenCalled();
        expect(interrupted).toHaveBeenCalledWith(request.workId);
        expect((await service.list(scope))[0]).toMatchObject({ status: "ACTIVE", delivery: "INTERRUPTED" });
      } else {
        expect((await service.list(scope))[0]).toMatchObject({ status: "CANCELED", delivery: "PENDING" });
        fixture.clock.advance(60 * 60_000); expect(await service.expire()).toEqual([]);
      }
      expect((await service.list(scope))[0]?.answer).toBeUndefined();
      expect(faux.state.callCount).toBe(1);
    } finally { controller.abort(); await running.catch(() => undefined); service.close(); await fixture.close(); }
  });

  it.each([false, true])("propagates parent shutdown through a waiting child without treating it as cancel (shutdown=%s)", async shutdown => {
    const fixture = await createRuntimeFixture();
    const questions = new UserQuestionService({ store: new SqliteUserQuestionStore(fixture.database), clock: fixture.clock });
    const { faux, runtime } = setupRuntime(); runtime.setUserQuestions(questions);
    const wb = await fixture.workbenchRegistry.create({ name: "Shutdown fixture", personaSummary: "Help", projectLabel: "Fixture", scopeSummary: "Synthetic child question" });
    const added = await fixture.partners.add({ displayName: "Child fixture", capabilities: [], kind: "local-pi", tools: [], skills: [] });
    const childRevision = await new SqlitePartnerRegistryRepository(fixture.database).getActive(added.partnerId);
    if (childRevision === null) throw new Error("Expected child revision");
    const parentStore = new SqliteConversationStore(fixture.database), childStore = new SqliteConversationSubagentStore(fixture.database);
    await parentStore.submit({ conversationId: scope.id, workbenchId: wb.workbenchId, turnId: "parent", requestId: "parent", text: "Synthetic parent", at: fixture.clock.now().toISOString(), revision: childRevision,
      config: { partnerId: added.partnerId, partnerName: "Child fixture", networkId: "s", networkName: "Synthetic", modelName: "faux", skills: [], attachmentIds: [] } });
    await parentStore.begin("parent");
    const input = { parentTurnId: "parent", revision: childRevision, request: { ...request, actionId: "parent", workId: "parent", workbenchId: wb.workbenchId },
      sourcePin: { turnId: "parent", modelId: "faux", modelRevisionId: "mr", sourceId: "s", sourceRevisionId: "sr" } };
    const children = new ConversationSubagentService({ clock: fixture.clock, ids: fixture.ids, store: childStore,
      execute: async (child, signal) => (await runtime.runEphemeral({ ...child.request, actionId: child.childId, workId: child.childId, subagentChild: true }, child.revision, execution, { signal })).output.body });
    const controller = new AbortController();
    const tools = createJoiSubagentTools(children, input, [], controller.signal);
    const child = await children.start({ ...input, callId: "child", task: "Ask a synthetic question" });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_user", prompt, { id: "waiting-child" })], { stopReason: "toolUse" })]);
    const ask = vi.spyOn(questions, "ask"), cancel = vi.spyOn(children, "cancel");
    const delivery = children.deliver(child.childId);
    const reason = shutdown ? new DomainError("conversation_shutdown", "Synthetic shutdown") : undefined;
    try {
      await vi.waitFor(async () => expect((await questions.list(scope))[0]?.status).toBe("ACTIVE"));
      controller.abort(reason);
      await children.close(reason); await tools.close(true); await delivery;
      expect((await childStore.get(child.childId))?.status).toBe(shutdown ? "INTERRUPTED" : "CANCELED");
      expect((await questions.list(scope))[0]).toMatchObject({ status: shutdown ? "ACTIVE" : "CANCELED", delivery: shutdown ? "INTERRUPTED" : "PENDING" });
      if (shutdown) { expect(ask.mock.calls[0]?.[1]?.reason).toBe(reason); expect(cancel).not.toHaveBeenCalled(); }
      else expect(cancel).toHaveBeenCalled();
      expect(faux.state.callCount).toBe(1);
    } finally { await children.close(reason); await tools.close(true); await delivery; questions.close(); await fixture.close(); }
  });

  it("keeps an answered question recoverable when aborted before the tool result returns", async () => {
    const fixture = await createRuntimeFixture();
    const service = new UserQuestionService({ store: new SqliteUserQuestionStore(fixture.database), clock: fixture.clock });
    const { faux, runtime } = setupRuntime(); runtime.setUserQuestions(service);
    const answerRead = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>();
    const originalAsk = service.ask.bind(service);
    vi.spyOn(service, "ask").mockImplementation(async (input, signal) => {
      const answer = await originalAsk(input, signal);
      answerRead.resolve(undefined); await release.promise; return answer;
    });
    const markDelivered = vi.spyOn(service, "markDelivered");
    faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_user", prompt, { id: "unconsumed" })], { stopReason: "toolUse" })]);
    const controller = new AbortController();
    const running = runtime.runEphemeral(request, revision, execution, { signal: controller.signal });
    const outcome = running.catch((error: unknown) => error);
    try {
      await vi.waitFor(async () => expect((await service.list(scope))[0]?.status).toBe("ACTIVE"));
      await service.answer(scope, "pi-question:turn:unconsumed", { version: 1, selectedOptionIds: ["b"] });
      await answerRead.promise;
      expect((await service.list(scope))[0]).toMatchObject({ status: "ANSWERED", delivery: "PENDING", answer: { text: "Route B" } });
      controller.abort(); release.resolve(undefined); await expect(outcome).resolves.toBeInstanceOf(Error);
      expect((await service.list(scope))[0]).toMatchObject({ status: "ANSWERED", delivery: "INTERRUPTED", answer: { text: "Route B" } });
      expect(markDelivered).not.toHaveBeenCalled(); expect(faux.state.callCount).toBe(1);
    } finally { controller.abort(); release.resolve(undefined); await outcome; service.close(); await fixture.close(); }
  });

  it("settles canonical answer ACK before marking an interrupted owner", async () => {
    const fixture = await createRuntimeFixture();
    const service = new UserQuestionService({ store: new SqliteUserQuestionStore(fixture.database), clock: fixture.clock });
    const { faux, runtime } = setupRuntime(); runtime.setUserQuestions(service);
    const ackStarted = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>();
    const mark = service.markDelivered.bind(service);
    vi.spyOn(service, "markDelivered").mockImplementation(async id => { ackStarted.resolve(undefined); await release.promise; await mark(id); });
    const interrupted = vi.spyOn(service, "interruptOwner");
    faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_user", prompt, { id: "consumed" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "Synthetic nonretryable failure" })]);
    const running = runtime.runEphemeral(request, revision, execution);
    const outcome = running.catch((error: unknown) => error);
    try {
      await vi.waitFor(async () => expect((await service.list(scope))[0]?.status).toBe("ACTIVE"));
      await service.answer(scope, "pi-question:turn:consumed", { version: 1, selectedOptionIds: ["b"] });
      await ackStarted.promise;
      expect(interrupted).not.toHaveBeenCalled();
      expect((await service.list(scope))[0]?.delivery).toBe("PENDING");
      release.resolve(undefined); await expect(outcome).resolves.toBeInstanceOf(Error);
      expect(interrupted).toHaveBeenCalledWith(request.workId);
      expect((await service.list(scope))[0]?.delivery).toBe("DELIVERED");
    } finally { release.resolve(undefined); await outcome; service.close(); await fixture.close(); }
  });

  it("executes two ask_user calls sequentially and receives each answer under its original id", async () => {
    const fixture = await createRuntimeFixture();
    const service = new UserQuestionService({ store: new SqliteUserQuestionStore(fixture.database), clock: fixture.clock });
    const { faux, runtime } = setupRuntime(); runtime.setUserQuestions(service);
    const ask = vi.spyOn(service, "ask");
    faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_user", prompt, { id: "first" }), fauxToolCall("ask_user", prompt, { id: "second" })], { stopReason: "toolUse" }), context => {
      expect(context.messages.filter(message => message.role === "toolResult").map(message => ({ id: message.toolCallId, content: message.content }))).toEqual([
        { id: "first", content: [{ type: "text", text: "Route B" }] }, { id: "second", content: [{ type: "text", text: "[TIMEOUT_DEFAULT: Automatic recommended answer, not a human response or authorization. Continue only within existing permissions; do not bypass required confirmation.]\nRoute A" }] },
      ]);
      return fauxAssistantMessage([fauxText("Both answers received")]);
    }]);
    const running = runtime.runEphemeral(request, revision, execution);
    try {
      await vi.waitFor(async () => expect((await service.list(scope))[0]?.status).toBe("ACTIVE"));
      expect(ask).toHaveBeenCalledOnce();
      await service.answer(scope, "pi-question:turn:first", { version: 1, selectedOptionIds: ["b"] });
      await vi.waitFor(async () => expect((await service.list(scope))[1]?.status).toBe("ACTIVE"));
      expect(ask).toHaveBeenCalledTimes(2); expect(faux.state.callCount).toBe(1);
      fixture.clock.advance(30 * 60_000); await service.expire();
      await expect(running).resolves.toMatchObject({ status: "COMPLETED", output: { body: "Both answers received" } });
      expect((await service.list(scope))[1]?.answer?.source).toBe("TIMEOUT_DEFAULT");
    } finally { await service.cancelOwner(request.workId); await running.catch(() => undefined); service.close(); await fixture.close(); }
  });

  it.each([false, true])("ACKs basic UI only after a canonical work result (abort=%s)", async abort => {
    const fixture = await createRuntimeFixture();
    const service = new UserQuestionService({ store: new SqliteUserQuestionStore(fixture.database), clock: fixture.clock });
    const { faux, runtime } = setupRuntime(); runtime.setUserQuestions(service);
    const returned = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>();
    const extension: ExtensionFactory = pi => {
      pi.registerTool({ name: "basic_ui", label: "Synthetic basic UI", description: "Exercise the real UI binding", parameters: Type.Object({}),
        execute: async (_id, _params, _signal, _update, ctx) => {
          const text = await ctx.ui.input("Synthetic value");
          returned.resolve(undefined); await release.promise;
          return { content: [{ type: "text", text: text ?? "No value" }], details: {} };
        } });
    };
    let session: AgentSession | undefined;
    const create = sessions.createJoiPiSession;
    const factory = vi.spyOn(sessions, "createJoiPiSession").mockImplementation(async (agent, models, cwd, options = {}) => {
      session = await create(agent, models, cwd, { ...options, extensionFactories: [...(options.extensionFactories ?? []), extension] });
      return session;
    });
    const mark = service.markDelivered.bind(service);
    const delivered = vi.spyOn(service, "markDelivered").mockImplementation(async id => {
      expect(session?.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "joi.work_result")).toBe(true);
      await mark(id);
    });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("basic_ui", {}, { id: "ui" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Completed UI")])]);
    const controller = new AbortController();
    const running = runtime.runEphemeral(request, revision, execution, { signal: controller.signal });
    const outcome = running.catch((error: unknown) => error);
    try {
      await vi.waitFor(async () => expect((await service.list(scope))[0]?.status).toBe("ACTIVE"));
      await service.answer(scope, "pi-ui-question:turn:1", { version: 1, text: "Synthetic answer" });
      await returned.promise;
      expect((await service.list(scope))[0]?.delivery).toBe("PENDING"); expect(delivered).not.toHaveBeenCalled();
      if (abort) controller.abort();
      release.resolve(undefined);
      if (abort) {
        await expect(outcome).resolves.toBeInstanceOf(Error);
        expect((await service.list(scope))[0]?.delivery).toBe("INTERRUPTED"); expect(delivered).not.toHaveBeenCalled();
      } else {
        await expect(outcome).resolves.toMatchObject({ status: "COMPLETED" });
        expect((await service.list(scope))[0]?.delivery).toBe("DELIVERED"); expect(delivered).toHaveBeenCalledOnce();
      }
    } finally { controller.abort(); release.resolve(undefined); await outcome; factory.mockRestore(); service.close(); await fixture.close(); }
  });

  it("preserves structured Work questions without awaiting the conversation service", async () => {
    const { faux, runtime } = setupRuntime();
    const questions = { ask: vi.fn(), cancelQuestion: vi.fn(async () => undefined), cancelOwner: vi.fn(async () => undefined), interruptOwner: vi.fn(async () => undefined), markDelivered: vi.fn(async () => undefined) };
    runtime.setUserQuestions(questions);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_user", prompt)], { stopReason: "toolUse" })]);
    const result = await runtime.runEphemeral({ actionId: request.actionId, workbenchId: request.workbenchId, workId: request.workId,
      contextSnapshotId: request.contextSnapshotId, taskProjection: request.taskProjection }, revision, execution);
    expect(result).toMatchObject({ status: "WAITING_INPUT", output: { pendingQuestion: prompt.question, pendingQuestionSpec: prompt } });
    expect(questions.ask).not.toHaveBeenCalled();
  });
});
