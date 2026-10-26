import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Guard,Stop,Reservations,Journal,supervise} from '../lib/synthetic-supervisor.mjs';
const MiB=1048576;
const sample=(at=0,extra={})=>({at,rss:90*MiB,heap:16*MiB,external:8*MiB,arrayBuffers:4*MiB,current:180*MiB,dirty:4*MiB,writeback:0,swap:0,memoryMax:256*MiB,swapMax:0,cpuQuota:1,cpuPercent:20,free:12*1024**3,inodeFreeRatio:.9,dataset:MiB,logBytes:0,oomKills:0,oomEvents:0,running:true,health:true,healthMs:10,...extra});
const stopped=(fn,reason)=>assert.throws(fn,e=>e instanceof Stop&&e.reason===reason);
test('supervisor fails closed on OOM, swap, limits, disk, malformed observations and hard duration',()=>{
 for(const [change,reason] of [[{oomKills:1},'oom'],[{oomEvents:1},'oom'],[{oomKilled:true},'oom'],[{swap:1},'resource-configuration'],[{memoryMax:512*MiB},'resource-configuration'],[{cpuQuota:2},'resource-configuration'],[{swapMax:MiB},'resource-configuration'],[{free:1},'disk-free'],[{inodeFreeRatio:.01},'disk-free'],[{dataset:900*MiB},'dataset'],[{rss:NaN},'observation-invalid'],[{logBytes:128*MiB},'log-budget'],[{running:false},'application-exit'],[{integrity:false},'integrity']])stopped(()=>new Guard().tick(sample(0,change)),reason);
 const g=new Guard({durationMs:2000});g.tick(sample());stopped(()=>g.tick(sample(2000)),'duration');
 const stale=new Guard();stale.tick(sample());stopped(()=>stale.tick(sample(11000)),'observation-stale');
});
test('health, memory, buffers, dirty/writeback and CPU use sustained windows; clean cache alone is allowed',()=>{
 const h=new Guard();h.tick(sample(0,{health:false}));h.tick(sample(1,{health:false}));stopped(()=>h.tick(sample(2,{health:false})),'health');
 for(const [change,reason,hold] of [[{rss:170*MiB},'rss',60000],[{heap:70*MiB},'heap',60000],[{external:90*MiB,arrayBuffers:20*MiB},'buffers',60000],[{current:255*MiB,dirty:40*MiB},'writeback',60000],[{cpuPercent:99,healthMs:700},'cpu-health',300000]]){
  const g=new Guard();for(let t=0;t<hold;t+=1000)g.tick(sample(t,change));stopped(()=>g.tick(sample(hold,change)),reason);
 }
 const clean=new Guard();for(let t=0;t<120000;t+=1000)clean.tick(sample(t,{current:255*MiB,dirty:0}));
});
test('default growth window detects sustained RSS rise after warmup but accepts a plateau',()=>{
 const g=new Guard(),plateau=new Guard();let detected=false;
 for(let t=0;t<=3600000;t+=1000){plateau.tick(sample(t));try{g.tick(sample(t,{rss:(80+t/60000*1.1)*MiB}));}catch(e){assert.equal(e.reason,'sustained-growth');detected=true;break;}}
 assert.equal(detected,true);assert.ok(g.rows.length<=32);
});
test('reservations serialize competing admissions, persist before use and retain uncertain flights',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ruano-ledger-'));try{
  const r=await Reservations.create(dir,{userMax:1000,tenantMax:1000,datasetMax:1000,minFree:100}),disk={used:0,free:10000};
  const results=await Promise.allSettled([r.reserve({tenant:'a',user:'a1',bytes:500},disk),r.reserve({tenant:'a',user:'a1',bytes:500},disk)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);const id=results.find(x=>x.status==='fulfilled').value;
  assert.equal(JSON.parse(await readFile(r.path)).pending[0].id,id);assert.equal((await stat(r.path)).mode&511,384);
  await r.complete(id,500);assert.equal(JSON.parse(await readFile(r.path)).committed.length,1);
  await assert.rejects(Reservations.create(dir));
  await assert.rejects(r.reserve({tenant:'b',user:'a1',bytes:1},disk),e=>e.reason==='reservation-invalid');
  const r2=await Reservations.create(await mkdtemp(join(dir,'nested-')));const pending=await r2.reserve({tenant:'b',user:'b1',bytes:1},{used:0,free:12*1024**3});await r2.fail(pending);assert.equal(r2.pending.size,1);assert.equal(r2.frozen,true);await assert.rejects(r2.reserve({tenant:'b',user:'b1',bytes:1},disk),e=>e.reason==='reservations-frozen');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('disk headroom reservation includes all flights; known cleanup releases only its own reservation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ruano-reserve-'));try{
  const r=await Reservations.create(dir,{minFree:100});const id=await r.reserve({tenant:'a',user:'a1',bytes:100},{used:0,free:400});
  await assert.rejects(r.reserve({tenant:'b',user:'b1',bytes:100},{used:0,free:400}),e=>e.reason==='disk-reservation');await r.fail(id,{cleaned:true});assert.equal(r.pending.size,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('bounded private journal refuses overflow and supervisor stops on hung sampling or cancellation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ruano-journal-'));try{
  const j=await Journal.create(join(dir,'metrics'),2200);await j.append({metric:1});await assert.rejects(j.append({value:'x'.repeat(200)}),e=>e.reason==='log-budget');await j.close();assert.ok((await stat(join(dir,'metrics'))).size<=2200);
  let calls=0;const r=await supervise({sample:()=>new Promise(()=>{}),stop:async reason=>{calls++;assert.equal(reason,'observation-timeout');},journal:{append:async()=>{}},probeTimeoutMs:10});assert.equal(r.reason,'observation-timeout');assert.equal(calls,1);
  const c=new AbortController();c.abort();assert.equal((await supervise({sample:async()=>sample(),stop:async()=>{},journal:{append:async()=>{}},signal:c.signal})).reason,'cancelled');
 }finally{await rm(dir,{recursive:true,force:true});}
});
