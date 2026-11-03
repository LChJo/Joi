import type { UiLocalePreference } from "./i18n/index.js";

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
  uiLocale?: UiLocalePreference;
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
  uiLocale?: UiLocalePreference;
  lan?: {
    address?: string;
    enabled?: boolean;
    port?: number;
    riskAccepted?: boolean;
  };
  joiSkills?: string[];
  launchAtLogin?: boolean;
}
