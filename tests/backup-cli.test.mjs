import test from 'node:test';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {rm,access} from 'node:fs/promises';import {fixture,root} from './helpers.mjs';import {inventory} from '../lib/photo-migration.mjs';
const run=promisify(execFile);
test('offline backup CLI requires confirmation and restores the complete synthetic tree without overwrite',async()=>{
 const f=await fixture({start:false}),backup=f.dir+'-cli-backup',restored=f.dir+'-cli-restored';try{
  await assert.rejects(run(process.execPath,['scripts/photo-storage.mjs','backup',f.dir,backup],{cwd:root}));await assert.rejects(access(backup));
  const before=await inventory(f.dir),r=await run(process.execPath,['scripts/photo-storage.mjs','backup',f.dir,backup,'--offline-confirmed'],{cwd:root});assert.equal(JSON.parse(r.stdout).verified,true);assert.deepEqual(await inventory(f.dir),before);
  await run(process.execPath,['scripts/photo-storage.mjs','restore',backup,restored],{cwd:root});assert.deepEqual(await inventory(restored),before);
  await assert.rejects(run(process.execPath,['scripts/photo-storage.mjs','restore',backup,restored],{cwd:root}));
 }finally{await f.close();await rm(backup,{recursive:true,force:true});await rm(restored,{recursive:true,force:true});}
});
