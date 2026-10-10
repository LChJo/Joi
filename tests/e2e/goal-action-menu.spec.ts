import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A card's action menu opens past the card's own edge, so the card must not clip it.
 *
 * The card used to carry `overflow: hidden` for its rounded corners, which silently cut the menu off
 * at the card's bottom edge — invisible to `toBeVisible` and to any layout assertion, because both
 * only look at the box. This drives the real stylesheet in a real window and hit-tests the last menu
 * row, which is the one that falls outside the card.
 */
test('the goal action menu is not clipped by the card it belongs to', async ({ browserName }) => {
  expect(browserName).toBe('chromium');
  const root = await mkdtemp(path.join(tmpdir(), 'joi-goal-menu-'));
  const entry = path.join(root, 'main.cjs');
  await writeFile(entry, `const {app,BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(path.join(root, 'userdata'))});
app.whenReady().then(()=>{const w=new BrowserWindow({width:1024,height:720,useContentSize:true});w.loadURL('data:text/html,fixture');});`);
  const application = await electron.launch({ args: [entry] });
  try {
    const page = await application.firstWindow();
    const css = await readFile('src/renderer/styles.css', 'utf8');
    await page.setContent(`<body style="margin:0">
      <section class="joi-home"><div class="joi-feed joi-feed-single">
        <article class="joi-goal-card completed">
          <div class="joi-goal-row">
            <button class="joi-goal-open" type="button">
              <span class="workbench-orb">归</span>
              <span class="joi-goal-copy"><small>归档工程</small><strong class="joi-goal-title">一个已经完成的目标</strong><span class="joi-goal-progress"><i>2 Agent · 1 工作完成</i></span></span>
            </button>
            <div class="joi-goal-side">
              <span class="joi-goal-status completed">已完成</span>
              <div class="joi-goal-menu">
                <button aria-expanded="true" aria-haspopup="menu" class="icon-button joi-goal-menu-trigger" type="button">⋯</button>
                <div class="joi-goal-menu-list" role="menu">
                  <button role="menuitem" type="button">继续</button>
                  <button role="menuitem" type="button">归档</button>
                  <button role="menuitem" type="button">移除</button>
                </div>
              </div>
            </div>
          </div>
        </article>
      </div></section>
    </body>`);
    await page.addStyleTag({ content: css });
    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));

    // The trigger's own declarations used to lose to `.icon-button`, which sits later in the same
    // stylesheet at equal specificity: the quiet 28px disc came out as a bordered 38px square, and
    // the button the user actually saw was the one nobody designed. jsdom never applies the
    // stylesheet, so the computed box has to be read here, where the real one is in force.
    const trigger = await page.locator('.joi-goal-menu-trigger').evaluate((element) => {
      const style = getComputedStyle(element);
      return { border: style.borderTopWidth, height: style.height, radius: style.borderRadius, width: style.width };
    });
    expect(trigger).toEqual({ border: '0px', height: '28px', radius: '999px', width: '28px' });

    const card = page.locator('.joi-goal-card');
    const menu = page.locator('.joi-goal-menu-list');
    const cardBox = await card.boundingBox();
    const menuBox = await menu.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(menuBox).not.toBeNull();
    // The fixture is built so the decisive row really does sit below the card; without that the
    // hit-test below would pass for the wrong reason.
    expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeGreaterThan((cardBox?.y ?? 0) + (cardBox?.height ?? 0));

    for (const label of ['继续', '归档', '移除']) {
      const row = page.getByRole('menuitem', { name: label });
      const box = await row.boundingBox();
      expect(box).not.toBeNull();
      // Clipping is invisible to a layout assertion, so ask the document what is actually painted at
      // the row's centre. The comparison has to be by identity: an ancestor's textContent contains
      // every label, so matching on text would report the clip as healthy.
      const paintedIsRow = await row.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element;
      });
      expect(paintedIsRow, `「${label}」被卡片裁掉了`).toBe(true);
    }

    const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    await page.screenshot({ path: path.resolve('test-results/e2e-goal-action-menu.png') });
  } finally { await application.close(); }
});

