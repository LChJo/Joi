import { DomainError } from "../errors.js";
import type { LifeState } from "./life.js";

export type LifeCommand =
  | "ACTIONS_COMMITTED" | "BUDGET_EXHAUSTED" | "BUDGET_RESET" | "EVENT_AVAILABLE" | "FAIL_PROTOCOL"
  | "LEASE_ACQUIRED" | "PAUSE" | "REPAIR" | "RESUME" | "START" | "STOP" | "WAIT_USER";

const TRANSITIONS: Partial<Record<LifeState, Partial<Record<LifeCommand, LifeState>>>> = {
  BUDGET_PAUSED: { BUDGET_RESET: "QUEUED", PAUSE: "PAUSED", STOP: "STOPPED" },
  DEGRADED: { PAUSE: "PAUSED", REPAIR: "QUEUED", STOP: "STOPPED" },
  PAUSED: { RESUME: "QUEUED", STOP: "STOPPED" },
  QUEUED: { BUDGET_EXHAUSTED: "BUDGET_PAUSED", LEASE_ACQUIRED: "RUNNING", PAUSE: "PAUSED", STOP: "STOPPED" },
  RUNNING: { ACTIONS_COMMITTED: "SLEEPING", BUDGET_EXHAUSTED: "BUDGET_PAUSED", FAIL_PROTOCOL: "DEGRADED", WAIT_USER: "WAITING_USER" },
  SLEEPING: { BUDGET_EXHAUSTED: "BUDGET_PAUSED", EVENT_AVAILABLE: "QUEUED", PAUSE: "PAUSED", STOP: "STOPPED" },
  STOPPED: { START: "SLEEPING" },
  WAITING_USER: { EVENT_AVAILABLE: "QUEUED", PAUSE: "PAUSED", STOP: "STOPPED" },
};

export function transitionLifeState(state: LifeState, command: LifeCommand): LifeState {
  const next = TRANSITIONS[state]?.[command];
  if (next === undefined) throw new DomainError("life_transition_invalid", `Command ${command} is invalid while Life is ${state}.`);
  return next;
}
