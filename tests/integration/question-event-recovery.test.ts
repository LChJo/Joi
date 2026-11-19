import { createRuntimeFixture } from "../support/runtime-fixture.js";
import { normalizeUserQuestion, UserQuestionService } from "../../src/main/application/joi/user-question-service.js";
import { SqliteUserQuestionStore } from "../../src/main/infrastructure/persistence/sqlite-user-question-store.js";
import { SqliteConversationStore } from "../../src/main/infrastructure/persistence/sqlite-conversation-store.js";

async function setup() {
  const fixture = await createRuntimeFixture();
  const workbench = await fixture.workbenchRegistry.create({ name: "Question events",personaSummary: "Fixture",projectLabel: "Fixture",scopeSummary: "Fixture" });
  const conversations = new SqliteConversationStore(fixture.database);
  const questions = new SqliteUserQuestionStore(fixture.database);
  const now = fixture.clock.now().toISOString();
  const config = { partnerId: "p",partnerName: "Fixture",networkId: "n",networkName: "Fixture",modelName: "Fixture",skills: [],attachmentIds: [] };
  const submit = (turnId: string,conversationId = "chat",recoveryContext?: string) => conversations.submit({ conversationId,turnId,requestId: turnId,
    workbenchId: workbench.workbenchId,text: "Continue",config,at: now,...(recoveryContext === undefined ? {} : { recoveryContext }) });
  const child = (childId: string,parentTurnId: string,status = "RUNNING") => fixture.database.transaction(db => db.prepare(
    "INSERT INTO conversation_subagents(child_id,parent_turn_id,call_id,input_json,status,created_at) VALUES (?,?,?,'{}',?,?)").run(childId,parentTurnId,childId,status,now));
  const enqueue = (questionId: string,ownerId = "parent",conversationId = "chat") => questions.enqueue(normalizeUserQuestion({ questionId,ownerId,
    scope: { kind: "CONVERSATION",id: conversationId },sourceName: "Fixture",question: "Choose a route",defaultAnswer: "Default" },now),now);
  return { fixture,conversations,questions,now,submit,child,enqueue };
}

