// Only disposable resources created here are removed. No published ports,
// bind mounts, production credentials or external/container networks are used.
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const image=process.argv[2]||'ruano-staging-check';
const prefix='ruano-synthetic-'+randomUUID(),container=prefix+'-app',volume=prefix+'-data';
const tmp=await mkdtemp(join(tmpdir(),'ruano-docker-'));
const run=(args,input='')=>new Promise((resolve,reject)=>{
 const p=spawn('docker',args,{stdio:['pipe','pipe','pipe']});let out='',err='';
 p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);
 p.on('close',code=>code===0?resolve(out.trim()):reject(Error('docker '+args[0]+' failed: '+err+out)));p.stdin.end(input);
});
const exec=code=>run(['exec','-i',container,'node','--input-type=module'],code);
async function healthy(){for(let i=0;i<40;i++){if(await run(['inspect','--format','{{.State.Health.Status}}',container])==='healthy')return;await new Promise(r=>setTimeout(r,500));}throw Error('Healthcheck did not become healthy');}
let createdVolume=false,createdContainer=false;
try{
 const env=join(tmp,'synthetic.env');await writeFile(env,[
 'APP_USERNAME=synthetic-owner','APP_PASSWORD='+randomBytes(24).toString('hex'),
 'APP_SESSION_SECRET='+randomBytes(48).toString('hex'),'OLLAMA_URL=http://127.0.0.1:1',
 ].join('\n'),{mode:0o600});
 await run(['volume','create',volume]);createdVolume=true;
 await run(['create','--name',container,'--network','none','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=32m',
 '--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--cpus','1','--pids-limit','128',
 '--env-file',env,'--mount',`type=volume,source=${volume},target=/app/data`,'--health-interval','1s','--health-start-period','1s',image]);createdContainer=true;
 assert.equal(await run(['inspect','--format','{{.HostConfig.NetworkMode}}',container]),'none');
 assert.equal(await run(['inspect','--format','{{.Config.User}}',container]),'node');
 await run(['start',container]);await healthy();
 const payload=(await readFile(new URL('../tests/fixtures/photo.jpg',import.meta.url))).toString('base64');
 const common=`import assert from 'node:assert/strict';
const req=(p,o={})=>fetch('http://127.0.0.1:3000'+p,{redirect:'manual',...o});
const login=await req('/login',{method:'POST',body:new URLSearchParams({username:process.env.APP_USERNAME,password:process.env.APP_PASSWORD})});
assert.equal(login.status,303);assert.match(login.headers.get('set-cookie'),/Secure/);assert.match(login.headers.get('set-cookie'),/HttpOnly/);
const cookie=login.headers.get('set-cookie').split(';')[0];const headers={Cookie:cookie,'Content-Type':'application/json'};
const photo=Buffer.from('${payload}','base64');`;
 await exec(common+`
assert.match(process.version,/^v22\\./);assert.equal(process.getuid(),1000);
const {writeFile}=await import('node:fs/promises');await writeFile('/app/data/permission-probe','synthetic');
await assert.rejects(writeFile('/app/forbidden-probe','synthetic'));
const sync=await req('/api/sync',{method:'POST',headers,body:JSON.stringify({brands:{upsert:[{id:'synthetic',name:'Synthetic Docker'}]},data:{synthetic:{properties:{upsert:[{id:101,title:'Synthetic property'}]}}}})});assert.equal(sync.status,200);
const upload=await req('/api/photos/101?brand=synthetic',{method:'POST',headers:{Cookie:cookie},body:photo});assert.equal(upload.status,201);
console.log('synthetic startup, permissions, authentication and upload verified');`);
 await run(['restart',container]);await healthy();
 const result=await exec(common+`
const state=await(await req('/api/sync',{headers})).json();assert.equal(state.data.synthetic.properties[0].title,'Synthetic property');
const manifest=await(await req('/api/photos/101?brand=synthetic',{headers})).json();assert.equal(manifest.photos.length,1);
const bytes=Buffer.from(await(await req('/api/photos/101/'+manifest.photos[0].id+'?brand=synthetic',{headers})).arrayBuffer());assert.deepEqual(bytes,photo);
console.log(JSON.stringify({node:process.version,uid:process.getuid(),health:true,authentication:true,volumePersistence:true,photoBytesAfterRestart:true,readOnlyRoot:true}));`);
 const report={image,network:'none',publishedPorts:0,productionData:false,...JSON.parse(result)};
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/docker-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
 if(createdContainer)await run(['rm','-f',container]);if(createdVolume)await run(['volume','rm',volume]);await rm(tmp,{recursive:true,force:true});
}
