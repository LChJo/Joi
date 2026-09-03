import {
  classifyPartnerRunFailure,
  partnerRunArtifactsFromError,
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
    [{ code: "partner_run_idle_timed_out" }, "partner_run_idle_timed_out"],
    [{ code: "partner_run_timed_out" }, "partner_run_timed_out"],
    [{ code: "partner_tool_timed_out" }, "partner_tool_timed_out"],
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
    for (const code of ["ETIMEDOUT", "partner_run_idle_timed_out", "partner_tool_timed_out"]) {
      expect(classifyPartnerRunFailure({ code }, { phase: "MODEL", sideEffectState: "OBSERVED" }).retryable).toBe(false);
      expect(classifyPartnerRunFailure({ code }, { phase: "MODEL", sideEffectState: "UNKNOWN" }).retryable).toBe(false);
    }
  });

  it("treats the provider's generic connection signal as transient before side effects", () => {
    expect(classifyPartnerRunFailure({ code: "connection_error" }, { phase: "MODEL", sideEffectState: "NONE" })).toEqual({
      phase: "MODEL", reasonCode: "connection_error", retryable: true, sideEffectState: "NONE",
    });
  });

  it("returns only a stable code and never includes raw error text", () => {
    const failure = classifyPartnerRunFailure(new Error("PRIVATE token and payload"), {
      phase: "EXECUTION", sideEffectState: "UNKNOWN",
    });
    expect(failure).toEqual({ phase: "EXECUTION", reasonCode: "unknown_error", retryable: false, sideEffectState: "UNKNOWN" });
    expect(JSON.stringify(failure)).not.toContain("PRIVATE");
  });

  it("falls back safely for null and malformed failure carriers", () => {
    expect(partnerRunArtifactsFromError(null)).toEqual([]);
    expect(partnerRunArtifactsFromError({ partialArtifacts: [null] })).toEqual([]);
    expect(partnerRunFailureFromError(null)).toEqual({
      phase: "EXECUTION", reasonCode: "unknown_error", retryable: false, sideEffectState: "UNKNOWN",
    });
    expect(partnerRunFailureFromError({
      partnerRunFailure: { phase: "MODEL", reasonCode: "contains spaces", retryable: true, sideEffectState: "OBSERVED" },
    })).toEqual({
      phase: "EXECUTION", reasonCode: "unknown_error", retryable: false, sideEffectState: "UNKNOWN",
    });
  });

  it("normalizes a provider 400 caused by an exhausted completion budget without retaining detail", () => {
    const raw = { detail: "HTTP 400: max_completion_tokens must be greater than or equal to 1", status: 400 };
    const failure = classifyPartnerRunFailure(raw, { phase: "MODEL", sideEffectState: "OBSERVED" });
    expect(failure).toEqual({
      phase: "MODEL", reasonCode: "model_context_budget_exhausted", retryable: false, sideEffectState: "OBSERVED",
    });
    const wrapped = wrapPartnerRunFailure(raw, { phase: "MODEL", sideEffectState: "OBSERVED" });
    expect(wrapped).not.toHaveProperty("detail");
    expect(JSON.stringify(wrapped)).not.toContain("max_completion_tokens");
  });

  it.each([
    ["HTTP 400: invalid model 'PRIVATE-model-id' for this route", "invalid_model"],
    ["status 400 unsupported parameter: PRIVATE-field", "unsupported_parameter"],
    ["400 invalid_request_error: PRIVATE malformed request", "invalid_request"],
  ])("classifies actionable provider 400 details as %s without retaining their text", (detail, reasonCode) => {
    const raw = { detail, status: 400 };
    expect(classifyPartnerRunFailure(raw, { phase: "MODEL", sideEffectState: "OBSERVED" })).toEqual({
      phase: "MODEL", reasonCode, retryable: false, sideEffectState: "OBSERVED",
    });
    const wrapped = wrapPartnerRunFailure(raw, { phase: "MODEL", sideEffectState: "OBSERVED" });
    expect(JSON.stringify(wrapped)).not.toContain("PRIVATE");
    expect(wrapped).not.toHaveProperty("detail");
  });

  it("keeps an unrecognized provider 400 generic and non-retryable", () => {
    expect(classifyPartnerRunFailure({ detail: "HTTP 400: PRIVATE provider validation", status: 400 }, {
      phase: "MODEL", sideEffectState: "NONE",
    })).toEqual({ phase: "MODEL", reasonCode: "http_400", retryable: false, sideEffectState: "NONE" });
  });

  it("preserves only bounded artifact metadata from a failed run", () => {
    const wrapped = Object.assign(new Error("private model output"), {
      partialArtifacts: [
        { artifactRef: "workspace://workbench/file/report.html", mimeType: "text/html", name: "report.html", size: 42 },
        { name: "bad", size: -1 },
      ],
    });
    expect(partnerRunArtifactsFromError(wrapped)).toEqual([{
      artifactRef: "workspace://workbench/file/report.html", mimeType: "text/html", name: "report.html", size: 42,
    }]);
    expect(partnerRunArtifactsFromError({ partialArtifacts: [{ name: "plain.txt", size: 1 }] })).toEqual([
      { name: "plain.txt", size: 1 },
    ]);
  });

  it.each([
    ["context_too_large", "exceeded the model route's context window"],
    ["invalid_model", "compatible READY model"],
    ["unsupported_parameter", "valid model route"],
    ["invalid_request", "valid model route"],
    ["model_context_budget_exhausted", "no safe completion budget left"],
    ["model_refused", "refused this request"],
  ])("provides a safe recovery direction for %s", (reasonCode, expected) => {
    expect(safePartnerRunFailureBody({ phase: "MODEL", reasonCode, retryable: false, sideEffectState: "NONE" }))
      .toContain(expected);
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
