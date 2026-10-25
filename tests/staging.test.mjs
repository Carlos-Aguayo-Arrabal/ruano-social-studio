import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import https from 'node:https';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {prepareStaging} from '../scripts/prepare-staging.mjs';
import {fixture} from './helpers.mjs';

test('staging generator creates independent private synthetic settings and cannot overwrite them',async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'ruano-plan-'));try{
  const a=await prepareStaging(join(tmp,'one')),b=await prepareStaging(join(tmp,'two'));assert.notEqual(a.project,b.project);assert.notEqual(a.volume,b.volume);
  const first=await readFile(join(a.output,'synthetic.env'),'utf8'),second=await readFile(join(b.output,'synthetic.env'),'utf8');assert.notEqual(first,second);assert.equal((await stat(join(a.output,'synthetic.env'))).mode&0o777,0o600);
  const compose=await readFile(join(a.output,'compose.yml'),'utf8');assert.match(compose,/network_mode: none/);assert.doesNotMatch(compose,/ports:|external: true/);
  const plan=JSON.parse(await readFile(join(a.output,'easypanel-plan.json')));assert.equal(plan.replicas,1);assert.equal(plan.autoDeploy,false);assert.equal(plan.domain.dnsConfigured,false);
  await assert.rejects(prepareStaging(a.output));assert.equal(await readFile(join(a.output,'synthetic.env'),'utf8'),first);
 }finally{await rm(tmp,{recursive:true,force:true})}
});
test('trusted synthetic TLS termination: Secure session, strict origin and perimeter on public routes',async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'ruano-tls-'));let f,proxy;
 try{
  const key=join(tmp,'key.pem'),cert=join(tmp,'cert.pem');await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=staging.example.invalid','-addext','subjectAltName=DNS:staging.example.invalid']);
  const ca=await readFile(cert),perimeter='Basic '+Buffer.from('synthetic:perimeter-only').toString('base64');
  proxy=https.createServer({key:await readFile(key),cert:ca},(req,res)=>{
   if(req.headers.authorization!==perimeter){res.writeHead(401,{'WWW-Authenticate':'Basic realm="synthetic-staging"'});res.end('restricted');return;}
   const {authorization,...forwarded}=req.headers;
   const upstream=http.request(f.origin+req.url,{method:req.method,headers:{...forwarded,host:host,'x-forwarded-proto':'https','x-forwarded-host':host}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
  });
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const host='staging.example.invalid:'+proxy.address().port,origin='https://'+host;
  const password=randomBytes(24).toString('hex');
  f=await fixture({runtime:{NODE_ENV:'production',PUBLIC_URL:origin,APP_USERNAME:'synthetic-tls-owner',APP_PASSWORD:password}});
  const request=(path,{auth=true,headers={},method='GET',body,servername='staging.example.invalid'}={})=>new Promise((resolve,reject)=>{
   const req=https.request({hostname:'127.0.0.1',port:proxy.address().port,servername,ca,path,method,headers:{Host:host,...(auth?{Authorization:perimeter}:{}),...headers}},res=>{let data='';res.setEncoding('utf8');res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Synthetic TLS request timeout')));req.end(body);
  });
  for(const path of ['/login','/api/me','/w/aaaaaaaaaaaaaaaa','/r/111111111111111111111111','/m/a/1/0.jpg','/health','/vendor/purify.min.js'])assert.equal((await request(path,{auth:false})).status,401);
  await assert.rejects(request('/login',{servername:'wrong.example.invalid'}),/certificate|Hostname|altnames/i);
  assert.equal((await request('/login')).status,200);
  const signedIn=await request('/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'synthetic-tls-owner',password}).toString()});
  assert.equal(signedIn.status,303);assert.match(signedIn.headers['set-cookie'][0],/Secure/);assert.match(signedIn.headers['set-cookie'][0],/HttpOnly/);
  const cookie=signedIn.headers['set-cookie'][0].split(';')[0];assert.equal((await request('/api/me',{headers:{Cookie:cookie}})).status,200);
  const allowed=await request('/api/sync',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:'{}'});assert.equal(allowed.status,200);
  assert.equal((await request('/api/sync',{method:'POST',headers:{Cookie:cookie,Origin:'http://'+host,'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await request('/w/aaaaaaaaaaaaaaaa')).status,200);
  const robots=await request('/robots.txt',{headers:{'X-Forwarded-Host':'evil.example.invalid'}});assert.ok(robots.body.includes(origin));assert.ok(!robots.body.includes('evil.example.invalid'));
 }finally{if(proxy)await new Promise(r=>proxy.close(r));await f?.close();await rm(tmp,{recursive:true,force:true})}
});
