import { isValidElement, memo, useMemo, type ReactNode } from "react";
import renderMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { currentLocale, t, useI18n } from "./i18n";
import { MarkdownRenderCache } from "./markdown-render-cache";

const COMPONENTS: Components = {
  a: ({ href, children }) => href !== undefined && /^https?:\/\//iu.test(href) ? <a href={href} rel="noreferrer" target="_blank">{children}</a> : <span>{children}</span>,
  img: ({ alt }) => <span className="agent-remote-image">{t("home.image")}{alt === undefined ? "" : `：${alt}`}]</span>,
};
const PLUGINS = [remarkGfm];
const POLICY_VERSION = "safe-markdown-v1";
const cache = new MarkdownRenderCache();

// The synchronous react-markdown entry point returns a pure tree without hooks.
function parse(body: string) {
  return renderMarkdown({ components: COMPONENTS, remarkPlugins: PLUGINS, skipHtml: true, children: body });
}

const PREVIEW_BLOCKS = new Set(["blockquote", "br", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "table", "tbody", "td", "th", "thead", "tr", "ul"]);

/** A preview reads the safe tree without mounting the hidden document. */
function previewText(tree: ReactNode): string {
  let text = "", pendingSpace = false, visited = 0;
  function append(value: string): boolean {
    for (const character of value) {
      if (/\s/u.test(character)) { pendingSpace = text.length > 0; continue; }
      if (pendingSpace && text.length < 320) text += " ";
      pendingSpace = false;
      if (text.length + character.length > 320) return false;
      text += character;
    }
    return true;
  }
  function visit(node: ReactNode, depth: number): boolean {
    if (depth > 32 || ++visited > 256) return false;
    if (typeof node === "string") return append(node);
    else if (Array.isArray(node)) { for (const child of node) if (!visit(child as ReactNode, depth)) return false; }
    else if (isValidElement<{ children?: ReactNode; alt?: string }>(node)) {
      if (node.type === COMPONENTS.img) return append(`${t("home.image")}${node.props.alt === undefined || node.props.alt === "" ? "" : `：${node.props.alt}`}]`);
      else {
        const block = typeof node.type === "string" && PREVIEW_BLOCKS.has(node.type);
        if (block) append(" ");
        if (!visit(node.props.children, depth + 1)) return false;
        if (block) append(" ");
      }
    }
    return true;
  }
  const complete = visit(tree, 0);
  return text.trimEnd() + (complete ? "" : "…");
}

export const SafeMarkdown = memo(function SafeMarkdown({ children, preview = false }: { children: string; preview?: boolean }) {
  useI18n();
  const locale = currentLocale();
  return useMemo(() => {
    const node = cache.getOrCreate(children, locale, POLICY_VERSION, parse);
    return preview ? previewText(node) : node;
  }, [children, locale, preview]);
});
