// Real ENOSPC in a 4 MiB disposable tmpfs, never fills a host filesystem.
import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';import {DockerLab,docker} from './supervisor-docker.mjs';
const image=process.argv[2]||'ruano-staging-check',lab=new DockerLab(image),tmp=await mkdtemp(join(tmpdir(),'ruano-enospc-'));let ok=false;const report={syntheticOnly:true,filesystem:'disposable-4MiB-tmpfs',persistentVolume:false};
try{
 const env=join(tmp,'synthetic.env');await writeFile(env,['APP_USERNAME=synthetic-owner','APP_PASSWORD='+randomBytes(24).toString('hex'),'APP_SESSION_SECRET='+randomBytes(48).toString('hex'),'OLLAMA_URL=http://127.0.0.1:1'].join('\n'),{mode:0o600});
 const app=await lab.create('app',['--network','none','--tmpfs','/app/data:rw,noexec,nosuid,size=4m,uid=1000,gid=1000','--env-file',env,'--health-interval','1s','--health-start-period','1s',image]);
 const client=await lab.create('client',['--network','container:'+app,'--env-file',env,image,'node','-e','setInterval(()=>{},1000)']);for(const id of [app,client])await lab.action(id,'start');
 for(let i=0;i<40;i++){if((await lab.inspect(app)).health?.Status==='healthy')break;await new Promise(r=>setTimeout(r,200));}assert.equal((await lab.inspect(app)).health?.Status,'healthy');
 const result=JSON.parse(await lab.exec(client,`import assert from 'node:assert/strict';import {createHash} from 'node:crypto';const req=(p,o={})=>fetch('http://127.0.0.1:3000'+p,{redirect:'manual',signal:AbortSignal.timeout(10000),...o});
 const r=await req('/login',{method:'POST',body:new URLSearchParams({username:process.env.APP_USERNAME,password:process.env.APP_PASSWORD})});assert.equal(r.status,303);const headers={Cookie:r.headers.get('set-cookie').split(';')[0]};
 assert.equal((await req('/api/sync',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({brands:{upsert:[{id:'a',name:'Synthetic'}]},data:{a:{properties:{upsert:[{id:101}]}}}})})).status,200);
 const bytes=n=>{const b=Buffer.alloc(n,37);b[0]=255;b[1]=216;b[2]=255;return b;};
 const upload=body=>req('/api/photos/101?brand=a',{method:'POST',headers,body});const first=await upload(bytes(65536));assert.equal(first.status,201);const id=(await first.json()).id;const hash=b=>createHash('sha256').update(b).digest('hex');
 const full=await upload(bytes(4*1048576));assert.equal(full.status,500);await full.text();
 const read=await req('/api/photos/101/'+id+'?brand=a',{headers});assert.equal(read.status,200);assert.equal(hash(Buffer.from(await read.arrayBuffer())),hash(bytes(65536)));
 const after=await upload(bytes(65536));assert.equal(after.status,201);console.log(JSON.stringify({fullStatus:full.status,validPreserved:true,retryStatus:after.status}));`));
 Object.assign(report,result);await lab.inspect(app);const logs=await docker(['logs','--tail','30',app],'',15000,true);assert.match(logs,/ENOSPC/);report.enospcObserved=true;
 const check=JSON.parse(await lab.exec(app,`import {readdir,readFile} from 'node:fs/promises';const walk=async p=>{let n=0;for(const e of await readdir(p,{withFileTypes:true})){if(e.isDirectory())n+=await walk(p+'/'+e.name);else if(/^\\.upload-.*\\.tmp$/.test(e.name))n++;}return n;};console.log(JSON.stringify({temporaries:await walk('/app/data')}));`));assert.equal(check.temporaries,0);report.temporaries=0;report.oomKilled=(await lab.inspect(app)).oom;assert.equal(report.oomKilled,false);report.success=true;ok=true;
}catch(e){report.success=false;report.failure=e.message;process.exitCode=1;}
finally{try{await lab.stopAll();await lab.remove();}catch(e){report.cleanupError=e.message;report.success=false;process.exitCode=1;}await rm(tmp,{recursive:true,force:true});}
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/supervisor-disk.json',JSON.stringify(report,null,2));console.log('::notice title=Supervisor real disk full::'+JSON.stringify(report));
