import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-assertion */

import { RemoteCommandService } from "../../src/main/application/remote/remote-command-service.js";

describe("RemoteCommandService", () => {
  it("exposes only the home feed and idempotent text submission", async () => {
    const feed = { goals: [], thinking: [], unassignedActions: [] };
    const load = vi.fn().mockResolvedValue(feed);
    const accept = vi.fn().mockResolvedValue({ acceptedAt: "2026-08-26T00:00:00.000Z", inputId: "input-1", status: "PENDING" });
    const service = new RemoteCommandService({ homeFeed: { load }, inbox: { accept } });

    await expect(service.handle({ kind: "feed.get", requestId: "request-feed" })).resolves.toEqual({
      kind: "response", requestId: "request-feed", result: feed,
    });
    await expect(service.handle({ idempotencyKey: "remote:device-1:message-1", kind: "message.send", requestId: "request-send", text: "  帮我整理今天的任务  " })).resolves.toEqual({
      kind: "response", requestId: "request-send", result: expect.objectContaining({ inputId: "input-1" }),
    });
    expect(accept).toHaveBeenCalledWith({ idempotencyKey: "remote:device-1:message-1", text: "帮我整理今天的任务" });
    await expect(service.handle({ kind: "settings.get", requestId: "request-nope" } as never)).resolves.toEqual({
      error: { code: "remote_operation_forbidden", message: "This remote operation is not available." },
      kind: "response", requestId: "request-nope",
    });
  });
});
