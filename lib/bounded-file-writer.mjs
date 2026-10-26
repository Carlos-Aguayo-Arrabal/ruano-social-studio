import {Writable} from 'node:stream';
import {open} from 'node:fs/promises';

// Backpressure must cover dirty kernel pages as well as the JS stream queue.
// Four admitted receivers retain at most ~16 MiB awaiting fdatasync, plus one
// input chunk each. Clean page cache remains reclaimable by the kernel.
export function boundedFileWriter(path,{syncBytes=4*1024*1024,openFile=open}={}){
 if(!Number.isSafeInteger(syncBytes)||syncBytes<1)throw Error('Invalid sync window');
 let file,unsynced=0,closing;
 const close=()=>closing||(closing=file?file.close():Promise.resolve());
 return new Writable({highWaterMark:64*1024,
  construct(done){openFile(path,'wx',0o600).then(f=>{file=f;done();},done);},
  write(chunk,encoding,done){(async()=>{
   let offset=0;
   while(offset<chunk.length){
    const count=Math.min(chunk.length-offset,syncBytes-unsynced);
    const {bytesWritten}=await file.write(chunk,offset,count,null);
    if(!(bytesWritten>0&&bytesWritten<=count))throw Error('Invalid file write progress');
    offset+=bytesWritten;unsynced+=bytesWritten;
    if(unsynced===syncBytes){await file.datasync();unsynced=0;}
   }
  })().then(()=>done(),done);},
  final(done){(async()=>{if(unsynced)await file.datasync();await close();})().then(()=>done(),done);},
  destroy(error,done){close().then(()=>done(error),e=>done(error||e));}
 });
}
