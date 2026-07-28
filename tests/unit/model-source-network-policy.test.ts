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
    "https://10.0.0.2/v1",
    "https://172.20.0.2/v1",
    "https://192.168.1.2/v1",
    "https://169.254.169.254/latest/meta-data",
    "http://127.0.0.2/v1",
    "http://[::1]/v1",
  ])("rejects prohibited generic endpoint %s", async (endpoint) => {
    const policy = new ModelSourceNetworkPolicy({ resolve: async () => ["10.0.0.2"] });
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
