// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { MarkdownRenderCache } from "../../src/renderer/markdown-render-cache";
import { SafeMarkdown } from "../../src/renderer/SafeMarkdown";
import { configureLocale } from "../../src/renderer/i18n";

describe("bounded Markdown render cache", () => {
  const create = vi.fn((body: string) => <p>{body}</p>);
  beforeEach(() => create.mockClear());
  it("shares only identical body, locale and policy combinations", () => {
    const cache = new MarkdownRenderCache();
    const first = cache.getOrCreate("body", "zh-CN", "safe-v1", create);
    expect(cache.getOrCreate("body", "zh-CN", "safe-v1", create)).toBe(first);
    expect(cache.getOrCreate("body changed", "zh-CN", "safe-v1", create)).not.toBe(first);
    expect(cache.getOrCreate("body", "en", "safe-v1", create)).not.toBe(first);
    expect(cache.getOrCreate("body", "zh-CN", "safe-v2", create)).not.toBe(first);
    expect(create).toHaveBeenCalledTimes(4);
  });
  it("refreshes LRU order and bounds entry count", () => {
    const cache = new MarkdownRenderCache({ maxEntries: 2, maxCharacters: 100, maxDocumentCharacters: 20 });
    const get = (body: string) => cache.getOrCreate(body, "en", "v1", create);
    const a = get("a"), b = get("b");
    expect(get("a")).toBe(a);
    get("c");
    expect(get("a")).toBe(a);
    expect(get("b")).not.toBe(b);
    expect(create).toHaveBeenCalledTimes(4);
  });
  it("bounds retained characters and renders oversized documents without evicting useful entries", () => {
    const cache = new MarkdownRenderCache({ maxEntries: 32, maxCharacters: 10, maxDocumentCharacters: 8 });
    const get = (body: string) => cache.getOrCreate(body, "en", "v1", create);
    const a = get("aaaa"), b = get("bbbb");
    const oversized = get("oversized body");
    expect(get("oversized body")).not.toBe(oversized);
    expect(get("aaaa")).toBe(a);
    get("ccc");
    expect(get("bbbb")).not.toBe(b);
    expect(create).toHaveBeenCalledTimes(6);
  });
  it("enforces default document and total bounds", () => {
    const cache = new MarkdownRenderCache();
    const get = (body: string) => cache.getOrCreate(body, "en", "v1", create);
    const long = "x".repeat(64 * 1024 + 1);
    expect(get(long)).not.toBe(get(long));
    const bodies = Array.from({ length: 9 }, (_, i) => `${String(i)}${"x".repeat(64 * 1024 - 1)}`);
    const first = get(bodies[0] ?? "");
    for (const body of bodies.slice(1)) get(body);
    expect(get(bodies[0] ?? "")).not.toBe(first);
  });
  it("enforces the default 32 entry limit", () => {
    const cache = new MarkdownRenderCache();
    const get = (body: string) => cache.getOrCreate(body, "en", "v1", create);
    const first = get("entry-0");
    for (let i = 1; i <= 32; i += 1) get(`entry-${String(i)}`);
    expect(get("entry-0")).not.toBe(first);
  });
  it("does not retain a failed render", () => {
    const cache = new MarkdownRenderCache();
    expect(() => cache.getOrCreate("retry", "en", "v1", () => { throw new Error("fixture"); })).toThrow("fixture");
    expect(cache.getOrCreate("retry", "en", "v1", create)).toEqual(<p>retry</p>);
  });
});

describe("shared safe Markdown rendering", () => {
  it("preserves GFM and rejects HTML, active links and remote images in every instance", () => {
    const body = "# safe fixture\n\n| A | B |\n| --- | --- |\n| a | b |\n\n<script>unsafe()</script>\n\n[bad](javascript:alert) [local](file:///private) [good](https://example.test)\n\n![fixture](https://example.test/image.png)";
    const { container } = render(<><article><SafeMarkdown>{body}</SafeMarkdown></article><article><SafeMarkdown>{body}</SafeMarkdown></article></>);
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(container.querySelector("script, img")).toBeNull();
    for (const link of screen.getAllByRole("link")) expect(link).toHaveAttribute("href", "https://example.test");
  });
  it("refreshes image labels after a locale switch and renders changed bodies", () => {
    const { container, rerender } = render(<SafeMarkdown>{"![locale-fixture](https://example.test/img)"}</SafeMarkdown>);
    const before = container.textContent;
    act(() => configureLocale({ preference: "en", systemLanguages: ["en"] }));
    expect(container.textContent).not.toBe(before);
    rerender(<SafeMarkdown>{"## new result body"}</SafeMarkdown>);
    expect(screen.getByRole("heading", { name: "new result body" })).toBeInTheDocument();
    expect(container.textContent).not.toContain("locale-fixture");
  });
});
