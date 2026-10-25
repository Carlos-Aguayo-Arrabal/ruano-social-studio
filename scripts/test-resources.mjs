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
const report={memoryLimitBytes:256*1024*1024,cpus:1,network:'none',clientCgroup:'separate',clientMemoryBytes:512*1024*1024,productionData:false,cases};
const state=async()=>{const [running,oomKilled,exitCode]=(await run(['inspect','--format','{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}',app])).split(' ');return {running:running==='true',oomKilled:oomKilled==='true',exitCode:Number(exitCode)};};
async function memory(){try{const values=await run(['exec',app,'sh','-c',"for f in memory.current memory.peak memory.swap.current memory.swap.max; do cat /sys/fs/cgroup/$f; done; awk '/^anon /{print $2}' /sys/fs/cgroup/memory.stat; awk '/^VmRSS:/{print $2*1024}' /proc/1/status"]);const [currentBytes,peakBytes,swapCurrentBytes,swapMaxBytes,anonBytes,rssBytes]=values.split(/\s+/).map(Number);return {currentBytes,peakBytes,swapCurrentBytes,swapMaxBytes,anonBytes,rssBytes,includesFileCache:true};}catch{return null}}
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
async function upload(path,bytes,video=false){const start=performance.now();return new Promise(resolve=>{
 let done=false;const source=body(bytes,video),finish=value=>{if(done)return;done=true;source.destroy();resolve({...value,ms:Math.round(performance.now()-start)});};
 const out=httpRequest({hostname:'127.0.0.1',port:3000,path,method:'PUT',headers},r=>{
  // Early 413/429 must stop generation; fetch/undici kept generating rejected
  // synthetic bodies at high concurrency and exhausted the CLIENT cgroup.
  source.unpipe(out);source.destroy();if(!out.writableEnded)out.end();
  r.resume();r.on('end',()=>finish({status:r.statusCode}));r.on('error',e=>finish({status:r.statusCode,networkError:e.code||e.name}));
 });
 out.setTimeout(90000,()=>out.destroy(Error('synthetic client timeout')));out.on('error',e=>finish({status:null,networkError:e.code||e.name}));source.on('error',e=>out.destroy(e));source.pipe(out);
});}`;
 await client(common+`const r=await req('/api/sync',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({brands:{upsert:[{id:'capacity',name:'Synthetic capacity'}]},data:{capacity:{properties:{upsert:[{id:101,title:'Synthetic'}]}}}})});assert.equal(r.status,200);`);
 report.baselineMemory=await memory();assert.equal(report.baselineMemory?.swapMaxBytes,0,"Swap must be disabled for capacity validation");
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
  const observed=await state();const result={name,bytes,expected,...value,...observed,memory:await memory()};cases.push(result);console.log('Resource case '+JSON.stringify(result));
  assert.equal(observed.running,true,'Application terminated during '+name);assert.equal(observed.oomKilled,false,'OOM during '+name);
  if(expected==='reject')assert.equal(value.status,413,name);else assert.equal(value.status,expected,name);
 }
 for(const concurrency of [4,8]){
  const result=JSON.parse(await client(common+`const start=performance.now();const results=await Promise.all(Array.from({length:${concurrency}},(_,i)=>upload('/api/media/capacity/concurrent-'+i+'?i=0',256*1024)));console.log(JSON.stringify({results,totalMs:Math.round(performance.now()-start)}));`));
  assert.ok(result.results.every(v=>[200,429].includes(v.status)));assert.ok(result.results.some(v=>v.status===200));const observed=await state();assert.equal(observed.running,true);assert.equal(observed.oomKilled,false);
  const item={name:'concurrent-256KiB-images',concurrency,...result,...observed,memory:await memory()};cases.push(item);console.log('Resource concurrency '+JSON.stringify(item));
 }
 for(const concurrency of [1,2,4,8,16,32]){
  const result=JSON.parse(await client(common+`const start=performance.now();const pending=Promise.all(Array.from({length:${concurrency}},(_,i)=>upload('/api/media/capacity/large-'+i+'?i=0&type=video',120*1024*1024,true)));const health=await req('/health');await health.text();const results=await pending;console.log(JSON.stringify({results,healthStatus:health.status,totalMs:Math.round(performance.now()-start)}));`));
  const observed=await state(),item={name:'concurrent-120MiB-videos',concurrency,...result,...observed,memory:await memory()};cases.push(item);console.log('Resource videos '+JSON.stringify(item));
  assert.equal(observed.running,true,'Application terminated during concurrent valid videos');assert.equal(observed.oomKilled,false,'OOM during concurrent videos');assert.equal(result.healthStatus,200);assert.ok(result.results.every(r=>[200,429].includes(r.status)));assert.ok(result.results.some(r=>r.status===200));
 }
 const download=JSON.parse(await client(common+`const start=performance.now();const results=await Promise.all(Array.from({length:4},async()=>{const r=await req('/api/media/capacity/video/0.mp4',{headers});let bytes=0;const hash=createHash('sha256');for await(const chunk of r.body){bytes+=chunk.length;hash.update(chunk);}return {status:r.status,bytes,sha256:hash.digest('hex')};}));console.log(JSON.stringify({results,totalMs:Math.round(performance.now()-start)}));`));
 const downloadCase={name:'concurrent-120MiB-downloads',concurrency:4,...download,...await state(),memory:await memory()};cases.push(downloadCase);console.log('Resource downloads '+JSON.stringify(downloadCase));
 assert.ok(download.results.every(r=>r.status===200&&r.bytes===120*MiB));assert.equal(downloadCase.running,true);assert.equal(downloadCase.oomKilled,false);
 await run(['restart',app]);
 for(let i=0;i<40;i++){if(await run(['inspect','--format','{{.State.Health.Status}}',app])==='healthy')break;await new Promise(r=>setTimeout(r,500));}
 assert.equal(await run(['inspect','--format','{{.State.Health.Status}}',app]),'healthy');
 const afterRestart=JSON.parse(await client(common+`const r=await req('/api/media/capacity/video/0.mp4',{headers});let bytes=0,header;const hash=createHash('sha256');for await(const chunk of r.body){if(!header)header=Buffer.from(chunk).subarray(4,8).toString();bytes+=chunk.length;hash.update(chunk);}assert.equal(r.status,200);assert.equal(bytes,120*1024*1024);assert.equal(header,'ftyp');console.log(JSON.stringify({status:r.status,bytes,header,sha256:hash.digest('hex')}));`));
 assert.ok(download.results.every(r=>r.sha256===afterRestart.sha256),'Video checksum changed across restart');
 report.restart={healthy:true,...afterRestart,...await state()};
 report.disk=JSON.parse(await run(['exec','-i',app,'node','--input-type=module'],`import {readdir,stat} from 'node:fs/promises';import {join} from 'node:path';let bytes=0,files=0,partials=0;async function walk(p){for(const f of await readdir(p)){const q=join(p,f),s=await stat(q);if(s.isDirectory())await walk(q);else{files++;bytes+=s.size;if(/^\\.upload-/.test(f))partials++;}}}await walk('/app/data');console.log(JSON.stringify({files,bytes,partials}));`));
 assert.equal(report.disk.partials,0);
 report.success=true;
}catch(err){report.success=false;report.failure=err.message;if(madeApp)report.finalState=await state();process.exitCode=1;console.error('Resource validation failed:',err.message);}
finally{
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/resource-results.json',JSON.stringify(report,null,2));console.log('::notice title=Resource summary::'+JSON.stringify({success:report.success,failure:report.failure,memoryLimitBytes:report.memoryLimitBytes,caseCount:cases.length,clientFailures:report.clientFailures,disk:report.disk,restart:report.restart,finalState:report.finalState}));
 const compact=cases.map(({results,memory,...c})=>({...c,...(results?{statuses:results.reduce((m,r)=>(m[String(r.status)]=(m[String(r.status)]||0)+1,m),{}),maxRequestMs:Math.max(...results.map(r=>r.ms||0)),networkErrors:results.filter(r=>r.networkError).map(r=>r.networkError)}:{}),memory}));
 for(let i=0;i<compact.length;i+=3)console.log('::notice title=Resource metrics '+(i/3+1)+'::'+JSON.stringify(compact.slice(i,i+3)));
 if(madeApp)await run(['rm','-f',app]);if(madeVolume)await run(['volume','rm',volume]);await rm(tmp,{recursive:true,force:true});
}
