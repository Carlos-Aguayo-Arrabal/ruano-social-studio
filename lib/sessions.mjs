import {readFile,lstat,open,rename,unlink} from 'node:fs/promises';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {dirname} from 'node:path';

const unavailable=()=>Object.assign(new Error('Almacén de sesiones no disponible'),{status:503});
const key=token=>typeof token==='string'&&/^v2\.[a-f0-9]{64}$/.test(token)?createHash('sha256').update(token).digest('hex'):null;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));

export class SessionStore {
  constructor(file,{now=Date.now,ttlMs=12*3600_000,maxSessions=2000,maxPerUser=20,maxFileBytes=2*1024*1024}={}) {
    this.file=file;this.now=now;this.ttlMs=ttlMs;this.maxSessions=maxSessions;this.maxPerUser=maxPerUser;this.maxFileBytes=maxFileBytes;
    this.records=new Map();this.healthy=true;this.queue=Promise.resolve();
  }
  static async open(file,options) {
    const store=new SessionStore(file,options);
    try {
      const info=await lstat(file);
      if(!info.isFile()||info.size>store.maxFileBytes)throw Error('Session store invalid or too large');
      const data=JSON.parse(await readFile(file,'utf8'));
      if(data.version!==2||!Array.isArray(data.sessions)||data.sessions.length>store.maxSessions)throw Error('Invalid session store');
      for(const r of data.sessions) {
        if(!r||!(/^[a-f0-9]{64}$/.test(r.key))||typeof r.uid!=='string'||!r.uid||r.uid.length>40||!(/^[a-f0-9]{64}$/.test(r.binding))||!Number.isSafeInteger(r.createdAt)||!Number.isSafeInteger(r.expiresAt)||r.createdAt<0||r.expiresAt<=r.createdAt||r.expiresAt-r.createdAt>store.ttlMs||store.records.has(r.key))throw Error('Invalid session record');
        store.records.set(r.key,r);
      }
    }catch(err){if(err.code!=='ENOENT')throw unavailable();}
    await store.prune(undefined,true);return store;
  }
  assertHealthy(){if(!this.healthy)throw unavailable();}
  async persist(records) {
    const bytes=JSON.stringify({version:2,sessions:[...records.values()]});
    if(Buffer.byteLength(bytes)>this.maxFileBytes)throw Object.assign(new Error('Límite de sesiones alcanzado'),{status:429});
    const tmp=this.file+'.'+randomBytes(12).toString('hex')+'.tmp';
    try{
      const file=await open(tmp,'wx',0o600);
      try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
      await rename(tmp,this.file);
      const dir=await open(dirname(this.file),'r');try{await dir.sync();}finally{await dir.close();}
    }
    catch{this.healthy=false;await unlink(tmp).catch(()=>{});throw unavailable();}
  }
  mutate(fn,force=false) {
    const run=this.queue.then(async()=>{this.assertHealthy();const next=new Map(this.records);const result=fn(next);if(force||next.size!==this.records.size||[...next].some(([k,v])=>this.records.get(k)!==v))await this.persist(next);this.records=next;return result;});
    this.queue=run.catch(()=>{});return run;
  }
  prune(validBinding,force=false) {
    return this.mutate(records=>{for(const [id,r] of records)if(r.expiresAt<=this.now()||(validBinding&&!same(r.binding,validBinding(r.uid))))records.delete(id);},force);
  }
  create(uid,binding) {
    return this.mutate(records=>{
      for(const [id,r] of records)if(r.expiresAt<=this.now())records.delete(id);
      if(records.size>=this.maxSessions||[...records.values()].filter(r=>r.uid===uid).length>=this.maxPerUser)throw Object.assign(new Error('Límite de sesiones alcanzado; cierra una sesión o espera su caducidad'),{status:429});
      const token='v2.'+randomBytes(32).toString('hex'),id=key(token),createdAt=this.now();
      records.set(id,{key:id,uid,binding,createdAt,expiresAt:createdAt+this.ttlMs});return token;
    });
  }
  resolve(token,validBinding) {
    this.assertHealthy();const id=key(token),r=id&&this.records.get(id);
    return r&&r.expiresAt>this.now()&&same(r.binding,validBinding(r.uid))?r.uid:null;
  }
  revoke(token) {return this.mutate(records=>{const id=key(token);return id?records.delete(id):false;});}
  revokeUsers(ids) {const users=new Set(ids);return this.mutate(records=>{for(const [id,r] of records)if(users.has(r.uid))records.delete(id);});}
}
