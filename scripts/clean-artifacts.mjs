import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(".");
const fixedArtifacts = [
  ".cache",
  ".vite",
  "apps/joi_mobile/android/app/src/main/jniLibs",
  "apps/joi_mobile/build",
  "coverage",
  "dist",
  "playwright-report",
  "resources/native",
  "test-results",
  "tmp",
  "temp",
];
const rootEntries = await readdir(projectRoot, { withFileTypes: true });
const generatedArtifacts = rootEntries
  .filter((entry) => (entry.isDirectory() && (entry.name === "release" || entry.name.startsWith("release-")))
    || (entry.isFile() && entry.name.endsWith(".tsbuildinfo")))
  .map((entry) => entry.name);
const targets = [...new Set([...fixedArtifacts, ...generatedArtifacts])];

const failures = [];
let cleaned = 0;
for (const target of targets) {
  const absoluteTarget = path.resolve(projectRoot, target);
  const relativeTarget = path.relative(projectRoot, absoluteTarget);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new Error(`Refusing to clean outside the project root: ${absoluteTarget}`);
  }
  try {
    process.stdout.write(`Cleaning ${relativeTarget}...\n`);
    await rm(absoluteTarget, { force: true, maxRetries: 2, recursive: true, retryDelay: 250 });
    process.stdout.write(`Cleaned ${relativeTarget}.\n`);
    cleaned += 1;
  } catch (error) {
    failures.push(`${relativeTarget}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.stdout.write(`Cleaned ${cleaned}/${targets.length} generated artifact paths.\n`);
if (failures.length > 0) {
  process.stderr.write(`Unable to clean:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
}
