import { DomainError } from "../../domain/errors.js";
import { ArtifactPolicy } from "../../domain/a2a/artifact-policy.js";
import type {
  A2aInvocationRequest,
  A2aInvocationOutput,
  A2aInvocationTransport,
  A2aRemoteEvent,
  A2aRemoteState,
  A2aTransportConfig,
  ArtifactDownloader,
  CredentialVault,
  InvocationRecord,
  InvocationStatus,
} from "../ports/a2a-ports.js";
import type { Clock, IdGenerator, RuntimeStore } from "../ports/runtime-store.js";
import { emitRuntimeDiagnostic, runtimeDiagnosticErrorCode, type RuntimeDiagnostics } from "../ports/runtime-diagnostics.js";
import { PersistentConnectionBreaker } from "./connection-breaker.js";
import { InvocationCapacityGate, type InvocationCapacityScope } from "./invocation-capacity-gate.js";

const TERMINAL = new Set<InvocationStatus>(["CANCELED", "COMPLETED", "FAILED", "UNKNOWN_REQUIRES_REVIEW"]);

function localStatus(state: A2aRemoteState): InvocationStatus {
  switch (state) {
    case "submitted": return "ACCEPTED";
    case "working": return "WORKING";
    case "input-required": return "INPUT_REQUIRED";
    case "auth-required": return "AUTH_REQUIRED";
    case "completed": return "COMPLETED";
    case "canceled": return "CANCELED";
    case "failed":
    case "rejected": return "FAILED";
    case "unknown": return "UNKNOWN_REQUIRES_REVIEW";
  }
}

export class A2aGatewayService {
  private readonly breaker: PersistentConnectionBreaker;
  private readonly artifactPolicy = new ArtifactPolicy();
  private readonly capacity: InvocationCapacityGate;
  private readonly capacityByInvocation = new Map<string, Omit<InvocationCapacityScope, "endpointKey">>();
  private readonly artifactScopeByInvocation = new Map<string, { affairId?: string; lifeId: string }>();

  constructor(private readonly dependencies: {
    clock: Clock;
    ids: IdGenerator;
    store: RuntimeStore;
    transport: A2aInvocationTransport;
    vault: CredentialVault;
    artifactDownloader?: ArtifactDownloader;
    capacity?: InvocationCapacityGate;
    diagnostics?: RuntimeDiagnostics;
  }) {
    this.breaker = new PersistentConnectionBreaker({ clock: dependencies.clock, store: dependencies.store });
    this.capacity = dependencies.capacity ?? new InvocationCapacityGate();
  }

  async start(input: { agentConnectionId: string; artifactScope?: { affairId?: string; lifeId: string }; capacity?: Omit<InvocationCapacityScope, "endpointKey">; contextId?: string; extensions?: string[]; messageId?: string; parts: A2aInvocationRequest["parts"]; signal?: AbortSignal }): Promise<InvocationRecord> {
    return (await this.startWithResult(input)).invocation;
  }

