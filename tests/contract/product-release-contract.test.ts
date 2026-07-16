import { readFile } from "node:fs/promises";
import path from "node:path";

const readProjectFile = (filePath: string) => readFile(path.resolve(filePath), "utf8");

describe("joi product and release contract", () => {
  it("uses joi as the package, application, document, and visible shell title", async () => {
    const [packageSource, productSource, html, readme, onboarding, consoleSource] = await Promise.all([
      readProjectFile("package.json"),
      readProjectFile("src/shared/product.ts"),
      readProjectFile("index.html"),
      readProjectFile("README.md"),
      readProjectFile("src/renderer/Onboarding.tsx"),
      readProjectFile("src/renderer/Console.tsx"),
    ]);
    const packageJson = JSON.parse(packageSource) as {
      build: { appId: string; directories: { output: string }; productName: string };
      name: string;
    };

    expect(packageJson.name).toBe("joi");
    expect(packageJson.build.productName).toBe("joi");
    expect(packageJson.build.appId).toBe("com.aimana.joi");
    expect(packageJson.build.directories.output).toBe("release-joi");
    expect(productSource).toContain('PRODUCT_NAME = "joi"');
    expect(html).toContain("<title>joi</title>");
    expect(readme.startsWith("# joi")).toBe(true);
    expect(onboarding).toContain("<strong>joi</strong>");
    expect(consoleSource).toContain("<strong>joi</strong>");
  });

  it("publishes reproducible run, clean, and package commands for agents", async () => {
    const [packageSource, agentCommands, packageScript, cleanScript, ignore] = await Promise.all([
      readProjectFile("package.json"),
      readProjectFile(".agent/commands.md"),
      readProjectFile("scripts/package-app.mjs"),
      readProjectFile("scripts/clean-artifacts.mjs"),
      readProjectFile(".gitignore"),
    ]);
    const packageJson = JSON.parse(packageSource) as { scripts: Record<string, string> };

    expect(packageJson.scripts["app:run"]).toBe("npm run build:prod && electron .");
    expect(packageJson.scripts.clean).toBe("node scripts/clean-artifacts.mjs");
    expect(packageJson.scripts["package:win"]).toContain("scripts/package-app.mjs --target win");
    expect(packageJson.scripts["package:mac"]).toContain("scripts/package-app.mjs --target mac");
    expect(packageJson.scripts["package:dir"]).toContain("scripts/package-app.mjs --target dir");
    for (const command of ["npm run dev", "npm run app:run", "npm run package:win", "npm run package:mac", "npm run package:dir"]) {
      expect(agentCommands).toContain(command);
    }
    expect(packageScript).toContain("supportedTargets");
    expect(packageScript).toContain("npm_execpath");
    expect(packageScript).not.toContain('const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"');
    expect(cleanScript).toContain("release-");
    expect(ignore).toContain(".harnesslite/");
    expect(ignore).toContain("*.dmp");
  });
});
