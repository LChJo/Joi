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

export interface SystemSettingsPort {
  get(): Promise<SystemSettings>;
  update(input: { lan?: Partial<LanSettings>; launchAtLogin?: boolean }): Promise<SystemSettings & { restartRequired: boolean }>;
}

export function isRfc1918Address(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const first = octets[0];
  const second = octets[1];
  return first === 10 || (first === 172 && second !== undefined && second >= 16 && second <= 31) || (first === 192 && second === 168);
}
