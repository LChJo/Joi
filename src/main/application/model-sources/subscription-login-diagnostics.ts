import type { Clock } from "../ports/runtime-store.js";
import type { SubscriptionLoginFacts, SubscriptionLoginStageEvent } from "../ports/model-source-ports.js";
import { maskEmail, subscriptionLoginReasonCode } from "../ports/runtime-diagnostics.js";
import type { AntigravityLoginStageDto, AntigravityLoginDiagnosticsDto, AntigravityRevocationDto } from "../../../shared/joi.js";

export { maskEmail, subscriptionLoginReasonCode };

export type SubscriptionLoginAttemptOutcome = AntigravityLoginDiagnosticsDto["outcome"];

/** Outbound records share the renderer-facing DTO shapes; stage codes stay bounded ASCII. */
export type SubscriptionLoginStageRecord = AntigravityLoginStageDto;

export type SubscriptionLoginDiagnosticsDto = AntigravityLoginDiagnosticsDto;

export type CredentialRevocationTrigger = AntigravityRevocationDto["trigger"];

export type CredentialRevocationDto = AntigravityRevocationDto;

/** Attempt facts the authorization adapter reports; the raw email stays inside this process. */
export type { SubscriptionLoginFacts };

export interface SubscriptionLoginRecorder {
  record(event: SubscriptionLoginStageEvent): void;
  note(facts: SubscriptionLoginFacts): void;
  finish(outcome: Exclude<SubscriptionLoginAttemptOutcome, "in_progress">): void;
}

const REVOCATION_HISTORY_LIMIT = 5;

interface MutableAttempt {
  provider: string;
  attemptId?: string;
  startedAt: string;
  finishedAt?: string;
  outcome: SubscriptionLoginAttemptOutcome;
  stages: SubscriptionLoginStageRecord[];
  facts: SubscriptionLoginFacts;
  lastStageAt: number;
}

/**
 * In-memory, sanitized login-stage history: the most recent attempt per provider and a bounded
 * ring of credential revocations. Every outgoing value is constructed field by field from bounded
 * facts — provider text, credentials and paths never pass through.
 */
export class SubscriptionLoginDiagnostics {
  readonly #attempts = new Map<string, MutableAttempt>();
  readonly #revocations: CredentialRevocationDto[] = [];

  constructor(private readonly clock: Clock) {}

  start(provider: string, attemptId?: string): SubscriptionLoginRecorder {
    const started = this.clock.now();
    const attempt: MutableAttempt = {
      provider,
      ...(attemptId === undefined ? {} : { attemptId }),
      startedAt: started.toISOString(),
      outcome: "in_progress",
      stages: [],
      facts: {},
      lastStageAt: started.getTime(),
    };
    this.#attempts.set(provider, attempt);
    return {
      record: (event) => this.#record(attempt, event),
      note: (facts) => { attempt.facts = { ...attempt.facts, ...facts }; },
      finish: (outcome) => {
        if (attempt.outcome === "in_progress") {
          attempt.outcome = outcome;
          attempt.finishedAt = this.clock.now().toISOString();
        }
      },
    };
  }

  latest(provider: string): SubscriptionLoginDiagnosticsDto | undefined {
    const attempt = this.#attempts.get(provider);
    if (attempt === undefined) return undefined;
    const facts = attempt.facts;
    return {
      provider: attempt.provider,
      ...(attempt.attemptId === undefined ? {} : { attemptId: attempt.attemptId }),
      startedAt: attempt.startedAt,
      ...(attempt.finishedAt === undefined ? {} : { finishedAt: attempt.finishedAt }),
      outcome: attempt.outcome,
      stages: attempt.stages.map((stage) => ({ ...stage })),
      ...(facts.accountEmail === undefined ? {} : { accountEmail: maskEmail(facts.accountEmail) }),
      ...(facts.grantedScopes === undefined || facts.grantedScopes.length === 0 ? {} : { grantedScopes: [...facts.grantedScopes] }),
      ...(facts.missingScopes === undefined || facts.missingScopes.length === 0 ? {} : { missingScopes: [...facts.missingScopes] }),
      ...(facts.clientSource === undefined ? {} : { clientSource: facts.clientSource }),
    };
  }

  recordRevocation(entry: Omit<CredentialRevocationDto, "at">): void {
    this.#revocations.push({ ...entry, at: this.clock.now().toISOString() });
    if (this.#revocations.length > REVOCATION_HISTORY_LIMIT) this.#revocations.splice(0, this.#revocations.length - REVOCATION_HISTORY_LIMIT);
  }

  revocations(): CredentialRevocationDto[] {
    return this.#revocations.map((entry) => ({ ...entry }));
  }

  #record(attempt: MutableAttempt, event: SubscriptionLoginStageEvent): void {
    const now = this.clock.now().getTime();
    attempt.stages.push({
      stage: event.stage,
      outcome: event.outcome,
      ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
      at: new Date(now).toISOString(),
      latencyMs: Math.max(0, now - attempt.lastStageAt),
    });
    attempt.lastStageAt = now;
  }
}
