import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConversationWorkspaceFileDto } from "../../src/shared/conversations";
import { waitForDesktopTestReady } from "./locale";

test("desktop workspace file actions reach the Electron shell for the selected file", async ({ browserName }, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe("chromium");
  const root = testInfo.outputPath("workspace");
  const relativePath = "reports/周报.png";
  const target = path.join(root,relativePath);
  await mkdir(path.dirname(target),{ recursive: true });
  await writeFile(target,Buffer.alloc(2_295_869));
  const application = await electron.launch({ args: ["."],env: { ...process.env,JOI_TEST: "1" } });
  try {
    const page = await application.firstWindow({ timeout: 60_000 });
    await waitForDesktopTestReady(page);
    await application.evaluate(({ dialog,shell },fixture) => {
      const actions: { mode: string; selectedFile: boolean }[] = [];
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false,filePaths: [fixture.root] });
      shell.openPath = file => { actions.push({ mode: "OPEN",selectedFile: file === fixture.target });return Promise.resolve(""); };
      shell.showItemInFolder = file => { actions.push({ mode: "REVEAL",selectedFile: file === fixture.target }); };
      Object.defineProperty(shell,"joiTestActions",{ value: actions });
    },{ root: await realpath(root),target: await realpath(target) });

    const result = await page.evaluate(async (relative) => {
      const grant = await window.digitalLifeDesktop?.createBootstrapNonce();
      if (grant === undefined) throw new Error("desktop_bridge_missing");
      const auth = await fetch("/api/v1/auth/bootstrap",{ method: "POST",headers: { "content-type": "application/json" },body: JSON.stringify({ nonce: grant.nonce }) });
      if (!auth.ok) throw new Error("desktop_bootstrap_failed");
      const { csrfToken } = await auth.json() as { csrfToken: string };
      const headers = { "content-type": "application/json","x-csrf-token": csrfToken };
      const bound = await fetch("/api/v1/conversation-workbenches",{ method: "POST",headers,body: "{}" });
      if (bound.status !== 201) throw new Error(`workspace_bind_failed:${String(bound.status)}`);
      const { workbenchId } = await bound.json() as { workbenchId: string };
      const workspace = `/api/v1/conversation-workspaces/${encodeURIComponent(workbenchId)}`;
      const preview = await fetch(`${workspace}/file?${new URLSearchParams({ path: relative }).toString()}`);
      const selection = await preview.json() as ConversationWorkspaceFileDto;
      const statuses: number[] = [];
      for (const mode of ["OPEN","REVEAL"]) {
        const opened = await fetch(`${workspace}/open`,{ method: "POST",headers,body: JSON.stringify({ path: relative,mode }) });
        statuses.push(opened.status);
      }
      return { preview: preview.status,unavailable: selection.unavailable,statuses };
    },relativePath);
    expect(result).toEqual({ preview: 200,unavailable: "TOO_LARGE",statuses: [200,200] });
    expect(await application.evaluate(({ shell }) => Reflect.get(shell,"joiTestActions") as unknown)).toEqual([
      { mode: "OPEN",selectedFile: true },{ mode: "REVEAL",selectedFile: true },
    ]);
  } finally { await application.close(); }
});
