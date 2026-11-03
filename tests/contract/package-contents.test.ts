import { readFileSync } from "node:fs";

import { validatePackageContents } from "../../scripts/package-contents.mjs";

describe("production package contents", () => {
  it("rejects secrets, development files, real user data, and source paths", () => {
    const result = validatePackageContents(
      [
        "dist/electron/main/index.js",
        "dist/renderer/index.html",
        ".env.production",
        "userData/life.sqlite",
      ],
      ["const token = 'test-token-secret';", "I:\\aimana\\digital-life"],
    );

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(".env.production"),
        expect.stringContaining("userData/life.sqlite"),
        expect.stringContaining("test-token-secret"),
        expect.stringContaining("source path"),
      ]),
    );
  });

  it("accepts the expected production shape", () => {
    const result = validatePackageContents(
      ["dist/electron/main/index.js", "dist/electron/preload/index.cjs", "dist/renderer/index.html"],
      ["joi", "urn:aimana:digital-life-runtime:v1"],
    );

    expect(result.violations).toEqual([]);
  });

  it("excludes transitive Codex CLI binaries while retaining the SDK bridge", () => {
    const packageLock = readFileSync("package-lock.json", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      build?: { asarUnpack?: string[]; files?: string[] };
      dependencies?: Record<string, string>;
    };
    const files = packageJson.build?.files ?? [];

    expect(packageJson.dependencies?.["@rd-efficiency/agentsdk"]).toBeUndefined();
    expect(packageLock).not.toContain("@rd-efficiency/agentsdk");
    expect(packageJson.dependencies?.["@anthropic-ai/claude-agent-sdk"]).toBe("0.3.251");
    expect(packageJson.dependencies?.["@openai/codex-sdk"]).toBe("0.151.0");
    expect(packageJson.build?.asarUnpack ?? []).not.toContain("node_modules/@rd-efficiency/**");

    expect(files).toEqual(expect.arrayContaining([
      "!node_modules/@openai/codex/**",
      "!node_modules/@openai/codex-darwin-arm64/**",
      "!node_modules/@openai/codex-darwin-x64/**",
      "!node_modules/@openai/codex-linux-arm64/**",
      "!node_modules/@openai/codex-linux-x64/**",
      "!node_modules/@openai/codex-win32-arm64/**",
      "!node_modules/@openai/codex-win32-x64/**",
    ]));
    expect(files).not.toContain("!node_modules/@openai/codex-sdk/**");
    expect(files).toEqual(expect.arrayContaining([
      "!node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-win32-arm64/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/**",
    ]));
  });
});
