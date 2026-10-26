import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('synthetic fdatasync probe reports bounded work and preserves its parent files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ruano-probe-test-'));
 try{
  await writeFile(join(dir,'sentinel'),'keep');
  let stdout;try{({stdout}=await exec(process.execPath,['scripts/probe-fdatasync.mjs',dir,'workers=2','mib=1','rounds=1']));}catch(e){if(e.code!==2)throw e;stdout=e.stdout;}
  const result=JSON.parse(stdout);assert.equal(result.totalBytes,2*1048576);assert.equal(result.syncMs.count,2);assert.equal(result.transferMs.count,2);assert.equal(result.syntheticOnly,true);assert.equal(typeof result.accepted,'boolean');
  assert.deepEqual(await readdir(dir),['sentinel']);assert.equal(await readFile(join(dir,'sentinel'),'utf8'),'keep');
  await assert.rejects(exec(process.execPath,['scripts/probe-fdatasync.mjs',dir,'workers=200']));assert.deepEqual(await readdir(dir),['sentinel']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
