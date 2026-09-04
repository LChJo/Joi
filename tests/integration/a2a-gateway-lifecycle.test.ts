/* Async-generator mocks deliberately model empty/finite remote streams. */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-empty-function, @typescript-eslint/unbound-method, require-yield */
import { A2aGatewayService } from "../../src/main/application/a2a/a2a-gateway-service";
import type { A2aInvocationTransport, CredentialVault } from "../../src/main/application/ports/a2a-ports";
import { createRuntimeFixture } from "../support/runtime-fixture";

class PlainTestVault implements CredentialVault {
  decrypt(ciphertext: Uint8Array): Promise<string> {
    return Promise.resolve(new TextDecoder().decode(ciphertext));
  }

  encrypt(token: string): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(token));
  }

  isAvailable(): boolean {
    return true;
  }
}

const card = {
  authentication: "bearer" as const,
  capabilities: { streaming: true },
  cardHash: "a".repeat(64),
  cardUrl: "http://agent.lan/card.json",
  cardUrlHash: "b".repeat(64),
  description: "Agent",
  name: "Agent",
  origin: "http://agent.lan",
  protocolVersion: "0.3.0",
  rpcUrl: "http://agent.lan/rpc",
  skills: ["planning"],
  transport: "JSONRPC" as const,
};

async function seedConnection(fixture: Awaited<ReturnType<typeof createRuntimeFixture>>) {
  await fixture.database.store.saveOnboardedAgent({
    agentConnectionId: "agent_gateway",
    card,
    cardSnapshotId: "card_gateway",
    credentialId: "credential_gateway",
    credentialVersion: 1,
    encryptedCredential: new TextEncoder().encode("secret-token"),
    now: fixture.clock.now().toISOString(),
    readiness: true,
    status: "ACTIVE",
  });
}

