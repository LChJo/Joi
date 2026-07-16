// @vitest-environment jsdom
import { ApiError, DigitalLifeApi, createApi } from "../../src/renderer/api";

function response(body: unknown, status = 200) {
  return Promise.resolve({
    json: () => Promise.resolve(body),
    ok: status >= 200 && status < 300,
    status,
  } as Response);
}

describe("renderer API client", () => {
  it("adds JSON, idempotency and CSRF semantics across the public client methods", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ items: [], csrfToken: "csrf" }));
    const api = new DigitalLifeApi("http://127.0.0.1:43130");
    api.setCsrfToken("csrf");
    await api.authStatus(); await api.bootstrap("nonce"); await api.login("password"); await api.setup("password");
    await api.logout(); await api.listSessions(); await api.logoutAllLan(); await api.changePassword("old password", "new password");
    await api.listLives(); await api.getLife("life 1"); await api.createLife({ name: "Life" }); await api.updateLife("life 1", { role: "R" });
    await api.archiveLife("life 1"); await api.getLifeDeletionImpact("life 1"); await api.changePrimaryAgent("life 1", "agent 2"); await api.deleteLife("life 1");
    await api.runtime("life 1", "pause"); await api.emergencyStopAll(); await api.sendMessage("life 1", "hello"); await api.sendMessage("life 1", "files", ["attachment 1"]); await api.listEvents("life 1"); await api.listExpressions("life 1"); await api.listActivity("life 1");
    const file = { arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer), name: "a.bin", type: "" } as File;
    await api.uploadAttachment("life 1", file);
    await api.continuity("life 1"); await api.updateSchedule("life 1", "schedule 1", "08:00", false); await api.updateRhythm("life 1", { quietStart: "23:00" });
    await api.listAgents(); await api.addAgent("http://agent/card", "token"); await api.agentAction("agent 1", "refresh"); await api.agentAction("agent 1", "refresh", {});
    await api.getAgentDeletionImpact("agent 1"); await api.deleteAgent("agent 1"); await api.rotateAgentToken("agent 1", "new"); await api.bindCollaborator("life 1", "agent 1"); await api.unbindCollaborator("life 1", "agent 1"); await api.listInteractions();
    await api.answerInteraction("interaction 1", "answer"); await api.resumeAuthorization("interaction 1"); await api.extendBudget("life 1"); await api.remindTodo("life 1", "todo 1");
    await api.createTodo("life 1", "todo"); await api.createTodo("life 1", "todo", "later"); await api.createTodo("life 1", "todo", { assignee: "agent" }); await api.updateTodo("life 1", "todo 1", { status: "DONE" });
    await api.createAlarm("life 1", "wake", "later"); await api.cancelAlarm("life 1", "alarm 1");
    await api.correctMemory("life 1", "memory 1", "fixed"); await api.forgetMemory("life 1", "memory 1"); await api.diagnostics();
    await api.settings(); await api.updateSettings({ launchAtLogin: true }); await api.listBackups(); await api.createBackup(); await api.restoreBackup("backup 1");
    expect(api.artifactUrl("life 1", "artifact 1", "preview")).toContain("artifact%201/preview");
    expect(api.diagnosticsExportUrl()).toContain("/api/v1/diagnostics/export");
    expect(fetchMock).toHaveBeenCalled();
    const write = fetchMock.mock.calls.find((call) => typeof call[0] === "string" && call[0].endsWith("/api/v1/auth/setup"));
    expect(write?.[1]?.headers).toMatchObject({ "content-type": "application/json", "x-csrf-token": "csrf" });
    fetchMock.mockRestore();
  });

  it("normalizes API errors, empty responses, and desktop bootstrap", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementationOnce(() => response(undefined, 204));
    await expect(new DigitalLifeApi("").setup("password")).resolves.toBeUndefined();
    fetchMock.mockImplementationOnce(() => response({ code: "bad", message: "失败" }, 400));
    await expect(new DigitalLifeApi("").request("/bad")).rejects.toEqual(new ApiError("bad", "失败", 400));
    fetchMock.mockImplementationOnce(() => Promise.resolve({ json: () => Promise.reject(new Error("bad")), ok: false, status: 500 } as Response));
    await expect(new DigitalLifeApi("").request("/bad-json")).rejects.toMatchObject({ code: "request_failed" });
    fetchMock.mockImplementationOnce(() => response({}, 400));
    await expect(new DigitalLifeApi("").request("/empty-error")).rejects.toMatchObject({ code: "request_failed", message: "请求未完成。" });

    window.digitalLifeDesktop = {
      createBootstrapNonce: vi.fn(() => Promise.resolve({ expiresAt: "later", nonce: "nonce" })),
      getRuntimeInfo: vi.fn(() => Promise.resolve({ apiOrigin: "http://127.0.0.1:1", platform: "win32", productName: "joi" as const, version: "1" })),
    };
    fetchMock.mockImplementationOnce(() => response({ configured: true })).mockImplementationOnce(() => response({ csrfToken: "desktop-csrf" }));
    await expect(createApi()).resolves.toMatchObject({ configured: true, desktop: true });
    delete window.digitalLifeDesktop;
    fetchMock.mockImplementationOnce(() => response({ configured: true }));
    await expect(createApi()).resolves.toMatchObject({ configured: true, desktop: false });
    fetchMock.mockRestore();
  });
});
