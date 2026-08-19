import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const productionExtensions = new Set([".cts", ".mts", ".ts", ".tsx"]);

const layerPrefixes = [
  ["src/main/domain/", "domain"],
  ["src/main/application/", "application"],
  ["src/main/infrastructure/", "infrastructure"],
  ["src/main/interfaces/", "interface"],
  ["src/main/composition/", "composition"],
  ["src/preload/", "preload"],
  ["src/renderer/", "renderer"],
  ["src/shared/", "shared"],
];

const allowedLocalLayers = {
  application: new Set(["application", "domain", "shared"]),
  composition: new Set([
    "application",
    "composition",
    "domain",
    "infrastructure",
    "interface",
    "shared",
  ]),
  domain: new Set(["domain", "shared"]),
  infrastructure: new Set(["application", "domain", "infrastructure", "shared"]),
  interface: new Set(["application", "interface", "shared"]),
  preload: new Set(["preload", "shared"]),
  renderer: new Set(["renderer", "shared"]),
  shared: new Set(["shared"]),
};

const nodeBuiltinsPattern = /^(?:node:|assert(?:\/|$)|buffer(?:\/|$)|child_process$|crypto$|events$|fs(?:\/|$)|http(?:\/|$)|https(?:\/|$)|net$|os$|path(?:\/|$)|stream(?:\/|$)|tls$|url$|util$|worker_threads$)/;
const sqlitePattern = /^(?:better-sqlite3|sqlite3|node:sqlite)(?:\/|$)/;
const a2aPattern = /^@a2a-js\/sdk(?:\/|$)/;

/** Engine SDKs stay inside their own infrastructure directory (plus type-only consumers are still violations). */
const confinedPackages = [
  { pattern: /^@rd-efficiency\/agentsdk(?:\/|$)/, prefix: "src/main/infrastructure/mana/" },
  { pattern: /^@earendil-works\/pi-(?:agent-core|ai|coding-agent)(?:\/|$)/, prefix: "src/main/infrastructure/pi/" },
];

function normalizePath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  const sourceIndex = normalized.lastIndexOf("/src/");
  return sourceIndex >= 0 ? normalized.slice(sourceIndex + 1) : normalized.replace(/^\.\//, "");
}

export function classifyProductionPath(filePath) {
  const normalized = normalizePath(filePath);
  if (normalized === "src/main/index.ts") {
    return "composition";
  }

  for (const [prefix, layer] of layerPrefixes) {
    if (normalized.startsWith(prefix)) {
      return layer;
    }
  }

  return null;
}

function classifyRelativeTarget(sourcePath, target) {
  const source = normalizePath(sourcePath);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), target));
  return classifyProductionPath(resolved);
}

function validateExternalImport(sourceLayer, target) {
  if (sourceLayer === "composition" || sourceLayer === "infrastructure") {
    return { allowed: true };
  }

  if (sourceLayer === "domain" || sourceLayer === "application" || sourceLayer === "shared") {
    if (nodeBuiltinsPattern.test(target) || sqlitePattern.test(target) || a2aPattern.test(target) || target === "electron") {
      return { allowed: false, reason: `${sourceLayer} cannot import runtime infrastructure package ${target}` };
    }
    return { allowed: true };
  }

  if (sourceLayer === "renderer") {
    if (nodeBuiltinsPattern.test(target) || sqlitePattern.test(target) || a2aPattern.test(target) || target === "electron") {
      return { allowed: false, reason: `renderer cannot import privileged package ${target}` };
    }
    return { allowed: true };
  }

  if (sourceLayer === "interface" && (sqlitePattern.test(target) || a2aPattern.test(target) || target === "electron")) {
    return { allowed: false, reason: `interface cannot import transport implementation package ${target}` };
  }

  return { allowed: true };
}

export function validateImport(sourcePath, target) {
  const sourceLayer = classifyProductionPath(sourcePath);
  if (sourceLayer === null) {
    return { allowed: false, reason: `unclassified production source ${normalizePath(sourcePath)}` };
  }

  if (!target.startsWith(".")) {
    const source = normalizePath(sourcePath);
    for (const { pattern, prefix } of confinedPackages) {
      if (pattern.test(target) && !source.startsWith(prefix)) {
        return { allowed: false, reason: `${target} is confined to ${prefix}` };
      }
    }
    return validateExternalImport(sourceLayer, target);
  }

  const targetLayer = classifyRelativeTarget(sourcePath, target);
  if (targetLayer === null) {
    return { allowed: false, reason: `import target ${target} does not belong to a production layer` };
  }

  if (!allowedLocalLayers[sourceLayer].has(targetLayer)) {
    return {
      allowed: false,
      reason: `${sourceLayer} cannot import ${targetLayer} through ${target}`,
    };
  }

  return { allowed: true };
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(absolute));
    } else if (productionExtensions.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
      files.push(absolute);
    }
  }
  return files;
}

export async function scanProductionBoundaries(sourceRoot) {
  const projectRoot = path.dirname(sourceRoot);
  const files = await walk(sourceRoot);
  const violations = [];
  const unclassified = [];

  for (const absoluteFile of files) {
    const sourceFile = normalizePath(path.relative(projectRoot, absoluteFile));
    if (classifyProductionPath(sourceFile) === null) {
      unclassified.push(sourceFile);
      continue;
    }

    const source = await readFile(absoluteFile, "utf8");
    const imports = ts.preProcessFile(source, true, true).importedFiles.map(({ fileName }) => fileName);
    for (const target of imports) {
      const result = validateImport(sourceFile, target);
      if (!result.allowed) {
        violations.push(`${sourceFile}: ${result.reason}`);
      }
    }
  }

  return { violations: violations.sort(), unclassified: unclassified.sort() };
}

async function main() {
  const result = await scanProductionBoundaries(path.resolve("src"));
  const failures = [...result.unclassified.map((file) => `Unclassified: ${file}`), ...result.violations];
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Production import boundaries passed.\n");
}

const entryPath = process.argv[1] ? pathToFileURL(fileURLToPath(pathToFileURL(process.argv[1]))).href : "";
if (entryPath === import.meta.url) {
  await main();
}
