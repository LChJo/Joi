import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { validatePackageContents } from "./package-contents.mjs";

const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".mjs", ".txt"]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(absolute));
    } else {
      files.push(absolute);
    }
  }
  return files;
}

const distRoot = path.resolve("dist");
const absoluteFiles = await walk(distRoot);
const relativeFiles = absoluteFiles.map((file) => path.relative(process.cwd(), file).replaceAll("\\", "/"));
const requiredFiles = [
  "dist/electron/main/index.js",
  "dist/electron/preload/index.cjs",
  "dist/remote-relay/relay/index.js",
  "dist/renderer/icon.png",
  "dist/renderer/index.html",
];
const missing = requiredFiles.filter((file) => !relativeFiles.includes(file));
const textContents = await Promise.all(
  absoluteFiles
    .filter((file) => textExtensions.has(path.extname(file)))
    .map((file) => readFile(file, "utf8")),
);
const result = validatePackageContents(relativeFiles, textContents);
const violations = [...missing.map((file) => `missing required file: ${file}`), ...result.violations];
const sidecarName = `joi-remote-sidecar${process.platform === "win32" ? ".exe" : ""}`;
const sidecarPath = path.resolve("resources", "native", process.platform, sidecarName);
try { await access(sidecarPath); }
catch { violations.push(`missing native remote sidecar: resources/native/${process.platform}/${sidecarName}`); }

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Package contents verified (${relativeFiles.length} files).\n`);
}
