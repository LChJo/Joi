import { DatabaseSync } from "node:sqlite";
import { WorkResultService } from "../../src/main/application/work/work-result-service.js";
import { SqliteWorkResultRepository } from "../../src/main/infrastructure/persistence/sqlite-work-result-repository.js";

describe("AC-43 Unicode result pagination", () => {
  it.each(["", "a".repeat(7999)])("reassembles emoji bodies through bounded SQL codepoint cursors without splitting surrogate pairs", async prefix => {
    const connection = new DatabaseSync(":memory:");
    try {
      connection.exec(`CREATE TABLE work_results(result_id TEXT,workbench_id TEXT,body_ref TEXT);
        CREATE TABLE work_result_bodies(body_ref TEXT,body TEXT);
        CREATE TABLE work_result_verifications(result_id TEXT,status TEXT,reason_code TEXT);
        INSERT INTO work_results VALUES ('result','bench','body');
        INSERT INTO work_result_verifications VALUES ('result','PASSED',NULL);`);
      const original = `${prefix}${"😀".repeat(9000)} CONCLUSION_TAIL`;
      connection.prepare("INSERT INTO work_result_bodies VALUES ('body',?)").run(original);
      const database = { transaction<T>(operation: (db: DatabaseSync) => T): T { return operation(connection); } };
      const service = new WorkResultService(new SqliteWorkResultRepository(database));
      let cursor: string | undefined;
      let reconstructed = "";
      let previousOffset = 0;
      do {
        const page = await service.read({ resultId: "result",workbenchId: "bench",...(cursor === undefined ? {} : { cursor }) });
        expect(page.content.length).toBeLessThanOrEqual(8000);
        expect(page.content.length).toBeGreaterThan(0);
        expect(page.content).not.toMatch(/[\uD800-\uDBFF]$/u);
        expect(page.content).not.toMatch(/^[\uDC00-\uDFFF]/u);
        if (page.nextCursor !== undefined) {
          expect(Number(page.nextCursor)).toBe(previousOffset + Array.from(page.content).length);
          expect(Number(page.nextCursor)).toBeGreaterThan(previousOffset);
        }
        reconstructed += page.content;
        cursor = page.nextCursor;
        previousOffset += Array.from(page.content).length;
      } while (cursor !== undefined);
      expect(reconstructed).toBe(original);
      expect(previousOffset).toBe(Array.from(original).length);
    } finally { connection.close(); }
  });
});
