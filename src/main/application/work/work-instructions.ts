import { DomainError } from "../../domain/errors.js";

export const WORK_INSTRUCTIONS_MAX_CHARS = 12_000;

export function validWorkInstructions(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= WORK_INSTRUCTIONS_MAX_CHARS;
}

export function requireWorkInstructions(value: unknown): string {
  if (!validWorkInstructions(value)) {
    throw new DomainError("work_instructions_invalid", "Provide self-contained task instructions between 1 and 12000 characters, including the relevant current requirements.");
  }
  return value;
}
