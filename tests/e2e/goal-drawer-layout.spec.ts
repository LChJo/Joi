import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
