import { _electron as electron,expect,test,type Page } from "@playwright/test";
import { setDesktopTestLocale } from "./locale";
import { mkdir } from "node:fs/promises";

async function expectExtensionSwitches(page: Page) {
  const switches = page.getByRole("dialog",{ name: "扩展" }).getByRole("switch");
  await expect(switches).toHaveCount(3);
  for (const control of await switches.all()) {
    const shape = await control.evaluate(element => {
      const box = element.getBoundingClientRect(),style = getComputedStyle(element),thumb = getComputedStyle(element,"::before");
      return { width: box.width,height: box.height,padding: style.padding,margin: style.margin,thumbWidth: thumb.width,thumbHeight: thumb.height,thumbTop: thumb.top,thumbLeft: thumb.left,transform: thumb.transform,checked: (element as HTMLInputElement).checked };
    });
    expect(shape).toMatchObject({ width: 32,height: 18,padding: "0px",margin: "0px",thumbWidth: "12px",thumbHeight: "12px",thumbTop: "2px",thumbLeft: "2px" });
    expect(shape.transform).toBe(shape.checked ? "matrix(1, 0, 0, 1, 14, 0)" : "none");
  }
  await expect(page.locator(".chat-extension-list small")).toHaveCount(0);
}

function colorContrast(colors: { foreground: string;background: string }) {
  const luminance = (color: string) => { const rgb=(color.match(/\d+/g) ?? []).slice(0,3).map(Number).map(v => { const s=v/255;return s<=.04045 ? s/12.92 : ((s+.055)/1.055)**2.4; });return .2126*(rgb[0] ?? 0)+.7152*(rgb[1] ?? 0)+.0722*(rgb[2] ?? 0); };
  const a=luminance(colors.foreground),b=luminance(colors.background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
}

test("normal conversation layout, independent selectors, inherited context and Git diff", async () => {
  test.setTimeout(60_000);
  const app = await electron.launch({ args: ["."],env: { ...process.env,JOI_TEST: "1" } });
  try {
    const page = await app.firstWindow();await setDesktopTestLocale(page,"zh-CN");
    await page.getByLabel("管理密码").fill("conversation fixture password");await page.getByLabel("确认密码").fill("conversation fixture password");
    await page.getByRole("button",{ name: /保存并继续/ }).click();await page.getByRole("button",{ name: /先只用本机/ }).click();await page.getByRole("button",{ name: "暂时跳过" }).click();
    const sent: Record<string,unknown>[] = [];
    const wb = { workbenchId: "joi",name: "Joi 产品研发",scopeSummary: "Product",updatedAt: "2026-11-11" };
    const toolParameters = 'rg -n "memory|cache|dispose|cleanup|listener" src/main/modules/cowork/runtime.ts src/main/modules/cowork/conversation/aggregator.ts';
    const chat = { conversationId: "chat",workbenchId: "joi",title: "优化首页的输入体验",updatedAt: "2026-11-11",turns: [{ turnId: "t1",text: "保留工作台选择和附件，让输入框更轻。",status: "COMPLETED",createdAt: "2026-11-11",config: { partnerId: "joi-chat",partnerName: "joi",networkId: "network",networkName: "研发网络",modelName: "Configured model",skills: ["user/design"],attachmentIds: [] },artifacts: [{ name: "ConversationPage.tsx",size: 2400 }],entries: [...["ls","bash"].flatMap((name,index) => [{ entryId: `call-${String(index)}`,toolCallId: `tool-${String(index)}`,sequence: index * 2,createdAt: "2026-11-11",kind: "TOOL_CALL",role: "TOOL",toolName: name,text: index === 0 ? "src/renderer" : toolParameters,toolState: "started" },{ entryId: `result-${String(index)}`,toolCallId: `tool-${String(index)}`,sequence: index * 2 + 1,createdAt: "2026-11-11",kind: "TOOL_RESULT",role: "TOOL",toolName: name,toolState: index === 0 ? "completed" : "failed",text: "PRIVATE_TOOL_RESULT" }]),{ entryId: "e1",sequence: 5,createdAt: "2026-11-11",kind: "MARKDOWN",role: "AGENT",text: "输入框采用更轻的结构，保留熟悉的操作。\n\n### 让常用操作留在手边\n\n- **正文优先**：输入区域与操作栏分层。\n- **上下文清晰**：工作台归属始终可见。\n\n```css\n.composer {\n  border-radius: 14px;\n}\n```\n\n| 区域 | 行为 |\n| --- | --- |\n| 工作台 | 首次发送后锁定 |\n| 模型网络 | 来自设置 |" }] }] };
    const displayedChat = { ...chat,context: { kind: "CHARACTERS",state: "COMPACTING",requestChars: 100,budgetChars: 1000,missingHistory: true },turns: chat.turns.map(turn => ({ ...turn,entries: [
      { entryId: "older-thinking",sequence: 0,createdAt: "2026-11-12",kind: "ACTIVITY",role: "SYSTEM",activity: { type: "THINKING",thinking: { phaseId: "older-phase",state: "COMPLETED",durationMs: 80,summary: "Earlier thinking must stay hidden" } } },
      { entryId: "thinking",sequence: 0,createdAt: "2026-11-12",kind: "ACTIVITY",role: "SYSTEM",activity: { type: "THINKING",thinking: { phaseId: "phase",state: "COMPLETED",durationMs: 1250,summary: "已定位组件与工具调用边界。" } } },...turn.entries,
    ] })) };
    await page.route("**/api/v1/**",async route => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown;
      if (path === "/api/v1/workbenches") body = { items: [wb] };
      else if (path === "/api/v1/model-sources") body = { items: [{ sourceId: "network",displayName: "研发网络",activeModel: { id: "Configured model" },status: "READY" }] };
      else if (path === "/api/v1/partners") body = { items: [] };
      else if (path === "/api/v1/conversations" && route.request().method() === "POST") { const input = route.request().postDataJSON() as Record<string,unknown>;sent.push(input);body = { ...displayedChat,conversationId: input.conversationId }; }
      else if (path === "/api/v1/conversations") body = { items: [chat] };
      else if (path.startsWith("/api/v1/conversations/")) body = displayedChat;
      else if (path.includes("/skills")) body = { items: [{ id: "user/design",displayName: "design-taste" }] };
      else if (path.includes("conversation-inheritance")) body = { memoryCount: 3,evolutionRevisionId: "method-active" };
      else if (path.endsWith("/git") && path.includes("conversation-workspaces")) body = { available: true,branch: "main",branches: ["main","feature/chat"],ahead: 1,behind: 0,files: [{ path: "src/renderer/ConversationPage.tsx",index: " ",workingTree: "M" }],history: [{ hash: "b602f34",message: "Refine conversation composer",date: "2026-11-11" }] };
      else if (path.endsWith("/diff")) body = { patch: "diff --git a/composer.css b/composer.css\n--- a/composer.css\n+++ b/composer.css\n@@ -1 +1 @@\n-border-radius: 8px;\n+border-radius: 14px;\n",truncated: false };
      else if (path === "/api/v1/joi/runtime") body = {};
      else if (path === "/api/v1/interactions") body = { items: [] };
      else { await route.continue();return; }
      await route.fulfill({ json: body });
    });
    await page.setViewportSize({ width: 1600,height: 1000 });
    await page.getByRole("navigation",{ name: "主导航" }).getByRole("button",{ name: "对话",exact: true }).click();
    await expect(page.getByRole("heading",{ name: "今天想一起做点什么？" })).toBeVisible();
    await expect(page.locator(".conversation-workspace")).toBeHidden();
    await expect(page.getByRole("button",{ name: "显示或收起工作区" })).toHaveCount(0);
    await expect(page.locator(".chat-context-strip")).toBeVisible();
    const sendButton = page.getByRole("button",{ name: "发送消息" });
    await expect(sendButton).toBeDisabled();
    await page.getByRole("button",{ name: "扩展",exact: true }).click();
    await expect(page.getByRole("switch",{ name: "子代理",exact: true })).toBeChecked();
    await expect(page.getByRole("switch",{ name: "OpenWiki",exact: true })).toHaveCount(0);
    for (const name of ["Agent Browser","CC Safety Net"]) await expect(page.getByRole("switch",{ name,exact: true })).not.toBeChecked();
    await page.getByRole("switch",{ name: "Agent Browser",exact: true }).check();
    await page.getByRole("switch",{ name: "CC Safety Net",exact: true }).check();
    await expectExtensionSwitches(page);
    await page.screenshot({ path: "test-results/conversation-extensions.png" });
    await page.keyboard.press("Escape");await expect(page.getByRole("button",{ name: "扩展",exact: true })).toBeFocused();
    expect(await page.locator(".chat-composer-toolbar").evaluate(element => [...element.querySelectorAll(":scope > button, :scope > .chat-picker > button")].map(button => button.getAttribute("aria-label"))))
      .toEqual(["附件","大模型网络","搭档","Skills","扩展","前往大模型网络设置","发送消息"]);
    const sendShape = await sendButton.evaluate(element => { const box=element.getBoundingClientRect();return { width: box.width,height: box.height,radius: parseFloat(getComputedStyle(element).borderRadius) }; });
    expect(sendShape.width).toBeGreaterThanOrEqual(32);expect(sendShape.width).toBeLessThanOrEqual(36);expect(sendShape.height).toBe(sendShape.width);expect(sendShape.radius).toBeLessThanOrEqual(8);
    const expandedWidth = await page.locator(".sidebar").evaluate(element => element.getBoundingClientRect().width);
    await page.getByRole("button",{ name: "收起主导航" }).click();
    expect(await page.locator(".sidebar").evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(expandedWidth);
    await page.getByRole("button",{ name: "展开主导航" }).click();
    await expect(page.getByRole("heading",{ name: "今天想一起做点什么？" })).toBeVisible();
    await page.getByRole("button",{ name: "大模型网络",exact: true }).click();await expect(page.getByRole("option",{ name: /研发网络/ })).toBeVisible();
    await page.getByRole("option",{ name: /研发网络/ }).click();
    await page.locator(".chat-composer").getByRole("button",{ name: "搭档",exact: true }).click();await page.getByRole("option",{ name: /joi/ }).click();
    await page.getByRole("textbox",{ name: "消息" }).fill("让输入框更轻");await page.getByRole("button",{ name: "发送消息" }).click();
    await expect(page.locator(".chat-context-strip")).toHaveCount(0);expect(sent).toHaveLength(1);expect(sent[0]).not.toHaveProperty("modelId");expect(sent[0]?.piExtensions).toEqual(["agent-browser","cc-safety-net"]);
    await expect(page.locator(".chat-output table")).toBeVisible();
    const tools = page.locator(".chat-tool-group"),toolSummary = tools.locator("summary");
    await expect(toolSummary).toContainText("bash");await expect(toolSummary).toContainText("共 2 次");
    await expect(toolSummary).toContainText(toolParameters);await expect(toolSummary).toContainText("执行失败");
    await expect(toolSummary.locator("code")).toHaveAttribute("title",toolParameters);
    await expect(toolSummary).toContainText("思考完成");await expect(toolSummary).toContainText("正在摘要历史");
    await expect(page.getByText(/思考完成/)).toHaveCount(1);await expect(page.getByText("Earlier thinking must stay hidden")).toHaveCount(0);
    expect(await toolSummary.locator(".chat-activity-brief").evaluate(element => getComputedStyle(element).color))
      .not.toBe(await toolSummary.evaluate(element => getComputedStyle(element).color));
    await expect(page.locator(".chat-compose-area .chat-runtime-context")).toHaveCount(0);
    expect((await toolSummary.boundingBox())?.height).toBeLessThanOrEqual(64);
    await expect(tools.locator("li").first()).toBeHidden();await toolSummary.focus();await page.keyboard.press("Enter");
    await expect(tools.locator("li").first()).toContainText("ls");await expect(tools.locator("li").first()).toBeVisible();
    await expect(tools.locator("li").first()).toContainText("src/renderer");await expect(tools.locator("li").first()).toContainText("已完成");
    await expect(tools.getByRole("status")).toContainText("100 / 1000");await expect(tools.getByText("已定位组件与工具调用边界。")).toBeVisible();
    await expect(page.getByText("导入历史不含完整的私有工具记录。")).toHaveCount(0);
    await expect(tools.locator("li").last()).toHaveAttribute("data-tool-state","failed");
    await expect(tools).not.toContainText("PRIVATE_TOOL_RESULT");await page.screenshot({ path: "test-results/conversation-tool-details.png" });
    await toolSummary.click();await page.screenshot({ path: "test-results/conversation-tools-compact.png" });
    await page.getByRole("button",{ name: "显示或收起工作区" }).click();
    const workspace = page.locator(".conversation-workspace"),separator = page.getByRole("separator",{ name: "调整工作区宽度" });
    const beforeWidth = await workspace.evaluate(element => element.getBoundingClientRect().width);
    const divider = await separator.boundingBox();if (divider === null) throw new Error("Missing workspace divider");
    await page.mouse.move(divider.x + divider.width / 2,divider.y + 130);await page.mouse.down();await page.mouse.move(divider.x - 100,divider.y + 130,{ steps: 8 });await page.mouse.up();
    expect(await workspace.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(beforeWidth + 80);
    await separator.focus();await page.keyboard.press("Home");await expect(separator).toHaveAttribute("aria-valuenow","280");
    await mkdir("test-results",{ recursive: true });await page.screenshot({ path: "test-results/conversation-production.png" });
    await page.getByRole("button",{ name: "Git",exact: true }).click();await page.getByRole("button",{ name: /^src\/renderer\/ConversationPage/ }).click();
    await page.getByRole("button",{ name: "并排视图" }).click();await expect(page.locator(".chat-diff-columns")).toBeVisible();await page.screenshot({ path: "test-results/conversation-production-diff.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    const contrast = await page.locator(".conversation-center").evaluate(element => {
      const luminance = (color: string) => { const rgb = (color.match(/\d+/g) ?? []).slice(0,3).map(Number).map(v => { const s=v/255;return s<=0.04045 ? s/12.92 : ((s+0.055)/1.055)**2.4; });return 0.2126*(rgb[0] ?? 0)+0.7152*(rgb[1] ?? 0)+0.0722*(rgb[2] ?? 0); };
      const style=getComputedStyle(element),a=luminance(style.color),b=luminance(style.backgroundColor);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);await page.screenshot({ path: "test-results/conversation-production-dark.png" });
    await page.getByRole("button",{ name: "扩展",exact: true }).click();await expectExtensionSwitches(page);await page.screenshot({ path: "test-results/conversation-extensions-dark.png" });await page.keyboard.press("Escape");await page.emulateMedia({ colorScheme: "light" });
    for (const colorScheme of ["light","dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(sendButton).toBeDisabled();
      await expect.poll(async () => colorContrast(await sendButton.evaluate(element => { const style=getComputedStyle(element);return { foreground: style.color,background: style.backgroundColor }; }))).toBeGreaterThanOrEqual(3);
      await page.getByRole("textbox",{ name: "消息" }).fill("继续讨论");await expect(sendButton).toBeEnabled();
      await expect.poll(async () => colorContrast(await sendButton.evaluate(element => { const style=getComputedStyle(element);return { foreground: style.color,background: style.backgroundColor }; }))).toBeGreaterThanOrEqual(4.5);
      await sendButton.focus();await page.keyboard.press("Shift+Tab");await page.keyboard.press("Tab");await expect(sendButton).toBeFocused();
      expect(await sendButton.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
      await page.getByRole("textbox",{ name: "消息" }).fill("");
    }
    await page.emulateMedia({ colorScheme: "light" });
    for (const size of [{ width: 1180,height: 850 },{ width: 720,height: 900 },{ width: 390,height: 844 }]) {
      await page.setViewportSize(size);if (await page.locator(".conversation-workspace").isVisible()) await page.getByRole("button",{ name: "显示或收起工作区" }).click();
      if (size.width <= 720 && await page.locator(".conversation-history").isVisible()) await page.getByRole("button",{ name: "显示或收起对话列表" }).click();
      const dimensions = await page.evaluate(() => ({ viewport: innerWidth,width: document.documentElement.scrollWidth,overflow: [...document.querySelectorAll(".app-shell,.console-main,.conversation-layout,.conversation-center,.chat-compose-area")].map(el => ({ class: el.className,width: el.getBoundingClientRect().width,right: el.getBoundingClientRect().right })) }));
      await page.screenshot({ path: `test-results/conversation-${String(size.width)}.png` });
      expect(dimensions.width,JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport);
      await expect(page.getByRole("textbox",{ name: "消息" })).toBeVisible();
      if (size.width === 390) {
        await page.getByRole("button",{ name: "扩展",exact: true }).click();
        await expectExtensionSwitches(page);
        const extensionBounds = await page.getByRole("dialog",{ name: "扩展" }).boundingBox();
        expect(extensionBounds?.x).toBeGreaterThanOrEqual(0);expect((extensionBounds?.x ?? 0) + (extensionBounds?.width ?? 0)).toBeLessThanOrEqual(390);
        await page.screenshot({ path: "test-results/conversation-extensions-mobile.png" });await page.keyboard.press("Escape");
        await toolSummary.click();await expect(tools.locator("li").last().locator("code")).toHaveText(toolParameters);
        const toolWidth = await tools.locator("li").last().evaluate(element => ({ width: element.clientWidth,scrollWidth: element.scrollWidth }));
        expect(toolWidth.scrollWidth).toBeLessThanOrEqual(toolWidth.width);
        await page.screenshot({ path: "test-results/conversation-tool-details-mobile.png" });await toolSummary.click();
        await page.screenshot({ path: "test-results/conversation-production-mobile.png" });
        await page.getByRole("button",{ name: "展开主导航" }).click();
        await expect(page.getByRole("button",{ name: "收起主导航" })).toBeVisible();
        await page.getByRole("button",{ name: "收起主导航" }).click();
        await page.getByRole("textbox",{ name: "消息" }).fill("窄屏可继续输入");
      }
    }
  } finally { await app.close(); }
});