/**
 * The archived card is the compact shape, and that shape is mostly CSS.
 *
 * jsdom never applies the stylesheet, so the renderer test can only see that the compact markup is
 * what got rendered — not that `.joi-goal-card.archived` is the scope those refinements actually hang
 * off. If that scope ever stops matching, the badge and the ⋯ fall back to the home card's stacked
 * column on a card that is now too short for it, and every jsdom assertion still passes.
 */
test('an archived card lays its chrome out in the compact shape', async ({ browserName }) => {
  expect(browserName).toBe('chromium');
  const root = await mkdtemp(path.join(tmpdir(), 'joi-goal-compact-'));
  const entry = path.join(root, 'main.cjs');
  await writeFile(entry, `const {app,BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(path.join(root, 'userdata'))});
app.whenReady().then(()=>{const w=new BrowserWindow({width:1024,height:720,useContentSize:true});w.loadURL('data:text/html,fixture');});`);
  const application = await electron.launch({ args: [entry] });
  try {
    const page = await application.firstWindow();
    const css = await readFile('src/renderer/styles.css', 'utf8');
    // The markup ArchivedGoals renders: no progress bar, no result preview, the 归档 time in the copy.
    // The second card is the same markup without `.archived`, and exists only as the control below —
    // it is what tells a passing assertion apart from an assertion that would pass either way.
    const compactCard = (extraClass: string) => `
        <article class="joi-goal-card ${extraClass} failed">
          <div class="joi-goal-row">
            <button class="joi-goal-open" type="button">
              <span class="workbench-orb">归</span>
              <span class="joi-goal-copy"><small>归档工程</small><strong class="joi-goal-title">一个已经归档的目标</strong><i>2026/10/9 18:42:27 归档</i></span>
            </button>
            <div class="joi-goal-side">
              <span class="joi-goal-status failed">处理失败</span>
              <div class="joi-goal-menu">
                <button aria-expanded="false" aria-haspopup="menu" class="icon-button joi-goal-menu-trigger" type="button">⋯</button>
              </div>
            </div>
          </div>
        </article>`;
    await page.setContent(`<body style="margin:0">
      <section class="joi-home"><div class="joi-feed joi-feed-single">${compactCard('archived')}${compactCard('control')}</div></section>
    </body>`);
    await page.addStyleTag({ content: css });
    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));

    const shape = await page.evaluate(() => {
      const measure = (card: Element) => {
        const orb = card.querySelector('.workbench-orb');
        const side = card.querySelector('.joi-goal-side');
        if (orb === null || side === null) throw new Error('missing fixture card chrome');
        const centre = (selector: string) => {
          const rect = card.querySelector(selector)?.getBoundingClientRect();
          if (rect === undefined) throw new Error(`missing ${selector}`);
          return rect.y + rect.height / 2;
        };
        return {
          orb: getComputedStyle(orb).width,
          side: getComputedStyle(side).flexDirection,
          // Badge and trigger share the card's right edge on one line rather than stacking.
          badgeAndMenuOnOneLine: Math.abs(centre('.joi-goal-status') - centre('.joi-goal-menu-trigger')) < 1,
        };
      };
      const archived = document.querySelector('.joi-goal-card.archived');
      const control = document.querySelector('.joi-goal-card.control');
      if (archived === null || control === null) throw new Error('missing fixture card');
      return { archived: measure(archived), control: measure(control) };
    });
    expect(shape.archived).toEqual({ orb: '32px', side: 'row', badgeAndMenuOnOneLine: true });
    // Without the scope the same markup falls back to the roomy home card: bigger orb, stacked side.
    expect(shape.control).toEqual({ orb: '44px', side: 'column', badgeAndMenuOnOneLine: false });
    await page.screenshot({ path: path.resolve('test-results/e2e-goal-archived-card.png') });
  } finally { await application.close(); }
});
