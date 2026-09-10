/* In-memory repository implements asynchronous persistence immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { WorkbenchChangeService } from "../../src/main/application/joi/workbench-change-service.js";
import type { WorkbenchChangeRepository, WorkbenchChangeRequest } from "../../src/main/application/ports/workbench-change.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

class MemoryWorkbenchChanges implements WorkbenchChangeRepository {
  readonly active = new Set(["source", "target"]);
  readonly requests = new Map<string, WorkbenchChangeRequest>();

  async archiveConfirmed(request: WorkbenchChangeRequest) {
    const existing = await this.get(request.requestId);
    if (existing !== null) return existing;
    await this.create(request);
    return this.decide(request.requestId, "CONFIRM", request.createdAt);
  }
  async create(request: WorkbenchChangeRequest) { this.requests.set(request.requestId, structuredClone(request)); }
  async decide(requestId: string, decision: "CONFIRM" | "REJECT", decidedAt: string) {
    const existing = this.requests.get(requestId);
    if (existing === undefined) throw new Error("missing fixture request");
    const decided: WorkbenchChangeRequest = { ...existing, decidedAt, status: decision === "CONFIRM" ? "CONFIRMED" : "REJECTED" };
    this.requests.set(requestId, decided);
    return decided;
  }
  async get(requestId: string) { return this.requests.get(requestId) ?? null; }
  async isActive(workbenchId: string) { return this.active.has(workbenchId); }
  async listPending() { return [...this.requests.values()].filter((request) => request.status === "PENDING"); }
}

function fixture() {
  const repository = new MemoryWorkbenchChanges();
  return { repository, service: new WorkbenchChangeService({ clock: new TestClock(), ids: new TestIds(), repository }) };
}

describe("Workbench change suggestions", () => {
  it("archives a workbench through a confirmed stable request", async () => {
    const { service, repository } = fixture();
    const confirmed = await service.archive("source");
    expect(confirmed).toMatchObject({ kind: "ARCHIVE", sourceWorkbenchId: "source", status: "CONFIRMED" });
    expect(await service.archive("source")).toEqual(confirmed);
    expect(repository.requests.size).toBe(1);
    await expect(service.archive(" ")).rejects.toMatchObject({ code: "workbench_change_source_required" });
  });

  it("validates identifiers, reasons, active records and merge targets before persisting", async () => {
    const { repository, service } = fixture();

    await expect(service.suggestArchive({ workbenchId: " ", reason: "cleanup", turnId: "turn" })).rejects.toMatchObject({ code: "workbench_change_source_required" });
    await expect(service.suggestArchive({ workbenchId: "missing", reason: "cleanup", turnId: "turn" })).rejects.toMatchObject({ code: "workbench_change_source_not_active" });
    await expect(service.suggestArchive({ workbenchId: "source", reason: " ", turnId: "turn" })).rejects.toMatchObject({ code: "workbench_change_reason_required" });
    await expect(service.suggestArchive({ workbenchId: "source", reason: "cleanup", turnId: " " })).rejects.toMatchObject({ code: "workbench_change_turn_required" });
    await expect(service.suggestMerge({ reason: "merge", sourceWorkbenchId: "source", targetWorkbenchId: "source", turnId: "turn" })).rejects.toMatchObject({ code: "workbench_change_same_target" });
    await expect(service.suggestMerge({ reason: "merge", sourceWorkbenchId: "source", targetWorkbenchId: "missing", turnId: "turn" })).rejects.toMatchObject({ code: "workbench_change_target_not_active" });

    expect(repository.requests.size).toBe(0);
  });

  it("makes repeated decisions idempotent but rejects a conflicting decision", async () => {
    const { service } = fixture();
    const request = await service.suggestArchive({ workbenchId: " source ", reason: " cleanup ", turnId: " turn " });
    const confirmed = await service.decide({ decision: "CONFIRM", requestId: request.requestId });

    expect(await service.decide({ decision: "CONFIRM", requestId: request.requestId })).toEqual(confirmed);
    await expect(service.decide({ decision: "REJECT", requestId: request.requestId })).rejects.toMatchObject({ code: "workbench_change_already_decided" });
    await expect(service.decide({ decision: "CONFIRM", requestId: "missing" })).rejects.toMatchObject({ code: "workbench_change_not_found" });
    await expect(service.decide({ decision: "CONFIRM", requestId: " " })).rejects.toMatchObject({ code: "workbench_change_request_required" });
    expect(await service.listPending()).toEqual([]);
  });

  it("treats repeated rejection as idempotent and refuses the opposite confirmation", async () => {
    const { service } = fixture();
    const request = await service.suggestArchive({ workbenchId: "source", reason: "cleanup", turnId: "turn" });
    const rejected = await service.decide({ decision: "REJECT", requestId: request.requestId });

    expect(await service.decide({ decision: "REJECT", requestId: request.requestId })).toEqual(rejected);
    await expect(service.decide({ decision: "CONFIRM", requestId: request.requestId })).rejects.toMatchObject({ code: "workbench_change_already_decided" });
  });
});
