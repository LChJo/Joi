import { readFile } from "node:fs/promises";
import path from "node:path";

const readProjectFile = (filePath: string) => readFile(path.resolve(filePath), "utf8");

describe("development startup contract", () => {
  it("uses the dedicated dev port consistently and proxies Runtime API requests", async () => {
    const [packageSource, viteSource, launcherSource, html] = await Promise.all([
      readProjectFile("package.json"),
      readProjectFile("vite.config.ts"),
      readProjectFile("scripts/launch-dev-electron.mjs"),
      readProjectFile("index.html"),
    ]);
    const packageJson = JSON.parse(packageSource) as { scripts: Record<string, string> };
    const devScript = packageJson.scripts.dev;

    expect(devScript).toContain("node scripts/launch-dev-electron.mjs");
    expect(devScript).toContain("--watch");
    expect(launcherSource).toContain("JOI_DEV_PORT ?? 43_715");
    expect(launcherSource).toContain("http-get://127.0.0.1:${port}/src/renderer/main.tsx");
    expect(launcherSource).toContain("VITE_DEV_SERVER_URL: origin");
    expect(viteSource).toContain("JOI_DEV_PORT ?? 43_715");
    expect(viteSource).toContain("JOI_DEV_API_PORT ?? 43_130");
    expect(viteSource).toContain("strictPort: true");
    expect(html).toContain("script-src 'self';");
    expect(viteSource).toContain('apply: "serve"');
  });
});
