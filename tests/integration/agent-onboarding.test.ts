import { AgentOnboardingService } from "../../src/main/application/agents/agent-onboarding-service";
import type { AgentDiscovery, CredentialVault } from "../../src/main/application/ports/a2a-ports";
import { createRuntimeFixture } from "../support/runtime-fixture";

const card = {
  authentication: "bearer" as const,
  capabilities: { streaming: true },
  cardHash: "a".repeat(64),
  cardUrl: "http://agent.lan/a2a/v0.3/agents/main/.well-known/agent-card.json",
  cardUrlHash: "c".repeat(64),
  description: "AI Mana Agent",
  name: "主 Agent",
  origin: "http://agent.lan",
  protocolVersion: "0.3.0",
  rpcUrl: "http://agent.lan/a2a/v0.3/agents/main",
  skills: ["planning"],
  transport: "JSONRPC" as const,
};

class FakeVault implements CredentialVault {
  decrypt(ciphertext: Uint8Array): Promise<string> {
    return Promise.resolve(new TextDecoder().decode(ciphertext).slice("sealed:".length));
  }

  encrypt(token: string): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(`sealed:${token}`));
  }

  isAvailable(): boolean {
    return true;
  }
}

describe("Agent onboarding", () => {
  it("atomically stores encrypted credentials and a readiness-capable safe projection", async () => {
    const fixture = await createRuntimeFixture();
    const discovery: AgentDiscovery = {
      validate: vi.fn().mockResolvedValue({ card, readiness: { supported: true, supportedActions: ["express", "sleep"] } }),
    };
    const service = new AgentOnboardingService({ clock: fixture.clock, discovery, ids: fixture.ids, store: fixture.database.store, vault: new FakeVault() });
    try {
      const connection = await service.onboard({ cardUrl: card.cardUrl, token: "top-secret-bearer" });
      expect(connection).toMatchObject({ name: "主 Agent", readiness: true, status: "ACTIVE" });
      expect(JSON.stringify(connection)).not.toMatch(/top-secret|agent\.lan/);
      const persisted = fixture.database.transaction((database) => database.prepare(`
        SELECT c.encrypted_blob, a.credential_version
          FROM agent_credentials c JOIN agent_connections a ON a.credential_id = c.credential_id
         WHERE a.agent_connection_id = ?`).get(connection.agentConnectionId)) as Record<string, unknown>;
      expect(new TextDecoder().decode(persisted.encrypted_blob as Uint8Array)).toBe("sealed:top-secret-bearer");
      expect(persisted.credential_version).toBe(1);

      const duplicate = await service.onboard({ cardUrl: card.cardUrl, token: "rotated-secret" });
      expect(duplicate.agentConnectionId).toBe(connection.agentConnectionId);
      expect((await fixture.agents.list())).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("keeps standard A2A Agents collaborator-only and fences sensitive Card drift", async () => {
    const fixture = await createRuntimeFixture();
    let result = { card, readiness: { supported: false, supportedActions: [] } };
    const discovery: AgentDiscovery = { validate: vi.fn(() => Promise.resolve(result)) };
    const service = new AgentOnboardingService({ clock: fixture.clock, discovery, ids: fixture.ids, store: fixture.database.store, vault: new FakeVault() });
    try {
      const connection = await service.onboard({ cardUrl: card.cardUrl, token: "secret" });
      expect(connection.status).toBe("COLLABORATOR_ONLY");
      result = { ...result, card: { ...card, cardHash: "b".repeat(64), origin: "http://other-agent.lan", rpcUrl: "http://other-agent.lan/rpc" } };
      await expect(service.refresh(connection.agentConnectionId)).resolves.toMatchObject({ status: "RECONFIRM_REQUIRED" });
      await expect(service.rotateToken(connection.agentConnectionId, "new-secret")).rejects.toMatchObject({ code: "agent_reconfirm_required" });
    } finally {
      await fixture.close();
    }
  });

  it("refuses plaintext fallback when secure credential storage is unavailable", async () => {
    const fixture = await createRuntimeFixture();
    const vault = new FakeVault();
    vi.spyOn(vault, "isAvailable").mockReturnValue(false);
    const service = new AgentOnboardingService({
      clock: fixture.clock,
      discovery: { validate: vi.fn().mockResolvedValue({ card, readiness: { supported: true, supportedActions: [] } }) },
      ids: fixture.ids,
      store: fixture.database.store,
      vault,
    });
    try {
      await expect(service.onboard({ cardUrl: card.cardUrl, token: "secret" })).rejects.toMatchObject({ code: "credential_storage_unavailable" });
      vi.spyOn(vault, "isAvailable").mockReturnValue(true);
      await expect(service.onboard({ cardUrl: card.cardUrl, token: " " })).rejects.toMatchObject({ code: "agent_auth_failed" });
    } finally {
      await fixture.close();
    }
  });

  it("refreshes, rotates and disables a confirmed connection without exposing credentials", async () => {
    const fixture = await createRuntimeFixture();
    let currentCard = card;
    const discovery: AgentDiscovery = {
      validate: vi.fn(() => Promise.resolve({ card: currentCard, readiness: { supported: true, supportedActions: ["express"] } })),
    };
    const vault = new FakeVault();
    const service = new AgentOnboardingService({ clock: fixture.clock, discovery, ids: fixture.ids, store: fixture.database.store, vault });
    try {
      const original = await service.onboard({ cardUrl: card.cardUrl, token: "secret-v1" });
      expect(await service.refresh(original.agentConnectionId)).toMatchObject({ credentialVersion: 1, status: "ACTIVE" });
      expect(await service.rotateToken(original.agentConnectionId, "secret-v2")).toMatchObject({ credentialVersion: 2, status: "ACTIVE" });
      expect(await service.disable(original.agentConnectionId)).toMatchObject({ status: "DISABLED" });
      expect(await service.enable(original.agentConnectionId)).toMatchObject({ status: "ACTIVE" });
      await service.disable(original.agentConnectionId);

      vi.spyOn(vault, "isAvailable").mockReturnValue(false);
      await expect(service.rotateToken(original.agentConnectionId, "secret-v3")).rejects.toMatchObject({ code: "credential_storage_unavailable" });
      currentCard = { ...card, rpcUrl: "http://agent.lan/changed-rpc" };
      vi.spyOn(vault, "isAvailable").mockReturnValue(true);
      await expect(service.refresh(original.agentConnectionId)).resolves.toMatchObject({ status: "RECONFIRM_REQUIRED" });
    } finally {
      await fixture.close();
    }
  });

  it("reports Life bindings and deletes only an unbound, idle local connection", async () => {
    const fixture = await createRuntimeFixture();
    const validate = vi.fn().mockResolvedValue({ card, readiness: { supported: true, supportedActions: ["express"] } });
    const discovery: AgentDiscovery = { validate };
    const service = new AgentOnboardingService({ clock: fixture.clock, discovery, ids: fixture.ids, store: fixture.database.store, vault: new FakeVault() });
    try {
      const original = await service.onboard({ cardUrl: card.cardUrl, token: "secret" });
      const life = await fixture.lives.create({
        mainAgentConnectionId: original.agentConnectionId, name: "绑定生命", personaSummary: "删除保护", timezone: "UTC",
      });
      expect(await service.deletionImpact(original.agentConnectionId)).toMatchObject({
        activeInvocations: 0,
        bindings: [{ lifeId: life.lifeId, name: "绑定生命", role: "PRIMARY" }],
      });
      await expect(service.delete(original.agentConnectionId)).rejects.toMatchObject({ code: "agent_still_bound" });

      await fixture.database.store.setLifeState(life.lifeId, "PAUSED", fixture.clock.now().toISOString());
      const replacementCard = { ...card, cardHash: "d".repeat(64), cardUrl: `${card.cardUrl}?replacement=1`, cardUrlHash: "e".repeat(64), name: "替代 Agent" };
      validate.mockResolvedValue({ card: replacementCard, readiness: { supported: true, supportedActions: ["express"] } });
      const replacement = await service.onboard({ cardUrl: replacementCard.cardUrl, token: "replacement-secret" });
      await fixture.lives.changePrimaryAgent(life.lifeId, replacement.agentConnectionId);
      expect((await service.deletionImpact(original.agentConnectionId)).bindings).toEqual([]);

      await service.delete(original.agentConnectionId);
      expect(await fixture.agents.list()).toEqual([expect.objectContaining({ agentConnectionId: replacement.agentConnectionId })]);
      await expect(service.deletionImpact(original.agentConnectionId)).rejects.toMatchObject({ code: "agent_not_found" });
      const credentials = fixture.database.transaction((database) => database.prepare("SELECT COUNT(*) AS count FROM agent_credentials").get()) as { count: number };
      expect(credentials.count).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("reports missing Agent records for refresh, rotation and disable", async () => {
    const fixture = await createRuntimeFixture();
    const service = new AgentOnboardingService({
      clock: fixture.clock,
      discovery: { validate: vi.fn().mockResolvedValue({ card, readiness: { supported: true, supportedActions: [] } }) },
      ids: fixture.ids,
      store: fixture.database.store,
      vault: new FakeVault(),
    });
    try {
      await expect(service.refresh("agent_missing")).rejects.toMatchObject({ code: "agent_not_found" });
      await expect(service.rotateToken("agent_missing", "secret")).rejects.toMatchObject({ code: "agent_not_found" });
      await expect(service.disable("agent_missing")).rejects.toMatchObject({ code: "agent_not_found" });
      await expect(service.enable("agent_missing")).rejects.toMatchObject({ code: "agent_not_found" });
      await expect(service.delete("agent_missing")).rejects.toMatchObject({ code: "agent_not_found" });
    } finally {
      await fixture.close();
    }
  });
});
