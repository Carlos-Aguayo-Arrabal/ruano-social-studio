// Disposable CI-only capacity probe. The app and client share only an isolated
// loopback namespace, never a host/private network, port or production volume.
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const image=process.argv[2]||'ruano-staging-check',id='ruano-soak-'+randomUUID(),app=id+'-app',volume=id+'-data';
const tmp=await mkdtemp(join(tmpdir(),'ruano-soak-')),cases=[];
const run=(args,input='')=>new Promise((resolve,reject)=>{const p=spawn('docker',args,{stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',c=>c===0?resolve(out.trim()):reject(Error('docker '+args[0]+' exit '+c+': '+err.slice(-1000))));p.stdin.end(input);});
let madeApp=false,madeVolume=false;
const report={memoryLimitBytes:256*1024*1024,cpus:1,network:'none',clientCgroup:'separate',clientMemoryBytes:512*1024*1024,productionData:false,cases,samples:[]};
const state=async()=>{const [running,oomKilled,exitCode]=(await run(['inspect','--format','{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}',app])).split(' ');return {running:running==='true',oomKilled:oomKilled==='true',exitCode:Number(exitCode)};};
async function memory(){try{const values=await run(['exec',app,'sh','-c',"for f in memory.current memory.peak memory.swap.current memory.swap.max memory.max; do cat /sys/fs/cgroup/$f; done; awk '/^anon /{print $2}' /sys/fs/cgroup/memory.stat; awk '/^VmRSS:/{print $2*1024}' /proc/1/status; awk '/^usage_usec/{print $2}' /sys/fs/cgroup/cpu.stat"]);const [currentBytes,peakBytes,swapCurrentBytes,swapMaxBytes,configuredLimitBytes,anonBytes,rssBytes,cpuUsec]=values.split(/\s+/).map(Number);return {currentBytes,peakBytes,swapCurrentBytes,swapMaxBytes,configuredLimitBytes,anonBytes,rssBytes,cpuUsec,includesFileCache:true};}catch{return null}}
try{
 const env=join(tmp,'synthetic.env');await writeFile(env,['APP_USERNAME=capacity-owner','APP_PASSWORD='+randomBytes(24).toString('hex'),'APP_SESSION_SECRET='+randomBytes(48).toString('hex'),'OLLAMA_URL=http://127.0.0.1:1'].join('\n'),{mode:0o600});
 await run(['volume','create',volume]);madeVolume=true;
 await run(['create','--name',app,'--network','none','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=32m','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--memory-swap','256m','--cpus','1','--pids-limit','128','--env-file',env,'--mount',`type=volume,source=${volume},target=/app/data`,'--health-interval','1s','--health-start-period','1s',image]);madeApp=true;await run(['start',app]);
 for(let i=0;i<40;i++){if(await run(['inspect','--format','{{.State.Health.Status}}',app])==='healthy')break;await new Promise(r=>setTimeout(r,500));}
 assert.equal(await run(['inspect','--format','{{.State.Health.Status}}',app]),'healthy');
 assert.equal(await run(['inspect','--format','{{.HostConfig.NetworkMode}}',app]),'none');
 const client=async script=>{
  const name=id+'-client-'+randomUUID();
  try{return await run(['run','--name',name,'-i','--network','container:'+app,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--memory-swap','512m','--cpus','1','--pids-limit','64','--env-file',env,image,'node','--input-type=module'],script);}
  catch(e){const info=JSON.parse(await run(['inspect','--format','{{json .State}}',name]));(report.clientFailures||=[]).push({oomKilled:info.OOMKilled,exitCode:info.ExitCode});throw e;}
  finally{await run(['rm','-f',name]).catch(()=>{});}
 };
 const common=`import assert from 'node:assert/strict';import {Readable} from 'node:stream';import {performance} from 'node:perf_hooks';import {createHash} from 'node:crypto';import {request as httpRequest} from 'node:http';
const req=(p,o={})=>fetch('http://127.0.0.1:3000'+p,{redirect:'manual',signal:AbortSignal.timeout(90000),...o});
const login=await req('/login',{method:'POST',body:new URLSearchParams({username:process.env.APP_USERNAME,password:process.env.APP_PASSWORD})});assert.equal(login.status,303);
const cookie=login.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie};
function body(bytes,video=false){return Readable.from((async function*(){let sent=0;const first=Buffer.alloc(Math.min(bytes,65536));if(video)first.write('ftyp',4);else{first[0]=255;first[1]=216;first[2]=255;}yield first;sent+=first.length;while(sent<bytes){const n=Math.min(65536,bytes-sent);yield Buffer.alloc(n);sent+=n;}})());}
async function upload(path,bytes,video=false,sendHeaders=headers){const start=performance.now();return new Promise(resolve=>{
 let done=false;const source=body(bytes,video),finish=value=>{if(done)return;done=true;source.destroy();resolve({...value,ms:Math.round(performance.now()-start)});};
 const out=httpRequest({hostname:'127.0.0.1',port:3000,path,method:'PUT',headers:sendHeaders},r=>{
  // Stop generation on early 413/429. The previous fetch-based load client
  // exited 137 at high concurrency while the application remained alive.
  source.unpipe(out);source.destroy();if(!out.writableEnded)out.end();
  r.resume();r.on('end',()=>finish({status:r.statusCode}));r.on('error',e=>finish({status:r.statusCode,networkError:e.code||e.name}));
 });
 out.setTimeout(90000,()=>out.destroy(Error('synthetic client timeout')));out.on('error',e=>finish({status:null,networkError:e.code||e.name}));source.on('error',e=>out.destroy(e));source.pipe(out);
});}`;
 await client(common+`const r=await req('/api/sync',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({brands:{upsert:['a','b'].map(id=>({id,name:'Synthetic '+id}))},data:Object.fromEntries(['a','b'].map(id=>[id,{properties:{upsert:[{id:101}]}}]))})});assert.equal(r.status,200);
for(const name of ['soaka1','soaka2','soakb1','soakb2']){const r=await req('/api/users',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({username:name,password:process.env.APP_PASSWORD,role:'agency',brands:[name[4]]})});assert.equal(r.status,200);}`);
 report.baselineMemory=await memory();assert.equal(report.baselineMemory.configuredLimitBytes,256*1024*1024);assert.equal(report.baselineMemory.swapMaxBytes,0);
 const phaseMs=60000;report.plannedDurationMs=phaseMs*3;report.phaseConcurrency=[1,2,8];
 let sampling=true;
 const sampleLoop=(async()=>{while(sampling){const m=await memory();if(m)report.samples.push({at:Date.now(),...m});await new Promise(r=>setTimeout(r,1000));}})();
 let sustained;
 try{
 sustained=JSON.parse(await client(common+`
const accounts=[];for(const name of ['soaka1','soaka2','soakb1','soakb2']){const r=await req('/login',{method:'POST',body:new URLSearchParams({username:name,password:process.env.APP_PASSWORD})});assert.equal(r.status,303);accounts.push({brand:name[4],headers:{Cookie:r.headers.get('set-cookie').split(';')[0]}});}
const percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))]||0;
async function cancel(a){return new Promise(resolve=>{const start=performance.now(),out=httpRequest({hostname:'127.0.0.1',port:3000,path:'/api/media/'+a.brand+'/cancel?i=0&type=video',method:'PUT',headers:{...a.headers,'Content-Length':120*1024*1024}},r=>{r.resume();r.on('end',()=>resolve({status:r.statusCode}));});out.on('error',()=>resolve({intentionalCancellation:true,ms:Math.round(performance.now()-start)}));out.write(Buffer.from([0,0,0,0,102,116,121,112]));setTimeout(()=>out.destroy(),50);});}
const phases=[];for(const concurrency of [1,2,8]){
 const start=performance.now(),results=[],health=[],byTenant={a:{},b:{}};let batches=0,cancellations=0,oversized=0;
 while(performance.now()-start<${phaseMs}){
  const cycle=performance.now(),video=batches%10===0,bytes=video?120*1024*1024:batches%3===0?8*1024*1024:256*1024;
  const batch=Promise.all(Array.from({length:concurrency},async(_,i)=>{const a=accounts[(batches+i)%4],r=await upload('/api/media/'+a.brand+'/slot-'+(i%4)+'?i=0'+(video?'&type=video':''),bytes,video,a.headers);byTenant[a.brand][String(r.status)]=(byTenant[a.brand][String(r.status)]||0)+1;return r;}));
  const hs=performance.now(),h=await req('/health');await h.text();health.push({status:h.status,ms:Math.round(performance.now()-hs)});assert.equal(h.status,200);
  const r=await batch;results.push(...r);assert.ok(r.every(v=>[200,429].includes(v.status)),'unexpected upload outcome');
  if(batches%5===0){await cancel(accounts[batches%4]);cancellations++;}
  if(batches%10===0){const over=await upload('/api/media/a/oversize?i=0',8*1024*1024+1,false,accounts[0].headers);assert.equal(over.status,413);oversized++;}
  if(batches%10===0){const cross=await req('/api/media/a/slot-0',{headers:accounts[2].headers});assert.equal(cross.status,403);await cross.text();}
  batches++;await new Promise(r=>setTimeout(r,Math.max(0,1000-(performance.now()-cycle))));
 }
 const times=results.map(r=>r.ms);phases.push({concurrency,durationMs:Math.round(performance.now()-start),batches,requests:results.length,statuses:results.reduce((m,r)=>(m[String(r.status)]=(m[String(r.status)]||0)+1,m),{}),byTenant,latencyMs:{p50:percentile(times,.5),p95:percentile(times,.95),p99:percentile(times,.99),max:Math.max(...times)},health:{requests:health.length,statuses:[...new Set(health.map(r=>r.status))],p95Ms:percentile(health.map(r=>r.ms),.95)},intentionalCancellations:cancellations,oversizedRejected:oversized,unexpectedFailures:results.filter(r=>![200,429].includes(r.status)).length});
}
console.log(JSON.stringify({phases}));`));
 }finally{sampling=false;await sampleLoop;}
 report.phases=sustained.phases;
 const samples=report.samples;assert.ok(samples.length>=120,'Insufficient duration/sample coverage');
 const cpu=samples.slice(1).map((s,i)=>100*(s.cpuUsec-samples[i].cpuUsec)/((s.at-samples[i].at)*1000));
 const sorted=[...cpu].sort((a,b)=>a-b);
 report.profile={samples:samples.length,durationMs:samples.at(-1).at-samples[0].at,peakCgroupBytes:Math.max(...samples.map(s=>s.peakBytes)),maxSampledRssBytes:Math.max(...samples.map(s=>s.rssBytes)),maxSampledAnonBytes:Math.max(...samples.map(s=>s.anonBytes)),startRssBytes:samples[0].rssBytes,endRssBytes:samples.at(-1).rssBytes,swapMaxBytes:Math.max(...samples.map(s=>s.swapCurrentBytes)),cpuAveragePercent:100*(samples.at(-1).cpuUsec-samples[0].cpuUsec)/((samples.at(-1).at-samples[0].at)*1000),cpuP95Percent:sorted[Math.floor(sorted.length*.95)],cpuMaxSampledPercent:Math.max(...cpu)};
 assert.equal(report.profile.swapMaxBytes,0);assert.equal((await state()).oomKilled,false);assert.equal((await state()).running,true);
 // A hard stop while a partial exists must preserve an older valid file.
 const before=JSON.parse(await client(common+`assert.equal((await upload('/api/media/a/stable?i=0',256*1024)).status,200);const r=await req('/api/media/a/stable/0.jpg',{headers});const hash=createHash('sha256');for await(const chunk of r.body)hash.update(chunk);console.log(JSON.stringify({sha256:hash.digest('hex')}));`));
 const pending=client(common+`await new Promise(resolve=>{const out=httpRequest({hostname:'127.0.0.1',port:3000,path:'/api/media/a/stable?i=0&type=video',method:'PUT',headers:{...headers,'Content-Length':120*1024*1024}},r=>{r.resume();r.on('end',resolve)});out.on('error',resolve);out.setTimeout(30000,()=>out.destroy());out.write(Buffer.from([0,0,0,0,102,116,121,112]));});console.log(JSON.stringify({connectionClosed:true}));`);
 let partials=0;for(let i=0;i<30;i++){partials=Number(await run(['exec',app,'sh','-c',"find /app/data/media -name '.upload-*.tmp' | wc -l"]));if(partials>0)break;await new Promise(r=>setTimeout(r,100));}assert.ok(partials>0,'No in-flight upload observed for interruption test');
 await run(['kill','--signal','KILL',app]);await pending;const stopped=await state();assert.equal(stopped.oomKilled,false);assert.equal(stopped.exitCode,137);await run(['start',app]);
 for(let i=0;i<40;i++){if(await run(['inspect','--format','{{.State.Health.Status}}',app])==='healthy')break;await new Promise(r=>setTimeout(r,500));}assert.equal(await run(['inspect','--format','{{.State.Health.Status}}',app]),'healthy');
 const after=JSON.parse(await client(common+`const r=await req('/api/media/a/stable/0.jpg',{headers});assert.equal(r.status,200);let bytes=0;const hash=createHash('sha256');for await(const chunk of r.body){bytes+=chunk.length;hash.update(chunk);}assert.equal(bytes,256*1024);assert.equal((await req('/api/media/a/stable/0.mp4',{headers})).status,404);console.log(JSON.stringify({bytes,sha256:hash.digest('hex')}));`));
 assert.equal(after.sha256,before.sha256);
 const remaining=Number(await run(['exec',app,'sh','-c',"find /app/data/media /app/data/photos-v2 -name '.upload-*.tmp' | wc -l"]));assert.equal(remaining,0);
 report.interruption={intentionalSigkill:true,partialObserved:true,oomKilled:stopped.oomKilled,oldValidFilePreserved:true,sha256:after.sha256,incompleteVideoStatus:404,remainingPartials:remaining,healthyAfterRestart:true};
 report.success=true;
}catch(e){report.success=false;report.failure=e.message;if(madeApp)report.finalState=await state();process.exitCode=1;}
finally{
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/soak-results.json',JSON.stringify(report,null,2));console.log('::notice title=Soak summary::'+JSON.stringify({success:report.success,failure:report.failure,finalState:report.finalState,profile:report.profile,interruption:report.interruption}));
 for(const phase of report.phases||[])console.log('::notice title=Soak phase::'+JSON.stringify(phase));
 if(madeApp)await run(['rm','-f',app]);if(madeVolume)await run(['volume','rm',volume]);await rm(tmp,{recursive:true,force:true});
}
