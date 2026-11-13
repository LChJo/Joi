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
  it.each([
    [403,"request_forbidden","权限"],[429,"request_rate_limited","请求过于频繁"],[503,"connection_unavailable","连接暂时中断"],
  ])("REL-03 safely classifies a non-JSON HTTP %s without exposing its response",async (status,code,label) => {
    const fetchMock = vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(new Response("PRIVATE_UPSTREAM_SENTINEL",{ status }));
    try {
      const failure: unknown = await new DigitalLifeApi("").getConversation("first").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({ code,status });
      expect((failure as ApiError).displayMessage).toContain(label);
      expect(JSON.stringify(failure)).not.toContain("PRIVATE_UPSTREAM_SENTINEL");
    } finally { fetchMock.mockRestore(); }
  });
  it("REL-02/03 bounds stalled reads and classifies empty proxy and authentication failures",async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis,"fetch");
    try {
      fetchMock.mockResolvedValueOnce(new Response("PRIVATE_PROXY_BODY",{ status: 502 }));
      await expect(new DigitalLifeApi("").getConversation("first")).rejects.toMatchObject({ code: "connection_unavailable",status: 502 });
      fetchMock.mockImplementationOnce(() => response({},401));
      await expect(new DigitalLifeApi("").getConversation("first")).rejects.toMatchObject({ code: "authentication_required",status: 401 });
      let aborted = false;
      fetchMock.mockImplementationOnce((_url,options) => new Promise((_resolve,reject) => {
        options?.signal?.addEventListener("abort",() => { aborted = true;reject(new DOMException("aborted","AbortError")); });
      }));
      const read = new DigitalLifeApi("").getConversation("first");
      const assertion = expect(read).rejects.toMatchObject({ code: "read_timed_out",status: 0 });
      await vi.advanceTimersByTimeAsync(10_000);await assertion;
      expect(aborted).toBe(true);
    } finally { fetchMock.mockRestore();vi.useRealTimers(); }
  });
  it("adds JSON, idempotency and CSRF semantics across the public client methods", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ items: [], csrfToken: "csrf" }));
    const api = new DigitalLifeApi("http://127.0.0.1:43130");
    api.setCsrfToken("csrf");
    await api.authStatus(); await api.bootstrap("nonce"); await api.login("password"); await api.setup("password");
    await api.statistics({ from: "2026-09-01", to: "2026-09-22", timeZone: "Asia/Shanghai", workbenchId: "unassigned", modelKey: "codex:gpt 5", purpose: "summary" });
    await api.logout(); await api.listSessions(); await api.logoutAllLan(); await api.changePassword("old password", "new password");
    await api.joiSnapshot(); await api.listWorkbenches(); await api.createWorkbench({ name: "Workbench", personaSummary: "Persona", projectLabel: "Project", scopeSummary: "Scope" });
    await api.archiveWorkbench("workbench 1");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:43130/api/v1/workbenches/workbench%201/archive", expect.objectContaining({ method: "POST" }));
    await api.getWorkbench("workbench 1"); await api.updateWorkbench("workbench 1", { name: "Updated", persona: "New persona" });
    await api.bindWorkbenchWorkspace("workbench 1"); await api.rebuildWorkbenchWorkspace("workbench 1");
    await api.joiHomeFeed(); await api.listWorkbenchAgents("workbench 1", { cursor: "agent cursor", limit: 12 });
    await api.agentConversation("workbench 1", "agent 1", { cursor: "entry cursor", limit: 30 });
    await api.openWorkbenchArtifact("workbench 1", { artifactId: "artifact 1", mode: "REVEAL", source: "GOAL", sourceId: "goal 1" });
    await api.revealWorkbenchToolTrace("workbench 1", "agent 1", "toolu 1");
    await api.deleteWorkbenchAgent("workbench 1", "agent 1");
    await api.decideWorkbenchChange("change 1", "CONFIRM"); await api.listPartners(); await api.deletePartner("partner 1");
    await api.listJoiMessages(); await api.listJoiActivity(); await api.sendJoiMessage("hi"); await api.sendJoiMessage("hi", { attachmentIds: ["attachment 1"] }); await api.sendJoiMessage("hi", { workbenchId: "workbench-1" });
    await api.clarifyJoiMessage("input 1", { workbenchId: "workbench-1" }); await api.clarifyJoiMessage("input 1", { text: "more" }); await api.clarifyJoiMessage("input 1", { partnerId: "partner-1" }); await api.cancelJoiMessage("input 1"); await api.dismissJoiMessage("input 1"); await api.scenarios(); await api.createScenarioPartners("scenario 1", ["role 1"]);
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
    await api.correctMemory("life 1", "memory 1", "fixed"); await api.forgetMemory("life 1", "memory 1"); await api.diagnostics(); await api.checkDatabaseIntegrity();
    await api.settings(); await api.updateSettings({ launchAtLogin: true }); await api.listBackups(); await api.createBackup(); await api.restoreBackup("backup 1");
    expect(api.artifactUrl("life 1", "artifact 1", "preview")).toContain("artifact%201/preview");
    expect(api.diagnosticsExportUrl()).toContain("/api/v1/diagnostics/export");
    expect(fetchMock.mock.calls.some((call) => typeof call[0] === "string" && call[0].endsWith("/api/v1/diagnostics/integrity-check") && call[1]?.method === "POST")).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((call) => call[0] === "http://127.0.0.1:43130/api/v1/statistics?from=2026-09-01&to=2026-09-22&timeZone=Asia%2FShanghai&workbenchId=unassigned&modelKey=codex%3Agpt+5&purpose=summary")).toBe(true);
    const write = fetchMock.mock.calls.find((call) => typeof call[0] === "string" && call[0].endsWith("/api/v1/auth/setup"));
    expect(write?.[1]?.headers).toMatchObject({ "content-type": "application/json", "x-csrf-token": "csrf" });
    const sendCalls = fetchMock.mock.calls.filter((call) => typeof call[0] === "string" && call[0].endsWith("/api/v1/joi/messages") && call[1]?.method === "POST");
    expect(sendCalls.map((call) => call[1]?.body)).toEqual(expect.arrayContaining([
      JSON.stringify({ text: "hi", attachmentIds: ["attachment 1"] }),
      JSON.stringify({ text: "hi", workbenchId: "workbench-1" }),
    ]));
    const clarifyCalls = fetchMock.mock.calls.filter((call) => typeof call[0] === "string" && call[0].endsWith("/api/v1/joi/messages/input%201/clarify"));
    expect(clarifyCalls.map((call) => call[1]?.body)).toEqual(expect.arrayContaining([JSON.stringify({ workbenchId: "workbench-1" }), JSON.stringify({ text: "more" }), JSON.stringify({ partnerId: "partner-1" })]));
    expect(clarifyCalls.every((call) => call[1]?.method === "POST")).toBe(true);
    const cancelCalls = fetchMock.mock.calls.filter((call) => typeof call[0] === "string" && call[0].endsWith("/api/v1/joi/messages/input%201/cancel"));
    expect(cancelCalls.length).toBeGreaterThan(0);
    expect(cancelCalls.every((call) => call[1]?.method === "POST")).toBe(true);
    const dismissCalls = fetchMock.mock.calls.filter((call) => typeof call[0] === "string" && call[0].endsWith("/api/v1/joi/messages/input%201/dismiss"));
    expect(dismissCalls.length).toBeGreaterThan(0);
    expect(dismissCalls.every((call) => call[1]?.method === "POST")).toBe(true);
    expect(fetchMock.mock.calls.some((call) => typeof call[0] === "string"
      && call[0].endsWith("/api/v1/workbenches/workbench%201/agents?cursor=agent%20cursor&limit=12"))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => typeof call[0] === "string"
      && call[0].endsWith("/api/v1/workbenches/workbench%201/agents/agent%201/conversation?cursor=entry%20cursor&limit=30"))).toBe(true);
    const revealTrace = fetchMock.mock.calls.find((call) => typeof call[0] === "string"
      && call[0].endsWith("/api/v1/workbenches/workbench%201/agents/agent%201/tool-traces/toolu%201/reveal"));
    expect(revealTrace?.[1]).toMatchObject({ method: "POST" });
    const openArtifact = fetchMock.mock.calls.find((call) => typeof call[0] === "string"
      && call[0].endsWith("/api/v1/workbenches/workbench%201/artifacts/artifact%201/open"));
    expect(openArtifact?.[1]).toMatchObject({
      body: JSON.stringify({ mode: "REVEAL", source: "GOAL", sourceId: "goal 1" }), method: "POST",
    });
    const deleteAgent = fetchMock.mock.calls.find((call) => typeof call[0] === "string"
      && call[0].endsWith("/api/v1/workbenches/workbench%201/agents/agent%201"));
    expect(deleteAgent?.[1]?.method).toBe("DELETE");
    const scenarioCalls = fetchMock.mock.calls.filter((call) => typeof call[0] === "string" && call[0].endsWith("/api/v1/scenarios/scenario%201/partners"));
    expect(scenarioCalls.length).toBeGreaterThan(0);
    expect(scenarioCalls[0]?.[1]?.body).toBe(JSON.stringify({ roleIds: ["role 1"] }));
    fetchMock.mockRestore();
  });

  it("sends idempotent writes without randomUUID", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response({
      acceptedAt: "2026-09-04T00:00:00.000Z",
      inputId: "input-lan",
      status: "PENDING",
    }, 202));
    const getRandomValues = vi.fn(<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) array.fill(0);
      return array;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    try {
      const api = new DigitalLifeApi("http://192.168.1.20:43130");
      api.setCsrfToken("csrf");
      await expect(api.sendJoiMessage("hi from lan")).resolves.toMatchObject({ inputId: "input-lan" });

      expect(getRandomValues).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("http://192.168.1.20:43130/api/v1/joi/messages");
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        "idempotency-key": "00000000-0000-4000-8000-000000000000",
        "x-csrf-token": "csrf",
      });
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    } finally {
      vi.unstubAllGlobals();
      fetchMock.mockRestore();
    }
  });

  it("normalizes API errors, empty responses, and desktop bootstrap", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementationOnce(() => response(undefined, 204));
    await expect(new DigitalLifeApi("").setup("password")).resolves.toBeUndefined();
    fetchMock.mockImplementationOnce(() => response({ code: "bad", message: "失败" }, 400));
    await expect(new DigitalLifeApi("").request("/bad")).rejects.toEqual(new ApiError("bad", "失败", 400));
    fetchMock.mockImplementationOnce(() => Promise.resolve({ json: () => Promise.reject(new Error("bad")), ok: false, status: 500 } as Response));
    await expect(new DigitalLifeApi("").request("/bad-json")).rejects.toMatchObject({ code: "backend_unavailable" });
    fetchMock.mockImplementationOnce(() => response({}, 400));
    await expect(new DigitalLifeApi("").request("/empty-error")).rejects.toMatchObject({ code: "request_failed", message: "请求没成功。" });

    window.digitalLifeDesktop = {
      createBootstrapNonce: vi.fn(() => Promise.resolve({ expiresAt: "later", nonce: "nonce" })),
      getRuntimeInfo: vi.fn(() => Promise.resolve({ apiOrigin: "http://127.0.0.1:1", platform: "win32", productName: "joi" as const, version: "1" })),
    };
    fetchMock.mockImplementationOnce(() => response({ configured: true })).mockImplementationOnce(() => response({ csrfToken: "desktop-csrf" }));
    await expect(createApi()).resolves.toMatchObject({ configured: true, desktop: true });
    expect(fetchMock.mock.calls.at(-2)?.[0]).toBe(`${window.location.origin}/api/v1/auth/status`);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${window.location.origin}/api/v1/auth/bootstrap`);
    delete window.digitalLifeDesktop;
    fetchMock.mockImplementationOnce(() => response({ configured: true }));
    await expect(createApi()).resolves.toMatchObject({ configured: true, desktop: false });

    vi.stubEnv("DEV", false);
    window.digitalLifeDesktop = {
      createBootstrapNonce: vi.fn(() => Promise.resolve({ expiresAt: "later", nonce: "nonce" })),
      getRuntimeInfo: vi.fn(() => Promise.resolve({ apiOrigin: "http://127.0.0.1:43130", platform: "win32", productName: "joi" as const, version: "1" })),
    };
    fetchMock.mockImplementationOnce(() => response({ configured: true })).mockImplementationOnce(() => response({ csrfToken: "desktop-csrf" }));
    await expect(createApi()).resolves.toMatchObject({ configured: true, desktop: true });
    expect(fetchMock.mock.calls.at(-2)?.[0]).toBe("http://127.0.0.1:43130/api/v1/auth/status");
    delete window.digitalLifeDesktop;
    fetchMock.mockImplementationOnce(() => response({ configured: true }));
    await expect(createApi()).resolves.toMatchObject({ configured: true, desktop: false });
    vi.unstubAllEnvs();
    fetchMock.mockRestore();
  });
});
