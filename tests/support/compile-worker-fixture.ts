import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** Compile the actual Worker import graph into disposable storage, independent of dist. */
export async function compileWorkerFixture(root: string, entries: string[]): Promise<URL[]> {
  await mkdir(root, { recursive: true });
  await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  const compiled = new Set<string>();
  const compile = async (relative: string): Promise<void> => {
    if (compiled.has(relative)) return;
    compiled.add(relative);
    const source = await readFile(relative, "utf8");
    const output = ts.transpileModule(source, { fileName: relative, compilerOptions: {
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
    } }).outputText;
    const destination = path.join(root, relative.replace(/\.ts$/u, ".js"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, output);
    for (const imported of ts.preProcessFile(output).importedFiles) {
      if (imported.fileName.startsWith(".")) {
        await compile(path.normalize(path.join(path.dirname(relative), imported.fileName.replace(/\.js$/u, ".ts"))));
      }
    }
  };
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  for (const entry of entries) await compile(entry);
  return entries.map((entry) => pathToFileURL(path.join(root, entry.replace(/\.ts$/u, ".js"))));
}
