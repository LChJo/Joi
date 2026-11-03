/* DNS test doubles intentionally resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { ModelSourceNetworkPolicy } from "../../src/main/infrastructure/pi/model-source-network-policy.js";

describe("generic-model-source-network-policy", () => {
  it("allows public HTTPS and the two explicit local forms", async () => {
    const policy = new ModelSourceNetworkPolicy({
      resolve: async (hostname) => ({
        "models.example": ["8.8.8.8"],
        localhost: ["127.0.0.1"],
      })[hostname] ?? [],
    });
    await expect(policy.validate("https://models.example/v1")).resolves.toMatchObject({ origin: "https://models.example" });
    await expect(policy.validate("http://localhost:11434/v1")).resolves.toMatchObject({ local: true });
    await expect(policy.validate("http://127.0.0.1:8080/v1")).resolves.toMatchObject({ local: true });
  });

  it.each([
    "http://models.example/v1",
    "https://user:secret@models.example/v1",
    "https://100.64.0.1/v1",
    "http://172.32.0.1/v1",
    "http://172.15.255.254/v1",
    "http://192.167.1.2/v1",
    "http://user:secret@10.0.0.2/v1",
    "ftp://10.0.0.2/v1",
    "https://192.169.0.1/v1?key=secret",
    "https://169.254.169.254/latest/meta-data",
    "http://127.0.0.2/v1",
    "http://[::1]/v1",
  ])("rejects prohibited generic endpoint %s", async (endpoint) => {
    const policy = new ModelSourceNetworkPolicy({ resolve: async () => ["10.0.0.2"] });
    await expect(policy.validate(endpoint)).rejects.toMatchObject({ code: "model_source_url_prohibited" });
  });

  it.each([
    "http://10.30.208.181:34567",
    "https://10.0.0.2/v1",
    "http://172.16.0.1:8080/v1",
    "https://172.31.255.254/v1",
    "http://192.168.1.2:11434/v1",
  ])("allows an explicitly configured RFC1918 endpoint without treating it as keyless localhost: %s", async (endpoint) => {
    const resolve = vi.fn(async () => ["8.8.8.8"]);
    const policy = new ModelSourceNetworkPolicy({ resolve });
    const approved = await policy.validate(endpoint);
    expect(approved).toMatchObject({ local: false, origin: new URL(endpoint).origin });
    expect(resolve).not.toHaveBeenCalled();
    await expect(policy.revalidateConnection(approved)).resolves.toEqual(approved);
    await expect(policy.validateRedirect({ approved, location: "/v1/messages" })).resolves.toMatchObject({ origin: approved.origin });
    await expect(policy.validateRedirect({ approved, location: "http://192.168.1.3/v1/messages" }))
      .rejects.toMatchObject({ code: "model_source_redirect_cross_origin" });
    await expect(policy.validateRedirect({ approved, location: "http://169.254.169.254/latest/meta-data" }))
      .rejects.toMatchObject({ code: "model_source_url_prohibited" });
  });

  it.each(["http://models.example/v1", "https://models.example/v1"])("requires an explicit IP for a LAN endpoint: %s", async (endpoint) => {
    const policy = new ModelSourceNetworkPolicy({ resolve: async () => ["10.30.208.181"] });
    await expect(policy.validate(endpoint)).rejects.toMatchObject({ code: "model_source_url_prohibited" });
  });

  it("rejects cross-origin redirects and DNS rebinding before connection", async () => {
    let resolution = ["8.8.8.8"];
    const policy = new ModelSourceNetworkPolicy({ resolve: async () => resolution });
    const approved = await policy.validate("https://models.example/v1");
    await expect(policy.validateRedirect({ approved, location: "/v1/chat/completions" })).resolves.toMatchObject({
      origin: "https://models.example",
    });
    await expect(policy.validateRedirect({ approved, location: "https://other.example/v1" }))
      .rejects.toMatchObject({ code: "model_source_redirect_cross_origin" });

    resolution = ["192.168.1.8"];
    await expect(policy.revalidateConnection(approved)).rejects.toMatchObject({ code: "model_source_url_prohibited" });
  });
});
