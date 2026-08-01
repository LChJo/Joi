import { DomainError } from "../../domain/errors.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type { PartnerKnowledgeDocMeta, PartnerKnowledgeStore } from "../ports/partner-knowledge.js";

export const PARTNER_KB_LIMITS = {
  injectionDocChars: 6_000,
  injectionTotalChars: 16_000,
  maxDocBytes: 256 * 1024,
  maxDocsPerPartner: 8,
  maxTotalBytes: 1024 * 1024,
} as const;

export class PartnerKnowledgeService {
  constructor(private readonly dependencies: { clock: Clock; ids: IdGenerator; store: PartnerKnowledgeStore }) {}

  async add(input: { body: string; filename: string; partnerId: string }): Promise<PartnerKnowledgeDocMeta> {
    const filename = input.filename.trim();
    if (filename.length === 0 || filename.length > 240) throw new DomainError("partner_kb_filename_invalid", "Knowledge document filename is invalid.");
    const body = input.body;
    const bytes = new TextEncoder().encode(body).length;
    if (bytes === 0) throw new DomainError("partner_kb_doc_empty", "Knowledge document must not be empty.");
    if (bytes > PARTNER_KB_LIMITS.maxDocBytes) throw new DomainError("partner_kb_doc_too_large", "Knowledge document exceeds the 256 KiB limit.");
    const existing = await this.dependencies.store.listMeta(input.partnerId);
    if (existing.length >= PARTNER_KB_LIMITS.maxDocsPerPartner) throw new DomainError("partner_kb_too_many", "A partner keeps at most eight knowledge documents.");
    if (existing.some((doc) => doc.filename === filename)) throw new DomainError("partner_kb_filename_taken", "A knowledge document with this filename already exists.");
    const totalBytes = existing.reduce((sum, doc) => sum + doc.bytes, 0) + bytes;
    if (totalBytes > PARTNER_KB_LIMITS.maxTotalBytes) throw new DomainError("partner_kb_total_too_large", "Partner knowledge base exceeds the 1 MiB limit.");
    const docId = this.dependencies.ids.next("partner_knowledge_doc");
    const createdAt = this.dependencies.clock.now().toISOString();
    const sha256 = await this.dependencies.store.save({ body, bytes, createdAt, docId, filename, partnerId: input.partnerId });
    return { bytes, createdAt, docId, filename, sha256 };
  }

  async list(partnerId: string): Promise<PartnerKnowledgeDocMeta[]> {
    return this.dependencies.store.listMeta(partnerId);
  }

  async count(partnerId: string): Promise<number> {
    return this.dependencies.store.count(partnerId);
  }

  async remove(partnerId: string, docId: string): Promise<boolean> {
    return this.dependencies.store.remove(partnerId, docId);
  }

  async duplicateTo(srcPartnerId: string, dstPartnerId: string): Promise<number> {
    return this.dependencies.store.copyTo(
      srcPartnerId,
      dstPartnerId,
      () => this.dependencies.ids.next("partner_knowledge_doc"),
      this.dependencies.clock.now().toISOString(),
    );
  }

  /**
   * Renders the partner knowledge base as a system-prompt section, truncated by a
   * deterministic FIFO budget. Only local engines inject this; A2A has no channel.
   */
  async readForInjection(partnerId: string): Promise<string> {
    const docs = await this.dependencies.store.readBodies(partnerId);
    if (docs.length === 0) return "";
    const sections: string[] = [];
    let used = 0;
    let truncated = false;
    for (const doc of docs) {
      let body = doc.body;
      if (body.length > PARTNER_KB_LIMITS.injectionDocChars) {
        body = body.slice(0, PARTNER_KB_LIMITS.injectionDocChars);
        truncated = true;
      }
      if (used + body.length > PARTNER_KB_LIMITS.injectionTotalChars) {
        const remaining = PARTNER_KB_LIMITS.injectionTotalChars - used;
        if (remaining > 200) sections.push(`[knowledge: ${doc.filename}]\n${body.slice(0, remaining)}`);
        truncated = true;
        break;
      }
      sections.push(`[knowledge: ${doc.filename}]\n${body}`);
      used += body.length;
    }
    if (truncated) sections.push("[joi: knowledge truncated]");
    return `Attached knowledge base (${String(docs.length)} document(s)):\n${sections.join("\n\n")}`;
  }
}
