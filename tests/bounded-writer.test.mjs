import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,open,rm,stat} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Readable} from 'node:stream';import {pipeline} from 'node:stream/promises';import {boundedFileWriter} from '../lib/bounded-file-writer.mjs';
test('writer bounds unsynced bytes, handles short writes and preserves exact data and private mode',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ruano-sync-')),path=join(dir,'new');let pending=0,maxPending=0,syncs=0;
 try{
  const input=Buffer.alloc(4*1024*1024+17,23);
  const openFile=async(...args)=>{const f=await open(...args);return {write:async(b,o,n,p)=>{const result=await f.write(b,o,Math.min(n,8192),p);pending+=result.bytesWritten;maxPending=Math.max(maxPending,pending);return result;},datasync:async()=>{await f.datasync();pending=0;syncs++;},close:()=>f.close()};};
  await pipeline(Readable.from([input]),boundedFileWriter(path,{syncBytes:1024*1024,openFile}));assert.equal(maxPending,1024*1024);assert.equal(pending,0);assert.equal(syncs,5);assert.deepEqual(await readFile(path),input);assert.equal((await stat(path)).mode&511,384);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('failed fdatasync closes descriptor and rejects rather than acknowledging an unsafe write',async()=>{
 let closed=0;const sink=boundedFileWriter('unused',{syncBytes:4,openFile:async()=>({write:async(b,o,n)=>({bytesWritten:n}),datasync:async()=>{throw Error('synthetic IO failure');},close:async()=>{closed++;}})});
 await assert.rejects(pipeline(Readable.from([Buffer.alloc(8)]),sink),/synthetic IO failure/);assert.equal(closed,1);
});
