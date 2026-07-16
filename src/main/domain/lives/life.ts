import { DomainError } from "../errors.js";

export const LIFE_STATES = [
  "BUDGET_PAUSED",
  "DEGRADED",
  "PAUSED",
  "QUEUED",
  "RUNNING",
  "SLEEPING",
  "STOPPED",
  "WAITING_USER",
] as const;

export type LifeState = (typeof LIFE_STATES)[number];

export interface Life {
  archivedAt?: string;
  autonomousWakesDefault: number;
  avatarUrl?: string;
  createdAt: string;
  currentPersonaVersionId: string;
  idleExplorationsDefault: number;
  initialGoal?: string;
  invocationsDefault: number;
  lifeId: string;
  mainAgentConnectionId: string;
  name: string;
  personaSummary: string;
  principles: string[];
  quietEnd: string;
  quietStart: string;
  role?: string;
  state: LifeState;
  timezone: string;
  updatedAt: string;
}

export interface CreateLifeInput {
  avatarUrl?: string;
  initialGoal?: string;
  mainAgentConnectionId: string;
  name: string;
  personaSummary: string;
  principles?: string[];
  role?: string;
  timezone: string;
}

export interface UpdateLifeInput {
  avatarUrl?: string | null;
  initialGoal?: string | null;
  name?: string;
  personaSummary?: string;
  principles?: string[];
  role?: string | null;
  timezone?: string;
}

function optionalText(value: string | null | undefined, maxLength: number, code: string) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new DomainError(code, `Value must not exceed ${String(maxLength)} characters.`);
  }
  return normalized === "" ? null : normalized;
}

function validateTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new DomainError("life_timezone_invalid", "Life timezone is invalid.");
  }
  return timezone;
}

function validatePrinciples(principles: string[] | undefined) {
  const normalized = (principles ?? []).map((principle) => principle.trim()).filter(Boolean);
  if (normalized.length > 20 || normalized.some((principle) => principle.length > 500)) {
    throw new DomainError("life_principles_invalid", "Life principles exceed the supported limits.");
  }
  return normalized;
}

export function validateCreateLife(input: CreateLifeInput): Required<Pick<CreateLifeInput, "mainAgentConnectionId" | "name" | "personaSummary" | "principles" | "timezone">> & Pick<CreateLifeInput, "avatarUrl" | "initialGoal" | "role"> {
  const name = input.name.trim();
  const personaSummary = input.personaSummary.trim();
  const mainAgentConnectionId = input.mainAgentConnectionId.trim();
  if (name.length === 0 || name.length > 80) {
    throw new DomainError("life_name_invalid", "Life name must contain 1 to 80 characters.");
  }
  if (personaSummary.length === 0 || personaSummary.length > 4000) {
    throw new DomainError("life_persona_invalid", "Life persona summary must contain 1 to 4000 characters.");
  }
  if (mainAgentConnectionId.length === 0) {
    throw new DomainError("life_primary_agent_required", "A primary Agent connection is required.");
  }

  const avatarUrl = optionalText(input.avatarUrl, 2048, "life_avatar_invalid");
  const initialGoal = optionalText(input.initialGoal, 4000, "life_initial_goal_invalid");
  const role = optionalText(input.role, 160, "life_role_invalid");
  return {
    mainAgentConnectionId,
    name,
    personaSummary,
    principles: validatePrinciples(input.principles),
    timezone: validateTimezone(input.timezone),
    ...(avatarUrl === undefined || avatarUrl === null ? {} : { avatarUrl }),
    ...(initialGoal === undefined || initialGoal === null ? {} : { initialGoal }),
    ...(role === undefined || role === null ? {} : { role }),
  };
}

export function validateUpdateLife(input: UpdateLifeInput): UpdateLifeInput {
  const output: UpdateLifeInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 80) throw new DomainError("life_name_invalid", "Life name must contain 1 to 80 characters.");
    output.name = name;
  }
  if (input.personaSummary !== undefined) {
    const summary = input.personaSummary.trim();
    if (summary.length === 0 || summary.length > 4000) throw new DomainError("life_persona_invalid", "Life persona summary must contain 1 to 4000 characters.");
    output.personaSummary = summary;
  }
  if (input.principles !== undefined) output.principles = validatePrinciples(input.principles);
  if (input.timezone !== undefined) output.timezone = validateTimezone(input.timezone);
  if (input.avatarUrl !== undefined) {
    const avatarUrl = optionalText(input.avatarUrl, 2048, "life_avatar_invalid");
    if (avatarUrl !== undefined) output.avatarUrl = avatarUrl;
  }
  if (input.initialGoal !== undefined) {
    const initialGoal = optionalText(input.initialGoal, 4000, "life_initial_goal_invalid");
    if (initialGoal !== undefined) output.initialGoal = initialGoal;
  }
  if (input.role !== undefined) {
    const role = optionalText(input.role, 160, "life_role_invalid");
    if (role !== undefined) output.role = role;
  }
  return output;
}
