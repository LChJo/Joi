import { _electron as electron, expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ResultExportDto } from "../../src/shared/result-export";

test("the runtime Worker exports through the native bridge and acknowledges durable state", async () => {
  test.setTimeout(60_000);
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });
  try {
    const page = await application.firstWindow();
    const userData = await application.evaluate(({ app }) => app.getPath("userData"));
    expect(userData).toContain("joi-e2e");
    const body = "# Disposable Worker export\n\nSynthetic complete result.";
    const connection = new DatabaseSync(path.join(userData, "runtime.sqlite"));
    const now = new Date().toISOString();
    try {
      connection.exec("PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
      connection.prepare(`INSERT INTO joi_inbox_messages(input_id,idempotency_key,body,status,created_at,updated_at)
        VALUES ('worker-export','worker-export','Synthetic goal','CONSUMED',?,?)`).run(now, now);
      connection.prepare(`INSERT INTO joi_turns(turn_id,input_id,workbench_id,session_id,status,created_at,updated_at)
        VALUES ('worker-export-turn','worker-export','synthetic-wb','synthetic-session','COMPLETED',?,?)`).run(now, now);
      connection.prepare(`INSERT INTO joi_turn_completions(input_id,turn_id,outcome_kind,completion_summary,completed_at,updated_at)
        VALUES ('worker-export','worker-export-turn','DIRECT_ANSWER',?,?,?)`).run(body, now, now);
      connection.exec("COMMIT");
    } finally { connection.close(); }
    // Credentials stay inside the disposable browser context; only public job state is returned.
    const job = await page.evaluate(async (digest) => {
      const grant = await window.digitalLifeDesktop?.createBootstrapNonce();
      if (grant === undefined) throw new Error("bridge_missing");
      const bootstrap = await fetch("/api/v1/auth/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: grant.nonce }) });
      const session = await bootstrap.json() as { csrfToken: string };
      const response = await fetch("/api/v1/result-exports", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ goalId: "worker-export", digest, format: "pdf", idempotencyKey: "worker-export-pdf" }) });
      if (response.status !== 202) throw new Error("export_not_accepted");
      return response.json() as Promise<ResultExportDto>;
    }, createHash("sha256").update(body).digest("hex"));
    let completed: ResultExportDto | undefined;
    await expect.poll(async () => {
      const response = await page.evaluate(async (id) => (await fetch(`/api/v1/result-exports/${id}`)).json() as Promise<ResultExportDto>, job.exportId);
      completed = response;
      return response.status;
    }, { timeout: 20_000 }).toBe("completed");
    expect(completed?.count).toBe(1);
    const filename = completed?.filenames[0];
    if (filename === undefined) throw new Error("export_file_missing");
    const pdf = await readFile(path.join(userData, "downloads", "Joi", filename));
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    const inspect = new DatabaseSync(path.join(userData, "runtime.sqlite"), { readOnly: true });
    try {
      await expect.poll(() => inspect.prepare("SELECT status FROM outbox WHERE outbox_id = ?").get(`export_${job.exportId}`)?.status).toBe("DONE");
    } finally { inspect.close(); }
  } finally { await application.close(); }
});
