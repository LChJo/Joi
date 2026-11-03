import { readFile } from "node:fs/promises";
import path from "node:path";

const readProjectFile = (filePath: string) => readFile(path.resolve(filePath), "utf8");

describe("development startup contract", () => {
  it("uses the dedicated dev port consistently and proxies Runtime API requests", async () => {
    const [packageSource, viteSource] = await Promise.all([
      readProjectFile("package.json"),
      readProjectFile("vite.config.ts"),
    ]);
    const packageJson = JSON.parse(packageSource) as { scripts: Record<string, string> };
    const devScript = packageJson.scripts.dev;

    expect(devScript).toContain("wait-on tcp:43715");
    expect(devScript).toContain("VITE_DEV_SERVER_URL=http://127.0.0.1:43715");
    expect(devScript).not.toContain("45173");
    expect(devScript).not.toContain("tcp:5173");
    expect(devScript).not.toContain("127.0.0.1:5173");
    expect(viteSource).toContain("port: 43715");
    expect(viteSource).not.toContain("45173");
    expect(viteSource).toContain('"/api": "http://127.0.0.1:43130"');
    expect(viteSource).toContain("strictPort: true");
  });
});
