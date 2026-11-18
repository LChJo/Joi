import { spawn } from "node:child_process";
import electron from "electron";
import waitOn from "wait-on";

const port = Number(process.env.JOI_DEV_PORT ?? 43_715);
const origin = `http://127.0.0.1:${port}`;
if (process.env.JOI_TEST === "1" && !process.env.JOI_DEV_API_PORT) {
  process.stderr.write("Set JOI_DEV_API_PORT to a free loopback port when starting isolated development mode.\n");
  process.exit(1);
}
try {
  await waitOn({ resources: [`http-get://127.0.0.1:${port}/src/renderer/main.tsx`], timeout: 30_000 });
} catch {
  process.stderr.write(`Vite did not serve the Joi renderer at ${origin} within 30 seconds.\n`);
  process.exit(1);
}

const child = spawn(electron, ["."], {
  env: { ...process.env, VITE_DEV_SERVER_URL: origin },
  stdio: "inherit",
});
child.once("error", error => {
  process.stderr.write(`Could not launch the Electron development window (${error.code ?? "spawn_failed"}).\n`);
  process.exitCode = 1;
});
child.once("exit", code => { process.exitCode = code ?? 1; });
