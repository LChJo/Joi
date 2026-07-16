import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isRfc1918Address } from "../../src/main/application/ports/system-settings";
import { SystemSettingsService } from "../../src/main/infrastructure/operations/system-settings-service";
import { RuntimeMarker } from "../../src/main/infrastructure/runtime/runtime-marker";

describe("runtime recovery marker and persisted settings", () => {
  it("detects an unclean predecessor and removes evidence after a clean stop", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-marker-"));
    try {
      const first = new RuntimeMarker(root);
      expect(await first.start(new Date("2026-07-15T12:00:00.000Z"))).toMatchObject({ uncleanShutdown: false });
      const second = new RuntimeMarker(root);
      expect(await second.start(new Date("2026-07-15T12:01:00.000Z"))).toMatchObject({ uncleanShutdown: true, previousStartedAt: "2026-07-15T12:00:00.000Z" });
      await second.clean();
      const third = new RuntimeMarker(root);
      expect(await third.start(new Date("2026-07-15T12:02:00.000Z"))).toMatchObject({ uncleanShutdown: false });
      await third.clean();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("requires an explicit private address and risk acknowledgement for LAN", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-settings-"));
    let launchAtLogin = false;
    try {
      const service = new SystemSettingsService({
        getLaunchAtLogin: () => launchAtLogin,
        setLaunchAtLogin: (enabled) => { launchAtLogin = enabled; },
        settingsPath: path.join(root, "settings.json"),
      });
      expect(isRfc1918Address("192.168.1.20")).toBe(true);
      expect(isRfc1918Address("10.2.3.4")).toBe(true);
      expect(isRfc1918Address("172.16.0.1")).toBe(true);
      expect(isRfc1918Address("172.31.255.254")).toBe(true);
      expect(isRfc1918Address("172.15.0.1")).toBe(false);
      expect(isRfc1918Address("172.32.0.1")).toBe(false);
      expect(isRfc1918Address("192.168.bad.1")).toBe(false);
      expect(isRfc1918Address("0.0.0.0")).toBe(false);
      await expect(service.update({ lan: { address: "203.0.113.2", enabled: true, riskAccepted: true } })).rejects.toThrow(/RFC1918/);
      const saved = await service.update({ lan: { address: "192.168.1.20", enabled: true, port: 43_130, riskAccepted: true }, launchAtLogin: true });
      expect(saved).toMatchObject({ launchAtLogin: true, restartRequired: true });
      expect(await service.get()).toMatchObject({ lan: { address: "192.168.1.20", enabled: true }, launchAtLogin: true });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
