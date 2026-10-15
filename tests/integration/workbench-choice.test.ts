import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";
import { createApiHandler } from "../../src/main/interfaces/http/api-handler.js";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners.js";

const proposal = { name: "joi 工程维护工坊", projectLabel: "joi", scopeSummary: "代码与工程文档维护。" };

describe("durable workbench choice", () => {
  it("exposes atomic creation through HTTP and rejects a competing versioned choice without creating another workbench", async () => {
    const fixture = await createRuntimeFixture();
    const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
    const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
    const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, joiInbox: inbox }), loopbackPort: 0 });
    try {
      const accepted = await inbox.accept({ text: "维护工程", idempotencyKey: "http-choice" });
      await repository.requireClarification(accepted.inputId, "workbench_selection_invalid", undefined, undefined, proposal);
      const question = (await inbox.list())[0];
      if (question?.questionId === undefined || question.questionVersion === undefined) throw new Error("missing question");
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const auth = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
        method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify({ nonce: bootstrap.nonce }),
      });
      const { csrfToken } = await auth.json() as { csrfToken: string };
      const headers = { "content-type": "application/json", origin: "null", cookie: auth.headers.get("set-cookie")?.split(";")[0] ?? "", "x-csrf-token": csrfToken };
      const draft = { ...proposal, personaSummary: "PRIVATE_PERSONA", bindInputId: accepted.inputId,
        questionId: question.questionId, questionVersion: question.questionVersion, idempotencyKey: "http-create" };
      const create = () => fetch(`${listeners.loopback.url}/api/v1/workbenches`, { headers, method: "POST", body: JSON.stringify(draft) });
      const first = await create();
      expect(first.status).toBe(201);
      const receipt = await first.json() as { workbenchId: string };
      expect(JSON.stringify(receipt)).not.toContain("PRIVATE_PERSONA");
      expect(await (await create()).json()).toEqual(receipt);
      const competing = await fetch(`${listeners.loopback.url}/api/v1/workbenches`, {
        headers, method: "POST", body: JSON.stringify({ ...draft, name: "其他工坊", idempotencyKey: "other-device" }),
      });
      expect(competing.status).toBe(409);
      expect(await fixture.workbenches.listSummaries()).toHaveLength(1);
      await expect(inbox.clarify({ inputId: accepted.inputId, workbenchId: receipt.workbenchId,
        questionId: question.questionId, questionVersion: question.questionVersion })).rejects.toMatchObject({ code: "joi_clarification_unavailable" });
    } finally { await listeners.close(); await fixture.close(); }
  });
  it("restores the public proposal and atomically creates and binds exactly once", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const input = await inbox.accept({ text: "完善工程文档", idempotencyKey: "choice" });
      await repository.requireClarification(input.inputId, "workbench_selection_invalid", undefined, undefined, proposal);
      const restored = (await new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository: new SqliteJoiInboxRepository(fixture.database, fixture.clock) }).list())[0];
      if (restored?.questionId === undefined || restored.questionVersion === undefined) throw new Error("missing question");
      expect(restored.workbenchProposal).toEqual(proposal);
      expect((await fixture.joiHomeFeed.load()).unassignedActions[0]?.workbenchProposal).toEqual(proposal);
      const draft = { ...proposal, personaSummary: "使用工程证据。", bindInputId: input.inputId, questionId: restored.questionId, questionVersion: restored.questionVersion, idempotencyKey: "create-choice" };
      const first = await fixture.workbenchRegistry.create(draft);
      expect((await repository.loadInput(input.inputId))?.workbenchId).toBe(first.workbenchId);
      expect(await fixture.workbenchRegistry.create(draft)).toEqual(first);
      expect(await fixture.workbenches.listSummaries()).toHaveLength(1);
      await expect(fixture.workbenchRegistry.create({ ...draft, name: "其他工程" })).rejects.toMatchObject({ code: "workbench_choice_conflict" });
      expect((await inbox.list())[0]?.workbenchProposal).toBeUndefined();
    } finally { await fixture.close(); }
  });

  it("rolls back creation if binding fails and rejects stale or canceled choices", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const input = await inbox.accept({ text: "维护代码", idempotencyKey: "rollback" });
      await repository.requireClarification(input.inputId, "workbench_selection_invalid");
      const question = (await inbox.list())[0];
      if (question?.questionId === undefined || question.questionVersion === undefined) throw new Error("missing question");
      const draft = { ...proposal, personaSummary: "工程证据。", bindInputId: input.inputId, questionId: question.questionId, questionVersion: question.questionVersion, idempotencyKey: "create-rollback" };
      await expect(fixture.workbenchRegistry.create({ ...draft, questionVersion: draft.questionVersion + 1 })).rejects.toMatchObject({ code: "workbench_choice_conflict" });
      expect(await fixture.workbenches.listSummaries()).toHaveLength(0);
      fixture.database.transaction((connection) => connection.exec("CREATE TRIGGER reject_choice_binding BEFORE UPDATE OF workbench_id ON joi_inbox_messages BEGIN SELECT RAISE(ABORT, 'fixture_choice_abort'); END"));
      await expect(fixture.workbenchRegistry.create(draft)).rejects.toThrow("fixture_choice_abort");
      expect(await fixture.workbenches.listSummaries()).toHaveLength(0);
      fixture.database.transaction((connection) => connection.exec("DROP TRIGGER reject_choice_binding"));
      await inbox.cancel({ inputId: input.inputId });
      await expect(fixture.workbenchRegistry.create(draft)).rejects.toMatchObject({ code: "workbench_choice_conflict" });
      expect(await fixture.workbenches.listSummaries()).toHaveLength(0);
    } finally { await fixture.close(); }
  });
});
