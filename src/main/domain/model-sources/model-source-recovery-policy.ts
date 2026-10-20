const TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  "connection_error", "endpoint_unreachable", "timeout", "server_error", "rate_limited",
]);

export function isTransientModelSourceFailure(reasonCode: string | undefined): boolean {
  return reasonCode !== undefined && TRANSIENT_REASONS.has(reasonCode);
}
