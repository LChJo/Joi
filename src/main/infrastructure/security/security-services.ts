import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { AuthError } from "../../application/auth/auth-service.js";
import type {
  AdminCredentialRecord,
  BootstrapNonceStore,
  Clock,
  LoginRateLimit,
  PasswordDerivation,
  SecurityPrimitives,
} from "../../application/ports/runtime-store.js";

const FAILURE_LIMIT = 10;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;

export class InMemoryBootstrapNonceStore implements BootstrapNonceStore {
  private readonly expirations = new Map<string, number>();

  consume(nonce: string, now: Date): boolean {
    const expiration = this.expirations.get(nonce);
    this.expirations.delete(nonce);
    return expiration !== undefined && expiration > now.getTime();
  }

  issue(nonce: string, expiresAt: Date): void {
    this.expirations.set(nonce, expiresAt.getTime());
  }
}

interface FailureWindow {
  failures: number[];
  pausedUntil?: number;
}

export class LoginRateLimiter implements LoginRateLimit {
  private readonly sources = new Map<string, FailureWindow>();
  private readonly global: FailureWindow = { failures: [] };

  constructor(private readonly clock: Clock) {}

  assertAllowed(remoteAddress: string): void {
    const now = this.clock.now().getTime();
    const source = this.getSource(remoteAddress, now);
    this.trim(this.global, now);
    if ((source.pausedUntil ?? 0) > now || (this.global.pausedUntil ?? 0) > now) {
      throw new AuthError("login_rate_limited", "Too many login failures. Try again later.", 429);
    }
  }

  recordFailure(remoteAddress: string): void {
    const now = this.clock.now().getTime();
    const source = this.getSource(remoteAddress, now);
    this.trim(this.global, now);
    source.failures.push(now);
    this.global.failures.push(now);
    if (source.failures.length >= FAILURE_LIMIT) source.pausedUntil = now + FAILURE_WINDOW_MS;
    if (this.global.failures.length >= FAILURE_LIMIT) this.global.pausedUntil = now + FAILURE_WINDOW_MS;
  }

  reset(remoteAddress: string): void {
    this.sources.delete(remoteAddress);
    this.global.failures = [];
    delete this.global.pausedUntil;
  }

  private getSource(remoteAddress: string, now: number): FailureWindow {
    const current = this.sources.get(remoteAddress) ?? { failures: [] };
    this.trim(current, now);
    this.sources.set(remoteAddress, current);
    return current;
  }

  private trim(window: FailureWindow, now: number): void {
    window.failures = window.failures.filter((timestamp) => timestamp > now - FAILURE_WINDOW_MS);
    if ((window.pausedUntil ?? 0) <= now) delete window.pausedUntil;
  }
}

export class NodeSecurityPrimitives implements SecurityPrimitives {
  private readonly parameters: AdminCredentialRecord["parameters"];

  constructor(input: { scryptCost?: number } = {}) {
    this.parameters = {
      blockSize: 8,
      cost: input.scryptCost ?? 16_384,
      keyLength: 32,
      parallelization: 1,
    };
  }

  async derivePassword(password: string): Promise<PasswordDerivation> {
    const salt = randomBytes(16).toString("base64url");
    const derivedKey = await this.scrypt(password, salt, this.parameters);
    return { derivedKey: derivedKey.toString("base64url"), parameters: { ...this.parameters }, salt };
  }

  hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
  }

  async verifyPassword(password: string, credential: AdminCredentialRecord): Promise<boolean> {
    const actual = await this.scrypt(password, credential.salt, credential.parameters);
    const expected = Buffer.from(credential.derivedKey, "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  verifyToken(token: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hashToken(token));
    const expected = Buffer.from(expectedHash);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private scrypt(password: string, salt: string, parameters: AdminCredentialRecord["parameters"]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scrypt(password, salt, parameters.keyLength, {
        N: parameters.cost,
        p: parameters.parallelization,
        r: parameters.blockSize,
        maxmem: Math.max(32 * 1024 * 1024, 256 * parameters.cost * parameters.blockSize),
      }, (error, derivedKey) => {
        if (error !== null) reject(error);
        else resolve(derivedKey);
      });
    });
  }
}
