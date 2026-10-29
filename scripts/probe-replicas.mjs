// Negative capability probe with two temporary local processes, never live data.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {fixture} from '../tests/helpers.mjs';
const runtime={APP_USERNAME:'replica-owner',APP_PASSWORD:randomBytes(32).toString('hex'),APP_SESSION_SECRET:randomBytes(48).toString('hex')};
const a=await fixture({runtime});let b;
try{
 b=await fixture({runtime:{...runtime,DATA_DIR:a.dir}});
 const cookie=await a.login('replica-owner',runtime.APP_PASSWORD);
 assert.equal((await a.request('/api/me',cookie)).status,200);
 const freshOnB=(await b.request('/api/me',cookie)).status;
 await b.stop();await b.launch();const afterReloadOnB=(await b.request('/api/me',cookie)).status;
 assert.equal((await a.request('/logout',cookie)).status,303);const afterLogoutOnA=(await a.request('/api/me',cookie)).status,afterLogoutOnB=(await b.request('/api/me',cookie)).status;
 const result={syntheticOnly:true,diagnosticCompleted:true,multiReplicaSupported:freshOnB===200&&afterLogoutOnB===401,freshOnB,afterReloadOnB,afterLogoutOnA,afterLogoutOnB,requiredReplicas:1};
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/replica-results.json',JSON.stringify(result,null,2));
 console.log('::warning title=Single replica capability::'+JSON.stringify(result));
}finally{await b?.close();await a.close();}
