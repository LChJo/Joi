/* eslint-disable @typescript-eslint/require-await */
import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import type { JoiInboxRecord, JoiInboxRepository } from "../../src/main/application/ports/joi-inbox.js";

class FakeInboxRepository implements JoiInboxRepository {
  readonly records = new Map<string, JoiInboxRecord>();
  cancelQueued?: () => Promise<number>;

  async clarify(inputId: string, patch: { workbenchId?: string; text?: string }): Promise<JoiInboxRecord | null> {
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
      ...(patch.workbenchId === undefined ? {} : { workbenchId: patch.workbenchId }),
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
      ...(record.workbenchId === undefined ? {} : { workbenchId: record.workbenchId }),
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

  async park(inputId: string, failure: { failureCount: number; reasonCode: string }): Promise<JoiInboxRecord | null> {
    const record = this.records.get(inputId);
    if (record?.status !== "PENDING") return null;
    const next: JoiInboxRecord = {
      ...record,
      failedAt: "2026-08-01T00:00:04.000Z",
      failureCount: failure.failureCount,
      failureReasonCode: failure.reasonCode,
      status: "CONSUMED",
      updatedAt: "2026-08-01T00:00:04.000Z",
    };
    this.records.set(inputId, next);
    return next;
  }

  async retry(inputId: string, patch: { text?: string }): Promise<JoiInboxRecord | null> {
    const record = this.records.get(inputId);
    if (record?.status !== "CONSUMED" || record.dismissedAt !== undefined) return null;
    const next: JoiInboxRecord = {
      body: patch.text === undefined ? record.body : `${record.body}\n\n[用户补充] ${patch.text}`,
      createdAt: record.createdAt,
      idempotencyKey: record.idempotencyKey,
      inputId: record.inputId,
      status: "PENDING",
      updatedAt: "2026-08-01T00:00:05.000Z",
      ...(record.workbenchId === undefined ? {} : { workbenchId: record.workbenchId }),
    };
    this.records.set(inputId, next);
    return next;
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
      workbenchId: "workbench-1",
      idempotencyKey: "request-1",
      text: "PRIVATE STOCK REQUEST",
    });

    expect(diagnostics).toEqual([{
      event: "joi.input.accepted",
      fields: { attachmentCount: 1, workbenchBound: true, inputId: "input-1" },
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE STOCK REQUEST");
    expect(JSON.stringify(diagnostics)).not.toContain("request-1");
  });

  it("rejects duplicate attachment references", async () => {
    const service = serviceWith(new FakeInboxRepository());

    await expect(service.accept({
      attachmentIds: ["attachment-1", "attachment-1"],
      idempotencyKey: "request-duplicate-attachments",
      text: "review",
    })).rejects.toMatchObject({ code: "joi_attachments_invalid" });
  });
});

