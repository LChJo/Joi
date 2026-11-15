import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

interface WorkflowStep {
  env?: Record<string, string>;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string | number>;
}

interface PackagingTarget {
  artifact: string;
  installer: string;
  os: string;
  package: string;
}

interface QualityWorkflow {
  jobs: {
    verify: {
      "runs-on": string;
      steps: WorkflowStep[];
      strategy: { matrix: { include?: PackagingTarget[] } };
    };
  };
  on: Record<string, unknown>;
}

const loadWorkflow = async () => parse(await readFile(path.resolve(".github/workflows/ci.yml"), "utf8")) as QualityWorkflow;

describe("CI desktop installer contract", () => {
  it("builds the native installer on each host and exposes separate downloadable artifacts", async () => {
    const { jobs: { verify } } = await loadWorkflow();
    const targets = verify.strategy.matrix.include ?? [];

    expect(verify["runs-on"]).toBe("${{ matrix.os }}");
    expect(targets.map(target => ({ os: target.os, package: target.package, installer: target.installer }))).toEqual([
      { os: "windows-latest", package: "package:win", installer: "release-joi/*.exe" },
      { os: "macos-latest", package: "package:mac", installer: "release-joi/*.dmg" },
    ]);
    expect(new Set(targets.map(target => target.artifact)).size).toBe(2);
    expect(targets.every(target => target.artifact.length > 0)).toBe(true);

    const packageIndex = verify.steps.findIndex(step => step.run === "npm run ${{ matrix.package }}");
    const uploadIndex = verify.steps.findIndex(step => step.uses?.startsWith("actions/upload-artifact@"));
    expect(packageIndex).toBeGreaterThan(verify.steps.findIndex(step => step.run === "npx playwright test"));
    expect(uploadIndex).toBeGreaterThan(packageIndex);
    expect(verify.steps[packageIndex]).toMatchObject({ env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
    expect(verify.steps[uploadIndex]).toMatchObject({
      with: { name: "${{ matrix.artifact }}", path: "${{ matrix.installer }}", "if-no-files-found": "error" },
    });
    expect(verify.steps[packageIndex]?.if).toBeUndefined();
    expect(verify.steps[uploadIndex]?.if).toBeUndefined();
  });

  it("supports push, pull requests and manual packaging without removing quality gates", async () => {
    const workflow = await loadWorkflow();
    expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining(["push", "pull_request", "workflow_dispatch"]));
    const commands = workflow.jobs.verify.steps.flatMap(step => step.run ? [step.run] : []);
    expect(commands).toEqual(expect.arrayContaining([
      "npm ci", "npm run i18n:check", "npm run typecheck", "npm run lint",
      "node scripts/ci-build.mjs", "npm run test:coverage", "npx playwright test",
    ]));
  });
});
