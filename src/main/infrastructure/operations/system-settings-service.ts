import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRfc1918Address, type LanSettings, type SystemSettings, type SystemSettingsPort } from "../../application/ports/system-settings.js";

const DEFAULT_LAN: LanSettings = { address: "", enabled: false, port: 43_130, riskAccepted: false };

export class SystemSettingsService implements SystemSettingsPort {
  constructor(private readonly dependencies: {
    getLaunchAtLogin: () => boolean;
    setLaunchAtLogin: (enabled: boolean) => void;
    settingsPath: string;
  }) {}

  async get(): Promise<SystemSettings> {
    let lan = DEFAULT_LAN;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.dependencies.settingsPath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && "lan" in parsed) {
        const candidate = (parsed as { lan: Partial<LanSettings> }).lan;
        const candidatePort = candidate.port;
        lan = {
          address: typeof candidate.address === "string" ? candidate.address : "",
          enabled: candidate.enabled === true,
          port: typeof candidatePort === "number" && Number.isInteger(candidatePort) ? candidatePort : DEFAULT_LAN.port,
          riskAccepted: candidate.riskAccepted === true,
        };
      }
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    return { lan, launchAtLogin: this.dependencies.getLaunchAtLogin() };
  }

  async update(input: { lan?: Partial<LanSettings>; launchAtLogin?: boolean }): Promise<SystemSettings & { restartRequired: boolean }> {
    const current = await this.get();
    const lan = { ...current.lan, ...(input.lan ?? {}) };
    if (!Number.isInteger(lan.port) || lan.port < 1024 || lan.port > 65_535) throw new Error("LAN port must be between 1024 and 65535.");
    if (lan.enabled && (!lan.riskAccepted || !isRfc1918Address(lan.address))) {
      throw new Error("LAN access requires an accepted warning and an explicit RFC1918 IPv4 address.");
    }
    if (input.launchAtLogin !== undefined) this.dependencies.setLaunchAtLogin(input.launchAtLogin);
    await mkdir(path.dirname(this.dependencies.settingsPath), { recursive: true });
    const temporary = `${this.dependencies.settingsPath}.${String(process.pid)}.tmp`;
    await rm(temporary, { force: true });
    await writeFile(temporary, `${JSON.stringify({ lan }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rm(this.dependencies.settingsPath, { force: true });
    await rename(temporary, this.dependencies.settingsPath);
    return { lan, launchAtLogin: this.dependencies.getLaunchAtLogin(), restartRequired: JSON.stringify(lan) !== JSON.stringify(current.lan) };
  }
}
