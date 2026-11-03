import { createRecoveryModeHandler } from "../../src/main/interfaces/http/recovery-mode-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";

describe("read-only recovery HTTP mode", () => {
  it("AC-I18N-06 changes only locale settings under the recovery Origin gate", async () => {
    const setUiLocale = vi.fn(() => Promise.resolve());
    const listeners = await startRuntimeListeners({ handler: createRecoveryModeHandler({
      backups: { create: () => Promise.resolve({ backupId: "snapshot" }), list: () => Promise.resolve([]), stageRecoveryRestore: () => Promise.resolve({ backupId: "saved", restartRequired: true }) },
      requestRestart: vi.fn(), uiLocale: "en", systemLanguages: ["zh-CN"], setUiLocale,
    }), loopbackPort: 0 });
    try {
      const source = await (await fetch(listeners.loopback.url)).text();
      expect(source).toContain('<html lang="en">');
      expect(source).toContain('id="language"');
      const endpoint = `${listeners.loopback.url}/api/v1/recovery/ui-locale`;
      expect((await fetch(endpoint, { method: "POST", body: JSON.stringify({ uiLocale: "zh-CN" }) })).status).toBe(403);
      expect(setUiLocale).not.toHaveBeenCalled();
      expect((await fetch(endpoint, { method: "POST", headers: { origin: listeners.loopback.url, "content-type": "application/json" }, body: JSON.stringify({ uiLocale: "unknown" }) })).status).toBe(400);
      expect(setUiLocale).not.toHaveBeenCalled();
      expect((await fetch(endpoint, { method: "POST", headers: { origin: listeners.loopback.url, "content-type": "application/json" }, body: JSON.stringify({ uiLocale: "zh-CN" }) })).status).toBe(200);
      expect(setUiLocale).toHaveBeenCalledExactlyOnceWith("zh-CN");
    } finally { await listeners.close(); }
  });
  it("serves a constrained recovery console and protects restore writes by Origin", async () => {
    const backups = {
      create: vi.fn(() => Promise.resolve({ backupId: "backup_snapshot" })),
      list: vi.fn(() => Promise.resolve([{ backupId: "backup_1", createdAt: "2026-07-16T00:00:00.000Z", databaseBytes: 1024, schemaVersion: 16 }])),
      stageRecoveryRestore: vi.fn(() => Promise.resolve({ backupId: "backup_1", restartRequired: true as const })),
    };
    const requestRestart = vi.fn();
    const listeners = await startRuntimeListeners({ handler: createRecoveryModeHandler({ backups, requestRestart }), loopbackPort: 0 });
    try {
      const page = await fetch(listeners.loopback.url);
      const pageSource = await page.text();
      expect(pageSource).toContain("joi 需要先修复本机数据");
      expect(pageSource).toContain("保存当前数据快照");
      expect(pageSource).not.toContain("READ-ONLY RECOVERY");
      expect(pageSource).not.toContain("Schema");
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      const health = await fetch(`${listeners.loopback.url}/api/v1/health`);
      expect(await health.json()).toEqual({ database: "read-only", reason: "migration_failed", status: "recovery" });
      const crossOrigin = await fetch(`${listeners.loopback.url}/api/v1/recovery/backups`, { method: "POST" });
      expect(crossOrigin.status).toBe(403);
      const snapshot = await fetch(`${listeners.loopback.url}/api/v1/recovery/backups`, {
        headers: { origin: listeners.loopback.url }, method: "POST",
      });
      expect(snapshot.status).toBe(201);
      const restore = await fetch(`${listeners.loopback.url}/api/v1/recovery/backups/backup_1/restore`, {
        headers: { origin: listeners.loopback.url }, method: "POST",
      });
      expect(restore.status).toBe(202);
      await vi.waitFor(() => expect(requestRestart).toHaveBeenCalledOnce());
    } finally {
      await listeners.close();
    }
  });
});
