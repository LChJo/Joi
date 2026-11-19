import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import { ConversationService } from "../../src/main/application/joi/conversation-service.js";
import { UserQuestionService } from "../../src/main/application/joi/user-question-service.js";
import { PartnerInstanceManager } from "../../src/main/application/partners/partner-instance-manager.js";
import { ConversationHandoff } from "../../src/main/infrastructure/pi/conversation-handoff.js";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime.js";
import { SqliteConversationStore } from "../../src/main/infrastructure/persistence/sqlite-conversation-store.js";
import { SqlitePartnerInstanceMessageStore } from "../../src/main/infrastructure/persistence/sqlite-partner-instance-message-store.js";
import { SqlitePartnerInstanceRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-instance-repository.js";
import { SqlitePartnerPromptStore } from "../../src/main/infrastructure/persistence/sqlite-partner-prompt-store.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqliteUserQuestionStore } from "../../src/main/infrastructure/persistence/sqlite-user-question-store.js";
import { SqliteWorkbenchContextRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-context-repository.js";
import { SqliteWorkbenchWorkspaceRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-workspace-repository.js";
import { createApiHandler } from "../../src/main/interfaces/http/api-handler.js";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners.js";
import type { ConversationDto } from "../../src/shared/conversations.js";
import type { UserQuestionAnswer } from "../../src/shared/user-questions.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

/** Only the model/network catalog is synthetic; dispatch, Pi, storage, auth and HTTP are production objects. */
async function setup() {
  const fixture = await createRuntimeFixture();
  const workbench = await fixture.workbenchRegistry.create({ name: "Question fixture", personaSummary: "Synthetic assistant", projectLabel: "Fixture", scopeSummary: "Synthetic question exercise" });
  await fixture.workbenchWorkspaces.bindExisting(workbench.workbenchId, fixture.root);
  const partner = await fixture.partners.add({ capabilities: [], displayName: "Synthetic Pi partner", kind: "local-pi", skills: [], tools: [], toolPolicyMode: "CUSTOM" });
  const faux = fauxProvider({ provider: "pi-question-http" });
  const models = createModels(); models.setProvider(faux.provider);
  const contexts = new SqliteWorkbenchContextRepository(fixture.database);
  const revisions = new SqlitePartnerRegistryRepository(fixture.database);
  const questions = new UserQuestionService({ store: new SqliteUserQuestionStore(fixture.database), clock: fixture.clock });
  const pin = (turnId: string) => Promise.resolve({ turnId, modelId: "faux", modelRevisionId: "mr", sourceId: "synthetic-network", sourceRevisionId: "sr" });
  const runtime = new PiPartnerEngineRuntime({ contexts, prompts: new SqlitePartnerPromptStore(fixture.database),
    resolver: { resolve: () => Promise.resolve({ model: faux.getModel(), models, thinkingLevel: "off" }) },
    sources: { selectInitial: pin, selectById: (_sourceId, turnId) => pin(turnId) }, tools: { names: [], create: () => [] } });
  runtime.setUserQuestions(questions);
  const instances = new PartnerInstanceManager({ clock: fixture.clock, ids: fixture.ids, engines: new Map([["pi-core", runtime]]),
    knowledge: fixture.knowledge, registry: fixture.partners, revisions, skills: fixture.skills,
    messages: new SqlitePartnerInstanceMessageStore(fixture.database), repository: new SqlitePartnerInstanceRepository(fixture.database) });
  const store = new SqliteConversationStore(fixture.database);
  const conversations = new ConversationService({ clock: fixture.clock, ids: fixture.ids, store, questions, instances,
    handoffs: new ConversationHandoff(), contexts, revisions, workbenches: fixture.workbenches,
    workspaces: new SqliteWorkbenchWorkspaceRepository(fixture.database), skills: fixture.skills,
    networks: { list: () => Promise.resolve([{ sourceId: "synthetic-network", displayName: "Synthetic network", activeModel: { id: "faux" }, status: "READY" }]) },
    inheritance: { read: () => Promise.resolve({ memoryCount: 0, evolutionRevisionId: null, instructions: "" }) } });
  const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, conversations, userQuestions: questions }), loopbackPort: 0 });
  const baseUrl = listeners.loopback.url;
  const nonce = await fixture.auth.issueDesktopBootstrap();
  const authenticated = await fetch(`${baseUrl}/api/v1/auth/bootstrap`, { method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify({ nonce: nonce.nonce }) });
  expect(authenticated.status).toBe(200);
  const cookie = authenticated.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Expected authenticated desktop session");
  const { csrfToken } = await authenticated.json() as { csrfToken: string };
  const headers = { "content-type": "application/json", cookie, origin: "null", "x-csrf-token": csrfToken };
  const get = async (): Promise<ConversationDto> => {
    const response = await fetch(`${baseUrl}/api/v1/conversations/question-chat`, { headers: { cookie } });
    expect(response.status).toBe(200); return await response.json() as ConversationDto;
  };
  return { fixture, faux, questions, conversations, store, baseUrl, headers, get, listeners,
    input: { conversationId: "question-chat", workbenchId: workbench.workbenchId, partnerId: partner.partnerId, networkId: "synthetic-network",
      requestId: "synthetic-send", text: "Ask which synthetic route and continue after the answer.", skills: [], attachmentIds: [] } };
}

