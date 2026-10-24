// Disposable CI-only capacity probe. The app and client share only an isolated
// loopback namespace, never a host/private network, port or production volume.
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const image=process.argv[2]||'ruano-staging-check',id='ruano-capacity-'+randomUUID(),app=id+'-app',volume=id+'-data';
const tmp=await mkdtemp(join(tmpdir(),'ruano-capacity-')),cases=[];
const run=(args,input='')=>new Promise((resolve,reject)=>{const p=spawn('docker',args,{stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',c=>c===0?resolve(out.trim()):reject(Error('docker '+args[0]+' exit '+c+': '+err.slice(0,500))));p.stdin.end(input);});
let madeApp=false,madeVolume=false;
const report={memoryLimitBytes:256*1024*1024,cpus:1,network:'none',clientCgroup:'separate',productionData:false,cases};
const state=async()=>{const [running,oomKilled,exitCode]=(await run(['inspect','--format','{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}',app])).split(' ');return {running:running==='true',oomKilled:oomKilled==='true',exitCode:Number(exitCode)};};
async function memory(){try{const values=await run(['exec',app,'sh','-c',"cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak; awk '/^anon /{print $2}' /sys/fs/cgroup/memory.stat; awk '/^VmRSS:/{print $2*1024}' /proc/1/status"]);const [currentBytes,peakBytes,anonBytes,rssBytes]=values.split(/\s+/).map(Number);return {currentBytes,peakBytes,anonBytes,rssBytes,includesFileCache:true};}catch{return null}}
try{
 const env=join(tmp,'synthetic.env');await writeFile(env,['APP_USERNAME=capacity-owner','APP_PASSWORD='+randomBytes(24).toString('hex'),'APP_SESSION_SECRET='+randomBytes(48).toString('hex'),'OLLAMA_URL=http://127.0.0.1:1'].join('\n'),{mode:0o600});
 await run(['volume','create',volume]);madeVolume=true;
 await run(['create','--name',app,'--network','none','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=32m','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--cpus','1','--pids-limit','128','--env-file',env,'--mount',`type=volume,source=${volume},target=/app/data`,'--health-interval','1s','--health-start-period','1s',image]);madeApp=true;await run(['start',app]);
 for(let i=0;i<40;i++){if(await run(['inspect','--format','{{.State.Health.Status}}',app])==='healthy')break;await new Promise(r=>setTimeout(r,500));}
 assert.equal(await run(['inspect','--format','{{.State.Health.Status}}',app]),'healthy');
 assert.equal(await run(['inspect','--format','{{.HostConfig.NetworkMode}}',app]),'none');
 const client=script=>run(['run','--rm','-i','--network','container:'+app,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--cpus','1','--pids-limit','64','--env-file',env,image,'node','--input-type=module'],script);
 const common=`import assert from 'node:assert/strict';import {Readable} from 'node:stream';import {performance} from 'node:perf_hooks';
const req=(p,o={})=>fetch('http://127.0.0.1:3000'+p,{redirect:'manual',signal:AbortSignal.timeout(90000),...o});
const login=await req('/login',{method:'POST',body:new URLSearchParams({username:process.env.APP_USERNAME,password:process.env.APP_PASSWORD})});assert.equal(login.status,303);
const cookie=login.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie};
function body(bytes,video=false){return Readable.from((async function*(){let sent=0;const first=Buffer.alloc(Math.min(bytes,65536));if(video)first.write('ftyp',4);else{first[0]=255;first[1]=216;first[2]=255;}yield first;sent+=first.length;while(sent<bytes){const n=Math.min(65536,bytes-sent);yield Buffer.alloc(n);sent+=n;}})());}
async function upload(path,bytes,video=false){const start=performance.now();try{const r=await req(path,{method:'PUT',headers,body:body(bytes,video),duplex:'half'});await r.arrayBuffer();return {status:r.status,ms:Math.round(performance.now()-start)};}catch(e){return {status:null,networkError:e.cause?.code||e.name,ms:Math.round(performance.now()-start)};}}`;
 await client(common+`const r=await req('/api/sync',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({brands:{upsert:[{id:'capacity',name:'Synthetic capacity'}]},data:{capacity:{properties:{upsert:[{id:101,title:'Synthetic'}]}}}})});assert.equal(r.status,200);`);
 report.baselineMemory=await memory();
 const MiB=1024*1024;
 for(const [name,path,bytes,video,expected] of [
  ['photo-exact-4MiB','/api/photos/101/cover?brand=capacity',4*MiB,false,200],
  ['photo-over-4MiB','/api/photos/101/cover?brand=capacity',4*MiB+1,false,'reject'],
  ['image-exact-8MiB','/api/media/capacity/asset?i=0',8*MiB,false,200],
  ['image-over-8MiB','/api/media/capacity/asset?i=0',8*MiB+1,false,'reject'],
  ['video-exact-120MiB','/api/media/capacity/video?i=0&type=video',120*MiB,true,200],
  ['video-over-120MiB','/api/media/capacity/video?i=0&type=video',120*MiB+1,true,'reject'],
 ]){
  const value=JSON.parse(await client(common+`console.log(JSON.stringify(await upload(${JSON.stringify(path)},${bytes},${video})));`));
  const observed=await state();const result={name,bytes,expected,...value,...observed,memory:await memory()};cases.push(result);console.log('::notice title=Resource case::'+JSON.stringify(result));
  assert.equal(observed.running,true,'Application terminated during '+name);assert.equal(observed.oomKilled,false,'OOM during '+name);
  if(expected==='reject')assert.ok(value.status===null||[400,413,429].includes(value.status));else assert.equal(value.status,expected,name);
 }
 for(const concurrency of [4,8]){
  const result=JSON.parse(await client(common+`const start=performance.now();const results=await Promise.all(Array.from({length:${concurrency}},(_,i)=>upload('/api/media/capacity/concurrent-'+i+'?i=0',256*1024)));console.log(JSON.stringify({results,totalMs:Math.round(performance.now()-start)}));`));
  assert.ok(result.results.every(v=>[200,429].includes(v.status)));assert.ok(result.results.some(v=>v.status===200));const observed=await state();assert.equal(observed.running,true);assert.equal(observed.oomKilled,false);
  const item={name:'concurrent-256KiB-images',concurrency,...result,...observed,memory:await memory()};cases.push(item);console.log('::notice title=Resource concurrency::'+JSON.stringify(item));
 }
 report.disk=JSON.parse(await run(['exec','-i',app,'node','--input-type=module'],`import {readdir,stat} from 'node:fs/promises';import {join} from 'node:path';let bytes=0,files=0;async function walk(p){for(const f of await readdir(p)){const q=join(p,f),s=await stat(q);if(s.isDirectory())await walk(q);else{files++;bytes+=s.size;}}}await walk('/app/data');console.log(JSON.stringify({files,bytes}));`));
 report.success=true;
}catch(err){report.success=false;report.failure=err.message;if(madeApp)report.finalState=await state();process.exitCode=1;console.error('Resource validation failed:',err.message);}
finally{
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/resource-results.json',JSON.stringify(report,null,2));console.log('::notice title=Resource summary::'+JSON.stringify({success:report.success,caseCount:cases.length,memoryLimitBytes:report.memoryLimitBytes,disk:report.disk,finalState:report.finalState}));
 if(madeApp)await run(['rm','-f',app]);if(madeVolume)await run(['volume','rm',volume]);await rm(tmp,{recursive:true,force:true});
}