describe("A2A invocation lifecycle", () => {
  it("persists a stable message before streaming and records terminal remote facts", async () => {
    const fixture = await createRuntimeFixture();
    await seedConnection(fixture);
    const transport: A2aInvocationTransport = {
      cancelTask: vi.fn(),
      getTask: vi.fn(),
      async *resubscribe() {},
      async *sendStream(input) {
        expect(input.token).toBe("secret-token");
        const beforeSend = await fixture.database.store.getInvocation(input.request.invocationId);
        expect(beforeSend).toMatchObject({ messageId: input.request.messageId, status: "SENDING" });
        yield { contextId: "context_remote", kind: "task", state: "submitted", taskId: "task_remote" } as const;
        yield { contextId: "context_remote", final: false, kind: "status", state: "working", taskId: "task_remote" } as const;
        yield { contextId: "context_remote", final: true, kind: "status", state: "completed", taskId: "task_remote" } as const;
      },
    };
    const service = new A2aGatewayService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store, transport, vault: new PlainTestVault() });
    try {
      const invocation = await service.start({
        agentConnectionId: "agent_gateway",
        parts: [{ kind: "text", text: "完成任务" }],
      });
      expect(invocation).toMatchObject({
        contextId: "context_remote", sendAttempts: 1, status: "COMPLETED", taskId: "task_remote",
      });
      expect(invocation.messageId).toMatch(/^message_/);
      expect(JSON.stringify(invocation)).not.toContain("secret-token");
    } finally {
      await fixture.close();
    }
  });

  it("recovers known Tasks by get/resubscribe and never replaces the messageId", async () => {
    const fixture = await createRuntimeFixture();
    await seedConnection(fixture);
    const transport: A2aInvocationTransport = {
      cancelTask: vi.fn(async () => ({ contextId: "context_1", kind: "task", state: "canceled", taskId: "task_1" } as const)),
      getTask: vi.fn(async () => ({ contextId: "context_1", kind: "task", state: "working", taskId: "task_1" } as const)),
      async *resubscribe() {
        yield { contextId: "context_1", final: true, kind: "status", state: "completed", taskId: "task_1" } as const;
      },
      async *sendStream() {
        throw new Error("known Tasks must not be resent");
      },
    };
    const service = new A2aGatewayService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store, transport, vault: new PlainTestVault() });
    try {
      await fixture.database.store.createInvocation({
        agentConnectionId: "agent_gateway",
        createdAt: fixture.clock.now().toISOString(),
        invocationId: "invocation_recover",
        messageId: "message_stable",
        outboxId: "outbox_recover",
        request: { parts: [{ kind: "text", text: "resume" }] },
      });
      await fixture.database.store.updateInvocation("invocation_recover", {
        contextId: "context_1", sendAttempts: 1, status: "WORKING", taskId: "task_1", updatedAt: fixture.clock.now().toISOString(),
      });
      const recovered = await service.recover("invocation_recover");
      expect(recovered.invocation).toMatchObject({ messageId: "message_stable", status: "COMPLETED", taskId: "task_1" });
      expect(transport.getTask).toHaveBeenCalledOnce();
      expect(transport.cancelTask).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("marks an unconfirmed second send as unknown instead of creating a new remote Task", async () => {
    const fixture = await createRuntimeFixture();
    await seedConnection(fixture);
    const sendStream = vi.fn(async function* () {});
    const transport: A2aInvocationTransport = {
      cancelTask: vi.fn(), getTask: vi.fn(), async *resubscribe() {}, sendStream,
    };
    const service = new A2aGatewayService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store, transport, vault: new PlainTestVault() });
    try {
      await fixture.database.store.createInvocation({
        agentConnectionId: "agent_gateway", createdAt: fixture.clock.now().toISOString(), invocationId: "invocation_unknown",
        messageId: "message_stable", outboxId: "outbox_unknown", request: { parts: [{ kind: "text", text: "retry once" }] },
      });
      await fixture.database.store.updateInvocation("invocation_unknown", {
        sendAttempts: 1, status: "SENT_NO_ACCEPT", updatedAt: fixture.clock.now().toISOString(),
      });
      const retried = await service.recover("invocation_unknown");
      expect(retried.invocation).toMatchObject({ messageId: "message_stable", sendAttempts: 2, status: "UNKNOWN_REQUIRES_REVIEW" });
      await service.recover("invocation_unknown");
      expect(sendStream).toHaveBeenCalledOnce();
    } finally {
      await fixture.close();
    }
  });

  it("normalizes input/auth interactions and task-declared Artifact metadata", async () => {
    const fixture = await createRuntimeFixture();
    await seedConnection(fixture);
    const transport: A2aInvocationTransport = {
      cancelTask: vi.fn(), getTask: vi.fn(), async *resubscribe() {},
      async *sendStream() {
        yield { contextId: "context_i", kind: "task", state: "submitted", taskId: "task_i" } as const;
        yield { contextId: "context_i", final: false, kind: "status", prompt: "请选择范围", state: "input-required", taskId: "task_i" } as const;
        yield { contextId: "context_i", final: false, kind: "status", state: "auth-required", taskId: "task_i" } as const;
        yield {
          artifactId: "remote_report", contextId: "context_i", filename: "report.md", kind: "artifact",
          mimeType: "text/markdown", size: 1024, taskId: "task_i", url: "http://agent.lan/artifacts/remote_report",
        } as const;
        yield { contextId: "context_i", final: true, kind: "status", state: "completed", taskId: "task_i" } as const;
      },
    };
    const service = new A2aGatewayService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store, transport, vault: new PlainTestVault() });
    try {
      const invocation = await service.start({ agentConnectionId: "agent_gateway", parts: [{ kind: "text", text: "需要交互" }] });
      expect(await fixture.database.store.listInvocationInteractions(invocation.invocationId)).toEqual([
        expect.objectContaining({ kind: "input-required", prompt: "请选择范围", status: "PENDING" }),
        expect.objectContaining({ kind: "auth-required", status: "PENDING" }),
      ]);
      expect(await fixture.database.store.listInvocationArtifacts(invocation.invocationId)).toEqual([
        expect.objectContaining({ filename: "report.md", mimeType: "text/markdown", remoteArtifactId: "remote_report", size: 1024 }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("deduplicates streamed output and persists scoped downloaded Artifacts with safe fallbacks", async () => {
    const fixture = await createRuntimeFixture();
    await seedConnection(fixture);
    const life = await fixture.lives.create({
      mainAgentConnectionId: "agent_gateway", name: "Artifact Life", personaSummary: "验证产物边界", timezone: "UTC",
    });
    fixture.database.transaction((database) => database.prepare(
      "INSERT INTO affairs (affair_id, life_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'RUNNING', ?, ?)",
    ).run("affair_artifact", life.lifeId, "Artifact Affair", fixture.clock.now().toISOString(), fixture.clock.now().toISOString()));
    const duplicateOutput = {
      artifacts: [{ name: "summary.md", text: "same" }, { name: "summary.md", text: "same" }],
      parts: [{ data: { value: "same" }, kind: "data" }, { data: { value: "same" }, kind: "data" }],
    };
    const transport: A2aInvocationTransport = {
      cancelTask: vi.fn(), getTask: vi.fn(), async *resubscribe() {},
      async *sendStream() {
        yield { contextId: "context_artifact", kind: "task", output: duplicateOutput, state: "submitted", taskId: "task_artifact" } as const;
        yield { contextId: "context_artifact", kind: "message", output: duplicateOutput } as const;
        yield { artifactId: "metadata_only", contextId: "context_artifact", kind: "artifact", taskId: "task_artifact" } as const;
        yield { artifactId: "remote_fallback", contextId: "context_artifact", kind: "artifact", taskId: "task_artifact", url: "http://agent.lan/files/fallback" } as const;
        yield { contextId: "context_artifact", final: false, kind: "status", state: "input-required", taskId: "task_artifact" } as const;
        yield { contextId: "context_artifact", final: true, kind: "status", output: { artifacts: [{ name: "final.md", text: "new" }], parts: [] }, state: "completed", taskId: "task_artifact" } as const;
      },
    };
    const download = vi.fn(() => Promise.resolve({ relativePath: "life/file.bin", sha256: "c".repeat(64), size: 7 }));
    const service = new A2aGatewayService({
      artifactDownloader: { download },
      clock: fixture.clock, ids: fixture.ids, store: fixture.database.store, transport, vault: new PlainTestVault(),
    });
    try {
      const result = await service.startWithResult({
        agentConnectionId: "agent_gateway", artifactScope: { affairId: "affair_artifact", lifeId: life.lifeId }, parts: [],
      });
      expect(result.output).toEqual({
        artifacts: [{ name: "summary.md", text: "same" }, { name: "final.md", text: "new" }],
        parts: [{ data: { value: "same" }, kind: "data" }],
      });
      expect(download).toHaveBeenCalledWith(expect.objectContaining({
        filename: "remote_fallback", mimeType: "application/octet-stream", size: 0,
      }));
      expect(await fixture.database.store.listInvocationArtifacts(result.invocation.invocationId)).toEqual([
        expect.objectContaining({
          affairId: "affair_artifact", filename: "remote_fallback", lifeId: life.lifeId,
          mimeType: "application/octet-stream", relativePath: "life/file.bin", sha256: "c".repeat(64), size: 7,
        }),
      ]);
      expect(await fixture.database.store.listInvocationInteractions(result.invocation.invocationId)).toEqual([
        expect.objectContaining({ kind: "input-required", prompt: "Agent requires user input." }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("cancels local and known remote work without changing terminal facts", async () => {
    const fixture = await createRuntimeFixture();
    await seedConnection(fixture);
    const cancelTask = vi.fn(async () => ({ contextId: "context_c", kind: "task", state: "canceled", taskId: "task_c" } as const));
    const transport: A2aInvocationTransport = {
      cancelTask, getTask: vi.fn(), async *resubscribe() {}, async *sendStream() {},
    };
    const service = new A2aGatewayService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store, transport, vault: new PlainTestVault() });
    try {
      await fixture.database.store.createInvocation({
        agentConnectionId: "agent_gateway", createdAt: fixture.clock.now().toISOString(), invocationId: "invocation_local_cancel",
        messageId: "message_local_cancel", outboxId: "outbox_local_cancel", request: { parts: [] },
      });
      expect(await service.cancel("invocation_local_cancel")).toMatchObject({ status: "CANCELED" });
      expect(await service.cancel("invocation_local_cancel")).toMatchObject({ status: "CANCELED" });

      await fixture.database.store.createInvocation({
        agentConnectionId: "agent_gateway", createdAt: fixture.clock.now().toISOString(), invocationId: "invocation_remote_cancel",
        messageId: "message_remote_cancel", outboxId: "outbox_remote_cancel", request: { parts: [] },
      });
      await fixture.database.store.updateInvocation("invocation_remote_cancel", {
        contextId: "context_c", status: "WORKING", taskId: "task_c", updatedAt: fixture.clock.now().toISOString(),
      });
      expect(await service.cancel("invocation_remote_cancel")).toMatchObject({ status: "CANCELED", taskId: "task_c" });
      expect(cancelTask).toHaveBeenCalledOnce();
      await expect(service.cancel("invocation_missing")).rejects.toMatchObject({ code: "invocation_not_found" });
    } finally {
      await fixture.close();
    }
  });

  it.each([
    ["failed", "FAILED"],
    ["rejected", "FAILED"],
    ["canceled", "CANCELED"],
    ["unknown", "UNKNOWN_REQUIRES_REVIEW"],
  ] as const)("maps remote %s to local %s", async (remoteState, localState) => {
    const fixture = await createRuntimeFixture();
    await seedConnection(fixture);
    const transport: A2aInvocationTransport = {
      cancelTask: vi.fn(), getTask: vi.fn(), async *resubscribe() {},
      async *sendStream() {
        yield { contextId: "context_state", kind: "task", state: remoteState, taskId: "task_state" } as const;
      },
    };
    try {
      const service = new A2aGatewayService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store, transport, vault: new PlainTestVault() });
      await expect(service.start({ agentConnectionId: "agent_gateway", contextId: "context_requested", extensions: ["urn:test"], parts: [] }))
        .resolves.toMatchObject({ status: localState });
    } finally {
      await fixture.close();
    }
  });

  it("opens the shared breaker on retryable transport responses and propagates ordinary failures", async () => {
    const fixture = await createRuntimeFixture();
    await seedConnection(fixture);
    class RetryableError extends Error {
      readonly retryAfter = null;
      readonly status = 429 as const;
    }
    let retryable = true;
    const transport: A2aInvocationTransport = {
      cancelTask: vi.fn(), getTask: vi.fn(), async *resubscribe() {},
      async *sendStream() {
        if (retryable) throw new RetryableError();
        throw new Error("ordinary failure");
      },
    };
    const service = new A2aGatewayService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store, transport, vault: new PlainTestVault() });
    try {
      await expect(service.start({ agentConnectionId: "agent_gateway", parts: [] })).resolves.toMatchObject({ status: "WAITING_RETRY" });
      await expect(service.start({ agentConnectionId: "agent_gateway", parts: [] })).rejects.toMatchObject({ code: "agent_rate_limited" });
      fixture.clock.advance(10_001);
      retryable = false;
      await expect(service.start({ agentConnectionId: "agent_gateway", parts: [] })).rejects.toThrow("ordinary failure");
    } finally {
      await fixture.close();
    }
  });

  it("honors 503 retry hints and preserves primitive transport failures", async () => {
    const fixture = await createRuntimeFixture();
    await seedConnection(fixture);
    let failure: unknown = { retryAfter: "3", status: 503 };
    const transport: A2aInvocationTransport = {
      cancelTask: vi.fn(), getTask: vi.fn(), async *resubscribe() {},
      async *sendStream() { throw failure; },
    };
    const service = new A2aGatewayService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store, transport, vault: new PlainTestVault() });
    try {
      await expect(service.start({ agentConnectionId: "agent_gateway", parts: [] })).resolves.toMatchObject({ status: "WAITING_RETRY" });
      fixture.clock.advance(10_001);
      failure = "socket closed";
      await expect(service.start({ agentConnectionId: "agent_gateway", contextId: "context_kept", parts: [] })).rejects.toBe("socket closed");
    } finally {
      await fixture.close();
    }
  });

  it("persists cancellation when dispatch starts with an aborted signal", async () => {
    const fixture = await createRuntimeFixture();
    await seedConnection(fixture);
    const sendStream = vi.fn(async function* () {});
    const transport: A2aInvocationTransport = {
      cancelTask: vi.fn(), getTask: vi.fn(), async *resubscribe() {}, sendStream,
    };
    const service = new A2aGatewayService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store, transport, vault: new PlainTestVault() });
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(service.start({ agentConnectionId: "agent_gateway", parts: [], signal: controller.signal }))
        .rejects.toMatchObject({ name: "AbortError" });
      expect(fixture.database.transaction((database) => database.prepare(
        "SELECT status FROM invocations ORDER BY created_at DESC LIMIT 1",
      ).get())).toMatchObject({ status: "CANCELED" });
      expect(sendStream).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("fences unavailable connections and sent-without-acceptance recovery", async () => {
    const fixture = await createRuntimeFixture();
    await seedConnection(fixture);
    const transport: A2aInvocationTransport = {
      cancelTask: vi.fn(), getTask: vi.fn(), async *resubscribe() {}, async *sendStream() {},
    };
    const service = new A2aGatewayService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store, transport, vault: new PlainTestVault() });
    try {
      await fixture.database.store.createInvocation({
        agentConnectionId: "agent_gateway", createdAt: fixture.clock.now().toISOString(), invocationId: "invocation_already_sent",
        messageId: "message_already_sent", outboxId: "outbox_already_sent", request: { parts: [] },
      });
      await fixture.database.store.updateInvocation("invocation_already_sent", {
        sendAttempts: 2, status: "SENT_NO_ACCEPT", updatedAt: fixture.clock.now().toISOString(),
      });
      expect((await service.recover("invocation_already_sent")).invocation).toMatchObject({ status: "UNKNOWN_REQUIRES_REVIEW" });

      await fixture.database.store.setAgentIntegrationStatus("agent_gateway", "DISABLED", fixture.clock.now().toISOString());
      await expect(service.start({ agentConnectionId: "agent_gateway", parts: [] })).rejects.toMatchObject({ code: "agent_unavailable" });
      fixture.database.transaction((database) => database.prepare("UPDATE agent_connections SET status = 'RECONFIRM_REQUIRED' WHERE agent_connection_id = ?").run("agent_gateway"));
      await expect(service.start({ agentConnectionId: "agent_gateway", parts: [] })).rejects.toMatchObject({ code: "agent_reconfirm_required" });
      fixture.database.transaction((database) => database.prepare("UPDATE agent_connections SET token_required = 1 WHERE agent_connection_id = ?").run("agent_gateway"));
      await expect(service.start({ agentConnectionId: "agent_gateway", parts: [] })).rejects.toMatchObject({ code: "agent_token_required" });
      fixture.database.transaction((database) => database.prepare("UPDATE agent_connections SET status = 'COLLABORATOR_ONLY', token_required = 0 WHERE agent_connection_id = ?").run("agent_gateway"));
      await expect(service.start({ agentConnectionId: "agent_gateway", parts: [] })).resolves.toMatchObject({ status: "SENT_NO_ACCEPT" });
    } finally {
      await fixture.close();
    }
  });

  it("emits invocation lifecycle and breaker diagnostics", async () => {
    const fixture = await createRuntimeFixture();
    await seedConnection(fixture);
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const diagnostics = { emit: (event: string, fields: Record<string, unknown>) => { events.push({ event, fields }); } };
    let fail429 = false;
    const transport: A2aInvocationTransport = {
      cancelTask: vi.fn(), getTask: vi.fn(), async *resubscribe() {},
      async *sendStream() {
        if (fail429) throw Object.assign(new Error("rate limited"), { retryAfter: null, status: 429 });
        yield { contextId: "context_diag", kind: "task", state: "completed", taskId: "task_diag" } as const;
      },
    };
    const service = new A2aGatewayService({ clock: fixture.clock, diagnostics, ids: fixture.ids, store: fixture.database.store, transport, vault: new PlainTestVault() });
    try {
      await service.start({ agentConnectionId: "agent_gateway", parts: [] });
      const started = events.find((entry) => entry.event === "joi.a2a.invocation_started");
      const settled = events.find((entry) => entry.event === "joi.a2a.invocation_settled");
      expect(started?.fields).toMatchObject({ agentConnectionId: "agent_gateway" });
      expect(settled?.fields.status).toBe("COMPLETED");
      expect(typeof settled?.fields.durationMs).toBe("number");

      fail429 = true;
      await expect(service.start({ agentConnectionId: "agent_gateway", parts: [] })).resolves.toMatchObject({ status: "WAITING_RETRY" });
      const opened = events.find((entry) => entry.event === "joi.a2a.breaker_opened");
      expect(opened?.fields.lastStatus).toBe(429);
      expect(typeof opened?.fields.openUntil).toBe("string");

      await expect(service.recover("invocation_missing")).rejects.toMatchObject({ code: "invocation_not_found" });
      expect(events.find((entry) => entry.event === "joi.a2a.recover_failed")?.fields)
        .toMatchObject({ errorCode: "invocation_not_found", invocationId: "invocation_missing" });
    } finally {
      await fixture.close();
    }
  });
});