describe("JoiInboxService.clarify", () => {
  it("rejects empty, oversized and missing-input clarifications", async () => {
    const repository = new FakeInboxRepository();
    const service = serviceWith(repository);
    await expect(service.clarify({ inputId: "input-1" })).rejects.toMatchObject({ code: "joi_clarification_empty" });
    await expect(service.clarify({ inputId: "input-1", text: "x".repeat(8_001) })).rejects.toMatchObject({ code: "joi_clarification_invalid" });
    await expect(service.clarify({ workbenchId: "a".repeat(161), inputId: "input-1" })).rejects.toMatchObject({ code: "joi_workbench_invalid" });
    await expect(service.clarify({ workbenchId: "workbench-1", inputId: "missing" })).rejects.toMatchObject({ code: "joi_clarification_unavailable" });
    repository.records.set("pending-1", record({ inputId: "pending-1", status: "PENDING" }));
    await expect(service.clarify({ workbenchId: "workbench-1", inputId: "pending-1" })).rejects.toMatchObject({ code: "joi_clarification_unavailable" });
  });

  it("assigns a workbench and clears the clarification reason on success", async () => {
    const repository = new FakeInboxRepository();
    repository.records.set("clarify-1", record({ body: "这条归谁", clarificationReasonCode: "workbench_selection_invalid", inputId: "clarify-1" }));
    const dto = await serviceWith(repository).clarify({ workbenchId: "workbench-1", inputId: "clarify-1" });
    expect(dto).toMatchObject({ workbenchId: "workbench-1", inputId: "clarify-1", status: "PENDING", textPreview: "这条归谁" });
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
    repository.records.set("failed-1", record({
      failedAt: "2026-08-01T00:00:04.000Z",
      failureCount: 8,
      failureExecutionStarted: true,
      failureReasonCode: "model_unavailable",
      inputId: "failed-1",
      status: "CONSUMED",
    }));
    const listed = await serviceWith(repository).list();
    expect(listed.find((item) => item.inputId === "joi_result_input:1")?.textPreview).toBeUndefined();
    expect(listed.find((item) => item.inputId === "blank-1")?.textPreview).toBeUndefined();
    expect(listed.find((item) => item.inputId === "failed-1")?.failure).toEqual({
      attempts: 8,
      executionStarted: true,
      reasonCode: "model_unavailable",
      suggestedAction: "CHECK_MODEL_SOURCE",
    });
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
    repository.records.set("cancel-1", record({ clarificationReasonCode: "workbench_selection_invalid", inputId: "cancel-1" }));
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

describe("JoiInboxService.emergencyStopQueued", () => {
  it("delegates to the repository when available and remains compatible with older repositories", async () => {
    const legacy = new FakeInboxRepository();
    await expect(serviceWith(legacy).emergencyStopQueued()).resolves.toBe(0);
    const repository = new FakeInboxRepository();
    repository.cancelQueued = async () => 3;
    await expect(serviceWith(repository).emergencyStopQueued()).resolves.toBe(3);
  });
});

describe("JoiInboxService.retry", () => {
  it("rejects blank and oversized ids and oversized supplementary text", async () => {
    const service = serviceWith(new FakeInboxRepository());
    await expect(service.retry({ inputId: "   " })).rejects.toMatchObject({ code: "joi_input_invalid" });
    await expect(service.retry({ inputId: "x".repeat(161) })).rejects.toMatchObject({ code: "joi_input_invalid" });
    await expect(service.retry({ inputId: "input-1", text: "x".repeat(8_001) })).rejects.toMatchObject({ code: "joi_retry_invalid" });
  });

  it("rejects inputs the repository cannot revive", async () => {
    const repository = new FakeInboxRepository();
    const service = serviceWith(repository);
    await expect(service.retry({ inputId: "missing" })).rejects.toMatchObject({ code: "joi_retry_unavailable" });
    repository.records.set("pending-1", record({ inputId: "pending-1", status: "PENDING" }));
    await expect(service.retry({ inputId: "pending-1" })).rejects.toMatchObject({ code: "joi_retry_unavailable" });
  });

  it("re-queues a parked goal without requiring supplementary text", async () => {
    const repository = new FakeInboxRepository();
    repository.records.set("failed-1", record({
      failedAt: "2026-08-01T00:00:04.000Z", failureCount: 8, failureReasonCode: "model_unavailable",
      inputId: "failed-1", status: "CONSUMED", workbenchId: "workbench-1",
    }));
    const diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
    const dto = await serviceWith(repository, diagnostics).retry({ inputId: "failed-1" });
    expect(dto).toMatchObject({ inputId: "failed-1", status: "PENDING", workbenchId: "workbench-1" });
    expect(dto.failure).toBeUndefined();
    expect(diagnostics).toEqual([{ event: "joi.input.retried", fields: { inputId: "failed-1", supplemented: false } }]);
  });

  it("appends supplementary text into the stored body before re-queueing", async () => {
    const repository = new FakeInboxRepository();
    repository.records.set("failed-2", record({ body: "分析沙堡项目", failedAt: "2026-08-01T00:00:04.000Z", failureCount: 8, failureReasonCode: "work_dispatch_failed", inputId: "failed-2", status: "CONSUMED" }));
    const dto = await serviceWith(repository).retry({ inputId: "failed-2", text: "已修复搭档技能配置" });
    expect(dto.textPreview).toBe("分析沙堡项目 [用户补充] 已修复搭档技能配置");
    expect(dto.status).toBe("PENDING");
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
