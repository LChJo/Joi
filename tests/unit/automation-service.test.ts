/* The fake async ports intentionally return immediate promises. */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, expect, it, vi } from "vitest";

import { AutomationService } from "../../src/main/application/automation/automation-service";
import type { AutomationRecord, AutomationStore } from "../../src/main/application/ports/automation";
import { DomainError } from "../../src/main/domain/errors";
import { createRoutine } from "../../src/main/domain/automation/routine";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function record(options: { complete?: boolean; optional?: boolean; blocked?: boolean } = {}): AutomationRecord {
  const routine = createRoutine({
    createdAt: NOW.toISOString(),
    ...(options.optional ? { from: "2026-01-01", lastRunAt: "2026-01-01T01:00:00.000Z", pendingTriggerAt: "2026-01-01T02:00:00.000Z", preferredPartnerId: "partner_1", to: "2026-12-31" } : {}),
    frequency: { at: "2026-01-02T00:00:00.000Z", kind: "once" },
    name: "Routine",
    prompt: options.optional ? "Prompt" : "P",
    routineId: "routine_1",
    workbenchId: "workbench_1",
  });
  return {
    ...routine,
    ...(options.optional ? { createIdempotencyKey: "create-key", nextRunAt: "2026-01-02T00:00:00.000Z" } : {}),
    runs: options.complete ? [{
      completedAt: "2026-01-01T03:00:00.000Z", inputId: "input_1", occurrenceAt: "2026-01-01T03:00:00.000Z", queuedAt: "2026-01-01T02:00:00.000Z",
      reasonCode: options.blocked ? "workbench_unavailable" : "reason", result: options.blocked ? "BLOCKED" : "COMPLETED", runId: "run_1", mergeCount: 2,
      status: options.blocked ? "BLOCKED" : "COMPLETED", triggeredAt: "2026-01-01T02:00:00.000Z",
    }] : [],
  };
}

function dependencies(store: Partial<AutomationStore>, options: {
  workspaceStatus?: string | null;
  workbench?: boolean;
  partnerStatus?: string;
} = {}) {
  return {
    clock: { now: () => new Date(NOW) },
    ids: { next: (kind: string) => `${kind}_generated` },
    store: store as AutomationStore,
    workbenches: {
      getWorkbench: vi.fn(async () => options.workbench === false ? null : ({ workbenchId: "workbench_1" } as never)),
      listSummaries: vi.fn(async () => []),
    },
    ...(options.workspaceStatus === null ? { workspaces: { getWorkspace: vi.fn(async () => null) } } : options.workspaceStatus === undefined ? {} : { workspaces: { getWorkspace: vi.fn(async () => ({ status: options.workspaceStatus })) } }),
    ...(options.partnerStatus === undefined ? {} : { partners: { inspect: vi.fn(async () => ({ status: options.partnerStatus } as never)) } }),
  } as ConstructorParameters<typeof AutomationService>[0];
}

function input(overrides: Partial<Parameters<AutomationService["create"]>[0]> = {}) {
  return {
    frequency: { at: "2026-01-02T00:00:00.000Z", kind: "once" as const },
    name: "New routine", prompt: "Do this", workbenchId: "workbench_1", ...overrides,
  };
}

