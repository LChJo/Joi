import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const project = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const output = path.resolve("release-joi-remote-relay");

await rm(output, { force: true, recursive: true });
await mkdir(output, { recursive: true });
await cp(path.resolve("dist/remote-relay"), path.join(output, "dist/remote-relay"), { recursive: true });
await cp(path.resolve("dist/renderer"), path.join(output, "dist/renderer"), { recursive: true });
await writeFile(path.join(output, "package.json"), `${JSON.stringify({
  dependencies: { ws: project.dependencies.ws },
  engines: project.engines,
  name: "joi-remote-relay",
  private: true,
  scripts: { start: "node dist/remote-relay/relay/index.js" },
  type: "module",
  version: project.version,
}, null, 2)}\n`);

process.stdout.write(`Remote relay package created at ${output}\n`);
