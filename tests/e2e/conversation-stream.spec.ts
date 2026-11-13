import { _electron as electron,expect,test } from "@playwright/test";
import { createServer,type ServerResponse } from "node:http";
import { setDesktopTestLocale } from "./locale";
import type { ConversationDto,ConversationUpdateDto } from "../../src/shared/conversations";

test("CHAT-45 Electron renders live prefixes before a paused refresh and retains stopped output",async () => {
  test.setTimeout(60_000);
  const connected = Promise.withResolvers<ServerResponse>(),releaseRefresh = Promise.withResolvers<undefined>();
  let origin = "";
  const server = createServer((_request,response) => {
    response.writeHead(200,{ "content-type": "text/event-stream","access-control-allow-origin": origin,"access-control-allow-credentials": "true" });
    response.flushHeaders();connected.resolve(response);
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address = server.address();if (address === null || typeof address === "string") throw new Error("Missing stream listener");
  const streamUrl = `http://127.0.0.1:${String(address.port)}/stream`;
  const app = await electron.launch({ args: ["."],env: { ...process.env,JOI_TEST: "1" } });
  try {
    const page = await app.firstWindow();await setDesktopTestLocale(page,"zh-CN");origin = new URL(page.url()).origin;
    await page.getByLabel("管理密码").fill("stream fixture password");await page.getByLabel("确认密码").fill("stream fixture password");
    await page.getByRole("button",{ name: /保存并继续/ }).click();await page.getByRole("button",{ name: /先只用本机/ }).click();await page.getByRole("button",{ name: "暂时跳过" }).click();
    const turn: ConversationDto["turns"][number] = { turnId: "turn",text: "Show a streamed answer",status: "RUNNING",createdAt: "2026-11-13T00:00:00Z",
      config: { partnerId: "joi-chat",partnerName: "joi",networkId: "network",networkName: "Network",modelName: "model",skills: [],attachmentIds: [] },entries: [],artifacts: [] };
    const chat: ConversationDto = { conversationId: "chat",workbenchId: "wb",title: "实时回答",updatedAt: turn.createdAt,turns: [turn] };
    let reads = 0;
    await page.route("**/api/v1/**",async route => {
      const path = new URL(route.request().url()).pathname;let body: unknown;
      if (path.endsWith("/chat/stream")) { await route.continue({ url: streamUrl });return; }
      if (path === "/api/v1/workbenches") body = { items: [{ workbenchId: "wb",name: "Project",scopeSummary: "Project",updatedAt: turn.createdAt }] };
      else if (path === "/api/v1/model-sources" || path === "/api/v1/partners" || path.endsWith("/skills")) body = { items: [] };
      else if (path.includes("conversation-inheritance")) body = { memoryCount: 0,evolutionRevisionId: null };
      else if (path === "/api/v1/conversations") body = { items: [chat] };
      else if (path.endsWith("/chat/stop")) { turn.status = "STOPPED";body = { stopped: true };releaseRefresh.resolve(undefined); }
      else if (path.endsWith("/chat")) { if (++reads > 1 && turn.status === "RUNNING") await releaseRefresh.promise;body = chat; }
      else if (path === "/api/v1/joi/runtime") body = {};
      else if (path === "/api/v1/interactions") body = { items: [] };
      else { await route.continue();return; }
      await route.fulfill({ json: body });
    });
    await page.getByRole("navigation",{ name: "主导航" }).getByRole("button",{ name: "对话",exact: true }).click();
    await page.getByRole("button",{ name: "实时回答",exact: true }).click();
    const response = await connected.promise;
    const publish = (text: string) => {
      turn.entries = [{ entryId: "answer",sequence: 1,createdAt: turn.createdAt,kind: "MARKDOWN",role: "AGENT",text }];
      const update: ConversationUpdateDto = { conversationId: "chat",turn };
      response.write(`event: conversation\ndata: ${JSON.stringify(update)}\n\n`);
    };
    publish("第一段正在到达");await expect(page.getByText("第一段正在到达",{ exact: true })).toBeVisible();
    await expect(page.getByText("正在处理…",{ exact: true })).toBeVisible();
    await page.getByRole("textbox",{ name: "消息" }).fill("保留下一条草稿");
    publish("第一段正在到达，后续文字继续追加");await expect(page.getByText("第一段正在到达，后续文字继续追加",{ exact: true })).toBeVisible();
    await expect(page.getByRole("textbox",{ name: "消息" })).toHaveValue("保留下一条草稿");
    await page.getByRole("button",{ name: "停止生成" }).click();await expect(page.getByText("已停止",{ exact: true })).toBeVisible();
    await expect(page.getByText("第一段正在到达，后续文字继续追加",{ exact: true })).toBeVisible();
    await expect.poll(() => response.destroyed).toBe(true);
  } finally {
    releaseRefresh.resolve(undefined);await app.close();server.closeAllConnections();await new Promise<void>((resolve,reject) => server.close(error => error === undefined ? resolve() : reject(error)));
  }
});
