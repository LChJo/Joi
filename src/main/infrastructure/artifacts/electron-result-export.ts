import { BrowserWindow, session, shell } from "electron";
import { mkdir, readFile, writeFile, lstat, realpath, unlink, link } from "node:fs/promises";
import path from "node:path";
import { exportSlices } from "../../../shared/result-export.js";
import type { ExportRecord } from "../persistence/sqlite-result-exports.js";
import { resultExportHtml } from "./result-export-html.js";

/** Stage by durable ID, publish using exclusive hard links, and recover only
 * links to those same staged files. User files are never overwritten. */
export class ElectronResultExporter {
  constructor(private readonly deps: { jobs: {
    record(id: string): ExportRecord | null | Promise<ExportRecord | null>;
    update(id: string, status: ExportRecord['status'], filenames?: string[], error?: string): void | Promise<void>;
  }; downloads: string; fontPath: string }) {}
  async handle(id: string): Promise<void> {
    const job = await this.deps.jobs.record(id);
    if (!job || job.status === 'completed' || job.status === 'failed') return;
    if (!/^[a-zA-Z0-9-]+$/.test(job.exportId) || path.basename(job.basename) !== job.basename) throw new Error('export_invalid');
    const root = path.join(this.deps.downloads, 'Joi');
    const staging = path.join(root, `.pending-${job.exportId}`);
    let win: BrowserWindow | undefined;
    const created: string[] = [];
    const publish = async (names: string[]) => {
      for (const name of names) {
        if (path.basename(name) !== name || !name.startsWith(job.basename) || !/\.(pdf|png)$/.test(name)) throw new Error('unsafe');
        const source = path.join(staging, name); const target = path.join(root, name);
        const sourceStat = await lstat(source);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('unsafe');
        if (!created.includes(source)) created.push(source);
        try { await link(source, target); }
        catch {
          const targetStat = await lstat(target);
          if (targetStat.isSymbolicLink() || sourceStat.ino !== targetStat.ino || sourceStat.dev !== targetStat.dev) throw new Error('export_collision');
        }
      }
    };
    const writeStaged = async (name: string, bytes: Uint8Array) => {
      const file = path.join(staging, name);
      try { if ((await lstat(file)).isSymbolicLink()) throw new Error('unsafe'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      created.push(file);
      await writeFile(file, bytes);
    };
    try {
      await mkdir(root, { recursive: true });
      if ((await lstat(root)).isSymbolicLink()) throw new Error('unsafe');
      await mkdir(staging, { recursive: true });
      if ((await lstat(staging)).isSymbolicLink()) throw new Error('unsafe');
      let manifest: string | null = null;
      try { manifest = await readFile(path.join(staging, 'manifest.json'), 'utf8'); } catch { /* Rendering was interrupted before publication. */ }
      if (manifest !== null) {
        const names = JSON.parse(manifest) as string[];
        await publish(names);
        await this.deps.jobs.update(id, 'completed', names); return;
      }
      await this.deps.jobs.update(id, 'rendering');
      const isolated = session.fromPartition(`result-export-${id}`);
      isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== 'joi-export://document/index' && !details.url.startsWith('data:font/') }));
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      win = new BrowserWindow({ show: false, width: 1080, height: 8192, useContentSize: true, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      const font = (await readFile(this.deps.fontPath)).toString('base64');
      const html = resultExportHtml(job.body, font);
      isolated.protocol.handle('joi-export', request => new Response(request.url === 'joi-export://document/index' ? html : '', { status: request.url === 'joi-export://document/index' ? 200 : 404, headers: { 'content-type': 'text/html; charset=utf-8' } }));
      await win.loadURL('joi-export://document/index');
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      const names: string[] = [];
      if (job.format === 'pdf') {
        const name = `${job.basename}.pdf`;
        await writeStaged(name, await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true }));
        names.push(name);
      } else {
        // Native windows may be constrained by the monitor. Capture document
        // coordinates through Chromium, not a resized visible viewport image.
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1080, height: 800, deviceScaleFactor: 1, mobile: false });
        await win.webContents.executeJavaScript("document.documentElement.style.overflow='hidden'");
        const layout = await win.webContents.executeJavaScript('({height:Math.ceil(document.querySelector("main").getBoundingClientRect().height), boundaries:[...document.querySelector("main").children].map(e=>Math.ceil(e.getBoundingClientRect().bottom))})') as { height: number; boundaries: number[] };
        const slices = exportSlices(layout.height, layout.boundaries);
        for (const [index, slice] of slices.entries()) {
          const capture = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: slice.y, width: 1080, height: slice.height, scale: 1 } }) as { data: string };
          const name = `${job.basename}${slices.length > 1 ? `-${String(index + 1).padStart(3, '0')}` : ''}.png`;
          await writeStaged(name, Buffer.from(capture.data, 'base64'));
          names.push(name);
        }
      }
      await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(names));
      await publish(names);
      await this.deps.jobs.update(id, 'completed', names);
    } catch {
      for (const file of created) {
        const target = path.join(root, path.basename(file));
        try {
          const sourceStat = await lstat(file); const targetStat = await lstat(target);
          if (!targetStat.isSymbolicLink() && sourceStat.ino === targetStat.ino && sourceStat.dev === targetStat.dev) await unlink(target);
        } catch { /* No published file owned by this task. */ }
        await unlink(file).catch(() => undefined);
      }
      await unlink(path.join(staging, 'manifest.json')).catch(() => undefined);
      await this.deps.jobs.update(id, 'failed', [], 'export_save_failed');
    } finally { win?.destroy(); }
  }
  async open(id: string, reveal: boolean) {
    const job = await this.deps.jobs.record(id);
    if (job?.status !== 'completed' || !job.filenames[0]) throw new Error('export_not_ready');
    const root = await realpath(path.join(this.deps.downloads, 'Joi'));
    const target = await realpath(path.join(root, job.filenames[0]));
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('export_path_invalid');
    if (reveal) shell.showItemInFolder(target);
    else if (await shell.openPath(target)) throw new Error('export_open_failed');
  }
}
