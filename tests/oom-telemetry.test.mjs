import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {root} from './helpers.mjs';
test('opt-in process telemetry writes a bounded private gauge with no environment or payload fields',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ruano-gauge-')),path=join(dir,'gauge.json');try{
  await promisify(execFile)(process.execPath,['--import','./lib/oom-telemetry.mjs','--input-type=module','-e','setTimeout(()=>{},500)'],{cwd:root,env:{PATH:process.env.PATH,RUANO_MEMORY_LOG:path,PRIVATE_TEST_VALUE:'not-for-the-gauge'}});
  const bytes=await readFile(path),data=JSON.parse(bytes);assert.equal(bytes.length,1024);assert.equal((await stat(path)).mode&511,384);for(const field of ['rss','heapUsed','heapTotal','external','arrayBuffers'])assert.ok(Number.isFinite(data[field])&&data[field]>=0);assert.equal(bytes.includes('not-for-the-gauge'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
