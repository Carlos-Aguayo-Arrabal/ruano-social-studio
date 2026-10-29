// Generates private local files only; never contacts Docker, DNS or EasyPanel.
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
export async function prepareStaging(output,project='ruano-stage-'+randomUUID().slice(0,12),options={}) {
 if(!/^ruano-stage-[a-z0-9-]{3,32}$/.test(project))throw Error('Use a fresh ruano-stage-* project name');
 const sourceSha=options.sourceSha||(await promisify(execFile)('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../',import.meta.url))})).stdout.trim();
 if(!/^[a-f0-9]{40}$/.test(sourceSha))throw Error('Provide a reviewed full Git commit SHA');
 const domain=options.domain||project+'.example.invalid',nodeImage=options.nodeImage||'node:22-alpine';
 if(!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))throw Error('Use a new lowercase staging hostname without scheme, port or wildcard');
 if(nodeImage!=='node:22-alpine'&&!/^(?:docker.io\/library\/)?node(?::22-alpine)?@sha256:[a-f0-9]{64}$/.test(nodeImage))throw Error('Use the tested Node image digest');
 const basePinned=nodeImage.includes('@sha256:'),image='ruano-staging:'+sourceSha.slice(0,12);
 const dir=resolve(output);await mkdir(dir,{mode:0o700});
 try{
  const volume=project+'-data';
  await writeFile(join(dir,'perimeter.env'),['STAGING_PERIMETER_USERNAME=stage-reviewer','STAGING_PERIMETER_PASSWORD='+randomBytes(32).toString('hex')].join('\n')+'\n',{mode:0o600,flag:'wx'});
  await writeFile(join(dir,'synthetic.env'),['NODE_ENV=production','PORT=3000','DATA_DIR=/app/data','PUBLIC_URL=https://'+domain,'OLLAMA_URL=http://127.0.0.1:1','APP_USERNAME=synthetic-owner','APP_PASSWORD='+randomBytes(32).toString('hex'),'APP_SESSION_SECRET='+randomBytes(48).toString('hex')].join('\n')+'\n',{mode:0o600,flag:'wx'});
  await writeFile(join(dir,'compose.yml'),`name: ${project}
services:
  studio:
    image: ${image}
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
  const plan={schema:'manual-reference-not-easypanel-api',project,volume:{name:volume,mount:'/app/data',external:false,uid:1000,gid:1000},replicas:1,updates:{automatic:false,order:'stop-first',parallelism:1},resources:{cpus:1,memoryBytes:268435456,swap:false,pids:128,uploadConcurrency:{global:4,perUser:2,perTenant:3}},recovery:{offline:true,newBackupAndRestoreTargets:true,externalRestoreVerified:false,newSessionsAfterRestore:true},image,source:{repository:'Carlos-Aguayo-Arrabal/ruano-social-studio',commit:sourceSha,branch:'security/phase-0-2026-10-24'},build:{dockerfile:'Dockerfile',nodeImage,basePinned,requiresPinnedBase:!basePinned},storage:{syntheticDatasetBudgetBytes:1073741824,applicationDiskQuotaEnforced:false,minFreeBytesBeforeRehearsal:8589934592,alertAtBudgetPercent:70,stopAtBudgetPercent:80},stagingEdgeNetwork:{name:project+'-edge',create:false,productionNetworksAllowed:false,defaultDenyEgressRequired:true},perimeter:{credentials:'perimeter.env (private; never commit or print)',mode:'closed before app routing',coversAllPaths:true,bcryptHashInPanelRequired:true},internalPort:3000,publishedHostPorts:[],domain:{hostname:domain,dnsConfigured:false,tls:'pending-real-staging-validation'},credentials:'synthetic.env (private; do not commit or print)',autoDeploy:false,networks:{isolatedRehearsal:'none',futureProxy:'new staging-only network after authorization; never production networks'},perimeterPaths:['/','/login','/api/*','/w/*','/r/*','/m/*','/health','/vendor/*']};
  await writeFile(join(dir,'easypanel-plan.json'),JSON.stringify(plan,null,2),{flag:'wx'});return {output:dir,project,volume:volume,files:['synthetic.env','perimeter.env','compose.yml','easypanel-plan.json'],infrastructureCreated:false};
 }catch(err){await rm(dir,{recursive:true,force:true});throw err;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{if(!process.argv[2])throw Error('Usage: node scripts/prepare-staging.mjs NEW_DIRECTORY [NEW_PROJECT_NAME]');const args=process.argv.slice(3),project=args[0]&&!args[0].startsWith('--')?args.shift():undefined,options={};while(args.length){const flag=args.shift(),key={'--source-sha':'sourceSha','--domain':'domain','--node-image':'nodeImage'}[flag];if(!key||!args.length)throw Error('Unknown or incomplete staging option');options[key]=args.shift();}console.log(JSON.stringify(await prepareStaging(process.argv[2],project,options)));}catch(err){console.error(err.message);process.exitCode=1;}
}
