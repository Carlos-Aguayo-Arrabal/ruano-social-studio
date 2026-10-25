import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable,PassThrough} from 'node:stream';
import {mkdtemp,readdir,readFile,writeFile,mkdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {receiveBinary,cleanInterruptedUploads} from '../lib/binary-transfer.mjs';
import {fixture,photo} from './helpers.mjs';

test('binary receiver rejects invalid, oversized and interrupted streams and removes temporary files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ruano-transfer-'));
 try{
  for(const source of [Readable.from([Buffer.alloc(20)]),Readable.from([photo]),Readable.from((async function*(){yield photo.subarray(0,4);throw Error('synthetic interruption');})())]){
   await assert.rejects(receiveBinary(source,dir,{maxBytes:8,kind:'jpg'}));
   assert.deepEqual(await readdir(dir),[]);
  }
  const upload=await receiveBinary(Readable.from([photo.subarray(0,2),photo.subarray(2)]),dir,{maxBytes:photo.length,kind:'jpg'});
  assert.equal(upload.bytes,photo.length);assert.deepEqual(await readFile(upload.path),photo);await upload.cleanup();assert.deepEqual(await readdir(dir),[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('only four active binary receivers are admitted and slots are released after aborts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ruano-transfer-')),sources=Array.from({length:4},()=>new PassThrough());
 const pending=sources.map(s=>receiveBinary(s,dir,{maxBytes:4096,kind:'jpg'}).then(()=>false,()=>true));
 try{
  await assert.rejects(receiveBinary(Readable.from([photo]),dir,{maxBytes:photo.length,kind:'jpg'}),e=>e.status===429);
  while(sources.some(s=>s.listenerCount('error')===0)) await new Promise(r=>setTimeout(r,5));
  for(const s of sources)s.destroy(Error('synthetic abort'));
  assert.ok((await Promise.all(pending)).every(Boolean));assert.deepEqual(await readdir(dir),[]);
  const r=await receiveBinary(Readable.from([photo]),dir,{maxBytes:photo.length,kind:'jpg'});await r.cleanup();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('startup cleanup removes only reserved partials and does not follow symlinks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ruano-transfer-')),outside=await mkdtemp(join(tmpdir(),'ruano-outside-'));
 try{
  const name='.upload-'+ 'a'.repeat(32)+'.tmp',resource=join(dir,'a','101');await mkdir(resource,{recursive:true});
  await writeFile(join(resource,name),'partial');await writeFile(join(resource,'keep.jpg'),photo);await writeFile(join(resource,'.other.tmp'),'preserved');
  await writeFile(join(outside,name),'outside');await symlink(outside,join(dir,'external'));await symlink(outside,join(dir,'a','external'));
  await cleanInterruptedUploads(dir);assert.deepEqual((await readdir(resource)).sort(),['.other.tmp','keep.jpg']);assert.equal(await readFile(join(outside,name),'utf8'),'outside');
 }finally{await rm(dir,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('invalid replacement preserves existing media; concurrent jpg/mp4 replacement commits one file; downloads and restart preserve bytes',async()=>{
 const f=await fixture();try{
  let cookie=await f.login();const path='/api/media/a/synthetic?i=0';
  assert.equal((await f.request(path,cookie,{method:'PUT',body:photo})).status,200);
  assert.equal((await f.request(path,cookie,{method:'PUT',body:'invalid'})).status,400);
  assert.deepEqual(Buffer.from(await(await f.request('/api/media/a/synthetic/0.jpg',cookie)).arrayBuffer()),photo);
  const mp4=Buffer.alloc(1024);mp4.write('ftyp',4);
  const results=await Promise.all([f.request(path,cookie,{method:'PUT',body:photo}),f.request(path+'&type=video',cookie,{method:'PUT',body:mp4})]);assert.ok(results.every(r=>r.status===200));
  const list=await(await f.request('/api/media/a/synthetic',cookie)).json();assert.equal(list.length,1);
  const expected=list[0].file.endsWith('.mp4')?mp4:photo;
  const other=await f.login('testb');assert.equal((await f.request('/api/media/a/synthetic/'+list[0].file,other)).status,403);
  // Simulate a hard stop residue; no route lists or serves the partial.
  const dir=join(f.dir,'media','a','synthetic'),partial='.upload-'+ 'b'.repeat(32)+'.tmp';await writeFile(join(dir,partial),'partial');
  assert.equal((await f.request('/api/media/a/synthetic/'+partial,cookie)).status,404);
  await f.stop();await f.launch();assert.equal((await f.request('/api/me',cookie)).status,200);
  assert.deepEqual(Buffer.from(await(await f.request('/api/media/a/synthetic/'+list[0].file,cookie)).arrayBuffer()),expected);
  assert.deepEqual(await readdir(dir),[list[0].file]);
 }finally{await f.close();}
});

test('HTTP disconnect cleans partial upload and oversize returns 413 without replacing valid bytes',async()=>{
 const {request}=await import('node:http');const f=await fixture();
 try{
  const cookie=await f.login(),path='/api/media/a/abort?i=0';assert.equal((await f.request(path,cookie,{method:'PUT',body:photo})).status,200);
  const oversized=Buffer.alloc(8*1024*1024+1);photo.copy(oversized);
  assert.equal((await f.request(path,cookie,{method:'PUT',body:oversized})).status,413);
  const dir=join(f.dir,'media','a','abort');
  const req=request(f.origin+path,{method:'PUT',headers:{Cookie:cookie,'Content-Length':8*1024*1024}});req.on('error',()=>{});req.write(photo);
  try {
   for(let i=0;i<100;i++){if((await readdir(dir)).some(n=>n.startsWith('.upload-')))break;await new Promise(r=>setTimeout(r,10));}
   assert.ok((await readdir(dir)).some(n=>n.startsWith('.upload-')));
  }finally{req.destroy();}
  for(let i=0;i<100;i++){if((await readdir(dir)).length===1)break;await new Promise(r=>setTimeout(r,10));}
  assert.deepEqual(await readdir(dir),['0.jpg']);
  assert.deepEqual(Buffer.from(await(await f.request('/api/media/a/abort/0.jpg',cookie)).arrayBuffer()),photo);
  assert.equal((await f.request('/health')).status,200);
 }finally{await f.close();}
});
