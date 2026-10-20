import { ModelSourceRecovery, MODEL_SOURCE_RECOVERY_KIND } from "../../src/main/application/model-sources/model-source-recovery.js";
import { JoiTaskComponent } from "../../src/main/application/actors/components/joi-task-component.js";
import { OutboxDispatcher } from "../../src/main/application/operations/outbox-dispatcher.js";
import type { ModelSourceRecord, ModelSourceValidator } from "../../src/main/application/ports/model-source-ports.js";
import { createModelSource } from "../../src/main/domain/model-sources/model-source.js";
import { SqliteModelSourceRepository } from "../../src/main/infrastructure/persistence/sqlite-model-source-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

function seedCredential(fixture: Awaited<ReturnType<typeof createRuntimeFixture>>, id = "source-recovery") {
  fixture.database.transaction(db => db.prepare(`INSERT INTO model_source_credentials
    (provider_id, credential_type, encrypted_blob, credential_version, updated_at) VALUES (?, 'api_key', ?, 1, ?)`)
    .run(`fake:${id}`, new Uint8Array([1, 2, 3]), fixture.clock.now().toISOString()));
}

function degraded(now: Date, id = "source-recovery"): ModelSourceRecord {
  const at = now.toISOString();
  return { local: false, order: 0, primary: true, reasonCode: "server_error", lastValidatedAt: at,
    source: { ...createModelSource({ createdAt: at, credentialRef: `fake:${id}`, credentialVersion: 1,
      displayName: "Synthetic source", kind: "deepseek", modelCapability: "release-tested", modelId: "fake-model",
      modelRevisionId: `${id}-model`, sourceId: id, sourceRevisionId: `${id}-revision` }), status: "DEGRADED" } };
}

