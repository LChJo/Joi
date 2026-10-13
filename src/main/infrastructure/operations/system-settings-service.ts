import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";

import { DomainError } from "../../domain/errors.js";
import { isRfc1918Address, type LanSettings, type SystemSettings, type SystemSettingsPort, type SystemSettingsSnapshot } from "../../application/ports/system-settings.js";
import type { LanAddressOption, LanRuntimeState } from "../../../shared/system-settings.js";

const DEFAULT_LAN: LanSettings = { address: "", enabled: false, port: 43_130, riskAccepted: false };

export class SystemSettingsService implements SystemSettingsPort {
  private updateChain: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: {
    getLaunchAtLogin: () => boolean | Promise<boolean>;
    getLanRuntimeState?: () => LanRuntimeState | undefined;
    listLanAddresses?: (() => Promise<LanAddressOption[]> | LanAddressOption[]) | LanAddressOption[];
    reconfigureLan?: (target: { address: string; port: number } | undefined) => Promise<LanRuntimeState>;
    setLaunchAtLogin: (enabled: boolean) => void | Promise<void>;
    settingsPath: string;
    validateJoiSkills?: (refs: readonly string[]) => void;
  }) {}

  async get(): Promise<SystemSettingsSnapshot> {
    const persisted = await this.readPersisted();
    const availableAddresses = await this.availableAddresses();
    return this.snapshot(persisted, availableAddresses);
  }

  async update(input: { lan?: Partial<LanSettings>; joiSkills?: string[]; launchAtLogin?: boolean }): Promise<SystemSettingsSnapshot & { restartRequired: boolean }> {
    const operation = this.updateChain.then(() => this.performUpdate(input));
    this.updateChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async performUpdate(input: { lan?: Partial<LanSettings>; joiSkills?: string[]; launchAtLogin?: boolean }): Promise<SystemSettingsSnapshot & { restartRequired: boolean }> {
    const current = await this.readPersisted();
    const lan = { ...current.lan, ...(input.lan ?? {}) };
    const applyLan = input.lan !== undefined || input.joiSkills === undefined;
    if (applyLan && (!Number.isInteger(lan.port) || lan.port < 1024 || lan.port > 65_535)) {
      throw new DomainError("lan_port_invalid", "LAN 端口必须在 1024 到 65535 之间。");
    }
    if (applyLan && lan.enabled && !lan.riskAccepted) {
      throw new DomainError("lan_risk_required", "启用 LAN 访问前必须确认明文连接风险。");
    }
    if (applyLan && lan.enabled && !isRfc1918Address(lan.address)) {
      throw new DomainError("lan_address_invalid", "LAN 访问必须使用明确的 RFC1918 IPv4 地址。");
    }
    const availableAddresses = await this.availableAddresses();
    if (applyLan && lan.enabled && !availableAddresses.some((item) => item.address === lan.address && item.available)) {
      throw new DomainError("lan_address_unavailable", "所选局域网地址当前不在本机网卡上。");
    }

    const joiSkills = input.joiSkills ?? current.joiSkills ?? [];
    if (input.joiSkills !== undefined) {
      if (!Array.isArray(joiSkills) || joiSkills.length > 100 || joiSkills.some((ref) => typeof ref !== "string" || ref.length > 256)
        || new Set(joiSkills).size !== joiSkills.length) {
        throw new DomainError("joi_skills_invalid", "技能选择无效，请重新选择。");
      }
      if (joiSkills.length > 0 && this.dependencies.validateJoiSkills === undefined) {
        throw new DomainError("joi_skills_unavailable", "技能加载暂不可用。");
      }
      this.dependencies.validateJoiSkills?.(joiSkills);
    }
    await this.persist(lan, joiSkills);
    if (input.launchAtLogin !== undefined) await this.dependencies.setLaunchAtLogin(input.launchAtLogin);

    let effective = this.dependencies.getLanRuntimeState?.();
    if (applyLan && this.dependencies.reconfigureLan !== undefined) {
      try {
        effective = await this.dependencies.reconfigureLan(lan.enabled ? { address: lan.address, port: lan.port } : undefined);
      } catch {
        effective = { status: "blocked", reasonCode: "lan_bind_failed", message: "LAN 监听器暂时无法绑定所选地址和端口。" };
      }
    }
    return {
      ...this.snapshot({ lan, joiSkills, launchAtLogin: await this.dependencies.getLaunchAtLogin() }, availableAddresses, effective),
      restartRequired: false,
    };
  }

  private async readPersisted(): Promise<SystemSettings> {
    let lan = DEFAULT_LAN;
    let joiSkills: string[] = [];
    try {
      const parsed: unknown = JSON.parse(await readFile(this.dependencies.settingsPath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && "joiSkills" in parsed && Array.isArray(parsed.joiSkills)) {
        joiSkills = parsed.joiSkills.filter((ref): ref is string => typeof ref === "string");
      }
      if (parsed !== null && typeof parsed === "object" && "lan" in parsed) {
        const value = parsed.lan;
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          const candidate = value as Partial<LanSettings>;
          const candidatePort = candidate.port;
          lan = {
            address: typeof candidate.address === "string" ? candidate.address : "",
            enabled: candidate.enabled === true,
            port: typeof candidatePort === "number" && Number.isInteger(candidatePort) ? candidatePort : DEFAULT_LAN.port,
            riskAccepted: candidate.riskAccepted === true,
          };
        }
      }
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    return { lan, joiSkills, launchAtLogin: await this.dependencies.getLaunchAtLogin() };
  }

  private async availableAddresses(): Promise<LanAddressOption[]> {
    const addresses = this.dependencies.listLanAddresses === undefined
      ? listRfc1918Addresses()
      : Array.isArray(this.dependencies.listLanAddresses)
        ? this.dependencies.listLanAddresses
        : await this.dependencies.listLanAddresses();
    return addresses
      .filter((item) => item.available && isRfc1918Address(item.address))
      .filter((item, index, all) => all.findIndex((candidate) => candidate.address === item.address) === index)
      .sort((left, right) => left.address.localeCompare(right.address));
  }

  private snapshot(persisted: SystemSettings, availableAddresses: LanAddressOption[], effective = this.dependencies.getLanRuntimeState?.()): SystemSettingsSnapshot {
    const runtime = effective ?? (persisted.lan.enabled
      ? { status: "blocked" as const, reasonCode: "lan_not_applied", message: "LAN 配置尚未应用到当前进程。" }
      : { status: "disabled" as const });
    return {
      joiSkills: persisted.joiSkills ?? [],
      launchAtLogin: persisted.launchAtLogin,
      lan: { ...persisted.lan, availableAddresses, effective: runtime },
    };
  }

  private async persist(lan: LanSettings, joiSkills: string[]): Promise<void> {
    await mkdir(path.dirname(this.dependencies.settingsPath), { recursive: true });
    const temporary = `${this.dependencies.settingsPath}.${String(process.pid)}.tmp`;
    await rm(temporary, { force: true });
    await writeFile(temporary, `${JSON.stringify({ lan, joiSkills }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.dependencies.settingsPath);
  }
}

export function listRfc1918Addresses(): LanAddressOption[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4" || !isRfc1918Address(entry.address)) continue;
      addresses.add(entry.address);
    }
  }
  return [...addresses].sort((left, right) => left.localeCompare(right)).map((address) => ({ address, available: true }));
}
