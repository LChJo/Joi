import { describe, expect, it } from "vitest";

import { partnerClusterKey, partnerClusterName, workbenchWorkspaceDisplayName, workspaceDirectoryName } from "../../src/main/domain/workbench/workbench-naming.js";

describe("workbench and partner naming", () => {
  it("groups frontend debugging work under the aimanadebug environment", () => {
    expect(workbenchWorkspaceDisplayName({ name: "前端调试分析", projectLabel: "数字生活", scopeSummary: "前端调试与分析" })).toBe("aimanadebug");
    expect(workspaceDirectoryName("aimanadebug")).toBe("aimanadebug");
  });

  it("names workbenches as 工坊 clusters instead of using a role name", () => {
    expect(workbenchWorkspaceDisplayName({ name: "发布工程", projectLabel: "数字生活", scopeSummary: "构建与发布" })).toBe("发布工程 工坊");
    expect(workbenchWorkspaceDisplayName({ name: "" })).toBe("工坊");
    expect(workbenchWorkspaceDisplayName({ name: "前端集成工坊" })).toBe("前端集成工坊");
  });

  it("sanitizes directory labels and falls back for path-only labels", () => {
    expect(workspaceDirectoryName("前端///调试")).toBe("前端-调试");
    expect(workspaceDirectoryName("///")).toBe("workbench");
  });

  it("names partner clusters as 搭档, normalizing role names and legacy 工坊 suffixes", () => {
    expect(partnerClusterName("资深程序员搭档")).toBe("编码搭档");
    expect(partnerClusterName("前端分析工坊")).toBe("前端分析搭档");
    expect(partnerClusterName("模型调研搭档")).toBe("模型调研搭档");
  });

  it("derives a stable reuse key by stripping one-off instance tokens", () => {
    expect(partnerClusterKey("Grok4.6 模型调研搭档")).toBe(partnerClusterKey("模型调研搭档"));
    expect(partnerClusterKey("模型调研搭档（GPT-5 专项）")).toBe(partnerClusterKey("模型调研搭档"));
    expect(partnerClusterKey("资深程序员搭档")).toBe(partnerClusterKey("编码工坊"));
    expect(partnerClusterKey("前端分析工坊")).not.toBe(partnerClusterKey("模型调研搭档"));
  });

  it("treats the legacy 工坊 suffix and 搭档 as the same reuse cluster", () => {
    expect(partnerClusterKey("前端集成工坊")).toBe(partnerClusterKey("前端集成搭档"));
  });
});
