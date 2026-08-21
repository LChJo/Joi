/* eslint-disable @typescript-eslint/require-await */
import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import { DomainError } from "../../src/main/domain/errors.js";
import type { JoiAcceptedMessageDto } from "../../src/shared/joi";
import { createRuntimeFixture } from "../support/runtime-fixture";

const DTO: JoiAcceptedMessageDto = { acceptedAt: "2026-08-01T00:00:00.000Z", inputId: "input-1", status: "PENDING" };

function cookieFrom(response: Response) {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("missing session cookie");
  return value.split(";", 1)[0] ?? "";
}

async function startSession(
  clarify: (input: { workbenchId?: string; inputId: string; text?: string }) => Promise<JoiAcceptedMessageDto>,
  cancel: (inputId: string) => Promise<JoiAcceptedMessageDto> = async () => DTO,
  dismiss: (inputId: string) => Promise<JoiAcceptedMessageDto> = async () => DTO,
  retry: (input: { inputId: string; text?: string }) => Promise<JoiAcceptedMessageDto> = async () => DTO,
) {
  const fixture = await createRuntimeFixture();
  const clarifyCalls: { workbenchId?: string; inputId: string; text?: string }[] = [];
  const cancelCalls: string[] = [];
  const dismissCalls: string[] = [];
  const retryCalls: { inputId: string; text?: string }[] = [];
  const joiInbox = {
    accept: async () => DTO,
    cancel: async (input: { inputId: string }) => { cancelCalls.push(input.inputId); return cancel(input.inputId); },
    clarify: async (input: { workbenchId?: string; inputId: string; text?: string }) => { clarifyCalls.push(input); return clarify(input); },
    dismiss: async (input: { inputId: string }) => { dismissCalls.push(input.inputId); return dismiss(input.inputId); },
    list: async () => [DTO],
    retry: async (input: { inputId: string; text?: string }) => { retryCalls.push(input); return retry(input); },
  };
  const deps = Object.assign({}, fixture, { joiInbox });
  const listeners = await startRuntimeListeners({ handler: createApiHandler(deps), loopbackPort: 0 });
  const bootstrap = await fixture.auth.issueDesktopBootstrap();
  const authenticated = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
    body: JSON.stringify({ nonce: bootstrap.nonce }),
    headers: { "content-type": "application/json", origin: "null" },
    method: "POST",
  });
  const cookie = cookieFrom(authenticated);
  const { csrfToken } = await authenticated.json() as { csrfToken: string };
  return {
    cancelCalls,
    clarifyCalls,
    async close() { await listeners.close(); await fixture.close(); },
    dismissCalls,
    headers: { "content-type": "application/json", cookie, origin: "null", "x-csrf-token": csrfToken },
    retryCalls,
    url: listeners.loopback.url,
  };
}

