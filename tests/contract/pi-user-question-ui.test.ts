import { Type } from "typebox";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { createJoiPiSession } from "../../src/main/infrastructure/pi/joi-pi-session.js";
import { createPiUserQuestionUI } from "../../src/main/infrastructure/pi/pi-user-question-ui.js";
import { UserQuestionService } from "../../src/main/application/joi/user-question-service.js";
import { SqliteUserQuestionStore } from "../../src/main/infrastructure/persistence/sqlite-user-question-store.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

const owner = { ownerId: "ui-turn", scope: { kind: "CONVERSATION" as const, id: "ui-chat" }, sourceName: "Synthetic extension" };

async function setup() {
  const fixture = await createRuntimeFixture();
  const service = new UserQuestionService({ store: new SqliteUserQuestionStore(fixture.database), clock: fixture.clock });
  return { fixture, service, ui: createPiUserQuestionUI(service, owner) };
}

describe("Pi official extension UI binding", () => {
  it("binds RPC ctx before session_start and awaits select/input/editor in a real registered tool", async () => {
    const { fixture, service, ui } = await setup();
    const faux = fauxProvider({ provider: "pi-basic-ui" }); const models = createModels(); models.setProvider(faux.provider);
    const modes: string[] = [];
    const extension: ExtensionFactory = pi => {
      pi.on("session_start", (_event, ctx) => { modes.push(ctx.mode); expect(ctx.hasUI).toBe(true); });
      pi.registerTool({ name: "basic_ui", label: "Basic UI", description: "Synthetic UI test", parameters: Type.Object({}), executionMode: "sequential",
        execute: async (_id, _params, signal, _update, ctx) => {
          expect(ctx.mode).toBe("rpc"); expect(ctx.hasUI).toBe(true);
          const opts = signal === undefined ? undefined : { signal };
          const choice = await ctx.ui.select("Choose a route", ["A", "B"], opts);
          const text = await ctx.ui.input("Input a value", "Synthetic placeholder", opts);
          const edited = await ctx.ui.editor("Edit the value", "Original synthetic text");
          return { content: [{ type: "text", text: [choice, text, edited].join("|") }], details: {} };
        },
      });
    };
    faux.setResponses([fauxAssistantMessage([fauxToolCall("basic_ui", {}, { id: "ui-call" })], { stopReason: "toolUse" }), context => {
      expect(context.messages.find(message => message.role === "toolResult" && message.toolCallId === "ui-call")).toMatchObject({ content: [{ type: "text", text: "B|Synthetic input|Edited synthetic text" }], isError: false });
      return fauxAssistantMessage([fauxText("UI sequence continued")]);
    }]);
    const session = await createJoiPiSession({ state: { model: faux.getModel(), thinkingLevel: "off", systemPrompt: "Synthetic test", messages: [], tools: [] } }, models, fixture.root, { extensionFactories: [extension], uiContext: ui });
    const running = session.prompt("Exercise basic UI");
    try {
      expect(modes).toEqual(["rpc"]);
      for (const [index, text] of ["B", "Synthetic input", "Edited synthetic text"].entries()) {
        await vi.waitFor(async () => expect((await service.list(owner.scope))[index]?.status).toBe("ACTIVE"));
        expect(faux.state.callCount).toBe(1);
        const question = (await service.list(owner.scope))[index];
        if (question === undefined) throw new Error("Expected an active UI question");
        await service.answer(owner.scope, question.questionId, index === 0 ? { version: 1, selectedOptionIds: ["option-2"] } : { version: 1, text });
      }
      await running; await session.waitForIdle();
      expect(faux.state.callCount).toBe(2);
      // A standalone UI binding cannot know the enclosing run's commit point; it never ACKs itself.
      expect((await service.list(owner.scope)).every(question => question.delivery === "PENDING")).toBe(true);
    } finally { await service.cancelOwner(owner.ownerId); await session.abort(); await running.catch(() => undefined); session.dispose(); service.close(); await fixture.close(); }
  });

  it("requires an explicit yes and rejects confirmation on durable timeout", async () => {
    const { fixture, service, ui } = await setup();
    try {
      const waiting = ui.confirm("Authorize?", "Synthetic action");
      await vi.waitFor(async () => expect((await service.list(owner.scope))[0]?.status).toBe("ACTIVE"));
      const question = (await service.list(owner.scope))[0];
      expect(question).toMatchObject({ kind: "CONFIRM", defaultOptionIds: ["no"], allowCustom: false });
      fixture.clock.advance(30 * 60_000); await service.expire();
      await expect(waiting).resolves.toBe(false);
      const second = ui.confirm("Authorize?", "Synthetic action");
      await vi.waitFor(async () => expect((await service.list(owner.scope))[1]?.status).toBe("ACTIVE"));
      const secondQuestion = (await service.list(owner.scope))[1];
      if (secondQuestion === undefined) throw new Error("Expected a second confirmation");
      await service.answer(owner.scope, secondQuestion.questionId, { version: 1, selectedOptionIds: ["yes"] });
      await expect(second).resolves.toBe(true);
    } finally { service.close(); await fixture.close(); }
  });

  it("does not promote dialog cancellation to a default answer; custom is unavailable in RPC", async () => {
    const { fixture, service, ui } = await setup();
    const controller = new AbortController();
    try {
      const pending = ui.input("Synthetic input", undefined, { signal: controller.signal });
      const failed = expect(pending).rejects.toBeInstanceOf(Error);
      await vi.waitFor(async () => expect((await service.list(owner.scope))[0]?.status).toBe("ACTIVE"));
      controller.abort(); await failed;
      expect((await service.list(owner.scope))[0]?.status).toBe("CANCELED");
      const custom = vi.fn(() => { throw new Error("TUI factory must not run"); });
      await expect(ui.custom(custom)).resolves.toBeUndefined(); expect(custom).not.toHaveBeenCalled();
      expect(ui.theme.fg("text", "plain")).toContain("plain");
      expect(ui.getAllThemes()).toEqual([]); expect(ui.getEditorText()).toBe("");
      expect(ui.setTheme("dark").success).toBe(false);
    } finally { service.close(); await fixture.close(); }
  });

  it("expires only the explicit dialog while preserving sibling cards and their activation deadlines", async () => {
    const { fixture, service } = await setup();
    const cancelOwner = vi.spyOn(service, "cancelOwner"), cancelQuestion = vi.spyOn(service, "cancelQuestion");
    const onCancel = vi.fn();
    const timedUI = createPiUserQuestionUI(service, owner, { onCancel });
    try {
      const first = await service.enqueue({ ...owner, questionId: "ordinary-active", question: "First ordinary question" });
      await service.enqueue({ ...owner, questionId: "ordinary-queued", question: "Next ordinary question" });
      fixture.clock.advance(10 * 60_000);
      await expect(timedUI.confirm("Synthetic approval", "Never approve by timeout", { timeout: 5 })).resolves.toBe(false);
      expect(cancelOwner).not.toHaveBeenCalled(); expect(onCancel).not.toHaveBeenCalled();
      expect(cancelQuestion).toHaveBeenCalledWith(owner.scope, "pi-ui-question:ui-turn:1");
      const cards = await service.list(owner.scope);
      expect(cards[0]).toMatchObject({ status: "ACTIVE", expiresAt: first.expiresAt });
      expect(cards[1]).toMatchObject({ status: "QUEUED" }); expect(cards[1]?.expiresAt).toBeUndefined();
      expect(cards[2]).toMatchObject({ status: "CANCELED" }); expect(cards[2]?.answer).toBeUndefined();
      await service.answer(owner.scope, first.questionId, { version: first.version, text: "First answer" });
      const next = (await service.list(owner.scope))[1];
      expect(next?.status).toBe("ACTIVE");
      expect(Date.parse(next?.expiresAt ?? "") - fixture.clock.now().getTime()).toBe(30 * 60_000);
    } finally { service.close(); await fixture.close(); }
  });
});
