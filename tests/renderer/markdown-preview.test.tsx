// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { SafeMarkdown } from "../../src/renderer/SafeMarkdown";
import { configureLocale, t } from "../../src/renderer/i18n";

describe("bounded safe Markdown previews", () => {
  it("keeps readable boundaries without creating nested links or tables", () => {
    const body = "# Heading\n\nA **bold** [link](https://example.test).\n\n| First | Second |\n| --- | --- |\n| one | two |\n\n> Quoted\n\n- First item\n- Second item\n\n```ts\nconst safe = true;\n```";
    const { container } = render(<SafeMarkdown preview>{body}</SafeMarkdown>);
    expect(container.textContent).toBe("Heading A bold link. First Second one two Quoted First item Second item const safe = true;");
    expect(container.childElementCount).toBe(0);
  });
  it("preserves safe image labels and rejects HTML and executable links", () => {
    const body = '<script>unsafe()</script>\n\n[bad](javascript:alert)\n\n![preview-alt](https://example.test/remote.png)\n\n**safe**';
    const { container } = render(<SafeMarkdown preview>{body}</SafeMarkdown>);
    expect(container.querySelector("script, img, a")).toBeNull();
    expect(container.textContent).not.toContain("unsafe()");
    expect(container.textContent).toContain("preview-alt");
    expect(container.textContent).toContain("safe");
    const before = container.textContent;
    act(() => configureLocale({ preference: "en", systemLanguages: ["en"] }));
    expect(container.textContent).not.toBe(before);
  });
  it("bounds a long unbroken Unicode paragraph and updates to a changed body", () => {
    const { container, rerender } = render(<SafeMarkdown preview>{"😀".repeat(1000)}</SafeMarkdown>);
    expect(container.textContent.length).toBeLessThanOrEqual(321);
    expect(container.textContent).toMatch(/^(?:😀)+…$/u);
    rerender(<SafeMarkdown preview>{"new short body"}</SafeMarkdown>);
    expect(container.textContent).toBe("new short body");
  });
  it("handles empty, image-only and line-break content", () => {
    const { container, rerender } = render(<SafeMarkdown preview>{""}</SafeMarkdown>);
    expect(container.textContent).toBe("");
    rerender(<SafeMarkdown preview>{"line one  \nline two"}</SafeMarkdown>);
    expect(container.textContent).toBe("line one line two");
    rerender(<SafeMarkdown preview>{"![](https://example.test/image.png)"}</SafeMarkdown>);
    expect(container.textContent).toContain(t("home.image"));
  });
  it("bounds traversal for empty structures and deeply nested blocks", () => {
    const { container, rerender } = render(<SafeMarkdown preview>{"\n\n---\n\n".repeat(300)}</SafeMarkdown>);
    expect(container.textContent).toBe("…");
    expect(container.childElementCount).toBe(0);
    rerender(<SafeMarkdown preview>{"> ".repeat(40) + "deep content"}</SafeMarkdown>);
    expect(container.textContent).toBe("…");
  });
});