describe("AutomationService", () => {
  it("projects safe list and detail DTOs without prompt text", async () => {
    const full = record({ complete: true, optional: true, blocked: true });
    const minimal = record();
    const store: Partial<AutomationStore> = { get: vi.fn(async () => full), list: vi.fn(async () => [full, minimal]) };
    const service = new AutomationService(dependencies(store));
    const list = await service.list();
    expect(list[0]).toMatchObject({ lifecycle: "BLOCKED", promptConfigured: true, target: { kind: "NEW_GOAL" }, runs: [{ completedAt: "2026-01-01T03:00:00.000Z" }] });
    expect(list[0]).not.toHaveProperty("prompt");
    expect((await service.get(" routine_1 ")).routineId).toBe("routine_1");
    await expect(service.get(" ")).rejects.toMatchObject({ code: "routine_id_invalid" });
    (store.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(service.get("missing")).rejects.toMatchObject({ code: "routine_not_found" });
  });

  it("derives a continuation Workbench from its live goal and rejects unavailable targets", async () => {
    const current = record();
    const inspectGoal = vi.fn(async () => ({ goalId: "goal_1", state: "COMPLETED" as const, workbenchId: "workbench_1" }));
    const store: Partial<AutomationStore> = {
      countActive: vi.fn(async () => 0),
      create: vi.fn(async (value) => value),
      inspectGoal,
    };
    const service = new AutomationService(dependencies(store));
    const created = await service.create({
      frequency: { at: "2026-01-02T00:00:00.000Z", kind: "once" }, name: "Continue", prompt: "继续检查",
      target: { goalId: "goal_1", kind: "GOAL_CONTINUATION" },
    } as never);
    expect(created).toMatchObject({ target: { goalId: "goal_1", kind: "GOAL_CONTINUATION" }, workbenchId: "workbench_1" });
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ target: { goalId: "goal_1", kind: "GOAL_CONTINUATION" }, workbenchId: "workbench_1" }));
    inspectGoal.mockResolvedValueOnce(null as never);
    await expect(service.create({ frequency: current.frequency, name: "Missing", prompt: "继续", target: { goalId: "missing", kind: "GOAL_CONTINUATION" } } as never)).rejects.toMatchObject({ code: "routine_goal_invalid" });
  });

  it("validates create idempotency, Workbench readiness, partner preference and the limit", async () => {
    const existing = record({ optional: true });
    const replayStore: Partial<AutomationStore> = { countActive: vi.fn(async () => 0), getByCreateIdempotencyKey: vi.fn(async () => existing) };
    const replay = new AutomationService(dependencies(replayStore));
    expect((await replay.create(input(), " create-key ")).routineId).toBe(existing.routineId);
    await expect(replay.create(input(), " ")).rejects.toMatchObject({ code: "idempotency_key_invalid" });
    await expect(replay.create(input(), "x".repeat(241))).rejects.toMatchObject({ code: "idempotency_key_invalid" });

    const limitStore: Partial<AutomationStore> = { countActive: vi.fn(async () => 30) };
    await expect(new AutomationService(dependencies(limitStore)).create(input())).rejects.toMatchObject({ code: "routine_limit_reached" });
    const invalidWorkbench = new AutomationService(dependencies({ countActive: vi.fn(async () => 0) }, { workbench: false }));
    await expect(invalidWorkbench.create(input())).rejects.toMatchObject({ code: "routine_workbench_invalid" });
    const provisioning = new AutomationService(dependencies({ countActive: vi.fn(async () => 0) }, { workspaceStatus: "PROVISIONING" }));
    await expect(provisioning.create(input())).rejects.toMatchObject({ code: "routine_workbench_unavailable" });
    const missingWorkspace = new AutomationService(dependencies({ countActive: vi.fn(async () => 0) }, { workspaceStatus: null }));
    await expect(missingWorkspace.create(input())).rejects.toMatchObject({ code: "routine_workbench_unavailable" });
  });

  it("creates a routine, including optional fields, and checks partner state", async () => {
    const store: Partial<AutomationStore> = { countActive: vi.fn(async () => 0), create: vi.fn(async (value) => ({ ...value, routineId: value.routineId, runs: [] })) };
    const service = new AutomationService(dependencies(store, { workspaceStatus: "READY", partnerStatus: "ACTIVE" }));
    const result = await service.create(input({ from: "2026-01-01", preferredPartnerId: "partner_1", to: "2026-12-31" }), "key");
    expect(result).toMatchObject({ name: "New routine", promptConfigured: true });
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ createIdempotencyKey: "key", from: "2026-01-01", preferredPartnerId: "partner_1", to: "2026-12-31" }));
    const noPartnerService = new AutomationService(dependencies({ countActive: vi.fn(async () => 0) }));
    await expect(noPartnerService.create(input({ preferredPartnerId: "partner_1" }))).rejects.toMatchObject({ code: "routine_partner_invalid" });
    const inactive = new AutomationService(dependencies({ countActive: vi.fn(async () => 0) }, { partnerStatus: "DISABLED" }));
    await expect(inactive.create(input({ preferredPartnerId: "partner_1" }))).rejects.toMatchObject({ code: "routine_partner_invalid" });
  });

  it("updates, toggles and deletes with safe mutation behavior", async () => {
    const current = record({ optional: true });
    const store: Partial<AutomationStore> = {
      get: vi.fn(async () => current),
      update: vi.fn(async () => current),
      softDelete: vi.fn(async () => current),
    };
    const service = new AutomationService(dependencies(store, { workspaceStatus: "READY", partnerStatus: "ACTIVE" }));
    const updated = await service.update("routine_1", {
      enabled: false, from: null, frequency: { kind: "interval", hours: 1 }, name: "Changed", preferredPartnerId: null,
      prompt: "New prompt", to: null, workbenchId: "workbench_1",
    }, "update-key");
    expect(updated.routineId).toBe("routine_1");
    expect(store.update).toHaveBeenCalledWith("routine_1", expect.objectContaining({ enabled: false, from: null, preferredPartnerId: null, to: null }), "update-key");
    await service.setEnabled("routine_1", true);
    await service.delete("routine_1", "delete-key");
    expect(store.softDelete).toHaveBeenCalledWith("routine_1", expect.any(String), "delete-key");
    (store.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(service.update("routine_1", {})).rejects.toMatchObject({ code: "routine_not_found" });
    (store.softDelete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(service.delete("routine_1")).rejects.toMatchObject({ code: "routine_not_found" });
    await expect(service.update("routine_1", {}, " ")).rejects.toMatchObject({ code: "idempotency_key_invalid" });
  });

  it("protects prompt reveal and immediate execution behind validation", async () => {
    const current = record({ optional: true });
    const store: Partial<AutomationStore> = {
      get: vi.fn(async () => current),
      revealPrompt: vi.fn(async () => ({ prompt: "secret" })),
      runNow: vi.fn(async () => ({ inputId: "input", routineId: "routine_1", runId: "run" })),
    };
    const service = new AutomationService(dependencies(store));
    expect(await service.revealPrompt("routine_1")).toEqual({ prompt: "secret" });
    expect(await service.promptForExecution("routine_1")).toEqual({ prompt: "Prompt" });
    await expect(service.runNow("routine_1", " ")).rejects.toMatchObject({ code: "idempotency_key_invalid" });
    await expect(service.runNow("routine_1", "x".repeat(241))).rejects.toMatchObject({ code: "idempotency_key_invalid" });
    await expect(service.runNow("routine_1", "key")).resolves.toMatchObject({ routineId: "routine_1" });
    (store.revealPrompt as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(service.revealPrompt("routine_1")).rejects.toMatchObject({ code: "routine_not_found" });
    (store.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(service.promptForExecution("routine_1")).resolves.toBeNull();
    (store.runNow as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(service.runNow("routine_1", "key-2")).rejects.toMatchObject({ code: "routine_not_found" });
    await expect(service.runNow(" ", "key")).rejects.toBeInstanceOf(DomainError);
  });
});
