export const LOCAL_DISPATCH_CAPACITY_REASONS = {
  global: "local_dispatch_global_capacity",
  partner: "local_dispatch_partner_capacity",
} as const;

export type LocalDispatchCapacityReason = typeof LOCAL_DISPATCH_CAPACITY_REASONS[keyof typeof LOCAL_DISPATCH_CAPACITY_REASONS];

/** Process-wide capacity for local execution. Reservations are keyed by dispatch attempt. */
export class LocalDispatchCapacityController {
  readonly #attempts = new Map<string, string>();

  constructor(private readonly limits: { global?: number; perPartner?: number } = {}) {}

  reserve(input: { dispatchAttemptId: string; partnerId: string }): { acquired: true } | { acquired: false; reasonCode: LocalDispatchCapacityReason } {
    if (this.#attempts.has(input.dispatchAttemptId)) return { acquired: true };
    const globalLimit = this.limits.global ?? 8;
    const partnerLimit = this.limits.perPartner ?? 4;
    if (this.#attempts.size >= globalLimit) return { acquired: false, reasonCode: LOCAL_DISPATCH_CAPACITY_REASONS.global };
    let partnerCount = 0;
    for (const partnerId of this.#attempts.values()) if (partnerId === input.partnerId) partnerCount += 1;
    if (partnerCount >= partnerLimit) return { acquired: false, reasonCode: LOCAL_DISPATCH_CAPACITY_REASONS.partner };
    this.#attempts.set(input.dispatchAttemptId, input.partnerId);
    return { acquired: true };
  }

  release(dispatchAttemptId: string): void {
    this.#attempts.delete(dispatchAttemptId);
  }

  snapshot(): { global: number; partners: Record<string, number> } {
    const partners: Record<string, number> = {};
    for (const partnerId of this.#attempts.values()) partners[partnerId] = (partners[partnerId] ?? 0) + 1;
    return { global: this.#attempts.size, partners };
  }
}
