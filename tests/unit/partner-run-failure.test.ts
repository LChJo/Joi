import {
  classifyPartnerRunFailure,
  partnerRunFailureFromError,
  safePartnerRunFailureBody,
  wrapPartnerRunFailure,
} from "../../src/main/application/partners/partner-run-failure.js";

describe("partner run failure classification", () => {
  it.each([
    [{ code: "ETIMEDOUT" }, "ETIMEDOUT"],
    [{ code: "ECONNRESET" }, "ECONNRESET"],
    [{ status: 429 }, "http_429"],
    [{ statusCode: 503 }, "http_503"],
    [{ code: "partner_run_timed_out" }, "partner_run_timed_out"],
  ])("allows a fresh attempt for transient %j before side effects", (error, reasonCode) => {
    expect(classifyPartnerRunFailure(error, { phase: "MODEL", sideEffectState: "NONE" })).toEqual({
      phase: "MODEL", reasonCode, retryable: true, sideEffectState: "NONE",
    });
  });

  it.each([
    [{ status: 401 }, "http_401"],
    [{ status: 402 }, "http_402"],
    [{ code: "partner_skill_not_found" }, "partner_skill_not_found"],
    [{ code: "invalid_api_key" }, "invalid_api_key"],
  ])("does not blindly switch models for deterministic %j", (error, reasonCode) => {
    expect(classifyPartnerRunFailure(error, { phase: "MODEL", sideEffectState: "NONE" })).toEqual({
      phase: "MODEL", reasonCode, retryable: false, sideEffectState: "NONE",
    });
  });

  it("blocks replay when side effects were observed or cannot be determined", () => {
    expect(classifyPartnerRunFailure({ code: "ETIMEDOUT" }, { phase: "MODEL", sideEffectState: "OBSERVED" }).retryable).toBe(false);
    expect(classifyPartnerRunFailure({ code: "ETIMEDOUT" }, { phase: "MODEL", sideEffectState: "UNKNOWN" }).retryable).toBe(false);
  });

  it("returns only a stable code and never includes raw error text", () => {
    const failure = classifyPartnerRunFailure(new Error("PRIVATE token and payload"), {
      phase: "EXECUTION", sideEffectState: "UNKNOWN",
    });
    expect(failure).toEqual({ phase: "EXECUTION", reasonCode: "unknown_error", retryable: false, sideEffectState: "UNKNOWN" });
    expect(JSON.stringify(failure)).not.toContain("PRIVATE");
  });

  it("preserves a configuration carrier as pre-execution and gives an actionable safe message", () => {
    const wrapped = wrapPartnerRunFailure(
      Object.assign(new Error("PRIVATE absolute path"), { code: "partner_skill_ref_invalid" }),
      { phase: "CONFIGURATION", sideEffectState: "NONE" },
    );
    const failure = partnerRunFailureFromError(wrapped);
    expect(failure).toEqual({
      phase: "CONFIGURATION", reasonCode: "partner_skill_ref_invalid", retryable: false, sideEffectState: "NONE",
    });
    const body = safePartnerRunFailureBody(failure);
    expect(body).toContain("No partner model or tool was started");
    expect(body).toContain("reselect an installed Skill");
    expect(body).toContain("enable the read tool");
    expect(body).not.toContain("PRIVATE");
    expect(body).not.toContain("absolute path");
  });
});
