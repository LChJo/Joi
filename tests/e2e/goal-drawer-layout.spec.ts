import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('long result headers reserve horizontal labels and home hover only changes the title', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'joi-header-layout-'));
  const entry = path.join(root, 'main.cjs');
  await writeFile(entry, `const {app,BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(path.join(root, 'userdata'))});
app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:800,useContentSize:true});w.loadURL('data:text/html,fixture');});`);
  const application = await electron.launch({ args: [entry] });
  try {
    const page = await application.firstWindow();
    await page.emulateMedia({ colorScheme: 'light' });
    const css = await readFile('src/renderer/styles.css', 'utf8');
    await page.setContent(`<main class="joi-home joi-home-c2"><button class="joi-goal-open"><span class="workbench-orb">项目</span><span class="joi-goal-copy"><strong class="joi-goal-title">合成目标</strong></span></button></main>`);
    await page.addStyleTag({ content: css });
    const open = page.locator('.joi-goal-open');
    await open.hover();
    expect.soft(await open.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    expect.soft(await page.locator('.joi-goal-title').evaluate(element => getComputedStyle(element).color)).toBe('rgb(40, 95, 72)');
    await page.setContent(`<main class="joi-home joi-home-c2"><div class="joi-drawer-backdrop"><section class="joi-goal-drawer joi-result-drawer"><header class="joi-goal-detail-header"><div class="joi-goal-detail-title"><p class="eyebrow">项目工作台</p><h1>${'合成任务包含一段需要完整阅读的长标题。'.repeat(12)}</h1><span class="joi-goal-detail-meta">已完成</span></div><div class="row-actions"><button class="button ghost">查看详情</button><button class="button quiet">关闭</button></div></header><div class="joi-goal-drawer-body">结果正文</div></section></div></main>`);
    await page.addStyleTag({ content: css });
    for (const width of [1280, 768, 480]) {
      await page.setViewportSize({ width, height: 800 });
      const heading = page.locator('.joi-goal-detail-title h1');
      expect(await heading.evaluate(element => getComputedStyle(element).fontSize)).toBe('19px');
      expect((await heading.boundingBox())?.height).toBeLessThanOrEqual(58);
      for (const button of await page.locator('.row-actions button').all()) {
        expect(await button.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('nowrap');
        expect((await button.boundingBox())?.height).toBeLessThanOrEqual(40);
      }
    }
  } finally { await application.close(); }
});

test('goal drawers stay right-aligned and scroll with the mouse wheel', async ({ browserName }) => {
  expect(browserName).toBe('chromium');
  const root = await mkdtemp(path.join(tmpdir(), 'joi-drawer-layout-'));
  const entry = path.join(root, 'main.cjs');
  await writeFile(entry, `const {app,BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(path.join(root, 'userdata'))});
app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:800,useContentSize:true});w.loadURL('data:text/html,fixture');});`);
  const application = await electron.launch({ args: [entry] });
  try {
    const page = await application.firstWindow();
    const css = await readFile('src/renderer/styles.css', 'utf8');
    for (const result of [false, true]) {
      await page.setContent(`<body style="overflow:hidden"><div class="joi-drawer-backdrop"><section class="joi-goal-drawer${result ? ' joi-result-drawer' : ''}"><header class="joi-goal-detail-header"><h1>任务详情</h1></header><div class="joi-goal-drawer-body">${'<p>完整正文滚动测试</p>'.repeat(120)}<p id="tail">全文末尾</p></div>${result ? '<div class="joi-result-export"><button>导出全文</button></div>' : ''}</section></div></body>`);
      await page.addStyleTag({ content: css });
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
      const drawer = page.locator('.joi-goal-drawer');
      // The app reserves a stable root scrollbar gutter; align to its usable viewport.
      const viewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: innerHeight }));
      const box = await drawer.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) - viewport.width)).toBeLessThanOrEqual(1);
      expect(box?.x).toBeGreaterThan(0);
      expect(box?.height).toBeLessThanOrEqual(viewport.height + 1);
      const body = page.locator('.joi-goal-drawer-body');
      await body.hover();
      await page.mouse.wheel(0, 700);
      await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(page.locator('#tail')).toBeInViewport();
      if (result) await expect(page.getByRole('button', { name: '导出全文' })).toBeInViewport();
    }
  } finally { await application.close(); }
});

test('a long agent list scrolls inside its own column instead of the drawer', async ({ browserName }) => {
  expect(browserName).toBe('chromium');
  const root = await mkdtemp(path.join(tmpdir(), 'joi-drawer-agents-'));
  const entry = path.join(root, 'main.cjs');
  await writeFile(entry, `const {app,BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(path.join(root, 'userdata'))});
app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:800,useContentSize:true});w.loadURL('data:text/html,fixture');});`);
  const application = await electron.launch({ args: [entry] });
  try {
    const page = await application.firstWindow();
    const css = await readFile('src/renderer/styles.css', 'utf8');
    const agent = '<button class="joi-goal-agent"><span class="agent-workbench">飞</span><span class="joi-goal-agent-copy"><strong>飞书操作搭档</strong><small>LOCAL · pi-core</small></span><i class="agent-status completed">COMPLETED</i></button>';
    await page.setContent(`<body style="overflow:hidden"><div class="joi-drawer-backdrop"><section class="joi-goal-drawer"><header class="joi-goal-detail-header"><h1>任务详情</h1></header><div class="joi-goal-drawer-body"><div class="joi-goal-detail-body"><aside aria-label="这条目标的 Agent 列表" class="joi-goal-agents">${agent.repeat(20)}</aside><div class="joi-goal-stream"><div class="agent-stream-viewport"><div class="agent-message-stream">${'<article class="agent-message user"><header><strong>任务</strong></header><p>正文</p></article>'.repeat(40)}</div></div></div></div></div></section></div></body>`);
    await page.addStyleTag({ content: css });
    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
    const height = await page.evaluate(() => innerHeight);
    const agents = page.locator('.joi-goal-agents');
    const stream = page.locator('.joi-goal-stream');
    // The list is capped, so it scrolls itself rather than growing the drawer.
    expect(await agents.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await agents.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(Math.round(height * 0.65) + 1);
    await agents.hover();
    await page.mouse.wheel(0, 700);
    await expect.poll(() => agents.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    // That scrollbar sits at the list's own right edge, left of the message stream.
    const [agentsBox, streamBox] = [await agents.boundingBox(), await stream.boundingBox()];
    expect(agentsBox).not.toBeNull();
    expect(streamBox).not.toBeNull();
    expect((agentsBox?.x ?? 0) + (agentsBox?.width ?? 0)).toBeLessThanOrEqual(streamBox?.x ?? 0);
    // The drawer body itself no longer has to scroll for the agent list.
    const body = page.locator('.joi-goal-drawer-body');
    expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  } finally { await application.close(); }
});
