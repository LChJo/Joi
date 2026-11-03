import type { A2aGatewayService } from "../a2a/a2a-gateway-service.js";
import type { EventService } from "../events/event-service.js";
import type { A2aRequestPart } from "../ports/a2a-ports.js";
import type { Clock, RuntimeStore } from "../ports/runtime-store.js";
import type { ArtifactReadPort } from "../ports/managed-file-ports.js";
import { DomainError } from "../../domain/errors.js";

export class DelegationService {
  constructor(private readonly dependencies: {
    clock: Clock;
    artifacts?: ArtifactReadPort;
    events: EventService;
    gateway: A2aGatewayService;
    notify: (lifeId: string) => void;
    store: RuntimeStore;
  }) {}

  async dispatch(delegationId: string) {
    const delegation = await this.dependencies.store.getDelegation(delegationId);
    if (delegation === null) throw new DomainError("delegation_not_found", "Delegation was not found.");
    if (new Set(["COMPLETED", "FAILED"]).has(delegation.status)) return delegation;
    const artifactParts: A2aRequestPart[] = [];
    let artifactBytes = 0;
    for (const artifactId of delegation.artifactIds ?? []) {
      if (this.dependencies.artifacts === undefined) throw new DomainError("artifact_service_unavailable", "Artifact forwarding is unavailable.");
      const content = await this.dependencies.artifacts.read({ artifactId, lifeId: delegation.lifeId, preview: false });
      if (content.bytes.byteLength > 10 * 1024 * 1024) throw new DomainError("artifact_forward_too_large", "A forwarded Artifact exceeds 10 MiB.");
      artifactBytes += content.bytes.byteLength;
      if (artifactBytes > 25 * 1024 * 1024) throw new DomainError("artifact_forward_too_large", "Forwarded Artifacts exceed 25 MiB in total.");
      artifactParts.push({ bytes: Buffer.from(content.bytes).toString("base64"), kind: "file" as const, mimeType: content.mimeType, name: content.filename });
    }
    const result = await this.dependencies.gateway.startWithResult({
      agentConnectionId: delegation.agentConnectionId,
      artifactScope: { ...(delegation.affairId === undefined ? {} : { affairId: delegation.affairId }), lifeId: delegation.lifeId },
      capacity: { lane: "collaborator", lifeId: delegation.lifeId },
      parts: [
        { kind: "text", text: `${delegation.title}\n\n${delegation.task}` },
        ...artifactParts,
        {
          data: {
            ...(delegation.affairId === undefined ? {} : { affairId: delegation.affairId }),
            delegationId: delegation.delegationId,
            lifeId: delegation.lifeId,
            sourceBoundary: "delegation-only",
          },
          kind: "data",
        },
      ],
    });
    const mapping = eventForStatus(result.invocation.status);
    if (mapping === null) throw new DomainError("delegation_retry", "Delegation has not reached a recoverable terminal state.");
    const updated = await this.dependencies.store.updateDelegation({
      delegationId,
      invocationId: result.invocation.invocationId,
      now: this.dependencies.clock.now().toISOString(),
      status: mapping.status,
    });
    const artifacts = await this.dependencies.store.listInvocationArtifacts(result.invocation.invocationId);
    for (const artifact of artifacts) {
      await this.dependencies.events.ingest({
        ...(delegation.affairId === undefined ? {} : { affairId: delegation.affairId }),
        dedupeKey: artifact.artifactId,
        lifeId: delegation.lifeId,
        payload: {
          agentConnectionId: delegation.agentConnectionId,
          artifactId: artifact.artifactId,
          filename: artifact.filename,
          invocationId: result.invocation.invocationId,
          mimeType: artifact.mimeType,
          sha256: artifact.sha256,
          size: artifact.size,
        },
        source: "agent",
        type: "agent.artifact_created",
      });
    }
    await this.dependencies.events.ingest({
      ...(delegation.affairId === undefined ? {} : { affairId: delegation.affairId }),
      dedupeKey: delegation.delegationId,
      lifeId: delegation.lifeId,
      payload: {
        agentConnectionId: delegation.agentConnectionId,
        delegationId: delegation.delegationId,
        invocationId: result.invocation.invocationId,
        summary: summarize(result.output),
      },
      source: "agent",
      type: mapping.eventType,
    });
    this.dependencies.notify(delegation.lifeId);
    return updated;
  }
}

function eventForStatus(status: Awaited<ReturnType<A2aGatewayService["start"]>>["status"]): {
  eventType: "agent.auth_required" | "agent.completed" | "agent.failed" | "agent.input_required";
  status: "COMPLETED" | "FAILED" | "WAITING_AUTH" | "WAITING_INPUT";
} | null {
  switch (status) {
    case "COMPLETED": return { eventType: "agent.completed", status: "COMPLETED" };
    case "INPUT_REQUIRED": return { eventType: "agent.input_required", status: "WAITING_INPUT" };
    case "AUTH_REQUIRED": return { eventType: "agent.auth_required", status: "WAITING_AUTH" };
    case "CANCELED":
    case "FAILED":
    case "UNKNOWN_REQUIRES_REVIEW": return { eventType: "agent.failed", status: "FAILED" };
    default: return null;
  }
}

function summarize(output: { artifacts: { name: string; text: string }[]; parts: { data: unknown; kind: string }[] }): string {
  const pieces = [
    ...output.parts.flatMap((part) => typeof part.data === "string" ? [part.data] : []),
    ...output.artifacts.map((artifact) => `${artifact.name}: ${artifact.text}`),
  ];
  return pieces.join("\n").slice(0, 8000);
}
