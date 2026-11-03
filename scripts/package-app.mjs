import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import path from "node:path";

const supportedTargets = new Set(["current", "dir", "mac", "win"]);
const arguments_ = process.argv.slice(2);
let requestedTarget = "current";
let outputDirectory = "release-joi";

for (let index = 0; index < arguments_.length; index += 1) {
  const argument = arguments_[index];
  if (argument === "--target") requestedTarget = arguments_[index += 1] ?? "";
  else if (argument === "--output") outputDirectory = arguments_[index += 1] ?? "";
  else throw new Error(`Unknown package argument: ${argument}`);
}

if (!supportedTargets.has(requestedTarget)) {
  throw new Error(`Unsupported package target: ${requestedTarget || "(empty)"}. Use current, dir, mac, or win.`);
}

const resolvedTarget = requestedTarget === "current"
  ? process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "dir"
  : requestedTarget;
if (resolvedTarget === "mac" && process.platform !== "darwin") {
  throw new Error("macOS DMG packaging must run on a macOS host.");
}

const projectRoot = path.resolve(".");
const absoluteOutput = path.resolve(projectRoot, outputDirectory);
const relativeOutput = path.relative(projectRoot, absoluteOutput);
if (outputDirectory.length === 0 || relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) {
  throw new Error(`Package output must stay inside the project root: ${outputDirectory || "(empty)"}`);
}

function run(command, argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, { cwd: projectRoot, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code === null ? `signal ${signal}` : `code ${String(code)}`}.`));
    });
  });
}

const npmCliCandidates = [
  process.env.npm_execpath,
  path.resolve(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
let npmCli;
for (const candidate of npmCliCandidates) {
  try {
    await access(candidate);
    npmCli = candidate;
    break;
  } catch {
    // Continue through platform-specific npm installation locations.
  }
}
if (npmCli === undefined) throw new Error("Unable to locate npm-cli.js. Run this script from npm or install npm next to Node.js.");
const builderArguments = resolvedTarget === "win"
  ? ["--win", "nsis"]
  : resolvedTarget === "mac" ? ["--mac", "dmg"] : ["--dir"];

await rm(path.resolve(projectRoot, "dist"), { force: true, maxRetries: 3, recursive: true, retryDelay: 150 });
await rm(absoluteOutput, { force: true, maxRetries: 3, recursive: true, retryDelay: 150 });
await run(process.execPath, [npmCli, "run", "assets:icons"]);
await run(process.execPath, [npmCli, "run", "build:prod"]);
await run(process.execPath, [path.resolve(projectRoot, "scripts/package-verify.mjs")]);
await run(process.execPath, [
  path.resolve(projectRoot, "node_modules/electron-builder/out/cli/cli.js"),
  ...builderArguments,
  `--config.directories.output=${relativeOutput.replaceAll("\\", "/")}`,
]);

process.stdout.write(`joi ${resolvedTarget} package completed in ${relativeOutput}.\n`);
