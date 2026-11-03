import path from "node:path";

import { REMOTE_MAX_FRAME_BYTES } from "../shared/remote.js";
import { createRemoteRelayServer } from "./remote-relay-server.js";

const hostToken = process.env.JOI_RELAY_HOST_TOKEN ?? "";
const address = process.env.JOI_RELAY_BIND_ADDRESS ?? "127.0.0.1";
const port = Number(process.env.JOI_RELAY_PORT ?? "8787");
const staticDirectory = path.resolve(process.env.JOI_RELAY_STATIC_DIRECTORY ?? "dist/renderer");

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("remote_relay_port_invalid");

const running = await createRemoteRelayServer({ hostToken, maxFrameBytes: REMOTE_MAX_FRAME_BYTES, staticDirectory }).listen(port, address);
process.stdout.write(`joi browser relay listening on ${running.httpOrigin}\n`);

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void running.close().then(() => process.exit(0), () => process.exit(1));
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
