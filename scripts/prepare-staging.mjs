// Generates private local files only; never contacts Docker, DNS or EasyPanel.
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function prepareStaging(output,project='ruano-stage-'+randomUUID().slice(0,12)) {
 if(!/^ruano-stage-[a-z0-9-]{3,32}$/.test(project))throw Error('Use a fresh ruano-stage-* project name');
 const dir=resolve(output);await mkdir(dir,{mode:0o700});
 try{
  const domain=project+'.example.invalid',volume=project+'-data';
  await writeFile(join(dir,'synthetic.env'),['NODE_ENV=production','PORT=3000','DATA_DIR=/app/data','PUBLIC_URL=https://'+domain,'OLLAMA_URL=http://127.0.0.1:1','APP_USERNAME=synthetic-owner','APP_PASSWORD='+randomBytes(32).toString('hex'),'APP_SESSION_SECRET='+randomBytes(48).toString('hex')].join('\n')+'\n',{mode:0o600,flag:'wx'});
  await writeFile(join(dir,'compose.yml'),`name: ${project}
services:
  studio:
    image: ruano-staging-check
    network_mode: none
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: [/tmp:rw,noexec,nosuid,size=32m]
    cpus: 1
    mem_limit: 256m
    memswap_limit: 256m
    pids_limit: 128
    restart: "no"
    deploy:
      replicas: 1
      update_config:
        parallelism: 1
        order: stop-first
    env_file: [./synthetic.env]
    volumes: [synthetic-data:/app/data]
volumes:
  synthetic-data:
    name: ${volume}
`,{flag:'wx'});
  const plan={schema:'manual-reference-not-easypanel-api',project,volume:{name:volume,mount:'/app/data',external:false,uid:1000,gid:1000},replicas:1,updates:{automatic:false,order:'stop-first',parallelism:1},resources:{cpus:1,memoryBytes:268435456,swap:false,pids:128,uploadConcurrency:{global:4,perUser:2,perTenant:3}},recovery:{offline:true,newBackupAndRestoreTargets:true,externalRestoreVerified:false,newSessionsAfterRestore:true},image:'ruano-staging-check',internalPort:3000,publishedHostPorts:[],domain:{hostname:domain,dnsConfigured:false,tls:'pending-real-staging-validation'},credentials:'synthetic.env (private; do not commit or print)',autoDeploy:false,networks:{isolatedRehearsal:'none',futureProxy:'new staging-only network after authorization; never production networks'},perimeterPaths:['/','/login','/api/*','/w/*','/r/*','/m/*','/health','/vendor/*']};
  await writeFile(join(dir,'easypanel-plan.json'),JSON.stringify(plan,null,2),{flag:'wx'});return {output:dir,project,volume:volume,files:['synthetic.env','compose.yml','easypanel-plan.json'],infrastructureCreated:false};
 }catch(err){await rm(dir,{recursive:true,force:true});throw err;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{if(!process.argv[2])throw Error('Usage: node scripts/prepare-staging.mjs NEW_DIRECTORY [NEW_PROJECT_NAME]');console.log(JSON.stringify(await prepareStaging(process.argv[2],process.argv[3])));}catch(err){console.error(err.message);process.exitCode=1;}
}