describe("joi clarify HTTP route", () => {
  it("decodes the input id and forwards the resolution; the traversal loop picks it up", async () => {
    const session = await startSession(async () => DTO);
    try {
      const response = await fetch(`${session.url}/api/v1/joi/messages/${encodeURIComponent("input:1")}/clarify`, {
        body: JSON.stringify({ workbenchId: "workbench-1" }),
        headers: session.headers,
        method: "POST",
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual(DTO);
      expect(session.clarifyCalls).toEqual([{ workbenchId: "workbench-1", inputId: "input:1" }]);

      await fetch(`${session.url}/api/v1/joi/messages/input-1/clarify`, {
        body: JSON.stringify({ text: "是登录模块" }),
        headers: session.headers,
        method: "POST",
      });
      expect(session.clarifyCalls.at(-1)).toEqual({ inputId: "input-1", text: "是登录模块" });
    } finally {
      await session.close();
    }
  });

  it("maps a non-clarifiable input to a 400 and rejects unauthenticated writes", async () => {
    const session = await startSession(async () => { throw new DomainError("joi_clarification_unavailable", "not awaiting clarification"); });
    try {
      const rejected = await fetch(`${session.url}/api/v1/joi/messages/input-1/clarify`, {
        body: JSON.stringify({ workbenchId: "workbench-1" }),
        headers: session.headers,
        method: "POST",
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ code: "joi_clarification_unavailable" });

      const unauth = await fetch(`${session.url}/api/v1/joi/messages/input-1/clarify`, {
        body: JSON.stringify({ workbenchId: "workbench-1" }),
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      expect(unauth.status).toBe(401);
    } finally {
      await session.close();
    }
  });
});

describe("joi cancel HTTP route", () => {
  it("decodes the input id and cancels it without side scheduling", async () => {
    const session = await startSession(async () => DTO, async () => ({ ...DTO, canceled: true, status: "CONSUMED" }));
    try {
      const response = await fetch(`${session.url}/api/v1/joi/messages/${encodeURIComponent("input:1")}/cancel`, {
        headers: session.headers,
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...DTO, canceled: true, status: "CONSUMED" });
      expect(session.cancelCalls).toEqual(["input:1"]);
    } finally {
      await session.close();
    }
  });

  it("maps a non-cancelable input to a 400 and rejects unauthenticated writes", async () => {
    const session = await startSession(async () => DTO, async () => { throw new DomainError("joi_cancel_unavailable", "not cancelable"); });
    try {
      const rejected = await fetch(`${session.url}/api/v1/joi/messages/input-1/cancel`, {
        headers: session.headers,
        method: "POST",
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ code: "joi_cancel_unavailable" });

      const unauth = await fetch(`${session.url}/api/v1/joi/messages/input-1/cancel`, {
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      expect(unauth.status).toBe(401);
    } finally {
      await session.close();
    }
  });
});

describe("joi retry HTTP route", () => {
  it("decodes the input id and forwards optional supplementary text; the traversal loop picks it up", async () => {
    const session = await startSession(async () => DTO, async () => DTO, async () => DTO, async (input) => ({ ...DTO, inputId: input.inputId, status: "PENDING" }));
    try {
      const response = await fetch(`${session.url}/api/v1/joi/messages/${encodeURIComponent("input:1")}/retry`, {
        body: JSON.stringify({ text: "已修复搭档技能" }),
        headers: session.headers,
        method: "POST",
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ inputId: "input:1", status: "PENDING" });
      expect(session.retryCalls).toEqual([{ inputId: "input:1", text: "已修复搭档技能" }]);

      await fetch(`${session.url}/api/v1/joi/messages/input-1/retry`, {
        body: JSON.stringify({}),
        headers: session.headers,
        method: "POST",
      });
      expect(session.retryCalls.at(-1)).toEqual({ inputId: "input-1" });
    } finally {
      await session.close();
    }
  });

  it("maps a non-retryable input to a 400 and rejects unauthenticated writes", async () => {
    const session = await startSession(async () => DTO, async () => DTO, async () => DTO, async () => { throw new DomainError("joi_retry_unavailable", "not retryable"); });
    try {
      const rejected = await fetch(`${session.url}/api/v1/joi/messages/input-1/retry`, {
        body: JSON.stringify({}),
        headers: session.headers,
        method: "POST",
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ code: "joi_retry_unavailable" });

      const unauth = await fetch(`${session.url}/api/v1/joi/messages/input-1/retry`, {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      expect(unauth.status).toBe(401);
    } finally {
      await session.close();
    }
  });
});

describe("joi dismiss HTTP route", () => {
  it("decodes the input id and dismisses it without side scheduling", async () => {
    const session = await startSession(async () => DTO, async () => DTO, async () => ({ ...DTO, status: "CONSUMED" }));
    try {
      const response = await fetch(`${session.url}/api/v1/joi/messages/${encodeURIComponent("input:1")}/dismiss`, {
        headers: session.headers,
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...DTO, status: "CONSUMED" });
      expect(session.dismissCalls).toEqual(["input:1"]);
    } finally {
      await session.close();
    }
  });

  it("maps a non-dismissible input to a 400 and rejects unauthenticated writes", async () => {
    const session = await startSession(async () => DTO, async () => DTO, async () => { throw new DomainError("joi_dismiss_unavailable", "not terminal"); });
    try {
      const rejected = await fetch(`${session.url}/api/v1/joi/messages/input-1/dismiss`, {
        headers: session.headers,
        method: "POST",
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ code: "joi_dismiss_unavailable" });

      const unauth = await fetch(`${session.url}/api/v1/joi/messages/input-1/dismiss`, {
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      expect(unauth.status).toBe(401);
    } finally {
      await session.close();
    }
  });
});
