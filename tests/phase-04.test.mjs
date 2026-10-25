import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PassThrough,Readable} from 'node:stream';
import {fixture,photo} from './helpers.mjs';
import {receiveBinary} from '../lib/binary-transfer.mjs';

test('photo idempotency persists across concurrent retry, lost response and restart, rejects conflicting bytes and remains tenant/user scoped',async()=>{
 const f=await fixture({start:false});try{
  f.store.data.b.properties=[{id:101}];await writeFile(join(f.dir,'store.json'),JSON.stringify(f.store));await f.launch();
  const a=await f.login(),b=await f.login('testb'),key='e'.repeat(32),options={method:'POST',body:photo,headers:{'Idempotency-Key':key}};
  const send=(cookie=a,brand='a',opts=options)=>f.request('/api/photos/101?brand='+brand,cookie,opts);
  const results=await Promise.all([send(),send()]);assert.ok(results.every(r=>r.status===201));const [first,second]=await Promise.all(results.map(r=>r.json()));assert.equal(first.id,second.id);
  const other=await send(b,'b');assert.equal(other.status,201);assert.notEqual((await other.json()).id,first.id);
  assert.equal((await send(b,'a')).status,403);
  assert.equal((await send(a,'a',{...options,body:Buffer.concat([photo,Buffer.from('different')])})).status,409);
  assert.equal((await send(a,'a',{...options,headers:{'Idempotency-Key':'../invalid'}})).status,400);
  await f.stop();await f.launch();assert.equal((await send()).status,201);
  const manifest=await(await f.request('/api/photos/101?brand=a',a)).json();assert.equal(manifest.photos.length,1);
  assert.deepEqual(Buffer.from(await(await f.request('/api/photos/101/'+first.id+'?brand=a',a)).arrayBuffer()),photo);
  assert.deepEqual((await readdir(join(f.dir,'photos-v2','a','101'))).sort(),[first.id+'.jpg','index.json'].sort());
 }finally{await f.close();}
});

test('active quotas enforce user 2, tenant 3 and global 4 without starving a different tenant; abort releases all counters',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ruano-quota-')),pending=[],sources=[];
 const start=(userId,tenantId)=>{const source=new PassThrough();sources.push(source);pending.push(receiveBinary(source,dir,{maxBytes:4096,kind:'jpg',userId,tenantId}).then(()=>false,()=>true));};
 const reject=(userId,tenantId)=>assert.rejects(receiveBinary(Readable.from([photo]),dir,{maxBytes:4096,kind:'jpg',userId,tenantId}),e=>e.status===429);
 try{
  start('a1','a');start('a1','a');await reject('a1','a');
  start('a2','a');await reject('a3','a');
  start('b1','b');await reject('b2','b');
  for(const source of sources)source.destroy(Error('synthetic cancellation'));assert.ok((await Promise.all(pending)).every(Boolean));assert.deepEqual(await readdir(dir),[]);
  const next=await receiveBinary(Readable.from([photo]),dir,{maxBytes:4096,kind:'jpg',userId:'a1',tenantId:'a'});await next.cleanup();
 }finally{for(const s of sources)s.destroy();await Promise.all(pending);await rm(dir,{recursive:true,force:true});}
});
