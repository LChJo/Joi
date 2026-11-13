// @vitest-environment jsdom
import { DigitalLifeApi } from "../../src/renderer/api";

it("CHAT-45 uses credentialed conversation events and closes on disconnect or cleanup",() => {
  const sources: Source[] = [];
  class Source extends EventTarget {
    readonly close = vi.fn();
    constructor(readonly url: string,readonly options: EventSourceInit) { super();sources.push(this); }
  }
  vi.stubGlobal("EventSource",Source);
  try {
    const api = new DigitalLifeApi("http://127.0.0.1:43130"),receive = vi.fn(),failed = vi.fn();
    const dispose = api.watchConversation("chat one",receive,failed),source = sources[0];
    if (source === undefined || dispose === undefined) throw new Error("Missing subscription");
    expect(source.url).toBe("http://127.0.0.1:43130/api/v1/conversations/chat%20one/stream");expect(source.options).toEqual({ withCredentials: true });
    const update = { conversationId: "chat one",turn: { turnId: "turn",status: "RUNNING",entries: [] } };
    source.dispatchEvent(new MessageEvent("conversation",{ data: JSON.stringify(update) }));expect(receive).toHaveBeenCalledWith(update);
    source.dispatchEvent(new Event("error"));expect(failed).toHaveBeenCalledTimes(1);expect(source.close).toHaveBeenCalledTimes(1);
    source.dispatchEvent(new MessageEvent("conversation",{ data: JSON.stringify(update) }));expect(receive).toHaveBeenCalledTimes(1);
    dispose();expect(source.close).toHaveBeenCalledTimes(1);
    const second = api.watchConversation("next",receive,failed);second?.();expect(sources[1]?.close).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});

it("CHAT-45 falls back when EventSource is unavailable or its payload is malformed",() => {
  const api = new DigitalLifeApi("http://127.0.0.1:43130"),receive = vi.fn(),failed = vi.fn();
  vi.stubGlobal("EventSource",undefined);
  try { expect(api.watchConversation("chat",receive,failed)).toBeUndefined(); }
  finally { vi.unstubAllGlobals(); }
  const sources: EventTarget[] = [];
  class Source extends EventTarget {
    close() { /* The fake transport owns no external resources. */ }
    constructor() { super();sources.push(this); }
  }
  vi.stubGlobal("EventSource",Source);
  try {
    api.watchConversation("chat",receive,failed);
    sources[0]?.dispatchEvent(new MessageEvent("conversation",{ data: "{" }));
    expect(failed).toHaveBeenCalledTimes(1);expect(receive).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
