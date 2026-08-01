/* eslint-disable @typescript-eslint/require-await */
import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import type { JoiInboxRecord, JoiInboxRepository } from "../../src/main/application/ports/joi-inbox.js";

class FakeInboxRepository implements JoiInboxRepository {
  readonly records = new Map<string, JoiInboxRecord>();

  async clarify(inputId: string, patch: { avatarId?: string; text?: string }): Promise<JoiInboxRecord | null> {
    const record = this.records.get(inputId);
    if (record === undefined) return null;
    if (record.status !== "CLARIFICATION_REQUIRED") return null;
    const next: JoiInboxRecord = {
      body: patch.text === undefined ? record.body : `${record.body}\n\n[用户补充] ${patch.text}`,
      createdAt: record.createdAt,
      idempotencyKey: record.idempotencyKey,
      inputId: record.inputId,
      status: "PENDING",
      updatedAt: "2026-08-01T00:00:01.000Z",
      ...(patch.avatarId === undefined ? {} : { avatarId: patch.avatarId }),
    };
    this.records.set(inputId, next);
    return next;
  }

  async create(record: JoiInboxRecord): Promise<JoiInboxRecord> {
    this.records.set(record.inputId, record);
    return record;
  }

  async list(): Promise<JoiInboxRecord[]> {
    return [...this.records.values()];
  }
}

function record(over: Partial<JoiInboxRecord> & { inputId: string }): JoiInboxRecord {
  return {
    body: "body",
    createdAt: "2026-08-01T00:00:00.000Z",
    idempotencyKey: `key-${over.inputId}`,
    status: "CLARIFICATION_REQUIRED",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function serviceWith(repository: JoiInboxRepository) {
  return new JoiInboxService({
    clock: { now: () => new Date("2026-08-01T00:00:00.000Z") },
    ids: { next: (prefix: string) => `${prefix}-1` },
    repository,
  });
}

describe("JoiInboxService.clarify", () => {
  it("rejects empty, oversized and missing-input clarifications", async () => {
    const repository = new FakeInboxRepository();
    const service = serviceWith(repository);
    await expect(service.clarify({ inputId: "input-1" })).rejects.toMatchObject({ code: "joi_clarification_empty" });
    await expect(service.clarify({ inputId: "input-1", text: "x".repeat(8_001) })).rejects.toMatchObject({ code: "joi_clarification_invalid" });
    await expect(service.clarify({ avatarId: "a".repeat(161), inputId: "input-1" })).rejects.toMatchObject({ code: "joi_avatar_invalid" });
    await expect(service.clarify({ avatarId: "av-1", inputId: "missing" })).rejects.toMatchObject({ code: "joi_clarification_unavailable" });
    repository.records.set("pending-1", record({ inputId: "pending-1", status: "PENDING" }));
    await expect(service.clarify({ avatarId: "av-1", inputId: "pending-1" })).rejects.toMatchObject({ code: "joi_clarification_unavailable" });
  });

  it("assigns an Avatar and clears the clarification reason on success", async () => {
    const repository = new FakeInboxRepository();
    repository.records.set("clarify-1", record({ body: "这条归谁", clarificationReasonCode: "avatar_selection_invalid", inputId: "clarify-1" }));
    const dto = await serviceWith(repository).clarify({ avatarId: "av-1", inputId: "clarify-1" });
    expect(dto).toMatchObject({ avatarId: "av-1", inputId: "clarify-1", status: "PENDING", textPreview: "这条归谁" });
    expect(dto.clarificationReasonCode).toBeUndefined();
  });

  it("appends supplementary text into the stored body", async () => {
    const repository = new FakeInboxRepository();
    repository.records.set("clarify-2", record({ body: "归属？", inputId: "clarify-2" }));
    const dto = await serviceWith(repository).clarify({ inputId: "clarify-2", text: "是登录模块" });
    expect(dto.textPreview).toBe("归属？ [用户补充] 是登录模块");
  });

  it("omits a preview for synthetic inputs and whitespace-only bodies", async () => {
    const repository = new FakeInboxRepository();
    repository.records.set("joi_result_input:1", record({ body: "synthetic partner result", inputId: "joi_result_input:1", status: "CONSUMED" }));
    repository.records.set("blank-1", record({ body: "   ", inputId: "blank-1", status: "CONSUMED" }));
    const listed = await serviceWith(repository).list();
    expect(listed.find((item) => item.inputId === "joi_result_input:1")?.textPreview).toBeUndefined();
    expect(listed.find((item) => item.inputId === "blank-1")?.textPreview).toBeUndefined();
  });
});
