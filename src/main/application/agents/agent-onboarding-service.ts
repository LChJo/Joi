import type { PublicAgentConnection } from "../../domain/agents/agent-connection.js";
import { DomainError } from "../../domain/errors.js";
import type {
  AgentCardCandidate,
  AgentDiscovery,
  AgentIntegrationRecord,
  AgentIntegrationStore,
  CredentialVault,
} from "../ports/a2a-ports.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";

function sensitiveCardChanged(previous: AgentCardCandidate, candidate: AgentCardCandidate): boolean {
  return previous.origin !== candidate.origin
    || previous.rpcUrl !== candidate.rpcUrl
    || previous.protocolVersion !== candidate.protocolVersion
    || previous.transport !== candidate.transport;
}

export class AgentOnboardingService {
  constructor(private readonly dependencies: {
    clock: Clock;
    discovery: AgentDiscovery;
    ids: IdGenerator;
    store: AgentIntegrationStore;
    vault: CredentialVault;
  }) {}

  async onboard(input: { cardUrl: string; token: string }): Promise<PublicAgentConnection> {
    if (!this.dependencies.vault.isAvailable()) {
      throw new DomainError("credential_storage_unavailable", "Secure credential storage is unavailable.");
    }
    if (input.token.trim() === "") throw new DomainError("agent_auth_failed", "Agent Bearer token is required.");
    const expectedActionId = this.dependencies.ids.next("readiness");
    const result = await this.dependencies.discovery.validate({ ...input, expectedActionId });
    const existing = await this.dependencies.store.findAgentConnectionByCardUrlHash(result.card.cardUrlHash);
    return this.persistValidated(result, input.token, existing);
  }

  async refresh(agentConnectionId: string): Promise<PublicAgentConnection> {
    const existing = await this.requireRecord(agentConnectionId);
    const token = await this.dependencies.vault.decrypt(existing.encryptedCredential);
    const result = await this.dependencies.discovery.validate({
      cardUrl: existing.card.cardUrl,
      confirmedCard: existing.card,
      expectedActionId: this.dependencies.ids.next("readiness"),
      token,
    });
    if (sensitiveCardChanged(existing.card, result.card)) {
      return this.dependencies.store.markAgentCardDrift({
        agentConnectionId,
        candidate: result.card,
        cardSnapshotId: this.dependencies.ids.next("card"),
        now: this.dependencies.clock.now().toISOString(),
      });
    }
    return this.dependencies.store.saveOnboardedAgent({
      agentConnectionId,
      card: result.card,
      cardSnapshotId: this.dependencies.ids.next("card"),
      credentialId: existing.credentialId,
      credentialVersion: existing.credentialVersion,
      encryptedCredential: existing.encryptedCredential,
      now: this.dependencies.clock.now().toISOString(),
      readiness: result.readiness.supported,
      status: result.readiness.supported ? "ACTIVE" : "COLLABORATOR_ONLY",
    });
  }

  async rotateToken(agentConnectionId: string, token: string): Promise<PublicAgentConnection> {
    const existing = await this.requireRecord(agentConnectionId);
    if (existing.status === "RECONFIRM_REQUIRED") {
      throw new DomainError("agent_reconfirm_required", "Agent Card changes must be confirmed before rotating credentials.");
    }
    if (!this.dependencies.vault.isAvailable()) throw new DomainError("credential_storage_unavailable", "Secure credential storage is unavailable.");
    const result = await this.dependencies.discovery.validate({
      cardUrl: existing.card.cardUrl,
      confirmedCard: existing.card,
      expectedActionId: this.dependencies.ids.next("readiness"),
      token,
    });
    if (sensitiveCardChanged(existing.card, result.card)) {
      return this.dependencies.store.markAgentCardDrift({
        agentConnectionId,
        candidate: result.card,
        cardSnapshotId: this.dependencies.ids.next("card"),
        now: this.dependencies.clock.now().toISOString(),
      });
    }
    return this.persistValidated(result, token, existing);
  }

  async disable(agentConnectionId: string): Promise<PublicAgentConnection> {
    const connection = await this.dependencies.store.setAgentIntegrationStatus(
      agentConnectionId,
      "DISABLED",
      this.dependencies.clock.now().toISOString(),
    );
    if (connection === null) throw new DomainError("agent_not_found", "Agent connection was not found.");
    return connection;
  }

  async enable(agentConnectionId: string): Promise<PublicAgentConnection> {
    const existing = await this.requireRecord(agentConnectionId);
    if (existing.status !== "DISABLED") throw new DomainError("agent_not_disabled", "Only a disabled Agent connection can be enabled.");
    return this.refresh(agentConnectionId);
  }

  async deletionImpact(agentConnectionId: string) {
    const impact = await this.dependencies.store.getAgentDeletionImpact(agentConnectionId);
    if (impact === null) throw new DomainError("agent_not_found", "Agent connection was not found.");
    return impact;
  }

  async delete(agentConnectionId: string): Promise<void> {
    if (!await this.dependencies.store.deleteAgentIntegration(agentConnectionId, this.dependencies.clock.now().toISOString())) {
      throw new DomainError("agent_not_found", "Agent connection was not found.");
    }
  }

  private async persistValidated(
    result: Awaited<ReturnType<AgentDiscovery["validate"]>>,
    token: string,
    existing: AgentIntegrationRecord | null,
  ): Promise<PublicAgentConnection> {
    const encryptedCredential = await this.dependencies.vault.encrypt(token);
    const now = this.dependencies.clock.now().toISOString();
    return this.dependencies.store.saveOnboardedAgent({
      agentConnectionId: existing?.agentConnectionId ?? this.dependencies.ids.next("agent"),
      card: result.card,
      cardSnapshotId: this.dependencies.ids.next("card"),
      credentialId: this.dependencies.ids.next("credential"),
      credentialVersion: (existing?.credentialVersion ?? 0) + 1,
      encryptedCredential,
      now,
      readiness: result.readiness.supported,
      status: result.readiness.supported ? "ACTIVE" : "COLLABORATOR_ONLY",
    });
  }

  private async requireRecord(agentConnectionId: string): Promise<AgentIntegrationRecord> {
    const record = await this.dependencies.store.getAgentIntegrationRecord(agentConnectionId);
    if (record === null) throw new DomainError("agent_not_found", "Agent connection was not found.");
    return record;
  }
}
