import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiHandler, type ApiDependencies } from '../../src/main/interfaces/http/api-handler.js';
import { HttpError } from '../../src/main/interfaces/http/http-core.js';

it('requires desktop and write verification before creating or opening exports', async () => {
  let kind = 'lan'; let allowed = true;
  const resultExports = { create: vi.fn().mockResolvedValue({ exportId: 'e', status: 'queued', filenames: [], count: 0 }), get: vi.fn().mockResolvedValue(null), open: vi.fn().mockResolvedValue(undefined) };
  const auth = { authenticate: vi.fn().mockImplementation(() => Promise.resolve({ kind })), verifyWrite: vi.fn().mockImplementation(() => allowed ? Promise.resolve() : Promise.reject(new HttpError('csrf_invalid','Denied',403))) };
  const handler = createApiHandler({ auth, resultExports } as unknown as ApiDependencies);
  const server = createServer((req,res) => { void handler(req,res); });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const headers = { origin, cookie: 'digital_life_session=fake', 'x-csrf-token':'fake', 'content-type':'application/json' };
  const body = { goalId:'g', format:'pdf', digest:'sha', idempotencyKey:'key', html:'untrusted', path:'untrusted' };
  try {
    expect((await fetch(`${origin}/api/v1/result-exports`,{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(403);
    expect((await fetch(`${origin}/api/v1/result-exports/e`,{headers})).status).toBe(403);
    expect((await fetch(`${origin}/api/v1/result-exports/e/open`,{method:'POST',headers,body:'{}'})).status).toBe(403);
    expect(resultExports.create).not.toHaveBeenCalled(); expect(resultExports.open).not.toHaveBeenCalled();
    kind = 'desktop'; allowed = false;
    expect((await fetch(`${origin}/api/v1/result-exports`,{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(403);
    expect(resultExports.create).not.toHaveBeenCalled();
    allowed = true;
    expect((await fetch(`${origin}/api/v1/result-exports`,{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(202);
    expect(resultExports.create).toHaveBeenCalledExactlyOnceWith({goalId:'g',format:'pdf',digest:'sha',idempotencyKey:'key'});
    expect((await fetch(`${origin}/api/v1/result-exports/e`,{headers})).status).toBe(404);
    expect((await fetch(`${origin}/api/v1/result-exports/e/open`,{method:'POST',headers,body:'{"reveal":true}'})).status).toBe(200);
    expect(resultExports.open).toHaveBeenCalledWith('e',true);
    expect(auth.verifyWrite).toHaveBeenCalledWith(expect.objectContaining({csrfToken:'fake',origin,sessionToken:'fake'}));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
