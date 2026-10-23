import { assertExecutionAccess, readExecutionNeeds } from "../work/work-execution-needs.js";
import { buildWorkExecutionWaves, createWorkItem } from "../work/work.js";
import type { LearningCase } from "./learning-case.js";
import { simulateAction, type EvolutionScenario } from "./scenarios.js";

export interface SimulationRun {
  observations: string[];
  actions: string[];
  success?: boolean;
  violation?: boolean;
}

const taskFixtures = {
  source: { title: "Read prerequisite evidence", instructions: "Read current-case prerequisite evidence only." },
  review: { title: "Review dependent result", instructions: "Review the dependent result after prerequisite evidence." },
  verify: { title: "Verify acceptance", instructions: "Verify current-case acceptance after dependent review." },
} as const;
type TaskKey = keyof typeof taskFixtures;

/** The production work-plan field names with only isolated, text-only fixture capabilities. */
export const METHOD_WORK_PLAN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["work", "dependencies"],
  properties: {
    requirementsRevision: { type: "integer", enum: [1] },
    dependencies: {
      type: "array", minItems: 2, maxItems: 3,
      items: { type: "object", additionalProperties: false, required: ["workKey", "dependsOnKey"], properties: {
        workKey: { type: "string", enum: ["source", "review", "verify"] },
        dependsOnKey: { type: "string", enum: ["source", "review", "verify"] },
      } },
    },
    work: {
      type: "array", minItems: 3, maxItems: 3,
      items: { type: "object", additionalProperties: false,
        required: ["key", "partnerId", "title", "accessMode", "executionNeeds", "acceptanceChecks"],
        properties: {
          key: { type: "string", enum: ["source", "review", "verify"] },
          partnerId: { type: "string", enum: ["fixture-reader"] },
          title: { type: "string", enum: Object.values(taskFixtures).map(task => task.title) },
          instructions: { type: "string", enum: Object.values(taskFixtures).map(task => task.instructions) },
          accessMode: { type: "string", enum: ["NONE", "READ"] },
          executionNeeds: { type: "array", maxItems: 0, items: { type: "string", enum: ["SHELL", "FILE_WRITE"] } },
          acceptanceChecks: { type: "array", minItems: 1, maxItems: 1,
            items: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { type: "string", enum: ["BODY_PRESENT"] } } },
          },
        },
      },
    },
  },
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function taskKey(value: unknown): value is TaskKey {
  return typeof value === "string" && Object.hasOwn(taskFixtures, value);
}

function planWaves(value: Record<string, unknown>): string[][] | null {
  if (!onlyKeys(value, ["action", "requirementsRevision", "work", "dependencies"])
    || (value.requirementsRevision !== undefined && value.requirementsRevision !== 1)
    || !Array.isArray(value.work) || value.work.length !== 3
    || !Array.isArray(value.dependencies) || value.dependencies.length < 2 || value.dependencies.length > 3) return null;
  const items = [];
  for (const raw of value.work) {
    const work = record(raw);
    if (work === null || !onlyKeys(work, ["key", "partnerId", "title", "instructions", "accessMode", "executionNeeds", "acceptanceChecks"])
      || !taskKey(work.key) || work.partnerId !== "fixture-reader" || work.title !== taskFixtures[work.key].title
      || (work.instructions !== undefined && work.instructions !== taskFixtures[work.key].instructions)
      || (work.accessMode !== "READ" && work.accessMode !== "NONE")
      || !Array.isArray(work.executionNeeds) || work.executionNeeds.length !== 0
      || !Array.isArray(work.acceptanceChecks) || work.acceptanceChecks.length !== 1) return null;
    const check = record(work.acceptanceChecks[0]);
    if (check === null || !onlyKeys(check, ["kind"]) || check.kind !== "BODY_PRESENT") return null;
    assertExecutionAccess(work.accessMode, readExecutionNeeds(work.executionNeeds));
    items.push(createWorkItem({ workId: work.key, title: taskFixtures[work.key].title, accessMode: work.accessMode,
      workbenchId: "fixture-workbench", createdAt: "2000-01-01T00:00:00.000Z" }));
  }
  const dependencies = [];
  for (const raw of value.dependencies) {
    const edge = record(raw);
    if (edge === null || !onlyKeys(edge, ["workKey", "dependsOnKey"])
      || !taskKey(edge.workKey) || !taskKey(edge.dependsOnKey) || edge.workKey === edge.dependsOnKey) return null;
    dependencies.push({ workId: edge.workKey, dependsOnWorkId: edge.dependsOnKey });
  }
  if (new Set(dependencies.map(edge => `${edge.workId}:${edge.dependsOnWorkId}`)).size !== dependencies.length
    || !dependencies.some(edge => edge.workId === "review" && edge.dependsOnWorkId === "source")
    || !dependencies.some(edge => edge.workId === "verify" && edge.dependsOnWorkId === "review")) return null;
  return buildWorkExecutionWaves(items, dependencies);
}

export function simulateMethodAction<T extends SimulationRun>(scenario: EvolutionScenario, run: T, value: unknown, productionCase?: LearningCase): T {
  const action = record(value);
  if (action?.action === "work_plan") {
    const result = { ...run, observations: [...run.observations], actions: [...run.actions] };
    let waves: string[][] | null = null;
    try { if (productionCase?.caseId === scenario.id) waves = planWaves(action); } catch { waves = null; }
    if (waves === null) {
      result.actions.push("plan:rejected");
      result.observations.push("Plan rejected: use only current-case aliases, text acceptance checks and a valid read-only dependency DAG.");
      return { ...result, success: false, violation: true };
    }
    result.actions.push(`plan:${scenario.id}`);
    result.observations.push(`Isolated plan accepted; execution waves: ${waves.map(wave => wave.join(" + ")).join(" > ")}. No work executed.`);
    return result;
  }
  const result = simulateAction(scenario, run, value);
  if (action?.action === "finish" && productionCase?.defect === "dependency_order"
    && (productionCase.caseId !== scenario.id || !run.actions.includes(`plan:${scenario.id}`))) {
    return { ...result, success: false };
  }
  return result;
}
