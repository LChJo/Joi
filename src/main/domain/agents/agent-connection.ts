import { DomainError } from "../errors.js";

export const AGENT_CONNECTION_STATUSES = [
  "ACTIVE",
  "COLLABORATOR_ONLY",
  "DISABLED",
  "DRAFT",
  "ERROR",
  "RECONFIRM_REQUIRED",
  "TOKEN_REQUIRED",
] as const;

export type AgentConnectionStatus = (typeof AGENT_CONNECTION_STATUSES)[number];

export interface AgentConnection {
  agentConnectionId: string;
  cardUrl: string;
  createdAt: string;
  name: string;
  status: AgentConnectionStatus;
  updatedAt: string;
}

export interface PublicAgentConnection {
  agentConnectionId: string;
  credentialVersion?: number;
  description?: string;
  lifeBindings?: { lifeId: string; name: string; role: "COLLABORATOR" | "PRIMARY" }[];
  name: string;
  readiness?: boolean;
  recentInvocationStatus?: string;
  skills?: string[];
  status: AgentConnectionStatus;
  updatedAt: string;
}

export function validateAgentShell(input: { cardUrl: string; name: string }) {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 120) {
    throw new DomainError("agent_name_invalid", "Agent name must contain 1 to 120 characters.");
  }

  let cardUrl: URL;
  try {
    cardUrl = new URL(input.cardUrl);
  } catch {
    throw new DomainError("agent_card_invalid", "Agent Card URL is invalid.");
  }
  if (!new Set(["http:", "https:"]).has(cardUrl.protocol) || cardUrl.username !== "" || cardUrl.password !== "" || cardUrl.hash !== "") {
    throw new DomainError("agent_card_invalid", "Agent Card URL must use HTTP(S) without userinfo or fragments.");
  }

  return { cardUrl: cardUrl.toString(), name };
}

export function toPublicAgentConnection(connection: AgentConnection): PublicAgentConnection {
  return {
    agentConnectionId: connection.agentConnectionId,
    name: connection.name,
    status: connection.status,
    updatedAt: connection.updatedAt,
  };
}
