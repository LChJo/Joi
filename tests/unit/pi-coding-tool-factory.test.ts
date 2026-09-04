import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BuiltinPiCodingToolFactory } from "../../src/main/infrastructure/pi/pi-coding-tool-factory.js";

// Every case spawns real `node -e` subprocesses through the bash tool; cold starts
// exceed vitest's default 5s per-test timeout under load, so widen it for this file.
vi.setConfig({ testTimeout: 30_000 });

describe("Pi coding tool workspace scope", () => {
  it("passes a broad non-secret baseline but rejects unknown environment variables", async () => {
    const root = mkdtempSync(join(tmpdir(), "joi-pi-env-scope-"));
    const previousHome = process.env.HOME;
    const previousSecret = process.env.UNRELATED_PRIVATE_VALUE;
    process.env.HOME = "safe-home-sentinel";
    process.env.UNRELATED_PRIVATE_VALUE = "private-sentinel-never-print";
    try {
      const [bash] = new BuiltinPiCodingToolFactory().create(root, ["bash"]);
      if (bash === undefined) throw new Error("bash tool missing");
      const result = await bash.execute("call-baseline", {
        command: `node -e "process.stdout.write((process.env.HOME ? 'home-present' : 'home-missing') + ':' + (process.env.UNRELATED_PRIVATE_VALUE ? 'secret-present' : 'secret-missing'))"`,
      });
      expect(JSON.stringify(result.content)).toContain("home-present:secret-missing");
      expect(JSON.stringify(result.content)).not.toContain("private-sentinel-never-print");
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousSecret === undefined) delete process.env.UNRELATED_PRIVATE_VALUE; else process.env.UNRELATED_PRIVATE_VALUE = previousSecret;
    }
  });

  it("passes a secret only when both the operator and selected Skill grant its name", async () => {
    const root = mkdtempSync(join(tmpdir(), "joi-pi-env-scope-"));
    const previousKey = process.env.TAVILY_API_KEY;
    const previousGrant = process.env.JOI_PARTNER_ENV_PASSTHROUGH;
    process.env.TAVILY_API_KEY = "test-sentinel-never-print";
    process.env.JOI_PARTNER_ENV_PASSTHROUGH = " TAVILY_API_KEY ";
    try {
      const [notRequested] = new BuiltinPiCodingToolFactory().create(root, ["bash"]);
      if (notRequested === undefined) throw new Error("bash tool missing");
      const deniedResult = await notRequested.execute("call-not-requested", {
        command: `node -e "process.stdout.write(process.env.TAVILY_API_KEY ? 'present' : 'missing')"`,
      });
      expect(JSON.stringify(deniedResult.content)).toContain("missing");

      const [granted] = new BuiltinPiCodingToolFactory().create(root, ["bash"], {
        environmentKeys: ["TAVILY_API_KEY"],
      });
      if (granted === undefined) throw new Error("bash tool missing");
      const grantedResult = await granted.execute("call-granted", {
        command: `node -e "process.stdout.write(process.env.TAVILY_API_KEY ? 'present' : 'missing')"`,
      });
      expect(JSON.stringify(grantedResult.content)).toContain("present");
      expect(JSON.stringify(grantedResult.content)).not.toContain("test-sentinel-never-print");
    } finally {
      if (previousKey === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = previousKey;
      if (previousGrant === undefined) delete process.env.JOI_PARTNER_ENV_PASSTHROUGH;
      else process.env.JOI_PARTNER_ENV_PASSTHROUGH = previousGrant;
    }
  });

  it("treats the workspace as a home base without enforcing path boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "joi-pi-open-scope-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "inside.txt"), "workspace body");
    writeFileSync(outside, "external body");

    const [read] = new BuiltinPiCodingToolFactory().create(workspace, ["read"]);
    if (read === undefined) throw new Error("read tool missing");
    const workspaceResult = await read.execute("call-workspace", { path: "inside.txt" });
    const outsideResult = await read.execute("call-outside", { path: outside });
    const traversalResult = await read.execute("call-traversal", { path: "../outside.txt" });
    expect(JSON.stringify(workspaceResult.content)).toContain("workspace body");
    // External access is prompt governance plus audit, not tool enforcement: partners may
    // leave the workspace when the task requires it and must report outside writes.
    expect(JSON.stringify(outsideResult.content)).toContain("external body");
    expect(JSON.stringify(traversalResult.content)).toContain("external body");
  });

  it("returns staged PNG files as image content for a vision-capable partner model", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "joi-pi-image-read-"));
    writeFileSync(join(workspace, "screen.png"), Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ));
    const [read] = new BuiltinPiCodingToolFactory().create(workspace, ["read"]);
    if (read === undefined) throw new Error("read tool missing");
    const output = await read.execute("call-image", { path: "screen.png" });
    expect(output.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ mimeType: "image/png", type: "image" }),
    ]));
  });

  it("rejects unknown tools and non-directory workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "joi-pi-open-scope-"));
    expect(() => new BuiltinPiCodingToolFactory().create(root, ["frobnicate"])).toThrow("partner_tool_not_allowed");
    expect(() => new BuiltinPiCodingToolFactory().create(join(root, "missing-dir"), ["read"])).toThrow();
  });
});
