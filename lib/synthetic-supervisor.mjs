// Test tooling only. Never imported by the application or exposed over HTTP.
import {open,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {rssWindow} from './soak-analysis.mjs';
const MiB=1048576;
export const defaults=Object.freeze({durationMs:27000000,staleMs:10000,holdMs:60000,cpuHoldMs:300000,growthWindowMs:1800000,warmupMs:1800000,rssMax:160*MiB,heapMax:64*MiB,buffersMax:96*MiB,logMax:128*MiB,datasetMax:1024*MiB,tenantMax:512*MiB,userMax:256*MiB,minFree:6*1024**3});
export class Stop extends Error {constructor(reason){super(reason);this.reason=reason;}}
export class Guard {
 constructor(options={}){this.p={...defaults,...options};this.start=null;this.last=null;this.rows=[];this.since=new Map();this.badHealth=0;}
 tick(s){
  const p=this.p;
  const required=['at','rss','heap','external','arrayBuffers','current','dirty','writeback','swap','memoryMax','swapMax','cpuQuota','cpuPercent','healthMs','free','inodeFreeRatio','dataset','logBytes','oomKills','oomEvents'];
  if(required.some(k=>!Number.isFinite(s[k])||s[k]<0))throw new Stop('observation-invalid');
  this.start??=s.at;
  if(this.last!==null&&(s.at<=this.last||s.at-this.last>p.staleMs))throw new Stop('observation-stale');this.last=s.at;
  if(s.memoryMax!==256*MiB||s.swapMax!==0||s.cpuQuota!==1||s.swap>0)throw new Stop('resource-configuration');
  if(s.oomKills>0||s.oomEvents>0||s.oomKilled)throw new Stop('oom');
  if(s.running!==true)throw new Stop('application-exit');
  if(s.health!==true){if(++this.badHealth>=3)throw new Stop('health');}else this.badHealth=0;
  if(s.integrity===false)throw new Stop('integrity');
  if(s.free<p.minFree||s.inodeFreeRatio<.1)throw new Stop('disk-free');
  if(s.dataset>=p.datasetMax*.8)throw new Stop('dataset');
  if(s.logBytes>=p.logMax-2048)throw new Stop('log-budget');
  const held=(name,condition,ms)=>{if(!condition){this.since.delete(name);return;}if(!this.since.has(name))this.since.set(name,s.at);if(s.at-this.since.get(name)>=ms)throw new Stop(name);};
  held('rss',s.rss>p.rssMax,p.holdMs);held('heap',s.heap>p.heapMax,p.holdMs);held('buffers',s.external+s.arrayBuffers>p.buffersMax,p.holdMs);
  held('writeback',s.current>256*MiB*.95&&s.dirty+s.writeback>32*MiB,p.holdMs);
  held('cpu-health',s.cpuPercent>95&&s.healthMs>500,p.cpuHoldMs);
  // One point per minute, bounded even for a many-hour run.
  if(s.at-this.start>=p.warmupMs&&(!this.rows.length||s.at-this.rows.at(-1).at>=Math.min(60000,p.growthWindowMs/4)))this.rows.push({at:s.at,rss:s.rss});
  while(this.rows.length>2&&this.rows[1].at<s.at-p.growthWindowMs)this.rows.shift();
  if(this.rows.length>=4&&this.rows.at(-1).at-this.rows[0].at>=p.growthWindowMs){
   const trend=rssWindow(this.rows.map(r=>({at:r.at,rssBytes:r.rss})),this.rows[0].at,this.rows.at(-1).at);
   if(trend.deltaMedianBytes>16*MiB&&trend.slopeMiBPerMinute>1)throw new Stop('sustained-growth');
  }
  if(s.at-this.start>=p.durationMs)throw new Stop('duration');
  return {warning:s.dataset>=p.datasetMax*.7};
 }
}
export class Journal {
 static async create(path,max=defaults.logMax){const file=await open(path,'wx',0o600);return new Journal(file,max);}
 constructor(file,max){this.file=file;this.max=max;this.bytes=0;}
 async append(record){const text=JSON.stringify(record)+'\n',bytes=Buffer.byteLength(text);if(this.bytes+bytes>this.max-2048)throw new Stop('log-budget');await this.file.writeFile(text);this.bytes+=bytes;}
 async close(){await this.file.sync();await this.file.close();}
}
export class Reservations {
 static async create(dir,options={}){const r=new Reservations(dir,options);const f=await open(r.path,'wx',0o600);await f.close();await r.persist();return r;}
 constructor(dir,options){this.path=join(dir,'reservations.json');this.p={...defaults,...options};this.pending=new Map();this.committed=[];this.frozen=false;this.queue=Promise.resolve();}
 serial(fn){const task=this.queue.then(fn);this.queue=task.catch(()=>{});return task;}
 async persist(){const tmp=this.path+'.new';const f=await open(tmp,'wx',0o600);try{await f.writeFile(JSON.stringify({frozen:this.frozen,pending:[...this.pending.values()],committed:this.committed}));await f.sync();}finally{await f.close();}await rename(tmp,this.path);}
 reserve({tenant,user,bytes},disk){return this.serial(async()=>{
  if(this.frozen)throw new Stop('reservations-frozen');
  if(!['a','b'].includes(tenant)||!['a1','a2','b1','b2'].includes(user)||!user.startsWith(tenant)||!Number.isSafeInteger(bytes)||bytes<1||bytes>120*MiB)throw new Stop('reservation-invalid');
  if(!Number.isFinite(disk.used)||!Number.isFinite(disk.free)||disk.used<0||disk.free<0)throw new Stop('observation-invalid');
  const rows=[...this.pending.values(),...this.committed],sum=filter=>rows.filter(filter).reduce((s,r)=>s+r.bytes,0),pending=[...this.pending.values()].reduce((s,r)=>s+r.bytes,0);
  if(this.pending.size>=4||this.committed.length>=512)throw new Stop('reservation-capacity');
  // Conservative full-size growth: no deduction for replacement or compression.
  if(Math.max(disk.used,sum(()=>true))+bytes>=this.p.datasetMax*.8||sum(r=>r.tenant===tenant)+bytes>=this.p.tenantMax*.8||sum(r=>r.user===user)+bytes>=this.p.userMax*.8)throw new Stop('quota');
  // Reserve coexistence of original/final and a complete temporary for all flights.
  if(disk.free-2*(pending+bytes)<this.p.minFree)throw new Stop('disk-reservation');
  const id=randomUUID(),r={id,tenant,user,bytes};this.pending.set(id,r);
  try{await this.persist();}catch{this.frozen=true;throw new Stop('ledger-io');}return id;
 });}
 complete(id,actualBytes){return this.serial(async()=>{const r=this.pending.get(id);if(!r||actualBytes!==r.bytes){this.frozen=true;await this.persist();throw new Stop('reservation-mismatch');}this.pending.delete(id);this.committed.push(r);try{await this.persist();}catch{this.frozen=true;throw new Stop('ledger-io');}});}
 fail(id,{cleaned=false}={}){return this.serial(async()=>{if(!this.pending.has(id))throw new Stop('reservation-invalid');if(cleaned)this.pending.delete(id);else this.frozen=true;await this.persist();});}
}
// Generic engine: the adapter owns resources. A stalled probe cannot postpone stop.
export async function supervise({sample,stop,journal,policy={},signal,intervalMs=1000,probeTimeoutMs=5000}){
 const guard=new Guard(policy);let reason='observer-error',last;
 try{while(true){
  if(signal?.aborted)throw new Stop('cancelled');
  let timer;try{last=await Promise.race([sample(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Stop('observation-timeout')),probeTimeoutMs);})]);}finally{clearTimeout(timer);}
  guard.tick(last);await journal.append(last);
  await new Promise(r=>setTimeout(r,intervalMs));
 }}catch(e){reason=e instanceof Stop?e.reason:'observer-error';}
 // stop must block admission before stopping clients, then drain/stop only owned app.
 await stop(reason);return {reason,last};
}
