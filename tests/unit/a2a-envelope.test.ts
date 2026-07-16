import {
  parseLifeActionEnvelope,
  validateLifeActionEnvelope,
  validateReadinessAck,
  validateWakeEnvelope,
} from "../../src/main/domain/a2a/digital-life-envelope";
import { RUNTIME_EXTENSION_URI } from "../../src/shared/product";

const wake = {
  collaborators: [],
  events: [{ eventId: "event_1", payload: { text: "你好" }, type: "human.message" }],
  kind: "wake",
  life: {
    lifeId: "life_1", name: "栖遥", persona: "保持连续性", personaVersion: "persona_1", principles: [], timezone: "Asia/Shanghai",
  },
  memories: [],
  now: "2026-07-15T12:00:00.000Z",
  protocol: { allowedActions: ["express", "sleep"], extensionUri: RUNTIME_EXTENSION_URI, maxTurnsRemaining: 2 },
  rhythm: {
    budget: { autonomousWakesRemaining: 24, invocationsRemaining: 100 },
    nextSchedules: [],
    quietHours: { end: "07:00", start: "23:00" },
  },
  todos: [],
  turnId: "turn_1",
  version: 1,
  wakeId: "wake_1",
};

const actions = {
  actionSetId: "aset_1",
  actions: [
    { actionId: "action_1", kind: "express", text: "我在。" },
    { actionId: "action_2", kind: "sleep", reason: "等待新事件" },
  ],
  consciousnessResidue: "已经回应，等待下一次事件。",
  continueWake: false,
  kind: "actions",
  turnId: "turn_1",
  version: 1,
  wakeId: "wake_1",
};

