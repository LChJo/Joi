import { toPublicAgentConnection, validateAgentShell, type AgentConnection } from "../../domain/agents/agent-connection.js";
import { DomainError } from "../../domain/errors.js";
import type { AgentStore, Clock, IdGenerator } from "../ports/runtime-store.js";

export class AgentService {
  constructor(private readonly dependencies: { clock: Clock; ids: IdGenerator; store: AgentStore }) {}

  async createShell(input: { cardUrl: string; name: string }) {
    const normalized = validateAgentShell(input);
    const now = this.dependencies.clock.now().toISOString();
    const connection: AgentConnection = {
      agentConnectionId: this.dependencies.ids.next("agent"),
      cardUrl: normalized.cardUrl,
      createdAt: now,
      name: normalized.name,
      status: "DRAFT",
      updatedAt: now,
    };
    await this.dependencies.store.createAgentConnection(connection);
    return toPublicAgentConnection(connection);
  }

  async activateForReadiness(agentConnectionId: string) {
    const connection = await this.dependencies.store.updateAgentConnectionStatus(
      agentConnectionId,
      "ACTIVE",
      this.dependencies.clock.now().toISOString(),
    );
    if (connection === null) throw new DomainError("agent_not_found", "Agent connection was not found.");
    return toPublicAgentConnection(connection);
  }

  list() {
    return this.dependencies.store.listPublicAgentConnections();
  }
}
