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
  clarify: (input: { avatarId?: string; inputId: string; text?: string }) => Promise<JoiAcceptedMessageDto>,
  cancel: (inputId: string) => Promise<JoiAcceptedMessageDto> = async () => DTO,
) {
  const fixture = await createRuntimeFixture();
  const clarifyCalls: { avatarId?: string; inputId: string; text?: string }[] = [];
  const cancelCalls: string[] = [];
  const wake = vi.fn();
  const joiInbox = {
    accept: async () => DTO,
    cancel: async (input: { inputId: string }) => { cancelCalls.push(input.inputId); return cancel(input.inputId); },
    clarify: async (input: { avatarId?: string; inputId: string; text?: string }) => { clarifyCalls.push(input); return clarify(input); },
    list: async () => [DTO],
  };
  const deps = Object.assign({}, fixture, { joiInbox, onJoiMessageAccepted: wake });
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
    headers: { "content-type": "application/json", cookie, origin: "null", "x-csrf-token": csrfToken },
    url: listeners.loopback.url,
    wake,
  };
}

describe("joi clarify HTTP route", () => {
  it("decodes the input id, forwards the resolution and wakes orchestration", async () => {
    const session = await startSession(async () => DTO);
    try {
      const response = await fetch(`${session.url}/api/v1/joi/messages/${encodeURIComponent("input:1")}/clarify`, {
        body: JSON.stringify({ avatarId: "av-1" }),
        headers: session.headers,
        method: "POST",
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual(DTO);
      expect(session.clarifyCalls).toEqual([{ avatarId: "av-1", inputId: "input:1" }]);
      expect(session.wake).toHaveBeenCalledWith("input-1");

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
        body: JSON.stringify({ avatarId: "av-1" }),
        headers: session.headers,
        method: "POST",
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ code: "joi_clarification_unavailable" });

      const unauth = await fetch(`${session.url}/api/v1/joi/messages/input-1/clarify`, {
        body: JSON.stringify({ avatarId: "av-1" }),
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
  it("decodes the input id, cancels it and does not wake orchestration", async () => {
    const session = await startSession(async () => DTO, async () => ({ ...DTO, canceled: true, status: "CONSUMED" }));
    try {
      const response = await fetch(`${session.url}/api/v1/joi/messages/${encodeURIComponent("input:1")}/cancel`, {
        headers: session.headers,
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...DTO, canceled: true, status: "CONSUMED" });
      expect(session.cancelCalls).toEqual(["input:1"]);
      expect(session.wake).not.toHaveBeenCalled();
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
