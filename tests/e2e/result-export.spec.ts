import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

for (const storage of ['normal storage', 'storage without hard links'] as const) {
test(`isolated Electron renders complete PDF and continuous PNG exports on ${storage}`, async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(tmpdir(), 'joi-export-e2e-'));
  const entry = path.join(root, 'main.cjs');
  const output = testInfo.outputPath('exports');
  await mkdir(output, { recursive: true });
  const body = '# 中文全文起点\n\n[链接](https://example.com)\n\n| 列一 | 列二 |\n|---|---|\n| 数据 | 长链接 https://example.com/' + 'long'.repeat(50) + ' |\n\n```ts\n' + 'veryLongCode'.repeat(120) + '\n```\n\n' + Array.from({ length: 180 }, (_, i) => `段落 ${String(i)} 中文内容完整保留。\n\n`).join('') + '全文终点 END';
  await writeFile(entry, `
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs/promises'); const path = require('node:path');
const withoutHardLinks = ${String(storage === 'storage without hard links')};
if (withoutHardLinks && process.env.JOI_E2E_EXPORT_REAL_VOLUME !== '1') {
  fs.link = async () => { throw Object.assign(new Error('Hard links unavailable'), {code: 'EISDIR'}); };
  require('node:module').syncBuiltinESMExports();
}
app.setPath('userData', ${JSON.stringify(path.join(root, 'userdata'))});
app.whenReady().then(async () => {
  const keeper = new BrowserWindow({show:false,width:1080,height:8192,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false}}); await keeper.loadURL('data:text/html,ready');
  const { ElectronResultExporter } = await import(${JSON.stringify(pathToFileURL(path.resolve('dist/electron/main/infrastructure/artifacts/electron-result-export.js')).href)});
  const { resultExportHtml } = await import(${JSON.stringify(pathToFileURL(path.resolve('dist/electron/main/infrastructure/artifacts/result-export-html.js')).href)});
  const records = new Map();
  const jobs = { record: id => records.get(id), update: (id,status,filenames=[],errorCode) => Object.assign(records.get(id), { status, filenames, errorCode }) };
  const exporter = new ElectronResultExporter({ jobs, downloads: ${JSON.stringify(output)}, fontPath: ${JSON.stringify(path.resolve('resources/fonts/NotoSansSC.ttf'))} });
  for (const format of ['pdf','png']) {
    const id = format; records.set(id,{exportId:id,status:'queued',format,body:${JSON.stringify(body)},basename:'result',filenames:[]});
    await exporter.handle(id);
    const job = records.get(id);
    if (format === 'png' && job.status === 'completed') {
      const images = await Promise.all(job.filenames.map(async name => nativeImage.createFromBuffer(await fs.readFile(path.join(${JSON.stringify(output)},'Joi',name)))));
      job.dimensions = images.map(image => image.getSize());
      const html = resultExportHtml(${JSON.stringify(body)}, (await fs.readFile(${JSON.stringify(path.resolve('resources/fonts/NotoSansSC.ttf'))})).toString('base64'));
      keeper.webContents.session.protocol.handle('export-reference', () => new Response(html, {headers:{'content-type':'text/html; charset=utf-8'}}));
      await keeper.loadURL('export-reference://document/index');
      await keeper.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      keeper.webContents.debugger.attach('1.3');
      await keeper.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {width:1080,height:800,deviceScaleFactor:1,mobile:false});
      const height = await keeper.webContents.executeJavaScript("document.documentElement.style.overflow='hidden'; Math.ceil(document.querySelector('main').getBoundingClientRect().height)");
      const full = await keeper.webContents.debugger.sendCommand('Page.captureScreenshot', {format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:1080,height,scale:1}});
      await fs.writeFile(${JSON.stringify(path.join(output, 'reference.png'))}, Buffer.from(full.data,'base64'));
      const reference = nativeImage.createFromBuffer(Buffer.from(full.data,'base64')).toBitmap();
      job.pixelsMatchFullDocument = Buffer.concat(images.map(image => image.toBitmap())).equals(reference);
      job.includesEnd = await keeper.webContents.executeJavaScript("document.querySelector('main').textContent.includes('END')");
    }
    const before = JSON.stringify(job.filenames);
    const firstImage = format === 'png' && withoutHardLinks && job.status === 'completed'
      ? path.join(${JSON.stringify(output)}, 'Joi', job.filenames[0]) : null;
    const imageBytes = firstImage && await fs.readFile(firstImage);
    if (firstImage) await fs.truncate(firstImage, 16);
    job.status = 'queued';
    await exporter.handle(id);
    job.recovered = before === JSON.stringify(job.filenames) && (!firstImage || imageBytes.equals(await fs.readFile(firstImage)));
  }
  const pdfPath = path.join(${JSON.stringify(output)}, 'Joi', 'result.pdf');
  const original = await fs.readFile(pdfPath).catch(() => null);
  records.set('collision', {exportId:'collision',status:'queued',format:'pdf',body:'different body',basename:'result',filenames:[]});
  if (original) await exporter.handle('collision');
  records.get('pdf').collisionProtected = Boolean(original && records.get('collision').status === 'failed' && original.equals(await fs.readFile(pdfPath)));
  records.delete('collision');
  records.set('short', {exportId:'short',status:'queued',format:'png',body:'Short result END',basename:'short',filenames:[]});
  await exporter.handle('short');
  records.get('png').singleImage = records.get('short').status === 'completed' && records.get('short').filenames.length === 1;
  records.delete('short');
  if (withoutHardLinks && records.get('png').status === 'completed') {
    const first = path.join(${JSON.stringify(output)}, 'Joi', 'multi-001.png');
    const collision = path.join(${JSON.stringify(output)}, 'Joi', 'multi-002.png');
    await fs.writeFile(collision, 'existing file', { flag: 'wx' });
    records.set('rollback', {exportId:'rollback',status:'queued',format:'png',body:${JSON.stringify(body)},basename:'multi',filenames:[]});
    await exporter.handle('rollback');
    const firstRemoved = await fs.stat(first).then(() => false, error => error.code === 'ENOENT');
    records.get('png').rollbackProtected = records.get('rollback').status === 'failed' && firstRemoved && await fs.readFile(collision, 'utf8') === 'existing file';
    records.delete('rollback');
  }
  await fs.writeFile(${JSON.stringify(path.join(output, 'report.json'))}, JSON.stringify([...records.values()].map(({body,...safe})=>safe)));
  const win = new BrowserWindow({show:false}); await win.loadURL('data:text/html,ready');
}).catch(async () => { await fs.writeFile(${JSON.stringify(path.join(output, 'report.json'))}, '[]'); });
`);
  const application = await electron.launch({ args: [entry] });
  try {
    await expect.poll(async () => { try { return JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8')) as unknown[]; } catch { return []; } }, { timeout: 100_000 }).toHaveLength(2);
    const report = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8')) as { status: string; format: string; recovered: boolean; collisionProtected?: boolean; rollbackProtected?: boolean; singleImage?: boolean; pixelsMatchFullDocument?: boolean; includesEnd?: boolean; dimensions?: { width: number; height: number }[] }[];
    expect(report.map(r => ({ format: r.format, status: r.status, recovered: r.recovered }))).toEqual([
      { format: 'pdf', status: 'completed', recovered: true },
      { format: 'png', status: 'completed', recovered: true },
    ]);
    const png = report.find(r => r.format === 'png');
    expect(png?.dimensions?.length).toBeGreaterThan(1);
    expect(png?.dimensions?.every(d => d.width === 1080 && d.height <= 8192)).toBe(true);
    expect(png?.pixelsMatchFullDocument).toBe(true);
    expect(png?.includesEnd).toBe(true);
    expect(png?.singleImage).toBe(true);
    if (storage === 'storage without hard links') expect(png?.rollbackProtected).toBe(true);
    expect(report.find(r => r.format === 'pdf')?.collisionProtected).toBe(true);
    const pdf = await readFile(path.join(output, 'Joi/result.pdf'));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    await testInfo.attach('export-report', { body: JSON.stringify(report), contentType: 'application/json' });
  } finally { await application.close(); }
});
}
