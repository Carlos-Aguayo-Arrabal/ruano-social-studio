// Explicit test-only preload. No HTTP endpoint, tokens, payloads or forced GC.
import {openSync,writeSync} from 'node:fs';
const path=process.env.RUANO_MEMORY_LOG;
if(path){
 const fd=openSync(path,'w',0o600),size=1024,data=Buffer.alloc(size,32);
 const sample=()=>{const record=JSON.stringify({at:Date.now(),...process.memoryUsage(),uptimeSeconds:process.uptime()});if(Buffer.byteLength(record)>size)throw Error('Memory gauge record exceeds fixed bound');data.fill(32);data.write(record);writeSync(fd,data,0,size,0);};
 sample();setInterval(sample,250).unref();
}
