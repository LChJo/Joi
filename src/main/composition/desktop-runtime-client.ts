import { MessageChannel, Worker } from "node:worker_threads";
import type { DesktopBootstrapNonce } from "../../shared/product.js";
import type { UiLocalePreference } from "../../shared/i18n/index.js";
import { WorkerRpc } from "../infrastructure/runtime/worker-rpc.js";
import type { ExportRecord } from "../infrastructure/persistence/sqlite-result-exports.js";
import type { BitmapTranscodeInput } from "../infrastructure/artifacts/bitmap-transcoder.js";
import type { DesktopRuntimeConfiguration, RuntimeDesktopCapabilities } from "./desktop-runtime-contract.js";

type DesktopCapabilities = Omit<RuntimeDesktopCapabilities, "createExporter"> & {
  createExporter(jobs: {
    record(id: string): Promise<ExportRecord | null>;
    update(id: string, status: ExportRecord["status"], filenames?: string[], error?: string): Promise<void>;
  }): { handle(id: string): Promise<void>; open(id: string, reveal: boolean): Promise<void> };
};

export async function startDesktopRuntime(configuration: DesktopRuntimeConfiguration, desktop: DesktopCapabilities, onFailure: () => void) {
  const { port1, port2 } = new MessageChannel();
  let closing = false;
  let ready = false;
  let closePromise: Promise<void> | undefined;
  const rpc = new WorkerRpc(port1, {
    setUiLocale: (preference) => desktop.setUiLocale?.(preference as UiLocalePreference),
    encrypt: (token) => desktop.vault.encrypt(token as string),
    decrypt: (ciphertext) => desktop.vault.decrypt(ciphertext as Uint8Array),
    getLaunchAtLogin: () => desktop.getLaunchAtLogin(),
    setLaunchAtLogin: (enabled) => desktop.setLaunchAtLogin(enabled as boolean),
    directoryPicker: () => desktop.directoryPicker(),
    artifactOpen: (artifact) => desktop.artifactOpen(artifact as { mode: string; targetPath: string }),
    transcodeBitmap: (bitmap) => desktop.transcodeBitmap(bitmap as BitmapTranscodeInput),
    requestRestart: () => desktop.requestRestart(),
    exportHandle: (id) => exporter.handle(id as string),
    exportOpen: (id, reveal) => exporter.open(id as string, reveal as boolean),
  });
  const exporter = desktop.createExporter({
    record: (id) => rpc.call("exportRecord", id),
    update: (id, status, filenames, error) => rpc.call("exportUpdate", id, status, filenames, error),
  });
  const worker = new Worker(new URL("./runtime-worker.js", import.meta.url), {
    workerData: { port: port2 }, transferList: [port2],
  });
  let failed = false;
  const fail = () => {
    rpc.close();
    if (!closing && ready && !failed) { failed = true; onFailure(); }
  };
  worker.on("error", fail);
  worker.on("exit", fail);
  try {
    const apiOrigin = await rpc.callWithTimeout<string>("start",60_000,configuration);
    ready = true;
    return {
      apiOrigin,
      issueDesktopBootstrap: () => rpc.call<DesktopBootstrapNonce>("bootstrap"),
      emergencyStop: async (): Promise<void> => { await rpc.callWithTimeout("emergencyStop",15_000); },
      close: () => {
        closePromise ??= (async () => {
          closing = true;
          try { await rpc.callWithTimeout("close",15_000); }
          finally { rpc.close(); await worker.terminate(); }
        })();
        return closePromise;
      },
    };
  } catch (error) { closing = true; rpc.close(); await worker.terminate(); throw error; }
}
