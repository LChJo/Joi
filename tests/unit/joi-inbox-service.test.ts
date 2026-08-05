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

  async cancel(inputId: string): Promise<JoiInboxRecord | null> {
    const record = this.records.get(inputId);
    if (record === undefined) return null;
    if (record.status !== "PENDING" && record.status !== "CLARIFICATION_REQUIRED") return null;
    const next: JoiInboxRecord = {
      body: record.body,
      canceledAt: "2026-08-01T00:00:02.000Z",
      createdAt: record.createdAt,
      idempotencyKey: record.idempotencyKey,
      inputId: record.inputId,
      status: "CONSUMED",
      updatedAt: "2026-08-01T00:00:02.000Z",
      ...(record.avatarId === undefined ? {} : { avatarId: record.avatarId }),
    };
    this.records.set(inputId, next);
    return next;
  }

  async dismiss(inputId: string): Promise<JoiInboxRecord | null> {
    const record = this.records.get(inputId);
    if (record === undefined) return null;
    if (record.status !== "CONSUMED" || record.dismissedAt !== undefined) return null;
    const next: JoiInboxRecord = { ...record, dismissedAt: "2026-08-01T00:00:03.000Z", updatedAt: "2026-08-01T00:00:03.000Z" };
    this.records.set(inputId, next);
    return next;
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

function serviceWith(repository: JoiInboxRepository, diagnostics: { event: string; fields: Record<string, unknown> }[] = []) {
  return new JoiInboxService({
    clock: { now: () => new Date("2026-08-01T00:00:00.000Z") },
    diagnostics: { emit: (event, fields) => { diagnostics.push({ event, fields }); } },
    ids: { next: (prefix: string) => `${prefix}-1` },
    repository,
  });
}

describe("JoiInboxService.accept", () => {
  it("logs only persisted input identity and safe counts", async () => {
    const repository = new FakeInboxRepository();
    const diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
    await serviceWith(repository, diagnostics).accept({
      attachmentIds: ["attachment-1"],
      avatarId: "avatar-1",
      idempotencyKey: "request-1",
      text: "PRIVATE STOCK REQUEST",
    });

    expect(diagnostics).toEqual([{
      event: "joi.input.accepted",
      fields: { attachmentCount: 1, avatarBound: true, inputId: "input-1" },
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE STOCK REQUEST");
    expect(JSON.stringify(diagnostics)).not.toContain("request-1");
  });
});

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

describe("JoiInboxService.cancel", () => {
  it("rejects blank and oversized ids and inputs that are not cancelable", async () => {
    const repository = new FakeInboxRepository();
    const service = serviceWith(repository);
    await expect(service.cancel({ inputId: "   " })).rejects.toMatchObject({ code: "joi_input_invalid" });
    await expect(service.cancel({ inputId: "x".repeat(161) })).rejects.toMatchObject({ code: "joi_input_invalid" });
    await expect(service.cancel({ inputId: "missing" })).rejects.toMatchObject({ code: "joi_cancel_unavailable" });
    repository.records.set("done-1", record({ inputId: "done-1", status: "CONSUMED" }));
    await expect(service.cancel({ inputId: "done-1" })).rejects.toMatchObject({ code: "joi_cancel_unavailable" });
  });

  it("cancels a clarification input and drops the reason code", async () => {
    const repository = new FakeInboxRepository();
    repository.records.set("cancel-1", record({ clarificationReasonCode: "avatar_selection_invalid", inputId: "cancel-1" }));
    const dto = await serviceWith(repository).cancel({ inputId: "cancel-1" });
    expect(dto).toMatchObject({ canceled: true, inputId: "cancel-1", status: "CONSUMED" });
    expect(dto.clarificationReasonCode).toBeUndefined();
  });

  it("cancels a pending input before routing", async () => {
    const repository = new FakeInboxRepository();
    repository.records.set("pending-1", record({ inputId: "pending-1", status: "PENDING" }));
    const dto = await serviceWith(repository).cancel({ inputId: "pending-1" });
    expect(dto).toMatchObject({ canceled: true, status: "CONSUMED" });
  });
});

describe("JoiInboxService.dismiss", () => {
  it("rejects blank and oversized ids and inputs that are not terminal", async () => {
    const repository = new FakeInboxRepository();
    const service = serviceWith(repository);
    await expect(service.dismiss({ inputId: "   " })).rejects.toMatchObject({ code: "joi_input_invalid" });
    await expect(service.dismiss({ inputId: "x".repeat(161) })).rejects.toMatchObject({ code: "joi_input_invalid" });
    await expect(service.dismiss({ inputId: "missing" })).rejects.toMatchObject({ code: "joi_dismiss_unavailable" });
    repository.records.set("pending-1", record({ inputId: "pending-1", status: "PENDING" }));
    await expect(service.dismiss({ inputId: "pending-1" })).rejects.toMatchObject({ code: "joi_dismiss_unavailable" });
  });

  it("dismisses a canceled input once and keeps the cancel marker in the dto", async () => {
    const repository = new FakeInboxRepository();
    repository.records.set("done-1", record({ canceledAt: "2026-08-01T00:00:02.000Z", inputId: "done-1", status: "CONSUMED" }));
    const service = serviceWith(repository);
    const dto = await service.dismiss({ inputId: "done-1" });
    expect(dto).toMatchObject({ canceled: true, inputId: "done-1", status: "CONSUMED" });
    await expect(service.dismiss({ inputId: "done-1" })).rejects.toMatchObject({ code: "joi_dismiss_unavailable" });
  });
});
