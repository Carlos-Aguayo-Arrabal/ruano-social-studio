// Disposable recovery test only. Source and restored DB must share the isolated test cluster.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { database } from '../db.mjs';
import { createApp } from '../app.mjs';
import { hashPassword } from '../security.mjs';
const url = new URL(process.env.RSS_TEST_ADMIN_URL);
if (process.env.RSS_TEST_ISOLATED !== 'yes' || url.pathname !== '/rss_pilot_test')
  throw new Error('Requires isolated rss_pilot_test');
const source = database(url.toString());
const restoredUrl = new URL(url); restoredUrl.pathname = '/rss_pilot_restored';
const restored = database(restoredUrl.toString());
let app, server;
try {
  const tables = ['rss_users','rss_organizations','rss_memberships','rss_sessions','rss_states'];
  for (const table of tables) {
    const query = 'SELECT to_jsonb(t) AS row FROM ' + table + ' t ORDER BY to_jsonb(t)::text';
    assert.deepEqual((await restored.query(query)).rows, (await source.query(query)).rows, table);
  }
  const {rows:[counts]} = await restored.query('SELECT (SELECT count(*) FROM rss_users)::int AS users, (SELECT count(*) FROM rss_organizations)::int AS organizations');
  assert.equal(counts.users,3); assert.equal(counts.organizations,2);
  const password = randomBytes(24).toString('hex');
  await restored.query('UPDATE rss_users SET password_hash=$1 WHERE email=$2',[await hashPassword(password),'a@example.test']);
  const appUrl = new URL(restoredUrl); appUrl.username='rss_smoke_app'; appUrl.password=process.env.RSS_TEST_APP_PASSWORD;
  app = database(appUrl.toString());
  const origin='http://127.0.0.1:39168';
  server=await createApp({pool:app,origin});
  await new Promise(resolve=>server.listen(39168,'127.0.0.1',resolve));
  assert.equal((await fetch(origin+'/health')).status,200);
  const login=await fetch(origin+'/login',{method:'POST',redirect:'manual',headers:{Origin:origin},body:new URLSearchParams({username:'a@example.test',password})});
  assert.equal(login.status,303);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const me=await (await fetch(origin+'/api/me',{headers:{Cookie:cookie}})).json();
  assert.equal(me.organizations.length,1);
  const state=await (await fetch(origin+'/api/organizations/'+me.organizations[0].id+'/state',{headers:{Cookie:cookie}})).json();
  assert.equal(state.version,1);
  assert.equal(state.data.content[0].title,'Contenido verificado');
  console.log('PASS: cinco tablas idénticas, tres usuarios, dos empresas, permisos restaurados, health, login y contenido recuperado.');
} finally {
  if(server) await new Promise(resolve=>server.close(resolve));
  if(app) await app.end();
  await restored.end(); await source.end();
}
