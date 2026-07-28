/* In-memory repository implements asynchronous persistence immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { AvatarChangeService } from "../../src/main/application/joi/avatar-change-service.js";
import type { AvatarChangeRepository, AvatarChangeRequest } from "../../src/main/application/ports/avatar-change.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

class MemoryAvatarChanges implements AvatarChangeRepository {
  readonly active = new Set(["source", "target"]);
  readonly requests = new Map<string, AvatarChangeRequest>();

  async create(request: AvatarChangeRequest) { this.requests.set(request.requestId, structuredClone(request)); }
  async decide(requestId: string, decision: "CONFIRM" | "REJECT", decidedAt: string) {
    const existing = this.requests.get(requestId);
    if (existing === undefined) throw new Error("missing fixture request");
    const decided: AvatarChangeRequest = { ...existing, decidedAt, status: decision === "CONFIRM" ? "CONFIRMED" : "REJECTED" };
    this.requests.set(requestId, decided);
    return decided;
  }
  async get(requestId: string) { return this.requests.get(requestId) ?? null; }
  async isActive(avatarId: string) { return this.active.has(avatarId); }
  async listPending() { return [...this.requests.values()].filter((request) => request.status === "PENDING"); }
}

function fixture() {
  const repository = new MemoryAvatarChanges();
  return { repository, service: new AvatarChangeService({ clock: new TestClock(), ids: new TestIds(), repository }) };
}

describe("Avatar change suggestions", () => {
  it("validates identifiers, reasons, active records and merge targets before persisting", async () => {
    const { repository, service } = fixture();

    await expect(service.suggestArchive({ avatarId: " ", reason: "cleanup", turnId: "turn" })).rejects.toMatchObject({ code: "avatar_change_source_required" });
    await expect(service.suggestArchive({ avatarId: "missing", reason: "cleanup", turnId: "turn" })).rejects.toMatchObject({ code: "avatar_change_source_not_active" });
    await expect(service.suggestArchive({ avatarId: "source", reason: " ", turnId: "turn" })).rejects.toMatchObject({ code: "avatar_change_reason_required" });
    await expect(service.suggestArchive({ avatarId: "source", reason: "cleanup", turnId: " " })).rejects.toMatchObject({ code: "avatar_change_turn_required" });
    await expect(service.suggestMerge({ reason: "merge", sourceAvatarId: "source", targetAvatarId: "source", turnId: "turn" })).rejects.toMatchObject({ code: "avatar_change_same_target" });
    await expect(service.suggestMerge({ reason: "merge", sourceAvatarId: "source", targetAvatarId: "missing", turnId: "turn" })).rejects.toMatchObject({ code: "avatar_change_target_not_active" });

    expect(repository.requests.size).toBe(0);
  });

  it("makes repeated decisions idempotent but rejects a conflicting decision", async () => {
    const { service } = fixture();
    const request = await service.suggestArchive({ avatarId: " source ", reason: " cleanup ", turnId: " turn " });
    const confirmed = await service.decide({ decision: "CONFIRM", requestId: request.requestId });

    expect(await service.decide({ decision: "CONFIRM", requestId: request.requestId })).toEqual(confirmed);
    await expect(service.decide({ decision: "REJECT", requestId: request.requestId })).rejects.toMatchObject({ code: "avatar_change_already_decided" });
    await expect(service.decide({ decision: "CONFIRM", requestId: "missing" })).rejects.toMatchObject({ code: "avatar_change_not_found" });
    await expect(service.decide({ decision: "CONFIRM", requestId: " " })).rejects.toMatchObject({ code: "avatar_change_request_required" });
    expect(await service.listPending()).toEqual([]);
  });

  it("treats repeated rejection as idempotent and refuses the opposite confirmation", async () => {
    const { service } = fixture();
    const request = await service.suggestArchive({ avatarId: "source", reason: "cleanup", turnId: "turn" });
    const rejected = await service.decide({ decision: "REJECT", requestId: request.requestId });

    expect(await service.decide({ decision: "REJECT", requestId: request.requestId })).toEqual(rejected);
    await expect(service.decide({ decision: "CONFIRM", requestId: request.requestId })).rejects.toMatchObject({ code: "avatar_change_already_decided" });
  });
});
