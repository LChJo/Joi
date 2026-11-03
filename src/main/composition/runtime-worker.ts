import { parentPort, type MessagePort, workerData } from "node:worker_threads";
import { WorkerRpc } from "../infrastructure/runtime/worker-rpc.js";
import type { ExportRecord, SqliteResultExports } from "../infrastructure/persistence/sqlite-result-exports.js";
import { createRuntimeHost } from "./runtime-host.js";
import type { DesktopRuntimeConfiguration, HostedRuntime } from "./desktop-runtime-contract.js";

const input = workerData as { port: MessagePort };
let host: HostedRuntime | undefined;
let starting = false;
let exportJobs: SqliteResultExports | undefined;
const peer = new WorkerRpc(input.port, {
  start: async (configuration) => {
    if (starting) throw new Error("runtime_already_started");
    starting = true;
    const config = configuration as DesktopRuntimeConfiguration;
    host = await createRuntimeHost(config, {
      vault: {
        isAvailable: () => config.credentialStorageAvailable,
        encrypt: (token) => peer.call("encrypt", token),
        decrypt: (ciphertext) => peer.call("decrypt", ciphertext),
      },
      getLaunchAtLogin: () => peer.call("getLaunchAtLogin"),
      setUiLocale: (preference) => peer.call("setUiLocale", preference),
      setLaunchAtLogin: (enabled) => peer.call("setLaunchAtLogin", enabled),
      directoryPicker: () => peer.call("directoryPicker"),
      artifactOpen: (artifact) => peer.call("artifactOpen", artifact),
      transcodeBitmap: (bitmap) => peer.call("transcodeBitmap", bitmap),
      requestRestart: () => { void peer.call("requestRestart").catch(() => undefined); },
      createExporter: (jobs) => {
        exportJobs = jobs as SqliteResultExports;
        return { handle: (id) => peer.call("exportHandle", id), open: (id, reveal) => peer.call("exportOpen", id, reveal) };
      },
    });
    return host.apiOrigin();
  },
  bootstrap: () => {
    if (host === undefined) throw new Error("runtime_not_ready");
    return host.issueDesktopBootstrap();
  },
  emergencyStop: () => host?.emergencyStop(),
  exportRecord: (id) => exportJobs?.record(id as string) ?? null,
  exportUpdate: (id, status, filenames, error) => exportJobs?.update(id as string, status as ExportRecord["status"], filenames as string[] | undefined, error as string | undefined),
  close: async () => {
    await host?.close();
    setImmediate(() => { peer.close(); parentPort?.close(); });
  },
});
