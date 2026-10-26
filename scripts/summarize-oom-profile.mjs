// Analyze existing numeric CI telemetry; never execute workloads or print secrets.
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {rssWindow} from '../lib/soak-analysis.mjs';
const report=JSON.parse(await readFile(process.argv[2],'utf8')),rows=report.samples||[];
const metric=(key,start,end)=>rssWindow(rows.filter(s=>Number.isFinite(key==='rss'?s.rssBytes:s.process?.[key])).map(s=>({at:s.at,rssBytes:key==='rss'?s.rssBytes:s.process[key]})),start,end);
const phases=(report.phases||[]).map(p=>({concurrency:p.concurrency,durationMs:p.durationMs,requests:p.requests,statuses:p.statuses,health:p.health,latencyMs:p.latencyMs,sessionRotations:p.sessionRotations,metrics:Object.fromEntries(['rss','heapUsed','external','arrayBuffers'].map(k=>[k,metric(k,p.startedAt,p.endedAt)]))}));
const idle=report.rssAnalysis?.idle;
const median=a=>a.length?[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)]:null;
const minutes=[];if(rows.length)for(let t=rows[0].at;t<=rows.at(-1).at;t+=60000){const r=rows.filter(s=>s.at>=t&&s.at<t+60000);if(!r.length)continue;const mb=n=>n===null?null:Math.round(n/1048576*100)/100;minutes.push({minute:minutes.length,rssMedianMiB:mb(median(r.map(s=>s.rssBytes))),heapMedianMiB:mb(median(r.map(s=>s.process?.heapUsed).filter(Number.isFinite))),externalMedianMiB:mb(median(r.map(s=>s.process?.external).filter(Number.isFinite))),dirtyMaxMiB:mb(Math.max(...r.map(s=>s.stat?.file_dirty||0)))});}
const result={success:report.success,failure:report.failure,profile:report.profile,memoryEvidence:report.memoryEvidence&&Object.fromEntries(Object.entries(report.memoryEvidence).filter(([k])=>k!=='tail')),dockerEvents:report.dockerEvents,phases,idle:idle&&{...idle,metrics:Object.fromEntries(['rss','heapUsed','external','arrayBuffers'].map(k=>[k,metric(k,idle.startedAt,idle.endedAt)]))},recovery:report.recovery,recoveryMemory:report.recoveryMemory?.map(({rows,...m})=>m),interruption:report.interruption,storage:report.storage,image:report.image,minutes};
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/oom-profile-summary.json',JSON.stringify(result,null,2));
console.log('::notice title=Acceptance summary::'+JSON.stringify({success:result.success,failure:result.failure,profile:result.profile,memoryEvidence:result.memoryEvidence,dockerEvents:result.dockerEvents,interruption:result.interruption}));
console.log('::notice title=Acceptance minute series::'+JSON.stringify(minutes));
for(const p of phases)console.log('::notice title=Acceptance phase::'+JSON.stringify(p));
if(result.idle)console.log('::notice title=Acceptance idle::'+JSON.stringify(result.idle));
console.log('::notice title=Acceptance recovery::'+JSON.stringify({recovery:result.recovery,memory:result.recoveryMemory}));
