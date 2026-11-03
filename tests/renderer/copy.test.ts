import {
  activityTitle,
  agentStatusLabel,
  eventStatusLabel,
  LIFE_STATE_LABEL,
  listenerStatusLabel,
  statusLabel,
  thinkingEffortLabel,
} from "../../src/renderer/copy";
import { configureLocale } from "../../src/renderer/i18n";

describe("friendly renderer copy", () => {
  it("AC-I18N-05 distinguishes thinking off from a close action", () => {
    configureLocale({ preference: "en" });
    expect(thinkingEffortLabel("off")).toBe("Off");
    expect(thinkingEffortLabel("high")).toBe("High");
    expect(thinkingEffortLabel("xhigh")).toBe("Very high");
  });
  it("names every life and partner state without exposing raw values", () => {
    expect(Object.values(LIFE_STATE_LABEL)).toEqual([
      "今天的次数用完了", "需要看看", "已暂停", "准备行动", "正在行动", "安静中", "已停止", "等你决定",
    ]);
    expect([
      agentStatusLabel("ACTIVE"),
      agentStatusLabel("COLLABORATOR_ONLY"),
      agentStatusLabel("DISABLED"),
      agentStatusLabel("DRAFT"),
      agentStatusLabel("ERROR"),
      agentStatusLabel("RECONFIRM_REQUIRED"),
      agentStatusLabel("TOKEN_REQUIRED"),
    ]).toEqual(["可用", "仅协作", "已停用", "待检查", "连接异常", "需要重新确认", "需要更新密钥"]);
  });

  it("turns activity and transport states into everyday language", () => {
    expect(activityTitle("DELEGATION")).toBe("搭档协作");
    expect(activityTitle("TURN")).toBe("一次对话");
    expect(activityTitle("WAKE")).toBe("一次行动");
    expect(activityTitle("FLOW")).toBe("运行记录");
    expect(statusLabel("COMPLETED")).toBe("已完成");
    expect(statusLabel("NOT_A_PUBLIC_STATUS")).toBe("状态已记录");
    expect(eventStatusLabel("CONSUMED")).toBe("已读取");
  });

  it("describes other-device access without listener jargon", () => {
    expect(listenerStatusLabel(undefined)).toBe("仅限本机");
    expect(listenerStatusLabel({ status: "listening" })).toBe("已对可信设备开放");
    expect(listenerStatusLabel({ status: "error" })).toBe("暂时无法开放");
    expect(listenerStatusLabel({ status: 42 })).toBe("待确认");
  });
});
