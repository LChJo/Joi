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
