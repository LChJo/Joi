import type { DesktopBootstrapNonce } from "../../shared/product.js";
import type { UiLocalePreference } from "../../shared/i18n/index.js";
import type { CredentialVault } from "../application/ports/a2a-ports.js";
import type { BitmapTranscodeInput, BitmapTranscodeResult } from "../infrastructure/artifacts/bitmap-transcoder.js";
import type { ExportRecord } from "../infrastructure/persistence/sqlite-result-exports.js";

export interface DesktopRuntimeConfiguration {
  systemLanguages?: string[];
  userDataDirectory: string;
  migrationsDirectory: string;
  rendererDirectory: string;
  runDirectory: string;
  remoteSidecarPath: string;
  appVersion: string;
  isTest: boolean;
  launchAtLogin: boolean;
  credentialStorageAvailable: boolean;
}

export interface RuntimeDesktopCapabilities {
  setUiLocale?(preference: UiLocalePreference): void | Promise<void>;
  vault: CredentialVault;
  getLaunchAtLogin(): boolean | Promise<boolean>;
  setLaunchAtLogin(enabled: boolean): void | Promise<void>;
  directoryPicker(): Promise<string | null>;
  artifactOpen(input: { mode: string; targetPath: string }): Promise<void>;
  transcodeBitmap(input: BitmapTranscodeInput): Promise<BitmapTranscodeResult | undefined>;
  requestRestart(): void;
  createExporter(jobs: {
    record(id: string): ExportRecord | null;
    update(id: string, status: ExportRecord["status"], filenames?: string[], error?: string): void;
  }): { handle(id: string): Promise<void>; open(id: string, reveal: boolean): Promise<void> };
}

export interface HostedRuntime {
  apiOrigin(): string;
  issueDesktopBootstrap(): Promise<DesktopBootstrapNonce>;
  emergencyStop(): Promise<void>;
  exportRecord(id: string): ExportRecord | null;
  exportUpdate(id: string, status: ExportRecord["status"], filenames?: string[], error?: string): void;
  close(): Promise<void>;
}
