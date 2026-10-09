import type { JoiGoalCardDto, JoiHomeFeedDto } from "../../src/shared/joi.js";
import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { createApiHandler } from "../../src/main/interfaces/http/api-handler.js";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

function cookieFrom(response: Response) {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("missing session cookie");
  return value.split(";", 1)[0] ?? "";
}

/**
 * The archive feature over its real surface.
 *
 * Route plumbing alone would not catch what matters here: that `archivedAt` survives the migration,
 * the repository write, and the home-feed projection both clients partition on — and that
 * unarchiving puts the card back. So this drives the real SQLite runtime rather than a stub service.
 */
async function startSession() {
  const fixture = await createRuntimeFixture();
  const repository = new SqliteJoiInboxRepository(fixture.database);
  const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
  const listeners = await startRuntimeListeners({ handler: createApiHandler(Object.assign({}, fixture, { joiInbox: inbox })), loopbackPort: 0 });
  const bootstrap = await fixture.auth.issueDesktopBootstrap();
  const authenticated = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
    body: JSON.stringify({ nonce: bootstrap.nonce }),
    headers: { "content-type": "application/json", origin: "null" },
    method: "POST",
  });
  const cookie = cookieFrom(authenticated);
  const { csrfToken } = await authenticated.json() as { csrfToken: string };
  const headers = { "content-type": "application/json", cookie, origin: "null", "x-csrf-token": csrfToken };
  return {
    async card(goalId: string): Promise<JoiGoalCardDto | undefined> {
      const feed = await (await fetch(`${listeners.loopback.url}/api/v1/joi/home-feed`, { headers })).json() as JoiHomeFeedDto;
      return feed.goals.find((goal) => goal.goalId === goalId);
    },
    async close() { await listeners.close(); await fixture.close(); },
    /** Accepts a goal and drives it to the terminal state archiving requires. */
    async goal(text: string, key: string): Promise<string> {
      const accepted = await inbox.accept({ idempotencyKey: key, text });
      await repository.completeInput(accepted.inputId, `turn-${key}`);
      return accepted.inputId;
    },
    /** Accepts a goal and leaves it queued, the one state archiving has to refuse. */
    async pending(text: string, key: string): Promise<string> {
      return (await inbox.accept({ idempotencyKey: key, text })).inputId;
    },
    post: (path: string) => fetch(`${listeners.loopback.url}${path}`, { body: "{}", headers, method: "POST" }),
  };
}

describe("joi archive HTTP route", () => {
  it("archives and unarchives a finished goal through the real runtime", async () => {
    const session = await startSession();
    try {
      const goalId = await session.goal("要归档的目标", "key-archive");
      const before = await session.card(goalId);
      expect(before?.archivedAt).toBeUndefined();
      // A goal with no finalized outcome is still archivable — this is the whole point of offering
      // archiving one step earlier than removal.
      expect(before?.canArchive).toBe(true);

      expect((await session.post(`/api/v1/joi/messages/${goalId}/archive`)).status).toBe(200);
      const archived = await session.card(goalId);
      expect(typeof archived?.archivedAt).toBe("string");

      expect((await session.post(`/api/v1/joi/messages/${goalId}/unarchive`)).status).toBe(200);
      expect((await session.card(goalId))?.archivedAt).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it("refuses to archive a goal that is still running", async () => {
    const session = await startSession();
    try {
      const goalId = await session.goal("已完成的目标", "key-live");
      // A queued input is not finished, and hiding it would take a running task off the feed.
      const queued = await session.pending("排队中的目标", "key-queued");
      const refused = await session.post(`/api/v1/joi/messages/${queued}/archive`);
      expect(refused.ok).toBe(false);
      expect(await refused.json()).toMatchObject({ code: "joi_archive_unavailable" });

      // A goal that never finished cannot be unarchived either — there is nothing to restore.
      const notArchived = await session.post(`/api/v1/joi/messages/${goalId}/unarchive`);
      expect(notArchived.ok).toBe(false);
      expect(await notArchived.json()).toMatchObject({ code: "joi_unarchive_unavailable" });
    } finally {
      await session.close();
    }
  });
});
