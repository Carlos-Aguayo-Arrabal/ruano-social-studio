import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture,photo } from './helpers.mjs';
import { inventory,planPhotos } from '../lib/photo-migration.mjs';
import { smtpFixture } from './smtp.mjs';

async function until(run,check){for(let i=0;i<100;i++){const v=await run();if(check(v))return v;await new Promise(r=>setTimeout(r,30));}throw Error('Readiness timeout');}
test('CSRF: foreign/null Origin and cross-site fetch writes rejected; same-origin UI remains supported',async()=>{
 const f=await fixture();try{
  const a=await f.login();const before=await readFile(join(f.dir,'store.json'),'utf8');
  for(const path of ['/api/sync','/login','/logout'])for(const headers of [{Origin:'https://foreign.invalid'},{Origin:'null'},{'Sec-Fetch-Site':'cross-site'}]) {
   const r=await f.request(path,a,{method:'POST',headers:{'Content-Type':'text/plain',...headers},body:'{}'});assert.equal(r.status,403);
  }
  assert.equal((await f.request('/api/sync',a,{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json'},body:JSON.stringify({data:{a:{properties:{upsert:[{id:102,title:'same origin'}]}}}})})).status,200);
  assert.notEqual(await readFile(join(f.dir,'store.json'),'utf8'),before);
  const r=await f.request('/api/sync',a,{method:'OPTIONS',headers:{Origin:'https://foreign.invalid','Access-Control-Request-Method':'POST'}});assert.equal(r.headers.get('access-control-allow-origin'),null);
 }finally{await f.close()}
});
test('cookie tampering, user endpoint and global Drive admin boundary remain closed to an agency',async()=>{
 const f=await fixture();try{
  const a=await f.login();assert.equal((await f.request('/api/me',a+'tampered')).status,401);
  for(const path of ['/api/users','/api/gdrive/status'])assert.equal((await f.request(path,a)).status,403);
 }finally{await f.close()}
});
test('corrupt photo manifest returns 503 without overwriting existing photographs',async()=>{
 const f=await fixture();try{
  const a=await f.login();await f.upload(a);
  await writeFile(join(f.dir,'photos-v2/a/101/index.json'),'{invalid');
  const before=await inventory(join(f.dir,'photos-v2'));
  for(const options of [{},{method:'POST',body:photo},{method:'PUT',headers:{'Content-Type':'application/json'},body:'{"photos":[]}'}])assert.equal((await f.request('/api/photos/101?brand=a',a,options)).status,503);
  assert.deepEqual(await inventory(join(f.dir,'photos-v2')),before);assert.equal((await f.request('/health')).status,200);
 }finally{await f.close()}
});
test('oversized photo is rejected without persisting it or terminating the server',async()=>{
 const f=await fixture();try{
  const a=await f.login(),bytes=Buffer.alloc(4*1024*1024+1);photo.copy(bytes);
  assert.equal((await f.request('/api/photos/101?brand=a',a,{method:'POST',body:bytes})).status,413);
  assert.deepEqual(await inventory(join(f.dir,'photos-v2')),{});assert.equal((await f.request('/health')).status,200);
 }finally{await f.close()}
});
test('AI jobs: a known job ID is not enough to read another agency result',async()=>{
 const mock=http.createServer(async(req,res)=>{for await(const chunk of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/tags'?{models:[{name:'fixture-model'}]}:{message:{content:JSON.stringify({texto:'Texto sintético de prueba suficientemente largo para la regresión.'})}}));});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));const f=await fixture({runtime:{OLLAMA_URL:'http://127.0.0.1:'+mock.address().port,OLLAMA_MODEL:'fixture-model'}});
 try{
  const a=await f.login(),b=await f.login('testb');await until(async()=>(await f.request('/api/ai/status',a)).json(),v=>v.enabled);
  const r=await f.request('/api/ai/rewrite',a,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Ficticio',kind:'publicacion'})});assert.equal(r.status,202);const {job}=await r.json();
  assert.equal((await f.request('/api/ai/jobs/'+job,b)).status,404);
  const own=await until(async()=>(await f.request('/api/ai/jobs/'+job,a)).json(),v=>v.status==='done');assert.match(own.result.text,/sintético/);
  const owner=await f.login('testowner');
  assert.equal((await f.request('/api/users/'+'a'.repeat(12),owner,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brands:['b']})})).status,200);
  assert.equal((await f.request('/api/ai/jobs/'+job,a)).status,401);
  assert.equal((await f.request('/api/ai/jobs/'+job,await f.login())).status,404);
 }finally{await f.close();await new Promise(r=>mock.close(r))}
});
test('migration plan detects same-brand duplicate IDs and unreferenced assets; never assigns them',async()=>{
 const f=await fixture({start:false});try{
  f.store.data.a.properties.push({id:101});await writeFile(join(f.dir,'store.json'),JSON.stringify(f.store));
  await mkdir(join(f.dir,'photos/101'),{recursive:true});await writeFile(join(f.dir,'photos/101/index.json'),'{}');
  let plan=await planPhotos(f.dir);assert.equal(plan.duplicateIds[0].occurrences,2);assert.equal(plan.unresolved[0].reason,'duplicate-property-id');assert.equal(plan.assignments.length,0);
  f.store.data.a.properties.pop();await writeFile(join(f.dir,'store.json'),JSON.stringify(f.store));
  await writeFile(join(f.dir,'photos/101/index.json'),'{"photos":[]}');await writeFile(join(f.dir,'photos/101/unreferenced.jpg'),photo);
  plan=await planPhotos(f.dir);assert.equal(plan.unresolved[0].reason,'unreferenced-files');assert.equal(plan.assignments.length,0);
 }finally{await f.close()}
});
for(const reject of [false,true])test(`notifications integrate with Nodemailer (local SMTP rejection=${reject})`,async()=>{
 const smtp=await smtpFixture({reject});const f=await fixture({runtime:{SMTP_HOST:'127.0.0.1',SMTP_PORT:String(smtp.port),SMTP_USER:'fixture-user',SMTP_PASS:'fixture-password',SMTP_FROM:'studio@example.invalid',NOTIFY_EMAIL:'recipient@example.invalid'}});
 try{
  const a=await f.login(),b=await f.login('testb');
  for(const path of ['/api/notify/test?brand=a','/api/report/send?brand=a'])assert.equal((await f.request(path,a,{method:'POST'})).status,reject?(path.includes('/notify/')?502:400):200);
  assert.equal((await f.request('/api/report/send?brand=a',b,{method:'POST'})).status,403);
  if(!reject){assert.equal(smtp.messages.length,2);const r=await f.request('/api/lead/aaaaaaaaaaaaaaaa/0','',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Synthetic Visitor',email:'visitor@example.invalid',consent:true})});assert.equal(r.status,200);await until(async()=>smtp.messages.length,v=>v===3);assert.match(smtp.messages[2],/Reply-To: visitor@example.invalid/i);}
  else assert.equal(smtp.messages.length,0);
 }finally{await f.close();await smtp.close()}
});
