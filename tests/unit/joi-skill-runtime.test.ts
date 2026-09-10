import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JoiSkillRuntime } from "../../src/main/infrastructure/pi/joi-skill-runtime.js";
import { SystemSettingsService } from "../../src/main/infrastructure/operations/system-settings-service.js";

describe("main Joi selected Skills (AC-14/AC-33)", () => {
  it("can save Skills when a previously configured LAN address is offline without reconfiguring LAN", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-skills-offline-"));
    const settingsPath = path.join(root, "settings.json");
    const reconfigureLan = vi.fn(() => Promise.resolve({ status: "disabled" as const }));
    try {
      await writeFile(settingsPath, JSON.stringify({ lan: { address: "192.168.1.20", enabled: true, port: 43130, riskAccepted: true } }));
      const settings = new SystemSettingsService({
        settingsPath, getLaunchAtLogin: () => false, setLaunchAtLogin: () => undefined,
        listLanAddresses: [], reconfigureLan, validateJoiSkills: () => undefined,
      });
      expect(await settings.update({ joiSkills: ["agents/example"] })).toMatchObject({ joiSkills: ["agents/example"], lan: { enabled: true } });
      expect(reconfigureLan).not.toHaveBeenCalled();
    } finally { await rm(root, { force: true, recursive: true }); }
  });

  it("persists explicit selections, preserves them on unrelated updates and rejects invalid refs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-main-skills-"));
    const validateJoiSkills = vi.fn((refs: readonly string[]) => {
      if (refs.includes("missing")) throw new Error("skill_missing");
    });
    const options = { getLaunchAtLogin: () => false, setLaunchAtLogin: () => undefined, settingsPath: path.join(root, "settings.json"), validateJoiSkills };
    try {
      const settings = new SystemSettingsService(options);
      expect((await settings.get()).joiSkills).toEqual([]);
      await settings.update({ joiSkills: ["agents/lark-project"] });
      await settings.update({ launchAtLogin: true });
      expect((await new SystemSettingsService(options).get()).joiSkills).toEqual(["agents/lark-project"]);
      await expect(settings.update({ joiSkills: ["missing"] })).rejects.toThrow("skill_missing");
      expect((await settings.get()).joiSkills).toEqual(["agents/lark-project"]);
      await settings.update({ joiSkills: [] });
      expect((await settings.get()).joiSkills).toEqual([]);
    } finally { await rm(root, { force: true, recursive: true }); }
  });

  it("exposes only selected metadata, reads on demand and refuses revoked or unselected Skills", async () => {
    let selected = ["agents/lark-project"];
    const catalog = {
      listForEngine: () => [{ id: "agents/lark-project", displayName: "lark-project", description: "Project tools" }, { id: "agents/other", displayName: "other" }],
      readInstructions: vi.fn(() => "private skill instructions"),
      validateRefs: vi.fn(),
    };
    const runtime = new JoiSkillRuntime({ catalog, settings: { get: () => Promise.resolve({ joiSkills: selected }) } });
    const context = await runtime.prepare();
    expect(context.promptSection).toContain("agents/lark-project");
    expect(context.promptSection).not.toContain("agents/other");
    expect(context.promptSection).not.toContain("private skill instructions");
    expect(context.tools.map((tool) => tool.name)).toEqual(["joi_read_skill"]);
    const read = context.tools[0];
    if (read === undefined) throw new Error("missing Skill reader");
    await expect(read.execute("call", { skillId: "agents/other" })).rejects.toThrow();
    expect(catalog.readInstructions).not.toHaveBeenCalled();
    expect(await read.execute("call", { skillId: "agents/lark-project" })).toMatchObject({ content: [{ text: "private skill instructions" }] });
    selected = [];
    await expect(read.execute("call", { skillId: "agents/lark-project" })).rejects.toThrow();
    expect(await runtime.prepare()).toEqual({ promptSection: "", tools: [] });
  });

  it("fails closed on stale saved references with actionable guidance", async () => {
    const runtime = new JoiSkillRuntime({
      catalog: { listForEngine: () => [], readInstructions: vi.fn(), validateRefs: () => { throw new Error("private path"); } },
      settings: { get: () => Promise.resolve({ joiSkills: ["agents/missing"] }) },
    });
    const context = await runtime.prepare();
    expect(context.tools).toEqual([]);
    expect(context.promptSection).toContain("设置");
    expect(context.promptSection).not.toContain("private path");
  });
});
