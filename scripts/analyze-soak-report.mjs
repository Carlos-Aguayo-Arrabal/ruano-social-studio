// Read synthetic CI telemetry only. Preserve failures; never turn OOM into pass.
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {rssWindow} from '../lib/soak-analysis.mjs';
const report=JSON.parse(await readFile(process.argv[2],'utf8')),rows=report.samples||[],first=rows[0],last=rows.at(-1);
const duration=first&&last?last.at-first.at:0;
const analysis={success:report.success,failure:report.failure,finalState:report.finalState,plannedActiveDurationMs:report.plannedDurationMs,observedSamples:rows.length,observedDurationMs:duration,configuredMemoryLimits:[...new Set(rows.map(s=>s.configuredLimitBytes))],maxObservedRssBytes:rows.length?Math.max(...rows.map(s=>s.rssBytes)):null,maxObservedAnonBytes:rows.length?Math.max(...rows.map(s=>s.anonBytes)):null,maxObservedCgroupPeakBytes:rows.length?Math.max(...rows.map(s=>s.peakBytes)):null,swapUsedMaxBytes:rows.length?Math.max(...rows.map(s=>s.swapCurrentBytes)):null,cpuAveragePercent:duration>0?100*(last.cpuUsec-first.cpuUsec)/(duration*1000):null,rssWindow:first?rssWindow(rows,first.at,last.at):null,phases:report.phases,recovery:report.recovery,storage:report.storage,diskSamplesCount:report.diskSamples?.length||0,lastSamples:rows.slice(-10).map(s=>({offsetSeconds:(s.at-first.at)/1000,rssBytes:s.rssBytes,anonBytes:s.anonBytes,currentBytes:s.currentBytes,peakBytes:s.peakBytes,swapUsedBytes:s.swapCurrentBytes})),measurementNote:'Original in-cgroup docker-exec probes consume part of the same 256 MiB budget; these data do not isolate causality.'};
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/replayed-soak-analysis.json',JSON.stringify(analysis,null,2));
const {lastSamples,phases,recovery,storage,rssWindow:trend,...summary}=analysis;
console.log('::notice title=Replayed telemetry summary::'+JSON.stringify(summary));
console.log('::notice title=Replayed RSS tail::'+JSON.stringify({trend,lastSamples}));
if(recovery)console.log('::notice title=Replayed recovery::'+JSON.stringify(recovery));
