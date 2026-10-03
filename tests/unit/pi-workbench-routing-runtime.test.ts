/* Pi faux providers resolve immediately in these adapter tests. */
/* eslint-disable @typescript-eslint/require-await */
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

import { PiWorkbenchRoutingRuntime } from "../../src/main/infrastructure/pi/pi-workbench-routing-runtime.js";

let captureSerial = 0;

/** Runs one decision and returns the request the adapter actually sent. */
async function capturedRequest(
  decide: (runtime: PiWorkbenchRoutingRuntime) => Promise<unknown>,
  response: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number],
): Promise<string> {
  captureSerial += 1;
  const faux = fauxProvider({ provider: `capture-${String(captureSerial)}` });
  let captured = "";
  faux.setResponses([(context) => {
    captured = JSON.stringify(context);
    return response;
  }]);
  const models = createModels();
  models.setProvider(faux.provider);
  await decide(new PiWorkbenchRoutingRuntime({
    resolver: { resolve: async () => ({ model: faux.getModel(), models, thinkingLevel: "off" as const }) },
    sources: { selectInitial: async (turnId) => ({ modelId: "m", modelRevisionId: "mr", sourceId: "s", sourceRevisionId: "sr", turnId }) },
  }));
  return captured;
}

describe("Pi Workbench routing runtime", () => {
  it("tells the router to place the input in an existing Workbench before creating one", async () => {
    const request = await capturedRequest(
      async (runtime) => runtime.decide({
        workbenches: [{ workbenchId: "w1", name: "研究", scopeSummary: "技术研究", updatedAt: "2026-07-28T10:00:00.000Z" }],
        input: "继续研究这个方向",
        repair: false,
      }),
      fauxAssistantMessage([fauxToolCall("workbench_select", { action: "select", workbenchId: "w1" })], { stopReason: "toolUse" }),
    );
    expect(request).toContain("Select an existing one whenever its scope can hold the input; create one only when none can.");
    expect(request).toContain("Never copy the user's wording, or any run of it, into name, projectLabel or scopeSummary.");
    expect(request).not.toContain("Prefer creating a new Workbench for a distinct new goal");
  });

  it("asks the abstract pass for a cluster name and offers it no way to select one", async () => {
    const request = await capturedRequest(
      async (runtime) => runtime.decide({
        workbenches: [{ workbenchId: "w1", name: "研究", scopeSummary: "技术研究", updatedAt: "2026-07-28T10:00:00.000Z" }],
        input: "民宿周边有哪些景点值得去",
        mode: "abstract",
        repair: false,
      }),
      fauxAssistantMessage([fauxToolCall("workbench_create", {
        action: "create", name: "行程规划工坊", personaSummary: "先确认约束。", projectLabel: "行程规划", scopeSummary: "目的地资料整理。",
      })], { stopReason: "toolUse" }),
    );
    expect(request).toContain("Name the durable work cluster it belongs to.");
    expect(request).toContain("workbench_create");
    expect(request).not.toContain("workbench_select");
  });

  it("uses a constrained workbench_select tool and returns only its structured arguments", async () => {
    const faux = fauxProvider({ provider: "routing-provider" });
    faux.setResponses([fauxAssistantMessage([
      fauxToolCall("workbench_select", { action: "select", workbenchId: "workbench_research" }),
    ], { stopReason: "toolUse" })]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiWorkbenchRoutingRuntime({
      resolver: { resolve: async () => ({ model: faux.getModel(), models, thinkingLevel: "off" as const }) },
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
      resolver: { resolve: async () => ({ model: faux.getModel(), models, thinkingLevel: "off" as const }) },
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
