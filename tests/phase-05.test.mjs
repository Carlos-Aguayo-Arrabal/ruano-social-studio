import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {prepareStaging} from '../scripts/prepare-staging.mjs';
test('exact staging plan pins source and optional tested base; independent perimeter credentials remain private; invalid domain/ref refused',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ruano-phase05-'));try{
 const opts={sourceSha:'a'.repeat(40),domain:'isolated-staging.example.invalid',nodeImage:'node@sha256:'+'b'.repeat(64)};
 const a=await prepareStaging(join(root,'one'),'ruano-stage-review',opts),b=await prepareStaging(join(root,'two'),'ruano-stage-second',opts);
 const plan=JSON.parse(await readFile(join(a.output,'easypanel-plan.json')));assert.equal(plan.source.commit,opts.sourceSha);assert.equal(plan.build.nodeImage,opts.nodeImage);assert.equal(plan.build.basePinned,true);assert.equal(plan.build.requiresPinnedBase,false);assert.equal(plan.domain.hostname,opts.domain);assert.equal(plan.storage.applicationDiskQuotaEnforced,false);assert.equal(plan.stagingEdgeNetwork.create,false);assert.equal(plan.perimeter.coversAllPaths,true);assert.equal(plan.domain.dnsConfigured,false);
 assert.equal((await stat(join(a.output,'perimeter.env'))).mode&511,384);const first=await readFile(join(a.output,'perimeter.env'),'utf8'),second=await readFile(join(b.output,'perimeter.env'),'utf8');assert.notEqual(first,second);
 assert.equal((await readFile(join(a.output,'compose.yml'),'utf8')).includes('image: ruano-staging:'+opts.sourceSha.slice(0,12)),true);
 for(const options of [{...opts,domain:'https://real.invalid'},{...opts,sourceSha:'main'},{...opts,nodeImage:'unknown:latest'}])await assert.rejects(prepareStaging(join(root,'refused'),'ruano-stage-rejected',options));
 await assert.rejects(stat(join(root,'refused')));await assert.rejects(prepareStaging(a.output,'ruano-stage-review',opts));assert.equal(await readFile(join(a.output,'perimeter.env'),'utf8'),first);
 }finally{await rm(root,{recursive:true,force:true});}
});
