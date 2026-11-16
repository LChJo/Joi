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
  permissions: Record<string, string>;
  jobs: {
    "release-plan": {
      outputs: Record<string, string>;
      steps: WorkflowStep[];
    };
    release?: {
      needs: string[];
      if: string;
      permissions: Record<string, string>;
      concurrency: { group: string; "cancel-in-progress": boolean };
      steps: WorkflowStep[];
    };
    verify: {
      needs: string;
      "runs-on": string;
      steps: WorkflowStep[];
      strategy: { matrix: { include?: PackagingTarget[] } };
    };
  };
  on: Record<string, unknown>;
}

const loadWorkflow = async () => parse(await readFile(path.resolve(".github/workflows/ci.yml"), "utf8")) as QualityWorkflow;

describe("CI desktop installer contract", () => {
  it("publishes both installers only after the main-branch quality matrix succeeds", async () => {
    const workflow = await loadWorkflow();
    const release = workflow.jobs.release;
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(release).toMatchObject({
      needs: ["release-plan", "verify"],
      if: "needs.release-plan.outputs.publish == 'true' && github.ref == 'refs/heads/main' && github.event_name != 'pull_request'",
      permissions: { contents: "write" },
      concurrency: { group: "desktop-release", "cancel-in-progress": false },
    });
    const downloads = release?.steps.filter(step => step.uses?.startsWith("actions/download-artifact@"));
    expect(downloads?.map(step => step.with)).toEqual([
      { name: "joi-windows", path: "release-assets" },
      { name: "joi-macos", path: "release-assets" },
    ]);
    expect(release?.steps.at(-1)).toMatchObject({
      run: "node scripts/publish-desktop-release.mjs",
      env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
    });
  });

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
    const installerCondition = "needs.release-plan.outputs.publish == 'true'";
    expect(verify.steps[packageIndex]?.if).toBe(installerCondition);
    expect(verify.steps[uploadIndex]?.if).toBe(installerCondition);
  });

  it("plans version upgrades before packaging while retaining every quality gate", async () => {
    const workflow = await loadWorkflow();
    expect(workflow.jobs.verify.needs).toBe("release-plan");
    expect(workflow.jobs["release-plan"].outputs).toEqual({ publish: "${{ steps.plan.outputs.publish }}" });
    expect(workflow.jobs["release-plan"].steps.at(-1)).toMatchObject({
      id: "plan", run: "node scripts/plan-desktop-release.mjs",
      env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
    });
    expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining(["push", "pull_request", "workflow_dispatch"]));
    const commands = workflow.jobs.verify.steps.flatMap(step => step.run ? [step.run] : []);
    expect(commands).toEqual(expect.arrayContaining([
      "npm ci", "npm run i18n:check", "npm run typecheck", "npm run lint",
      "node scripts/ci-build.mjs", "npm run test:coverage", "npx playwright test",
    ]));
    for (const step of workflow.jobs.verify.steps.filter(step => step.run && step.run !== "npm run ${{ matrix.package }}")) {
      expect(step.if).toBeUndefined();
    }
  });
});
