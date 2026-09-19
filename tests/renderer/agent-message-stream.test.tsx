// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AgentMessageStream } from "../../src/renderer/JoiHome.js";
import { DigitalLifeApi } from "../../src/renderer/api.js";
import type { AgentConversationEntryDto, WorkbenchAgentCardDto } from "../../src/shared/joi.js";

const agent: WorkbenchAgentCardDto = {
  agentId: "a", workbenchId: "w", canDelete: false, createdAt: "2026-09-18T10:00:00Z", engine: "pi-core",
  lastActivityAt: "2026-09-18T10:00:00Z", partnerId: "p", partnerName: "搭档", sessionPolicy: "EPHEMERAL", status: "RUNNING", transport: "LOCAL",
};
const entry = (sequence: number): AgentConversationEntryDto => ({ entryId: `e${String(sequence)}`, sequence, createdAt: `2026-09-18T10:${String(sequence).padStart(2, "0")}:00Z`, kind: "MARKDOWN", role: "AGENT", text: `输出 ${String(sequence)}` });

describe("AC-60 latest conversation viewport", () => {
  afterEach(() => vi.useRealTimers());
  it("follows latest output, auto-loads history without stopping polling, and preserves a reader's position", async () => {
    vi.useFakeTimers();
    const api = new DigitalLifeApi("", true);
    const read = vi.spyOn(api, "agentConversation")
      .mockResolvedValueOnce({ agent, items: [entry(2), entry(3)], nextCursor: "older" })
      .mockResolvedValueOnce({ agent, items: [entry(3), entry(4)], nextCursor: "between" })
      .mockResolvedValueOnce({ agent, items: [entry(0), entry(1)] })
      .mockResolvedValue({ agent, items: [entry(4), entry(5)], nextCursor: "between" });
    render(<AgentMessageStream agent={agent} api={api} workbenchId="w" live />);
    const log = screen.getByRole("log", { name: "Agent 执行记录" });
    const reveal = vi.fn();
    log.scrollIntoView = reveal;
    Object.defineProperties(log, { clientHeight: { value: 200 }, scrollHeight: { get: () => 600 + log.querySelectorAll("article").length * 200 } });
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(read).toHaveBeenCalledWith("w", "a", { limit: 50, latest: true });
    expect(log.scrollTop).toBe(1000);
    expect(reveal).toHaveBeenCalledExactlyOnceWith({ block: "end", inline: "nearest" });
    await act(() => vi.advanceTimersByTimeAsync(750));
    expect(screen.getByText("输出 4")).toBeInTheDocument();
    expect(log.scrollTop).toBe(1200);
    log.scrollTop = 0;
    fireEvent.scroll(log);
    await act(async () => { await Promise.resolve(); });
    expect(read).toHaveBeenCalledWith("w", "a", { limit: 50, latest: true, cursor: "older" });
    expect(log.scrollTop).toBe(400);
    expect(screen.getByText("输出 0")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(750));
    expect(screen.getByText("输出 5")).toBeInTheDocument();
    expect(log.scrollTop).toBe(400);
    expect(screen.queryByRole("button", { name: "加载更早记录" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
    expect(log.scrollTop).toBe(1800);
    expect(reveal).toHaveBeenCalledTimes(2);
    expect([...log.querySelectorAll("article time")].map(time => time.getAttribute("datetime"))).toEqual(Array.from({ length: 6 }, (_, i) => entry(i).createdAt));
  });

  it("bridges missed live pages and fetches the final page when the run stops", async () => {
    vi.useFakeTimers();
    const api = new DigitalLifeApi("", true);
    const read = vi.spyOn(api, "agentConversation")
      .mockResolvedValueOnce({ agent, items: [entry(0), entry(1)] })
      .mockResolvedValueOnce({ agent, items: [entry(4), entry(5)], nextCursor: "gap" })
      .mockResolvedValueOnce({ agent, items: [entry(1), entry(2), entry(3)], nextCursor: "old" })
      .mockResolvedValue({ agent, items: [entry(5), entry(6)] });
    const view = render(<AgentMessageStream agent={agent} api={api} workbenchId="w" live />);
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(() => vi.advanceTimersByTimeAsync(750));
    expect(read).toHaveBeenCalledTimes(3);
    expect(screen.getAllByText(/^输出 /)).toHaveLength(6);
    view.rerender(<AgentMessageStream agent={{ ...agent, status: "COMPLETED" }} api={api} workbenchId="w" live={false} />);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText("输出 6")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("fills a short viewport automatically and stops polling on a terminal response", async () => {
    vi.useFakeTimers();
    const api = new DigitalLifeApi("", true);
    const read = vi.spyOn(api, "agentConversation")
      .mockResolvedValueOnce({ agent, items: [entry(2)], nextCursor: "older" })
      .mockResolvedValueOnce({ agent, items: [entry(0), entry(1)] })
      .mockResolvedValue({ agent: { ...agent, status: "COMPLETED" }, items: [entry(2), entry(3)] });
    render(<AgentMessageStream agent={agent} api={api} workbenchId="w" live />);
    const log = screen.getByRole("log", { name: "Agent 执行记录" });
    Object.defineProperties(log, { clientHeight: { value: 600 }, scrollHeight: { get: () => log.querySelectorAll("article").length * 250 } });
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText("输出 0")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(750));
    expect(screen.getByText("输出 3")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("retains history after a paging error and retries on the next upward scroll", async () => {
    vi.useFakeTimers();
    const api = new DigitalLifeApi("", true);
    const read = vi.spyOn(api, "agentConversation")
      .mockResolvedValueOnce({ agent, items: [entry(2)], nextCursor: "older" })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ agent, items: [entry(0), entry(1)] });
    render(<AgentMessageStream agent={agent} api={api} workbenchId="w" />);
    const log = screen.getByRole("log", { name: "Agent 执行记录" });
    Object.defineProperties(log, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } });
    await act(() => vi.advanceTimersByTimeAsync(1));
    log.scrollTop = 0;
    fireEvent.scroll(log);
    fireEvent.scroll(log);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("alert")).toHaveTextContent("没能读取更早记录");
    expect(read).toHaveBeenCalledTimes(2);
    fireEvent.scroll(log);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("输出 0")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