  async startWithResult(input: { agentConnectionId: string; artifactScope?: { affairId?: string; lifeId: string }; capacity?: Omit<InvocationCapacityScope, "endpointKey">; contextId?: string; extensions?: string[]; messageId?: string; parts: A2aInvocationRequest["parts"]; signal?: AbortSignal }): Promise<{ invocation: InvocationRecord; output: A2aInvocationOutput }> {
    const now = this.dependencies.clock.now().toISOString();
    const invocationId = this.dependencies.ids.next("invocation");
    const messageId = input.messageId ?? this.dependencies.ids.next("message");
    const outboxId = this.dependencies.ids.next("outbox");
    await this.dependencies.store.createInvocation({
      agentConnectionId: input.agentConnectionId,
      createdAt: now,
      invocationId,
      messageId,
      outboxId,
      request: {
        parts: input.parts,
        ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
        ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
      },
    });
    if (input.capacity !== undefined) this.capacityByInvocation.set(invocationId, input.capacity);
    if (input.artifactScope !== undefined) this.artifactScopeByInvocation.set(invocationId, input.artifactScope);
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.a2a.invocation_started", {
      agentConnectionId: input.agentConnectionId,
      invocationId,
      messageId,
    });
    const startedAtMillis = this.dependencies.clock.now().getTime();
    const directOwner = `direct:${invocationId}`;
    const claimed = await this.dependencies.store.claimOutboxById({
      claimUntil: new Date(this.dependencies.clock.now().getTime() + 10 * 60_000).toISOString(),
      now,
      outboxId,
      owner: directOwner,
    });
    if (claimed === null) throw new DomainError("outbox_claim_lost", "Invocation outbox could not be claimed for dispatch.");
    const output: A2aInvocationOutput = { artifacts: [], parts: [] };
    try {
      const invocation = await this.dispatch(invocationId, output, input.signal);
      if (invocation.status === "SENT_NO_ACCEPT" || invocation.status === "WAITING_RETRY") {
        await this.dependencies.store.releaseOutbox({
          availableAt: new Date(this.dependencies.clock.now().getTime() + 2 * 60_000).toISOString(),
          outboxId,
          owner: directOwner,
        });
      } else {
        await this.dependencies.store.completeOutbox(outboxId, directOwner);
      }
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.a2a.invocation_settled", {
        durationMs: Math.max(0, this.dependencies.clock.now().getTime() - startedAtMillis),
        invocationId,
        status: invocation.status,
      });
      return { invocation, output };
    } catch (error) {
      if (input.signal?.aborted === true) {
        await this.dependencies.store.updateInvocation(invocationId, {
          status: "CANCELED",
          updatedAt: this.dependencies.clock.now().toISOString(),
        });
        await this.dependencies.store.completeOutbox(outboxId, directOwner);
      } else if (input.contextId !== undefined && this.contextNotFound(error)) {
        await this.dependencies.store.updateInvocation(invocationId, {
          status: "FAILED",
          updatedAt: this.dependencies.clock.now().toISOString(),
        });
        await this.dependencies.store.completeOutbox(outboxId, directOwner);
        throw new DomainError("a2a_context_not_found", "The remote Agent context no longer exists.");
      } else {
        await this.dependencies.store.releaseOutbox({
          availableAt: new Date(this.dependencies.clock.now().getTime() + 2 * 60_000).toISOString(),
          outboxId,
          owner: directOwner,
        });
      }
      throw error;
    } finally {
      this.capacityByInvocation.delete(invocationId);
      this.artifactScopeByInvocation.delete(invocationId);
    }
  }

  async recover(invocationId: string): Promise<{ invocation: InvocationRecord; output: A2aInvocationOutput }> {
    // Recovered terminal output must be returned to the caller: the dispatch path builds the
    // work result body from it, and dropping it turns completed remote work into an empty
    // (and, with mandatory acceptance checks, failing) result.
    const output: A2aInvocationOutput = { artifacts: [], parts: [] };
    try {
      const invocation = await this.requireInvocation(invocationId);
      const recoverCompletedOutput = invocation.status === "COMPLETED" && invocation.taskId !== undefined;
      if (TERMINAL.has(invocation.status) && !recoverCompletedOutput) return { invocation, output };
      if (invocation.taskId !== undefined) {
        const access = await this.access(invocation.agentConnectionId);
        const breakerKey = this.breaker.keyFor({
          agentConnectionId: access.config.agentConnectionId,
          credentialVersion: access.config.credentialVersion,
          origin: access.config.origin,
        });
        try {
          await this.breaker.assertAvailable(breakerKey);
        } catch (error) {
          if (recoverCompletedOutput) throw error;
          // Cooling endpoints postpone reads until the outbox retries after the cooldown.
          return { invocation, output };
        }
        const remote = await this.dependencies.transport.getTask({ config: access.config, taskId: invocation.taskId });
        if (remote.output !== undefined) this.collectOutput(output, remote.output);
        // Reading completed output cannot revise settled invocation facts or restart remote work.
        if (recoverCompletedOutput) return { invocation, output };
        let current = await this.applyEvent(invocation, remote);
        if (!TERMINAL.has(current.status)) {
          for await (const event of this.dependencies.transport.resubscribe({ config: access.config, taskId: invocation.taskId })) {
            if (event.output !== undefined) this.collectOutput(output, event.output);
            current = await this.applyEvent(current, event);
          }
        }
        return { invocation: current, output };
      }
      if (invocation.status === "SENT_NO_ACCEPT" && invocation.sendAttempts >= 2) {
        return {
          invocation: await this.dependencies.store.updateInvocation(invocationId, {
            status: "UNKNOWN_REQUIRES_REVIEW",
            updatedAt: this.dependencies.clock.now().toISOString(),
          }),
          output,
        };
      }
      return { invocation: await this.dispatch(invocationId, output), output };
    } catch (error) {
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.a2a.recover_failed", {
        errorCode: runtimeDiagnosticErrorCode(error),
        invocationId,
      });
      throw error;
    }
  }

  async cancel(invocationId: string): Promise<InvocationRecord> {
    const invocation = await this.requireInvocation(invocationId);
    if (TERMINAL.has(invocation.status)) return invocation;
    if (invocation.taskId === undefined) {
      return this.dependencies.store.updateInvocation(invocationId, {
        status: "CANCELED", updatedAt: this.dependencies.clock.now().toISOString(),
      });
    }
    const access = await this.access(invocation.agentConnectionId);
    return this.applyEvent(invocation, await this.dependencies.transport.cancelTask({ config: access.config, taskId: invocation.taskId }));
  }

  private async dispatch(invocationId: string, output?: A2aInvocationOutput, signal?: AbortSignal): Promise<InvocationRecord> {
    let invocation = await this.requireInvocation(invocationId);
    const access = await this.access(invocation.agentConnectionId);
    const breakerKey = this.breaker.keyFor({
      agentConnectionId: access.config.agentConnectionId,
      credentialVersion: access.config.credentialVersion,
      origin: access.config.origin,
    });
    await this.breaker.assertAvailable(breakerKey);
    const capacity = this.capacityByInvocation.get(invocationId);
    const release = await this.capacity.acquire({ endpointKey: access.config.origin, ...capacity }, signal);
    try {
    const sendAttempts = invocation.sendAttempts + 1;
    invocation = await this.dependencies.store.updateInvocation(invocationId, {
      sendAttempts,
      status: "SENDING",
      updatedAt: this.dependencies.clock.now().toISOString(),
    });
    const request: A2aInvocationRequest = {
      invocationId,
      messageId: invocation.messageId,
      parts: invocation.request.parts,
      ...(invocation.request.contextId === undefined ? {} : { contextId: invocation.request.contextId }),
      ...(invocation.request.extensions === undefined ? {} : { extensions: invocation.request.extensions }),
    };
    let receivedAcceptance = false;
    try {
      for await (const event of this.dependencies.transport.sendStream({
        config: access.config,
        request,
        ...(signal === undefined ? {} : { signal }),
        token: access.config.token,
      })) {
        if (event.kind === "task" || event.kind === "status") receivedAcceptance = true;
        if (output !== undefined && event.output !== undefined) this.collectOutput(output, event.output);
        invocation = await this.applyEvent(invocation, event);
      }
    } catch (error) {
      const retryable = this.retryableError(error);
      if (retryable !== null) {
        const opened = await this.breaker.recordRetryableResponse({ key: breakerKey, retryAfter: retryable.retryAfter, status: retryable.status });
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.a2a.breaker_opened", {
          breakerKey,
          invocationId,
          lastStatus: retryable.status,
          openUntil: opened.openUntil,
        });
        return await this.dependencies.store.updateInvocation(invocationId, {
          status: "WAITING_RETRY", updatedAt: this.dependencies.clock.now().toISOString(),
        });
      }
      throw error;
    }
    if (!receivedAcceptance) {
      return await this.dependencies.store.updateInvocation(invocationId, {
        status: sendAttempts >= 2 ? "UNKNOWN_REQUIRES_REVIEW" : "SENT_NO_ACCEPT",
        updatedAt: this.dependencies.clock.now().toISOString(),
      });
    }
    return invocation;
    } finally {
      release();
    }
  }

  private collectOutput(target: A2aInvocationOutput, incoming: A2aInvocationOutput): void {
    const partKeys = new Set(target.parts.map((part) => JSON.stringify(part)));
    for (const part of incoming.parts) {
      const key = JSON.stringify(part);
      if (!partKeys.has(key)) {
        partKeys.add(key);
        target.parts.push(part);
      }
    }
    const artifactKeys = new Set(target.artifacts.map((artifact) => `${artifact.name}\n${artifact.text}`));
    for (const artifact of incoming.artifacts) {
      const key = `${artifact.name}\n${artifact.text}`;
      if (!artifactKeys.has(key)) {
        artifactKeys.add(key);
        target.artifacts.push(artifact);
      }
    }
  }

  private async applyEvent(invocation: InvocationRecord, event: A2aRemoteEvent): Promise<InvocationRecord> {
    if (event.kind === "message") return invocation;
    if (event.kind === "artifact") {
      if (event.url !== undefined) {
        const access = await this.access(invocation.agentConnectionId);
        const artifact = this.artifactPolicy.validate({
          declaredOrigin: access.config.origin,
          filename: event.filename ?? event.artifactId,
          mimeType: event.mimeType ?? "application/octet-stream",
          size: event.size ?? 0,
          url: event.url,
        });
        const scope = this.artifactScopeByInvocation.get(invocation.invocationId);
        if (scope !== undefined) await this.dependencies.store.assertArtifactQuota({
          ...(scope.affairId === undefined ? {} : { affairId: scope.affairId }), additionalBytes: artifact.size, lifeId: scope.lifeId,
        });
        const downloaded = this.dependencies.artifactDownloader === undefined
          ? undefined
          : await this.dependencies.artifactDownloader.download({
            artifactId: event.artifactId,
            declaredOrigin: access.config.origin,
            filename: artifact.filename,
            invocationId: invocation.invocationId,
            mimeType: artifact.mimeType,
            size: artifact.size,
            token: access.config.token,
            url: artifact.url,
          });
        await this.dependencies.store.createArtifact({
          artifactId: this.dependencies.ids.next("artifact"),
          createdAt: this.dependencies.clock.now().toISOString(),
          filename: artifact.filename,
          invocationId: invocation.invocationId,
          mimeType: artifact.mimeType,
          remoteArtifactId: event.artifactId,
          size: downloaded?.size ?? artifact.size,
          ...(scope === undefined ? {} : { lifeId: scope.lifeId }),
          ...(scope?.affairId === undefined ? {} : { affairId: scope.affairId }),
          ...(downloaded === undefined ? {} : { relativePath: downloaded.relativePath, sha256: downloaded.sha256 }),
        });
      }
      return this.dependencies.store.updateInvocation(invocation.invocationId, {
        contextId: event.contextId,
        taskId: event.taskId,
        updatedAt: this.dependencies.clock.now().toISOString(),
      });
    }
    const now = this.dependencies.clock.now().toISOString();
    if (event.state === "input-required" || event.state === "auth-required") {
      await this.dependencies.store.createInteraction({
        createdAt: now,
        interactionId: this.dependencies.ids.next("interaction"),
        invocationId: invocation.invocationId,
        kind: event.state,
        prompt: (event.kind === "status" ? event.prompt : undefined)
          ?? (event.state === "auth-required" ? "Agent requires user authorization." : "Agent requires user input."),
        status: "PENDING",
      });
    }
    return this.dependencies.store.updateInvocation(invocation.invocationId, {
      ...(invocation.acceptedAt === undefined ? { acceptedAt: now } : {}),
      contextId: event.contextId,
      status: localStatus(event.state),
      taskId: event.taskId,
      updatedAt: now,
    });
  }

  private async access(agentConnectionId: string): Promise<{ config: A2aTransportConfig }> {
    const connection = await this.dependencies.store.getAgentIntegrationRecord(agentConnectionId);
    if (connection === null) throw new DomainError("agent_not_found", "Agent connection was not found.");
    if (!new Set(["ACTIVE", "COLLABORATOR_ONLY"]).has(connection.status)) {
      const code = connection.status === "RECONFIRM_REQUIRED"
        ? "agent_reconfirm_required"
        : connection.status === "TOKEN_REQUIRED" ? "agent_token_required" : "agent_unavailable";
      throw new DomainError(code, "Agent connection is not available for new invocations.");
    }
    const token = await this.dependencies.vault.decrypt(connection.encryptedCredential);
    return {
      config: {
        agentConnectionId,
        credentialVersion: connection.credentialVersion,
        origin: connection.card.origin,
        rpcUrl: connection.card.rpcUrl,
        token,
        transport: connection.card.transport,
      },
    };
  }

  private async requireInvocation(invocationId: string): Promise<InvocationRecord> {
    const invocation = await this.dependencies.store.getInvocation(invocationId);
    if (invocation === null) throw new DomainError("invocation_not_found", "Invocation was not found.");
    return invocation;
  }

  private retryableError(error: unknown): { retryAfter: string | null; status: 429 | 503 } | null {
    if (error === null || typeof error !== "object") return null;
    const candidate = error as { retryAfter?: unknown; status?: unknown };
    if (candidate.status !== 429 && candidate.status !== 503) return null;
    return { retryAfter: typeof candidate.retryAfter === "string" ? candidate.retryAfter : null, status: candidate.status };
  }

  private contextNotFound(error: unknown): boolean {
    if (error === null || typeof error !== "object") return false;
    const candidate = error as { code?: unknown; message?: unknown; status?: unknown };
    if (candidate.status === 404) return true;
    const description = `${typeof candidate.code === "string" ? candidate.code : ""} ${typeof candidate.message === "string" ? candidate.message : ""}`.toLowerCase();
    return /(context|task).*(not.?found|missing|expired)/.test(description);
  }
}
