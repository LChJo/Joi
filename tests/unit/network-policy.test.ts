import { OutboundNetworkPolicy } from "../../src/main/infrastructure/a2a/outbound-network-policy";

function resolver(records: Record<string, string[]>) {
  return (hostname: string) => Promise.resolve(records[hostname] ?? []);
}

describe("A2A outbound network policy", () => {
  it("accepts explicit private HTTP and policy-checked public HTTPS", async () => {
    const policy = new OutboundNetworkPolicy({
      resolve: resolver({ "agent.lan": ["192.168.1.20"], "agent.example": ["8.8.8.8"] }),
    });
    await expect(policy.validate("http://agent.lan/a2a/card.json", { rejectQuery: true })).resolves.toMatchObject({
      origin: "http://agent.lan",
    });
    await expect(policy.validate("https://agent.example/card.json", { rejectQuery: true })).resolves.toMatchObject({
      origin: "https://agent.example",
    });
  });

  it("rejects credentials, fragments, public HTTP and dangerous resolved addresses", async () => {
    const policy = new OutboundNetworkPolicy({
      resolve: resolver({
        "link-local.test": ["169.254.169.254"],
        "mixed.test": ["192.168.1.30", "127.0.0.1"],
        "public.test": ["8.8.8.8"],
      }),
    });
    await expect(policy.validate("http://user:secret@mixed.test/card", { rejectQuery: true })).rejects.toMatchObject({ code: "agent_card_invalid" });
    await expect(policy.validate("http://mixed.test/card#secret", { rejectQuery: true })).rejects.toMatchObject({ code: "agent_card_invalid" });
    await expect(policy.validate("http://mixed.test/card?token=x", { rejectQuery: true })).rejects.toMatchObject({ code: "agent_card_invalid" });
    await expect(policy.validate("http://public.test/card", { rejectQuery: true })).rejects.toMatchObject({ code: "agent_card_invalid" });
    await expect(policy.validate("https://link-local.test/card", { rejectQuery: true })).rejects.toMatchObject({ code: "agent_card_invalid" });
    await expect(policy.validate("file:///tmp/card", { rejectQuery: true })).rejects.toMatchObject({ code: "agent_card_invalid" });
    await expect(policy.validate("not a url", { rejectQuery: true })).rejects.toMatchObject({ code: "agent_card_invalid" });
  });

  it("revalidates redirects and forbids Bearer forwarding across origins", async () => {
    const policy = new OutboundNetworkPolicy({ resolve: resolver({ "agent.lan": ["10.0.0.2"], "other.lan": ["10.0.0.3"] }) });
    await expect(policy.validateRedirect({
      bearerOrigin: "http://agent.lan",
      from: "http://agent.lan/a2a",
      location: "/a2a/v0.3",
    })).resolves.toMatchObject({ origin: "http://agent.lan" });
    await expect(policy.validateRedirect({
      bearerOrigin: "http://agent.lan",
      from: "http://agent.lan/a2a",
      location: "http://other.lan/a2a",
    })).rejects.toMatchObject({ code: "agent_reconfirm_required" });
  });
});
