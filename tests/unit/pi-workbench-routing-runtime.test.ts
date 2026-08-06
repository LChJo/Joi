/* Pi faux providers resolve immediately in these adapter tests. */
/* eslint-disable @typescript-eslint/require-await */
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

import { PiWorkbenchRoutingRuntime } from "../../src/main/infrastructure/pi/pi-workbench-routing-runtime.js";

describe("Pi Workbench routing runtime", () => {
  it("uses a constrained workbench_select tool and returns only its structured arguments", async () => {
    const faux = fauxProvider({ provider: "routing-provider" });
    faux.setResponses([fauxAssistantMessage([
      fauxToolCall("workbench_select", { action: "select", workbenchId: "workbench_research" }),
    ], { stopReason: "toolUse" })]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiWorkbenchRoutingRuntime({
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
      workbenches: [{ workbenchId: "workbench_research", name: "Research", scopeSummary: "Research only", updatedAt: "2026-07-28T10:00:00.000Z" }],
      input: "continue research",
      repair: false,
    })).resolves.toEqual({ action: "select", workbenchId: "workbench_research" });
  });

  it("can create the first Workbench and returns null for free text", async () => {
    const faux = fauxProvider({ provider: "routing-text-provider" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("workbench_create", {
        action: "create",
        name: "New work",
        personaSummary: "A focused context",
        projectLabel: "New project",
        scopeSummary: "New scope",
      })], { stopReason: "toolUse" }),
      fauxAssistantMessage([{ type: "text", text: "workbench_research" }]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const textOnly = new PiWorkbenchRoutingRuntime({
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
    });
    await expect(textOnly.decide({ workbenches: [], input: "new work", repair: false })).resolves.toEqual({
      action: "create",
      name: "New work",
      personaSummary: "A focused context",
      projectLabel: "New project",
      scopeSummary: "New scope",
    });
    await expect(textOnly.decide({
      workbenches: [{ workbenchId: "workbench_research", name: "Research", scopeSummary: "Research", updatedAt: "2026-07-28T10:00:00.000Z" }],
      input: "research",
      repair: true,
    })).resolves.toBeNull();
  });
});
