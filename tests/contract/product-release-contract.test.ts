import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { JoiBrand } from "../../src/renderer/JoiBrand";

const readProjectFile = (filePath: string) => readFile(path.resolve(filePath), "utf8");

describe("joi product and release contract", () => {
  it("uses joi as the package, application, document, and visible shell title", async () => {
    const [packageSource, productSource, html, readme, chineseReadme, onboarding, consoleSource] = await Promise.all([
      readProjectFile("package.json"),
      readProjectFile("src/shared/product.ts"),
      readProjectFile("index.html"),
      readProjectFile("README.md"),
      readProjectFile("README.zh-CN.md"),
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
    expect(readme).toMatch(/^# joi\r?$/m);
    expect(chineseReadme).toMatch(/^# joi\r?$/m);
    expect(onboarding).toContain("<strong>joi</strong>");
    expect(consoleSource).toContain("<JoiBrand />");
    const brandMarkup = renderToStaticMarkup(createElement(JoiBrand));
    expect(brandMarkup).toContain('aria-label="joi"');
    expect(brandMarkup).toContain(">joi</strong>");
  });

  it("removes the default native menu from the desktop window", async () => {
    const [mainSource, uxSpecification] = await Promise.all([
      readProjectFile("src/main/index.ts"),
      readProjectFile("docs/02-ux-specification.md"),
    ]);

    expect(mainSource).toContain("window.setMenu(null)");
    expect(uxSpecification).toContain("Windows 桌面窗口启动后不出现 Electron 默认原生菜单栏");
  });

  it("publishes reproducible run, clean, and package commands for agents", async () => {
    const [
      packageSource,
      agentCommands,
      commandIndex,
      devCommand,
      verifyCommand,
      packageCommand,
      cleanCommand,
      packageScript,
      cleanScript,
      ignore,
    ] = await Promise.all([
      readProjectFile("package.json"),
      readProjectFile(".agent/commands.md"),
      readProjectFile(".agent/commands/README.md"),
      readProjectFile(".agent/commands/dev.md"),
      readProjectFile(".agent/commands/verify.md"),
      readProjectFile(".agent/commands/package.md"),
      readProjectFile(".agent/commands/clean.md"),
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
    for (const commandPath of ["dev.md", "verify.md", "package.md", "clean.md"]) {
      expect(commandIndex).toContain(`(${commandPath})`);
    }
    expect(devCommand).toContain("npm run dev");
    expect(verifyCommand).toContain("npm run typecheck");
    expect(verifyCommand).toContain("npm run package:verify");
    expect(packageCommand).toContain("npm run build:mobile:android");
    expect(packageCommand).toContain("npm run package:win");
    expect(cleanCommand).toContain("npm run clean");
    expect(packageScript).toContain("supportedTargets");
    expect(packageScript).toContain("npm_execpath");
    expect(packageScript).not.toContain('const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"');
    expect(cleanScript).toContain("release-");
    expect(ignore).toContain(".harnesslite/");
    expect(ignore).toContain("*.dmp");
  });
});
