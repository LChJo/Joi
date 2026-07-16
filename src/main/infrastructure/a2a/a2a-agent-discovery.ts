import { createHash } from "node:crypto";

import type { Message, MessageSendParams, Task, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import { JsonRpcTransport } from "@a2a-js/sdk/client";

import type { AgentCardCandidate, AgentDiscovery, AgentDiscoveryResult } from "../../application/ports/a2a-ports.js";
import { validateReadinessAck } from "../../domain/a2a/digital-life-envelope.js";
import { DomainError } from "../../domain/errors.js";
import { RUNTIME_EXTENSION_URI } from "../../../shared/product.js";
import type { OutboundNetworkPolicy } from "./outbound-network-policy.js";

const MAX_CARD_BYTES = 256 * 1024;
const REQUIRED_ACTIONS = [
  "express",
  "memory.append",
  "memory.revise",
  "affair.upsert",
  "todo.upsert",
  "alarm.schedule",
  "alarm.cancel",
  "delegate",
  "interaction.answer",
  "sleep",
];

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new DomainError("agent_card_invalid", `${label} is invalid.`);
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw new DomainError("agent_card_invalid", `Agent Card ${key} is invalid.`);
  return value;
}

function hasBearerScheme(card: Record<string, unknown>): boolean {
  const schemes = card.securitySchemes;
  if (schemes === null || Array.isArray(schemes) || typeof schemes !== "object") return false;
  return Object.values(schemes as Record<string, unknown>).some((scheme) => {
    if (scheme === null || Array.isArray(scheme) || typeof scheme !== "object") return false;
    const item = scheme as Record<string, unknown>;
    return item.type === "http" && typeof item.scheme === "string" && item.scheme.toLowerCase() === "bearer";
  });
}

function sensitiveCardChanged(previous: AgentCardCandidate, candidate: AgentCardCandidate): boolean {
  return previous.origin !== candidate.origin
    || previous.rpcUrl !== candidate.rpcUrl
    || previous.protocolVersion !== candidate.protocolVersion
    || previous.transport !== candidate.transport;
}

function dataFromMessage(message: Message): unknown {
  if (!message.extensions?.includes(RUNTIME_EXTENSION_URI)) return undefined;
  const dataParts = message.parts.filter((part) => part.kind === "data");
  return dataParts.length === 1 && dataParts[0]?.kind === "data" ? dataParts[0].data : undefined;
}

function readinessData(event: Message | Task | TaskStatusUpdateEvent): unknown {
  if (event.kind === "message") return dataFromMessage(event);
  if (event.kind === "task") return event.status.message === undefined ? undefined : dataFromMessage(event.status.message);
  return event.status.message === undefined ? undefined : dataFromMessage(event.status.message);
}

export class A2aAgentDiscovery implements AgentDiscovery {
  constructor(private readonly dependencies: { fetchImpl?: typeof fetch; policy: OutboundNetworkPolicy }) {}

  async validate(input: { cardUrl: string; confirmedCard?: AgentCardCandidate; expectedActionId: string; token: string }): Promise<AgentDiscoveryResult> {
    const cardLocation = await this.dependencies.policy.validate(input.cardUrl, { rejectQuery: true });
    const response = await this.fetchFollowingRedirects(cardLocation.url, undefined);
    if (!response.ok) throw new DomainError("agent_card_invalid", "Agent Card could not be fetched.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_CARD_BYTES) throw new DomainError("agent_card_invalid", "Agent Card exceeds 256 KiB.");
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new DomainError("agent_card_invalid", "Agent Card is not valid JSON.");
    }
    const card = await this.parseCard(raw, cardLocation.url);
    if (input.confirmedCard !== undefined && sensitiveCardChanged(input.confirmedCard, card)) {
      return { card, readiness: { supported: false, supportedActions: [] } };
    }

    const secureFetch = this.authorizedFetch(card.origin, input.token);
    const transport = new JsonRpcTransport({ endpoint: card.rpcUrl, fetchImpl: secureFetch });
    const request: MessageSendParams = {
      message: {
        extensions: [RUNTIME_EXTENSION_URI],
        kind: "message",
        messageId: input.expectedActionId,
        parts: [
          { kind: "text", text: "Verify joi runtime readiness without side effects." },
          {
            data: {
              expectedActionId: input.expectedActionId,
              kind: "readiness",
              noSideEffects: true,
              requiredActions: REQUIRED_ACTIONS,
              version: 1,
            },
            kind: "data",
          },
        ],
        role: "user",
      },
    };
    try {
      for await (const event of transport.sendMessageStream(request, { signal: AbortSignal.timeout(30_000) })) {
        if (event.kind !== "artifact-update") {
          const data = readinessData(event);
          if (data !== undefined) {
            const ack = validateReadinessAck(data, { expectedActionId: input.expectedActionId, requiredActions: REQUIRED_ACTIONS });
            return { card, readiness: { supported: true, supportedActions: ack.supportedActions } };
          }
        }
      }
      return { card, readiness: { supported: false, supportedActions: [] } };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      return { card, readiness: { supported: false, supportedActions: [] } };
    }
  }

