import { readFile } from "node:fs/promises";
import path from "node:path";

const read = (filePath: string) => readFile(path.resolve(filePath), "utf8");

describe("JOI-01 target architecture documentation", () => {
  it("defines one global joi with Pi reasoning and Workbench-scoped context", async () => {
    const [readme, chineseReadme, glossary, prd, architecture, domain] = await Promise.all([
      read("README.md"),
      read("README.zh-CN.md"),
      read("docs/00-sources-and-glossary.md"),
      read("docs/01-product-requirements.md"),
      read("docs/03-system-architecture.md"),
      read("docs/04-domain-and-runtime.md"),
    ]);

    for (const source of [chineseReadme, glossary, prd, architecture, domain]) {
      expect(source).toMatch(/唯一全局 (?:\*\*)?joi/);
      expect(source).toContain("工作台");
    }
    expect(readme).toMatch(/single global (?:\*\*)?joi/i);
    expect(readme).toContain("Workbench");
    expect(readme).toContain("Pi");
    expect(chineseReadme).toContain("Pi");
    expect(glossary).toContain("Workbench/workbenchId/workbench.*");
    expect(domain).toContain("工作台不是 Agent");
    expect(architecture).toContain("唯一调度权威");
  });

  it("documents the first-run model network gate and exactly seven visible connection choices", async () => {
    const [ux, security] = await Promise.all([
      read("docs/02-ux-specification.md"),
      read("docs/06-security-and-operations.md"),
    ]);

    expect(ux).toContain("joi需要链接到大模型网络");
    expect(ux).toContain("Kimi、GLM、Qwen、Doubao、MiniMax、DeepSeek、通用平台");
    expect(ux).toContain("厂商 → 接入方案");
    expect(ux).toContain("Coding Plan");
    expect(ux).toContain("百炼 Token Plan");
    expect(ux).toContain("token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic");
    expect(ux).toContain("OpenAI-compatible");
    expect(ux).toContain("Anthropic-compatible");
    expect(ux).toContain("OpenAI Responses");
    expect(ux).toContain("恰好 7 个");
    expect(security).toContain("DNS rebinding");
    expect(security).toContain("safeStorage");
  });

  it("records partner revisions, migration boundaries, roadmap gates, and traceability", async () => {
    const [a2a, roadmap, assessment, release, traceability, orchestrationAdr, migrationAdr] = await Promise.all([
      read("docs/05-a2a-integration.md"),
      read("docs/07-roadmap-and-acceptance.md"),
      read("docs/08-reference-backend-assessment.md"),
      read("docs/09-release-validation-report.md"),
      read("docs/10-requirements-traceability.md"),
      read("docs/adr/0002-unique-joi-pi-workbench-orchestration.md"),
      read("docs/adr/0003-workbench-legacy-life-migration.md"),
    ]);

    expect(a2a).toContain("partnerRevisionId");
    expect(a2a).toContain("首选搭档");
    expect(roadmap).toContain("JOI-01");
    expect(roadmap).toContain("W0-W7");
    expect(assessment).toContain("工作台范围内");
    expect(release).toContain("JOI-01");
    expect(traceability).toContain("AC-30");
    expect(traceability).toContain("AC-45");
    expect(orchestrationAdr).toContain("Pi");
    expect(migrationAdr).toContain("LegacyLifeStoreAdapter");
  });
});
