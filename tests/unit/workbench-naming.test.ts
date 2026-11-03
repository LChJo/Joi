import { describe, expect, it } from "vitest";

import { partnerClusterKey, partnerClusterName, proposedWorkbenchRejection, workbenchWorkspaceDisplayName, workspaceDirectoryName } from "../../src/main/domain/workbench/workbench-naming.js";

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

describe("proposed workbench rejection", () => {
  const travel = "民宿周边有皖南川藏线，落羽红杉林，青龙湾度假区，分析哪些是最值得去的景点";
  const cluster = { name: "行程规划工坊", projectLabel: "行程规划", scopeSummary: "目的地资料整理、路线与时间安排。" };

  it("accepts a durable cluster label", () => {
    expect(proposedWorkbenchRejection(travel, cluster)).toBeNull();
  });

  it("rejects a name lifted from the request", () => {
    expect(proposedWorkbenchRejection(travel, { ...cluster, name: "民宿周边有皖南川藏线，落羽红杉林，青… 工作台" })).toBe("workbench_name_echoes_input");
  });

  it("rejects a project label or scope summary that quotes the request", () => {
    expect(proposedWorkbenchRejection(travel, { ...cluster, projectLabel: "民宿周边有皖南川藏线，落羽红杉林，青龙湾度假区" })).toBe("workbench_project_label_echoes_input");
    expect(proposedWorkbenchRejection(travel, { ...cluster, scopeSummary: "围绕“民宿周边有皖南川藏线，落羽红杉林”的目标与执行过程。" })).toBe("workbench_scope_summary_echoes_input");
  });

  it("rejects an empty or run-on name", () => {
    expect(proposedWorkbenchRejection(travel, { ...cluster, name: "工坊" })).toBe("workbench_name_empty");
    expect(proposedWorkbenchRejection(travel, { ...cluster, name: "这是一段被模型当成工作台名字倒出来的很长很长的句子，读起来完全不像一个工作簇" })).toBe("workbench_name_too_long");
  });

  it("measures the name without its cluster suffix", () => {
    expect(proposedWorkbenchRejection(travel, { ...cluster, name: "皖南川藏线片区景点调研工坊" })).toBeNull();
  });
});
