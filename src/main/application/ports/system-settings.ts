import type { LanAddressOption, LanRuntimeState } from "../../../shared/system-settings.js";

export interface LanSettings {
  address: string;
  enabled: boolean;
  port: number;
  riskAccepted: boolean;
}

export interface SystemSettings {
  lan: LanSettings;
  launchAtLogin: boolean;
}

export interface SystemSettingsSnapshot extends SystemSettings {
  lan: LanSettings & {
    availableAddresses: LanAddressOption[];
    effective: LanRuntimeState;
  };
}

export interface SystemSettingsPort {
  get(): Promise<SystemSettingsSnapshot>;
  update(input: { lan?: Partial<LanSettings>; launchAtLogin?: boolean }): Promise<SystemSettingsSnapshot & { restartRequired: boolean }>;
}

export function isRfc1918Address(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const first = octets[0];
  const second = octets[1];
  return first === 10 || (first === 172 && second !== undefined && second >= 16 && second <= 31) || (first === 192 && second === 168);
}
