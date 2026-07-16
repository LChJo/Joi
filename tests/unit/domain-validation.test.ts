import { validateAgentShell } from "../../src/main/domain/agents/agent-connection";
import { DomainError } from "../../src/main/domain/errors";
import { validateCreateLife, validateUpdateLife } from "../../src/main/domain/lives/life";

describe("domain validation", () => {
  it("normalizes safe Agent shells and rejects unsafe Agent Card URLs", () => {
    expect(validateAgentShell({ cardUrl: "http://192.168.1.20/card.json", name: " 主 Agent " })).toEqual({
      cardUrl: "http://192.168.1.20/card.json",
      name: "主 Agent",
    });
    expect(() => validateAgentShell({ cardUrl: "http://agent.invalid", name: " " })).toThrow(DomainError);
    expect(() => validateAgentShell({ cardUrl: "not a URL", name: "Agent" })).toThrow(/invalid/i);
    expect(() => validateAgentShell({ cardUrl: "ftp://agent.invalid/card", name: "Agent" })).toThrow(/HTTP/);
    expect(() => validateAgentShell({ cardUrl: "http://user:secret@agent.invalid/card", name: "Agent" })).toThrow(/HTTP/);
    expect(() => validateAgentShell({ cardUrl: "http://agent.invalid/card#token", name: "Agent" })).toThrow(/HTTP/);
    expect(() => validateAgentShell({ cardUrl: "http://agent.invalid", name: "x".repeat(121) })).toThrow(/120/);
  });

  it("normalizes complete Life input and optional fields", () => {
    expect(validateCreateLife({
      avatarUrl: " https://example.test/avatar.png ",
      initialGoal: " 建立一套可持续的个人知识系统 ",
      mainAgentConnectionId: " agent_1 ",
      name: " 栖遥 ",
      personaSummary: " 保持连续性 ",
      principles: [" 先保存事实 ", ""],
      role: " 长期伙伴 ",
      timezone: "Asia/Shanghai",
    })).toEqual({
      avatarUrl: "https://example.test/avatar.png",
      initialGoal: "建立一套可持续的个人知识系统",
      mainAgentConnectionId: "agent_1",
      name: "栖遥",
      personaSummary: "保持连续性",
      principles: ["先保存事实"],
      role: "长期伙伴",
      timezone: "Asia/Shanghai",
    });
    expect(validateCreateLife({
      avatarUrl: " ", mainAgentConnectionId: "agent_1", name: "栖遥", personaSummary: "保持连续性", role: " ", timezone: "UTC",
    })).toEqual({
      mainAgentConnectionId: "agent_1", name: "栖遥", personaSummary: "保持连续性", principles: [], timezone: "UTC",
    });
  });

  it("rejects invalid Life creation values", () => {
    const base = { mainAgentConnectionId: "agent_1", name: "栖遥", personaSummary: "保持连续性", timezone: "UTC" };
    expect(() => validateCreateLife({ ...base, name: "" })).toThrow(/1 to 80/);
    expect(() => validateCreateLife({ ...base, name: "x".repeat(81) })).toThrow(/1 to 80/);
    expect(() => validateCreateLife({ ...base, personaSummary: "" })).toThrow(/1 to 4000/);
    expect(() => validateCreateLife({ ...base, personaSummary: "x".repeat(4001) })).toThrow(/1 to 4000/);
    expect(() => validateCreateLife({ ...base, mainAgentConnectionId: " " })).toThrow(/required/);
    expect(() => validateCreateLife({ ...base, timezone: "Mars/Olympus" })).toThrow(/timezone/);
    expect(() => validateCreateLife({ ...base, principles: Array.from({ length: 21 }, () => "p") })).toThrow(/principles/);
    expect(() => validateCreateLife({ ...base, principles: ["x".repeat(501)] })).toThrow(/principles/);
    expect(() => validateCreateLife({ ...base, avatarUrl: "x".repeat(2049) })).toThrow(/2048/);
    expect(() => validateCreateLife({ ...base, initialGoal: "x".repeat(4001) })).toThrow(/4000/);
    expect(() => validateCreateLife({ ...base, role: "x".repeat(161) })).toThrow(/160/);
  });

  it("validates partial Life updates including explicit optional-field removal", () => {
    expect(validateUpdateLife({
      avatarUrl: null,
      name: " 新名字 ",
      personaSummary: " 新人格 ",
      principles: [" 原则 "],
      role: " ",
      timezone: "Asia/Tokyo",
    })).toEqual({
      avatarUrl: null,
      name: "新名字",
      personaSummary: "新人格",
      principles: ["原则"],
      role: null,
      timezone: "Asia/Tokyo",
    });
    expect(validateUpdateLife({})).toEqual({});
    expect(() => validateUpdateLife({ name: " " })).toThrow(/1 to 80/);
    expect(() => validateUpdateLife({ personaSummary: " " })).toThrow(/1 to 4000/);
    expect(() => validateUpdateLife({ timezone: "invalid/timezone" })).toThrow(/timezone/);
    expect(() => validateUpdateLife({ principles: Array.from({ length: 21 }, () => "p") })).toThrow(/principles/);
    expect(() => validateUpdateLife({ avatarUrl: "x".repeat(2049) })).toThrow(/2048/);
    expect(() => validateUpdateLife({ role: "x".repeat(161) })).toThrow(/160/);
  });
});