  private async parseCard(value: unknown, cardUrl: string): Promise<AgentCardCandidate> {
    const raw = recordValue(value, "Agent Card");
    const protocolVersion = requiredString(raw, "protocolVersion");
    if (!/^0\.3(?:\.\d+)?$/.test(protocolVersion)) throw new DomainError("agent_protocol_unsupported", "Agent must support A2A protocol 0.3.x.");
    const transportValue = typeof raw.preferredTransport === "string" ? raw.preferredTransport.toUpperCase() : "JSONRPC";
    const transport = transportValue === "JSONRPC" ? "JSONRPC" : new Set(["REST", "HTTP+JSON"]).has(transportValue) ? "REST" : null;
    if (transport === null) throw new DomainError("agent_protocol_unsupported", "Agent transport is unsupported.");
    if (!hasBearerScheme(raw)) throw new DomainError("agent_auth_failed", "Agent Card must declare HTTP Bearer authentication.");
    const rpc = await this.dependencies.policy.validate(requiredString(raw, "url"));
    const skillsRaw = raw.skills;
    if (!Array.isArray(skillsRaw)) throw new DomainError("agent_card_invalid", "Agent Card skills are invalid.");
    const skills = skillsRaw.map((skill) => {
      const item = recordValue(skill, "Agent skill");
      return requiredString(item, "name");
    });
    const capabilities = recordValue(raw.capabilities, "Agent capabilities");
    const canonical = JSON.stringify(raw);
    return {
      authentication: "bearer",
      capabilities: { streaming: capabilities.streaming === true },
      cardHash: createHash("sha256").update(canonical).digest("hex"),
      cardUrl,
      cardUrlHash: createHash("sha256").update(cardUrl).digest("hex"),
      description: requiredString(raw, "description"),
      name: requiredString(raw, "name"),
      origin: rpc.origin,
      protocolVersion,
      rpcUrl: rpc.url,
      skills,
      transport,
    };
  }

  private authorizedFetch(bearerOrigin: string, token: string): typeof fetch {
    return async (resource, init) => {
      const url = resource instanceof Request ? resource.url : resource.toString();
      const validated = await this.dependencies.policy.validate(url);
      if (validated.origin !== bearerOrigin) throw new DomainError("agent_reconfirm_required", "Bearer Origin no longer matches the confirmed Agent Origin.");
      const headers = new Headers(resource instanceof Request ? resource.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      headers.set("authorization", `Bearer ${token}`);
      return this.fetchFollowingRedirects(validated.url, { ...init, headers }, bearerOrigin);
    };
  }

  private async fetchFollowingRedirects(url: string, init?: RequestInit, bearerOrigin?: string): Promise<Response> {
    const fetchImpl = this.dependencies.fetchImpl ?? fetch;
    let current = url;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await this.dependencies.policy.validate(current);
      const response = await fetchImpl(current, { ...init, redirect: "manual", signal: init?.signal ?? AbortSignal.timeout(15_000) });
      if (bearerOrigin !== undefined && (response.status === 401 || response.status === 403)) {
        throw new DomainError("agent_auth_failed", "Agent rejected the Bearer credential.");
      }
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (location === null) throw new DomainError("agent_card_invalid", "Agent redirect is missing Location.");
      current = (await this.dependencies.policy.validateRedirect({
        ...(bearerOrigin === undefined ? {} : { bearerOrigin }),
        from: current,
        location,
      })).url;
    }
    throw new DomainError("agent_card_invalid", "Agent redirect limit exceeded.");
  }
}
