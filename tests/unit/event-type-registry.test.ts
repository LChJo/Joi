import { EVENT_TYPE_REGISTRY } from "../../src/main/domain/events/event-type-registry";

describe("EventTypeRegistry", () => {
  it("is the versioned source of truth for every MVP event", () => {
    expect(EVENT_TYPE_REGISTRY.version).toBe(1);
    expect(EVENT_TYPE_REGISTRY.types()).toEqual(expect.arrayContaining([
      "system.birth", "human.message", "alarm.fired", "agent.completed", "budget.reset", "idle.explore",
    ]));
    expect(EVENT_TYPE_REGISTRY.definition("human.message")).toMatchObject({
      autoWake: true, defaultPriority: 1, maxAttempts: 8, payloadSchema: "event://v1/human.message",
    });
  });

  it("validates trusted payload shapes and quarantines unknown or malformed types", () => {
    expect(EVENT_TYPE_REGISTRY.inspect("human.message", { text: "你好" })).toMatchObject({ autoWake: true, registered: true, valid: true });
    expect(EVENT_TYPE_REGISTRY.inspect("human.message", { text: "" })).toMatchObject({ autoWake: false, registered: true, valid: false });
    expect(EVENT_TYPE_REGISTRY.inspect("alarm.fired", { alarmId: "alarm_1", occurrenceAt: "2026-07-16T08:00:00Z" })).toMatchObject({ valid: true });
    expect(EVENT_TYPE_REGISTRY.inspect("extension.unknown", { arbitrary: true })).toEqual({ autoWake: false, registered: false, valid: true });
  });

  it("declares debounce without merging current user messages", () => {
    expect(EVENT_TYPE_REGISTRY.definition("human.message")?.debounce).toBeUndefined();
    expect(EVENT_TYPE_REGISTRY.definition("budget.exhausted")?.debounce).toMatchObject({ merge: "latest" });
  });
});
