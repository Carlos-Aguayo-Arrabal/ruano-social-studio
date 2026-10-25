// Out-of-cgroup observer for this run's owned disposable container only.
import {readFile} from 'node:fs/promises';import {join} from 'node:path';
const numbers=text=>Object.fromEntries(text.trim().split('\n').map(l=>{const [k,v]=l.split(/\s+/);return [k,Number(v)]}));
export async function hostMemory(pid){
 const group=(await readFile(`/proc/${pid}/cgroup`,'utf8')).trim().split('\n').find(l=>l.startsWith('0::'))?.slice(3);
 if(!group||!group.startsWith('/')||group.includes('..'))throw Error('Expected cgroup v2 for owned container');
 const root='/sys/fs/cgroup'+group,scalar=async name=>Number((await readFile(join(root,name),'utf8')).trim());
 const [currentBytes,peakBytes,swapCurrentBytes,swapMaxBytes,configuredLimitBytes,stat,events,cpu,status]=await Promise.all([scalar('memory.current'),scalar('memory.peak'),scalar('memory.swap.current'),scalar('memory.swap.max'),scalar('memory.max'),readFile(join(root,'memory.stat'),'utf8'),readFile(join(root,'memory.events'),'utf8'),readFile(join(root,'cpu.stat'),'utf8'),readFile(`/proc/${pid}/status`,'utf8')]);
 const values=numbers(stat);return {currentBytes,peakBytes,swapCurrentBytes,swapMaxBytes,configuredLimitBytes,anonBytes:values.anon,rssBytes:Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1])*1024,cpuUsec:numbers(cpu).usage_usec,stat:values,events:numbers(events),includesFileCache:true,observer:'host'};
}
