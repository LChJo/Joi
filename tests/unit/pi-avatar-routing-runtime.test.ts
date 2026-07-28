/* Pi faux providers resolve immediately in these adapter tests. */
/* eslint-disable @typescript-eslint/require-await */
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

import { PiAvatarRoutingRuntime } from "../../src/main/infrastructure/pi/pi-avatar-routing-runtime.js";

describe("Pi Avatar routing runtime", () => {
  it("uses a constrained avatar.select tool and returns only its structured arguments", async () => {
    const faux = fauxProvider({ provider: "routing-provider" });
    faux.setResponses([fauxAssistantMessage([
      fauxToolCall("avatar.select", { action: "select", avatarId: "avatar_research" }),
    ], { stopReason: "toolUse" })]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiAvatarRoutingRuntime({
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      sources: {
        selectInitial: async (turnId) => ({
          modelId: "routing-model",
          modelRevisionId: "model_revision_1",
          sourceId: "source_1",
          sourceRevisionId: "source_revision_1",
          turnId,
        }),
      },
    });

    await expect(runtime.decide({
      avatars: [{ avatarId: "avatar_research", name: "Research", scopeSummary: "Research only", updatedAt: "2026-07-28T10:00:00.000Z" }],
      input: "continue research",
      repair: false,
    })).resolves.toEqual({ action: "select", avatarId: "avatar_research" });
  });

  it("can create the first Avatar and returns null for free text", async () => {
    const faux = fauxProvider({ provider: "routing-text-provider" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("avatar.create", {
        action: "create",
        name: "New work",
        personaSummary: "A focused context",
        projectLabel: "New project",
        scopeSummary: "New scope",
      })], { stopReason: "toolUse" }),
      fauxAssistantMessage([{ type: "text", text: "avatar_research" }]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const textOnly = new PiAvatarRoutingRuntime({
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
    });
    await expect(textOnly.decide({ avatars: [], input: "new work", repair: false })).resolves.toEqual({
      action: "create",
      name: "New work",
      personaSummary: "A focused context",
      projectLabel: "New project",
      scopeSummary: "New scope",
    });
    await expect(textOnly.decide({
      avatars: [{ avatarId: "avatar_research", name: "Research", scopeSummary: "Research", updatedAt: "2026-07-28T10:00:00.000Z" }],
      input: "research",
      repair: true,
    })).resolves.toBeNull();
  });
});
