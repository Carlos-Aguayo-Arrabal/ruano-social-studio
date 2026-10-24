import { spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const photo = await readFile(new URL('./fixtures/photo.jpg', import.meta.url));
export async function fixture({ store: custom, start = true, runtime = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ruano-security-'));
  const password = randomBytes(24).toString('hex');
  const store = custom || { version: 2, v: 1,
    brands: [{ id: 'b', name: 'Test B', color: '#123456', color2: '#123456', webId: 'bbbbbbbbbbbbbbbb', reviewToken: '222222222222222222222222' },
      { id: 'a', name: 'Test A', color: '#123456', color2: '#123456', webId: 'aaaaaaaaaaaaaaaa', reviewToken: '111111111111111111111111' }],
    data: { b: { content: [], properties: [] }, a: { content: [], properties: [{ id: 101, reference: 'PRIVATE-A', web: false }] } } };
  await writeFile(join(dir, 'store.json'), JSON.stringify(store));
  await writeFile(join(dir, 'users.json'), JSON.stringify(['a', 'b'].map(id => ({ id: id.repeat(12), username: 'test' + id, role: 'agency', name: id, brands: [id], salt: id, hash: scryptSync(password, id, 64).toString('hex'), pv: 0 }))));
  let child, origin, logs = '';
  const launch = async () => {
    // Deliberately do not inherit provider credentials or production configuration.
    child = spawn(process.execPath, ['server.mjs'], { cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0', DATA_DIR: dir, NODE_ENV: 'development', APP_USERNAME: 'testowner', APP_PASSWORD: password, APP_SESSION_SECRET: randomBytes(48).toString('hex'), OLLAMA_URL: 'http://127.0.0.1:1', ...runtime },
      stdio: ['ignore', 'pipe', 'pipe'] });
    logs = '';
    child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
    for (let i = 0; i < 150; i++) {
      const match = logs.match(/escuchando en el puerto (\d+)/);
      if (match) { origin = 'http://127.0.0.1:' + match[1]; return; }
      if (child.exitCode !== null) throw Error(logs);
      await new Promise(r => setTimeout(r, 30));
    }
    throw Error('Server readiness timeout: ' + logs);
  };
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
    }
  };
  const close = async () => { await stop(); await rm(dir, { recursive: true, force: true }); };
  const request = (path, cookie = '', options = {}) => fetch(origin + path, { redirect: 'manual', ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
  const login = async (username = 'testa') => {
    const r = await request('/login', '', { method: 'POST', body: new URLSearchParams({ username, password }) });
    assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/');
    return r.headers.get('set-cookie').split(';')[0];
  };
  const sync = (cookie, body) => request('/api/sync', cookie, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const upload = async (cookie, brand = 'a', id = 101, bytes = photo) => {
    const r = await request(`/api/photos/${id}?brand=${brand}`, cookie, { method: 'POST', body: bytes });
    assert.equal(r.status, 201); return (await r.json()).id;
  };
  try { if (start) await launch(); }
  catch (err) { await close(); throw err; }
  return { dir, store, request, login, sync, upload, launch, stop, close, get origin() { return origin; }, get logs() { return logs; } };
}
