// @vitest-environment jsdom
import { ApiError, DigitalLifeApi } from "../../src/renderer/api.js";

type FetchCall = [input: string | URL | Request, init?: RequestInit];

function jsonResponse(payload: unknown, status = 200) {
  return { json: () => Promise.resolve(payload), ok: status >= 200 && status < 300, status };
}

function sentBody(calls: FetchCall[], index: number): Record<string, unknown> {
  const init = calls[index]?.[1];
  return JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
}

function sentUrl(calls: FetchCall[], index: number): string {
  const input = calls[index]?.[0];
  return typeof input === "string" ? input : "";
}

describe("partner api client", () => {
  it("sends the new partner config fields and engine-aware knowledge routes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = new DigitalLifeApi("http://127.0.0.1:43130");
    api.setCsrfToken("csrf-test");

    const created = { createdBy: "user", displayName: "Coder", engine: "pi-core", partnerId: "partner-1" };
    fetchMock.mockResolvedValueOnce(jsonResponse(created, 201));
    await api.createPartner({ capabilities: [], description: "工程搭档", displayName: "Coder", kind: "local-pi", skills: [], tools: [] });
    const calls = fetchMock.mock.calls as FetchCall[];
    expect(calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(sentBody(calls, 0)).toMatchObject({ description: "工程搭档", kind: "local-pi" });

    fetchMock.mockResolvedValueOnce(jsonResponse(created));
    await api.updatePartner("partner-1", { capabilities: [], displayName: "Coder", modelIdOverride: null, modelSourceId: null, prompt: "补充规则", promptMode: "APPEND", skills: [], tools: [] });
    expect(sentUrl(calls, 1)).toContain("/api/v1/partners/partner-1");
    expect(sentBody(calls, 1)).toMatchObject({ modelIdOverride: null, modelSourceId: null, prompt: "补充规则", promptMode: "APPEND" });

    fetchMock.mockResolvedValueOnce(jsonResponse(created));
    await api.setPartnerEnabled("partner-1", false);
    expect(sentBody(calls, 2)).toEqual({ disabled: true });

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...created, partnerId: "partner-2" }, 201));
    await api.duplicatePartner("partner-1");
    expect(sentUrl(calls, 3)).toContain("/duplicate");

    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    await api.listKnowledgeDocs("partner-1");
    expect(sentUrl(calls, 4)).toContain("/knowledge");

    fetchMock.mockResolvedValueOnce(jsonResponse({ docId: "doc-1", filename: "guide.md" }, 201));
    await api.uploadKnowledgeDoc("partner-1", new File(["# 规范"], "guide.md"));
    const uploadedBody = sentBody(calls, 5) as { contentBase64: string; filename: string };
    expect(uploadedBody.filename).toBe("guide.md");
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(uploadedBody.contentBase64), (char) => char.charCodeAt(0)));
    expect(decoded).toBe("# 规范");

    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 });
    expect(await api.deleteKnowledgeDoc("partner-1", "doc-1")).toBeUndefined();
    expect(calls[6]?.[1]).toMatchObject({ method: "DELETE" });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      modelId: "gpt-5.6-sol-sub", partnerId: "partner-1", sourceDisplayName: "gpt-sub", sourceId: "source-ready",
      status: "READY", testedAt: "2026-08-25T08:00:00.000Z",
    }));
    await api.testPartnerModel("partner-1");
    expect(sentUrl(calls, 7)).toContain("/api/v1/partners/partner-1/test-model");
    expect(calls[7]?.[1]).toMatchObject({ method: "POST" });

    fetchMock.mockResolvedValueOnce(jsonResponse({ prompt: "当前提示词" }));
    expect(await api.revealPartnerPrompt("partner-1")).toEqual({ prompt: "当前提示词" });
    expect(sentUrl(calls, 8)).toContain("/api/v1/partners/partner-1/prompt/reveal");
    expect(calls[8]?.[1]).toMatchObject({ method: "POST" });

    vi.unstubAllGlobals();
  });

  it("surfaces server error codes and falls back when the body is not json", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = new DigitalLifeApi("");

    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "partner_kb_too_many", message: "太多了。" }, 400));
    await expect(api.listKnowledgeDocs("partner-1")).rejects.toMatchObject({ code: "partner_kb_too_many", status: 400 });

    fetchMock.mockResolvedValueOnce({ json: () => Promise.reject(new Error("not json")), ok: false, status: 500 });
    await expect(api.duplicatePartner("partner-1")).rejects.toBeInstanceOf(ApiError);

    vi.unstubAllGlobals();
  });
});
