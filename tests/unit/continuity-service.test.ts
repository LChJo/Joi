import { ContinuityService } from "../../src/main/application/continuity/continuity-service";
import type { RuntimeStore } from "../../src/main/application/ports/runtime-store";

describe("Continuity Service", () => {
  it("rejects snapshots for a missing Life", async () => {
    const store = { getLife: vi.fn(() => Promise.resolve(null)) } as unknown as RuntimeStore;
    const service = new ContinuityService({ clock: { now: () => new Date("2026-07-15T12:00:00.000Z") }, store });
    await expect(service.snapshot("life_missing")).rejects.toMatchObject({ code: "life_not_found" });
  });

  it("validates collaborator, expression, schedule and rhythm edge cases", async () => {
    const store = {
      bindCollaborator: vi.fn(() => Promise.resolve()),
      getLife: vi.fn(() => Promise.resolve(null)),
      listExpressions: vi.fn(() => Promise.resolve([])),
      listLifeCollaborators: vi.fn(() => Promise.resolve([])),
      unbindCollaborator: vi.fn(() => Promise.resolve(false)),
      updateLifeRhythm: vi.fn(() => Promise.resolve(null)),
      updateSchedule: vi.fn(() => Promise.resolve(null)),
    } as unknown as RuntimeStore;
    const service = new ContinuityService({ clock: { now: () => new Date("2026-07-15T12:00:00.000Z") }, store });
    await expect(service.bindCollaborator("life_1", "agent_1")).resolves.toEqual([]);
    await expect(service.unbindCollaborator("life_1", "agent_1")).rejects.toMatchObject({ code: "collaborator_binding_not_found" });
    await expect(service.expressions("life_1")).rejects.toMatchObject({ code: "life_not_found" });
    await expect(service.updateSchedule("life_1", "missing", { enabled: true, localTime: "08:00" })).rejects.toMatchObject({ code: "schedule_not_found" });
    await expect(service.updateSchedule("life_1", "missing", { enabled: true, localTime: "08:99" })).rejects.toMatchObject({ code: "schedule_time_invalid" });
    await expect(service.updateRhythm("life_1", {
      autonomousWakesDefault: 1, idleExplorationsDefault: 1, invocationsDefault: 1, quietEnd: "07:00", quietStart: "bad",
    })).rejects.toMatchObject({ code: "quiet_hours_invalid" });
    await expect(service.updateRhythm("life_1", {
      autonomousWakesDefault: 1.5, idleExplorationsDefault: 1, invocationsDefault: 1, quietEnd: "07:00", quietStart: "23:00",
    })).rejects.toMatchObject({ code: "budget_defaults_invalid" });
    await expect(service.updateRhythm("life_1", {
      autonomousWakesDefault: 1, idleExplorationsDefault: 1, invocationsDefault: 1, quietEnd: "07:00", quietStart: "23:00",
    })).rejects.toMatchObject({ code: "life_not_found" });
  });
});