describe("Pi question HTTP continuation", () => {
  it.each(["USER", "TIMEOUT_DEFAULT"] as const)("continues the original turn after %s via the durable question queue", async source => {
    const { fixture, faux, questions, conversations, store, baseUrl, headers, get, listeners, input } = await setup();
    let delivery: Promise<void> | undefined;
    let observed: unknown;
    const selected = source === "USER" ? "b" : "a";
    const answerText = source === "USER" ? "Synthetic route B" : "Synthetic route A";
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("ask_user", { question: "Which synthetic route?", options: [
        { id: "a", label: "Synthetic route A", recommended: true }, { id: "b", label: "Synthetic route B" },
      ], multiSelect: false }, { id: "original-question-call" })], { stopReason: "toolUse" }),
      context => {
        observed = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "original-question-call");
        return fauxAssistantMessage([fauxText(`Continued with ${answerText}`)]);
      },
    ]);
    try {
      const submitted = await fetch(`${baseUrl}/api/v1/conversations`, { method: "POST", headers, body: JSON.stringify(input) });
      expect(submitted.status).toBe(202);
      const accepted = await submitted.json() as ConversationDto;
      const turn = accepted.turns[0]; if (turn === undefined) throw new Error("Expected an accepted turn");
      // Run the same delivery entry point the production outbox dispatcher invokes, without replacing dispatch.
      delivery = conversations.deliver(turn.turnId);
      await vi.waitFor(async () => expect((await get()).turns[0]).toMatchObject({ turnId: turn.turnId, status: "RUNNING", waitingForUser: true }), { timeout: 5_000 });
      const waiting = await get();
      const question = waiting.turns[0]?.questions?.[0]; if (question === undefined) throw new Error("Expected a durable HTTP question projection");
      expect(question).toMatchObject({ questionId: `pi-question:${turn.turnId}:original-question-call`, ownerId: turn.turnId, sourceName: "Synthetic Pi partner", status: "ACTIVE", version: 1 });
      expect(faux.state.callCount).toBe(1); expect(observed).toBeUndefined();
      const answerUrl = `${baseUrl}/api/v1/conversations/question-chat/questions/${encodeURIComponent(question.questionId)}/answer`;
      if (source === "USER") {
        const stale = await fetch(answerUrl, { method: "POST", headers, body: JSON.stringify({ version: 2, selectedOptionIds: ["b"] }) });
        expect(stale.ok).toBe(false); expect(await stale.json()).toMatchObject({ code: "question_stale" });
        expect(faux.state.callCount).toBe(1);
        const answered = await fetch(answerUrl, { method: "POST", headers, body: JSON.stringify({ version: question.version, selectedOptionIds: ["b"] }) });
        expect(answered.status).toBe(200);
        expect(await answered.json()).toMatchObject({ questionId: question.questionId, status: "ANSWERED", answer: { text: answerText, selectedOptionIds: [selected], source } });
      } else {
        fixture.clock.advance(30 * 60_000 - 1); expect(await questions.expire()).toEqual([]);
        expect((await get()).turns[0]?.waitingForUser).toBe(true); expect(faux.state.callCount).toBe(1);
        fixture.clock.advance(1); expect(await questions.expire()).toHaveLength(1);
      }
      await delivery;
      expect(observed).toMatchObject({ role: "toolResult", toolCallId: "original-question-call", toolName: "ask_user", isError: false,
        content: [{ type: "text", text: source === "USER" ? answerText : `[TIMEOUT_DEFAULT: Automatic recommended answer, not a human response or authorization. Continue only within existing permissions; do not bypass required confirmation.]\n${answerText}` }],
        details: { text: answerText, selectedOptionIds: [selected], source } satisfies Partial<UserQuestionAnswer> });
      expect(faux.state.callCount).toBe(2);
      const completed = await get();
      expect(completed.turns).toHaveLength(1);
      expect(completed.turns[0]).toMatchObject({ turnId: turn.turnId, status: "COMPLETED", waitingForUser: false,
        questions: [{ questionId: question.questionId, status: "ANSWERED", delivery: "DELIVERED", answer: { source, text: answerText } }] });
      expect(completed.turns[0]?.entries.some(entry => entry.text === `Continued with ${answerText}`)).toBe(true);
      expect((await store.get(input.conversationId))?.turns[0]?.status).toBe("COMPLETED");
      const duplicate = await fetch(answerUrl, { method: "POST", headers, body: JSON.stringify({ version: 1, text: "Do not replay" }) });
      expect(duplicate.ok).toBe(false); expect(await duplicate.json()).toMatchObject({ code: "question_stale" });
      expect(faux.state.callCount).toBe(2);
    } finally {
      conversations.close(); await delivery; questions.close(); await listeners.close(); await fixture.close();
    }
  });
});
