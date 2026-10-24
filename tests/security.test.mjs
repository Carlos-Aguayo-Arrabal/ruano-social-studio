import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import { fixture, photo } from './helpers.mjs';
import { parseCookies, resourceId } from '../lib/security.mjs';
import { inventory } from '../lib/photo-migration.mjs';

const denied = r => assert.ok([403, 404].includes(r.status), 'Expected denied, got ' + r.status);
test('H01: malformed cookie values are ignored, not fatal', async () => {
  const f = await fixture();
  try {
    for (const cookie of ['unrelated=%', 'ruano_session=%', 'ruano_session=%E0%A4%A', 'a=%GG', 'garbage', 'a=%; b=ok']) {
      const r = await f.request('/', cookie); assert.equal(r.status, 302);
      assert.equal(await (await f.request('/health')).text(), 'ok');
    }
    const a = await f.login();
    assert.equal((await f.request('/api/me', 'unrelated=%; ' + a)).status, 200);
    assert.equal((await f.request('/api/me', 'ruano_session=%')).status, 401);
    assert.equal(parseCookies({ headers: { cookie: 'broken; ok=hello%20world' } }).ok, 'hello world');
  } finally { await f.close(); }
});
test('H01: unexpected async route errors return an error and leave the process alive', async () => {
  const f = await fixture();
  try {
    // URL construction occurs before any route-local catch.
    const status = await new Promise((resolve,reject)=>{
      const req=http.request(f.origin+'/health',{headers:{Host:'['}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
      req.on('error',reject);req.end();
    });
    assert.equal(status,400);
    assert.equal((await f.request('/health')).status, 200);
  } finally { await f.close(); }
});

for (const mode of ['normal', 'orphan', 'collision']) {
  test(`H02 ${mode}: all private photo operations require the owning brand`, async t => {
    const f = await fixture();
    try {
      const a = await f.login('testa'), b = await f.login('testb');
      const id = await f.upload(a);
      assert.equal((await f.request('/api/photos/101/cover?brand=a', a, { method: 'PUT', body: photo })).status, 200);
      if (mode === 'orphan') assert.equal((await f.sync(a, { data: { a: { properties: { remove: [101] } } } })).status, 200);
      if (mode === 'collision') assert.equal((await f.sync(b, { data: { b: { properties: { upsert: [{ id: 101, reference: 'B', web: true }] } } } })).status, 200);
      const before = await inventory(join(f.dir, 'photos-v2', 'a'));
      const ops = [
        ['consult', '/api/photos/101', {}], ['download', `/api/photos/101/${id}`, {}],
        ['cover', '/api/photos/101/cover', {}],
        ['adjust', '/api/photos/101', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photos: [{ id, adjust: { brightness: 70 } }] }) }],
        ['cover update', '/api/photos/101/cover', { method: 'PUT', body: photo }],
        ['upload', '/api/photos/101', { method: 'POST', body: photo }],
        ['delete', `/api/photos/101/${id}`, { method: 'DELETE' }],
      ];
      for (const [name, path, options] of ops) await t.test(name, async () => {
        denied(await f.request(path + '?brand=a', b, options));
        assert.deepEqual(await inventory(join(f.dir, 'photos-v2', 'a')), before);
      });
      denied(await f.request('/api/photo-counts?brand=a&ids=101', b));
      denied(await f.request('/api/photos/101', b)); // old global API fails closed
      if (mode === 'orphan') {
        for (const [name, path, options] of ops) { denied(await f.request(path + '?brand=a', a, options)); }
        // An unrelated brand cannot create an unowned resource either.
        denied(await f.request('/api/photos/101?brand=b', b, { method: 'POST', body: photo }));
      }
      if (mode === 'collision') {
        const manifest = await (await f.request('/api/photos/101?brand=b', b)).json(); assert.deepEqual(manifest.photos, []);
        denied(await f.request(`/api/photos/101/${id}?brand=b`, b));
        denied(await f.request(`/api/photos/101/${id}?brand=b`, b, { method: 'DELETE' }));
        const photoB = Buffer.concat([photo, Buffer.from('synthetic-B')]);
        const other = await f.upload(b, 'b', 101, photoB); assert.notEqual(other, id);
        for (const path of ['/w/bbbbbbbbbbbbbbbb/101/foto/0', '/w/bbbbbbbbbbbbbbbb/101/portada.jpg', '/api/review/222222222222222222222222/photo/101']) {
          // B now has its own photo: must not resolve to A's asset identity.
          const r = await f.request(path); assert.equal(r.status, 200);
          assert.deepEqual(Buffer.from(await r.arrayBuffer()), photoB);
        }
        const bManifest = JSON.parse(await readFile(join(f.dir, 'photos-v2', 'b', '101', 'index.json')));
        assert.deepEqual(bManifest.photos.map(p => p.id), [other]);
        assert.deepEqual(await inventory(join(f.dir, 'photos-v2', 'a')), before);
      }
    } finally { await f.close(); }
  });
}

