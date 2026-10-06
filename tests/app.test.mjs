import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApp } from '../app.mjs';
import { hashPassword, verifyPassword, LoginLimiter } from '../security.mjs';
import { validateState } from '../state.mjs';
const db = new PGlite();
// Real embedded PostgreSQL SQL execution. Serialize leases like a one-connection pool.
let tail=Promise.resolve();
async function lease() {
  const previous=tail; let release; tail=new Promise(resolve=>release=resolve);
  await previous;
  return {query:(text,params)=>db.query(text,params),release};
}
const pool={connect:lease,async query(text,params){const c=await lease();try{return await c.query(text,params)}finally{c.release()}}};
let server, origin, cookieA, cookieB, cookieViewer;
const userA=randomUUID(),userB=randomUUID(),viewer=randomUUID(),orgA=randomUUID(),orgB=randomUUID();
const password='synthetic-test-password-123';
const empty={content:[],properties:[],workflowStep:1};
async function login(email) {
  const response=await fetch(origin+'/login',{method:'POST',redirect:'manual',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:email,password})});
  assert.equal(response.status,303); assert.equal(response.headers.get('location'),'/');
  const cookie=response.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);return cookie.split(';')[0];
}
async function state(org,cookie,method='GET',body,extra={}) {
  return fetch(`${origin}/api/organizations/${org}/state`,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});
}
before(async()=>{
  await db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  const hash=await hashPassword(password);
  for(const [id,email] of [[userA,'a@example.test'],[userB,'b@example.test'],[viewer,'viewer@example.test']])
    await db.query('INSERT INTO rss_users(id,email,password_hash) VALUES($1,$2,$3)',[id,email,hash]);
  for(const [id,name] of [[orgA,'Empresa A'],[orgB,'Empresa B']]){
    await db.query('INSERT INTO rss_organizations(id,name) VALUES($1,$2)',[id,name]);
    await db.query('INSERT INTO rss_states(organization_id) VALUES($1)',[id]);
  }
  for(const [id,org,role] of [[userA,orgA,'owner'],[userB,orgB,'editor'],[viewer,orgA,'viewer']])
    await db.query('INSERT INTO rss_memberships(user_id,organization_id,role) VALUES($1,$2,$3)',[id,org,role]);
  await db.exec(`CREATE ROLE rss_app;
    GRANT USAGE ON SCHEMA public TO rss_app;
    GRANT SELECT ON rss_users,rss_organizations,rss_memberships TO rss_app;
    GRANT SELECT,INSERT,DELETE ON rss_sessions TO rss_app;
    GRANT SELECT,UPDATE ON rss_states TO rss_app;
    SET ROLE rss_app;`);
  // Reserve a port first; createApp validates the canonical Origin used by CSRF checks.
  server=await createApp({pool,origin:'http://127.0.0.1:1'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  origin=`http://127.0.0.1:${port}`;server=await createApp({pool,origin});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  cookieA=await login('a@example.test');cookieB=await login('b@example.test');cookieViewer=await login('viewer@example.test');
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await db.close()});
test('password hashes and limiter reject invalid credentials and bursts',async()=>{
  const hash=await hashPassword(password);assert.equal(await verifyPassword(password,hash),true);
  assert.equal(await verifyPassword('wrong',hash),false);
  const limiter=new LoginLimiter();for(let i=0;i<10;i++)assert.equal(limiter.allow('key',0),true);
  assert.equal(limiter.allow('key',0),false);assert.equal(limiter.allow('key',900001),true);
  const response=await fetch(origin+'/login',{method:'POST',redirect:'manual',headers:{Origin:origin},body:new URLSearchParams({username:'a@example.test',password:'wrong'})});
  assert.equal(response.headers.get('location'),'/login?error=1');
});
test('anonymous API access fails and malformed session cannot crash the server',async()=>{
  const anonymous=await fetch(origin+'/api/me');assert.equal(anonymous.status,401);
  assert.match(anonymous.headers.get('content-security-policy'),/script-src 'self';/);
  assert.doesNotMatch(anonymous.headers.get('content-security-policy'),/script-src[^;]*unsafe-inline/);
  assert.equal((await fetch(origin+'/api/me',{headers:{Cookie:'rss_session=%malformed'}})).status,401);
});
test('membership filters organizations and rejects cross-tenant reads/writes',async()=>{
  const me=await (await fetch(origin+'/api/me',{headers:{Cookie:cookieA}})).json();
  assert.deepEqual(me.organizations.map(o=>o.id),[orgA]);
  assert.equal((await state(orgB,cookieA)).status,404);
  assert.equal((await state(orgA,cookieB,'PUT',{version:0,data:empty})).status,404);
});
test('viewer is read-only; CSRF and invalid status are rejected',async()=>{
  assert.equal((await state(orgA,cookieViewer)).status,200);
  assert.equal((await state(orgA,cookieViewer,'PUT',{version:0,data:empty})).status,403);
  assert.equal((await state(orgA,cookieA,'PUT',{version:0,data:empty},{Origin:'https://attacker.test'})).status,403);
  assert.throws(()=>validateState({version:0,data:{...empty,content:[{id:1,title:'a',status:'published'}]}}));
});
test('concurrent edits cannot overwrite each other; new state survives another session',async()=>{
  const result=await Promise.all([state(orgA,cookieA,'PUT',{version:0,data:empty}),state(orgA,cookieA,'PUT',{version:0,data:empty})]);
  assert.deepEqual(result.map(r=>r.status).sort(),[200,409]);
  const saved=await (await state(orgA,cookieA)).json();assert.equal(saved.version,1);
  assert.deepEqual(saved.data,empty);
  assert.equal((await (await state(orgB,cookieB)).json()).version,0);
});
test('property export downloads saved text only for members of the owning organization',async()=>{
 const current=await (await state(orgA,cookieA)).json();
 const property={id:7001,title:'Exportación de prueba',reference:'REF-TEST',location:'',price:'165.000 €',built:'',useful:'',beds:'',baths:'',floor:'',extras:'',photos:0,url:''};
 const draft={id:7002,title:property.title,type:'Publicación',channel:'Instagram',status:'pending',date:'2026-10-04',caption:'Texto guardado y revisado',icon:'⌂',propertyRef:'inmueble:7001'};
 assert.equal((await state(orgA,cookieA,'PUT',{version:current.version,data:{properties:[property],content:[draft],workflowStep:4}})).status,200);
 const path=`${origin}/api/organizations/${orgA}/properties/7001/export`;
 const own=await fetch(path,{headers:{Cookie:cookieA}});assert.equal(own.status,200);assert.match(own.headers.get('content-disposition'),/attachment/);assert.match(await own.text(),/Texto guardado y revisado/);
 assert.equal((await fetch(path,{headers:{Cookie:cookieB}})).status,404);
 assert.equal((await fetch(path)).status,401);
 assert.equal((await fetch(path,{headers:{Cookie:cookieViewer}})).status,200);
});
test('brand settings remain tenant-owned; editors cannot replace or erase them',async()=>{
 const brand={name:'Marca B',tagline:'Lema',phone:'',website:'https://example.test',color:'#123456',logo:''};
 assert.equal((await state(orgB,cookieB,'PUT',{version:0,data:{...empty,brand}})).status,403);
 await db.exec('RESET ROLE');await db.query("UPDATE rss_states SET data=$1::jsonb WHERE organization_id=$2",[JSON.stringify({...empty,brand}),orgB]);await db.exec('SET ROLE rss_app');
 assert.equal((await state(orgB,cookieB,'PUT',{version:0,data:empty})).status,403);
 assert.equal((await state(orgB,cookieB,'PUT',{version:0,data:{...empty,brand}})).status,200);
 const current=await (await state(orgA,cookieA)).json();
 assert.equal((await state(orgA,cookieA,'PUT',{version:current.version,data:{...current.data,brand}})).status,200);
 assert.equal((await (await state(orgA,cookieA)).json()).data.brand.name,'Marca B');
 assert.equal((await state(orgA,cookieB)).status,404);
});
test('invalid branding, dangling property selection, empty approvals and past schedules are rejected',async()=>{
 for(const brand of [{logo:'data:image/svg+xml;base64,PHN2Zz4='},{color:'red'},{website:'javascript:alert(1)'},{logo:'data:image/png;base64,aGVsbG8='}])assert.throws(()=>validateState({version:0,data:{...empty,brand}}));
 assert.throws(()=>validateState({version:0,data:{...empty,selectedPropertyId:999}}));
 const current=await (await state(orgA,cookieA)).json();
 const item={id:8001,title:'Test',type:'Publicación',channel:'Instagram',status:'approved',date:'2000-01-01',caption:'',icon:'⌂'};
 assert.equal((await state(orgA,cookieA,'PUT',{version:current.version,data:{...current.data,content:[item]}})).status,400);
 item.status='scheduled';item.caption='Texto confirmado';
 assert.equal((await state(orgA,cookieA,'PUT',{version:current.version,data:{...current.data,content:[item]}})).status,400);
});
test('membership revocation and logout revoke existing sessions',async()=>{
  await db.exec('RESET ROLE');
  await db.query('DELETE FROM rss_memberships WHERE user_id=$1 AND organization_id=$2',[userB,orgB]);
  await db.exec('SET ROLE rss_app');
  assert.equal((await state(orgB,cookieB)).status,404);
  const response=await fetch(origin+'/logout',{method:'POST',redirect:'manual',headers:{Cookie:cookieB,Origin:origin}});
  assert.equal(response.status,303);
  assert.equal((await fetch(origin+'/api/me',{headers:{Cookie:cookieB}})).status,401);
});
