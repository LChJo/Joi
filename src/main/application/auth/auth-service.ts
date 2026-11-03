import type {
  AuthStore,
  BootstrapNonceStore,
  Clock,
  LoginRateLimit,
  SecurityPrimitives,
  WebSessionRecord,
} from "../ports/runtime-store.js";
import { ADMIN_PASSWORD_MIN_LENGTH } from "../../../shared/product.js";

const BOOTSTRAP_TTL_MS = 60_000;
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface SessionGrant {
  csrfToken: string;
  expiresAt: string;
  kind: "desktop" | "lan";
  sessionToken: string;
}

function isLoopback(address: string) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isLoopbackOrigin(origin: string) {
  if (origin === "null") return true;
  try {
    return isLoopback(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export class AuthService {
  constructor(private readonly dependencies: {
    clock: Clock;
    nonces: BootstrapNonceStore;
    rateLimiter: LoginRateLimit;
    security: SecurityPrimitives;
    store: AuthStore;
  }) {}

  issueDesktopBootstrap() {
    const nonce = this.dependencies.security.randomToken(32);
    const expiresAt = new Date(this.dependencies.clock.now().getTime() + BOOTSTRAP_TTL_MS);
    this.dependencies.nonces.issue(nonce, expiresAt);
    return Promise.resolve({ expiresAt: expiresAt.toISOString(), nonce });
  }

  async exchangeDesktopBootstrap(input: { nonce: string; remoteAddress: string }) {
    if (!isLoopback(input.remoteAddress) || !this.dependencies.nonces.consume(input.nonce, this.dependencies.clock.now())) {
      throw new AuthError("bootstrap_invalid", "Desktop bootstrap is invalid or expired.");
    }
    return this.createSession("desktop", input.remoteAddress);
  }

  async isConfigured() {
    return (await this.dependencies.store.getAdminCredential()) !== null;
  }

  async setupPassword(input: {
    csrfToken: string;
    origin: string;
    password: string;
    remoteAddress: string;
    sessionToken: string;
  }) {
    const session = await this.verifyWrite({ ...input, expectedOrigin: "null" });
    if (session.kind !== "desktop") throw new AuthError("desktop_required", "Initial setup requires a desktop session.", 403);
    if (input.password.length < ADMIN_PASSWORD_MIN_LENGTH) {
      throw new AuthError("password_too_short", `Administrator password must contain at least ${String(ADMIN_PASSWORD_MIN_LENGTH)} characters.`, 400);
    }
    if (await this.isConfigured()) throw new AuthError("admin_already_configured", "Administrator password is already configured.", 409);
    const derived = await this.dependencies.security.derivePassword(input.password);
    await this.dependencies.store.saveAdminCredential({ algorithm: "scrypt", updatedAt: this.dependencies.clock.now().toISOString(), ...derived });
  }

  async login(input: {
    expectedOrigin: string;
    origin: string;
    password: string;
    remoteAddress: string;
  }) {
    if (input.origin !== input.expectedOrigin) throw new AuthError("origin_invalid", "Request Origin is not allowed.", 403);
    this.dependencies.rateLimiter.assertAllowed(input.remoteAddress);
    const credential = await this.dependencies.store.getAdminCredential();
    const valid = credential !== null && await this.dependencies.security.verifyPassword(input.password, credential);
    if (!valid) {
      this.dependencies.rateLimiter.recordFailure(input.remoteAddress);
      throw new AuthError("login_invalid", "Administrator password is invalid.");
    }
    this.dependencies.rateLimiter.reset(input.remoteAddress);
    return this.createSession("lan", input.remoteAddress);
  }

  async authenticate(sessionToken: string) {
    const now = this.dependencies.clock.now();
    await this.dependencies.store.deleteExpiredSessions(now.toISOString());
    const sessionHash = this.dependencies.security.hashToken(sessionToken);
    const session = await this.dependencies.store.getSession(sessionHash);
    if (session === null || session.revokedAt !== undefined || Date.parse(session.idleExpiresAt) <= now.getTime() || Date.parse(session.absoluteExpiresAt) <= now.getTime()) {
      throw new AuthError("session_invalid", "Session is missing or expired.");
    }
    const idleExpiresAt = new Date(Math.min(now.getTime() + SESSION_IDLE_MS, Date.parse(session.absoluteExpiresAt))).toISOString();
    await this.dependencies.store.touchSession(sessionHash, now.toISOString(), idleExpiresAt);
    return { ...session, idleExpiresAt, lastActivityAt: now.toISOString() };
  }

  async verifyWrite(input: {
    csrfToken: string;
    expectedOrigin: string;
    origin: string;
    remoteAddress: string;
    sessionToken: string;
  }) {
    const session = await this.authenticate(input.sessionToken);
    if (session.kind === "desktop") {
      if (!isLoopbackOrigin(input.origin) || !isLoopback(input.remoteAddress)) throw new AuthError("origin_invalid", "Desktop request Origin is not allowed.", 403);
    } else if (input.origin !== input.expectedOrigin) {
      throw new AuthError("origin_invalid", "Request Origin is not allowed.", 403);
    }
    if (!this.dependencies.security.verifyToken(input.csrfToken, session.csrfHash)) {
      throw new AuthError("csrf_invalid", "CSRF token is invalid.", 403);
    }
    return session;
  }

  async logout(sessionToken: string) {
    await this.dependencies.store.revokeSession(
      this.dependencies.security.hashToken(sessionToken),
      this.dependencies.clock.now().toISOString(),
    );
  }

  async listSessions(sessionToken: string) {
    await this.authenticate(sessionToken);
    const currentHash = this.dependencies.security.hashToken(sessionToken);
    return (await this.dependencies.store.listSessions()).map((session) => ({
      createdAt: session.createdAt,
      current: session.sessionHash === currentHash,
      deviceId: session.sessionHash.slice(0, 12),
      ipSummary: session.ipHash.slice(0, 12),
      kind: session.kind,
      lastActivityAt: session.lastActivityAt,
    }));
  }

  async changePassword(input: {
    csrfToken: string;
    currentPassword: string;
    expectedOrigin: string;
    newPassword: string;
    origin: string;
    remoteAddress: string;
    sessionToken: string;
  }) {
    await this.verifyWrite(input);
    if (input.newPassword.length < ADMIN_PASSWORD_MIN_LENGTH) {
      throw new AuthError("password_too_short", `Administrator password must contain at least ${String(ADMIN_PASSWORD_MIN_LENGTH)} characters.`, 400);
    }
    const credential = await this.dependencies.store.getAdminCredential();
    if (credential === null || !await this.dependencies.security.verifyPassword(input.currentPassword, credential)) {
      throw new AuthError("password_invalid", "Current administrator password is invalid.", 403);
    }
    const derived = await this.dependencies.security.derivePassword(input.newPassword);
    const now = this.dependencies.clock.now().toISOString();
    await this.dependencies.store.saveAdminCredential({ algorithm: "scrypt", updatedAt: now, ...derived });
    await this.dependencies.store.revokeAllLanSessions(now);
  }

  async revokeAllLanSessions() {
    await this.dependencies.store.revokeAllLanSessions(this.dependencies.clock.now().toISOString());
  }

  private async createSession(kind: "desktop" | "lan", remoteAddress: string): Promise<SessionGrant> {
    const now = this.dependencies.clock.now();
    const sessionToken = this.dependencies.security.randomToken(32);
    const csrfToken = this.dependencies.security.randomToken(24);
    const absoluteExpiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS).toISOString();
    const record: WebSessionRecord = {
      absoluteExpiresAt,
      createdAt: now.toISOString(),
      csrfHash: this.dependencies.security.hashToken(csrfToken),
      idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_MS).toISOString(),
      ipHash: this.dependencies.security.hashToken(remoteAddress),
      kind,
      lastActivityAt: now.toISOString(),
      sessionHash: this.dependencies.security.hashToken(sessionToken),
    };
    await this.dependencies.store.saveSession(record);
    return { csrfToken, expiresAt: absoluteExpiresAt, kind, sessionToken };
  }
}
