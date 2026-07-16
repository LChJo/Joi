import type { A2aGatewayService } from "../../application/a2a/a2a-gateway-service.js";
import type { A2aResultStore, ArtifactRecord, PrimaryAgentContextStore } from "../../application/ports/a2a-ports.js";
import type { WakeAgentExecutor } from "../../application/wakes/wake-runner.js";
import { DomainError } from "../../domain/errors.js";
import { parseLifeActionEnvelope } from "../../domain/a2a/digital-life-envelope.js";
import { RUNTIME_EXTENSION_URI } from "../../../shared/product.js";
import type { AttachmentService } from "../artifacts/user-attachment-service.js";

export class A2aWakeAgentExecutor implements WakeAgentExecutor {
  constructor(
    private readonly gateway: A2aGatewayService,
    private readonly contexts?: PrimaryAgentContextStore & Pick<A2aResultStore, "listInvocationArtifacts">,
    private readonly artifactEvent?: (input: { affairId?: string; artifact: ArtifactRecord; lifeId: string }) => Promise<void>,
    private readonly attachments?: AttachmentService,
  ) {}

  async execute(input: Parameters<WakeAgentExecutor["execute"]>[0]): Promise<{ invocationId: string; output: unknown }> {
    const scope = contextScope(input.payload);
    const existing = scope === null || this.contexts === undefined ? null : await this.contexts.getPrimaryAgentContext({
      affairKey: scope.affairKey,
      agentConnectionId: input.agentConnectionId,
      lifeId: scope.lifeId,
    });
    const attachmentParts = this.attachments === undefined ? [] : await this.attachments.filePartsFromWake(input.payload);
    const invoke = (contextId?: string, recovery = false) => this.gateway.startWithResult({
      agentConnectionId: input.agentConnectionId,
      ...(scope === null ? {} : { artifactScope: { ...(scope.affairId === undefined ? {} : { affairId: scope.affairId }), lifeId: scope.lifeId } }),
      ...(scope === null ? {} : { capacity: { lane: "primary" as const, lifeId: scope.lifeId } }),
      ...(contextId === undefined ? {} : { contextId }),
      extensions: [RUNTIME_EXTENSION_URI],
      messageId: recovery ? `${input.messageId}_context_rebuild` : input.messageId,
      parts: [
        {
          kind: "text" as const,
          text: recovery
            ? "远端 context 已失效。使用这份有界交接包重建上下文，并只返回一个有效 joi action Envelope。"
            : input.kind === "repair"
              ? "修复上一次 joi action 输出，只返回一个有效动作 Envelope。"
              : "处理这次唤醒并返回 joi actions。",
        },
        { data: input.payload, kind: "data" as const },
        ...attachmentParts,
      ],
      signal: input.signal,
    });
    let result;
    try {
      result = await invoke(existing?.contextId);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "a2a_context_not_found" || existing === null || scope === null || this.contexts === undefined) throw error;
      await this.contexts.clearPrimaryAgentContext({ affairKey: scope.affairKey, agentConnectionId: input.agentConnectionId, lifeId: scope.lifeId });
      result = await invoke(undefined, true);
    }
    if (scope !== null && this.contexts !== undefined && result.invocation.contextId !== undefined) {
      await this.contexts.savePrimaryAgentContext({
        affairKey: scope.affairKey,
        agentConnectionId: input.agentConnectionId,
        contextId: result.invocation.contextId,
        createdAt: existing?.createdAt ?? result.invocation.createdAt,
        lifeId: scope.lifeId,
        updatedAt: result.invocation.updatedAt,
      });
    }
    if (scope !== null && this.contexts !== undefined && this.artifactEvent !== undefined) {
      const artifacts = await this.contexts.listInvocationArtifacts(result.invocation.invocationId);
      for (const artifact of artifacts) await this.artifactEvent({
        ...(scope.affairId === undefined ? {} : { affairId: scope.affairId }), artifact, lifeId: scope.lifeId,
      });
    }
    return { invocationId: result.invocation.invocationId, output: parseLifeActionEnvelope(result.output) };
  }
}

function contextScope(payload: Record<string, unknown>): { affairId?: string; affairKey: string; lifeId: string } | null {
  const life = payload.life;
  if (life === null || Array.isArray(life) || typeof life !== "object") return null;
  const lifeId = (life as Record<string, unknown>).lifeId;
  if (typeof lifeId !== "string" || lifeId === "") return null;
  const affair = payload.affair;
  const affairId = affair !== null && !Array.isArray(affair) && typeof affair === "object"
    ? (affair as Record<string, unknown>).affairId
    : undefined;
  return typeof affairId === "string" && affairId !== ""
    ? { affairId, affairKey: affairId, lifeId }
    : { affairKey: "system", lifeId };
}
