import { createRuntimeFixture } from "../support/runtime-fixture.js";
import { SqliteUserQuestionStore } from "../../src/main/infrastructure/persistence/sqlite-user-question-store.js";
import { UserQuestionService } from "../../src/main/application/joi/user-question-service.js";

async function setup() {
  const fixture = await createRuntimeFixture();
  const store = new SqliteUserQuestionStore(fixture.database);
  const service = new UserQuestionService({ store, clock: fixture.clock });
  return { fixture, store, service };
}
const scope = { kind: "CONVERSATION" as const, id: "chat" };
const question = (id: string) => ({ questionId: id, scope, ownerId: "turn", toolCallId: id, sourceName: "搭档", question: `问题 ${id}`,
  options: [{ id: "a", label: "保留现状" }, { id: "b", label: "推荐方案", recommended: true }] });

describe("持久提问队列", () => {
  it("按队列 FIFO 激活，排队不计时，重复请求不新增卡片", async () => {
    const { fixture, service } = await setup();
    try {
      const first = await service.enqueue(question("first"));
      fixture.clock.advance(60_000);
      const second = await service.enqueue(question("second"));
      expect(first).toMatchObject({ status: "ACTIVE", version: 1 });
      expect(second).toMatchObject({ status: "QUEUED" });
      expect(second.expiresAt).toBeUndefined();
      expect(await service.enqueue(question("first"))).toEqual(first);
      const saved = await service.answer(scope, "first", { version: 1, selectedOptionIds: ["b"] });
      expect(saved).toMatchObject({ status: "ANSWERED", answer: { source: "USER", text: "推荐方案", selectedOptionIds: ["b"] } });
      const next = (await service.list(scope)).find(item => item.questionId === "second");
      expect(next?.status).toBe("ACTIVE");
      expect(Date.parse(next?.expiresAt ?? "") - fixture.clock.now().getTime()).toBe(30 * 60_000);
    } finally { service.close(); await fixture.close(); }
  });

  it("选项和自定义补充同时保留在返回模型的答案正文", async () => {
    const { fixture, service } = await setup();
    try {
      await service.enqueue(question("combined"));
      const answer = await service.answer(scope,"combined",{version:1,selectedOptionIds:["b"],text:"仅处理当前目录"});
      expect(answer.answer?.text).toBe("选择：推荐方案\n补充：仅处理当前目录");
    } finally { service.close();await fixture.close(); }
  });

  it("超时采用推荐且仅解决一次，下一张有完整三十分钟", async () => {
    const { fixture, service } = await setup();
    try {
      await service.enqueue(question("first")); await service.enqueue(question("second"));
      fixture.clock.advance(30 * 60_000 - 1); expect(await service.expire()).toEqual([]);
      fixture.clock.advance(1); expect(await service.expire()).toHaveLength(1);
      expect(await service.expire()).toEqual([]);
      expect((await service.list(scope))[0]).toMatchObject({ status: "ANSWERED", answer: { source: "TIMEOUT_DEFAULT", selectedOptionIds: ["b"] } });
      await expect(service.answer(scope, "first", { version: 1, text: "迟到回答" })).rejects.toMatchObject({ code: "question_stale" });
      expect((await service.list(scope))[1]?.status).toBe("ACTIVE");
    } finally { service.close(); await fixture.close(); }
  });

  it("人工回答和超时竞争只有一个赢家，拒绝跨队列和排队回答", async () => {
    const { fixture, service } = await setup();
    try {
      await service.enqueue(question("first")); await service.enqueue(question("second"));
      await expect(service.answer(scope, "second", { version: 1, text: "越序" })).rejects.toMatchObject({ code: "question_stale" });
      await expect(service.answer({ kind: "CONVERSATION", id: "foreign" }, "first", { version: 1, text: "跨会话" })).rejects.toMatchObject({ code: "question_not_found" });
      fixture.clock.advance(30 * 60_000);
      await Promise.allSettled([service.answer(scope, "first", { version: 1, text: "人工答案" }), service.expire()]);
      expect((await service.list(scope)).filter(item => item.status === "ANSWERED")).toMatchObject([{ answer: { source: "TIMEOUT_DEFAULT" } }]);
    } finally { service.close(); await fixture.close(); }
  });

  it("ASK-02/03 在超时扫描尚未运行时也拒绝过期人工回答", async () => {
    const { fixture, service } = await setup();
    try {
      await service.enqueue(question("first"));
      fixture.clock.advance(30 * 60_000);
      await expect(service.answer(scope,"first",{ version: 1, text: "过期" })).rejects.toMatchObject({ code: "question_stale" });
      expect(await service.expire()).toMatchObject([{ answer: { source: "TIMEOUT_DEFAULT" } }]);
    } finally { service.close(); await fixture.close(); }
  });

  it("取消撤销等待者，旧卡与执行中断不得自动唤醒", async () => {
    const { fixture, service } = await setup();
    try {
      await service.enqueue(question("first"));
      const waiting = service.wait("first");
      const rejected = expect(waiting).rejects.toMatchObject({ code: "question_canceled" });
      await service.cancelOwner("turn"); await rejected;
      fixture.clock.advance(60 * 60_000); expect(await service.expire()).toEqual([]);
      await expect(service.answer(scope, "first", { version: 1, text: "过期" })).rejects.toMatchObject({ code: "question_stale" });
    } finally { service.close(); await fixture.close(); }
  });

  it("重新创建服务保留期限，默认文本不编造答案，确认超时不等于同意", async () => {
    const { fixture, store, service } = await setup();
    const restarted = new UserQuestionService({ store, clock: fixture.clock });
    try {
      const first = await service.enqueue({ ...question("first"), options: [], question: "请选择方式" });
      service.close(); fixture.clock.advance(30 * 60_000);
      await restarted.expire();
      const saved = (await restarted.list(scope))[0];
      expect(saved?.expiresAt).toBe(first.expiresAt);
      expect(saved?.answer?.text).toContain("现有权限");
      await restarted.enqueue({ ...question("confirm"), options: [{ id: "yes", label: "允许" }, { id: "no", label: "拒绝" }], defaultOptionIds: ["no"], kind: "CONFIRM" });
      fixture.clock.advance(30 * 60_000); await restarted.expire();
      expect((await restarted.list(scope))[1]?.answer?.text).toBe("拒绝");
    } finally { restarted.close(); await fixture.close(); }
  });
});
