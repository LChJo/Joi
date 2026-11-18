import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

describe("desktop package command", () => {
  it("builds and audits the host installer without requesting publication in CI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-package-command-"));
    try {
      await mkdir(path.join(root, "scripts"), { recursive: true });
      await mkdir(path.join(root, "node_modules/electron-builder/out/cli"), { recursive: true });
      await copyFile(path.resolve("scripts/package-app.mjs"), path.join(root, "scripts/package-app.mjs"));
      const trace = path.join(root, "commands.jsonl");
      const recorder = (stage: string) => `import { appendFileSync } from "node:fs";
appendFileSync(process.env.JOI_PACKAGE_TRACE, JSON.stringify({ stage: ${JSON.stringify(stage)}, args: process.argv.slice(2) }) + "\\n");\n`;
      await writeFile(path.join(root, "npm-cli.mjs"), recorder("npm"));
      await writeFile(path.join(root, "scripts/package-verify.mjs"), recorder("audit"));
      await writeFile(path.join(root, "node_modules/electron-builder/out/cli/cli.js"), recorder("builder"));
      await writeFile(path.join(root, "package.json"), '{"type":"module"}');
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_execpath"));
      await execute(process.execPath, [path.join(root, "scripts/package-app.mjs"), "--target", "current"], {
        cwd: root,
        env: {
          ...environment,
          CI: "true",
          CSC_IDENTITY_AUTO_DISCOVERY: "false",
          GH_TOKEN: "",
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REPOSITORY: "fixture/joi",
          GITHUB_TOKEN: "",
          JOI_PACKAGE_TRACE: trace,
          npm_execpath: path.join(root, "npm-cli.mjs"),
        },
      });
      const commands = (await readFile(trace, "utf8")).trim().split("\n")
        .map(line => JSON.parse(line) as { args: string[]; stage: string });
      expect(commands.map(command => command.stage)).toEqual(["npm", "npm", "audit", "builder"]);
      expect(commands[0]?.args).toEqual(["run", "assets:icons"]);
      expect(commands[1]?.args).toEqual(["run", "build:prod"]);
      const args = commands[3]?.args ?? [];
      const target = process.platform === "win32" ? ["--win", "nsis"] : process.platform === "darwin" ? ["--mac", "dmg"] : ["--dir"];
      expect(args).toEqual(expect.arrayContaining(target));
      expect(args.slice(args.indexOf("--publish"), args.indexOf("--publish") + 2)).toEqual(["--publish", "never"]);
      expect(args).toContain("--config.directories.output=release-joi");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("Android package command", () => {
  it("uses the project version for the APK manifest and filename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-android-package-"));
    try {
      const mobile = path.join(root, "apps/joi_mobile");
      const trace = path.join(root, "flutter-arguments.json");
      const stub = path.join(root, "flutter-stub.cjs");
      await mkdir(mobile, { recursive: true });
      await mkdir(path.join(root, "scripts"));
      await mkdir(path.join(root, "node_modules/electron"), { recursive: true });
      await copyFile(path.resolve("scripts/build-joi-mobile.mjs"), path.join(root, "scripts/build-joi-mobile.mjs"));
      await writeFile(path.join(root, "package.json"), '{"version":"2.4.7"}');
      for (const file of ["scripts/i18n.mjs", "scripts/build-native-remote.mjs", "node_modules/electron/cli.js"]) {
        await writeFile(path.join(root, file), "");
      }
      await writeFile(stub, `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "build") {
  fs.writeFileSync(process.env.JOI_PACKAGE_TRACE, JSON.stringify(args));
  fs.mkdirSync("build/app/outputs/flutter-apk", { recursive: true });
  fs.writeFileSync("build/app/outputs/flutter-apk/app-release.apk", "fixture APK");
}
`);
      if (process.platform === "win32") {
        await writeFile(path.join(mobile, "flutter.cmd"), '@"%JOI_TEST_NODE_EXEC%" "%JOI_TEST_FLUTTER_STUB%" %*\r\n');
      } else {
        await writeFile(path.join(mobile, "flutter"), '#!/bin/sh\nexec "$JOI_TEST_NODE_EXEC" "$JOI_TEST_FLUTTER_STUB" "$@"\n', { mode: 0o700 });
      }
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
      await execute(process.execPath, [path.join(root, "scripts/build-joi-mobile.mjs")], { cwd: root, env: {
        ...env, PATH: [mobile, process.env.PATH ?? ""].join(path.delimiter),
        JOI_PACKAGE_TRACE: trace, JOI_TEST_NODE_EXEC: process.execPath, JOI_TEST_FLUTTER_STUB: stub,
      } });
      expect(JSON.parse(await readFile(trace, "utf8"))).toEqual(["build", "apk", "--release", "--target-platform", "android-arm64", "--build-name", "2.4.7"]);
      expect(await readFile(path.join(root, "release-joi-mobile/joi-android-2.4.7-arm64.apk"), "utf8")).toBe("fixture APK");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
