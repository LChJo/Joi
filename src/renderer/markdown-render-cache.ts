import type { ReactElement } from "react";

interface MarkdownCacheLimits {
  maxEntries: number;
  maxCharacters: number;
  maxDocumentCharacters: number;
}

interface Entry {
  node: ReactElement;
  characters: number;
}

/** Rendered trees are immutable and shared only within the renderer process. */
export class MarkdownRenderCache {
  readonly #entries = new Map<string, Entry>();
  #characters = 0;

  constructor(private readonly limits: MarkdownCacheLimits = {
    maxEntries: 32,
    maxCharacters: 512 * 1024,
    maxDocumentCharacters: 64 * 1024,
  }) {}

  getOrCreate(body: string, locale: string, policyVersion: string, render: (body: string) => ReactElement): ReactElement {
    if (body.length > this.limits.maxDocumentCharacters || body.length > this.limits.maxCharacters || this.limits.maxEntries < 1) return render(body);
    const key = JSON.stringify([locale, policyVersion, body]);
    const cached = this.#entries.get(key);
    if (cached !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, cached);
      return cached.node;
    }
    const node = render(body);
    while (this.#entries.size >= this.limits.maxEntries || this.#characters + body.length > this.limits.maxCharacters) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      const entry = this.#entries.get(oldest.value);
      if (entry !== undefined) this.#characters -= entry.characters;
      this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, { node, characters: body.length });
    this.#characters += body.length;
    return node;
  }
}
