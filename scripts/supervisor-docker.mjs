// Only creates resources with an unpredictable per-run label. No attach mode.
import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';
export function docker(args,input='',timeout=15000,includeStderr=false){return new Promise((resolve,reject)=>{
 const p=spawn('docker',args,{stdio:['pipe','pipe','pipe']});let out='',err='',size=0,failed=false;
 const fail=reason=>{if(failed)return;failed=true;p.kill('SIGKILL');reject(Error(reason));};
 const timer=setTimeout(()=>fail('docker-command-timeout'),timeout);
 p.stdout.on('data',b=>{size+=b.length;if(size>65536)return fail('docker-output-budget');out+=b;});p.stderr.on('data',b=>{err+=b;if(includeStderr)out+=b;size+=b.length;if(size>65536)fail('docker-output-budget');});
 p.on('error',()=>{clearTimeout(timer);fail('docker-command-unavailable');});p.on('close',code=>{clearTimeout(timer);if(!failed){if(code===0)resolve(out.trim());else reject(Error('docker-command-exit-'+code+'-'+args[0]+(args[0]==='inspect'?':'+err.slice(0,1000):'')));}});p.stdin.on('error',()=>{});p.stdin.end(input);
 });}
export class DockerLab {
 constructor(image){this.image=image;this.id='ruano-guard-'+randomUUID();this.containers=[];this.volumes=[];}
 async volume(){const name=this.id+'-data';await docker(['volume','create','--label','ruano.synthetic='+this.id,name]);this.volumes.push(name);return name;}
 async create(role,args=[]){const size=role==='app'?'256m':role==='client'?'512m':'128m',cpu=role==='helper'?'0.25':'1';
  const id=await docker(['create','--name',this.id+'-'+role,'--label','ruano.synthetic='+this.id,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory',size,'--memory-swap',size,'--cpus',cpu,'--pids-limit','128','--log-driver','local','--log-opt','max-size=1m','--log-opt','max-file=2',...args]);
  if(!/^[a-f0-9]{64}$/.test(id))throw Error('invalid-created-container');this.containers.push({id,role});return id;
 }
 async inspect(id){if(!this.containers.some(c=>c.id===id))throw Error('not-owned');const s=JSON.parse(await docker(['inspect','--format','{"label":{{json (index .Config.Labels "ruano.synthetic")}},"id":{{json .Id}},"pid":{{.State.Pid}},"running":{{.State.Running}},"oom":{{.State.OOMKilled}},"memory":{{.HostConfig.Memory}},"memswap":{{.HostConfig.MemorySwap}},"cpus":{{.HostConfig.NanoCpus}},"health":{{json (index .State "Health")}}}',id]));if(s.id!==id||s.label!==this.id)throw Error('ownership-mismatch');return s;}
 async action(id,command,args=[]){await this.inspect(id);return docker([command,id,...args]);}
 async exec(id,script,timeout=15000){await this.inspect(id);return docker(['exec','--env','NODE_OPTIONS=','-i',id,'node','--input-type=module'],script,timeout);}
 async stopAll(){let error;for(const {id} of [...this.containers].reverse()){try{const s=await this.inspect(id);if(s.running)await this.action(id,'stop',['--time','3']);}catch(e){error=e;}}if(error)throw error;}
 async remove({volumes=false}={}){for(const {id} of [...this.containers].reverse()){await this.inspect(id);await docker(['rm',id]);}if(volumes)for(const v of this.volumes){const label=await docker(['volume','inspect','--format','{{index .Labels "ruano.synthetic"}}',v]);if(label!==this.id)throw Error('volume-ownership-mismatch');await docker(['volume','rm',v]);}}
}
