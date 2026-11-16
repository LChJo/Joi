import { PiReasoningFailureClassifier } from "../../src/main/infrastructure/pi/pi-reasoning-failure-classifier.js";

describe("Pi reasoning failure classifier", () => {
  const classifier = new PiReasoningFailureClassifier();

  it.each([
    [{ code: "ETIMEDOUT" }, "timeout"],
    [{ code: "ECONNREFUSED" }, "connect"],
    [{ status: 429 }, "rate_limited"],
    [{ statusCode: 503 }, "server_error"],
    [{ status: 401 }, "auth"],
    [{ status: 403, detail: "Model deployment access denied" }, "access"],
    [{ status: 403, detail: "Unsupported country" }, "access"],
    [{ status: 403, detail: "Request blocked by safety policy" }, "safety_refusal"],
    [{ status: 403, detail: "Model access denied: request blocked by safety policy" }, "safety_refusal"],
    [{ status: 403, detail: "Invalid API key" }, "auth"],
    [{ status: 403 }, "auth"],
    [{ status: 402 }, "balance"],
    [{ status: 400 }, "configuration"],
    [{ code: "joi_model_toolcall_leak" }, "protocol"],
    [{ code: "custom_model_tool_capability_unverified" }, "protocol"],
  ] as const)("maps infrastructure error %j to %s", (error, expected) => {
    expect(classifier.classify(error)).toBe(expected);
  });

  it("does not guess from unknown errors", () => {
    expect(classifier.classify(new Error("something failed"))).toBeNull();
  });
});