test('H02: public and review links cannot expose A private photo through a colliding B ID', async () => {
  const f = await fixture();
  try {
    const a = await f.login(), b = await f.login('testb'); await f.upload(a);
    await f.sync(b, { data: { b: { properties: { upsert: [{ id: 101, reference: 'B', web: true }] } } } });
    for (const path of ['/w/bbbbbbbbbbbbbbbb/101/foto/0', '/w/bbbbbbbbbbbbbbbb/101/portada.jpg', '/api/review/222222222222222222222222/photo/101', '/w/aaaaaaaaaaaaaaaa/101/foto/0']) denied(await f.request(path));
    const counts = await (await f.request('/api/photo-counts?brand=b&ids=101', b)).json(); assert.equal(counts['101'], 0);
  } finally { await f.close(); }
});

test('H02: legacy and unowned directories are never claimed automatically', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, 'photos', '101'), { recursive: true });
    await writeFile(join(f.dir, 'photos', '101', 'legacy.jpg'), photo);
    const before = await inventory(join(f.dir, 'photos'));
    const a = await f.login();
    assert.deepEqual((await (await f.request('/api/photos/101?brand=a', a)).json()).photos, []);
    assert.deepEqual(await inventory(join(f.dir, 'photos')), before);
    denied(await f.request('/api/photos/999?brand=a', a, { method: 'POST', body: photo }));
  } finally { await f.close(); }
});

test('H02: owner operations, public gallery, reviews and persistence continue to work', async () => {
  const f = await fixture();
  try {
    let a = await f.login(); const id = await f.upload(a);
    const original = await f.request(`/api/photos/101/${id}?brand=a`, a);
    assert.equal(original.status, 200); assert.equal(original.headers.get('cache-control'), 'no-store');
    assert.equal((await f.request('/api/photos/101?brand=a', a, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photos: [{ id, adjust: { brightness: 12 } }] }) })).status, 200);
    await f.sync(a, { data: { a: { properties: { upsert: [{ id: 101, reference: 'A', web: true }] } } } });
    await f.stop(); await f.launch(); a = await f.login();
    for (const path of ['/w/aaaaaaaaaaaaaaaa/101/foto/0', '/w/aaaaaaaaaaaaaaaa/101/portada.jpg', '/api/review/111111111111111111111111/photo/101']) {
      const r = await f.request(path); assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), photo);
    }
    assert.equal((await f.request(`/api/photos/101/${id}?brand=a`, a, { method: 'DELETE' })).status, 200);
    assert.equal((await f.request(`/api/photos/101/${id}?brand=a`, a)).status, 404);
  } finally { await f.close(); }
});

test('storage segments reject traversal and prototype keys', () => {
  for (const value of ['../a', 'a/b', '__proto__', 'constructor', 'prototype', '', 'a'.repeat(41)]) assert.equal(resourceId(value), null);
  assert.equal(resourceId(101), '101');
});
