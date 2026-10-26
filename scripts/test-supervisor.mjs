// Short, disposable Docker acceptance only. No existing-container/volume option.
import assert from 'node:assert/strict';import {mkdtemp,writeFile,mkdir,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {DockerLab} from './supervisor-docker.mjs';import {hostMemory} from './container-memory.mjs';import {Reservations,Journal,supervise} from '../lib/synthetic-supervisor.mjs';
const image=process.argv[2]||'ruano-staging-check',reports=[];
const prelude=`import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const req=(path,options={})=>fetch('http://127.0.0.1:3000'+path,{redirect:'manual',signal:AbortSignal.timeout(4000),...options});
const login=async name=>{const r=await req('/login',{method:'POST',body:new URLSearchParams({username:name,password:process.env.APP_PASSWORD})});assert.equal(r.status,303);return {Cookie:r.headers.get('set-cookie').split(';')[0]};};
const hash=b=>createHash('sha256').update(b).digest('hex');`;
const scan=`import {readdir,lstat,statfs,readFile} from 'node:fs/promises';import {join} from 'node:path';
let used=0,files=0,temporaries=0;async function walk(p){for(const e of await readdir(p,{withFileTypes:true})){if(++files>4096)throw Error('scan-budget');const path=join(p,e.name),s=await lstat(path);if(s.isSymbolicLink())throw Error('unexpected-link');used+=s.blocks*512;if(s.isDirectory())await walk(path);if(/^\\.upload-.*\\.tmp$/.test(e.name))temporaries++;}}
await walk('/app/data');const d=await statfs('/app/data'),g=JSON.parse(await readFile('/app/data/.process-memory.json','utf8'));console.log(JSON.stringify({used,files,temporaries,free:d.bavail*d.bsize,inodeFreeRatio:d.files?d.ffree/d.files:0,g}));`;
const cancellation=new AbortController();const cancel=()=>{cancellation.abort();process.exitCode=1;};process.on('SIGTERM',cancel);process.on('SIGINT',cancel);const wall=setTimeout(cancel,180000);
for(const mode of ['duration','quota','health','oom']){
 if(cancellation.signal.aborted)break;
 const lab=new DockerLab(image),tmp=await mkdtemp(join(tmpdir(),'ruano-supervisor-'));let journal,book,artifactDir,ok=false,app,helper,client;const report={mode,success:false};reports.push(report);
 try{
  const env=join(tmp,'synthetic.env');await writeFile(env,['APP_USERNAME=synthetic-owner','APP_PASSWORD='+randomBytes(24).toString('hex'),'APP_SESSION_SECRET='+randomBytes(48).toString('hex'),'OLLAMA_URL=http://127.0.0.1:1'].join('\n'),{mode:0o600});
  report.stage='create';const volume=await lab.volume();
  app=await lab.create('app',['--network','none','--tmpfs','/tmp:rw,noexec,nosuid,size=32m','--env-file',env,'--env','NODE_OPTIONS=--import=/app/lib/oom-telemetry.mjs','--env','RUANO_MEMORY_LOG=/app/data/.process-memory.json','--mount',`type=volume,src=${volume},dst=/app/data`,'--health-cmd','test ! -f /tmp/health-fault && wget -qO- http://127.0.0.1:3000/health >/dev/null','--health-interval','1s','--health-timeout','1s','--health-retries','1','--health-start-period','1s',image]);
  helper=await lab.create('helper',['--network','none','--mount',`type=volume,src=${volume},dst=/app/data,readonly`,image,'node','-e','setInterval(()=>{},1000)']);
  client=await lab.create('client',['--network','container:'+app,'--env-file',env,image,'node','-e','setInterval(()=>{},1000)']);
  for(const id of [app,helper,client])await lab.action(id,'start');
  const ready=async()=>{for(let i=0;i<30;i++){if((await lab.inspect(app)).health?.Status==='healthy')return;await new Promise(r=>setTimeout(r,200));}throw Error('readiness-timeout');};await ready();report.stage='setup';
  await lab.exec(client,prelude+`const headers=await login(process.env.APP_USERNAME);const r=await req('/api/sync',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({brands:{upsert:['a','b'].map(id=>({id,name:'Synthetic '+id}))},data:Object.fromEntries(['a','b'].map(id=>[id,{properties:{upsert:[{id:101}]}}]))})});assert.equal(r.status,200);for(const user of ['a1','a2','b1','b2']){const r=await req('/api/users',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({username:'synthetic-'+user,password:process.env.APP_PASSWORD,role:'agency',brands:[user[0]]})});assert.equal(r.status,200);}`);
  const disk=()=>lab.exec(helper,scan).then(JSON.parse),initial=await disk();assert.ok(initial.free>=12*1024**3,'12 GiB free required before synthetic run');
  book=await Reservations.create(tmp,mode==='quota'?{userMax:100000}:{});let admitting=true;
  const send=async user=>{
   if(!admitting)throw Error('admission-closed');const before=await disk(),token=await book.reserve({tenant:user[0],user,bytes:65536},before);
   // The HTTP request can start only after the durable reservation resolves.
   try{const value=JSON.parse(await lab.exec(client,prelude+`const headers=await login('synthetic-${user}'),body=Buffer.alloc(65536,37);body[0]=255;body[1]=216;body[2]=255;const r=await req('/api/photos/101?brand=${user[0]}',{method:'POST',headers,body});assert.equal(r.status,201);const id=(await r.json()).id;const got=await req('/api/photos/101/'+id+'?brand=${user[0]}',{headers});assert.equal(got.status,200);const data=Buffer.from(await got.arrayBuffer());assert.equal(hash(data),hash(body));console.log(JSON.stringify({id,bytes:data.length,sha256:hash(data)}));`));await book.complete(token,value.bytes);return value;}catch(e){await book.fail(token);throw e;}
  };
  report.stage='initial-reservations';const valid=await send('a1');await send('b1');report.reservationsBeforeStop=JSON.parse(await readFile(book.path,'utf8')).committed.length;
  artifactDir=join('artifacts','supervisor-'+mode);await mkdir(artifactDir,{recursive:true});journal=await Journal.create(join(artifactDir,'metrics.ndjson'),1024*1024);
  let prior,triggered=false;const atStart=Date.now(),selfStart=process.cpuUsage();
  const sample=async()=>{
   const s=await lab.inspect(app);let m,d;
   if(s.running){[m,d]=await Promise.all([hostMemory(s.pid),disk()]);}else if(prior)return {...prior,at:Date.now(),running:false,oomKilled:s.oom};else throw Error('application-exit');
   const at=Date.now(),g=d.g;if(at-g.at>10000)throw Error('process-gauge-stale');
   const cpuPercent=prior?(m.cpuUsec-prior.cpuUsec)/((at-prior.at)*10):0;
   const own=process.memoryUsage(),self=process.cpuUsage(selfStart);
   if(own.rss>192*1048576||(at-atStart>30000&&(self.user+self.system)/((at-atStart)*1000)>.25))throw Error('observer-resource-budget');
   const value={at,rss:g.rss,heap:g.heapUsed,external:g.external,arrayBuffers:g.arrayBuffers,current:m.currentBytes,dirty:m.stat.file_dirty,writeback:m.stat.file_writeback,swap:m.swapCurrentBytes,memoryMax:m.configuredLimitBytes,swapMax:m.swapMaxBytes,cpuQuota:m.cpuQuota,cpuPercent,free:d.free,inodeFreeRatio:d.inodeFreeRatio,dataset:d.used,logBytes:journal.bytes,oomKills:m.events.oom_kill,oomEvents:m.events.oom,running:s.running,oomKilled:s.oom,health:s.health?.Status==='healthy',healthMs:0,cpuUsec:m.cpuUsec,temporaries:d.temporaries};prior=value;
   if(!triggered){triggered=true;
    if(mode==='health')await lab.exec(app,"import {writeFile} from 'node:fs/promises';await writeFile('/tmp/health-fault','synthetic');");
    if(mode==='oom')void lab.exec(app,"const chunks=[];setInterval(()=>{for(let i=0;i<16;i++)chunks.push(Buffer.alloc(1048576,37));},10);",8000).catch(()=>{});
   }else if(mode==='quota'){await send('a1');throw Error('quota-admission-was-not-blocked');}
   return value;
  };
  report.stage='supervision';const result=await supervise({sample,signal:cancellation.signal,stop:async()=>{admitting=false;await lab.stopAll();},journal,policy:{durationMs:mode==='oom'?20000:5000},intervalMs:500,probeTimeoutMs:8000});
  report.stop=result.reason;report.last=result.last;assert.equal(result.reason,mode==='oom'?'oom':mode==='health'?'health':mode==='quota'?'quota':'duration');assert.equal(admitting,false);assert.equal((await lab.inspect(app)).running,false);report.stoppedOwnedApplication=true;
  report.stage='recovery';// Explicit recovery subtest after stop; never resumes the load loop.
  for(const id of [app,helper,client])await lab.action(id,'start');await ready();
  const verified=await lab.exec(client,prelude+`const headers=await login('synthetic-a1');const r=await req('/api/photos/101/${valid.id}?brand=a',{headers});assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),'${valid.sha256}');const other=await login('synthetic-b1');assert.equal((await req('/api/photos/101/${valid.id}?brand=a',{headers:other})).status,403);assert.equal((await req('/logout',{headers})).status,303);assert.equal((await req('/api/me',{headers})).status,401);console.log('verified');`);assert.equal(verified,'verified');assert.equal((await disk()).temporaries,0);
  report.recovery={validHash:true,crossTenant403:true,revoked401:true,temporaries:0};report.stage='verified';report.success=true;ok=true;
 }catch(e){report.failure=e.message;process.exitCode=1;}
 finally{
  try{await lab.stopAll();await lab.remove({volumes:ok});}catch(e){report.cleanupError=e.message;report.success=false;process.exitCode=1;}
  if(journal)await journal.close();if(book&&artifactDir)await writeFile(join(artifactDir,'reservations.json'),await readFile(book.path),{mode:0o600});if(ok)await rm(tmp,{recursive:true,force:true});else{report.privateBundlePreserved=tmp;report.preservedVolumes=lab.volumes;}
 }
 console.log('::notice title=Supervisor short case::'+JSON.stringify(report));
}
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/supervisor-results.json',JSON.stringify(reports,null,2));

clearTimeout(wall);process.off('SIGTERM',cancel);process.off('SIGINT',cancel);
