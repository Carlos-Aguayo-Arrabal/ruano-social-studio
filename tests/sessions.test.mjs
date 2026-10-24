import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from './helpers.mjs';
import {SessionStore} from '../lib/sessions.mjs';
import {createHmac} from 'node:crypto';

const binding='a'.repeat(64), uidA='a'.repeat(12);
const manage=(f,owner,id,body,method='POST')=>f.request('/api/users/'+id,owner,{method,headers:{'Content-Type':'application/json'},...(method==='DELETE'?{}:{body:JSON.stringify(body)})});
test('logout revokes only its independent cookie, survives restart, and does not affect company B',async()=>{
 const f=await fixture();try{
  const a1=await f.login(),a2=await f.login(),b=await f.login('testb');assert.notEqual(a1,a2);
  assert.equal((await f.request('/logout',a1)).status,303);
  for(const path of ['/api/me','/api/sync','/api/photos/101?brand=a'])assert.equal((await f.request(path,a1)).status,401);
  assert.equal((await f.request('/api/me',a2)).status,200);assert.equal((await f.request('/api/me',b)).status,200);
  await f.stop();await f.launch();
  assert.equal((await f.request('/api/me',a1)).status,401);
  assert.equal((await f.request('/api/me',a2)).status,200);assert.equal((await f.request('/api/me',b)).status,200);
  assert.equal((await f.request('/api/photos/101?brand=a',b)).status,403);
  const bytes=await readFile(join(f.dir,'sessions.json'),'utf8');assert.ok(!bytes.includes(decodeURIComponent(a1.split('=')[1])));assert.equal((await stat(join(f.dir,'sessions.json'))).mode&0o777,0o600);
 }finally{await f.close()}
});
for(const [name,body] of [['password',{password:'synthetic-new-password'}],['disabled',{disabled:true}],['permissions',{brands:['b']}],['role',{role:'admin'}]])test(name+' changes invalidate all affected sessions immediately and after restart',async()=>{
 const f=await fixture();try{
  let owner=await f.login('testowner');const a1=await f.login(),a2=await f.login(),b=await f.login('testb');
  assert.equal((await manage(f,owner,uidA,body)).status,200);
  for(const c of [a1,a2])assert.equal((await f.request('/api/me',c)).status,401);
  assert.equal((await f.request('/api/me',b)).status,200);
  await f.stop();await f.launch();owner=await f.login('testowner');
  for(const c of [a1,a2])assert.equal((await f.request('/api/me',c)).status,401);
  assert.equal((await f.request('/api/me',b)).status,200);
  if(name==='disabled'){
   assert.equal((await manage(f,owner,uidA,{disabled:false})).status,200);assert.equal((await f.request('/api/me',a1)).status,401);assert.equal((await f.request('/api/me',await f.login())).status,200);
  }else if(name==='password')assert.equal((await f.request('/api/me',await f.login('testa','synthetic-new-password'))).status,200);
  else if(name==='permissions'){
   const fresh=await f.login();const state=await(await f.request('/api/sync',fresh)).json();assert.deepEqual(state.brands.map(b=>b.id),['b']);assert.equal((await f.request('/api/photos/101?brand=a',fresh)).status,403);
  }else{
   const promoted=await f.login();assert.equal((await f.request('/api/users',promoted)).status,200);
   assert.equal((await manage(f,owner,uidA,{role:'agency',brands:['a']})).status,200);assert.equal((await f.request('/api/me',promoted)).status,401);
  }
 }finally{await f.close()}
});
test('deletion revokes the affected sessions; changing only display name preserves them',async()=>{
 const f=await fixture();try{const owner=await f.login('testowner'),a=await f.login();assert.equal((await manage(f,owner,uidA,{name:'Synthetic renamed'})).status,200);assert.equal((await f.request('/api/me',a)).status,200);assert.equal((await manage(f,owner,uidA,{},'DELETE')).status,200);assert.equal((await f.request('/api/me',a)).status,401);}finally{await f.close()}
});
test('only owner can create/promote/manage global admins; agency has no user-management access',async()=>{
 const f=await fixture();try{
  const owner=await f.login('testowner'),a=await f.login(),b=await f.login('testb');
  assert.equal((await manage(f,a,uidA,{role:'admin'})).status,403);
  assert.equal((await manage(f,owner,uidA,{role:'admin'})).status,200);const admin=await f.login();
  assert.equal((await manage(f,admin,'b'.repeat(12),{role:'admin'})).status,403);
  assert.equal((await manage(f,admin,uidA,{disabled:true})).status,403);
  assert.equal((await f.request('/api/users',admin,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'unwanted-admin',role:'admin',password:'synthetic-password'})})).status,403);
  assert.equal((await manage(f,admin,'b'.repeat(12),{name:'Agency renamed'})).status,200);assert.equal((await f.request('/api/me',b)).status,200);
 }finally{await f.close()}
});
test('legacy stateless cookies rejected; credential changes in environment invalidate owner sessions after restart',async()=>{
 const runtime={APP_SESSION_SECRET:'synthetic-legacy-transition-key'};const f=await fixture({runtime});try{
  const owner=await f.login('testowner');
  const payload=Buffer.from(JSON.stringify({uid:'owner',user:'testowner',pv:0,exp:Date.now()+3600_000})).toString('base64url');
  const legacy=payload+'.'+createHmac('sha256',runtime.APP_SESSION_SECRET).update(payload).digest('base64url');
  assert.equal((await f.request('/api/me','ruano_session='+legacy)).status,401);
  await f.stop();runtime.APP_PASSWORD='synthetic-env-replacement';await f.launch();assert.equal((await f.request('/api/me',owner)).status,401);
  assert.equal((await f.request('/api/me',await f.login('testowner','synthetic-env-replacement'))).status,200);
 }finally{await f.close()}
});
test('session TTL, cleanup, limits, hashes and restart persistence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ruano-session-unit-')),file=join(dir,'sessions.json');let now=1000;
 const options={now:()=>now,ttlMs:100,maxSessions:2,maxPerUser:1};
 try{
  const store=await SessionStore.open(file,options),a=await store.create('a',binding);assert.equal(store.resolve(a,()=>binding),'a');
  await assert.rejects(store.create('a',binding),e=>e.status===429);await store.create('b',binding);await assert.rejects(store.create('c',binding),e=>e.status===429);
  const reloaded=await SessionStore.open(file,options);assert.equal(reloaded.resolve(a,()=>binding),'a');assert.equal(reloaded.resolve(a,()=> 'b'.repeat(64)),null);
  now=1100;assert.equal(reloaded.resolve(a,()=>binding),null);await reloaded.prune();assert.equal(JSON.parse(await readFile(file)).sessions.length,0);
  assert.equal((await stat(file)).mode&0o777,0o600);assert.ok(!(await readFile(file,'utf8')).includes(a));
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('corrupt/oversized storage fails closed without resetting it; failed revocation is not acknowledged',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ruano-session-errors-')),file=join(dir,'sessions.json');
 try{
  await writeFile(file,'{corrupt');await assert.rejects(SessionStore.open(file),e=>e.status===503);assert.equal(await readFile(file,'utf8'),'{corrupt');
  await writeFile(file,'x'.repeat(1025));await assert.rejects(SessionStore.open(file,{maxFileBytes:1024}),e=>e.status===503);
  await rm(file);const store=await SessionStore.open(file),token=await store.create('a',binding);
  await rename(dir,dir+'-moved');await assert.rejects(store.revoke(token),e=>e.status===503);assert.throws(()=>store.resolve(token,()=>binding),e=>e.status===503);
 }finally{await rm(dir,{recursive:true,force:true});await rm(dir+'-moved',{recursive:true,force:true})}
});
