// Run only against a disposable, isolated PostgreSQL container, not the live database.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createApp } from '../app.mjs';
import { database, migrate } from '../db.mjs';
import { hashPassword } from '../security.mjs';
const adminUrl = new URL(process.env.RSS_TEST_ADMIN_URL);
if (adminUrl.pathname !== '/rss_pilot_test' || process.env.RSS_TEST_ISOLATED !== 'yes')
  throw new Error('Esta prueba exige rss_pilot_test y RSS_TEST_ISOLATED=yes');
const appPassword = process.env.RSS_TEST_APP_PASSWORD;
if (!/^[a-f0-9]{48}$/.test(appPassword || '')) throw new Error('Contraseña temporal no válida');
const admin = database(adminUrl.toString());
let app, server;
try {
  await migrate(admin);
  await migrate(admin);
  const {rows:[version]} = await admin.query('SELECT version()');
  console.log('Motor verificado:',version.version.split(',')[0]);
  await admin.query(`CREATE ROLE rss_smoke_app LOGIN PASSWORD '${appPassword}'`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO rss_smoke_app;
    GRANT SELECT ON rss_users,rss_organizations,rss_memberships TO rss_smoke_app;
    GRANT SELECT,INSERT,DELETE ON rss_sessions TO rss_smoke_app;
    GRANT SELECT,UPDATE ON rss_states TO rss_smoke_app;`);
  const orgA=randomUUID(),orgB=randomUUID(),userA=randomUUID(),userB=randomUUID(),viewer=randomUUID();
  const password=randomBytes(24).toString('hex'),hash=await hashPassword(password);
  for(const [id,email] of [[userA,'a@example.test'],[userB,'b@example.test'],[viewer,'viewer@example.test']])
    await admin.query('INSERT INTO rss_users(id,email,password_hash) VALUES($1,$2,$3)',[id,email,hash]);
  for(const [id,name] of [[orgA,'Empresa A de prueba'],[orgB,'Empresa B de prueba']]) {
    await admin.query('INSERT INTO rss_organizations(id,name) VALUES($1,$2)',[id,name]);
    await admin.query('INSERT INTO rss_states(organization_id) VALUES($1)',[id]);
  }
  for(const [id,org,role] of [[userA,orgA,'owner'],[userB,orgB,'editor'],[viewer,orgA,'viewer']])
    await admin.query('INSERT INTO rss_memberships(user_id,organization_id,role) VALUES($1,$2,$3)',[id,org,role]);
  const appUrl=new URL(adminUrl);appUrl.username='rss_smoke_app';appUrl.password=appPassword;
  app=database(appUrl.toString());
  const {rows:[role]}=await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  const origin='http://127.0.0.1:39167';
  server=await createApp({pool:app,origin});
  await new Promise(resolve=>server.listen(39167,'127.0.0.1',resolve));
  async function request(path,{cookie,method='GET',body,customOrigin=origin}={}) {
    return fetch(origin+path,{method,redirect:'manual',headers:{Origin:customOrigin,...(cookie?{Cookie:cookie}:{}),
      'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  }
  async function login(email) {
    const response=await fetch(origin+'/login',{method:'POST',redirect:'manual',headers:{Origin:origin},body:new URLSearchParams({username:email,password})});
    assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/');
    return response.headers.get('set-cookie').split(';')[0];
  }
  const cookieA=await login('a@example.test'),cookieB=await login('b@example.test'),cookieViewer=await login('viewer@example.test');
  assert.equal((await request('/health')).status,200);
  assert.equal((await request('/api/me')).status,401);
  const me=await (await request('/api/me',{cookie:cookieA})).json();
  assert.deepEqual(me.organizations.map(org=>org.id),[orgA]);
  const route=id=>`/api/organizations/${id}/state`;
  const data={content:[{id:1,title:'Contenido verificado',caption:'Datos sintéticos',type:'Publicación',channel:'Instagram',status:'pending',date:'2026-10-04',icon:'⌂'}],properties:[],workflowStep:1};
  assert.equal((await request(route(orgB),{cookie:cookieA})).status,404);
  assert.equal((await request(route(orgA),{cookie:cookieB,method:'PUT',body:{version:0,data}})).status,404);
  assert.equal((await request(route(orgA),{cookie:cookieViewer,method:'PUT',body:{version:0,data}})).status,403);
  assert.equal((await request(route(orgA),{cookie:cookieA,method:'PUT',body:{version:0,data},customOrigin:'https://attacker.test'})).status,403);
  const edits=await Promise.all([request(route(orgA),{cookie:cookieA,method:'PUT',body:{version:0,data}}),request(route(orgA),{cookie:cookieA,method:'PUT',body:{version:0,data}})]);
  assert.deepEqual(edits.map(response=>response.status).sort(),[200,409]);
  const saved=await (await request(route(orgA),{cookie:await login('a@example.test')})).json();
  assert.equal(saved.version,1);assert.deepEqual(saved.data,data);
  assert.equal((await (await request(route(orgB),{cookie:cookieB})).json()).version,0);
  assert.equal((await request('/',{cookie:cookieA})).status,200);
  assert.equal((await request('/saas-client.js',{cookie:cookieA})).status,200);
  await admin.query('DELETE FROM rss_memberships WHERE user_id=$1 AND organization_id=$2',[userB,orgB]);
  assert.equal((await request(route(orgB),{cookie:cookieB})).status,404);
  assert.equal((await request('/logout',{cookie:cookieB,method:'POST'})).status,303);
  assert.equal((await request('/api/me',{cookie:cookieB})).status,401);
  console.log('PASS: migración idempotente, rol restringido, login, salud, aislamiento, viewer, CSRF, concurrencia, persistencia, interfaz, revocación y logout.');
} finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  if(app)await app.end();await admin.end();
}
