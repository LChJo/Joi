import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import { EventService } from "../../src/main/application/events/event-service";
import { ContinuityService } from "../../src/main/application/continuity/continuity-service";
import { LifeRuntimeService } from "../../src/main/application/lives/life-runtime-service";
import { AttachmentService } from "../../src/main/infrastructure/artifacts/user-attachment-service";
import path from "node:path";
import { InMemoryEventSignal } from "../../src/main/infrastructure/runtime/in-memory-event-signal";
import { createRuntimeFixture } from "../support/runtime-fixture";

function cookieFrom(response: Response) {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("missing session cookie");
  return value.split(";", 1)[0] ?? "";
}

describe("HTTP API v1", () => {
  it("bootstraps desktop auth and exposes persistent Life resources with safe Agent DTOs", async () => {
    const fixture = await createRuntimeFixture();
    const events = new EventService({
      clock: fixture.clock,
      ids: fixture.ids,
      publisher: fixture.sse,
      signal: new InMemoryEventSignal(),
      store: fixture.database.store,
    });
    const lifeRuntime = new LifeRuntimeService({ clock: fixture.clock, events, store: fixture.database.store });
    const attachments = new AttachmentService({
      clock: fixture.clock, ids: fixture.ids, rootDirectory: path.join(fixture.root, "artifacts"), store: fixture.database.store,
    });
    const continuity = new ContinuityService({ clock: fixture.clock, store: fixture.database.store });
    const handler = createApiHandler({ ...fixture, attachments, continuity, events, lifeRuntime });
    const listeners = await startRuntimeListeners({ handler, loopbackPort: 0 });
    const origin = listeners.loopback.url;

    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const bootstrapResponse = await fetch(`${origin}/api/v1/auth/bootstrap`, {
        body: JSON.stringify({ nonce: bootstrap.nonce }),
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      expect(bootstrapResponse.status).toBe(200);
      const cookie = cookieFrom(bootstrapResponse);
      const bootstrapBody = await bootstrapResponse.json() as { csrfToken: string };
      const authHeaders = {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": bootstrapBody.csrfToken,
        origin: "null",
      };
      const setup = await fetch(`${origin}/api/v1/auth/setup`, {
        body: JSON.stringify({ password: "correct horse battery staple" }),
        headers: authHeaders,
        method: "POST",
      });
      expect(setup.status).toBe(204);

      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.20/card.json", name: "主 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const collaborator = await fixture.agents.createShell({ cardUrl: "http://192.168.1.21/card.json", name: "协作者" });
      await fixture.agents.activateForReadiness(collaborator.agentConnectionId);
      const created = await fetch(`${origin}/api/v1/lives`, {
        body: JSON.stringify({
          mainAgentConnectionId: agent.agentConnectionId,
          initialGoal: "先整理长期计划",
          name: "栖遥",
          personaSummary: "一位关注长期连续性、会主动整理计划并诚实表达不确定性的数字生命。",
          principles: ["先保存事实，再采取行动"],
          timezone: "Asia/Shanghai",
        }),
        headers: { ...authHeaders, "idempotency-key": "create-life-1" },
        method: "POST",
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json() as { lifeId: string };
      expect(createdBody.lifeId).toMatch(/^life_/);
      const bound = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/collaborators`, {
        body: JSON.stringify({ agentConnectionId: collaborator.agentConnectionId }),
        headers: authHeaders,
        method: "POST",
      });
      expect(await bound.json()).toMatchObject({ items: [expect.objectContaining({ agentConnectionId: collaborator.agentConnectionId })] });

      const started = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/runtime/start`, {
        headers: authHeaders,
        method: "POST",
      });
      expect(await started.json()).toMatchObject({ state: "SLEEPING" });
      const uploadedAttachment = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/attachments`, {
        body: JSON.stringify({ bytes: Buffer.from("本地附件").toString("base64"), filename: "note.txt", mimeType: "text/plain" }),
        headers: authHeaders,
        method: "POST",
      });
      expect(uploadedAttachment.status).toBe(201);
      const uploadedAttachmentBody = await uploadedAttachment.json() as { attachmentId: string };
      const message = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/messages`, {
        body: JSON.stringify({ attachmentIds: [uploadedAttachmentBody.attachmentId], channelId: "desktop", text: "今天先整理计划" }),
        headers: { ...authHeaders, "idempotency-key": "message-1" },
        method: "POST",
      });
      expect(message.status).toBe(202);
      const messageBody = await message.json() as { eventId: string };
      const replayedMessage = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/messages`, {
        body: JSON.stringify({ text: "重复正文不能覆盖" }),
        headers: { ...authHeaders, "idempotency-key": "message-1" },
        method: "POST",
      });
      expect(await replayedMessage.json()).toMatchObject({
        eventId: messageBody.eventId,
        payload: { attachments: [expect.objectContaining({ attachmentId: uploadedAttachmentBody.attachmentId, filename: "note.txt" })], text: "今天先整理计划" },
      });
      const eventList = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/events`, { headers: { cookie } });
      expect(await eventList.json()).toMatchObject({ items: expect.arrayContaining([
        expect.objectContaining({ payload: { initialGoal: "先整理长期计划" }, type: "system.birth" }),
        expect.objectContaining({ eventId: messageBody.eventId, type: "human.message" }),
      ]) as unknown });
      const continuitySnapshot = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/continuity`, { headers: { cookie } });
      expect(await continuitySnapshot.json()).toMatchObject({
        affairs: [],
        budget: { autonomousWakesLimit: 24, invocationsLimit: 100 },
        schedules: expect.arrayContaining([
          expect.objectContaining({ kind: "morning_plan", localTime: "08:00" }),
          expect.objectContaining({ kind: "memory_metabolism", localTime: "03:00" }),
        ]) as unknown,
      });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((database) => {
        database.prepare(`
          INSERT INTO todos (todo_id, life_id, title, status, created_at, updated_at)
          VALUES ('todo_http', ?, '整理 HTTP 合约', 'OPEN', ?, ?)`)
          .run(createdBody.lifeId, now, now);
        database.prepare(`
          INSERT INTO memory_fragments
            (memory_id, life_id, kind, content, confidence, revision, status, created_at, updated_at)
          VALUES ('memory_http', ?, 'SEMANTIC', '旧的合约事实', 0.8, 1, 'ACTIVE', ?, ?)`)
          .run(createdBody.lifeId, now, now);
      });
      const expressions = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/expressions`, { headers: { cookie } });
      expect(await expressions.json()).toEqual({ items: [] });
      const reminded = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/todos/todo_http/remind`, {
        headers: authHeaders, method: "POST",
      });
      expect(await reminded.json()).toMatchObject({ payload: { todoId: "todo_http" }, type: "todo.reminder" });
      const corrected = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/memories/memory_http/correct`, {
        body: JSON.stringify({ content: "新的合约事实" }), headers: authHeaders, method: "POST",
      });
      expect(await corrected.json()).toMatchObject({ payload: { memoryId: "memory_http", previousRevision: 1 }, type: "memory.corrected" });
      const forgotten = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/memories/memory_http/forget`, { headers: authHeaders, method: "POST" });
      expect(await forgotten.json()).toMatchObject({ payload: { memoryId: "memory_http" }, type: "memory.forgotten" });
      const todoCreated = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/todos`, {
        body: JSON.stringify({ dueAt: "2026-07-16T08:00:00.000Z", title: "用户新待办" }), headers: authHeaders, method: "POST",
      });
      expect(await todoCreated.json()).toMatchObject({ payload: { operation: "create", title: "用户新待办" }, type: "todo.user_changed" });
      const todoCompleted = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/todos/todo_http`, {
        body: JSON.stringify({ status: "DONE" }), headers: authHeaders, method: "PATCH",
      });
      expect(await todoCompleted.json()).toMatchObject({ payload: { operation: "update", status: "DONE", todoId: "todo_http" }, type: "todo.user_changed" });
      const alarmCreated = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/alarms`, {
        body: JSON.stringify({ nextAt: "2026-07-16T08:00:00.000Z", reason: "合约提醒" }), headers: authHeaders, method: "POST",
      });
      expect(await alarmCreated.json()).toMatchObject({ payload: { operation: "create", reason: "合约提醒" }, type: "alarm.user_changed" });
      const alarmCanceled = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/alarms/alarm_http`, { headers: authHeaders, method: "DELETE" });
      expect(await alarmCanceled.json()).toMatchObject({ payload: { alarmId: "alarm_http", operation: "cancel" }, type: "alarm.user_changed" });
      const sessions = await fetch(`${origin}/api/v1/auth/sessions`, { headers: { cookie } });
      expect(await sessions.json()).toMatchObject({ items: [expect.objectContaining({ current: true, kind: "desktop" })] });
      const paused = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/runtime/pause`, { headers: authHeaders, method: "POST" });
      expect(await paused.json()).toMatchObject({ state: "PAUSED" });
      const primaryChanged = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/primary-agent`, {
        body: JSON.stringify({ agentConnectionId: collaborator.agentConnectionId }), headers: authHeaders, method: "POST",
      });
      expect(await primaryChanged.json()).toMatchObject({
        handoff: { fromAgentConnectionId: agent.agentConnectionId, toAgentConnectionId: collaborator.agentConnectionId },
        life: { mainAgentConnectionId: collaborator.agentConnectionId, state: "PAUSED" },
      });
      const handoffs = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/primary-agent`, { headers: { cookie } });
      expect(await handoffs.json()).toMatchObject({ items: [expect.objectContaining({ lifeId: createdBody.lifeId })] });
      const resumed = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/runtime/resume`, { headers: authHeaders, method: "POST" });
      expect(await resumed.json()).toMatchObject({ state: "QUEUED" });
      const stopped = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/runtime/stop`, { headers: authHeaders, method: "POST" });
      expect(await stopped.json()).toMatchObject({ state: "STOPPED" });
      const impact = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/deletion-impact`, { headers: { cookie } });
      expect(await impact.json()).toMatchObject({ events: expect.any(Number) as unknown, schedules: 3 });
      const archived = await fetch(`${origin}/api/v1/lives/${createdBody.lifeId}/archive`, { headers: authHeaders, method: "POST" });
      expect(await archived.json()).toMatchObject({ archivedAt: fixture.clock.now().toISOString(), state: "STOPPED" });

      const replayed = await fetch(`${origin}/api/v1/lives`, {
        body: JSON.stringify({
          mainAgentConnectionId: agent.agentConnectionId,
          name: "这个名称不会覆盖第一次提交",
          personaSummary: "重复请求必须返回第一次已经持久化的资源，而不是创建另一份数字生命。",
          principles: [],
          timezone: "Asia/Shanghai",
        }),
        headers: { ...authHeaders, "idempotency-key": "create-life-1" },
        method: "POST",
      });
      expect(await replayed.json() as unknown).toMatchObject({ lifeId: createdBody.lifeId, name: "栖遥" });

      const list = await fetch(`${origin}/api/v1/lives?limit=20`, { headers: { cookie } });
      expect(await list.json()).toMatchObject({
        items: [expect.objectContaining({
          autonomousBudgetDailyLimit: 24, lifeId: createdBody.lifeId, name: "栖遥", pendingEventCount: expect.any(Number) as unknown,
          totalBudgetDailyLimit: 100,
        })],
      });
      const agents = await fetch(`${origin}/api/v1/agents`, { headers: { cookie } });
      const agentText = await agents.text();
      expect(agentText).toContain("主 Agent");
      expect(agentText).not.toContain("192.168.1.20");
      expect(agentText.toLowerCase()).not.toContain("token");

      const unauthorized = await fetch(`${origin}/api/v1/lives`);
      expect(unauthorized.status).toBe(401);
      const unauthorizedBody = await unauthorized.json() as { code: string; requestId: string };
      expect(unauthorizedBody.code).toBe("session_invalid");
      expect(unauthorizedBody.requestId).toMatch(/^req_/);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });

  it("replays SSE from an opaque cursor", async () => {
    const fixture = await createRuntimeFixture();
    const handler = createApiHandler(fixture);
    const listeners = await startRuntimeListeners({ handler, loopbackPort: 0 });

    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const sessionResponse = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
        body: JSON.stringify({ nonce: bootstrap.nonce }),
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      const cookie = cookieFrom(sessionResponse);
      await fixture.database.store.appendSseEvent({ entityId: "life_test", payload: { state: "STOPPED" }, type: "life.state.changed" });
      const controller = new AbortController();
      const response = await fetch(`${listeners.loopback.url}/api/v1/stream?cursor=sse_MA`, {
        headers: { cookie },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("missing SSE stream");
      const chunk = await reader.read();
      controller.abort();
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain("event: life.state.changed");
      expect(text).toMatch(/id: sse_[A-Za-z0-9_-]+/);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });

  it("prunes SSE projections older than seven days and resets an expired cursor", async () => {
    const fixture = await createRuntimeFixture();
    const handler = createApiHandler(fixture);
    const listeners = await startRuntimeListeners({ handler, loopbackPort: 0 });

    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const sessionResponse = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
        body: JSON.stringify({ nonce: bootstrap.nonce }),
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      const cookie = cookieFrom(sessionResponse);
      fixture.database.transaction((database) => {
        database.prepare(`INSERT INTO sse_events (event_type, entity_id, payload_json, created_at) VALUES ('old.1', 'runtime', '{}', '2026-07-01T00:00:00.000Z')`).run();
        database.prepare(`INSERT INTO sse_events (event_type, entity_id, payload_json, created_at) VALUES ('old.2', 'runtime', '{}', '2026-07-02T00:00:00.000Z')`).run();
      });
      await fixture.database.store.appendSseEvent({ entityId: "runtime", payload: {}, type: "current" });

      const controller = new AbortController();
      const response = await fetch(`${listeners.loopback.url}/api/v1/stream?cursor=sse_MQ`, { headers: { cookie }, signal: controller.signal });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("missing SSE stream");
      const chunk = await reader.read();
      controller.abort();
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain("event: stream_reset");
      expect(text).toContain('"snapshotRequired":true');
      expect(await fixture.database.store.listSseEvents(0, 100)).toEqual([
        expect.objectContaining({ type: "current" }),
      ]);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });
});
