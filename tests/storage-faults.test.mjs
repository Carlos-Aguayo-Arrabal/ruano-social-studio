import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,open,writeFile,readFile,rm,readdir,rename} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Readable} from 'node:stream';import {pipeline} from 'node:stream/promises';import {boundedFileWriter} from '../lib/bounded-file-writer.mjs';
for(const code of ['ENOSPC','EDQUOT','EIO'])test(`failed ${code} sync rejects, preserves valid original and permits a clean retry`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ruano-storage-fault-')),valid=join(dir,'valid.jpg'),partial=join(dir,'.upload-synthetic.tmp');try{
  const old=Buffer.from('synthetic-valid-original');await writeFile(valid,old);
  const openFile=async(...args)=>{const f=await open(...args);return {write:(...a)=>f.write(...a),close:()=>f.close(),datasync:async()=>{throw Object.assign(Error('synthetic sync error'),{code});}};};
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(64)]),boundedFileWriter(partial,{syncBytes:32,openFile})),e=>e.code===code);await rm(partial);
  assert.deepEqual(await readFile(valid),old);assert.deepEqual(await readdir(dir),['valid.jpg']);
  await pipeline(Readable.from([Buffer.from('synthetic-retry')]),boundedFileWriter(partial));await rename(partial,valid);assert.equal(await readFile(valid,'utf8'),'synthetic-retry');
 }finally{await rm(dir,{recursive:true,force:true});}
});
