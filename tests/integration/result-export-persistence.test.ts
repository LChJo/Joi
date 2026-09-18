import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRuntimeDatabase } from '../../src/main/infrastructure/persistence/runtime-database.js';
import { SqliteResultExports } from '../../src/main/infrastructure/persistence/sqlite-result-exports.js';

it('persists a private snapshot and exactly one outbox job across reopen and rejects key reuse', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'joi-export-test-'));
  const options = { databasePath: path.join(root, 'test.sqlite'), migrationsDirectory: path.resolve('resources/migrations') };
  let database = await openRuntimeDatabase(options);
  try {
    let jobs = new SqliteResultExports(database);
    const input = { goalId: 'goal', format: 'pdf' as const, body: '# Only final', title: 'title', digest: 'digest', idempotencyKey: 'stable' };
    const first = await jobs.create(input);
    expect(await jobs.create(input)).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('Only final');
    expect(database.transaction(c => c.prepare("SELECT count(*) AS n FROM outbox WHERE kind = 'result.export'").get())?.n).toBe(1);
    database.close(); database = await openRuntimeDatabase(options); jobs = new SqliteResultExports(database);
    expect(await jobs.create(input)).toEqual(first);
    expect(jobs.record(first.exportId)?.body).toBe(input.body);
    await expect(jobs.create({ ...input, digest: 'changed' })).rejects.toThrow('export_idempotency_conflict');
    jobs.update(first.exportId, 'completed', ['result.pdf']);
    expect(await jobs.get(first.exportId)).toEqual({ exportId: first.exportId, status: 'completed', filenames: ['result.pdf'], count: 1 });
    expect(await jobs.get('missing')).toBeNull();
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
