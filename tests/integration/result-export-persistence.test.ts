import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRuntimeDatabaseFixture } from '../support/runtime-database-fixture.js';
import { SqliteResultExports } from '../../src/main/infrastructure/persistence/sqlite-result-exports.js';

it('persists a private snapshot and exactly one outbox job across reopen and rejects key reuse', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'joi-export-test-'));
  const databasePath = path.join(root, 'test.sqlite');
  let database = await openRuntimeDatabaseFixture(databasePath);
  try {
    let jobs = new SqliteResultExports(database);
    const input = { goalId: 'goal', format: 'pdf' as const, body: '# Only final', title: 'title', digest: 'digest', idempotencyKey: 'stable' };
    const first = await jobs.create(input);
    expect(await jobs.create(input)).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('Only final');
    expect(database.transaction(c => c.prepare("SELECT count(*) AS n FROM outbox WHERE kind = 'result.export'").get())?.n).toBe(1);
    database.close(); database = await openRuntimeDatabaseFixture(databasePath); jobs = new SqliteResultExports(database);
    expect(await jobs.create(input)).toEqual(first);
    expect(jobs.record(first.exportId)?.body).toBe(input.body);
    await expect(jobs.create({ ...input, digest: 'changed' })).rejects.toThrow('export_idempotency_conflict');
    jobs.update(first.exportId, 'completed', ['result.pdf']);
    expect(await jobs.get(first.exportId)).toEqual({ exportId: first.exportId, status: 'completed', filenames: ['result.pdf'], count: 1 });
    expect(await jobs.get('missing')).toBeNull();
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

it('persists selected result identity across reopen and rejects idempotency reuse for another result with the same body', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'joi-history-export-test-'));
  const databasePath = path.join(root, 'test.sqlite');
  let database = await openRuntimeDatabaseFixture(databasePath);
  try {
    let jobs = new SqliteResultExports(database);
    const common = { goalId: 'goal', format: 'png' as const, body: '# Identical delivery', title: 'Synthetic', digest: 'same-digest', idempotencyKey: 'history-stable' };
    const input = { ...common, resultId: '1'.repeat(32) };
    database.transaction(db => {
      const now = '2026-11-02T00:00:00.000Z';
      db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,created_at,updated_at) VALUES ('goal','goal','Synthetic','CONSUMED',?,?)`).run(now, now);
      for (const resultId of [input.resultId, '2'.repeat(32)]) db.prepare(`INSERT INTO joi_goal_result_history
        (result_id,goal_input_id,source_key,completed_at,status,body) VALUES (?,'goal',?,?,'COMPLETED',?)`)
        .run(resultId, `turn:${resultId}`, now, input.body);
    });
    const first = await jobs.create(input);
    expect(await jobs.find(input)).toEqual(first);
    database.close(); database = await openRuntimeDatabaseFixture(databasePath); jobs = new SqliteResultExports(database);
    expect(await jobs.create(input)).toEqual(first);
    expect(jobs.record(first.exportId)?.body).toBe(input.body);
    for (const target of [{ ...common, resultId: '2'.repeat(32) }, common]) {
      await expect(jobs.find(target)).rejects.toThrow('export_idempotency_conflict');
      await expect(jobs.create(target)).rejects.toThrow('export_idempotency_conflict');
    }
    expect(database.transaction(c => c.prepare("SELECT count(*) AS n FROM outbox WHERE kind = 'result.export'").get())?.n).toBe(1);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