describe("joi A2A envelope", () => {
  it("validates bounded Wake and atomic Action envelopes", () => {
    expect(validateWakeEnvelope(wake)).toMatchObject({ wakeId: "wake_1" });
    expect(validateLifeActionEnvelope(actions, { allowedActions: ["express", "sleep"], turnId: "turn_1", wakeId: "wake_1" }))
      .toMatchObject({ actionSetId: "aset_1", actions: [{ kind: "express" }, { kind: "sleep" }] });
  });

  it("rejects oversized, mismatched, duplicate and unknown actions", () => {
    expect(() => validateWakeEnvelope({ ...wake, life: { ...wake.life, persona: "x".repeat(132_000) } })).toThrow(/128 KiB/);
    expect(() => validateLifeActionEnvelope({ ...actions, wakeId: "other" }, { allowedActions: ["express", "sleep"], turnId: "turn_1", wakeId: "wake_1" })).toThrow(/wakeId/);
    expect(() => validateLifeActionEnvelope({ ...actions, actions: [actions.actions[0], actions.actions[0]] }, { allowedActions: ["express"], turnId: "turn_1", wakeId: "wake_1" })).toThrow(/duplicate/);
    expect(() => validateLifeActionEnvelope({ ...actions, actions: [{ actionId: "action_x", kind: "shell.exec" }] }, { allowedActions: ["express"], turnId: "turn_1", wakeId: "wake_1" })).toThrow(/unknown|allowed/);
    expect(() => validateLifeActionEnvelope({ ...actions, actions: [{ actionId: "action_x", kind: "express", text: "" }] }, { allowedActions: ["express"], turnId: "turn_1", wakeId: "wake_1" })).toThrow(/text/);
    expect(() => validateLifeActionEnvelope(null, { allowedActions: [], turnId: "turn_1", wakeId: "wake_1" })).toThrow(/object/);
    expect(() => validateLifeActionEnvelope({ ...actions, turnId: "other" }, { allowedActions: ["express", "sleep"], turnId: "turn_1", wakeId: "wake_1" })).toThrow(/turnId/);
    expect(() => validateLifeActionEnvelope({ ...actions, continueWake: "yes" }, { allowedActions: ["express", "sleep"], turnId: "turn_1", wakeId: "wake_1" })).toThrow(/boolean/);
    expect(() => validateLifeActionEnvelope({ ...actions, actions: "invalid" }, { allowedActions: [], turnId: "turn_1", wakeId: "wake_1" })).toThrow(/array/);
  });

  it("validates every registered action shape as one atomic set", () => {
    const complete = {
      ...actions,
      actions: [
        { actionId: "a1", kind: "memory.append", content: "记忆" },
        { actionId: "a2", kind: "affair.upsert", title: "事务" },
        { actionId: "a3", kind: "todo.upsert", title: "待办" },
        { actionId: "a4", kind: "alarm.schedule", at: "2026-07-16T08:00:00Z", reason: "复查" },
        { actionId: "a5", kind: "delegate", agentConnectionId: "agent_2", task: "调研" },
      ],
    };
    expect(validateLifeActionEnvelope(complete, {
      allowedActions: ["memory.append", "affair.upsert", "todo.upsert", "alarm.schedule", "delegate"],
      turnId: "turn_1", wakeId: "wake_1",
    }).actions).toHaveLength(5);
  });

  it("validates revision, cancellation and interaction actions with strict optional fields", () => {
    const extended = {
      ...actions,
      actions: [
        { actionId: "r1", confidence: 0.8, content: "修订", kind: "memory.revise", memoryId: "memory_1" },
        { actionId: "r2", alarmId: "alarm_1", kind: "alarm.cancel" },
        { actionId: "r3", answer: "普通回答", interactionId: "interaction_1", kind: "interaction.answer" },
        { actionId: "r4", affairId: "affair_1", kind: "affair.upsert", status: "WAITING", title: "等待", waitingReason: "TIME" },
        { actionId: "r5", at: "2026-07-16T08:00:00+08:00", kind: "alarm.schedule", reason: "重复", repeatEveryMinutes: 60 },
      ],
    };
    expect(validateLifeActionEnvelope(extended, {
      allowedActions: ["memory.revise", "alarm.cancel", "interaction.answer", "affair.upsert", "alarm.schedule"],
      turnId: "turn_1", wakeId: "wake_1",
    }).actions).toHaveLength(5);
    const invalid = (action: Record<string, unknown>) => () => validateLifeActionEnvelope({ ...actions, actions: [action] }, {
      allowedActions: [String(action.kind)], turnId: "turn_1", wakeId: "wake_1",
    });
    expect(invalid({ actionId: "x1", kind: "affair.upsert", status: "WAITING", title: "等待" })).toThrow(/waitingReason/);
    expect(invalid({ actionId: "x2", at: "2026-07-16 08:00", kind: "alarm.schedule", reason: "无时区" })).toThrow(/timezone/);
    expect(invalid({ actionId: "x3", confidence: 2, content: "错误", kind: "memory.append" })).toThrow(/confidence/);
    expect(invalid({ actionId: "x4", content: "错误", kind: "memory.append", memoryKind: "UNKNOWN" })).toThrow(/memoryKind/);
    expect(invalid({ actionId: "x5", kind: "todo.upsert", status: "UNKNOWN", title: "错误" })).toThrow(/status/);
    expect(invalid({ actionId: "x6", agentConnectionId: "agent_1", kind: "delegate", task: "工作", title: 1 })).toThrow(/title/);
  });

  it("rejects malformed Wake collections, protocol and turn budget", () => {
    expect(() => validateWakeEnvelope({ ...wake, events: "invalid" })).toThrow(/events/);
    expect(() => validateWakeEnvelope({ ...wake, life: { ...wake.life, principles: [1] } })).toThrow(/principles/);
    expect(() => validateWakeEnvelope({ ...wake, protocol: { ...wake.protocol, extensionUri: "wrong" } })).toThrow(/extensionUri/);
    expect(() => validateWakeEnvelope({ ...wake, protocol: { ...wake.protocol, maxTurnsRemaining: -1 } })).toThrow(/non-negative/);
  });

  it("prefers extension DataPart and only accepts one fenced fallback", () => {
    const parsed = parseLifeActionEnvelope({
      artifacts: [{ name: "response.txt", text: `diagnostic\n\`\`\`digital-life-actions\n${JSON.stringify({ ...actions, actions: [] })}\n\`\`\`` }],
      parts: [{ data: actions, extensionUri: RUNTIME_EXTENSION_URI, kind: "data" }],
    });
    expect(parsed).toEqual(actions);
    expect(parseLifeActionEnvelope({
      artifacts: [{ name: "response.txt", text: `\`\`\`digital-life-actions\n${JSON.stringify(actions)}\n\`\`\`` }], parts: [],
    })).toEqual(actions);
    expect(() => parseLifeActionEnvelope({
      artifacts: [{ name: "response.txt", text: `\`\`\`digital-life-actions\n{}\n\`\`\`\n\`\`\`digital-life-actions\n{}\n\`\`\`` }], parts: [],
    })).toThrow(/exactly one/);
    expect(() => parseLifeActionEnvelope({
      artifacts: [],
      parts: [
        { data: actions, extensionUri: RUNTIME_EXTENSION_URI, kind: "data" },
        { data: actions, extensionUri: RUNTIME_EXTENSION_URI, kind: "data" },
      ],
    })).toThrow(/exactly one/);
    expect(() => parseLifeActionEnvelope({
      artifacts: [{ name: "response.txt", text: "```digital-life-actions\nnot-json\n```" }], parts: [],
    })).toThrow(/JSON/);
  });

  it("requires an exact no-side-effect readiness acknowledgement", () => {
    expect(validateReadinessAck({
      actionId: "ready_1", kind: "readiness_ack", noSideEffects: true,
      supportedActions: ["express", "sleep"], version: 1,
    }, { expectedActionId: "ready_1", requiredActions: ["express", "sleep"] })).toMatchObject({ actionId: "ready_1" });
    expect(() => validateReadinessAck({
      actionId: "wrong", kind: "readiness_ack", noSideEffects: true, supportedActions: ["express"], version: 1,
    }, { expectedActionId: "ready_1", requiredActions: ["express"] })).toThrow(/actionId/);
    expect(() => validateReadinessAck({
      actionId: "ready_1", kind: "readiness_ack", noSideEffects: true, supportedActions: [], version: 1,
    }, { expectedActionId: "ready_1", requiredActions: ["express"] })).toThrow(/support/);
  });
});
