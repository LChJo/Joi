import { describe, expect, it } from "vitest";

import { partnerClusterName, workbenchWorkspaceDisplayName, workspaceDirectoryName } from "../../src/main/domain/workbench/workbench-naming.js";

describe("workbench and partner naming", () => {
  it("groups frontend debugging work under the aimanadebug environment", () => {
    expect(workbenchWorkspaceDisplayName({ name: "前端调试分析", projectLabel: "数字生活", scopeSummary: "前端调试与分析" })).toBe("aimanadebug");
    expect(workspaceDirectoryName("aimanadebug")).toBe("aimanadebug");
  });

  it("keeps workbench names cluster-oriented instead of using a role name", () => {
    expect(workbenchWorkspaceDisplayName({ name: "发布工程", projectLabel: "数字生活", scopeSummary: "构建与发布" })).toBe("发布工程 工作区");
    expect(workbenchWorkspaceDisplayName({ name: "" })).toBe("工作区");
  });

  it("sanitizes directory labels and falls back for path-only labels", () => {
    expect(workspaceDirectoryName("前端///调试")).toBe("前端-调试");
    expect(workspaceDirectoryName("///")).toBe("workbench");
  });

  it("groups senior programmer partners under a coding workshop", () => {
    expect(partnerClusterName("资深程序员搭档")).toBe("编码工坊");
    expect(partnerClusterName("前端分析工坊")).toBe("前端分析工坊");
  });
});
