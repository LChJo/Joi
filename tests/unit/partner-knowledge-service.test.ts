/* In-memory store keeps the service tests free of SQLite. */
/* eslint-disable @typescript-eslint/require-await */
import { createHash } from "node:crypto";

import { PARTNER_KB_LIMITS, PartnerKnowledgeService } from "../../src/main/application/partners/partner-knowledge-service.js";
import type { PartnerKnowledgeDocMeta, PartnerKnowledgeStore } from "../../src/main/application/ports/partner-knowledge.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

class MemoryKnowledgeStore implements PartnerKnowledgeStore {
  readonly docs: { body: string; bytes: number; createdAt: string; docId: string; filename: string; partnerId: string; sha256: string }[] = [];
  async count(partnerId: string) { return this.docs.filter((doc) => doc.partnerId === partnerId).length; }
  async copyTo(srcPartnerId: string, dstPartnerId: string, nextDocId: () => string, createdAt: string) {
    const rows = this.docs.filter((doc) => doc.partnerId === srcPartnerId);
    for (const row of rows) this.docs.push({ ...row, createdAt, docId: nextDocId(), partnerId: dstPartnerId });
    return rows.length;
  }
  async listMeta(partnerId: string): Promise<PartnerKnowledgeDocMeta[]> {
    return this.docs.filter((doc) => doc.partnerId === partnerId)
      .map((doc) => ({ bytes: doc.bytes, createdAt: doc.createdAt, docId: doc.docId, filename: doc.filename, sha256: doc.sha256 }));
  }
  async readBodies(partnerId: string) {
    return this.docs.filter((doc) => doc.partnerId === partnerId).map((doc) => ({ body: doc.body, filename: doc.filename }));
  }
  async remove(partnerId: string, docId: string) {
    const index = this.docs.findIndex((doc) => doc.docId === docId && doc.partnerId === partnerId);
    if (index === -1) return false;
    this.docs.splice(index, 1);
    return true;
  }
  async save(input: { body: string; bytes: number; createdAt: string; docId: string; filename: string; partnerId: string }) {
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    this.docs.push({ ...input, sha256 });
    return sha256;
  }
}

function makeService() {
  const store = new MemoryKnowledgeStore();
  return { service: new PartnerKnowledgeService({ clock: new TestClock(), ids: new TestIds(), store }), store };
}

describe("partner-knowledge-service", () => {
  it("stores documents with a stable sha256 and metadata", async () => {
    const { service } = makeService();
    const meta = await service.add({ body: "# 规范\n先读后写。", filename: "guide.md", partnerId: "partner_1" });
    expect(meta.filename).toBe("guide.md");
    expect(meta.bytes).toBe(new TextEncoder().encode("# 规范\n先读后写。").length);
    expect(meta.sha256).toBe(createHash("sha256").update("# 规范\n先读后写。").digest("hex"));
    expect(meta.docId).toMatch(/^partner_knowledge_doc_/u);
    expect(await service.count("partner_1")).toBe(1);
    expect(await service.count("partner_2")).toBe(0);
  });

  it("rejects empty, oversized, duplicate and overflowing uploads", async () => {
    const { service } = makeService();
    await expect(service.add({ body: "", filename: "empty.md", partnerId: "partner_1" })).rejects.toMatchObject({ code: "partner_kb_doc_empty" });
    await expect(service.add({ body: "x".repeat(PARTNER_KB_LIMITS.maxDocBytes + 1), filename: "big.md", partnerId: "partner_1" }))
      .rejects.toMatchObject({ code: "partner_kb_doc_too_large" });
    await expect(service.add({ body: "  ", filename: "   ", partnerId: "partner_1" })).rejects.toMatchObject({ code: "partner_kb_filename_invalid" });
    await service.add({ body: "first", filename: "a.md", partnerId: "partner_1" });
    await expect(service.add({ body: "second", filename: "a.md", partnerId: "partner_1" })).rejects.toMatchObject({ code: "partner_kb_filename_taken" });

    const { service: capped } = makeService();
    const small = "x".repeat(1_000);
    for (let index = 0; index < PARTNER_KB_LIMITS.maxDocsPerPartner; index += 1) {
      await capped.add({ body: small, filename: `doc-${String(index)}.md`, partnerId: "partner_full" });
    }
    await expect(capped.add({ body: "ninth", filename: "doc-9.md", partnerId: "partner_full" })).rejects.toMatchObject({ code: "partner_kb_too_many" });

    const { service: total } = makeService();
    const chunk = "x".repeat(250 * 1024);
    for (let index = 0; index < 4; index += 1) {
      await total.add({ body: chunk, filename: `chunk-${String(index)}.md`, partnerId: "partner_total" });
    }
    await expect(total.add({ body: chunk, filename: "chunk-4.md", partnerId: "partner_total" }))
      .rejects.toMatchObject({ code: "partner_kb_total_too_large" });
  });

  it("removes documents only within the owning partner", async () => {
    const { service } = makeService();
    const meta = await service.add({ body: "content", filename: "note.md", partnerId: "partner_1" });
    expect(await service.remove("partner_2", meta.docId)).toBe(false);
    expect(await service.remove("partner_1", meta.docId)).toBe(true);
    expect(await service.list("partner_1")).toEqual([]);
  });

  it("injects knowledge as a FIFO budgeted prompt section with a truncation marker", async () => {
    const { service } = makeService();
    expect(await service.readForInjection("partner_1")).toBe("");
    const big = "x".repeat(PARTNER_KB_LIMITS.injectionDocChars + 2_000);
    await service.add({ body: big, filename: "one.md", partnerId: "partner_1" });
    await service.add({ body: big, filename: "two.md", partnerId: "partner_1" });
    const section = await service.readForInjection("partner_1");
    expect(section).toContain("Attached knowledge base (2 document(s))");
    expect(section).toContain("[knowledge: one.md]");
    expect(section).toContain("[joi: knowledge truncated]");
    expect(section.length).toBeLessThan(PARTNER_KB_LIMITS.injectionTotalChars + 400);
    expect(section.indexOf("one.md")).toBeLessThan(section.indexOf("[joi: knowledge truncated]"));
  });

  it("omits the truncation marker when the budget is not exceeded", async () => {
    const { service } = makeService();
    await service.add({ body: "small one", filename: "one.md", partnerId: "partner_2" });
    await service.add({ body: "small two", filename: "two.md", partnerId: "partner_2" });
    const section = await service.readForInjection("partner_2");
    expect(section).toContain("[knowledge: one.md]");
    expect(section).toContain("[knowledge: two.md]");
    expect(section).not.toContain("[joi: knowledge truncated]");
  });

  it("skips documents whose remaining budget is too small to be useful", async () => {
    const { service } = makeService();
    const chunk = "y".repeat(5_333);
    for (const name of ["one.md", "two.md", "three.md", "four.md"]) {
      await service.add({ body: chunk, filename: name, partnerId: "partner_3" });
    }
    const section = await service.readForInjection("partner_3");
    expect(section).toContain("[knowledge: three.md]");
    expect(section).not.toContain("[knowledge: four.md]");
    expect(section).toContain("[joi: knowledge truncated]");
  });
});
