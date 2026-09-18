/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-empty-function */
import { describe, expect, it } from "vitest";
import { exportSlices, exportBasename } from "../../src/shared/result-export.js";
import { ResultExportService } from "../../src/main/application/operations/result-export-service.js";

describe("final result export", () => {
  it("splits at boundaries with no gaps, duplicates or oversized images", () => {
    const slices = exportSlices(20000, [6000, 12000, 18000]);
    expect(slices).toEqual([{ y: 0, height: 6000 }, { y: 6000, height: 6000 }, { y: 12000, height: 8000 }]);
    expect(exportSlices(100, [])).toEqual([{ y: 0, height: 100 }]);
    expect(exportSlices(20000, []).every(s => s.height <= 8192)).toBe(true);
  });
  it("constrains names to a single safe basename", () => {
    expect(exportBasename('../a\\b:*?', '2026-09-17T01:02:03Z', 'abcdef12')).toMatch(/^[^/\\:*?]+$/);
    expect(exportBasename('...', '', '')).toBe('Joi--');
  });
  it('orchestrates only the final snapshot and delegates reading and opening', async () => {
    const create = vi.fn().mockResolvedValue({ exportId: 'e', status: 'queued', filenames: [], count: 0 });
    const get = vi.fn().mockResolvedValue(null); const open = vi.fn().mockResolvedValue(undefined);
    const service = new ResultExportService({ read: async () => ({ title: 'title', body: '# final' }), digest: async () => 'sha', create, get, open });
    const input = { goalId: 'g', format: 'png' as const, digest: 'sha', idempotencyKey: 'key' };
    await service.create(input);
    expect(create).toHaveBeenCalledExactlyOnceWith({ ...input, title: 'title', body: '# final' });
    await service.get('e'); await service.open('e', true);
    expect(get).toHaveBeenCalledWith('e'); expect(open).toHaveBeenCalledWith('e', true);
    await expect(service.create({ ...input, idempotencyKey: '../' })).rejects.toThrow('export_invalid');
    await expect(service.create({ ...input, format: 'exe' as 'png' })).rejects.toThrow('export_invalid');
    const empty = new ResultExportService({ read: async () => null, digest: async () => 'sha', create, get, open });
    await expect(empty.create(input)).rejects.toThrow('export_empty');
    const resumed = new ResultExportService({ find: async () => ({ exportId: 'e', status: 'completed', filenames: ['result.png'], count: 1 }), read: async () => null, digest: async () => '', create, get, open });
    await expect(resumed.create(input)).resolves.toMatchObject({ exportId: 'e', status: 'completed' });
  });
  it("rejects changed and empty results before queuing side effects", async () => {
    let body = 'final';
    const jobs: unknown[] = [];
    const service = new ResultExportService({
      read: async () => ({ title: 'title', body }), digest: async text => text,
      create: async input => { jobs.push(input); return { exportId: 'e', status: 'queued', filenames: [], count: 0 }; },
      get: async () => null, open: async () => {},
    });
    await expect(service.create({ goalId: 'g', format: 'pdf', digest: 'old', idempotencyKey: 'key' })).rejects.toThrow('export_snapshot_changed');
    body = '  ';
    await expect(service.create({ goalId: 'g', format: 'pdf', digest: body, idempotencyKey: 'key' })).rejects.toThrow('export_empty');
    expect(jobs).toHaveLength(0);
  });
});
