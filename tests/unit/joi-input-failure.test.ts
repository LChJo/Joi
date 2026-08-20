import {
  normalizeJoiFailureReasonCode,
  suggestedActionForJoiInputFailure,
} from "../../src/main/application/joi/joi-input-failure.js";

describe("joi input failure presentation", () => {
  it("maps bounded reason codes to safe next actions", () => {
    expect(suggestedActionForJoiInputFailure("unsafe_reasoning_tool")).toBe("RESTART_OR_UPDATE");
    expect(suggestedActionForJoiInputFailure("model_unavailable")).toBe("CHECK_MODEL_SOURCE");
    expect(suggestedActionForJoiInputFailure("joi_task_turn_failed")).toBe("RETRY_OR_EXPORT_DIAGNOSTICS");
  });

  it("never exposes free-form or oversized error content as a reason code", () => {
    expect(normalizeJoiFailureReasonCode("unsafe_reasoning_tool")).toBe("unsafe_reasoning_tool");
    expect(normalizeJoiFailureReasonCode(undefined)).toBe("unknown_error");
    expect(normalizeJoiFailureReasonCode("private message with spaces")).toBe("unknown_error");
    expect(normalizeJoiFailureReasonCode("x".repeat(81))).toBe("unknown_error");
  });
});