describe("AC-10/48/55/65 automatic model source recovery", () => {
  it("recovers an all-degraded pool through durable, deduplicated background delivery and resumes queued inputs", async () => {
    const fixture = await createRuntimeFixture();
    const repository = new SqliteModelSourceRepository(fixture.database);
    const validator = { validate: vi.fn(() => Promise.resolve({ status: "READY" as const, validatedAt: fixture.clock.now().toISOString() })) };
    const recovery = new ModelSourceRecovery({ repository, queue: repository, clock: fixture.clock, validator });
    const handle = vi.fn(() => Promise.resolve());
    const task = new JoiTaskComponent({ gate: { hasReadySource: async () => (await repository.list()).some(r => r.source.status === "READY") },
      driver: { handle }, inbox: { listPendingInputs: () => Promise.resolve([{ createdAt: fixture.clock.now().toISOString(), inputId: "queued-goal" }]),
        listStaleRunningTurns: () => Promise.resolve([]), isCanceled: () => Promise.resolve(false),
        failTurn: () => Promise.resolve(), park: () => Promise.resolve() } });
    const restarted = new ModelSourceRecovery({ repository, queue: repository, clock: fixture.clock, validator });
    const dispatcher = new OutboxDispatcher({ clock: fixture.clock, owner: "recovery", store: fixture.database.store,
      includeKinds: [MODEL_SOURCE_RECOVERY_KIND], handlers: { [MODEL_SOURCE_RECOVERY_KIND]: r => restarted.handle(r) } });
    try {
      seedCredential(fixture); await repository.create(degraded(fixture.clock.now()));
      const tick = () => task.update({ clock: fixture.clock, now: fixture.clock.now(), tickId: 1 });
      await tick(); expect(handle).not.toHaveBeenCalled();
      fixture.clock.advance(60_000); await recovery.enqueueDue();
      fixture.clock.advance(10_000); await recovery.enqueueDue();
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind=?").get(MODEL_SOURCE_RECOVERY_KIND)?.n)).toBe(1);
      expect(validator.validate).not.toHaveBeenCalled();
      expect(dispatcher.startOnce()).toBe(true); await dispatcher.drain();
      expect((await repository.get("source-recovery"))?.source.status).toBe("READY");
      await tick(); expect(handle).toHaveBeenCalledOnce();
      expect(validator.validate).toHaveBeenCalledOnce();
    } finally { recovery.stop(); restarted.stop(); await dispatcher.close(); await fixture.close(); }
  });

  it("spaces persistent temporary failures by a minute and never probes configuration, auth or disabled sources", async () => {
    const fixture = await createRuntimeFixture(); const repository = new SqliteModelSourceRepository(fixture.database);
    const validator = { validate: vi.fn(() => Promise.resolve({ status: "DEGRADED" as const, reasonCode: "server_error", validatedAt: fixture.clock.now().toISOString() })) };
    const recovery = new ModelSourceRecovery({ repository, queue: repository, clock: fixture.clock, validator });
    const dispatcher = new OutboxDispatcher({ clock: fixture.clock, owner: "recovery", store: fixture.database.store,
      includeKinds: [MODEL_SOURCE_RECOVERY_KIND], handlers: { [MODEL_SOURCE_RECOVERY_KIND]: r => recovery.handle(r) } });
    try {
      seedCredential(fixture); await repository.create(degraded(fixture.clock.now()));
      for (const [id, status, reasonCode] of [["auth", "NEEDS_AUTH", "auth_failed"], ["config", "DEGRADED", "bad_request"], ["off", "DISABLED", "server_error"]] as const) {
        seedCredential(fixture, id);
        const record = degraded(fixture.clock.now(), id); await repository.create({ ...record, reasonCode, order: ["auth", "config", "off"].indexOf(id) + 1, primary: false, source: { ...record.source, status } });
      }
      fixture.clock.advance(59_999); await recovery.enqueueDue(); expect(await dispatcher.dispatchOnce()).toBe(0);
      fixture.clock.advance(10_001); await recovery.enqueueDue(); await dispatcher.dispatchOnce(); expect(validator.validate).toHaveBeenCalledOnce();
      fixture.clock.advance(50_000); await recovery.enqueueDue(); expect(await dispatcher.dispatchOnce()).toBe(0);
      fixture.clock.advance(10_000); await recovery.enqueueDue(); await dispatcher.dispatchOnce(); expect(validator.validate).toHaveBeenCalledTimes(2);
      expect((await repository.get("source-recovery"))?.reasonCode).toBe("server_error");
    } finally { recovery.stop(); await dispatcher.close(); await fixture.close(); }
  });

  it.each(["DISABLED", "DRAFT"] as const)("does not overwrite a concurrent %s decision with a delayed successful probe", async status => {
    const fixture = await createRuntimeFixture(); const repository = new SqliteModelSourceRepository(fixture.database);
    let resolve!: (result: Awaited<ReturnType<ModelSourceValidator["validate"]>>) => void;
    const validator = { validate: vi.fn(() => new Promise<Awaited<ReturnType<ModelSourceValidator["validate"]>>>(done => { resolve = done; })) };
    const recovery = new ModelSourceRecovery({ repository, queue: repository, clock: fixture.clock, validator });
    const dispatcher = new OutboxDispatcher({ clock: fixture.clock, owner: "recovery", store: fixture.database.store,
      includeKinds: [MODEL_SOURCE_RECOVERY_KIND], handlers: { [MODEL_SOURCE_RECOVERY_KIND]: r => recovery.handle(r) } });
    try {
      seedCredential(fixture); const record = degraded(fixture.clock.now()); await repository.create(record); fixture.clock.advance(60_000); await recovery.enqueueDue();
      dispatcher.startOnce(); await vi.waitFor(() => expect(validator.validate).toHaveBeenCalledOnce());
      await repository.save({ ...record, source: { ...record.source, status, updatedAt: fixture.clock.now().toISOString() } });
      resolve({ status: "READY", validatedAt: fixture.clock.now().toISOString() }); await dispatcher.drain();
      expect((await repository.get(record.source.sourceId))?.source.status).toBe(status);
    } finally { recovery.stop(); await dispatcher.close(); await fixture.close(); }
  });

  it("does not block traversal while probing and preserves health and queued delivery on emergency stop", async () => {
    const fixture = await createRuntimeFixture(); const repository = new SqliteModelSourceRepository(fixture.database);
    const validate = vi.fn<ModelSourceValidator["validate"]>((_record, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("probe_aborted")), { once: true });
    }));
    const validator = { validate };
    const recovery = new ModelSourceRecovery({ repository, queue: repository, clock: fixture.clock, validator });
    const dispatcher = new OutboxDispatcher({ clock: fixture.clock, owner: "recovery", store: fixture.database.store,
      includeKinds: [MODEL_SOURCE_RECOVERY_KIND], handlers: { [MODEL_SOURCE_RECOVERY_KIND]: r => recovery.handle(r) } });
    try {
      seedCredential(fixture); const original = degraded(fixture.clock.now()); await repository.create(original);
      fixture.clock.advance(60_000); await recovery.enqueueDue();
      expect(dispatcher.startOnce()).toBe(true); await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
      fixture.clock.advance(10_000); await recovery.enqueueDue();
      expect(dispatcher.startOnce()).toBe(false);
      recovery.stop(); await dispatcher.close();
      expect(await repository.get(original.source.sourceId)).toEqual(original);
      expect(fixture.database.transaction(db => db.prepare("SELECT status FROM outbox WHERE kind=?").get(MODEL_SOURCE_RECOVERY_KIND)?.status)).toBe("PENDING");
      fixture.clock.advance(600_000); await recovery.enqueueDue(); expect(validate).toHaveBeenCalledOnce();
    } finally { recovery.stop(); await dispatcher.close(); await fixture.close(); }
  });

  it("retires a queued probe when the source is manually validated before delivery", async () => {
    const fixture = await createRuntimeFixture(); const repository = new SqliteModelSourceRepository(fixture.database);
    const validator = { validate: vi.fn(() => Promise.resolve({ status: "READY" as const, validatedAt: fixture.clock.now().toISOString() })) };
    const recovery = new ModelSourceRecovery({ repository, queue: repository, clock: fixture.clock, validator });
    const dispatcher = new OutboxDispatcher({ clock: fixture.clock, owner: "recovery", store: fixture.database.store,
      includeKinds: [MODEL_SOURCE_RECOVERY_KIND], handlers: { [MODEL_SOURCE_RECOVERY_KIND]: r => recovery.handle(r) } });
    try {
      seedCredential(fixture); const record = degraded(fixture.clock.now()); await repository.create(record);
      fixture.clock.advance(60_000); await recovery.enqueueDue();
      await repository.save({ ...record, source: { ...record.source, status: "READY", updatedAt: fixture.clock.now().toISOString() } });
      await dispatcher.dispatchOnce(); expect(validator.validate).not.toHaveBeenCalled();
    } finally { recovery.stop(); await dispatcher.close(); await fixture.close(); }
  });
});
