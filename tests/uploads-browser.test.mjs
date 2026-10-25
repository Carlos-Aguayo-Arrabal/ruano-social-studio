import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {fixture,root} from './helpers.mjs';
const executablePath=process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
async function browserFixture(){const f=await fixture();let browser;try{
 const cookie=await f.login();browser=await chromium.launch({executablePath,headless:true});const context=await browser.newContext();await context.addCookies([{name:'ruano_session',value:cookie.split('=')[1],url:f.origin}]);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(f.origin+'/')?r.continue():r.abort());
 await page.goto(f.origin);await page.waitForFunction(()=>serverReady);await page.evaluate(()=>openPhotos(101));
 return {f,page,errors,close:async()=>{await browser.close();await f.close();}};
 }catch(e){await browser?.close();await f.close();throw e;}}

test('Chromium: 429 shows busy state, retries the same photo key, and never announces saved before confirmation',async()=>{
 const t=await browserFixture();try{
  let first=true;const keys=[];
  await t.page.route('**/api/photos/101?brand=a',async route=>{if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']);if(first){first=false;return route.fulfill({status:429,headers:{'Retry-After':'1','Content-Type':'application/json'},body:'{}'});}return route.continue();});
  await t.page.locator('#photoInput').setInputFiles(join(root,'tests/fixtures/photo.jpg'));
  const row=t.page.locator('#uploadPanel [data-upload-state="busy"]');await row.waitFor();assert.match(await row.textContent(),/Servidor ocupado/);
  assert.equal((await(await t.f.request('/api/photos/101?brand=a',await t.f.login())).json()).photos.length,0);
  await row.getByRole('button',{name:'Reintentar'}).click();await t.page.waitForFunction(()=>photoState.images[0]?.serverId);
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal((await(await t.f.request('/api/photos/101?brand=a',await t.f.login())).json()).photos.length,1);assert.deepEqual(t.errors,[]);
 }finally{await t.close();}
});

test('Chromium: lost acknowledgement retries without duplicates and the target tenant is frozen',async()=>{
 const t=await browserFixture();try{
  let first=true;const urls=[];
  await t.page.route('**/api/photos/101?brand=a',async route=>{if(route.request().method()!=='POST')return route.continue();urls.push(route.request().url());if(first){first=false;const response=await route.fetch();assert.equal(response.status(),201);return route.abort('failed');}return route.continue();});
  await t.page.locator('#photoInput').setInputFiles(join(root,'tests/fixtures/photo.jpg'));
  const row=t.page.locator('#uploadPanel [data-upload-state="error"]');await row.waitFor();
  await t.page.evaluate(()=>{BRAND={...BRAND,id:'b'};});
  await row.getByRole('button',{name:'Reintentar'}).click();await t.page.locator('#uploadPanel [data-upload-state="done"]').waitFor();
  assert.equal(urls.length,2);assert.ok(urls.every(u=>u.endsWith('brand=a')));
  assert.equal((await(await t.f.request('/api/photos/101?brand=a',await t.f.login())).json()).photos.length,1);assert.deepEqual(t.errors,[]);
 }finally{await t.close();}
});

test('Chromium: queued/active cancellation, progress, oversize and retry controls use text-safe labels',async()=>{
 const t=await browserFixture();try{
  let release;const blocked=new Promise(r=>release=r);
  await t.page.route('**/api/media/a/slow?*',async route=>{await blocked;try{await route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});}catch{}});
  await t.page.evaluate(()=>{
   globalThis.testQueue=new RuanoUploadQueue({concurrency:1});globalThis.testTasks=[];
   for(let i=0;i<2;i++)testTasks.push(testQueue.enqueue({url:'/api/media/a/slow?i='+i,blob:new Blob([new Uint8Array(1024*1024)],{type:'image/jpeg'}),label:'<img onerror="window.uploadXss=1"> '+i}));
  });
  const panel=t.page.locator('section[aria-label="Subidas"]').last();await panel.locator('progress').waitFor();
  assert.equal(await panel.locator('img').count(),0);assert.equal(await t.page.evaluate(()=>globalThis.uploadXss),undefined);
  await panel.locator('[data-upload-state="queued"]').getByRole('button',{name:'Cancelar'}).click();await panel.locator('[data-upload-state="uploading"]').getByRole('button',{name:'Cancelar'}).click();
  assert.equal(await panel.locator('[data-upload-state="cancelled"]').count(),2);release();
  await t.page.route('**/api/media/a/large?*',r=>r.fulfill({status:413,contentType:'application/json',body:'{}'}));
  await t.page.evaluate(()=>{testQueue.enqueue({url:'/api/media/a/large?i=0',blob:new Blob(['synthetic']),label:'Oversize'});});
  await panel.locator('[data-upload-state="error"]').waitFor();assert.match(await panel.textContent(),/supera el tamaño/);assert.deepEqual(t.errors,[]);
 }finally{await t.close();}
});