describe("conversation question events and recovery", () => {
  it("ASK-01/03/10 gives a new turn the active slot while preserving interrupted cards for explicit recovery", async () => {
    const s = await setup();
    const service = new UserQuestionService({ store: s.questions, clock: s.fixture.clock });
    try {
      await s.submit("parent");await s.conversations.begin("parent");
      await s.enqueue("orphan");await s.enqueue("old-queued");
      await s.questions.interruptUnfinishedConversations();
      await s.conversations.recoverInterrupted(s.now);
      await expect(service.answer({ kind: "CONVERSATION", id: "chat" },"orphan",{ version: 1, text: "stale" }))
        .rejects.toMatchObject({ code: "question_stale" });
      s.fixture.clock.advance(30 * 60_000);
      expect(await service.expire()).toEqual([]);
      await s.submit("next");await s.conversations.begin("next");
      const current = await service.enqueue({ questionId: "fresh", ownerId: "next", scope: { kind: "CONVERSATION", id: "chat" },
        sourceName: "Fixture", question: "Choose the new route" });
      expect(current).toMatchObject({ status: "ACTIVE", delivery: "PENDING" });
      expect(Date.parse(current.expiresAt ?? "") - s.fixture.clock.now().getTime()).toBe(30 * 60_000);
      expect((await s.questions.get("orphan"))?.answer).toBeUndefined();
      expect((await s.questions.get("old-queued"))?.answer).toBeUndefined();
    } finally { service.close();await s.fixture.close(); }
  });

  it("persists child ownership independently of the latest turn and rejects a foreign parent scope", async () => {
    const s = await setup();
    try {
      await s.submit("parent");await s.conversations.begin("parent");s.child("child","parent");
      expect(await s.enqueue("child-q","child")).toMatchObject({ ownerId: "child",parentTurnId: "parent" });
      expect(await s.enqueue("parent-q")).toMatchObject({ ownerId: "parent",parentTurnId: "parent" });
      const persisted = s.fixture.database.transaction(db => db.prepare("SELECT payload_json FROM user_questions WHERE question_id='child-q'").get());
      expect(JSON.parse(String(persisted?.payload_json))).toMatchObject({ parentTurnId: "parent" });
      await s.submit("foreign-parent","foreign");
      await expect(s.enqueue("foreign-q","child","foreign")).rejects.toMatchObject({ code: "question_invalid" });
      const goal = await s.questions.enqueue(normalizeUserQuestion({ questionId: "goal-q",ownerId: "goal",scope: { kind: "GOAL",id: "goal" },sourceName: "Fixture",question: "Goal question" },s.now),s.now);
      expect(goal.parentTurnId).toBeUndefined();
    } finally { await s.fixture.close(); }
  });

  it("advances payload-free parent cursors for queue, answer, cancellation and delivery in the same transaction", async () => {
    const s = await setup();
    try {
      await s.submit("parent");await s.conversations.begin("parent");s.child("child","parent");
      let cursor = (await s.conversations.get("chat"))?.eventCursor;
      const changed = async (action: () => Promise<unknown>) => {
        await action();const events = await s.conversations.events("chat",cursor);
        expect(events.items.length).toBeGreaterThan(0);expect(events.items.every(item => item.turnId === "parent")).toBe(true);
        expect(JSON.stringify(events)).not.toContain("Choose a route");cursor = events.cursor;
      };
      await changed(() => s.enqueue("first","child"));
      expect((await s.conversations.get("chat"))?.turns[0]).toMatchObject({ waitingForUser: true,questions: [{ questionId: "first",parentTurnId: "parent",status: "ACTIVE" }] });
      await s.enqueue("first","child");expect((await s.conversations.events("chat",cursor)).items).toEqual([]);
      await changed(() => s.enqueue("second"));
      await changed(() => s.questions.answer("first",1,{ text: "Saved answer",selectedOptionIds: [],source: "USER",answeredAt: s.now },s.now));
      expect((await s.questions.get("second"))?.status).toBe("ACTIVE");
      await changed(() => s.questions.markDelivered("first"));
      await changed(() => s.questions.cancelQuestion({ kind: "CONVERSATION",id: "chat" },"second",s.now));
      await changed(() => s.enqueue("third","child"));
      await changed(() => s.questions.interruptOwner("child",s.now));
      await changed(() => s.questions.cancelOwner("child",s.now));
      expect(() => s.fixture.database.transaction(db => {
        db.prepare("UPDATE user_questions SET delivery='PENDING' WHERE question_id='first'").run();
        throw new Error("rollback fixture");
      })).toThrow("rollback fixture");
      expect((await s.conversations.events("chat",cursor)).items).toEqual([]);
      expect((await s.questions.get("first"))?.delivery).toBe("DELIVERED");
    } finally { await s.fixture.close(); }
  });

  it("projects old child cards into the owning history page with safe DTOs, not the latest turn", async () => {
    const s = await setup();
    try {
      await s.submit("parent");await s.conversations.begin("parent");s.child("child","parent");
      await s.enqueue("child-q","child");
      await s.questions.answer("child-q",1,{ text: "token=synthetic-secret",selectedOptionIds: [],source: "USER",answeredAt: s.now },s.now);
      await s.questions.markDelivered("child-q");
      await s.conversations.update("parent",{ status: "COMPLETED",entries: [],artifacts: [] });
      for (let index = 0;index < 51;index++) {
        const id = `later-${String(index)}`;await s.submit(id);await s.conversations.begin(id);await s.conversations.update(id,{ status: "COMPLETED",entries: [],artifacts: [] });
      }
      const current = await s.conversations.get("chat");
      expect(current?.turns).toHaveLength(50);expect(current?.turns.every(turn => turn.questions === undefined)).toBe(true);
      const page = await s.conversations.page("chat",current?.historyCursor);
      expect(page.items[0]).toMatchObject({ turnId: "parent",waitingForUser: false,questions: [{ questionId: "child-q",ownerId: "child",parentTurnId: "parent",answer: { text: "token=[redacted]" } }] });
      expect((await s.conversations.turn("parent"))?.turn.questions).toEqual(page.items[0]?.questions);
      expect(JSON.stringify(page)).not.toContain("synthetic-secret");
    } finally { await s.fixture.close(); }
  });

  it("interrupts unconsumed parent and child questions on cold boot without changing consumed or canceled cards", async () => {
    const s = await setup();
    try {
      await s.submit("parent");await s.conversations.begin("parent");s.child("child","parent");
      await s.enqueue("delivered","child");await s.questions.answer("delivered",1,{ text: "Consumed",selectedOptionIds: [],source: "USER",answeredAt: s.now },s.now);await s.questions.markDelivered("delivered");
      await s.enqueue("answered","child");await s.questions.answer("answered",1,{ text: "Not consumed",selectedOptionIds: [],source: "USER",answeredAt: s.now },s.now);
      const active = await s.enqueue("active");await s.enqueue("queued","child");await s.enqueue("canceled","child");await s.questions.cancelQuestion({ kind: "CONVERSATION",id: "chat" },"canceled",s.now);
      const cold = new SqliteUserQuestionStore(s.fixture.database);
      await cold.interruptUnfinishedConversations();
      for (const id of ["answered","active","queued"]) expect((await cold.get(id))?.delivery).toBe("INTERRUPTED");
      expect((await cold.get("active"))?.expiresAt).toBe(active.expiresAt);
      expect((await cold.get("delivered"))?.delivery).toBe("DELIVERED");
      expect((await cold.get("canceled"))?.delivery).toBe("PENDING");
      const cursor = (await s.conversations.get("chat"))?.eventCursor;
      await s.conversations.recoverInterrupted(s.now);await cold.interruptUnfinishedConversations();
      const settledCursor = (await s.conversations.events("chat",cursor)).cursor;
      await cold.interruptUnfinishedConversations();expect((await s.conversations.events("chat",settledCursor)).items).toEqual([]);
    } finally { await s.fixture.close(); }
  });

  it("reads canonical status, identity, version and deadline columns instead of stale payload fields", async () => {
    const s = await setup();
    try {
      await s.submit("parent");await s.conversations.begin("parent");await s.enqueue("canonical");
      s.fixture.database.transaction(db => db.prepare("UPDATE user_questions SET status='CANCELED',version=2,expires_at=NULL,delivery='INTERRUPTED' WHERE question_id='canonical'").run());
      const cold = new SqliteUserQuestionStore(s.fixture.database);
      for (const question of [await cold.get("canonical"),...(await cold.list({ kind: "CONVERSATION",id: "chat" }))]) {
        expect(question).toMatchObject({ questionId: "canonical",scope: { kind: "CONVERSATION",id: "chat" },ownerId: "parent",status: "CANCELED",version: 2,delivery: "INTERRUPTED" });
        expect(question?.expiresAt).toBeUndefined();
      }
    } finally { await s.fixture.close(); }
  });

  it("keeps complete recovery context private and enforces its submission identity", async () => {
    const s = await setup();
    try {
      const recoveryContext = `PRIVATE_RECOVERY ${"原".repeat(70_000)} /original/complete/path/to/file token=synthetic-secret`;
      const dto = await s.submit("recovery","chat",recoveryContext);
      expect((await s.conversations.turn("recovery"))?.recoveryContext === recoveryContext).toBe(true);
      expect(JSON.stringify(dto)).not.toContain("PRIVATE_RECOVERY");
      expect(JSON.stringify(await s.conversations.page("chat"))).not.toContain("PRIVATE_RECOVERY");
      expect(JSON.stringify(await s.conversations.request("recovery"))).not.toContain("PRIVATE_RECOVERY");
      expect(await s.submit("recovery","chat",recoveryContext)).toEqual(dto);
      await expect(s.submit("recovery","chat","Changed recovery context")).rejects.toMatchObject({ code: "conversation_request_conflict" });
    } finally { await s.fixture.close(); }
  });
});
