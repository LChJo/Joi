import {
  LOCAL_DISPATCH_CAPACITY_REASONS,
  LocalDispatchCapacityController,
} from "../../src/main/application/work/local-dispatch-capacity.js";

describe("local dispatch capacity", () => {
  it("limits one partner to four reservations without consuming a global slot", () => {
    const capacity = new LocalDispatchCapacityController();
    for (let index = 1; index <= 4; index += 1) {
      expect(capacity.reserve({ dispatchAttemptId: `same-${String(index)}`, partnerId: "partner-a" }))
        .toEqual({ acquired: true });
    }
    expect(capacity.reserve({ dispatchAttemptId: "same-5", partnerId: "partner-a" })).toEqual({
      acquired: false,
      reasonCode: LOCAL_DISPATCH_CAPACITY_REASONS.partner,
    });
    expect(capacity.snapshot()).toEqual({ global: 4, partners: { "partner-a": 4 } });
  });

  it("queues the ninth local run globally and releases by dispatch attempt", () => {
    const capacity = new LocalDispatchCapacityController();
    for (let index = 1; index <= 8; index += 1) {
      expect(capacity.reserve({
        dispatchAttemptId: `attempt-${String(index)}`,
        partnerId: index <= 4 ? "partner-a" : "partner-b",
      })).toEqual({ acquired: true });
    }
    expect(capacity.reserve({ dispatchAttemptId: "attempt-9", partnerId: "partner-c" })).toEqual({
      acquired: false,
      reasonCode: LOCAL_DISPATCH_CAPACITY_REASONS.global,
    });
    capacity.release("attempt-1");
    expect(capacity.reserve({ dispatchAttemptId: "attempt-9", partnerId: "partner-c" })).toEqual({ acquired: true });
    expect(capacity.snapshot().global).toBe(8);
  });

  it("treats a repeated reservation for the same attempt as idempotent", () => {
    const capacity = new LocalDispatchCapacityController({ global: 1, perPartner: 1 });
    expect(capacity.reserve({ dispatchAttemptId: "same", partnerId: "partner-a" })).toEqual({ acquired: true });
    expect(capacity.reserve({ dispatchAttemptId: "same", partnerId: "partner-a" })).toEqual({ acquired: true });
    expect(capacity.snapshot().global).toBe(1);
  });
});
