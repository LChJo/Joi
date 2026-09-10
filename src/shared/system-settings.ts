export interface LanAddressOption {
  address: string;
  available: boolean;
}

export type LanRuntimeState =
  | { status: "disabled" }
  | { status: "blocked"; message: string; reasonCode: string }
  | {
      address: string;
      message?: string;
      pending?: { address: string; port: number; reasonCode: string };
      port: number;
      status: "listening";
      url: string;
    };

export interface SystemSettingsDto {
  lan: {
    address: string;
    availableAddresses?: LanAddressOption[];
    effective?: LanRuntimeState;
    enabled: boolean;
    port: number;
    riskAccepted: boolean;
  };
  joiSkills?: string[];
  launchAtLogin: boolean;
  restartRequired?: boolean;
}

export interface UpdateSystemSettingsInput {
  lan?: {
    address?: string;
    enabled?: boolean;
    port?: number;
    riskAccepted?: boolean;
  };
  joiSkills?: string[];
  launchAtLogin?: boolean;
}
