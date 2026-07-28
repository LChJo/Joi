import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import type { ApiHandler } from "./api-handler.js";

interface RecoveryBackups {
  create(): Promise<{ backupId: string }>;
  list(): Promise<{ backupId: string; createdAt: string; databaseBytes: number; schemaVersion: number }[]>;
  stageRecoveryRestore(backupId: string): Promise<{ backupId: string; restartRequired: true }>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

function page(nonce: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>joi · 安全恢复</title><style nonce="${nonce}">:root{color-scheme:dark;font-family:Inter,"Segoe UI",sans-serif;background:#111815;color:#e7eee9}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;background:#111815}main{width:min(760px,100%);border:1px solid #35443d;border-top:3px solid #d99a54;background:#18231f;padding:32px;box-shadow:0 18px 55px #0006}.eyebrow{color:#d99a54;font:700 11px ui-monospace;letter-spacing:.14em}h1{font-size:30px;margin:8px 0 12px}p{color:#aab8b0;line-height:1.7}section{margin-top:28px;border-top:1px solid #35443d;padding-top:20px}.row{display:flex;justify-content:space-between;gap:18px;align-items:center;padding:14px 0;border-bottom:1px solid #2a3731}.row small{display:block;color:#809087;margin-top:4px}button{border:1px solid #53675e;background:#24342d;color:#e7eee9;padding:9px 13px;cursor:pointer}button.primary{border-color:#76b98f;background:#315d43}button:disabled{opacity:.5;cursor:wait}#notice{min-height:24px;color:#d9b77f}</style></head><body><main><p class="eyebrow">joi 的安全恢复</p><h1>joi 需要先修复本机数据</h1><p>joi 已暂停所有智能体和数据写入，避免问题扩大。你可以先保存当前数据快照，或选择一份备份恢复。joi 不会在这里显示敏感内容或文件位置。</p><div><button id="snapshot">保存当前数据快照</button></div><p id="notice" role="status"></p><section><h2>可以恢复的备份</h2><div id="backups">joi 读取备份中…</div></section></main><script nonce="${nonce}">const notice=document.querySelector('#notice');const list=document.querySelector('#backups');async function load(){const r=await fetch('/api/v1/recovery');const d=await r.json();list.textContent='';if(!d.backups.length){list.textContent='没有可用备份。';return}for(const b of d.backups){const row=document.createElement('div');row.className='row';const text=document.createElement('div');const strong=document.createElement('strong');strong.textContent=new Date(b.createdAt).toLocaleString();const small=document.createElement('small');small.textContent='数据格式 v'+b.schemaVersion+' · '+(b.databaseBytes/1048576).toFixed(1)+' MB';text.append(strong,small);const button=document.createElement('button');button.className='primary';button.textContent='恢复并重启';button.onclick=async()=>{if(!confirm('joi 会先把当前数据隔离。确认恢复这份备份吗？'))return;button.disabled=true;const response=await fetch('/api/v1/recovery/backups/'+encodeURIComponent(b.backupId)+'/restore',{method:'POST',headers:{'content-type':'application/json'}});const result=await response.json();notice.textContent=response.ok?'恢复已经安排好，应用即将重启。':result.message;};row.append(text,button);list.append(row)}}document.querySelector('#snapshot').onclick=async(e)=>{e.currentTarget.disabled=true;notice.textContent='joi 保存数据快照中…';const r=await fetch('/api/v1/recovery/backups',{method:'POST',headers:{'content-type':'application/json'}});notice.textContent=r.ok?'数据快照已保存。':'数据快照没保存成功。';e.currentTarget.disabled=false;await load()};load().catch(()=>{list.textContent='joi 读取备份失败。'});</script></body></html>`;
}

export function createRecoveryModeHandler(input: { backups: RecoveryBackups; requestRestart: () => void }): ApiHandler {
  const nonce = randomBytes(18).toString("base64");
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method === "GET" && url.pathname === "/api/v1/health") {
        json(response, 200, { database: "read-only", reason: "migration_failed", status: "recovery" }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/recovery") {
        json(response, 200, { backups: await input.backups.list(), database: { mode: "read-only-recovery" }, reason: "migration_failed" }); return;
      }
      const expectedOrigin = `http://${request.headers.host ?? ""}`;
      if (request.method === "POST" && request.headers.origin !== expectedOrigin) {
        json(response, 403, { code: "origin_invalid", message: "Recovery writes require the same loopback Origin." }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/recovery/backups") {
        json(response, 201, await input.backups.create()); return;
      }
      const restore = /^\/api\/v1\/recovery\/backups\/([^/]+)\/restore$/.exec(url.pathname);
      if (request.method === "POST" && restore !== null) {
        const result = await input.backups.stageRecoveryRestore(decodeURIComponent(restore[1] ?? ""));
        json(response, 202, result);
        setTimeout(input.requestRestart, 50).unref();
        return;
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'`,
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(page(nonce)); return;
      }
      json(response, 404, { code: "route_not_found", message: "Recovery route was not found." });
    } catch {
      json(response, 400, { code: "recovery_request_failed", message: "The recovery request could not be completed." });
    }
  };
}
