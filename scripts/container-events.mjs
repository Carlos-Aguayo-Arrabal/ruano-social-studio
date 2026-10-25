import {spawn} from 'node:child_process';
export function watchContainerEvents(name){
 const events=[];let pending='',stopping=false;
 const child=spawn('docker',['events','--since',String(Math.floor(Date.now()/1000)),'--filter','container='+name,'--filter','event=oom','--filter','event=die','--format','{{.Action}} {{.TimeNano}}'],{stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>{pending+=chunk;const lines=pending.split('\n');pending=lines.pop();for(const line of lines){const [action,atUnixNs]=line.trim().split(/\s+/);if(['oom','die'].includes(action))events.push({action,atUnixNs});}});
 child.on('close',code=>{if(!stopping&&code!==0)events.push({observerError:'Docker event stream exited '+code});});
 child.stderr.on('data',()=>{});child.on('error',error=>events.push({observerError:error.code||error.name}));
 return {events,stop:async()=>{if(child.exitCode!==null||child.signalCode!==null)return;stopping=true;await new Promise(resolve=>{child.once('close',resolve);child.kill('SIGTERM');});}};
}
