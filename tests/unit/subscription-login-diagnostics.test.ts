import {
  SubscriptionLoginDiagnostics,
  maskEmail,
  subscriptionLoginReasonCode,
} from "../../src/main/application/model-sources/subscription-login-diagnostics.js";
import { TestClock } from "../support/runtime-fixture.js";

const STAGE_DTO_KEYS = ["stage", "outcome", "reasonCode", "at", "latencyMs"];
const LOGIN_DTO_KEYS = ["provider", "attemptId", "startedAt", "finishedAt", "outcome", "stages", "accountEmail", "grantedScopes", "missingScopes", "clientSource"];
const REVOCATION_DTO_KEYS = ["kind", "trigger", "outcome", "reasonCode", "at"];

describe("Subscription login diagnostics", () => {
  it("records ordered stages with clock-derived latency and a masked account", () => {
    const clock = new TestClock();
    const diagnostics = new SubscriptionLoginDiagnostics(clock);
    const recorder = diagnostics.start("antigravity", "antigravity_login_test_0001");
    clock.advance(50);
    recorder.record({ stage: "client_credentials", outcome: "ok" });
    recorder.note({ clientSource: "builtin" });
    clock.advance(120);
    recorder.record({ stage: "callback_listener", outcome: "fallback", reasonCode: "callback_listener_manual" });
    recorder.note({ accountEmail: "brycen@gmail.com", grantedScopes: ["aicode", "cloud-platform"], missingScopes: ["cclog"] });
    clock.advance(30);
    recorder.finish("completed");
    const dto = diagnostics.latest("antigravity");
    expect(dto).toMatchObject({
      provider: "antigravity",
      attemptId: "antigravity_login_test_0001",
      outcome: "completed",
      clientSource: "builtin",
      accountEmail: "b***@gmail.com",
      grantedScopes: ["aicode", "cloud-platform"],
      missingScopes: ["cclog"],
    });
    expect(dto?.stages).toEqual([
      { stage: "client_credentials", outcome: "ok", at: "2026-07-15T12:00:00.050Z", latencyMs: 50 },
      { stage: "callback_listener", outcome: "fallback", reasonCode: "callback_listener_manual", at: "2026-07-15T12:00:00.170Z", latencyMs: 120 },
    ]);
    expect((dto ? Object.keys(dto) : []).every((key) => LOGIN_DTO_KEYS.includes(key))).toBe(true);
    expect(dto?.stages.every((stage) => Object.keys(stage).every((key) => STAGE_DTO_KEYS.includes(key)))).toBe(true);
  });

  it("finishes once and keeps the first outcome", () => {
    const diagnostics = new SubscriptionLoginDiagnostics(new TestClock());
    const recorder = diagnostics.start("antigravity");
    recorder.finish("failed");
    recorder.finish("completed");
    expect(diagnostics.latest("antigravity")).toMatchObject({ outcome: "failed" });
    expect(diagnostics.latest("antigravity")?.finishedAt).toBeDefined();
    expect(diagnostics.latest("unknown-provider")).toBeUndefined();
  });

  it("never exposes the raw account email or unbounded text", () => {
    const diagnostics = new SubscriptionLoginDiagnostics(new TestClock());
    const recorder = diagnostics.start("antigravity");
    recorder.note({ accountEmail: "brycen@gmail.com" });
    recorder.record({ stage: "token_exchange", outcome: "failed", reasonCode: "token_exchange_rejected" });
    const serialized = JSON.stringify(diagnostics.latest("antigravity"));
    expect(serialized).not.toContain("brycen@gmail.com");
    expect(serialized).toContain("b***@gmail.com");
  });

  it("keeps at most five credential revocations", () => {
    const clock = new TestClock();
    const diagnostics = new SubscriptionLoginDiagnostics(clock);
    for (let index = 0; index < 7; index += 1) {
      diagnostics.recordRevocation({ kind: "antigravity", trigger: "delete", outcome: "revoked" });
      clock.advance(1_000);
    }
    const entries = diagnostics.revocations();
    expect(entries).toHaveLength(5);
    expect(entries[0]?.at).toBe("2026-07-15T12:00:02.000Z");
    expect(entries.at(-1)?.at).toBe("2026-07-15T12:00:06.000Z");
    expect(entries.every((entry) => Object.keys(entry).every((key) => REVOCATION_DTO_KEYS.includes(key)))).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("2026-07-15T12:00:00.000Z");
    expect(JSON.stringify(entries)).not.toContain("2026-07-15T12:00:01.000Z");
  });
});

describe("Subscription login reason codes", () => {
  it.each([
    ["401 OAuth credential rejected", "token_exchange_rejected"],
    ["401 OAuth credential invalid", "credential_invalid"],
    ["OAuth response invalid", "token_response_invalid"],
    ["OAuth HTTP 502", "token_exchange_http"],
    ["Antigravity HTTP 403", "project_discovery_http"],
    ["Antigravity project response invalid", "project_response_invalid"],
    ["Antigravity connection failed", "connection_failed"],
    ["antigravity_callback_invalid", "callback_invalid"],
  ])("maps the known prefix %s", (message, expected) => {
    expect(subscriptionLoginReasonCode(new Error(message))).toBe(expected);
  });

  it("falls back to a bounded identifier for unknown errors", () => {
    expect(subscriptionLoginReasonCode(new Error("secret fixture path /tmp/private says confidential"))).toMatch(/^[A-Za-z0-9_.:-]+$/u);
    expect(subscriptionLoginReasonCode(new Error("secret fixture path /tmp/private says confidential"))).not.toContain("secret");
    expect(subscriptionLoginReasonCode({ code: "antigravity_login_method_invalid" })).toBe("antigravity_login_method_invalid");
    expect(subscriptionLoginReasonCode("a plain string failure")).toBe("unknown_error");
  });
});

describe("Email masking", () => {
  it.each([
    ["brycen@gmail.com", "b***@gmail.com"],
    ["long.local.name@example.com", "l***@example.com"],
    ["no-at-sign", "***"],
    ["@leading", "***"],
    ["trailing@", "***"],
    ["double@@at", "***"],
    ["nested@inner@outer.com", "***"],
  ])("masks %s as %s", (email, expected) => {
    expect(maskEmail(email)).toBe(expected);
  });
});
