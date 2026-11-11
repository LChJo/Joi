import assert from "node:assert/strict";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename,dirname,join,resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { BuiltinPiCodingToolFactory } from "../dist/electron/main/infrastructure/pi/pi-coding-tool-factory.js";

const root = await mkdtemp(join(tmpdir(),"joi-exploration-"));
const repeats = 11;
const median = values => [...values].sort((a,b) => a - b)[Math.floor(values.length / 2)];
try {
  await mkdir(join(root,".git"));
  await writeFile(join(root,".gitignore"),"ignored/\n");
  await mkdir(join(root,"ignored"));await writeFile(join(root,"ignored","excluded.tsx"),"BENCH_TARGET\n");
  for (let area = 0;area < 32;area++) {
    const dir = join(root,"src",`area-${String(area).padStart(3,"0")}`);await mkdir(dir,{ recursive: true });
    await Promise.all(Array.from({ length: 30 },(_,file) => writeFile(join(dir,`file-${String(file).padStart(3,"0")}.tsx`),
      Array.from({ length: 60 },(_,line) => `export const line${String(line + 1)} = '${file === 0 && line === 14 ? "BENCH_TARGET" : "synthetic"}';`).join("\n") + "\n")));
  }
  const tools = new BuiltinPiCodingToolFactory().create(root,["grep","find","read","bash"]);
  let callId = 0;
  const execute = async (name,args) => {
    const tool = tools.find(candidate => candidate.name === name);assert(tool);
    const start = performance.now(),result = await tool.execute(`benchmark-${String(++callId)}`,args);
    return { ms: performance.now() - start,text: result.content.filter(item => item.type === "text").map(item => item.text).join("\n") };
  };
  const rows = [],normalizePaths = text => text.split(/\r?\n/u).map(line => line.replaceAll("\\","/").replace(/^\.?\/?src\//u,"")).filter(Boolean).sort();
  const cases = [
    { task: "content-search",name: "grep",args: { pattern: "BENCH_TARGET",path: "src",glob: "*.tsx" },command: "rg -n --glob '*.tsx' -- 'BENCH_TARGET' src",normalize: text => normalizePaths(text).map(line => line.replace(/(:\d+:) (?=export const)/u,"$1")),count: 32 },
    { task: "file-glob",name: "find",args: { pattern: "*.tsx",path: "src",limit: 2000 },command: "rg --files --glob '*.tsx' src",normalize: normalizePaths,count: 960 },
    { task: "read-range",name: "read",args: { path: "src/area-000/file-000.tsx",offset: 11,limit: 20 },command: "sed -n '11,30p' src/area-000/file-000.tsx",normalize: text => text.split(/\r?\n/u).filter(line => /^export const line\d+ = /u.test(line)),count: 20 },
  ];
  for (const item of cases) {
    const dedicated = [],shell = [];
    for (let repeat = 0;repeat <= repeats;repeat++) {
      const runDedicated = () => execute(item.name,item.args),runShell = () => execute("bash",{ command: item.command });
      let a,b;
      if (repeat % 2 === 0) { a = await runDedicated();b = await runShell(); }
      else { b = await runShell();a = await runDedicated(); }
      assert.deepEqual(item.normalize(a.text),item.normalize(b.text));assert.equal(item.normalize(a.text).length,item.count);
      if (repeat > 0) { dedicated.push(a.ms);shell.push(b.ms); }
    }
    rows.push({ task: item.task,matchingRecords: item.count,dedicatedMedianMs: Math.round(median(dedicated) * 100) / 100,bashMedianMs: Math.round(median(shell) * 100) / 100 });
  }
  process.stdout.write(JSON.stringify({ files: 960,repeats,warmupsPerCase: 1,modelRequests: 0,measurements: rows },null,2) + "\n");
} finally {
  assert.equal(resolve(dirname(root)),resolve(tmpdir()));assert(basename(root).startsWith("joi-exploration-"));
  await rm(root,{ recursive: true,force: true });
}
