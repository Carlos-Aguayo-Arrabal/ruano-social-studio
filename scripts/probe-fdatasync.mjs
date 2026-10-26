// Offline synthetic probe. Writes only in its own new directory; no Docker/network.
import {mkdtemp,open,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
const [parent,...args]=process.argv.slice(2);
const options=Object.fromEntries(args.map(a=>a.split('=')));
const workers=Number(options.workers||4),mib=Number(options.mib||120),rounds=Number(options.rounds||10);
if(!parent||args.some(a=>! /^(workers|mib|rounds)=\d+$/.test(a))||![1,2,4].includes(workers)||!Number.isInteger(mib)||mib<1||mib>120||!Number.isInteger(rounds)||rounds<1||rounds>10)throw Error('Usage: node scripts/probe-fdatasync.mjs NEW_SCRATCH_PARENT [workers=1|2|4] [mib=1..120] [rounds=1..10]');
let stopping=false;const stop=()=>{stopping=true;};process.on('SIGTERM',stop);process.on('SIGINT',stop);
const scratch=await mkdtemp(join(resolve(parent),'ruano-fdatasync-')),samples=[],transfers=[],chunk=Buffer.alloc(65536,37),start=performance.now();
try{
 const results=await Promise.allSettled(Array.from({length:workers},async(_,worker)=>{
  for(let round=0;round<rounds;round++){
   if(stopping)throw Error('Probe interrupted');
   const path=join(scratch,`${worker}-${round}`),file=await open(path,'wx',0o600),began=performance.now();let pending=0;
   try{for(let bytes=0;bytes<mib*1048576;){
    if(stopping)throw Error('Probe interrupted');
    const {bytesWritten}=await file.write(chunk,0,Math.min(chunk.length,mib*1048576-bytes,4*1048576-pending),null);
    if(bytesWritten<=0)throw Error('No file write progress');bytes+=bytesWritten;pending+=bytesWritten;
    if(pending>=4*1048576||bytes===mib*1048576){const t=performance.now();await file.datasync();samples.push(performance.now()-t);pending=0;}
   }}finally{await file.close();}
   transfers.push(performance.now()-began);await rm(path);
  }
 }));
 const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
 const stats=values=>{const a=[...values].sort((a,b)=>a-b);return {count:a.length,p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],p99:a[Math.ceil(a.length*.99)-1],max:a.at(-1)};};
 const syncMs=stats(samples),transferMs=stats(transfers);
 const accepted=syncMs.p95<=100&&syncMs.p99<=500&&syncMs.max<=2000&&transferMs.max<=60000;
 console.log(JSON.stringify({syntheticOnly:true,workers,mib,rounds,totalBytes:workers*mib*1048576*rounds,durationMs:performance.now()-start,syncMs,transferMs,accepted,scope:'scratch filesystem only; not provider validation'},null,2));
 if(!accepted)process.exitCode=2;
}finally{await rm(scratch,{recursive:true,force:true});process.off('SIGTERM',stop);process.off('SIGINT',stop);}
