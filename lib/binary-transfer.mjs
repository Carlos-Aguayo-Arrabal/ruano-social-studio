import {mkdir,unlink,open} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

async function removeTemporary(path) {
  try { await unlink(path); } catch(e) { if(e.code!=='ENOENT')throw e; }
}
let active=0;
export async function receiveBinary(req,dir,{maxBytes,kind}) {
  if(active>=4)throw Object.assign(new Error('Hay varias subidas en curso; vuelve a intentarlo'),{status:429});
  active++;let tmp;
  try{
    await mkdir(dir,{recursive:true});tmp=join(dir,'.upload-'+randomBytes(16).toString('hex')+'.tmp');
    let bytes=0,head=Buffer.alloc(0);
    const limit=new Transform({transform(chunk,encoding,done){
      bytes+=chunk.length;
      if(bytes>maxBytes)return done(Object.assign(new Error('Petición demasiado grande'),{status:413}));
      if(head.length<16)head=Buffer.concat([head,chunk.subarray(0,16-head.length)]);
      done(null,chunk);
    }});
    // Keep the incoming socket out of pipeline's automatic destruction so a
    // size rejection can return HTTP 413 while the request is safely drained.
    const fail = err => limit.destroy(err instanceof Error ? err : new Error('Subida interrumpida'));
    req.on('error',fail); req.once('aborted',fail);
    try {
      req.pipe(limit);
      await pipeline(limit,createWriteStream(tmp,{flags:'wx',mode:0o600}));
    } finally {
      req.unpipe(limit);req.removeListener('aborted',fail);
      if(!req.readableEnded && !req.destroyed) req.resume();
      // The source may emit a late error after an HTTP abort.
      req.once('close',()=>req.removeListener('error',fail));
    }
    const jpg=head.length>3&&head[0]===255&&head[1]===216&&head[2]===255;
    const webp=head.length>12&&head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP';
    const mp4=head.length>=8&&head.toString('ascii',4,8)==='ftyp';
    if(!(kind==='photo'?(jpg||webp):kind==='mp4'?mp4:jpg))throw Object.assign(new Error('Formato de archivo no válido'),{status:400});
    return {path:tmp,bytes,ext:mp4&&kind==='mp4'?'mp4':webp&&kind==='photo'?'webp':'jpg',cleanup:()=>removeTemporary(tmp)};
  }catch(err){if(tmp)await removeTemporary(tmp);throw err;}
  finally{active--;}
}

// Callers must authorize the resource before passing a path. Open first to pin
// the inode while it is served; a rename/delete cannot change the bytes mid-read.
export async function streamBinary(res,path,headers) {
  let file,info;
  try{file=await open(path,'r');info=await file.stat();if(!info.isFile()){await file.close();return false;}}
  catch{await file?.close().catch(()=>{});return false;}
  try{
    res.writeHead(200,{'Content-Length':info.size,...headers});
    await pipeline(file.createReadStream(),res);
  }catch{res.destroy();}
  finally{await file.close().catch(()=>{});}
  return true;
}

// Only our reserved temporary names, inside the two-level tenant resource tree.
// One process/replica is mandatory: never run this against another writer.
export async function cleanInterruptedUploads(root) {
  const {readdir} = await import('node:fs/promises');
  const entries = async path => { try { return await readdir(path,{withFileTypes:true}); } catch(e) { if(e.code==='ENOENT')return [];throw e; } };
  for(const brand of await entries(root)) if(brand.isDirectory()) {
    const tenant=join(root,brand.name);
    for(const resource of await entries(tenant)) if(resource.isDirectory()) {
      const dir=join(tenant,resource.name);
      for(const file of await entries(dir)) if(file.isFile() && /^\.upload-[a-f0-9]{32}\.tmp$/.test(file.name)) await unlink(join(dir,file.name));
    }
  }
}
